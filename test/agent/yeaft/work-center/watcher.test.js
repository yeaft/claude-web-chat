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
      interruptRun: vi.fn(() => true),
      isActiveRun: vi.fn(() => true),
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

  it('persists and emits fenced live response progress', async () => {
    const claim = {
      workItem: { id: 'w1' }, action: { id: 'a1' }, run: { id: 'r1', leaseEpoch: 3 },
    };
    const detail = { id: 'w1', actions: [{ id: 'a1', response: 'Inspecting files' }] };
    const updateRunProgress = vi.fn().mockReturnValue(detail);
    const onEvent = vi.fn();
    let resolveRun;
    const runner = {
      run: vi.fn(options => new Promise(resolve => {
        resolveRun = resolve;
        options.onProgress({
          response: 'Inspecting files', loopCount: 1, toolCount: 2, llmRequestCount: 2,
          inputTokens: 120, outputTokens: 30, cacheReadTokens: 20, cacheWriteTokens: 5,
          totalTokens: 175,
        });
      })),
    };
    const store = {
      claimReadyAction: vi.fn().mockReturnValueOnce(claim).mockReturnValue(null),
      renewLease: vi.fn(() => true), interruptRun: vi.fn(() => true),
      isActiveRun: vi.fn(() => true), getWorkItemDetail: vi.fn(() => detail), updateRunProgress,
    };
    const watcher = new WorkItemWatcher({
      store, controller: { submit: vi.fn(() => detail) }, runner, onEvent,
      ownerBootId: 'boot', pollIntervalMs: 60_000, leaseMs: 60_000,
    });

    await watcher.tick();
    expect(updateRunProgress).toHaveBeenCalledWith('r1', 'boot', 3, {
      response: 'Inspecting files', loopCount: 1, toolCount: 2, llmRequestCount: 2,
      inputTokens: 120, outputTokens: 30, cacheReadTokens: 20, cacheWriteTokens: 5,
      totalTokens: 175,
    });
    expect(onEvent).toHaveBeenCalledWith({ type: 'run.progress', workItem: detail });
    resolveRun({ outcome: 'completed', response: 'Done', summary: 'Done', evidence: [] });
    await watcher.activeRuns.get('r1').promise;
  });

  it('persists a fenced interruption before aborting an active Run', async () => {
    const gate = deferred();
    const store = {
      claimReadyAction: vi.fn()
        .mockReturnValueOnce({
          workItem: { id: 'w1' }, action: { id: 'a1' },
          run: { id: 'r1', leaseEpoch: 7 },
        })
        .mockReturnValue(null),
      renewLease: vi.fn(() => true),
      interruptRun: vi.fn(() => true),
      isActiveRun: vi.fn(() => true),
      getWorkItemDetail: vi.fn(id => ({ id })),
    };
    const watcher = new WorkItemWatcher({
      store,
      controller: { submit: vi.fn() },
      runner: { run: vi.fn(() => gate.promise) },
      ownerBootId: 'boot', pollIntervalMs: 60_000, leaseMs: 60_000,
    });
    await watcher.tick();
    const stop = watcher.stop();
    expect(store.interruptRun).toHaveBeenCalledWith(
      'r1', 'boot', 7, 'Work Center watcher stopped',
    );
    gate.resolve({ outcome: 'completed', summary: '', evidence: [] });
    await stop;
    expect(watcher.activeRuns.size).toBe(0);
  });

  it('does not abort a Run whose fenced DB state is still active', async () => {
    const gate = deferred();
    const store = {
      claimReadyAction: vi.fn().mockReturnValueOnce({
        workItem: { id: 'w1' }, action: { id: 'a1' }, run: { id: 'r1', leaseEpoch: 2 },
      }),
      renewLease: vi.fn(() => true),
      interruptRun: vi.fn(() => true),
      isActiveRun: vi.fn(() => true),
      getWorkItemDetail: vi.fn(id => ({ id })),
    };
    const watcher = new WorkItemWatcher({
      store,
      controller: { submit: vi.fn() },
      runner: { run: vi.fn(() => gate.promise) },
      ownerBootId: 'boot', pollIntervalMs: 60_000, leaseMs: 60_000,
    });
    await watcher.tick();
    const entry = watcher.activeRuns.get('r1');
    watcher.abortInvalidWorkItemRuns('w1');
    expect(entry.abortController.signal.aborted).toBe(false);
    store.isActiveRun.mockReturnValue(false);
    watcher.abortInvalidWorkItemRuns('w1');
    expect(entry.abortController.signal.aborted).toBe(true);
    gate.resolve({ outcome: 'completed', summary: '', evidence: [] });
    await entry.promise;
  });
});
