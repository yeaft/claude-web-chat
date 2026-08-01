import { afterEach, describe, expect, it, vi } from 'vitest';
import { beforeEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createSession } from '../../../agent/yeaft/sessions/session-store.js';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const sent = [];
let resolveLoadSession;
const loadSession = vi.fn(() => new Promise((resolve) => { resolveLoadSession = resolve; }));

vi.mock('../../../agent/connection/buffer.js', () => ({
  sendToServer: vi.fn((msg) => { sent.push(msg); }),
}));

vi.mock('../../../agent/yeaft/session.js', () => ({
  loadSession,
}));

vi.mock('../../../agent/yeaft/status-cache.js', () => ({
  hydrateYeaftStatusFromSession: vi.fn(),
}));

const ctx = (await import('../../../agent/context.js')).default;
const { ConversationStore } = await import('../../../agent/yeaft/conversation/persist.js');
const {
  handleYeaftLoadHistory,
  handleYeaftLoadMoreHistory,
  handleYeaftSessionAddMember,
  handleYeaftSessionRemoveMember,
  handleYeaftSessionSetDefaultVp,
  __testHandleEngineEvent,
  __testGroupHistory,
  __testSetSession,
  __testHooks,
} = await import('../../../agent/yeaft/web-bridge.js');

function flushMicrotasks() {
  return new Promise(resolve => setImmediate(resolve));
}

