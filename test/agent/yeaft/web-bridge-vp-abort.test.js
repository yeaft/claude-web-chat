import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { NullTrace } from '../../../agent/yeaft/debug-trace.js';
import { AmsRegistry } from '../../../agent/yeaft/memory/ams-registry.js';
import { ToolRegistry } from '../../../agent/yeaft/tools/registry.js';

const sent = [];
const tempDirs = [];

vi.mock('../../../agent/connection/buffer.js', () => ({
  sendToServer: vi.fn((msg) => { sent.push(msg); }),
}));

const {
  handleYeaftAbortTurn,
  __testDrainVpDrivers,
  __testEnqueueForVp,
  __testGroupHistory,
  __testHandleEngineEvent,
  __testHooks,
  __testRaceWithEscalation,
  __testResetVpState,
  __testSetSession,
  installYeaftRuntimeBridge,
} = await import('../../../agent/yeaft/web-bridge.js');

describe('Yeaft VP turn abort routing', () => {
  beforeEach(() => {
    sent.length = 0;
    __testHooks.resetAbortState();
  });

  afterEach(async () => {
    __testSetSession(null);
    await __testResetVpState();
    while (tempDirs.length > 0) {
      rmSync(tempDirs.pop(), { recursive: true, force: true });
    }
  });

  it('treats a cooperative clean-close abort as stopped without appending completion history', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'yeaft-bridge-abort-'));
    tempDirs.push(tempDir);
    let streamStarted;
    const started = new Promise(resolve => { streamStarted = resolve; });
    const adapter = {
      async *stream(params) {
        yield { type: 'text_delta', text: 'truncated assistant output' };
        streamStarted();
        await new Promise(resolve => params.signal.addEventListener('abort', resolve, { once: true }));
        // Cooperative proxy behavior: close the SSE body without throwing.
      },
      async call() { return { text: 'ok', usage: {} }; },
    };
    const sessionLike = {
      adapter,
      trace: new NullTrace(),
      config: {
        model: 'test-model',
        maxOutputTokens: 1024,
        _readOnly: true,
        language: 'en',
      },
      conversationStore: {
        append(record) { return { id: 'persisted', ...record }; },
        loadRecentBySession() { return []; },
        readCompactSummary() { return ''; },
      },
      memoryIndex: null,
      amsRegistry: null,
      toolRegistry: new ToolRegistry(),
      skillManager: null,
      mcpManager: null,
      yeaftDir: tempDir,
      taskManager: null,
      toolStats: null,
    };

    __testSetSession(sessionLike);
    installYeaftRuntimeBridge(sessionLike);
    __testEnqueueForVp('session-abort', 'vp-a', {
      sessionId: 'session-abort',
      trigger: 'mention',
      msg: {
        id: 'msg-abort',
        from: 'user',
        role: 'user',
        text: 'start then stop',
        meta: {},
      },
    });

    await started;
    handleYeaftAbortTurn({ sessionId: 'session-abort', vpId: 'vp-a' });
    await __testDrainVpDrivers();

    const resultFrames = sent.filter(msg => msg.type === 'yeaft_output' && msg.data?.type === 'result');
    expect(resultFrames).toHaveLength(1);
    expect(resultFrames[0].data).toMatchObject({ stopped: true });

    const terminalEvents = sent.filter(msg => msg.event?.type === 'vp_turn_end');
    expect(terminalEvents).toHaveLength(1);
    expect(terminalEvents[0].event.reason).toBe('aborted');
    expect(terminalEvents.some(msg => msg.event.reason === 'end_turn')).toBe(false);
    expect(__testGroupHistory('session-abort')).toEqual([]);
  });

  it('does not turn a completed answer into stopped when AMS maintenance stalls', async () => {
    vi.useFakeTimers();
    try {
      const tempDir = mkdtempSync(join(tmpdir(), 'yeaft-bridge-ams-timeout-'));
      tempDirs.push(tempDir);
      let firstAdjustStarted;
      let secondAdjustStarted;
      const firstAdjustCallStarted = new Promise(resolve => { firstAdjustStarted = resolve; });
      const secondAdjustCallStarted = new Promise(resolve => { secondAdjustStarted = resolve; });
      const maintenanceSignals = [];
      const adapter = {
        async *stream() {
          yield { type: 'text_delta', text: 'completed answer' };
          yield { type: 'stop', stopReason: 'end_turn' };
        },
        async call(params) {
          maintenanceSignals.push(params.signal || null);
          if (maintenanceSignals.length === 1) firstAdjustStarted();
          if (maintenanceSignals.length === 2) secondAdjustStarted();
          // Deliberately ignore AbortSignal: the Engine's independent deadline
          // must release the VP driver even when the maintenance provider does not.
          return await new Promise(() => {});
        },
      };
      const memoryIndex = {
        search() { return []; },
        listByScope() { return []; },
        get() { return null; },
      };
      const sessionLike = {
        adapter,
        trace: new NullTrace(),
        config: {
          model: 'test-model',
          maxOutputTokens: 1024,
          _readOnly: true,
          language: 'en',
        },
        conversationStore: {
          append(record) { return { id: 'persisted', ...record }; },
          loadRecentBySession() { return []; },
          readCompactSummary() { return ''; },
        },
        memoryIndex,
        amsRegistry: new AmsRegistry({ yeaftDir: tempDir, memoryIndex, config: {} }),
        toolRegistry: new ToolRegistry(),
        skillManager: null,
        mcpManager: null,
        yeaftDir: tempDir,
        taskManager: null,
        toolStats: null,
      };

      __testSetSession(sessionLike);
      installYeaftRuntimeBridge(sessionLike);
      __testEnqueueForVp('session-ams', 'vp-a', {
        sessionId: 'session-ams',
        trigger: 'mention',
        msg: {
          id: 'msg-ams',
          from: 'user',
          role: 'user',
          text: 'finish normally',
          meta: {},
        },
      });

      await firstAdjustCallStarted;
      expect(maintenanceSignals[0]).toBeTruthy();
      expect(maintenanceSignals[0].aborted).toBe(false);

      await vi.advanceTimersByTimeAsync(30_000);
      await __testDrainVpDrivers();

      // A timed-out maintenance call must not leave the per-VP driver wedged.
      __testEnqueueForVp('session-ams', 'vp-a', {
        sessionId: 'session-ams',
        trigger: 'mention',
        msg: {
          id: 'msg-ams-2',
          from: 'user',
          role: 'user',
          text: 'finish normally again',
          meta: {},
        },
      });
      await secondAdjustCallStarted;
      await vi.advanceTimersByTimeAsync(30_000);
      await __testDrainVpDrivers();
      await vi.advanceTimersByTimeAsync(120_000);

      const resultFrames = sent.filter(msg => msg.type === 'yeaft_output' && msg.data?.type === 'result');
      expect(resultFrames).toHaveLength(2);
      expect(resultFrames.every(msg => msg.data.stopped !== true)).toBe(true);
      const terminalEvents = sent.filter(msg => msg.event?.type === 'vp_turn_end');
      expect(terminalEvents).toHaveLength(2);
      expect(terminalEvents.every(msg => msg.event.reason === 'end_turn')).toBe(true);
      expect(maintenanceSignals).toHaveLength(2);
      expect(maintenanceSignals.every(signal => signal?.aborted)).toBe(true);
      expect(__testGroupHistory('session-ams').filter(row => row.role === 'assistant'
        && row.content === 'completed answer')).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('removes a queued VP turn by turnId before an AbortController exists', () => {
    __testHooks.seedQueuedVpTurn({
      sessionId: 'session-1',
      vpId: 'vp-a',
      threadId: 'main',
      turnId: 'turn-a',
    });
    __testHooks.seedQueuedVpTurn({
      sessionId: 'session-1',
      vpId: 'vp-b',
      threadId: 'main',
      turnId: 'turn-b',
    });

    handleYeaftAbortTurn({ turnId: 'turn-a' });

    expect(__testHooks.queuedTurnIds()).toEqual(['turn-b']);
    expect(sent.some((msg) => msg.event?.type === 'yeaft_turn_aborted'
      && msg.event.turnId === 'turn-a'
      && msg.event.success === true)).toBe(true);
    expect(sent.some((msg) => msg.event?.type === 'vp_turn_end'
      && msg.event.turnId === 'turn-a'
      && msg.event.reason === 'aborted')).toBe(true);
  });

  it('aborts only the matching running VP turn', () => {
    const a = __testHooks.seedRunningVpTurn({ turnId: 'turn-a', vpId: 'vp-a' });
    const b = __testHooks.seedRunningVpTurn({ turnId: 'turn-b', vpId: 'vp-b' });

    handleYeaftAbortTurn({ turnId: 'turn-a' });

    expect(a.ctrl.signal.aborted).toBe(true);
    expect(b.ctrl.signal.aborted).toBe(false);
    expect(sent.some((msg) => msg.event?.type === 'yeaft_turn_aborted'
      && msg.event.turnId === 'turn-a'
      && msg.event.success === true)).toBe(true);
  });

  it('aborts a running VP turn by sessionId and vpId when turnId is unknown to the UI', () => {
    const a = __testHooks.seedRunningVpTurn({ sessionId: 'session-1', turnId: 'turn-a', vpId: 'vp-a' });
    const b = __testHooks.seedRunningVpTurn({ sessionId: 'session-1', turnId: 'turn-b', vpId: 'vp-b' });
    const c = __testHooks.seedRunningVpTurn({ sessionId: 'session-2', turnId: 'turn-c', vpId: 'vp-a' });

    handleYeaftAbortTurn({ sessionId: 'session-1', vpId: 'vp-a' });

    expect(a.ctrl.signal.aborted).toBe(true);
    expect(b.ctrl.signal.aborted).toBe(false);
    expect(c.ctrl.signal.aborted).toBe(false);
    expect(sent.some((msg) => msg.event?.type === 'yeaft_turn_aborted'
      && msg.event.turnId === 'turn-a'
      && msg.event.turnIds?.includes('turn-a')
      && msg.event.sessionId === 'session-1'
      && msg.event.vpId === 'vp-a'
      && msg.event.success === true)).toBe(true);
  });

  it('removes a queued VP turn by sessionId and vpId before an AbortController exists', () => {
    __testHooks.seedQueuedVpTurn({ sessionId: 'session-1', vpId: 'vp-a', turnId: 'turn-a' });
    __testHooks.seedQueuedVpTurn({ sessionId: 'session-1', vpId: 'vp-b', turnId: 'turn-b' });
    __testHooks.seedQueuedVpTurn({ sessionId: 'session-2', vpId: 'vp-a', turnId: 'turn-c' });

    handleYeaftAbortTurn({ sessionId: 'session-1', vpId: 'vp-a' });

    expect(__testHooks.queuedTurnIds().sort()).toEqual(['turn-b', 'turn-c']);
    expect(sent.some((msg) => msg.event?.type === 'vp_turn_end'
      && msg.event.turnId === 'turn-a'
      && msg.event.reason === 'aborted')).toBe(true);
    expect(sent.some((msg) => msg.event?.type === 'yeaft_turn_aborted'
      && msg.event.turnIds?.includes('turn-a')
      && msg.event.success === true)).toBe(true);
  });

  it('does not escalate a healthy long-running turn before abort', async () => {
    vi.useFakeTimers();
    try {
      const ctrl = new AbortController();
      let resolveInner;
      const inner = new Promise(resolve => { resolveInner = resolve; });
      const onEscalate = vi.fn();
      const raced = __testRaceWithEscalation(inner, {
        signal: ctrl.signal,
        graceMs: 15_000,
        onEscalate,
      });

      await vi.advanceTimersByTimeAsync(600_000);
      expect(onEscalate).not.toHaveBeenCalled();

      resolveInner('completed');
      await expect(raced).resolves.toBe('completed');
    } finally {
      vi.useRealTimers();
    }
  });

  it('escalates only after the abort grace period expires', async () => {
    vi.useFakeTimers();
    try {
      const ctrl = new AbortController();
      const onEscalate = vi.fn();
      const raced = __testRaceWithEscalation(new Promise(() => {}), {
        signal: ctrl.signal,
        graceMs: 15_000,
        onEscalate,
      });

      await vi.advanceTimersByTimeAsync(600_000);
      expect(onEscalate).not.toHaveBeenCalled();

      ctrl.abort();
      await vi.advanceTimersByTimeAsync(14_999);
      expect(onEscalate).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      await expect(raced).resolves.toBeUndefined();
      expect(onEscalate).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancels pending escalation when the turn settles during abort grace', async () => {
    vi.useFakeTimers();
    try {
      const ctrl = new AbortController();
      let resolveInner;
      const inner = new Promise(resolve => { resolveInner = resolve; });
      const onEscalate = vi.fn();
      const raced = __testRaceWithEscalation(inner, {
        signal: ctrl.signal,
        graceMs: 15_000,
        onEscalate,
      });

      ctrl.abort();
      await vi.advanceTimersByTimeAsync(5_000);
      resolveInner('aborted cleanly');
      await expect(raced).resolves.toBe('aborted cleanly');

      await vi.advanceTimersByTimeAsync(20_000);
      expect(onEscalate).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops the LLM silence watchdog only at an explicit terminal turn boundary', () => {
    const pauseQueryTimer = vi.fn();
    const resetQueryTimer = vi.fn();
    const hctx = {
      pauseQueryTimer,
      resetQueryTimer,
      sessionId: 'session-1',
      vpId: 'vp-a',
      turnId: 'turn-a',
      threadId: 'main',
    };

    __testHandleEngineEvent({
      type: 'turn_end',
      stopReason: 'tool_use',
      terminal: false,
      threadId: 'main',
    }, hctx);
    expect(resetQueryTimer).toHaveBeenCalledTimes(1);
    expect(pauseQueryTimer).not.toHaveBeenCalled();

    __testHandleEngineEvent({
      type: 'turn_end',
      stopReason: 'end_turn',
      terminal: true,
      threadId: 'main',
    }, hctx);
    expect(resetQueryTimer).toHaveBeenCalledTimes(1);
    expect(pauseQueryTimer).toHaveBeenCalledTimes(1);
  });

  it('pauses the LLM silence watchdog while the engine waits on a background task', () => {
    const pauseQueryTimer = vi.fn();
    const resetQueryTimer = vi.fn();
    const hctx = {
      pauseQueryTimer,
      resetQueryTimer,
      sessionId: 'session-1',
      vpId: 'vp-a',
      turnId: 'turn-a',
      threadId: 'main',
    };

    __testHandleEngineEvent({
      type: 'async_task_wait_start',
      turnId: 'turn-a',
      threadId: 'main',
      loopNumber: 1,
      pendingTaskIds: ['task-1'],
    }, hctx);
    expect(pauseQueryTimer).toHaveBeenCalledTimes(1);
    expect(resetQueryTimer).not.toHaveBeenCalled();

    __testHandleEngineEvent({
      type: 'async_task_wait_end',
      turnId: 'turn-a',
      threadId: 'main',
      loopNumber: 1,
      aborted: false,
      remainingTaskIds: [],
    }, hctx);
    expect(resetQueryTimer).toHaveBeenCalledTimes(1);
  });

  it('forwards safe auth error metadata as a structured session event', () => {
    const err = new Error('LLM provider returned HTTP 403 (unknown_forbidden)');
    err.name = 'LLMAuthError';
    err.statusCode = 403;
    err.reasonCode = 'unknown_forbidden';
    err.provider = 'test-provider';
    err.model = 'test-provider/test-model';
    err.credentialRefreshable = false;

    __testHandleEngineEvent({ type: 'error', error: err, retryable: false }, {
      resetQueryTimer: vi.fn(),
      sessionId: 'session-1',
      vpId: 'vp-a',
      turnId: 'turn-a',
      threadId: 'main',
    });

    expect(sent).toContainEqual(expect.objectContaining({
      type: 'yeaft_output',
      event: expect.objectContaining({
        type: 'error',
        statusCode: 403,
        reasonCode: 'unknown_forbidden',
        provider: 'test-provider',
        model: 'test-provider/test-model',
        credentialRefreshable: false,
      }),
    }));
  });

  it('forwards final stream idle error metadata as a structured session event', () => {
    const err = new Error('OpenAI stream idle timeout after 20000ms');
    err.name = 'LLMStreamIdleTimeoutError';

    __testHandleEngineEvent({
      type: 'error',
      error: err,
      retryable: true,
      reason: 'stream_idle_timeout',
      retryExhausted: true,
    }, {
      resetQueryTimer: vi.fn(),
      sessionId: 'session-1',
      vpId: 'vp-a',
      turnId: 'turn-a',
      threadId: 'main',
    });

    expect(sent).toContainEqual(expect.objectContaining({
      type: 'yeaft_output',
      sessionId: 'session-1',
      vpId: 'vp-a',
      turnId: 'turn-a',
      event: expect.objectContaining({
        type: 'error',
        message: 'OpenAI stream idle timeout after 20000ms',
        errorName: 'LLMStreamIdleTimeoutError',
        retryable: true,
        reason: 'stream_idle_timeout',
        retryExhausted: true,
      }),
    }));
    expect(sent).toContainEqual(expect.objectContaining({
      type: 'yeaft_output',
      data: expect.objectContaining({ type: 'assistant' }),
    }));
  });
});
