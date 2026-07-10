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
    for (const run of this.activeRuns.values()) run.abortController.abort('watcher_stopped');
    await Promise.allSettled(Array.from(this.activeRuns.values()).map(run => run.promise));
  }

  abortWorkItem(workItemId) {
    for (const entry of this.activeRuns.values()) {
      if (entry.workItemId === workItemId) entry.abortController.abort('work_item_cancelled');
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

      const promise = this.#execute(claim, abortController.signal)
        .finally(() => {
          clearInterval(renewal);
          this.activeRuns.delete(key);
        });
      this.activeRuns.set(key, { promise, abortController, workItemId: claim.workItem.id });
      this.onEvent({ type: 'run.started', workItem: this.store.getWorkItemDetail(claim.workItem.id) });
    } finally {
      this.ticking = false;
    }
  }

  async #execute(claim, signal) {
    let result;
    try {
      result = await this.runner.run({ ...claim, signal, ownerBootId: this.ownerBootId });
    } catch (err) {
      if (signal.aborted) return;
      result = {
        outcome: 'retryable',
        summary: '',
        evidence: [],
        error: err?.message || String(err),
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
