const DEFAULT_POLL_INTERVAL_MS = 2_000;
const DEFAULT_LEASE_MS = 60_000;
const DEFAULT_MAX_CONCURRENT_ACTIONS = 3;

export class WorkItemWatcher {
  constructor(options) {
    this.store = options.store;
    this.controller = options.controller;
    this.runner = options.runner;
    this.ownerBootId = options.ownerBootId;
    this.onEvent = typeof options.onEvent === 'function' ? options.onEvent : () => {};
    this.pollIntervalMs = Number(options.pollIntervalMs) > 0
      ? Number(options.pollIntervalMs)
      : DEFAULT_POLL_INTERVAL_MS;
    this.leaseMs = Number(options.leaseMs) > 0 ? Number(options.leaseMs) : DEFAULT_LEASE_MS;
    this.concurrencyProvider = typeof options.concurrencyProvider === 'function'
      ? options.concurrencyProvider
      : () => DEFAULT_MAX_CONCURRENT_ACTIONS;
    this.timer = null;
    this.ticking = false;
    this.tickPromise = null;
    this.lifecycle = 'running';
    this.activeRuns = new Map();
  }

  status() {
    return {
      enabled: !!this.timer,
      activeRuns: this.activeRuns.size,
      ownerBootId: this.ownerBootId,
    };
  }

  start() {
    if (this.timer) return;
    this.lifecycle = 'running';
    this.timer = setInterval(() => { this.tick().catch(() => {}); }, this.pollIntervalMs);
    this.timer.unref?.();
    this.tick().catch(() => {});
  }

  async stop() {
    this.lifecycle = 'stopping';
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    const failures = [];
    const stoppingRuns = new Map(this.activeRuns);
    for (const entry of stoppingRuns.values()) {
      entry.abortController.abort('watcher_stopped');
    }
    try {
      await this.tickPromise;
    } catch (error) {
      failures.push(error);
    }
    for (const [runId, entry] of this.activeRuns) stoppingRuns.set(runId, entry);
    const active = Array.from(stoppingRuns.values());
    for (const entry of active) entry.abortController.abort('watcher_stopped');
    await Promise.allSettled(active.map(entry => entry.promise));
    for (const entry of active) {
      try {
        const finalProgress = entry.readFinalProgress?.() || null;
        entry.interrupted = this.store.interruptRun(
          entry.runId,
          this.ownerBootId,
          entry.leaseEpoch,
          'Work Center watcher stopped',
          finalProgress,
        );
      } catch (error) {
        entry.interrupted = false;
        failures.push(error);
      }
    }
    this.lifecycle = 'idle';
    if (failures.length > 0) {
      throw new AggregateError(failures, 'Could not persist one or more Work Center interruptions');
    }
    return active.map(entry => ({ runId: entry.runId, interrupted: entry.interrupted === true }));
  }

  abortInvalidWorkItemRuns(workItemId) {
    for (const entry of this.activeRuns.values()) {
      if (entry.workItemId !== workItemId) continue;
      if (!this.store.isActiveRun(entry.runId, this.ownerBootId, entry.leaseEpoch)) {
        entry.abortController.abort('work_item_state_changed');
      }
    }
  }

  notifyActionInput(workItemId, actionId) {
    for (const entry of this.activeRuns.values()) {
      if (entry.workItemId !== workItemId || entry.actionId !== actionId) continue;
      try { entry.wakeForPendingUserMessage?.(); } catch {}
    }
  }

  notifyWorkItemInput(workItemId) {
    for (const entry of this.activeRuns.values()) {
      if (entry.workItemId !== workItemId) continue;
      try { entry.wakeForPendingUserMessage?.(); } catch {}
    }
  }

