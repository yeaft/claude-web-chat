const DEFAULT_POLL_INTERVAL_MS = 2_000;
const DEFAULT_LEASE_MS = 60_000;

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
    this.timer = null;
    this.ticking = false;
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
    this.timer = setInterval(() => { this.tick().catch(() => {}); }, this.pollIntervalMs);
    this.timer.unref?.();
    this.tick().catch(() => {});
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    const active = Array.from(this.activeRuns.values());
    for (const entry of active) entry.abortController.abort('watcher_stopped');
    await Promise.allSettled(active.map(entry => entry.promise));
    const failures = [];
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

  async tick() {
    // V1 deliberately serializes WorkItem Runs per Agent. Without a dedicated
    // per-WorkItem workspace manager, concurrent writers could mutate the same
    // project directory. Parallel execution can be added only with exclusive
    // workspace leases.
    if (this.ticking || this.activeRuns.size > 0 || !this.runner) return;
    this.ticking = true;
    try {
      const claim = this.store.claimReadyAction(this.ownerBootId, this.leaseMs);
      if (!claim) return;
      const abortController = new AbortController();
      const key = claim.run.id;
      const renewEvery = Math.max(1_000, Math.floor(this.leaseMs / 3));
      const renewal = setInterval(() => {
        const ok = this.store.renewLease(key, this.ownerBootId, claim.run.leaseEpoch, this.leaseMs);
        if (!ok) abortController.abort('work_item_lease_lost');
      }, renewEvery);
      renewal.unref?.();

      const entry = {
        promise: null,
        abortController,
        readFinalProgress: null,
        interrupted: false,
        workItemId: claim.workItem.id,
        runId: claim.run.id,
        leaseEpoch: claim.run.leaseEpoch,
      };
      entry.promise = this.#execute(claim, abortController.signal, readProgress => {
        entry.readFinalProgress = readProgress;
      }).finally(() => {
        clearInterval(renewal);
        this.activeRuns.delete(key);
      });
      this.activeRuns.set(key, entry);
      this.onEvent({ type: 'run.started', workItem: this.store.getWorkItemDetail(claim.workItem.id) });
    } finally {
      this.ticking = false;
    }
  }

  async #execute(claim, signal, registerProgressReader) {
    let result;
    try {
      result = await this.runner.run({
        ...claim,
        signal,
        ownerBootId: this.ownerBootId,
        registerProgressReader,
        onProgress: progress => {
          const detail = this.store.updateRunProgress(
            claim.run.id,
            this.ownerBootId,
            claim.run.leaseEpoch,
            progress,
          );
          if (detail) this.onEvent({ type: 'run.progress', workItem: detail });
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
      this.onEvent({ type: 'run.finished', workItem });
    } catch (err) {
      if (!/stale|cancelled|already finished/i.test(err?.message || '')) throw err;
    }
  }
}
