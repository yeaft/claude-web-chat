import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WorkItemWatcher } from '../../../../agent/yeaft/work-center/watcher.js';
import { WorkItemStore } from '../../../../agent/yeaft/work-center/store.js';
import { WorkflowController } from '../../../../agent/yeaft/work-center/controller.js';

function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}

describe('WorkItemWatcher', () => {
  it('starts ready Actions up to the configured concurrency limit', async () => {
    const gates = [deferred(), deferred(), deferred(), deferred()];
    const claims = gates.map((_, index) => ({
      workItem: { id: `w${index + 1}` }, action: { id: `a${index + 1}` },
      run: { id: `r${index + 1}`, leaseEpoch: 1 },
    }));
    const store = {
      claimReadyAction: vi.fn(() => claims.shift() || null),
      renewLease: vi.fn(() => true), interruptRun: vi.fn(() => true),
      isActiveRun: vi.fn(() => true), getWorkItemDetail: vi.fn(id => ({ id })),
    };
    const controller = { submit: vi.fn(({ id } = {}) => ({ id, status: 'done' })) };
    const runner = { run: vi.fn((claim) => gates[Number(claim.run.id.slice(1)) - 1].promise) };
    const watcher = new WorkItemWatcher({
      store, controller, runner, ownerBootId: 'boot', pollIntervalMs: 60_000, leaseMs: 60_000,
      concurrencyProvider: () => 3,
    });

    await watcher.tick();
    expect(runner.run).toHaveBeenCalledTimes(3);
    expect(watcher.activeRuns.size).toBe(3);
    gates[0].resolve({ outcome: 'completed', summary: '', evidence: [] });
    await watcher.activeRuns.get('r1').promise;
    await new Promise(resolve => setImmediate(resolve));
    expect(runner.run).toHaveBeenCalledTimes(4);
    gates.slice(1).forEach(gate => gate.resolve({ outcome: 'completed', summary: '', evidence: [] }));
    await Promise.all([...watcher.activeRuns.values()].map(entry => entry.promise));
    await watcher.stop();
  });

  it('cleans a prepared workspace exactly once when an active Run is stopped', async () => {
    const gate = deferred();
    const claim = { workItem: { id: 'w1' }, action: { id: 'a1', workspace: { isolated: true } }, run: { id: 'r1', leaseEpoch: 1 } };
    const cleanup = vi.fn();
    const runner = {
      prepare: vi.fn(value => value), cleanup,
      run: vi.fn(({ signal }) => new Promise(resolve => signal.addEventListener('abort', () => resolve({ outcome: 'retryable' }), { once: true }))),
    };
    const store = {
      recoverInterruptedRuns: vi.fn(() => 0),
      claimReadyAction: vi.fn().mockReturnValueOnce(claim).mockReturnValue(null),
      renewLease: vi.fn(() => true), interruptRun: vi.fn(() => true),
      isActiveRun: vi.fn(() => true), getWorkItemDetail: vi.fn(id => ({ id })),
    };
    const watcher = new WorkItemWatcher({ store, controller: { submit: vi.fn() }, runner, ownerBootId: 'boot', pollIntervalMs: 60_000, leaseMs: 60_000 });
    await watcher.tick();
    await watcher.stop();
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(cleanup).toHaveBeenCalledWith(claim.action);
    gate.resolve?.();
  });

  it('cleans a prepared workspace after runner failure', async () => {
    const claim = { workItem: { id: 'w1' }, action: { id: 'a1' }, run: { id: 'r1', leaseEpoch: 1 } };
    const cleanup = vi.fn();
    const store = {
      recoverInterruptedRuns: vi.fn(() => 0),
      claimReadyAction: vi.fn().mockReturnValueOnce(claim).mockReturnValue(null),
      renewLease: vi.fn(() => true), interruptRun: vi.fn(() => true), isActiveRun: vi.fn(() => true), getWorkItemDetail: vi.fn(id => ({ id })),
    };
    const controller = { submit: vi.fn(() => ({ id: 'w1' })) };
    const watcher = new WorkItemWatcher({ store, controller, runner: { run: vi.fn().mockRejectedValue(new Error('boom')), cleanup }, ownerBootId: 'boot', pollIntervalMs: 60_000, leaseMs: 60_000 });
    await watcher.tick();
    await vi.waitFor(() => expect(cleanup).toHaveBeenCalledTimes(1));
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
          response: 'Inspecting files',
          loopCount: 1,
          toolCount: 2,
          checkpoint: {
            version: 1,
            toolEvents: [{ name: 'FileRead', status: 'completed', resource: 'src/current.js' }],
          },
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
      response: 'Inspecting files',
      loopCount: 1,
      toolCount: 2,
      checkpoint: {
        version: 1,
        toolEvents: [{ name: 'FileRead', status: 'completed', resource: 'src/current.js' }],
      },
    });
    expect(onEvent).toHaveBeenCalledWith({ type: 'run.progress', workItem: detail });
    resolveRun({ outcome: 'completed', response: 'Done', summary: 'Done', evidence: [] });
    await watcher.activeRuns.get('r1').promise;
  });

  it('does not start a queued Run after stop settles an active Run', async () => {
    const gate = deferred();
    const claims = [
      { workItem: { id: 'w1' }, action: { id: 'a1' }, run: { id: 'r1', leaseEpoch: 1 } },
      { workItem: { id: 'w2' }, action: { id: 'a2' }, run: { id: 'r2', leaseEpoch: 1 } },
    ];
    const store = {
      recoverInterruptedRuns: vi.fn(() => 0),
      claimReadyAction: vi.fn(() => claims.shift() || null),
      renewLease: vi.fn(() => true), interruptRun: vi.fn(() => true),
      isActiveRun: vi.fn(() => true), getWorkItemDetail: vi.fn(id => ({ id })),
    };
    const runner = { run: vi.fn(({ signal }) => new Promise(resolve => {
      signal.addEventListener('abort', () => {
        gate.resolve();
        resolve({ outcome: 'retryable' });
      }, { once: true });
    })) };
    const watcher = new WorkItemWatcher({
      store, controller: { submit: vi.fn() }, runner, ownerBootId: 'boot',
      pollIntervalMs: 60_000, leaseMs: 60_000, concurrencyProvider: () => 1,
    });
    await watcher.tick();
    await watcher.stop();
    await gate.promise;
    await new Promise(resolve => setImmediate(resolve));
    expect(runner.run).toHaveBeenCalledTimes(1);
    expect(watcher.status()).toMatchObject({ enabled: false, activeRuns: 0 });
    expect(watcher.activeRuns.size).toBe(0);
  });

  it('interrupts a claimed Run when stop races with preparation', async () => {
    const prepareGate = deferred();
    const claim = { workItem: { id: 'w1' }, action: { id: 'a1' }, run: { id: 'r1', leaseEpoch: 4 } };
    const prepared = { ...claim, action: { ...claim.action, workspace: { isolated: true } } };
    const cleanup = vi.fn();
    const store = {
      recoverInterruptedRuns: vi.fn(() => 0),
      claimReadyAction: vi.fn().mockReturnValueOnce(claim).mockReturnValue(null),
      renewLease: vi.fn(() => true), interruptRun: vi.fn(() => true),
      isActiveRun: vi.fn(() => true), getWorkItemDetail: vi.fn(id => ({ id })),
    };
    const runner = {
      prepare: vi.fn(() => prepareGate.promise), cleanup, run: vi.fn(),
    };
    const controller = { submit: vi.fn() };
    const watcher = new WorkItemWatcher({
      store, controller, runner, ownerBootId: 'boot', pollIntervalMs: 60_000, leaseMs: 60_000,
    });
    const tick = watcher.tick();
    await vi.waitFor(() => expect(runner.prepare).toHaveBeenCalledTimes(1));
    const stop = watcher.stop();
    prepareGate.resolve(prepared);
    await tick;
    await expect(stop).resolves.toEqual([]);
    expect(cleanup).toHaveBeenCalledWith(prepared.action);
    expect(store.interruptRun).toHaveBeenCalledWith(
      'r1', 'boot', 4, 'Work Center watcher stopped during Action preparation', null,
    );
    expect(runner.run).not.toHaveBeenCalled();
    expect(controller.submit).not.toHaveBeenCalled();
    expect(watcher.status()).toMatchObject({ enabled: false, activeRuns: 0 });
  });

  it('persists an active Run interrupted while stop waits for preparation to settle', async () => {
    const activeGate = deferred();
    const prepareGate = deferred();
    const claims = [
      { workItem: { id: 'w1' }, action: { id: 'a1' }, run: { id: 'r1', leaseEpoch: 1 } },
      { workItem: { id: 'w2' }, action: { id: 'a2' }, run: { id: 'r2', leaseEpoch: 2 } },
    ];
    const store = {
      recoverInterruptedRuns: vi.fn(() => 0), claimReadyAction: vi.fn(() => claims.shift() || null),
      renewLease: vi.fn(() => true), interruptRun: vi.fn(() => true),
      isActiveRun: vi.fn(() => true), getWorkItemDetail: vi.fn(id => ({ id })),
    };
    const runner = {
      prepare: vi.fn(claim => claim.run.id === 'r2' ? prepareGate.promise : claim),
      run: vi.fn(({ signal }) => new Promise(resolve => signal.addEventListener('abort', () => {
        activeGate.resolve();
        resolve({ outcome: 'retryable' });
      }, { once: true }))),
      cleanup: vi.fn(),
    };
    const watcher = new WorkItemWatcher({
      store, controller: { submit: vi.fn() }, runner, ownerBootId: 'boot',
      pollIntervalMs: 60_000, leaseMs: 60_000, concurrencyProvider: () => 2,
    });
    const tick = watcher.tick();
    await vi.waitFor(() => expect(runner.prepare).toHaveBeenCalledTimes(2));
    const stop = watcher.stop();
    await activeGate.promise;
    prepareGate.resolve(claims[1] || {
      workItem: { id: 'w2' }, action: { id: 'a2' }, run: { id: 'r2', leaseEpoch: 2 },
    });
    await tick;
    await stop;
    expect(store.interruptRun).toHaveBeenCalledWith(
      'r1', 'boot', 1, 'Work Center watcher stopped', null,
    );
  });

  it('does not run a queued tick after stop changes the lifecycle', async () => {
    const concurrencyGate = deferred();
    const store = {
      recoverInterruptedRuns: vi.fn(() => 0), claimReadyAction: vi.fn(),
    };
    const watcher = new WorkItemWatcher({
      store, controller: { submit: vi.fn() }, runner: { run: vi.fn() },
      ownerBootId: 'boot', pollIntervalMs: 60_000, leaseMs: 60_000,
      concurrencyProvider: () => concurrencyGate.promise,
    });
    const firstTick = watcher.tick();
    const queuedTick = watcher.tick();
    const stop = watcher.stop();
    concurrencyGate.resolve(1);
    await Promise.all([firstTick, queuedTick, stop]);
    await new Promise(resolve => queueMicrotask(resolve));
    expect(store.claimReadyAction).not.toHaveBeenCalled();
    expect(watcher.status()).toMatchObject({ enabled: false, activeRuns: 0 });
  });

  it('aborts and settles an active Run before closing its fence', async () => {
    const gate = deferred();
    let capturedSignal;
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
      runner: { run: vi.fn(options => {
        capturedSignal = options.signal;
        return gate.promise;
      }) },
      ownerBootId: 'boot', pollIntervalMs: 60_000, leaseMs: 60_000,
    });
    await watcher.tick();
    const stop = watcher.stop();
    expect(capturedSignal.aborted).toBe(true);
    expect(store.interruptRun).not.toHaveBeenCalled();
    gate.resolve({ outcome: 'completed', summary: '', evidence: [] });
    await expect(stop).resolves.toEqual([{ runId: 'r1', interrupted: true }]);
    expect(store.interruptRun).toHaveBeenCalledWith(
      'r1', 'boot', 7, 'Work Center watcher stopped', null,
    );
    expect(watcher.activeRuns.size).toBe(0);
  });

  it('aborts and settles an active Run when the atomic interruption loses its fence', async () => {
    const gate = deferred();
    let capturedSignal;
    const store = {
      claimReadyAction: vi.fn().mockReturnValueOnce({
        workItem: { id: 'w1' }, action: { id: 'a1' }, run: { id: 'r1', leaseEpoch: 5 },
      }),
      renewLease: vi.fn(() => true),
      interruptRun: vi.fn(() => false),
      isActiveRun: vi.fn(() => true),
      getWorkItemDetail: vi.fn(id => ({ id })),
    };
    const runner = { run: vi.fn(options => {
      capturedSignal = options.signal;
      options.registerProgressReader(() => ({
        response: 'latest', loopCount: 1, toolCount: 1, checkpoint: null,
      }));
      return gate.promise;
    }) };
    const watcher = new WorkItemWatcher({
      store, controller: { submit: vi.fn() }, runner,
      ownerBootId: 'boot', pollIntervalMs: 60_000, leaseMs: 60_000,
    });

    await watcher.tick();
    const stop = watcher.stop();
    expect(capturedSignal.aborted).toBe(true);
    expect(store.interruptRun).not.toHaveBeenCalled();
    gate.resolve({ outcome: 'completed', summary: '', evidence: [] });
    await expect(stop).resolves.toEqual([{ runId: 'r1', interrupted: false }]);
    expect(store.interruptRun).toHaveBeenCalledWith(
      'r1', 'boot', 5, 'Work Center watcher stopped',
      { response: 'latest', loopCount: 1, toolCount: 1, checkpoint: null },
    );
    expect(watcher.activeRuns.size).toBe(0);
  });

  it('aborts and settles every active Run before reporting an interruption write error', async () => {
    const gate = deferred();
    let capturedSignal;
    const store = {
      claimReadyAction: vi.fn().mockReturnValueOnce({
        workItem: { id: 'w1' }, action: { id: 'a1' }, run: { id: 'r1', leaseEpoch: 6 },
      }),
      renewLease: vi.fn(() => true),
      interruptRun: vi.fn(() => { throw new Error('sqlite busy'); }),
      isActiveRun: vi.fn(() => true),
      getWorkItemDetail: vi.fn(id => ({ id })),
    };
    const runner = { run: vi.fn(options => {
      capturedSignal = options.signal;
      return gate.promise;
    }) };
    const watcher = new WorkItemWatcher({
      store, controller: { submit: vi.fn() }, runner,
      ownerBootId: 'boot', pollIntervalMs: 60_000, leaseMs: 60_000,
    });

    await watcher.tick();
    const stop = watcher.stop();
    expect(capturedSignal.aborted).toBe(true);
    gate.resolve({ outcome: 'completed', summary: '', evidence: [] });
    await expect(stop).rejects.toThrow(/Could not persist.*interruptions/i);
    expect(watcher.activeRuns.size).toBe(0);
  });

  it('aborts and settles an active Run when reading final progress throws', async () => {
    const gate = deferred();
    let capturedSignal;
    const store = {
      claimReadyAction: vi.fn().mockReturnValueOnce({
        workItem: { id: 'w1' }, action: { id: 'a1' }, run: { id: 'r1', leaseEpoch: 8 },
      }),
      renewLease: vi.fn(() => true),
      interruptRun: vi.fn(() => true),
      isActiveRun: vi.fn(() => true),
      getWorkItemDetail: vi.fn(id => ({ id })),
    };
    const runner = { run: vi.fn(options => {
      capturedSignal = options.signal;
      options.registerProgressReader(() => { throw new Error('progress snapshot failed'); });
      return gate.promise;
    }) };
    const watcher = new WorkItemWatcher({
      store, controller: { submit: vi.fn() }, runner,
      ownerBootId: 'boot', pollIntervalMs: 60_000, leaseMs: 60_000,
    });

    await watcher.tick();
    const stop = watcher.stop();
    expect(capturedSignal.aborted).toBe(true);
    expect(store.interruptRun).not.toHaveBeenCalled();
    gate.resolve({ outcome: 'completed', summary: '', evidence: [] });
    await expect(stop).rejects.toThrow(/Could not persist.*interruptions/i);
    expect(watcher.activeRuns.size).toBe(0);
  });

  it('flushes final usage before atomically closing the Run fence on stop', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'yeaft-work-center-watcher-'));
    const store = new WorkItemStore(join(dir, 'work-center.db'));
    const controller = new WorkflowController(store);
    const item = controller.create({
      title: 'Track interrupted usage',
      goal: 'Persist usage received before watcher shutdown',
      acceptanceCriteria: ['Interrupted usage remains visible'],
      workflowTemplate: 'software-change',
      workDir: '/tmp',
      start: true,
    });
    let progressAccepted = null;
    const runner = {
      run: vi.fn(options => new Promise(resolve => {
        options.signal.addEventListener('abort', () => {
          options.registerProgressReader(() => ({
            response: 'Partial response', loopCount: 1, toolCount: 2, llmRequestCount: 1,
            inputTokens: 100, outputTokens: 20, cacheReadTokens: 10, cacheWriteTokens: 5,
            totalTokens: 135, checkpoint: null,
          }));
          progressAccepted = options.onProgress({
            response: 'Partial response', loopCount: 1, toolCount: 2, llmRequestCount: 1,
            inputTokens: 100, outputTokens: 20, cacheReadTokens: 10, cacheWriteTokens: 5,
            totalTokens: 135, checkpoint: null,
          });
          resolve({ outcome: 'retryable', summary: '', evidence: [] });
        }, { once: true });
      })),
    };
    const watcher = new WorkItemWatcher({
      store, controller, runner,
      ownerBootId: 'boot', pollIntervalMs: 60_000, leaseMs: 60_000,
    });

    try {
      await watcher.tick();
      const runId = store.getWorkItemDetail(item.id).currentRunId;
      await watcher.stop();

      expect(progressAccepted).toBe(true);
      expect(store.getRun(runId)).toMatchObject({
        status: 'interrupted', response: 'Partial response',
        loopCount: 1, toolCount: 2, llmRequestCount: 1,
        inputTokens: 100, outputTokens: 20, cacheReadTokens: 10, cacheWriteTokens: 5,
        totalTokens: 135,
      });
      expect(store.getWorkItemDetail(item.id)).toMatchObject({
        status: 'ready', currentRunId: null,
        actions: [expect.objectContaining({ status: 'ready' })],
      });
      expect(watcher.activeRuns.size).toBe(0);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('recovers an expired lease during a later tick without restarting the watcher', async () => {
    const gate = deferred();
    const claim = { workItem: { id: 'w1' }, action: { id: 'a1' }, run: { id: 'r1', leaseEpoch: 1 } };
    let active = true;
    const store = {
      recoverInterruptedRuns: vi.fn().mockReturnValueOnce(0).mockImplementation(() => {
        active = false;
        return 1;
      }),
      claimReadyAction: vi.fn().mockReturnValueOnce(claim).mockReturnValue(null),
      renewLease: vi.fn(() => true), interruptRun: vi.fn(() => true),
      isActiveRun: vi.fn(() => active), getWorkItemDetail: vi.fn(id => ({ id })),
    };
    const cleanup = vi.fn();
    const runner = { cleanup, run: vi.fn(({ signal }) => new Promise(resolve => {
      signal.addEventListener('abort', () => resolve({ outcome: 'retryable' }), { once: true });
    })) };
    const watcher = new WorkItemWatcher({ store, controller: { submit: vi.fn() }, runner, ownerBootId: 'boot', pollIntervalMs: 60_000, leaseMs: 60_000 });
    await watcher.tick();
    const entry = watcher.activeRuns.get('r1');
    await watcher.tick();
    await entry.promise;
    expect(entry.abortController.signal.reason).toBe('work_item_lease_expired');
    expect(cleanup).toHaveBeenCalledTimes(1);
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
