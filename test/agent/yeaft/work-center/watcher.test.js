import { describe, expect, it, vi } from 'vitest';
import { WorkItemWatcher } from '../../../../agent/yeaft/work-center/watcher.js';

function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}

describe('WorkItemWatcher', () => {
  it('runs only one Action at a time until workspace leases exist', async () => {
    const gate = deferred();
    const secondGate = deferred();
    const claims = [
      { workItem: { id: 'w1' }, action: { id: 'a1' }, run: { id: 'r1', leaseEpoch: 1 } },
      { workItem: { id: 'w2' }, action: { id: 'a2' }, run: { id: 'r2', leaseEpoch: 1 } },
    ];
    const store = {
      claimReadyAction: vi.fn(() => claims.shift() || null),
      renewLease: vi.fn(() => true),
      getWorkItemDetail: vi.fn(id => ({ id })),
    };
    const controller = { submit: vi.fn(() => ({ id: 'w1', status: 'done' })) };
    const runner = { run: vi.fn()
      .mockImplementationOnce(() => gate.promise)
      .mockImplementationOnce(() => secondGate.promise) };
    const watcher = new WorkItemWatcher({
      store, controller, runner, ownerBootId: 'boot', pollIntervalMs: 60_000, leaseMs: 60_000,
    });

    await watcher.tick();
    await watcher.tick();
    expect(store.claimReadyAction).toHaveBeenCalledTimes(1);
    expect(runner.run).toHaveBeenCalledTimes(1);

    gate.resolve({ outcome: 'completed', summary: '', evidence: [] });
    await watcher.activeRuns.get('r1').promise;
    await watcher.tick();
    expect(store.claimReadyAction).toHaveBeenCalledTimes(2);
    expect(runner.run).toHaveBeenCalledTimes(2);
    secondGate.resolve({ outcome: 'completed', summary: '', evidence: [] });
    await watcher.activeRuns.get('r2').promise;
    await watcher.stop();
  });
});
