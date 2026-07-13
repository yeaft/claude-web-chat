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