describe('Yeaft load-history first paint', () => {
  beforeEach(() => {
    __testSetSession(null);
    sent.length = 0;
    loadSession.mockClear();
    resolveLoadSession = null;
    ctx.CONFIG = null;
  });

  afterEach(() => {
    __testSetSession(null);
    sent.length = 0;
    loadSession.mockClear();
    resolveLoadSession = null;
    ctx.CONFIG = null;
  });

  it('filters internal rows and uses a collision-resistant virtual conversation id', () => {
    const firstConversationId = __testHooks.ensureYeaftConversationIdForTest();
    __testHooks.setYeaftConversationIdForTest(null);
    const secondConversationId = __testHooks.ensureYeaftConversationIdForTest();
    expect(firstConversationId).toMatch(/^yeaft-[0-9a-f-]{36}$/);
    expect(secondConversationId).toMatch(/^yeaft-[0-9a-f-]{36}$/);
    expect(secondConversationId).not.toBe(firstConversationId);

    const hctx = {
      assistantTextParts: [],
      toolCallsAccum: [],
      toolResultsAccum: [],
      resetQueryTimer: vi.fn(),
      sessionId: 'session-fast',
      vpId: 'vp-linus',
      turnId: 'turn-retry',
      threadId: 'main',
    };
    __testHandleEngineEvent({
      type: 'llm_retry',
      attempt: 2,
      maxRetries: 3,
      delayMs: 2000,
      reason: 'stream_idle_timeout',
      recoveryMode: 'continue',
      errorName: 'LLMStreamIdleTimeoutError',
      statusCode: 0,
      message: 'idle',
    }, hctx);
    __testHandleEngineEvent({
      type: 'error',
      error: new Error('OpenAI stream idle timeout after 90000ms'),
      retryable: true,
      reason: 'stream_idle_timeout',
      retryExhausted: true,
      retryAttempts: 3,
      maxRetries: 3,
    }, hctx);
    expect(sent).toContainEqual(expect.objectContaining({
      event: expect.objectContaining({
        type: 'llm_retry',
        recoveryMode: 'continue',
        attempt: 2,
      }),
    }));
    expect(sent).toContainEqual(expect.objectContaining({
      event: expect.objectContaining({
        type: 'vp_status_changed',
        state: 'retrying',
        turnId: 'turn-retry',
      }),
    }));
    expect(sent).toContainEqual(expect.objectContaining({
      event: expect.objectContaining({
        type: 'error',
        retryAttempts: 3,
        message: expect.stringContaining('after 3 fresh request retries'),
      }),
    }));
    expect(sent).toContainEqual(expect.objectContaining({
      data: expect.objectContaining({
        type: 'assistant',
        message: expect.objectContaining({
          content: [{ type: 'text', text: expect.stringContaining('after 3 fresh request retries') }],
        }),
      }),
    }));
    const markEngineTerminal = vi.fn();
    hctx.markEngineTerminal = markEngineTerminal;
    __testHandleEngineEvent({
      type: 'turn_end',
      stopReason: 'error',
      terminal: true,
      threadId: 'main',
    }, hctx);
    expect(markEngineTerminal).toHaveBeenCalledWith('error', expect.objectContaining({
      message: expect.stringContaining('after 3 fresh request retries'),
      reason: 'stream_idle_timeout',
      retryAttempts: 3,
    }));
    expect(__testHooks.decorateSessionsWithRuntimeState([{ id: 'session-fast' }])).toEqual([
      expect.objectContaining({
        id: 'session-fast',
        running: false,
        active: false,
        runningVpCount: 0,
      }),
    ]);
    expect(sent).toContainEqual(expect.objectContaining({
      event: expect.objectContaining({
        type: 'vp_status_changed',
        state: 'error',
        runningThreadCount: 0,
        turnId: 'turn-retry',
      }),
    }));
    sent.length = 0;

    const rows = [
      { id: 'm0001', role: 'user', content: 'visible q', sessionId: 'session-fast', threadId: 'main' },
      { id: 'm0002', role: 'user', content: '<task-result id="task_1" kind="shell" status="succeeded">\nPASS\n</task-result>', sessionId: 'session-fast', threadId: 'main' },
      { id: 'm0003', role: 'user', content: '[system note] You have called ListAgents with the same arguments 3 times. Previous result: {...}', sessionId: 'session-fast', threadId: 'main' },
      { id: 'm0004', role: 'assistant', content: 'visible a', sessionId: 'session-fast', threadId: 'main', speakerVpId: 'vp-linus' },
      { id: 'm0005', role: 'user', content: 'In docs, <task-result> is just prose', sessionId: 'session-fast', threadId: 'main' },
      { id: 'm0006', role: 'user', content: 'model-only continuation', sessionId: 'session-fast', threadId: 'main', userAuthored: false },
    ];
    const page = __testHooks.loadVisibleGroupHistoryPage({
      loadOlderBySession() {
        return { messages: rows };
      },
    }, 'session-fast', 10);

    expect(page.messages.map(m => m.content)).toEqual([
      'visible q',
      'visible a',
      'In docs, <task-result> is just prose',
    ]);

    const quote = {
      id: 'm0001', role: 'assistant', author: 'Linus', content: 'Prior answer',
      todos: [{ content: 'Verify', status: 'completed' }],
    };
    const projected = __testHooks.projectVisibleHistoryChunkMessages([
      { id: 'm0002', role: 'user', content: 'Follow up', sessionId: 'session-fast', quote },
    ]);
    expect(projected[0]).toMatchObject({ id: 'm0002', quote });
  });

  it('projects the latest TodoWrite snapshot without counting it as a generic tool summary', () => {
    const projected = __testHooks.projectVisibleHistoryChunkMessages([{
      id: 'm0003',
      role: 'assistant',
      content: 'Progress',
      sessionId: 'session-fast',
      responseKind: 'progress',
      toolCalls: [
        { id: 'todo-old', name: 'TodoWrite', input: { todos: [{ content: 'Old', status: 'pending' }] } },
        { id: 'bash', name: 'Bash', input: { command: 'true' } },
        { id: 'todo-new', name: 'TodoWrite', input: { todos: [{ content: 'New', status: 'completed' }] } },
      ],
    }]);

    expect(projected[0]).toMatchObject({
      todos: [{ content: 'New', status: 'completed' }],
      toolSummaryCount: 1,
      responseKind: 'progress',
    });

    expect(__testHooks.projectVisibleHistoryChunkMessages([{
      id: 'm0004', role: 'assistant', content: 'Partial', sessionId: 'session-fast',
      incomplete: true, stopReason: 'aborted',
    }])[0]).toMatchObject({ responseKind: 'progress' });
    expect(__testHooks.projectVisibleHistoryChunkMessages([{
      id: 'm0005', role: 'assistant', content: 'Partial before error', sessionId: 'session-fast',
      responseKind: 'result', incomplete: true, stopReason: 'error',
    }])[0]).toMatchObject({
      responseKind: 'progress', incomplete: true, stopReason: 'error',
    });
    expect(__testHooks.projectVisibleHistoryChunkMessages([{
      id: 'm0006', role: 'assistant', content: 'Cancelled partial', sessionId: 'session-fast',
      responseKind: 'result', stopReason: 'cancelled',
    }])[0]).toMatchObject({ responseKind: 'progress', stopReason: 'cancelled' });

    const markEngineTerminal = vi.fn();
    const handlerCtx = {
      assistantTextParts: [],
      toolCallsAccum: [],
      toolResultsAccum: [],
      resetQueryTimer: vi.fn(),
      pauseQueryTimer: vi.fn(),
      markEngineTerminal,
      sessionId: 'session-fast',
      vpId: 'vp-linus',
      turnId: 'turn-error',
      threadId: 'main',
    };
    __testHandleEngineEvent({
      type: 'error',
      error: new Error('provider exploded'),
      retryable: false,
    }, handlerCtx);
    expect(markEngineTerminal).not.toHaveBeenCalled();

    handlerCtx.resetQueryTimer.mockClear();
    handlerCtx.pauseQueryTimer.mockClear();
    __testHandleEngineEvent({
      type: 'llm_retry',
      attempt: 2,
      maxRetries: 2,
      delayMs: 120_000,
      reason: 'temporary_forbidden',
      threadId: 'main',
    }, handlerCtx);
    expect(handlerCtx.pauseQueryTimer).toHaveBeenCalledTimes(1);
    expect(handlerCtx.resetQueryTimer).not.toHaveBeenCalled();
    expect(sent).toContainEqual(expect.objectContaining({
      event: expect.objectContaining({
        type: 'llm_retry',
        delayMs: 120_000,
      }),
    }));
    expect(sent.at(-1)).toMatchObject({
      sessionId: 'session-fast',
      vpId: 'vp-linus',
      turnId: 'turn-error',
      threadId: 'main',
    });
    __testHandleEngineEvent({ type: 'turn_start', threadId: 'main' }, handlerCtx);
    expect(handlerCtx.resetQueryTimer).toHaveBeenCalledTimes(1);

    __testHandleEngineEvent({
      type: 'turn_end',
      stopReason: 'error',
      terminal: true,
      threadId: 'main',
    }, handlerCtx);
    expect(markEngineTerminal).toHaveBeenCalledWith('error', { message: 'provider exploded' });

    sent.length = 0;
    const waitWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      __testHandleEngineEvent({
        type: 'async_task_wait_end',
        turnId: 'turn-stalled-task',
        threadId: 'main',
        loopNumber: 2,
        aborted: false,
        remainingTaskIds: [],
        timedOut: true,
        deferredTaskIds: ['task-stalled'],
      }, handlerCtx);
      expect(handlerCtx.resetQueryTimer).toHaveBeenCalled();
      expect(waitWarn).toHaveBeenCalledWith(
        expect.stringContaining('async task wait timed out'),
        ['task-stalled'],
      );
      expect(sent).toContainEqual(expect.objectContaining({
        event: expect.objectContaining({
          type: 'vp_async_task_wait_end',
          timedOut: true,
          deferredTaskIds: ['task-stalled'],
        }),
      }));
    } finally {
      waitWarn.mockRestore();
    }
  });

  it('preserves TodoWrite through the real store page and history wire projection', () => {
    const dir = mkdtempSync(join(tmpdir(), 'yeaft-todo-history-'));
    try {
      const store = new ConversationStore(dir);
      store.append({ role: 'user', content: 'status?', sessionId: 'session-fast' });
      store.append({
        role: 'assistant',
        content: 'Progress',
        sessionId: 'session-fast',
        speakerVpId: 'vp-linus',
        responseKind: 'result',
        stopReason: 'end_turn',
        toolCalls: [
          { id: 'todo', name: 'TodoWrite', input: { todos: [{ content: 'Verify', status: 'completed' }] } },
          { id: 'bash', name: 'Bash', input: { command: 'true' } },
        ],
      });

      const page = __testHooks.loadVisibleGroupHistoryPage(store, 'session-fast', 1);
      const projected = __testHooks.projectVisibleHistoryChunkMessages(page.messages);

      expect(page.messages[1]).toMatchObject({
        todos: [{ content: 'Verify', status: 'completed' }],
        toolSummaryCount: 1,
        responseKind: 'result',
      });
      expect(projected[1]).toMatchObject({
        todos: [{ content: 'Verify', status: 'completed' }],
        toolSummaryCount: 1,
        responseKind: 'result',
      });

      store.append({
        role: 'assistant', content: 'Persisted partial', sessionId: 'session-fast',
        speakerVpId: 'vp-linus', responseKind: 'result', incomplete: true, stopReason: 'error',
      });
      const failedPage = __testHooks.loadVisibleGroupHistoryPage(store, 'session-fast', 1);
      const failedProjected = __testHooks.projectVisibleHistoryChunkMessages(failedPage.messages);
      expect(failedPage.messages.at(-1)).toMatchObject({
        responseKind: 'progress', incomplete: true, stopReason: 'error',
      });
      expect(failedProjected.at(-1)).toMatchObject({
        responseKind: 'progress', incomplete: true, stopReason: 'error',
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('preserves the canonical image asset anchor in the history wire projection', () => {
    const projected = __testHooks.projectVisibleHistoryChunkMessages([
      { id: 'm0001', role: 'assistant', content: 'tool progress', sessionId: 'session-fast', turnId: 'turn-image' },
      { id: 'm0002', role: 'assistant', content: 'final response', sessionId: 'session-fast', turnId: 'turn-image', imageAssetAnchor: true },
    ]);

    expect(projected[0]).not.toHaveProperty('imageAssetAnchor');
    expect(projected[1]).toMatchObject({
      id: 'm0002',
      turnId: 'turn-image',
      imageAssetAnchor: true,
    });
  });

  it('projects a persisted AskUser answer as terminal history metadata', () => {
    const projected = __testHooks.projectVisibleHistoryChunkMessages([
      {
        id: 'm0100',
        role: 'assistant',
        content: '',
        sessionId: 'session-fast',
        threadId: 'thread-a',
        turnId: 'turn-a',
        speakerVpId: 'vp-a',
        toolCalls: [{ id: 'ask_1', name: 'AskUser', input: { question: 'Continue?', options: ['Yes', 'No'] } }],
      },
      {
        id: 'm0101',
        role: 'tool',
        content: JSON.stringify({ question: 'Continue?', answers: { 'Continue?': 'Yes' } }),
        sessionId: 'session-fast',
        threadId: 'thread-a',
        turnId: 'turn-a',
        speakerVpId: 'vp-a',
        toolCallId: 'ask_1',
      },
    ]);

    expect(projected).toEqual([
      expect.objectContaining({
        id: 'm0100',
        role: 'assistant',
        askUserResults: [{
          toolCallId: 'ask_1',
          status: 'answered',
          question: 'Continue?',
          options: ['Yes', 'No'],
          answers: { 'Continue?': 'Yes' },
        }],
      }),
    ]);
    expect(projected[0].toolSummaryCount).toBeUndefined();
  });

  it('loads older pages from persisted history before runtime boot resolves', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'yeaft-fast-older-history-'));
    try {
      ctx.CONFIG = { yeaftDir: dir };
      const store = new ConversationStore(dir);
      const appended = store.appendBatch(Array.from({ length: 24 }, (_, index) => ({
        role: index % 2 === 0 ? 'user' : 'assistant',
        content: `history ${index + 1}`,
        sessionId: 'session-fast-older',
        ...(index % 2 === 0 ? {} : { speakerVpId: 'vp-linus' }),
      })));

      await handleYeaftLoadMoreHistory({
        sessionId: 'session-fast-older',
        beforeSeq: store.getMessageSeqById(appended.at(-1).id) + 1,
        turns: 20,
      });

      expect(loadSession).not.toHaveBeenCalled();
      const chunk = sent.find(message => message.type === 'yeaft_history_chunk' && message.mode === 'older');
      expect(chunk).toMatchObject({ sessionId: 'session-fast-older', turns: 20 });
      expect(chunk.messages).toHaveLength(24);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('replays the recent message window before full session boot resolves', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'yeaft-fast-history-'));
    try {
      ctx.CONFIG = { yeaftDir: dir };
      const store = new ConversationStore(dir);
      store.appendBatch([
        { role: 'user', content: 'old q', sessionId: 'session-fast' },
        { role: 'assistant', content: 'old a', sessionId: 'session-fast', speakerVpId: 'vp-linus' },
        { role: 'user', content: 'new q', sessionId: 'session-fast' },
        { role: 'assistant', content: '', sessionId: 'session-fast', speakerVpId: 'vp-linus', toolCalls: [{ id: 'tool-1', name: 'Bash', input: { command: 'echo ok' } }] },
      ]);

      const pending = handleYeaftLoadHistory({
        sessionId: 'session-fast',
        limit: 1,
        requestId: 'history-request-1',
        _requestClientId: 'web-client-1',
      });
      await flushMicrotasks();

      expect(loadSession).toHaveBeenCalledTimes(1);
      const chunk = sent.find(m => m.type === 'yeaft_history_chunk');
      expect(chunk).toMatchObject({
        type: 'yeaft_history_chunk',
        sessionId: 'session-fast',
        requestId: 'history-request-1',
        _requestClientId: 'web-client-1',
        mode: 'recent',
        hasMore: true,
        messages: [
          { role: 'user', content: 'new q', sessionId: 'session-fast' },
          { role: 'assistant', content: '', sessionId: 'session-fast', speakerVpId: 'vp-linus', toolSummaryCount: 1 },
        ],
      });
      const historyDone = sent.find(m => m.event?.type === 'history_loaded');
      expect(historyDone).toMatchObject({
        type: 'yeaft_output',
        requestId: 'history-request-1',
        _requestClientId: 'web-client-1',
        event: {
          type: 'history_loaded',
          mode: 'recent',
          count: 2,
          sessionId: 'session-fast',
          requestId: 'history-request-1',
          hasMore: true,
        },
      });
      expect(sent.filter(m => m.type === 'yeaft_output' && m.data)).toHaveLength(0);

      await pending;
      const historyLoadedEvents = sent.filter(m => m.event?.type === 'history_loaded');
      expect(historyLoadedEvents).toHaveLength(1);
      expect(sent.some(m => m.event?.type === 'session_ready' && !m.event.partial)).toBe(false);

      resolveLoadSession({
        conversationStore: store,
        config: { model: 'test-model', availableModels: [] },
        status: { skills: 0, mcpServers: [], tools: 0 },
        taskManager: { listActiveTasks: () => [] },
      });
      await flushMicrotasks();

      await new Promise(resolve => setTimeout(resolve, 0));
      const ready = sent.find(m => m.event?.type === 'session_ready' && !m.event.partial);
      expect(ready).toMatchObject({
        type: 'yeaft_output',
        sessionId: 'session-fast',
        event: { type: 'session_ready' },
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('cold-start history uses the user-level session store before runtime boot', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'yeaft-workdir-history-default-'));
    const workDir = mkdtempSync(join(tmpdir(), 'yeaft-workdir-history-project-'));
    try {
      const sessionId = 'session-workdir';
      const sessionDir = join(dir, 'sessions', sessionId);
      mkdirSync(sessionDir, { recursive: true });
      writeFileSync(join(sessionDir, 'session.json'), `${JSON.stringify({
        id: sessionId,
        name: 'WorkDir Session',
        roster: ['omni'],
        defaultVpId: 'omni',
        workDir,
        createdAt: '2026-06-26T00:00:00.000Z',
      }, null, 2)}\n`);
      mkdirSync(dir, { recursive: true });

      ctx.CONFIG = { yeaftDir: dir };
      const store = new ConversationStore(dir);
      store.append({ role: 'user', content: 'workdir q', sessionId, time: '2026-06-26T01:00:00.000Z' });
      store.append({ role: 'assistant', content: 'workdir a', sessionId, speakerVpId: 'vp-linus', time: '2026-06-26T01:00:01.000Z' });

      const pending = handleYeaftLoadHistory({ sessionId, limit: 1 });
      await flushMicrotasks();

      const chunk = sent.find(m => m.type === 'yeaft_history_chunk' && m.mode === 'recent');
      expect(chunk.messages.map(m => m.content)).toEqual(['workdir q', 'workdir a']);
      expect(loadSession).toHaveBeenCalledTimes(1);
      expect(loadSession.mock.calls[0][0]).toMatchObject({ dir, workDir });
      expect(existsSync(join(workDir, '.yeaft', 'sessions', sessionId, 'conversation', 'segments', '000001.jsonl'))).toBe(false);

      await pending;
      resolveLoadSession({
        conversationStore: store,
        config: { model: 'test-model', availableModels: [] },
        status: { skills: 0, mcpServers: [], tools: 0 },
        taskManager: { listActiveTasks: () => [] },
      });
      await flushMicrotasks();
      await new Promise(resolve => setTimeout(resolve, 0));
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  it('migrates legacy project session history before cold-start replay', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'yeaft-workdir-history-default-'));
    const workDir = mkdtempSync(join(tmpdir(), 'yeaft-workdir-history-project-'));
    try {
      const sessionId = 'session-workdir-legacy';
      const projectSessionDir = join(workDir, '.yeaft', 'sessions', sessionId);
      mkdirSync(projectSessionDir, { recursive: true });
      writeFileSync(join(projectSessionDir, 'session.json'), `${JSON.stringify({
        id: sessionId,
        name: 'Legacy WorkDir Session',
        roster: ['omni'],
        defaultVpId: 'omni',
        workDir,
        createdAt: '2026-06-26T00:00:00.000Z',
      }, null, 2)}\n`);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'group-workdirs.json'), `${JSON.stringify({ [sessionId]: workDir }, null, 2)}\n`);

      ctx.CONFIG = { yeaftDir: dir };
      const projectStore = new ConversationStore(join(workDir, '.yeaft'));
      projectStore.append({ role: 'user', content: 'legacy q', sessionId, time: '2026-06-26T01:00:00.000Z' });
      projectStore.append({ role: 'assistant', content: 'legacy a', sessionId, speakerVpId: 'vp-linus', time: '2026-06-26T01:00:01.000Z' });

      const pending = handleYeaftLoadHistory({ sessionId, limit: 1 });
      await flushMicrotasks();

      const chunk = sent.find(m => m.type === 'yeaft_history_chunk' && m.mode === 'recent');
      expect(chunk.messages.map(m => m.content)).toEqual(['legacy q', 'legacy a']);
      expect(existsSync(join(dir, 'sessions', sessionId, 'session.json'))).toBe(true);
      expect(existsSync(join(dir, 'sessions', sessionId, 'conversation', 'segments', '000001.jsonl'))).toBe(true);
      expect(loadSession).toHaveBeenCalledTimes(1);
      expect(loadSession.mock.calls[0][0]).toMatchObject({ dir, workDir });

      await pending;
      resolveLoadSession({
        conversationStore: new ConversationStore(dir),
        config: { model: 'test-model', availableModels: [] },
        status: { skills: 0, mcpServers: [], tools: 0 },
        taskManager: { listActiveTasks: () => [] },
      });
      await flushMicrotasks();
      await new Promise(resolve => setTimeout(resolve, 0));
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  it('loaded runtime history hydration uses the bounded recent window', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'yeaft-runtime-history-'));
    try {
      ctx.CONFIG = { yeaftDir: dir };
      const store = new ConversationStore(dir);
      for (let i = 0; i < 500; i++) {
        store.append({ role: 'user', content: `old ${i}`, sessionId: 'session-fast' });
        store.append({ role: 'assistant', content: `old answer ${i}`, sessionId: 'session-fast', speakerVpId: 'vp-linus' });
      }
      store.append({ role: 'user', content: 'latest q', sessionId: 'session-fast' });
      store.append({ role: 'assistant', content: 'latest a', sessionId: 'session-fast', speakerVpId: 'vp-linus' });

      const readCounts = { count: 0 };
      const original = store.readMessageFile;
      store.readMessageFile = (...args) => {
        readCounts.count += 1;
        return original.call(store, ...args);
      };
      __testSetSession({
        conversationStore: store,
        config: { model: 'test-model', availableModels: [] },
        status: { skills: 0, mcpServers: [], tools: 0 },
        taskManager: { listActiveTasks: () => [] },
      });

      await handleYeaftLoadHistory({ sessionId: 'session-fast', limit: 1 });
      const chunk = sent.find(m => m.type === 'yeaft_history_chunk');
      expect(chunk.messages.map(m => m.content)).toEqual(['latest q', 'latest a']);
      expect(__testHooks.loadVisibleGroupHistoryPage({
        loadVisibleBySession: (...args) => store.loadVisibleBySession(...args),
      }, 'session-fast', 1).messages.map(m => m.content)).toEqual(['latest q', 'latest a']);
      // One bounded UI replay (limit: 1) plus one bounded runtime hydrate
      // (default recentTurnsLimit) is fine; parsing the whole 1002-row session is not.
      expect(readCounts.count).toBeLessThan(80);

      store.append({ role: 'user', content: 'progress q', sessionId: 'session-progress' });
      store.append({
        role: 'assistant', content: 'I found the request construction boundary.',
        sessionId: 'session-progress', speakerVpId: 'vp-linus', responseKind: 'progress',
      });
      store.append({
        role: 'assistant', content: 'The prior turn completed.',
        sessionId: 'session-progress', speakerVpId: 'vp-linus',
        responseKind: 'result', stopReason: 'end_turn',
      });
      expect(__testGroupHistory('session-progress')).toEqual([
        expect.objectContaining({ role: 'user', content: 'progress q' }),
        expect.objectContaining({
          role: 'assistant',
          content: 'I found the request construction boundary.',
          responseKind: 'progress',
        }),
        expect.objectContaining({
          role: 'assistant',
          content: 'The prior turn completed.',
          responseKind: 'result',
        }),
      ]);
    } finally {
      __testSetSession(null);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('metadata-only load does not emit an empty recent history chunk', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'yeaft-metadata-only-'));
    try {
      ctx.CONFIG = { yeaftDir: dir };
      const store = new ConversationStore(dir);
      store.appendBatch([
        { role: 'user', content: 'cached q', sessionId: 'session-fast' },
        { role: 'assistant', content: 'cached a', sessionId: 'session-fast', speakerVpId: 'vp-linus' },
      ]);

      const pending = handleYeaftLoadHistory({ sessionId: 'session-fast', limit: 0 });
      await flushMicrotasks();

      expect(sent.some(m => m.type === 'yeaft_history_chunk')).toBe(false);
      expect(sent.some(m => m.event?.type === 'history_loaded')).toBe(false);

      await pending;
      expect(sent.some(m => m.event?.type === 'session_ready')).toBe(false);

      resolveLoadSession({
        conversationStore: store,
        config: { model: 'test-model', availableModels: [] },
        status: { skills: 0, mcpServers: [], tools: 0 },
        taskManager: { listActiveTasks: () => [] },
      });
      await flushMicrotasks();
      await new Promise(resolve => setTimeout(resolve, 0));

      expect(sent.some(m => m.type === 'yeaft_history_chunk')).toBe(false);
      expect(sent.some(m => m.event?.type === 'history_loaded')).toBe(false);
      expect(sent.some(m => m.event?.type === 'session_ready')).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('persists inbound user rows with the coordinator receive timestamp', () => {
    const dir = mkdtempSync(join(tmpdir(), 'yeaft-inbound-ts-'));
    try {
      const store = new ConversationStore(dir);
      __testSetSession({ conversationStore: store });

      const wrote = __testHooks.persistInboundMessageOnceByMsgId({
        msgId: 'g_msg_1',
        text: 'hello at the real send time',
        sessionId: 'session-fast',
        threadId: 'main',
        role: 'user',
        ts: '2026-06-20T01:02:03.456Z',
      });

      expect(wrote).toBe(true);
      const rows = store.loadAllBySession('session-fast');
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        role: 'user',
        content: 'hello at the real send time',
        time: '2026-06-20T01:02:03.456Z',
        userAuthored: true,
      });
    } finally {
      __testSetSession(null);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('cold-start delta replay preserves timestamps, attachments, and tool summaries', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'yeaft-delta-cold-'));
    try {
      ctx.CONFIG = { yeaftDir: dir };
      const store = new ConversationStore(dir);
      const anchor = store.append({
        role: 'user',
        content: 'already seen',
        sessionId: 'session-fast',
        time: '2026-06-20T01:00:00.000Z',
      });
      store.append({
        role: 'user',
        content: 'with file',
        sessionId: 'session-fast',
        time: '2026-06-20T01:00:01.000Z',
        attachments: [{ fileId: 'file_1', name: 'note.txt', isImage: false }],
      });
      store.append({
        role: 'assistant',
        content: 'I will use a tool',
        sessionId: 'session-fast',
        threadId: 'main',
        speakerVpId: 'vp-linus',
        time: '2026-06-20T01:00:02.000Z',
        toolCalls: [{ id: 'toolu_1', name: 'Bash', input: { command: 'echo ok' } }],
      });
      store.append({
        role: 'tool',
        content: 'ok',
        sessionId: 'session-fast',
        threadId: 'main',
        toolCallId: 'toolu_1',
        time: '2026-06-20T01:00:03.000Z',
      });

      const pending = handleYeaftLoadHistory({ sessionId: 'session-fast', afterMessageId: anchor.id });
      await flushMicrotasks();

      const chunk = sent.find(m => m.type === 'yeaft_history_chunk' && m.mode === 'delta');
      expect(chunk).toMatchObject({
        type: 'yeaft_history_chunk',
        sessionId: 'session-fast',
        mode: 'delta',
        afterSeq: Number(anchor.id.slice(1)),
        messages: [
          {
            role: 'user',
            content: 'with file',
            ts: '2026-06-20T01:00:01.000Z',
            attachments: [{ fileId: 'file_1', name: 'note.txt', isImage: false }],
          },
          {
            role: 'assistant',
            content: 'I will use a tool',
            ts: '2026-06-20T01:00:02.000Z',
            speakerVpId: 'vp-linus',
            toolSummaryCount: 1,
          },
        ],
      });
      expect(chunk.messages).toHaveLength(2);
      expect(sent.filter(m => m.type === 'yeaft_output' && m.data)).toHaveLength(0);
      expect(sent.find(m => m.event?.type === 'history_loaded')?.event).toMatchObject({
        mode: 'delta',
        count: chunk.messages.length,
        sessionId: 'session-fast',
      });

      await pending;

      resolveLoadSession({
        conversationStore: store,
        config: { model: 'test-model', availableModels: [] },
        status: { skills: 0, mcpServers: [], tools: 0 },
        taskManager: { listActiveTasks: () => [] },
      });
      await flushMicrotasks();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('emits an empty delta acknowledgement when no visible rows changed after the cursor', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'yeaft-empty-delta-'));
    try {
      ctx.CONFIG = { yeaftDir: dir };
      const store = new ConversationStore(dir);
      const anchor = store.append({
        role: 'user',
        content: 'already seen',
        sessionId: 'session-fast',
        time: '2026-06-20T01:00:00.000Z',
      });
      const hidden = store.append({
        role: 'user',
        content: '[system note] You have called ListAgents with the same arguments 3 times. Previous result: {...}',
        sessionId: 'session-fast',
        time: '2026-06-20T01:00:01.000Z',
      });

      const pending = handleYeaftLoadHistory({ sessionId: 'session-fast', afterSeq: Number(anchor.id.slice(1)) });
      await flushMicrotasks();

      expect(sent.find(m => m.type === 'yeaft_history_chunk' && m.mode === 'delta')).toMatchObject({
        sessionId: 'session-fast',
        messages: [],
        latestSeq: Number(hidden.id.slice(1)),
        afterSeq: Number(anchor.id.slice(1)),
      });
      const event = sent.find(m => m.event?.type === 'history_loaded')?.event;
      expect(event).toMatchObject({
        mode: 'delta',
        count: 0,
        sessionId: 'session-fast',
        latestSeq: Number(hidden.id.slice(1)),
        afterSeq: Number(anchor.id.slice(1)),
      });
      expect(event.latestSeq).toBeGreaterThan(event.afterSeq);

      await pending;

      resolveLoadSession({
        conversationStore: store,
        config: { model: 'test-model', availableModels: [] },
        status: { skills: 0, mcpServers: [], tools: 0 },
        taskManager: { listActiveTasks: () => [] },
      });
      await flushMicrotasks();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('ready-session recent replay emits history before metadata snapshots', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'yeaft-ready-recent-first-'));
    try {
      const store = new ConversationStore(dir);
      store.append({
        role: 'user',
        content: 'ready recent user',
        sessionId: 'session-fast',
        time: '2026-06-20T03:00:00.000Z',
      });
      store.append({
        role: 'assistant',
        content: 'ready recent assistant',
        sessionId: 'session-fast',
        speakerVpId: 'vp-linus',
        time: '2026-06-20T03:00:01.000Z',
      });
      __testSetSession({
        conversationStore: store,
        config: { model: 'test-model', availableModels: [] },
        status: { skills: 0, mcpServers: [], tools: 0 },
        taskManager: { listActiveTasks: () => [] },
      });

      await handleYeaftLoadHistory({ sessionId: 'session-fast', limit: 1 });

      const firstHistoryIndex = sent.findIndex(m => m.type === 'yeaft_history_chunk' && m.mode === 'recent');
      let sessionReadyIndex = sent.findIndex(m => m.event?.type === 'session_ready');
      expect(firstHistoryIndex).toBeGreaterThanOrEqual(0);
      expect(sessionReadyIndex).toBe(-1);
      await new Promise(resolve => setTimeout(resolve, 0));
      sessionReadyIndex = sent.findIndex(m => m.event?.type === 'session_ready');
      expect(sessionReadyIndex).toBeGreaterThan(firstHistoryIndex);
      expect(sent[sessionReadyIndex]).toMatchObject({
        type: 'yeaft_output',
        sessionId: 'session-fast',
        event: { type: 'session_ready' },
      });
      expect(sent[firstHistoryIndex].messages.map(m => m.content)).toEqual([
        'ready recent user',
        'ready recent assistant',
      ]);
    } finally {
      __testSetSession(null);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('ready-session delta replay uses the same projected frame shape', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'yeaft-delta-ready-'));
    try {
      const store = new ConversationStore(dir);
      const anchor = store.append({
        role: 'user',
        content: 'already seen',
        sessionId: 'session-fast',
        time: '2026-06-20T02:00:00.000Z',
      });
      store.append({
        role: 'user',
        content: 'ready delta user',
        sessionId: 'session-fast',
        time: '2026-06-20T02:00:01.000Z',
        attachments: [{ fileId: 'file_2', name: 'diagram.png', isImage: true }],
      });
      store.append({
        role: 'assistant',
        content: 'ready delta assistant',
        sessionId: 'session-fast',
        speakerVpId: 'vp-martin',
        time: '2026-06-20T02:00:02.000Z',
        toolCalls: [{ id: 'toolu_2', name: 'WebSearch', input: { query: 'yeaft' } }],
      });
      store.append({
        role: 'tool',
        content: 'result',
        sessionId: 'session-fast',
        toolCallId: 'toolu_2',
        time: '2026-06-20T02:00:03.000Z',
      });
      __testSetSession({
        conversationStore: store,
        config: { model: 'test-model', availableModels: [] },
        status: { skills: 0, mcpServers: [], tools: 0 },
        taskManager: { listActiveTasks: () => [] },
      });

      await handleYeaftLoadHistory({ sessionId: 'session-fast', afterSeq: Number(anchor.id.slice(1)) });

      const chunk = sent.find(m => m.type === 'yeaft_history_chunk' && m.mode === 'delta');
      expect(chunk).toMatchObject({
        type: 'yeaft_history_chunk',
        sessionId: 'session-fast',
        mode: 'delta',
        afterSeq: Number(anchor.id.slice(1)),
        messages: [
          {
            role: 'user',
            content: 'ready delta user',
            ts: '2026-06-20T02:00:01.000Z',
            attachments: [{ fileId: 'file_2', name: 'diagram.png', isImage: true }],
          },
          {
            role: 'assistant',
            content: 'ready delta assistant',
            ts: '2026-06-20T02:00:02.000Z',
            speakerVpId: 'vp-martin',
            toolSummaryCount: 1,
          },
        ],
      });
      expect(chunk.messages).toHaveLength(2);
      expect(sent.filter(m => m.type === 'yeaft_output' && m.data)).toHaveLength(0);
      expect(sent.find(m => m.event?.type === 'history_loaded')?.event).toMatchObject({
        mode: 'delta',
        count: chunk.messages.length,
        sessionId: 'session-fast',
      });

      vi.useFakeTimers();
      const metadataDir = mkdtempSync(join(tmpdir(), 'yeaft-roster-metadata-'));
      try {
        ctx.CONFIG = { yeaftDir: metadataDir };
        vi.setSystemTime(new Date('2026-07-29T10:00:00.000Z'));
        createSession(join(metadataDir, 'sessions'), {
          id: 'session-roster',
          name: 'Roster',
          roster: ['omni'],
          defaultVpId: 'omni',
        }).close();

        const cases = [
          [new Date('2026-07-29T11:00:00.000Z'), handleYeaftSessionAddMember, 'add_member', 'reviewer'],
          [new Date('2026-07-29T12:00:00.000Z'), handleYeaftSessionSetDefaultVp, 'set_default_vp', 'reviewer'],
          [new Date('2026-07-29T13:00:00.000Z'), handleYeaftSessionRemoveMember, 'remove_member', 'reviewer'],
        ];
        for (const [at, handler, op, vpId] of cases) {
          vi.setSystemTime(at);
          sent.length = 0;
          handler({ sessionId: 'session-roster', vpId, requestId: `request-${op}` });
          expect(sent).toContainEqual(expect.objectContaining({
            type: 'yeaft_output',
            event: expect.objectContaining({
              type: 'session_roster_changed',
              sessionId: 'session-roster',
              metadataUpdatedAt: at.toISOString(),
            }),
          }));
        }
      } finally {
        vi.useRealTimers();
        rmSync(metadataDir, { recursive: true, force: true });
      }
    } finally {
      __testSetSession(null);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