  #recoverExpiredRuns() {
    const recovered = this.store.recoverInterruptedRuns?.(this.ownerBootId) || 0;
    if (recovered > 0) {
      for (const entry of this.activeRuns.values()) {
        if (!this.store.isActiveRun(entry.runId, this.ownerBootId, entry.leaseEpoch)) {
          entry.abortController.abort('work_item_lease_expired');
        }
      }
    }
    return recovered;
  }

  async tick() {
    if (this.lifecycle !== 'running' || !this.runner) return;
    if (this.tickPromise) return this.tickPromise;
    this.ticking = true;
    this.tickPromise = (async () => {
      try {
        this.#recoverExpiredRuns();
        const limit = Math.min(Math.max(Number(await this.concurrencyProvider()) || 3, 1), 12);
        while (this.lifecycle === 'running' && this.activeRuns.size < limit) {
          let claim = this.store.claimReadyAction(this.ownerBootId, this.leaseMs);
          if (!claim) break;
          try {
            claim = await this.runner.prepare?.({ ...claim, ownerBootId: this.ownerBootId }) || claim;
            if (this.lifecycle !== 'running') {
              try { this.runner.cleanup?.(claim.action); } catch {}
              this.store.interruptRun(
                claim.run.id,
                this.ownerBootId,
                claim.run.leaseEpoch,
                'Work Center watcher stopped during Action preparation',
                null,
              );
              break;
            }
          } catch (error) {
            try { this.runner.cleanup?.(claim.action); } catch {}
            if (this.lifecycle !== 'running') {
              this.store.interruptRun(
                claim.run.id,
                this.ownerBootId,
                claim.run.leaseEpoch,
                'Work Center watcher stopped during Action preparation',
                null,
              );
              break;
            }
            if (error?.workItemPrepareDeferred) {
              const detail = this.store.deferRun(
                claim.run.id,
                this.ownerBootId,
                claim.run.leaseEpoch,
                error.message,
              );
              if (!detail) throw new Error('Work Center deferred preparation lost its Run lease');
              this.onEvent({ type: 'run.deferred', workItem: detail });
              break;
            }
            this.controller.submit(claim.run.id, this.ownerBootId, claim.run.leaseEpoch, {
              outcome: error?.workItemPrepareRetryable ? 'retryable' : 'failed',
              response: '', summary: '', evidence: [],
              error: error?.message || String(error),
            });
            this.onEvent({
              type: 'run.finished',
              actionId: claim.action.id,
              runId: claim.run.id,
              workItem: this.store.getWorkItemDetail(claim.workItem.id),
            });
            continue;
          }
          this.#startClaim(claim);
        }
      } finally {
        this.ticking = false;
        this.tickPromise = null;
      }
    })();
    return this.tickPromise;
  }

  #startClaim(claim) {
    const abortController = new AbortController();
    const key = claim.run.id;
    const renewEvery = Math.max(1_000, Math.floor(this.leaseMs / 3));
    const renewal = setInterval(() => {
      const ok = this.store.renewLease(key, this.ownerBootId, claim.run.leaseEpoch, this.leaseMs);
      if (!ok) {
        this.#recoverExpiredRuns();
        abortController.abort('work_item_lease_lost');
      }
    }, renewEvery);
    renewal.unref?.();
    const entry = {
      promise: null,
      abortController,
      readFinalProgress: null,
      interrupted: false,
      workItemId: claim.workItem.id,
      actionId: claim.action.id,
      runId: claim.run.id,
      leaseEpoch: claim.run.leaseEpoch,
      wakeForPendingUserMessage: null,
    };
    entry.promise = this.#execute(claim, abortController.signal, readProgress => {
      entry.readFinalProgress = readProgress;
    }, wake => {
      entry.wakeForPendingUserMessage = wake;
    }).finally(() => {
      clearInterval(renewal);
      this.activeRuns.delete(key);
      if (this.lifecycle === 'running') queueMicrotask(() => { this.tick().catch(() => {}); });
    });
    this.activeRuns.set(key, entry);
    this.onEvent({
      type: 'run.started',
      actionId: claim.action.id,
      runId: claim.run.id,
      workItem: this.store.getWorkItemDetail(claim.workItem.id),
    });
  }

  async #execute(claim, signal, registerProgressReader, registerInputWake) {
    try {
      let result;
      try {
        result = await this.runner.run({
          ...claim,
          signal,
          ownerBootId: this.ownerBootId,
          registerProgressReader,
          registerInputWake,
          onProgress: progress => {
            const detail = this.store.updateRunProgress(
              claim.run.id,
              this.ownerBootId,
              claim.run.leaseEpoch,
              progress,
            );
            if (detail) {
              this.onEvent({
                type: 'run.progress',
                actionId: claim.action.id,
                runId: claim.run.id,
                workItem: detail,
              });
            }
            return !!detail;
          },
        });
      } catch (err) {
        if (signal.aborted) return;
        result = {
          outcome: err?.retryable === false ? 'failed' : 'retryable',
          response: err?.workItemExecutionStats?.response || '',
          summary: '',
          evidence: [],
          error: err?.message || String(err),
          failureKind: err?.workItemFailureKind || null,
          failureCode: err?.workItemFailureCode || null,
          loopCount: err?.workItemExecutionStats?.loopCount || 0,
          toolCount: err?.workItemExecutionStats?.toolCount || 0,
          llmRequestCount: err?.workItemExecutionStats?.llmRequestCount || 0,
          inputTokens: err?.workItemExecutionStats?.inputTokens || 0,
          outputTokens: err?.workItemExecutionStats?.outputTokens || 0,
          cacheReadTokens: err?.workItemExecutionStats?.cacheReadTokens || 0,
          cacheWriteTokens: err?.workItemExecutionStats?.cacheWriteTokens || 0,
          totalTokens: err?.workItemExecutionStats?.totalTokens || 0,
          checkpoint: err?.workItemExecutionStats?.checkpoint || null,
        };
      }
      if (signal.aborted) return;
      try {
        const workItem = this.controller.submit(
          claim.run.id,
          this.ownerBootId,
          claim.run.leaseEpoch,
          result,
        );
        this.onEvent({
          type: 'run.finished',
          actionId: claim.action.id,
          runId: claim.run.id,
          workItem,
        });
      } catch (err) {
        if (!/stale|cancelled|already finished/i.test(err?.message || '')) throw err;
      }
    } finally {
      try { this.runner.cleanup?.(claim.action); } catch {}
    }
  }
}
