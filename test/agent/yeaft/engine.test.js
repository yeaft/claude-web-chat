import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, rmSync, mkdtempSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { ActiveMemorySet } from '../../../agent/yeaft/memory/ams.js';
import { filterMemoryPromptTextForPrompt } from '../../../agent/yeaft/memory/prompt-cleanup.js';
import { Engine, buildResidentEntries, selectResidentTopicScopes } from '../../../agent/yeaft/engine.js';
import { ConversationStore } from '../../../agent/yeaft/conversation/persist.js';
import { AmsRegistry } from '../../../agent/yeaft/memory/ams-registry.js';
import { writeSummary } from '../../../agent/yeaft/memory/store.js';
import { NullTrace, DebugTrace } from '../../../agent/yeaft/debug-trace.js';
import { buildMcpFlattenedTools } from '../../../agent/yeaft/tools/mcp-tools.js';
import { ToolRegistry } from '../../../agent/yeaft/tools/registry.js';
import { defineTool } from '../../../agent/yeaft/tools/types.js';
import { buildSystemPrompt } from '../../../agent/yeaft/prompts.js';
import todoWriteTool from '../../../agent/yeaft/tools/todo-write.js';
import startPlanTool from '../../../agent/yeaft/tools/start-plan.js';

// ─── Mock Adapter ─────────────────────────────────────────────

/**
 * MockAdapter — emits pre-configured events for testing.
 * Each call to stream() pops the next response from the queue.
 */
class MockAdapter {
  constructor() {
    this.responses = []; // Array of arrays of StreamEvent
    this.callLog = [];   // Records what was passed to stream()
  }

  /** Push a pre-configured response (array of StreamEvent). */
  pushResponse(events) {
    this.responses.push(events);
  }

  async *stream(params) {
    this.callLog.push(params);
    const events = this.responses.shift();
    if (!events) {
      throw new Error('MockAdapter: no more responses queued');
    }
    for (const event of events) {
      yield event;
    }
  }

  async call(params) {
    this.callLog.push(params);
    return { text: 'mock call response', usage: { inputTokens: 10, outputTokens: 5 } };
  }
}

// ─── Test Setup ───────────────────────────────────────────────

const TEST_DB = join(tmpdir(), `yeaft-test-engine-${Date.now()}.db`);
let trace;
let mockAdapter;

beforeEach(() => {
  trace = new NullTrace();
  mockAdapter = new MockAdapter();
});

afterEach(() => {
  // Clean up any DB files
  for (const suffix of ['', '-wal', '-shm']) {
    const path = TEST_DB + suffix;
    if (existsSync(path)) rmSync(path);
  }
});

// ─── Tests ────────────────────────────────────────────────────

describe('Engine memory prompt hygiene', () => {
  it('strips dream-state metadata from resident summaries before prompt injection', () => {
    const entries = buildResidentEntries({
      sessionId: 's1',
      ownVpId: 'linus',
      summaries: {
        session: 'Useful session fact.\n\n<!-- dream-state -->\nlastDreamAt: 2026-07-17T00:00:00.000Z\n<!-- /dream-state -->',
        topics: [{
          scope: 'sessions/s1/topic/dream/recall',
          summary: 'Topic detail stays.\n<!-- dream-state -->\nlastDreamAt: old\n<!-- /dream-state -->',
        }],
      },
    });

    expect(entries).toEqual([
      { scope: 'sessions/s1', summary: 'Useful session fact.' },
      { scope: 'sessions/s1/topic/dream/recall', summary: 'Topic detail stays.' },
    ]);
  });

  it('deduplicates repeated memory text across resident, recent, and onDemand layers', () => {
    const ams = new ActiveMemorySet({
      budget: { total: 1000, resident: 400, recent: 300, onDemand: 300 },
    });
    const repeated = 'Dream topic recall should load topic memory through AMS without repeating the same storage path details in every injected line.';
    ams.setResident([{ scope: 'sessions/s1', summary: repeated }]);
    ams.touchRecent({ id: 'recent-1', scope: 'sessions/s1/topic/dream', body: repeated, kind: 'context', tags: [], sourceMessages: [] });
    ams.setOnDemand([
      { id: 'od-1', scope: 'sessions/s1/topic/dream', body: repeated, kind: 'context', tags: [], sourceMessages: [] },
      { id: 'od-2', scope: 'sessions/s1/topic/dream', body: 'A distinct implementation detail remains available.', kind: 'context', tags: [], sourceMessages: [] },
    ]);

    const snap = ams.snapshot();

    expect(snap.resident.map(entry => entry.summary)).toEqual([repeated]);
    expect(snap.recent).toEqual([]);
    expect(snap.onDemand.map(seg => seg.body)).toEqual(['A distinct implementation detail remains available.']);
  });

  it('does not let over-budget resident candidates suppress onDemand memory', () => {
    const ams = new ActiveMemorySet({
      budget: { total: 100, resident: 1, recent: 1, onDemand: 80 },
    });
    const repeated = 'Budget-sensitive Dream memory detail should remain available from onDemand when the resident copy is too large for the resident budget.';
    ams.setResident([{ scope: 'sessions/s1', summary: repeated }]);
    ams.setOnDemand([
      { id: 'od-1', scope: 'sessions/s1/topic/dream', body: repeated, kind: 'context', tags: [], sourceMessages: [] },
    ]);

    const snap = ams.snapshot();

    expect(snap.resident).toEqual([]);
    expect(snap.onDemand.map(seg => seg.body)).toEqual([repeated]);
  });

  it('keeps detailed onDemand memory when resident summary is only a prefix', () => {
    const ams = new ActiveMemorySet({
      budget: { total: 1000, resident: 300, recent: 100, onDemand: 600 },
    });
    const summary = 'Dream recall should include topic memory generated by Dream and avoid noisy repeated scope path labels in prompts.';
    const detail = `${summary} Critical extra detail: FTS fallback must use topic-prioritized round-robin so user/session oversized segments cannot starve topic memory.`;
    ams.setResident([{ scope: 'sessions/s1', summary }]);
    ams.setOnDemand([
      { id: 'od-detail', scope: 'sessions/s1/topic/dream', body: detail, kind: 'context', tags: [], sourceMessages: [] },
    ]);

    const snap = ams.snapshot();

    expect(snap.resident.map(entry => entry.summary)).toEqual([summary]);
    expect(snap.onDemand.map(seg => seg.body)).toEqual([detail]);
  });

  it('drops unrelated transient work-item state from the prompt snapshot', () => {
    const ams = new ActiveMemorySet({
      budget: { total: 1000, resident: 500, recent: 200, onDemand: 300 },
    });
    ams.setResident([
      {
        scope: 'sessions/s1',
        summary: [
          'Reusable Dream memory rule: topic recall must stay precise.',
          '',
          'Current Work Item #884: build billing dashboard export. Next step: merge PR #884.',
        ].join('\n'),
      },
    ]);
    ams.setOnDemand([
      {
        id: 'billing-work-item',
        scope: 'sessions/s1/topic/billing',
        body: 'Work Item #884: billing dashboard export is in progress and awaiting review.',
        kind: 'context',
        tags: [],
        sourceMessages: [],
      },
      {
        id: 'dream-rule',
        scope: 'sessions/s1/topic/dream',
        body: 'Dream memory relevance should keep stable topic recall facts available.',
        kind: 'context',
        tags: [],
        sourceMessages: [],
      },
    ]);

    const snap = ams.snapshot({ userMsg: '优化 Dream memory relevance，减少无关状态' });

    expect(snap.resident.map(entry => entry.summary)).toEqual([
      'Reusable Dream memory rule: topic recall must stay precise.',
    ]);
    expect(snap.onDemand.map(seg => seg.body)).toEqual([
      'Dream memory relevance should keep stable topic recall facts available.',
    ]);
  });

  it('keeps transient work-item state when the user asks about the same task', () => {
    const ams = new ActiveMemorySet({
      budget: { total: 1000, resident: 500, recent: 200, onDemand: 300 },
    });
    ams.setOnDemand([
      {
        id: 'billing-work-item',
        scope: 'sessions/s1/topic/billing',
        body: 'Work Item #884: billing dashboard export is in progress and awaiting review.',
        kind: 'context',
        tags: [],
        sourceMessages: [],
      },
    ]);

    const snap = ams.snapshot({ userMsg: '继续 billing dashboard export 的 work item' });

    expect(snap.onDemand.map(seg => seg.body)).toEqual([
      'Work Item #884: billing dashboard export is in progress and awaiting review.',
    ]);
  });

  it('keeps stable markdown bullets when a sibling transient bullet is unrelated', () => {
    const filtered = filterMemoryPromptTextForPrompt(
      [
        '- Stable preference: user wants Dream memory topic labels compact.',
        '- Current Work Item #884: build billing dashboard export. Next step: merge PR #884.',
      ].join('\n'),
      '优化 Dream memory relevance，减少无关状态',
    );

    expect(filtered).toBe('- Stable preference: user wants Dream memory topic labels compact.');
  });

  it('keeps related transient markdown bullets alongside stable bullets', () => {
    const filtered = filterMemoryPromptTextForPrompt(
      [
        '- Stable preference: user wants Dream memory topic labels compact.',
        '- Current Work Item #884: build billing dashboard export. Next step: merge PR #884.',
      ].join('\n'),
      '继续 billing dashboard export 的 work item',
    );

    expect(filtered).toBe([
      '- Stable preference: user wants Dream memory topic labels compact.',
      '- Current Work Item #884: build billing dashboard export. Next step: merge PR #884.',
    ].join('\n'));
  });

  it('loads resident topic summaries only for topics recalled or named this turn', () => {
    expect(selectResidentTopicScopes([
      'sessions/s1/topic/dream/relevance',
      'sessions/s1/topic/dream/recall',
      'sessions/s1/topic/billing/export',
    ], [
      { scope: 'sessions/s1/topic/dream/relevance', body: 'Relevant Dream memory.' },
      { scope: 'sessions/s1', body: 'Session memory.' },
    ], 'please inspect dream recall')).toEqual([
      'sessions/s1/topic/dream/relevance',
      'sessions/s1/topic/dream/recall',
    ]);
  });
});

describe('Engine', () => {
  describe('constructor', () => {
    it('should create an engine with trace ID', () => {
      const engine = new Engine({
        adapter: mockAdapter,
        trace,
        config: { model: 'test-model', maxOutputTokens: 1024 },
      });
      expect(engine.traceId).toBeTruthy();
      expect(typeof engine.traceId).toBe('string');
    });

    it('refreshes the fast-model config without rebuilding the engine', () => {
      const engine = new Engine({
        adapter: mockAdapter,
        trace,
        config: { model: 'old-primary', fastModelId: 'old-fast', maxOutputTokens: 1024 },
      });

      engine.refreshConfig({ model: 'new-primary', fastModelId: 'new-fast', maxOutputTokens: 2048 });

      expect(engine.fastConfig).toMatchObject({ model: 'new-fast', maxOutputTokens: 2048 });
    });
  });

  describe('perf trace', () => {
    it('records LLM request lifecycle events when an inbound perf trace id is present', async () => {
      const yeaftDir = mkdtempSync(join(tmpdir(), 'yeaft-engine-perf-'));
      try {
        mockAdapter.pushResponse([
          { type: 'text_delta', text: 'ok' },
          { type: 'stop', stopReason: 'end_turn' },
        ]);
        const engine = new Engine({
          adapter: mockAdapter,
          trace,
          config: { model: 'test-model', maxOutputTokens: 1024, yeaftDir },
          yeaftDir,
          sessionId: 'sess-1',
          vpId: 'vp-1',
        });

        for await (const _event of engine.query({
          prompt: 'hello',
          inboundEnvelope: { _perfTraceId: 'pt-engine-1' },
          sessionId: 'sess-1',
          threadId: 'thr-1',
          vpTurnId: 'turn-1',
        })) {
          // consume
        }

        const day = new Date().toISOString().slice(0, 10);
        const rows = readFileSync(join(yeaftDir, 'perf-traces', `${day}.jsonl`), 'utf8')
          .trim()
          .split('\n')
          .map(line => JSON.parse(line));
        expect(rows.map(row => row.phase)).toEqual(expect.arrayContaining([
          'llm.request_start',
          'llm.first_event',
          'llm.request_complete',
        ]));
        expect(rows.every(row => row.traceId === 'pt-engine-1')).toBe(true);
      } finally {
        rmSync(yeaftDir, { recursive: true, force: true });
      }
    });
  });

  describe('tool registration', () => {
    it('should register and list tools', () => {
      const engine = new Engine({
        adapter: mockAdapter,
        trace,
        config: { model: 'test-model' },
      });

      engine.registerTool({
        name: 'search',
        description: 'Search the web',
        parameters: { type: 'object', properties: { q: { type: 'string' } } },
        execute: async (input) => `Results for: ${input.q}`,
      });

      expect(engine.toolNames).toEqual(['search']);
    });

    it('should unregister tools', () => {
      const engine = new Engine({
        adapter: mockAdapter,
        trace,
        config: { model: 'test-model' },
      });

      engine.registerTool({
        name: 'search',
        description: 'Search',
        parameters: {},
        execute: async () => 'ok',
      });

      engine.unregisterTool('search');
      expect(engine.toolNames).toEqual([]);
    });
  });

  describe('input validation', () => {
    it('should yield error for empty prompt', async () => {
      const engine = new Engine({
        adapter: mockAdapter,
        trace,
        config: { model: 'test-model', maxOutputTokens: 1024 },
      });

      const events = [];
      for await (const event of engine.query({ prompt: '' })) {
        events.push(event);
      }

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('error');
      expect(events[0].error.message).toContain('prompt is required');
      // Should NOT have called adapter
      expect(mockAdapter.callLog).toHaveLength(0);
    });

    it('should yield error for null prompt', async () => {
      const engine = new Engine({
        adapter: mockAdapter,
        trace,
        config: { model: 'test-model', maxOutputTokens: 1024 },
      });

      const events = [];
      for await (const event of engine.query({ prompt: null })) {
        events.push(event);
      }

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('error');
    });

    it('should yield error for whitespace-only prompt', async () => {
      const engine = new Engine({
        adapter: mockAdapter,
        trace,
        config: { model: 'test-model', maxOutputTokens: 1024 },
      });

      const events = [];
      for await (const event of engine.query({ prompt: '   ' })) {
        events.push(event);
      }

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('error');
    });
  });

  describe('simple query (no tools)', () => {
    it('should yield text events and complete', async () => {
      mockAdapter.pushResponse([
        { type: 'text_delta', text: 'Hello' },
        { type: 'text_delta', text: ' world' },
        { type: 'usage', inputTokens: 50, outputTokens: 10 },
        { type: 'stop', stopReason: 'end_turn' },
      ]);

      const engine = new Engine({
        adapter: mockAdapter,
        trace,
        config: { model: 'test-model', maxOutputTokens: 1024 },
      });

      const events = [];
      for await (const event of engine.query({ prompt: 'hello' })) {
        events.push(event);
      }

      // Should have: turn_start, text_delta, text_delta, usage, stop, turn_end
      const types = events.map(e => e.type);
      expect(types).toContain('turn_start');
      expect(types).toContain('text_delta');
      expect(types).toContain('usage');
      expect(types).toContain('stop');
      expect(types).toContain('turn_end');

      // Check text content
      const textEvents = events.filter(e => e.type === 'text_delta');
      expect(textEvents).toHaveLength(2);
      expect(textEvents[0].text).toBe('Hello');
      expect(textEvents[1].text).toBe(' world');

      // Check turn_end
      const turnEnd = events.find(e => e.type === 'turn_end');
      expect(turnEnd.stopReason).toBe('end_turn');
      expect(turnEnd.turnNumber).toBe(1);

      const continuityAdapter = new MockAdapter();
      continuityAdapter.pushResponse([
        { type: 'text_delta', text: 'Current answer' },
        { type: 'stop', stopReason: 'end_turn' },
      ]);
      const continuityEngine = new Engine({
        adapter: continuityAdapter,
        trace,
        config: { model: 'test-model', maxOutputTokens: 1024 },
      });
      for await (const _event of continuityEngine.query({
        prompt: 'Continue',
        messages: [
          { role: 'user', content: 'Original question' },
          { role: 'assistant', content: 'I found the relevant state boundary.', responseKind: 'progress' },
          { role: 'assistant', content: 'The previous turn completed.', responseKind: 'result' },
        ],
      })) {
        // consume
      }
      expect(continuityAdapter.callLog[0].messages).toEqual([
        { role: 'user', content: 'Original question' },
        { role: 'assistant', content: 'I found the relevant state boundary.', responseKind: 'progress' },
        { role: 'assistant', content: 'The previous turn completed.', responseKind: 'result' },
        { role: 'user', content: 'Continue' },
      ]);
    });

    it('persists the user row before starting the LLM request', async () => {
      const yeaftDir = mkdtempSync(join(tmpdir(), 'yeaft-engine-user-prewrite-'));
      try {
        const conversationStore = new ConversationStore(yeaftDir);
        const adapter = {
          async *stream() {
            const persisted = conversationStore.loadRecentBySession('session-prewrite', 10);
            expect(persisted).toHaveLength(1);
            expect(persisted[0]).toMatchObject({
              role: 'user',
              content: 'persist before request',
              sessionId: 'session-prewrite',
              threadId: 'main',
              userAuthored: true,
            });
            throw new Error('provider failed before replying');
          },
        };
        const engine = new Engine({
          adapter,
          trace,
          config: { model: 'test-model', maxOutputTokens: 1024 },
          conversationStore,
          yeaftDir,
        });

        const events = [];
        for await (const event of engine.query({
          prompt: 'persist before request',
          sessionId: 'session-prewrite',
        })) events.push(event);

        expect(events.find(event => event.type === 'error')).toBeTruthy();
        expect(conversationStore.loadRecentBySession('session-prewrite', 10)).toHaveLength(1);
      } finally {
        rmSync(yeaftDir, { recursive: true, force: true });
      }
    });

    it('persists partial assistant text when the provider fails mid-stream', async () => {
      const yeaftDir = mkdtempSync(join(tmpdir(), 'yeaft-engine-partial-persist-'));
      try {
        const conversationStore = new ConversationStore(yeaftDir);
        const adapter = {
          async *stream() {
            yield { type: 'text_delta', text: 'partial reply' };
            throw new Error('stream disconnected');
          },
        };
        const engine = new Engine({
          adapter,
          trace,
          config: { model: 'test-model', maxOutputTokens: 1024 },
          conversationStore,
          yeaftDir,
          vpId: 'vp-linus',
        });

        for await (const _event of engine.query({
          prompt: 'hello',
          sessionId: 'session-partial',
          vpTurnId: 'vp-turn-partial',
        })) {
          // consume
        }

        expect(conversationStore.loadRecentBySession('session-partial', 10)).toEqual([
          expect.objectContaining({ role: 'user', content: 'hello' }),
          expect.objectContaining({
            role: 'assistant',
            content: 'partial reply',
            turnId: 'vp-turn-partial',
            speakerVpId: 'vp-linus',
            incomplete: true,
            stopReason: 'error',
            responseKind: 'progress',
          }),
        ]);
      } finally {
        rmSync(yeaftDir, { recursive: true, force: true });
      }
    });

    it('persists partial assistant text when the user aborts mid-stream', async () => {
      const yeaftDir = mkdtempSync(join(tmpdir(), 'yeaft-engine-partial-abort-'));
      try {
        const conversationStore = new ConversationStore(yeaftDir);
        const controller = new AbortController();
        const adapter = {
          async *stream() {
            yield { type: 'text_delta', text: 'partial before stop' };
            controller.abort('user');
          },
        };
        const engine = new Engine({
          adapter,
          trace,
          config: { model: 'test-model', maxOutputTokens: 1024 },
          conversationStore,
          yeaftDir,
          vpId: 'vp-linus',
        });

        const events = [];
        for await (const event of engine.query({
          prompt: 'stop this',
          signal: controller.signal,
          sessionId: 'session-partial-abort',
          vpTurnId: 'vp-turn-abort',
        })) events.push(event);

        expect(events.filter(event => event.type === 'aborted')).toHaveLength(1);
        expect(conversationStore.loadRecentBySession('session-partial-abort', 10)).toEqual([
          expect.objectContaining({ role: 'user', content: 'stop this' }),
          expect.objectContaining({
            role: 'assistant',
            content: 'partial before stop',
            turnId: 'vp-turn-abort',
            speakerVpId: 'vp-linus',
            incomplete: true,
            stopReason: 'aborted',
            responseKind: 'progress',
          }),
        ]);
      } finally {
        rmSync(yeaftDir, { recursive: true, force: true });
      }
    });

    it('persists completed assistant and tool records before a later LLM loop fails', async () => {
      const yeaftDir = mkdtempSync(join(tmpdir(), 'yeaft-engine-tool-incremental-'));
      try {
        const conversationStore = new ConversationStore(yeaftDir);
        mockAdapter.pushResponse([
          { type: 'tool_call', id: 'call_incremental', name: 'durable_tool', input: {} },
          { type: 'stop', stopReason: 'tool_use' },
        ]);
        mockAdapter.pushResponse([
          { type: 'error', error: new Error('second request failed'), retryable: false },
        ]);
        const rawToolOutput = 'tool output that must survive';
        const engine = new Engine({
          adapter: mockAdapter,
          trace,
          config: { model: 'test-model', maxOutputTokens: 1024 },
          conversationStore,
          yeaftDir,
          vpId: 'vp-linus',
        });
        engine.registerTool({
          name: 'durable_tool',
          description: 'returns durable output',
          parameters: { type: 'object', properties: {} },
          execute: async () => rawToolOutput,
        });

        for await (const _event of engine.query({
          prompt: 'use the tool',
          sessionId: 'session-tool-incremental',
          vpTurnId: 'vp-turn-tool',
        })) {
          // consume
        }

        const persisted = conversationStore.loadRecentBySession('session-tool-incremental', 10);
        expect(persisted.map(message => message.role)).toEqual(['user', 'assistant', 'tool']);
        expect(persisted[1]).toMatchObject({
          toolCalls: [expect.objectContaining({ id: 'call_incremental', name: 'durable_tool' })],
          turnId: 'vp-turn-tool',
          responseKind: 'progress',
        });
        expect(persisted[2]).toMatchObject({
          toolCallId: 'call_incremental',
          content: rawToolOutput,
          turnId: 'vp-turn-tool',
          speakerVpId: 'vp-linus',
        });

        const emptyFinalAdapter = new MockAdapter();
        emptyFinalAdapter.pushResponse([
          { type: 'text_delta', text: 'Completed via tool.' },
          { type: 'tool_call', id: 'call_empty_final', name: 'durable_tool', input: {} },
          { type: 'stop', stopReason: 'tool_use' },
        ]);
        emptyFinalAdapter.pushResponse([
          { type: 'stop', stopReason: 'end_turn' },
        ]);
        const emptyFinalEngine = new Engine({
          adapter: emptyFinalAdapter,
          trace,
          config: { model: 'test-model', maxOutputTokens: 1024 },
          conversationStore,
          yeaftDir,
          vpId: 'vp-linus',
        });
        emptyFinalEngine.registerTool({
          name: 'durable_tool',
          description: 'returns durable output',
          parameters: { type: 'object', properties: {} },
          execute: async () => rawToolOutput,
        });

        for await (const _event of emptyFinalEngine.query({
          prompt: 'use the tool, then finish silently',
          sessionId: 'session-tool-empty-final',
          vpTurnId: 'vp-turn-empty-final',
        })) {
          // consume
        }

        const emptyFinalRows = conversationStore.loadRecentBySession('session-tool-empty-final', 10);
        expect(emptyFinalRows.find(message => message.content === 'Completed via tool.')).toMatchObject({
          responseKind: 'result',
          stopReason: 'end_turn',
          turnId: 'vp-turn-empty-final',
        });
      } finally {
        rmSync(yeaftDir, { recursive: true, force: true });
      }
    });

    it('persists a T1 folding reflection and hides the original tool arc after restart', async () => {
      const yeaftDir = mkdtempSync(join(tmpdir(), 'yeaft-engine-t1-fold-persist-'));
      try {
        const conversationStore = new ConversationStore(yeaftDir);
        const adapter = new MockAdapter();
        adapter.call = async () => ({
          text: 'durable reflection summary',
          usage: { inputTokens: 10, outputTokens: 5 },
        });
        adapter.pushResponse([
          ...Array.from({ length: 30 }, (_, index) => ({
            type: 'tool_call',
            id: `call_fold_${index}`,
            name: 'fold_tool',
            input: { index },
          })),
          { type: 'stop', stopReason: 'tool_use' },
        ]);
        adapter.pushResponse([
          { type: 'text_delta', text: 'finished after fold' },
          { type: 'stop', stopReason: 'end_turn' },
        ]);
        const engine = new Engine({
          adapter,
          trace,
          config: { model: 'test-model', maxOutputTokens: 1024, maxContextTokens: 1000 },
          conversationStore,
          yeaftDir,
        });
        engine.registerTool({
          name: 'fold_tool',
          description: 'returns one result',
          parameters: { type: 'object', properties: { index: { type: 'number' } } },
          execute: async ({ index }) => `result ${index}`,
        });

        for await (const _event of engine.query({
          prompt: 'run thirty tools',
          sessionId: 'session-t1-fold',
        })) {
          // consume
        }

        const restarted = new ConversationStore(yeaftDir);
        const durable = restarted.loadRecentBySession(
          'session-t1-fold',
          Infinity,
          { includeReflections: true },
        );
        expect(durable.filter(message => message._reflection)).toEqual([
          expect.objectContaining({ content: expect.stringContaining('durable reflection summary') }),
        ]);
        expect(durable.some(message => message.role === 'tool')).toBe(false);
        expect(durable.some(message => Array.isArray(message.toolCalls) && message.toolCalls.length > 0)).toBe(false);
        expect(durable.at(-1)).toMatchObject({ role: 'assistant', content: 'finished after fold' });
      } finally {
        rmSync(yeaftDir, { recursive: true, force: true });
      }
    });

    it('persists a T2 carry-forward reflection and hides the original tool arc after restart', async () => {
      const yeaftDir = mkdtempSync(join(tmpdir(), 'yeaft-engine-t2-fold-persist-'));
      try {
        const conversationStore = new ConversationStore(yeaftDir);
        const adapter = new MockAdapter();
        adapter.call = async () => ({
          text: 'durable t2 reflection summary',
          usage: { inputTokens: 10, outputTokens: 5 },
        });
        adapter.pushResponse([
          ...Array.from({ length: 9 }, (_, index) => ({
            type: 'tool_call',
            id: `call_t2_fold_${index}`,
            name: 't2_fold_tool',
            input: { index },
          })),
          { type: 'stop', stopReason: 'tool_use' },
        ]);
        adapter.pushResponse([
          { type: 'text_delta', text: 'first turn finished' },
          { type: 'stop', stopReason: 'end_turn' },
        ]);
        adapter.pushResponse([
          { type: 'text_delta', text: 'second turn finished' },
          { type: 'stop', stopReason: 'end_turn' },
        ]);
        const engine = new Engine({
          adapter,
          trace,
          config: { model: 'test-model', maxOutputTokens: 1024, maxContextTokens: 1000 },
          conversationStore,
          yeaftDir,
        });
        engine.registerTool({
          name: 't2_fold_tool',
          description: 'returns one result',
          parameters: { type: 'object', properties: { index: { type: 'number' } } },
          execute: async ({ index }) => `result ${index}`,
        });

        for await (const _event of engine.query({
          prompt: 'run nine tools',
          sessionId: 'session-t2-fold',
        })) {
          // consume
        }
        await Promise.resolve();
        const firstTurn = conversationStore.loadRecentBySession('session-t2-fold', Infinity);
        for await (const _event of engine.query({
          prompt: 'continue after t2',
          messages: firstTurn,
          sessionId: 'session-t2-fold',
        })) {
          // consume
        }

        const restarted = new ConversationStore(yeaftDir);
        const durable = restarted.loadRecentBySession(
          'session-t2-fold',
          Infinity,
          { includeReflections: true },
        );
        expect(durable.filter(message => message._reflection)).toEqual([
          expect.objectContaining({ content: expect.stringContaining('durable t2 reflection summary') }),
        ]);
        expect(durable.some(message => message.role === 'tool')).toBe(false);
        expect(durable.some(message => Array.isArray(message.toolCalls) && message.toolCalls.length > 0)).toBe(false);
        expect(durable.at(-1)).toMatchObject({ role: 'assistant', content: 'second turn finished' });
      } finally {
        rmSync(yeaftDir, { recursive: true, force: true });
      }
    });

    it('persists a normal turn once without end-of-turn duplicates', async () => {
      const yeaftDir = mkdtempSync(join(tmpdir(), 'yeaft-engine-no-persist-duplicates-'));
      try {
        const conversationStore = new ConversationStore(yeaftDir);
        mockAdapter.pushResponse([
          { type: 'text_delta', text: 'one reply' },
          { type: 'stop', stopReason: 'end_turn' },
        ]);
        const engine = new Engine({
          adapter: mockAdapter,
          trace,
          config: { model: 'test-model', maxOutputTokens: 1024 },
          conversationStore,
          yeaftDir,
        });

        for await (const _event of engine.query({
          prompt: 'one prompt',
          sessionId: 'session-no-duplicates',
        })) {
          // consume
        }

        expect(conversationStore.loadRecentBySession('session-no-duplicates', 10).map(message => ({
          role: message.role,
          content: message.content,
        }))).toEqual([
          { role: 'user', content: 'one prompt' },
          { role: 'assistant', content: 'one reply' },
        ]);
      } finally {
        rmSync(yeaftDir, { recursive: true, force: true });
      }
    });

    it('persists the max-token continuation boundary before the next request fails', async () => {
      const yeaftDir = mkdtempSync(join(tmpdir(), 'yeaft-engine-continue-persist-'));
      try {
        const conversationStore = new ConversationStore(yeaftDir);
        mockAdapter.pushResponse([
          { type: 'text_delta', text: 'first part' },
          { type: 'stop', stopReason: 'max_tokens' },
        ]);
        mockAdapter.pushResponse([
          { type: 'error', error: new Error('continuation request failed'), retryable: false },
        ]);
        const engine = new Engine({
          adapter: mockAdapter,
          trace,
          config: { model: 'test-model', maxOutputTokens: 1024 },
          conversationStore,
          yeaftDir,
        });

        for await (const _event of engine.query({
          prompt: 'write a long answer',
          sessionId: 'session-continue-persist',
        })) {
          // consume
        }

        expect(conversationStore.loadRecentBySession('session-continue-persist', 10).map(message => ({
          role: message.role,
          content: message.content,
          userAuthored: message.userAuthored,
        }))).toEqual([
          { role: 'user', content: 'write a long answer', userAuthored: true },
          { role: 'assistant', content: 'first part', userAuthored: undefined },
          { role: 'user', content: 'Continue', userAuthored: false },
        ]);
        expect(conversationStore.loadVisibleBySession('session-continue-persist', null, 10).messages).toEqual([
          expect.objectContaining({ role: 'user', content: 'write a long answer', userAuthored: true }),
          expect.objectContaining({ role: 'assistant', content: 'first part' }),
        ]);
      } finally {
        rmSync(yeaftDir, { recursive: true, force: true });
      }
    });

    it('persists assistant rows with the caller-provided VP turn id', async () => {
      const yeaftDir = mkdtempSync(join(tmpdir(), 'yeaft-engine-vp-turn-id-'));
      try {
        const conversationStore = new ConversationStore(join(yeaftDir, 'conversation'));
        mockAdapter.pushResponse([
          { type: 'text_delta', text: 'persisted reply' },
          { type: 'usage', inputTokens: 8, outputTokens: 3 },
          { type: 'stop', stopReason: 'end_turn' },
        ]);

        const engine = new Engine({
          adapter: mockAdapter,
          trace,
          config: { model: 'test-model', maxOutputTokens: 1024 },
          conversationStore,
          yeaftDir,
          vpId: 'vp-linus',
        });

        const events = [];
        for await (const event of engine.query({
          prompt: 'hello',
          sessionId: 'session-turn-id',
          threadId: 'main',
          vpTurnId: 'vp-turn-ui-1',
          userAlreadyPersisted: true,
        })) {
          events.push(event);
        }

        expect(events.map(e => e.type)).toContain('turn_end');
        const loaded = conversationStore.loadRecentBySession('session-turn-id', 10);
        expect(loaded).toHaveLength(1);
        expect(loaded[0]).toMatchObject({
          role: 'assistant',
          content: 'persisted reply',
          threadId: 'main',
          turnId: 'vp-turn-ui-1',
          speakerVpId: 'vp-linus',
          responseKind: 'result',
          stopReason: 'end_turn',
        });
      } finally {
        rmSync(yeaftDir, { recursive: true, force: true });
      }
    });

    it('loads Dream session summary into the system prompt Memory section and debug event', async () => {
      const yeaftDir = mkdtempSync(join(tmpdir(), 'yeaft-engine-dream-load-'));
      await writeSummary(
        { kind: 'session', id: 'g1' },
        'The user prefers concrete execution notes and wants Dream memory loaded into the prompt.\n<!-- dream-state -->\nlastDreamAt: 2026-07-17T00:00:00.000Z\n<!-- /dream-state -->',
        { root: join(yeaftDir, 'memory') },
      );
      await writeSummary(
        { kind: 'user' },
        'User-level Dream summary should enter the prompt but not the dream_memory_loaded browser payload.',
        { root: join(yeaftDir, 'memory') },
      );
      await writeSummary(
        { kind: 'session-vp', sessionId: 'g1', id: 'vp1' },
        'VP Dream summary should enter the prompt but not the session prompt-load payload.',
        { root: join(yeaftDir, 'memory') },
      );
      await writeSummary(
        { kind: 'session-topic', sessionId: 'g1', path: ['dream', 'recall'] },
        `Topic Dream summary should enter the prompt through AMS Resident. ${'完整摘要细节'.repeat(800)}`,
        { root: join(yeaftDir, 'memory') },
      );
      mockAdapter.pushResponse([
        { type: 'text_delta', text: 'ok' },
        { type: 'stop', stopReason: 'end_turn' },
      ]);

      const engine = new Engine({
        adapter: mockAdapter,
        trace,
        yeaftDir,
        sessionId: 'g1',
        config: { model: 'claude-test', maxOutputTokens: 2048, language: 'en' },
        amsRegistry: new AmsRegistry({ yeaftDir, config: {} }),
      });

      const events = [];
      for await (const event of engine.query({
        prompt: 'dream recall test',
        sessionId: 'g1',
        vpPersona: { vpId: 'vp1', name: 'VP One' },
      })) {
        events.push(event);
      }

      expect(mockAdapter.callLog).toHaveLength(1);
      const system = mockAdapter.callLog[0].system;
      expect(system).toContain('## Active Memory Set');
      expect(system).toContain('### Resident');
      expect(system).toContain('Dream memory loaded into the prompt');
      expect(system).toContain('User-level Dream summary should enter the prompt');
      expect(system).toContain('VP Dream summary should enter the prompt');
      expect(system).toContain('**session**: The user prefers concrete execution notes and wants Dream memory loaded into the prompt.');
      expect(system).not.toContain('dream-state');
      expect(system).not.toContain('lastDreamAt:');
      expect(system).toContain('**topic: dream/recall**: Topic Dream summary should enter the prompt through AMS Resident.');
      expect(system).not.toContain('**sessions/g1/topic/dream/recall**');
      expect(system).not.toContain('**sessions/g1**');
      expect(system).toContain('Topic Dream summary should enter the prompt through AMS Resident.');

      const loaded = events.find(e => e.type === 'dream_memory_loaded');
      expect(loaded).toBeTruthy();
      expect(loaded.loadedInto).toBe('system_prompt.memory');
      expect(loaded.resident).toHaveLength(2);
      expect(loaded.resident).toEqual(expect.arrayContaining([
        expect.objectContaining({
          scope: 'sessions/g1',
          source: 'resident-summary',
          summary: 'The user prefers concrete execution notes and wants Dream memory loaded into the prompt.',
          truncated: false,
        }),
        expect.objectContaining({
          scope: 'sessions/g1/topic/dream/recall',
          source: 'resident-summary',
          truncated: false,
        }),
      ]));
      const topicLoaded = loaded.resident.find(entry => entry.scope === 'sessions/g1/topic/dream/recall');
      expect(topicLoaded.summary).toContain('完整摘要细节'.repeat(800));
    });

    it('should pass model and system prompt to adapter', async () => {
      mockAdapter.pushResponse([
        { type: 'text_delta', text: 'Hi' },
        { type: 'stop', stopReason: 'end_turn' },
      ]);

      const engine = new Engine({
        adapter: mockAdapter,
        trace,
        config: { model: 'claude-test', maxOutputTokens: 2048 },
      });

      const events = [];
      for await (const event of engine.query({ prompt: 'test' })) {
        events.push(event);
      }

      expect(mockAdapter.callLog).toHaveLength(1);
      const call = mockAdapter.callLog[0];
      expect(call.model).toBe('claude-test');
      expect(call.system).toContain('Session Participant');
      expect(call.system).not.toContain('Yeaft — AI');
      expect(call.system).toContain('work');
      expect(call.maxTokens).toBe(2048);
      expect(call.messages).toHaveLength(1);
      expect(call.messages[0].role).toBe('user');
      expect(call.messages[0].content).toBe('test');
    });
  });

  describe('tool execution loop', () => {
    it('should execute tools and loop until end_turn', async () => {
      // First response: model wants to use a tool
      mockAdapter.pushResponse([
        { type: 'text_delta', text: 'Let me search.' },
        { type: 'tool_call', id: 'call_1', name: 'search', input: { q: 'test query' } },
        { type: 'usage', inputTokens: 50, outputTokens: 20 },
        { type: 'stop', stopReason: 'tool_use' },
      ]);

      // Second response: model has the answer
      mockAdapter.pushResponse([
        { type: 'text_delta', text: 'Found results for test query.' },
        { type: 'usage', inputTokens: 80, outputTokens: 15 },
        { type: 'stop', stopReason: 'end_turn' },
      ]);

      const engine = new Engine({
        adapter: mockAdapter,
        trace,
        config: { model: 'test-model', maxOutputTokens: 1024 },
      });

      engine.registerTool({
        name: 'search',
        description: 'Search the web',
        parameters: { type: 'object', properties: { q: { type: 'string' } } },
        execute: async (input) => `Search results for: ${input.q}`,
      });

      const events = [];
      for await (const event of engine.query({ prompt: 'search for test query' })) {
        events.push(event);
      }

      // Check we got 2 turns
      const turnStarts = events.filter(e => e.type === 'turn_start');
      expect(turnStarts).toHaveLength(2);

      // Check tool execution events
      const toolStarts = events.filter(e => e.type === 'tool_start');
      expect(toolStarts).toHaveLength(1);
      expect(toolStarts[0].name).toBe('search');
      expect(toolStarts[0].input).toEqual({ q: 'test query' });

      const toolEnds = events.filter(e => e.type === 'tool_end');
      expect(toolEnds).toHaveLength(1);
      expect(toolEnds[0].output).toBe('Search results for: test query');
      expect(toolEnds[0].isError).toBe(false);

      // Check second adapter call has tool results in messages
      expect(mockAdapter.callLog).toHaveLength(2);
      const secondCall = mockAdapter.callLog[1];
      // Messages: user, assistant (with toolCalls), tool result
      expect(secondCall.messages).toHaveLength(3);
      expect(secondCall.messages[0].role).toBe('user');
      expect(secondCall.messages[1].role).toBe('assistant');
      expect(secondCall.messages[1].toolCalls).toHaveLength(1);
      expect(secondCall.messages[2].role).toBe('tool');
      expect(secondCall.messages[2].toolCallId).toBe('call_1');
    });

    it('passes the active tool call identity to interactive AskUser hosts', async () => {
      mockAdapter.pushResponse([
        { type: 'tool_call', id: 'call_ask', name: 'ask_test', input: { question: 'Continue?' } },
        { type: 'stop', stopReason: 'tool_use' },
      ]);
      mockAdapter.pushResponse([
        { type: 'text_delta', text: 'Continuing.' },
        { type: 'stop', stopReason: 'end_turn' },
      ]);

      const askUser = async (_input, toolCall) => JSON.stringify(toolCall);
      const engine = new Engine({
        adapter: mockAdapter,
        trace,
        config: { model: 'test-model', maxOutputTokens: 1024 },
      });
      engine.registerTool({
        name: 'ask_test',
        description: 'Ask through the host',
        parameters: {},
        execute: async (input, ctx) => ctx.askUser(input),
      });

      const events = [];
      for await (const event of engine.query({ prompt: 'ask me', askUser })) events.push(event);

      const toolEnd = events.find(event => event.type === 'tool_end');
      expect(JSON.parse(toolEnd.output)).toMatchObject({
        id: 'call_ask',
        name: 'ask_test',
      });
    });

    it('marks structured tool error envelopes as failed executions', async () => {
      mockAdapter.pushResponse([
        { type: 'tool_call', id: 'call_structured_error', name: 'structured_error_tool', input: {} },
        { type: 'stop', stopReason: 'tool_use' },
      ]);
      mockAdapter.pushResponse([
        { type: 'text_delta', text: 'The tool returned an error.' },
        { type: 'stop', stopReason: 'end_turn' },
      ]);

      const records = [];
      const engine = new Engine({
        adapter: mockAdapter,
        trace,
        config: { model: 'test-model', maxOutputTokens: 1024 },
        toolStats: { record: entry => records.push(entry) },
      });
      engine.registerTool({
        name: 'structured_error_tool',
        description: 'Returns a structured failure',
        parameters: {},
        errorOutput: 'json-error-envelope',
        execute: async () => JSON.stringify({ error: 'Path not found' }),
      });

      const events = [];
      for await (const event of engine.query({ prompt: 'use the tool' })) events.push(event);

      expect(events.find(event => event.type === 'tool_end')).toMatchObject({ isError: true });
      expect(events.find(event => event.type === 'tool_exec')).toMatchObject({ isError: true });
      expect(mockAdapter.callLog[1].messages.find(message => message.role === 'tool')).toMatchObject({ isError: true });
      expect(records).toEqual([
        expect.objectContaining({ name: 'structured_error_tool', isError: true, errorMessage: '{"error":"Path not found"}' }),
      ]);
    });

    it('propagates resolved MCP isError results through events, model messages, and stats', async () => {
      mockAdapter.pushResponse([
        { type: 'tool_call', id: 'call_mcp_error', name: 'mcp__secure__read', input: {} },
        { type: 'stop', stopReason: 'tool_use' },
      ]);
      mockAdapter.pushResponse([
        { type: 'text_delta', text: 'The MCP tool failed.' },
        { type: 'stop', stopReason: 'end_turn' },
      ]);

      const records = [];
      const mcpManager = {
        listTools: () => [{
          name: 'secure__read',
          server: 'secure',
          description: 'Read protected data',
          inputSchema: { type: 'object', properties: {} },
        }],
        callTool: async () => ({
          isError: true,
          content: [{ type: 'text', text: 'permission denied' }],
        }),
      };
      const engine = new Engine({
        adapter: mockAdapter,
        trace,
        config: { model: 'test-model', maxOutputTokens: 1024 },
        toolStats: { record: entry => records.push(entry) },
      });
      for (const tool of buildMcpFlattenedTools(mcpManager)) engine.registerTool(tool);

      const events = [];
      for await (const event of engine.query({ prompt: 'read protected data' })) events.push(event);

      expect(events.find(event => event.type === 'tool_end')).toMatchObject({
        output: 'Error: permission denied',
        isError: true,
      });
      expect(events.find(event => event.type === 'tool_exec')).toMatchObject({ isError: true });
      expect(mockAdapter.callLog[1].messages.find(message => message.role === 'tool')).toMatchObject({
        content: 'Error: permission denied',
        isError: true,
      });
      expect(records).toEqual([
        expect.objectContaining({
          name: 'mcp__secure__read',
          isError: true,
          errorMessage: 'Error: permission denied',
        }),
      ]);
    });

    it('should handle tool execution errors gracefully', async () => {
      mockAdapter.pushResponse([
        { type: 'tool_call', id: 'call_1', name: 'failing_tool', input: {} },
        { type: 'stop', stopReason: 'tool_use' },
      ]);

      mockAdapter.pushResponse([
        { type: 'text_delta', text: 'The tool failed, sorry.' },
        { type: 'stop', stopReason: 'end_turn' },
      ]);

      const engine = new Engine({
        adapter: mockAdapter,
        trace,
        config: { model: 'test-model', maxOutputTokens: 1024 },
      });

      engine.registerTool({
        name: 'failing_tool',
        description: 'A tool that fails',
        parameters: {},
        execute: async () => { throw new Error('Tool crashed'); },
      });

      const events = [];
      for await (const event of engine.query({ prompt: 'use the tool' })) {
        events.push(event);
      }

      // Tool should have reported error
      const toolEnds = events.filter(e => e.type === 'tool_end');
      expect(toolEnds).toHaveLength(1);
      expect(toolEnds[0].isError).toBe(true);
      expect(toolEnds[0].output).toContain('Tool crashed');

      // Engine should still complete
      const lastTurnEnd = events.filter(e => e.type === 'turn_end').pop();
      expect(lastTurnEnd.stopReason).toBe('end_turn');
    });

    it('should handle unknown tool gracefully', async () => {
      mockAdapter.pushResponse([
        { type: 'tool_call', id: 'call_1', name: 'nonexistent', input: {} },
        { type: 'stop', stopReason: 'tool_use' },
      ]);

      mockAdapter.pushResponse([
        { type: 'text_delta', text: 'I see the tool was not found.' },
        { type: 'stop', stopReason: 'end_turn' },
      ]);

      const engine = new Engine({
        adapter: mockAdapter,
        trace,
        config: { model: 'test-model', maxOutputTokens: 1024 },
      });

      const events = [];
      for await (const event of engine.query({ prompt: 'use nonexistent' })) {
        events.push(event);
      }

      const toolEnds = events.filter(e => e.type === 'tool_end');
      expect(toolEnds).toHaveLength(1);
      expect(toolEnds[0].isError).toBe(true);
      expect(toolEnds[0].output).toContain('unknown tool');
    });
  });

  describe('multiple tool calls in one turn', () => {
    it('should execute multiple tools from a single response', async () => {
      mockAdapter.pushResponse([
        { type: 'text_delta', text: 'Searching both...' },
        { type: 'tool_call', id: 'call_1', name: 'search', input: { q: 'foo' } },
        { type: 'tool_call', id: 'call_2', name: 'search', input: { q: 'bar' } },
        { type: 'stop', stopReason: 'tool_use' },
      ]);

      mockAdapter.pushResponse([
        { type: 'text_delta', text: 'Found both results.' },
        { type: 'stop', stopReason: 'end_turn' },
      ]);

      const engine = new Engine({
        adapter: mockAdapter,
        trace,
        config: { model: 'test-model', maxOutputTokens: 1024 },
      });

      engine.registerTool({
        name: 'search',
        description: 'Search',
        parameters: {},
        execute: async (input) => `Results: ${input.q}`,
      });

      const events = [];
      for await (const event of engine.query({ prompt: 'search foo and bar' })) {
        events.push(event);
      }

      const toolEnds = events.filter(e => e.type === 'tool_end');
      expect(toolEnds).toHaveLength(2);
      expect(toolEnds[0].output).toBe('Results: foo');
      expect(toolEnds[1].output).toBe('Results: bar');

      // Second call should have both tool results
      const secondCall = mockAdapter.callLog[1];
      const toolMessages = secondCall.messages.filter(m => m.role === 'tool');
      expect(toolMessages).toHaveLength(2);
    });
  });

  describe('no max turns cap (task-324)', () => {
    it('should run past the old MAX_TURNS=25 cap when tool loop continues', async () => {
      // Push 30 tool_use responses, then a final end_turn — old behavior
      // would error at turn 26, new behavior runs all 30 tool turns + 1
      // final response turn.
      for (let i = 0; i < 30; i++) {
        mockAdapter.pushResponse([
          { type: 'tool_call', id: `call_${i}`, name: 'echo', input: { msg: `${i}` } },
          { type: 'stop', stopReason: 'tool_use' },
        ]);
      }
      // Final turn: end_turn (no tool calls) to let the loop exit cleanly.
      mockAdapter.pushResponse([
        { type: 'text_delta', delta: 'done' },
        { type: 'stop', stopReason: 'end_turn' },
      ]);

      const engine = new Engine({
        adapter: mockAdapter,
        trace,
        config: { model: 'test-model', maxOutputTokens: 1024 },
      });

      engine.registerTool({
        name: 'echo',
        description: 'Echo',
        parameters: {},
        execute: async (input) => input.msg,
      });

      const events = [];
      for await (const event of engine.query({ prompt: 'loop past old cap' })) {
        events.push(event);
      }

      // No "Max turns" error event should be emitted.
      const errorEvents = events.filter(e => e.type === 'error');
      const maxTurnsErrors = errorEvents.filter(e =>
        e.error && /Max turns/.test(e.error.message || '')
      );
      expect(maxTurnsErrors).toHaveLength(0);

      // Turns executed should exceed the old cap of 25.
      const turnStarts = events.filter(e => e.type === 'turn_start');
      expect(turnStarts.length).toBeGreaterThan(25);
      // And should include the final end_turn turn (31 total).
      expect(turnStarts.length).toBe(31);
    });
  });

  describe('adapter errors', () => {
    it('should handle adapter throw gracefully', async () => {
      const engine = new Engine({
        adapter: {
          async *stream() {
            throw new Error('Network error');
          },
        },
        trace,
        config: { model: 'test-model', maxOutputTokens: 1024 },
      });

      const events = [];
      for await (const event of engine.query({ prompt: 'hello' })) {
        events.push(event);
      }

      const errorEvents = events.filter(e => e.type === 'error');
      expect(errorEvents).toHaveLength(1);
      expect(errorEvents[0].error.message).toBe('Network error');
      expect(errorEvents[0].retryable).toBe(false);

      // Should still emit turn_end
      const turnEnds = events.filter(e => e.type === 'turn_end');
      expect(turnEnds).toHaveLength(1);
      expect(turnEnds[0].stopReason).toBe('error');
    });

    it('should mark LLMRateLimitError as retryable', async () => {
      const { LLMRateLimitError } = await import('../../../agent/yeaft/llm/adapter.js');

      const engine = new Engine({
        adapter: {
          async *stream() {
            throw new LLMRateLimitError('Too fast', 429);
          },
        },
        trace,
        // Disable backoff retry so the test surfaces the legacy error
        // shape directly. The new retry policy is covered separately.
        config: { model: 'test-model', maxOutputTokens: 1024, llmRetry: { maxRetries: 0 } },
      });

      const events = [];
      for await (const event of engine.query({ prompt: 'hello' })) {
        events.push(event);
      }

      const errorEvents = events.filter(e => e.type === 'error');
      expect(errorEvents).toHaveLength(1);
      expect(errorEvents[0].retryable).toBe(true);
    });

    it('should mark LLMServerError as retryable', async () => {
      const { LLMServerError } = await import('../../../agent/yeaft/llm/adapter.js');

      const engine = new Engine({
        adapter: {
          async *stream() {
            throw new LLMServerError('Internal error', 500);
          },
        },
        trace,
        config: { model: 'test-model', maxOutputTokens: 1024, llmRetry: { maxRetries: 0 } },
      });

      const events = [];
      for await (const event of engine.query({ prompt: 'hello' })) {
        events.push(event);
      }

      const errorEvents = events.filter(e => e.type === 'error');
      expect(errorEvents).toHaveLength(1);
      expect(errorEvents[0].retryable).toBe(true);
    });
  });

  describe('LLM retry policy', () => {
    it('honours server Retry-After on LLMRateLimitError and recovers', async () => {
      const { LLMRateLimitError } = await import('../../../agent/yeaft/llm/adapter.js');
      let attempts = 0;
      const engine = new Engine({
        adapter: {
          async *stream() {
            attempts += 1;
            if (attempts === 1) {
              throw new LLMRateLimitError('Too fast', 429, 50);
            }
            yield { type: 'text_delta', text: 'ok' };
            yield { type: 'usage', inputTokens: 1, outputTokens: 1 };
            yield { type: 'stop', stopReason: 'end_turn' };
          },
        },
        trace,
        config: {
          model: 'test-model',
          maxOutputTokens: 1024,
          llmRetry: { maxRetries: 3, baseDelayMs: 10, maxDelayMs: 100, jitterRatio: 0 },
        },
      });

      const events = [];
      for await (const event of engine.query({ prompt: 'hello' })) {
        events.push(event);
      }

      expect(attempts).toBe(2);
      const retryEvents = events.filter(e => e.type === 'llm_retry');
      expect(retryEvents).toHaveLength(1);
      expect(retryEvents[0].attempt).toBe(1);
      expect(retryEvents[0].reason).toBe('rate_limit_retry_after');
      expect(retryEvents[0].recoveryMode).toBe('restart');
      expect(retryEvents[0].delayMs).toBeLessThanOrEqual(50);
      const errorEvents = events.filter(e => e.type === 'error');
      expect(errorEvents).toHaveLength(0);
    });

    it('uses exponential backoff for LLMServerError and gives up after maxRetries', async () => {
      const { LLMServerError } = await import('../../../agent/yeaft/llm/adapter.js');
      let attempts = 0;
      const engine = new Engine({
        adapter: {
          async *stream() {
            attempts += 1;
            throw new LLMServerError('bad gateway', 502);
          },
        },
        trace,
        config: {
          model: 'test-model',
          maxOutputTokens: 1024,
          llmRetry: { maxRetries: 2, baseDelayMs: 5, maxDelayMs: 20, jitterRatio: 0 },
        },
      });

      const events = [];
      for await (const event of engine.query({ prompt: 'hello' })) {
        events.push(event);
      }

      // First attempt + 2 retries = 3 total adapter calls.
      expect(attempts).toBe(3);
      const retryEvents = events.filter(e => e.type === 'llm_retry');
      expect(retryEvents).toHaveLength(2);
      expect(retryEvents[0].reason).toBe('transient_backoff');
      // Backoff grows: attempt 1 uses base, attempt 2 doubles.
      expect(retryEvents[1].delayMs).toBeGreaterThanOrEqual(retryEvents[0].delayMs);
      const errorEvents = events.filter(e => e.type === 'error');
      expect(errorEvents).toHaveLength(1);
      expect(errorEvents[0].retryable).toBe(true);
    });

    it('classifies stream idle timeout retries separately and marks final retry exhaustion', async () => {
      const { LLMStreamIdleTimeoutError } = await import('../../../agent/yeaft/llm/adapter.js');
      let attempts = 0;
      const engine = new Engine({
        adapter: {
          async *stream() {
            attempts += 1;
            throw new LLMStreamIdleTimeoutError('OpenAI stream idle timeout after 20000ms', 20_000);
          },
        },
        trace,
        config: {
          model: 'test-model',
          maxOutputTokens: 1024,
          llmRetry: { maxRetries: 3, baseDelayMs: 1, maxDelayMs: 5, jitterRatio: 0 },
        },
      });

      const events = [];
      for await (const event of engine.query({ prompt: 'hello' })) {
        events.push(event);
      }

      // First attempt + 3 retries = 4 total adapter calls.
      expect(attempts).toBe(4);
      const retryEvents = events.filter(e => e.type === 'llm_retry');
      expect(retryEvents).toHaveLength(3);
      expect(retryEvents.map(e => e.reason)).toEqual([
        'stream_idle_timeout',
        'stream_idle_timeout',
        'stream_idle_timeout',
      ]);
      expect(retryEvents[0].message).toContain('20000ms');
      const errorEvents = events.filter(e => e.type === 'error');
      expect(errorEvents).toHaveLength(1);
      expect(errorEvents[0].retryable).toBe(true);
      expect(errorEvents[0].reason).toBe('stream_idle_timeout');
      expect(errorEvents[0].retryExhausted).toBe(true);
      expect(errorEvents[0].retryAttempts).toBe(3);
      expect(errorEvents[0].maxRetries).toBe(3);
      expect(errorEvents[0].error).toBeInstanceOf(LLMStreamIdleTimeoutError);

      // Once a complete tool call has crossed the stream boundary, retrying or
      // falling back could publish and execute it twice. Fail closed instead.
      let toolAttempts = 0;
      const toolEngine = new Engine({
        adapter: {
          async *stream() {
            toolAttempts += 1;
            yield { type: 'tool_call', id: 'call-once', name: 'echo', input: { value: 1 } };
            throw new LLMStreamIdleTimeoutError('OpenAI stream idle timeout after 90000ms', 90_000);
          },
        },
        trace,
        config: {
          model: 'test-model',
          fallbackModel: 'fallback-model',
          maxOutputTokens: 1024,
          llmRetry: { maxRetries: 3, baseDelayMs: 1, maxDelayMs: 5, jitterRatio: 0 },
        },
      });
      const toolEvents = [];
      for await (const event of toolEngine.query({ prompt: 'use a tool' })) toolEvents.push(event);
      expect(toolAttempts).toBe(1);
      expect(toolEvents.filter(event => event.type === 'tool_call')).toHaveLength(1);
      expect(toolEvents.filter(event => event.type === 'llm_retry' || event.type === 'fallback')).toHaveLength(0);
      expect(toolEvents).toContainEqual(expect.objectContaining({
        type: 'error',
        reason: 'stream_idle_timeout',
        retryExhausted: false,
        retryAttempts: 0,
      }));
    });

    it('falls back after stream idle timeout retries are exhausted', async () => {
      const { LLMStreamIdleTimeoutError } = await import('../../../agent/yeaft/llm/adapter.js');
      const models = [];
      const engine = new Engine({
        adapter: {
          async *stream(params) {
            models.push(params.model);
            if (params.model === 'primary-model') {
              throw new LLMStreamIdleTimeoutError('OpenAI stream idle timeout after 20000ms', 20_000);
            }
            yield { type: 'text_delta', text: 'fallback ok' };
            yield { type: 'stop', stopReason: 'end_turn' };
          },
        },
        trace,
        config: {
          model: 'primary-model',
          fallbackModel: 'fallback-model',
          maxOutputTokens: 1024,
          llmRetry: { maxRetries: 2, baseDelayMs: 1, maxDelayMs: 5, jitterRatio: 0 },
        },
      });

      const events = [];
      for await (const event of engine.query({ prompt: 'hello' })) {
        events.push(event);
      }

      expect(models).toEqual(['primary-model', 'primary-model', 'primary-model', 'fallback-model']);
      const retryEvents = events.filter(e => e.type === 'llm_retry');
      expect(retryEvents).toHaveLength(2);
      expect(retryEvents.map(e => e.reason)).toEqual(['stream_idle_timeout', 'stream_idle_timeout']);
      expect(events).toContainEqual(expect.objectContaining({
        type: 'fallback',
        from: 'primary-model',
        to: 'fallback-model',
      }));
      expect(events.filter(e => e.type === 'error')).toHaveLength(0);
      expect(events).toContainEqual(expect.objectContaining({ type: 'text_delta', text: 'fallback ok' }));

      // A retry after visible text must continue from the accepted prefix on a
      // fresh request instead of replaying the original prompt and duplicating
      // the already-rendered output.
      const requests = [];
      const traceRows = [];
      const continuationTrace = Object.create(trace);
      continuationTrace.startTurn = () => 'retry-trace';
      continuationTrace.endTurn = (_id, row) => traceRows.push(row);
      const continuationDir = mkdtempSync(join(tmpdir(), 'yeaft-engine-idle-continuation-'));
      const continuationStore = new ConversationStore(continuationDir);
      let attempt = 0;
      const continuationEngine = new Engine({
        adapter: {
          async *stream(params) {
            requests.push(params.messages.map(message => ({
              role: message.role,
              content: message.content,
            })));
            attempt += 1;
            if (attempt === 1) {
              yield { type: 'text_delta', text: 'first half ' };
              throw new LLMStreamIdleTimeoutError('OpenAI stream idle timeout after 90000ms', 90_000);
            }
            yield { type: 'stop', stopReason: 'end_turn' };
          },
        },
        trace: continuationTrace,
        conversationStore: continuationStore,
        yeaftDir: continuationDir,
        config: {
          model: 'test-model',
          maxOutputTokens: 1024,
          llmRetry: { maxRetries: 3, baseDelayMs: 1, maxDelayMs: 5, jitterRatio: 0 },
        },
      });
      const continuationEvents = [];
      for await (const event of continuationEngine.query({
        prompt: 'hello',
        sessionId: 'session-idle-continuation',
      })) continuationEvents.push(event);
      expect(attempt).toBe(2);
      expect(continuationEvents.filter(event => event.type === 'text_delta').map(event => event.text))
        .toEqual(['first half ']);
      expect(continuationEvents.filter(event => event.type === 'llm_retry')).toEqual([
        expect.objectContaining({ reason: 'stream_idle_timeout', recoveryMode: 'continue' }),
      ]);
      expect(requests[1].slice(-2)).toEqual([
        expect.objectContaining({ role: 'assistant', content: 'first half ' }),
        expect.objectContaining({
          role: 'user',
          content: expect.stringContaining('Continue from the exact point'),
        }),
      ]);
      const retryTrace = traceRows.find(row => row.stopReason === 'llm_retry');
      expect(retryTrace.messages).not.toContainEqual(expect.objectContaining({
        role: 'user',
        content: expect.stringContaining('Continue from the exact point'),
      }));
      expect(traceRows.at(-1).messages).toContainEqual(expect.objectContaining({
        role: 'user',
        content: expect.stringContaining('Continue from the exact point'),
      }));
      expect(continuationStore.loadRecentBySession('session-idle-continuation', 10)
        .find(message => message.content === 'first half ')).toMatchObject({
          responseKind: 'result',
          stopReason: 'end_turn',
        });
      rmSync(continuationDir, { recursive: true, force: true });
    });

    it('does not emit debug loop rows for retryable attempts before fallback succeeds', async () => {
      const { LLMServerError } = await import('../../../agent/yeaft/llm/adapter.js');
      const engine = new Engine({
        adapter: {
          async *stream(params) {
            if (params.model === 'primary-model') {
              throw new LLMServerError('Anthropic stream ended before stop event', 0);
            }
            yield { type: 'text_delta', text: 'fallback ok' };
            yield { type: 'stop', stopReason: 'end_turn' };
          },
        },
        trace,
        config: {
          model: 'primary-model',
          fallbackModel: 'fallback-model',
          maxOutputTokens: 1024,
          llmRetry: { maxRetries: 1, baseDelayMs: 1, maxDelayMs: 5, jitterRatio: 0 },
        },
      });

      const events = [];
      for await (const event of engine.query({ prompt: 'hello' })) {
        events.push(event);
      }

      expect(events.filter(e => e.type === 'llm_retry')).toHaveLength(1);
      expect(events.filter(e => e.type === 'fallback')).toHaveLength(1);
      expect(events.filter(e => e.type === 'error')).toHaveLength(0);
      const loops = events.filter(e => e.type === 'loop');
      expect(loops).toHaveLength(1);
      expect(loops[0].model).toBe('fallback-model');
      expect(loops[0].response).toBe('fallback ok');
    });

    it('falls back immediately on stream idle timeout when maxRetries is zero', async () => {
      const { LLMStreamIdleTimeoutError } = await import('../../../agent/yeaft/llm/adapter.js');
      const models = [];
      const engine = new Engine({
        adapter: {
          async *stream(params) {
            models.push(params.model);
            if (params.model === 'primary-model') {
              throw new LLMStreamIdleTimeoutError('OpenAI stream idle timeout after 20000ms', 20_000);
            }
            yield { type: 'text_delta', text: 'fallback ok' };
            yield { type: 'stop', stopReason: 'end_turn' };
          },
        },
        trace,
        config: {
          model: 'primary-model',
          fallbackModel: 'fallback-model',
          maxOutputTokens: 1024,
          llmRetry: { maxRetries: 0, baseDelayMs: 1, maxDelayMs: 5, jitterRatio: 0 },
        },
      });

      const events = [];
      for await (const event of engine.query({ prompt: 'hello' })) {
        events.push(event);
      }

      expect(models).toEqual(['primary-model', 'fallback-model']);
      expect(events.filter(e => e.type === 'llm_retry')).toHaveLength(0);
      expect(events).toContainEqual(expect.objectContaining({
        type: 'fallback',
        from: 'primary-model',
        to: 'fallback-model',
      }));
      expect(events.filter(e => e.type === 'error')).toHaveLength(0);
      expect(events).toContainEqual(expect.objectContaining({ type: 'text_delta', text: 'fallback ok' }));
    });

    it('does not retry on non-retryable error', async () => {
      const { LLMAuthError } = await import('../../../agent/yeaft/llm/adapter.js');
      let attempts = 0;
      const engine = new Engine({
        adapter: {
          async *stream() {
            attempts += 1;
            throw new LLMAuthError('bad key', 401);
          },
        },
        trace,
        config: {
          model: 'test-model',
          maxOutputTokens: 1024,
          llmRetry: { maxRetries: 5, baseDelayMs: 1, maxDelayMs: 5, jitterRatio: 0 },
        },
      });

      const events = [];
      for await (const event of engine.query({ prompt: 'hello' })) {
        events.push(event);
      }

      expect(attempts).toBe(1);
      expect(events.filter(e => e.type === 'llm_retry')).toHaveLength(0);
      const errorEvents = events.filter(e => e.type === 'error');
      expect(errorEvents).toHaveLength(1);
      // 401 is not in the retryable allow-list at the engine event boundary.
      expect(errorEvents[0].retryable).toBe(false);
    });

    it('terminates on non-retryable in-band adapter error instead of normal end_turn', async () => {
      const failed = new Error('bad request body');
      failed.code = 'invalid_request_error';
      const engine = new Engine({
        adapter: {
          async *stream() {
            yield { type: 'error', error: failed, retryable: false };
          },
        },
        trace,
        config: {
          model: 'test-model',
          maxOutputTokens: 1024,
          llmRetry: { maxRetries: 5, baseDelayMs: 1, maxDelayMs: 5, jitterRatio: 0 },
        },
      });

      const events = [];
      for await (const event of engine.query({ prompt: 'hello' })) {
        events.push(event);
      }

      expect(events.filter(e => e.type === 'llm_retry')).toHaveLength(0);
      const errorEvents = events.filter(e => e.type === 'error');
      expect(errorEvents).toHaveLength(1);
      expect(errorEvents[0].error.message).toBe('bad request body');
      expect(errorEvents[0].retryable).toBe(false);
      const loops = events.filter(e => e.type === 'loop');
      expect(loops).toHaveLength(1);
      expect(loops[0].stopReason).toBe('error');
      expect(loops[0].response).toBe('Error: bad request body');
      expect(events).toContainEqual(expect.objectContaining({ type: 'turn_end', stopReason: 'error' }));
      expect(events).not.toContainEqual(expect.objectContaining({ type: 'turn_end', stopReason: 'end_turn' }));
    });

    it('settles retry persistence for boundary teardown and later textless failure', async () => {
      const { LLMServerError } = await import('../../../agent/yeaft/llm/adapter.js');
      const yeaftDir = mkdtempSync(join(tmpdir(), 'yeaft-engine-retry-abort-partial-'));
      try {
        const conversationStore = new ConversationStore(yeaftDir);
        let attempts = 0;
        const engine = new Engine({
          adapter: {
            async *stream() {
              attempts += 1;
              yield { type: 'text_delta', text: 'visible partial before retry' };
              throw new LLMServerError('temporary upstream failure', 503);
            },
          },
          trace,
          conversationStore,
          yeaftDir,
          config: {
            model: 'test-model',
            maxOutputTokens: 1024,
            llmRetry: { maxRetries: 3, baseDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 },
          },
        });

        const iterator = engine.query({
          prompt: 'hi',
          sessionId: 'session-retry-abort',
          vpTurnId: 'turn-retry-abort',
        })[Symbol.asyncIterator]();
        const events = [];
        while (true) {
          const step = await iterator.next();
          if (step.done) break;
          events.push(step.value);
          if (step.value.type === 'turn_end' && step.value.stopReason === 'llm_retry') break;
        }
        await iterator.return();

        expect(attempts).toBe(1);
        expect(events.some(e => e.type === 'llm_retry')).toBe(true);
        expect(events).toContainEqual(expect.objectContaining({ type: 'turn_end', stopReason: 'llm_retry' }));
        expect(conversationStore.loadRecentBySession('session-retry-abort', Infinity)).toEqual([
          expect.objectContaining({ role: 'user', content: 'hi' }),
          expect.objectContaining({
            role: 'assistant',
            content: 'visible partial before retry',
            incomplete: true,
            stopReason: 'aborted',
            turnId: 'turn-retry-abort',
          }),
        ]);
      } finally {
        rmSync(yeaftDir, { recursive: true, force: true });
      }
      const errorDir = mkdtempSync(join(tmpdir(), 'yeaft-engine-retry-final-partial-'));
      try {
        const conversationStore = new ConversationStore(errorDir);
        let attempts = 0;
        const engine = new Engine({
          adapter: {
            async *stream() {
              attempts += 1;
              if (attempts === 1) yield { type: 'text_delta', text: 'visible partial before failure' };
              throw new LLMServerError('temporary upstream failure', 503);
            },
          },
          trace,
          conversationStore,
          yeaftDir: errorDir,
          config: {
            model: 'test-model',
            maxOutputTokens: 1024,
            llmRetry: { maxRetries: 2, baseDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 },
          },
        });

        const events = [];
        for await (const event of engine.query({
          prompt: 'hi',
          sessionId: 'session-retry-final-partial',
          vpTurnId: 'turn-retry-final-partial',
        })) events.push(event);

        expect(attempts).toBe(3);
        expect(events).toContainEqual(expect.objectContaining({ type: 'error', retryable: true }));
        expect(conversationStore.loadRecentBySession('session-retry-final-partial', Infinity)).toEqual([
          expect.objectContaining({ role: 'user', content: 'hi' }),
          expect.objectContaining({
            role: 'assistant',
            content: 'visible partial before failure',
            incomplete: true,
            stopReason: 'error',
            turnId: 'turn-retry-final-partial',
          }),
          expect.objectContaining({
            role: 'user',
            userAuthored: false,
            content: expect.stringContaining('Continue from the exact point'),
          }),
        ]);
      } finally {
        rmSync(errorDir, { recursive: true, force: true });
      }
    });
  });

  describe('max_tokens stop reason', () => {
    it('should yield turn_end with max_tokens when output is truncated', async () => {
      mockAdapter.pushResponse([
        { type: 'text_delta', text: 'This response was cut short because—' },
        { type: 'usage', inputTokens: 50, outputTokens: 16384 },
        { type: 'stop', stopReason: 'max_tokens' },
      ]);

      const engine = new Engine({
        adapter: mockAdapter,
        trace,
        config: { model: 'test-model', maxOutputTokens: 16384 },
      });

      const events = [];
      for await (const event of engine.query({ prompt: 'write a long essay' })) {
        events.push(event);
      }

      // Should have stop event with max_tokens
      const stopEvents = events.filter(e => e.type === 'stop');
      expect(stopEvents).toHaveLength(1);
      expect(stopEvents[0].stopReason).toBe('max_tokens');

      // turn_end should reflect max_tokens_continue (Phase 2: auto-continue)
      const turnEnd = events.find(e => e.type === 'turn_end');
      expect(turnEnd.stopReason).toBe('max_tokens_continue');
      expect(turnEnd.turnNumber).toBe(1);

      // Phase 2: auto-continue triggers additional turns
      const turnStarts = events.filter(e => e.type === 'turn_start');
      expect(turnStarts.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('abort signal', () => {
    it('should propagate abort signal to adapter', async () => {
      const ac = new AbortController();
      let receivedSignal = null;

      const abortAdapter = {
        async *stream(params) {
          receivedSignal = params.signal;
          // Simulate checking the signal
          if (params.signal?.aborted) {
            throw new Error('Request aborted');
          }
          yield { type: 'text_delta', text: 'Hello' };
          yield { type: 'stop', stopReason: 'end_turn' };
        },
      };

      const engine = new Engine({
        adapter: abortAdapter,
        trace,
        config: { model: 'test-model', maxOutputTokens: 1024 },
      });

      const events = [];
      for await (const event of engine.query({ prompt: 'hello', signal: ac.signal })) {
        events.push(event);
      }

      // task-325a: the engine now owns an internal AbortController that
      // mirrors the caller-provided signal, so the adapter receives the
      // engine's linked signal (not the caller's identity). Verify that
      // a valid AbortSignal was propagated rather than identity.
      expect(receivedSignal).toBeInstanceOf(AbortSignal);
      // Verify normal completion when signal is not aborted
      const textEvents = events.filter(e => e.type === 'text_delta');
      expect(textEvents).toHaveLength(1);
    });

    it('should handle pre-aborted signal', async () => {
      const ac = new AbortController();
      ac.abort(); // Pre-abort

      const abortAdapter = {
        async *stream(params) {
          if (params.signal?.aborted) {
            throw new Error('Request aborted');
          }
          yield { type: 'text_delta', text: 'Should not reach' };
          yield { type: 'stop', stopReason: 'end_turn' };
        },
      };

      const engine = new Engine({
        adapter: abortAdapter,
        trace,
        config: { model: 'test-model', maxOutputTokens: 1024 },
      });

      const events = [];
      for await (const event of engine.query({ prompt: 'hello', signal: ac.signal })) {
        events.push(event);
      }

      // task-325a: pre-aborted external signal now converges on the
      // typed `aborted` event (not a generic `error`), and the turn
      // ends with stopReason 'aborted'.
      const abortedEvents = events.filter(e => e.type === 'aborted');
      expect(abortedEvents).toHaveLength(1);
      expect(abortedEvents[0].reason).toBe('external');
      const turnEnds = events.filter(e => e.type === 'turn_end');
      expect(turnEnds.at(-1).stopReason).toBe('aborted');
    });

    it('should pass signal to tool execute function', async () => {
      const ac = new AbortController();
      let toolReceivedSignal = null;

      mockAdapter.pushResponse([
        { type: 'tool_call', id: 'call_1', name: 'slow_tool', input: {} },
        { type: 'stop', stopReason: 'tool_use' },
      ]);

      mockAdapter.pushResponse([
        { type: 'text_delta', text: 'Done.' },
        { type: 'stop', stopReason: 'end_turn' },
      ]);

      const engine = new Engine({
        adapter: mockAdapter,
        trace,
        config: { model: 'test-model', maxOutputTokens: 1024 },
      });

      engine.registerTool({
        name: 'slow_tool',
        description: 'A slow tool',
        parameters: {},
        execute: async (input, ctx) => {
          toolReceivedSignal = ctx?.signal;
          return 'done';
        },
      });

      for await (const _event of engine.query({ prompt: 'use tool', signal: ac.signal })) {
        // consume
      }

      // task-325a: engine's internal linked signal is forwarded, so the
      // tool receives an AbortSignal — not the caller's identity.
      expect(toolReceivedSignal).toBeInstanceOf(AbortSignal);
    });

    // Regression: per-VP Stop in Yeaft Session was not interrupting the
    // current turn promptly. The wire frame reached the agent, the
    // controller fired, but the upstream LLM stream had already buffered
    // a batch of SSE chunks at the network/proxy layer. The adapter
    // continued reading them (reader.read() doesn't observe the signal
    // synchronously when chunks are already in the kernel buffer), and
    // the engine for-await loop happily yielded each chunk to the
    // web-bridge, which pushed yeaft_output frames to the browser for
    // 1–2s after Stop. The fix: engine must check signal.aborted before
    // yielding each adapter event so already-buffered chunks are
    // dropped — not forwarded — once the user has requested abort.
    it('drops buffered adapter chunks emitted after abort fires', async () => {
      // A non-cooperative adapter: it does NOT observe params.signal and
      // synchronously yields a long sequence of text_delta + tool_call
      // events, exactly like a fetch() ReadableStream that already has
      // SSE chunks in its kernel/proxy buffer when AbortSignal fires.
      const noncoopAdapter = {
        async *stream(_params) {
          // Pre-buffered chunks. None of these observe the signal —
          // that's the whole point: this models the network reality
          // where bytes are already in flight when Stop is pressed.
          for (let i = 0; i < 30; i += 1) {
            yield { type: 'text_delta', text: `chunk-${i} ` };
          }
          yield { type: 'stop', stopReason: 'end_turn' };
        },
      };

      const ac = new AbortController();
      const engine = new Engine({
        adapter: noncoopAdapter,
        trace,
        config: { model: 'test-model', maxOutputTokens: 1024 },
      });

      // Abort fires synchronously BEFORE the first yield is consumed.
      // This is the most adversarial timing: every single chunk the
      // adapter emits is post-abort, so a correctly-behaving engine
      // must yield zero text_delta events to the caller.
      ac.abort('user');

      const events = [];
      for await (const event of engine.query({ prompt: 'hi', signal: ac.signal })) {
        events.push(event);
      }

      const textDeltas = events.filter(e => e.type === 'text_delta');
      const aborted = events.filter(e => e.type === 'aborted');
      const turnEnds = events.filter(e => e.type === 'turn_end');

      // With the bug: textDeltas.length === 30 (all buffered chunks
      // leaked through). With the fix: textDeltas.length === 0 because
      // the engine checks signal.aborted before forwarding each adapter
      // event.
      expect(textDeltas).toHaveLength(0);
      expect(aborted).toHaveLength(1);
      expect(aborted[0].reason).toBe('external');
      expect(turnEnds.at(-1)?.stopReason).toBe('aborted');
    });

    it('treats a clean stream end after abort as aborted', async () => {
      let abortFn = null;
      const noncoopAdapter = {
        async *stream() {
          yield { type: 'text_delta', text: 'partial ' };
          if (abortFn) abortFn();
          // Some proxies close the body cleanly on abort instead of throwing.
          // No more events are yielded, so only the post-stream guard can
          // prevent this truncated response from reaching persistence.
        },
      };

      const ac = new AbortController();
      abortFn = () => ac.abort('user');
      const engine = new Engine({
        adapter: noncoopAdapter,
        trace,
        config: { model: 'test-model', maxOutputTokens: 1024 },
      });

      const events = [];
      for await (const event of engine.query({ prompt: 'hi', signal: ac.signal })) {
        events.push(event);
      }

      expect(events.filter(e => e.type === 'text_delta')).toHaveLength(1);
      expect(events.filter(e => e.type === 'aborted')).toHaveLength(1);
      expect(events.filter(e => e.type === 'turn_end').at(-1)?.stopReason).toBe('aborted');
    });

    it('drops adapter chunks emitted after abort fires mid-stream', async () => {
      // Same as above but abort fires AFTER a few chunks were already
      // legitimately delivered. Everything emitted post-abort must be
      // dropped; pre-abort chunks must still flow.
      let abortFn = null;
      const noncoopAdapter = {
        async *stream(_params) {
          for (let i = 0; i < 5; i += 1) {
            yield { type: 'text_delta', text: `pre-${i} ` };
          }
          // Trigger abort mid-stream. The remaining 25 chunks are the
          // "already in network buffer" payload the engine must drop.
          if (abortFn) abortFn();
          for (let i = 0; i < 25; i += 1) {
            yield { type: 'text_delta', text: `post-${i} ` };
          }
          yield { type: 'stop', stopReason: 'end_turn' };
        },
      };

      const ac = new AbortController();
      abortFn = () => ac.abort('user');

      const engine = new Engine({
        adapter: noncoopAdapter,
        trace,
        config: { model: 'test-model', maxOutputTokens: 1024 },
      });

      const events = [];
      for await (const event of engine.query({ prompt: 'hi', signal: ac.signal })) {
        events.push(event);
      }

      const textDeltas = events.filter(e => e.type === 'text_delta');
      const preChunks = textDeltas.filter(e => e.text.startsWith('pre-'));
      const postChunks = textDeltas.filter(e => e.text.startsWith('post-'));

      expect(preChunks).toHaveLength(5);
      // With the bug: postChunks.length === 25. With the fix: 0.
      expect(postChunks).toHaveLength(0);
      const aborted = events.filter(e => e.type === 'aborted');
      const turnEnds = events.filter(e => e.type === 'turn_end');
      expect(aborted).toHaveLength(1);
      expect(turnEnds.at(-1)?.stopReason).toBe('aborted');
    });
  });

  describe('debug trace integration', () => {
    it('should record turns and tools in debug trace', async () => {
      const dbTrace = new DebugTrace(TEST_DB);

      mockAdapter.pushResponse([
        { type: 'text_delta', text: 'Let me search.' },
        { type: 'tool_call', id: 'call_1', name: 'search', input: { q: 'test' } },
        { type: 'usage', inputTokens: 50, outputTokens: 20 },
        { type: 'stop', stopReason: 'tool_use' },
      ]);

      mockAdapter.pushResponse([
        { type: 'text_delta', text: 'Done.' },
        { type: 'usage', inputTokens: 80, outputTokens: 10 },
        { type: 'stop', stopReason: 'end_turn' },
      ]);

      const engine = new Engine({
        adapter: mockAdapter,
        trace: dbTrace,
        config: { model: 'test-model', maxOutputTokens: 1024 },
      });

      engine.registerTool({
        name: 'search',
        description: 'Search',
        parameters: {},
        execute: async () => 'results',
      });

      for await (const _event of engine.query({ prompt: 'search test' })) {
        // consume events
      }

      // Check debug trace recorded the turns
      const stats = await dbTrace.stats();
      expect(stats.turnCount).toBe(2);
      expect(stats.toolCount).toBe(1);

      // Check turn details
      const recent = await dbTrace.queryRecent(10);
      expect(recent).toHaveLength(2);

      // Check tool details
      const tools = await dbTrace.queryTools({ name: 'search' });
      expect(tools).toHaveLength(1);
      expect(tools[0].tool_name).toBe('search');
      expect(tools[0].tool_output).toBe('results');

      await dbTrace.close();
    });
  });

  describe('existing messages', () => {
    it('should prepend existing messages to conversation', async () => {
      mockAdapter.pushResponse([
        { type: 'text_delta', text: 'I remember.' },
        { type: 'stop', stopReason: 'end_turn' },
      ]);

      const engine = new Engine({
        adapter: mockAdapter,
        trace,
        config: { model: 'test-model', maxOutputTokens: 1024 },
      });

      const existingMessages = [
        { role: 'user', content: 'my name is Alice' },
        { role: 'assistant', content: 'Nice to meet you, Alice!' },
      ];

      const events = [];
      for await (const event of engine.query({
        prompt: 'what is my name?',
        messages: existingMessages,
      })) {
        events.push(event);
      }

      // Adapter should have received all messages
      const call = mockAdapter.callLog[0];
      expect(call.messages).toHaveLength(3);
      expect(call.messages[0].content).toBe('my name is Alice');
      expect(call.messages[1].content).toBe('Nice to meet you, Alice!');
      expect(call.messages[2].content).toBe('what is my name?');
    });
  });

  describe('tools passed to adapter', () => {
    it('should pass tool definitions to adapter when tools are registered', async () => {
      mockAdapter.pushResponse([
        { type: 'text_delta', text: 'ok' },
        { type: 'stop', stopReason: 'end_turn' },
      ]);

      const engine = new Engine({
        adapter: mockAdapter,
        trace,
        config: { model: 'test-model', maxOutputTokens: 1024 },
      });

      engine.registerTool({
        name: 'calculator',
        description: 'Calculate math',
        parameters: { type: 'object', properties: { expr: { type: 'string' } } },
        execute: async () => '42',
      });

      for await (const _event of engine.query({ prompt: 'test' })) {
        // consume
      }

      const call = mockAdapter.callLog[0];
      expect(call.tools).toHaveLength(1);
      expect(call.tools[0].name).toBe('calculator');
      expect(call.tools[0].description).toBe('Calculate math');

      const registry = new ToolRegistry();
      let disabledCalls = 0;
      registry.register(defineTool({
        name: 'EnabledTool',
        description: 'Enabled',
        parameters: { type: 'object', properties: {} },
        execute: async () => 'ok',
      }));
      registry.register(defineTool({
        name: 'DisabledTool',
        description: 'Disabled',
        parameters: { type: 'object', properties: {} },
        execute: async () => { disabledCalls += 1; return 'must not run'; },
      }));
      registry.register(defineTool({
        name: 'mcp__github__list_prs',
        mcpServer: 'github',
        description: 'GitHub',
        parameters: { type: 'object', properties: {} },
        execute: async () => 'github',
      }));
      registry.register(defineTool({
        name: 'mcp__slack__send_message',
        mcpServer: 'slack',
        description: 'Slack',
        parameters: { type: 'object', properties: {} },
        execute: async () => 'slack',
      }));
      mockAdapter.pushResponse([
        { type: 'tool_call', id: 'call-disabled', name: 'DisabledTool', input: {} },
        { type: 'stop', stopReason: 'tool_use' },
      ]);
      mockAdapter.pushResponse([
        { type: 'text_delta', text: 'handled' },
        { type: 'stop', stopReason: 'end_turn' },
      ]);
      const filteredEngine = new Engine({
        adapter: mockAdapter,
        trace,
        config: {
          model: 'test-model',
          maxOutputTokens: 1024,
          plugins: { tools: ['EnabledTool'], mcpServers: ['github'] },
        },
        toolRegistry: registry,
      });
      const events = [];
      for await (const event of filteredEngine.query({ prompt: 'try disabled tool' })) events.push(event);
      expect(mockAdapter.callLog.at(-2).tools.map(tool => tool.name)).toEqual([
        'EnabledTool',
        'mcp__github__list_prs',
      ]);
      expect(disabledCalls).toBe(0);
      expect(events.find(event => event.type === 'tool_end')).toMatchObject({
        name: 'DisabledTool',
        isError: true,
      });
    });

    it('should not pass tools when none are registered', async () => {
      mockAdapter.pushResponse([
        { type: 'text_delta', text: 'ok' },
        { type: 'stop', stopReason: 'end_turn' },
      ]);

      const engine = new Engine({
        adapter: mockAdapter,
        trace,
        config: { model: 'test-model', maxOutputTokens: 1024 },
      });

      for await (const _event of engine.query({ prompt: 'test' })) {
        // consume
      }

      const call = mockAdapter.callLog[0];
      expect(call.tools).toBeUndefined();
    });
  });

  describe('active scope in system prompt', () => {
    it('should render session id and session members without current member or group label', async () => {
      mockAdapter.pushResponse([
        { type: 'text_delta', text: 'ok' },
        { type: 'stop', stopReason: 'end_turn' },
      ]);

      const engine = new Engine({
        adapter: mockAdapter,
        trace,
        config: { model: 'test-model', maxOutputTokens: 1024, language: 'en' },
      });

      for await (const _event of engine.query({
        prompt: 'test',
        sessionId: 'session_active',
        sessionMembers: ['vp-omni', 'vp-martin', 'vp-linus'],
        sessionTopics: ['dream/segments', 'active_scope/rendering'],
        vpPersona: { vpId: 'vp-linus', displayName: 'Linus' },
      })) {
        // consume
      }

      const call = mockAdapter.callLog[0];
      expect(call.system).toContain('## Current session context');
      expect(call.system).toContain('Session ID: session_active');
      expect(call.system).not.toContain('session_member:');
      expect(call.system).not.toContain('session_members:');
      expect(call.system).not.toContain('session_topics:');
      expect(call.system).toContain('Session members: vp-omni, vp-martin, vp-linus');
      expect(call.system).toContain('Current focus: Dream memory segment extraction and organization; current session context prompt rendering');
      expect(call.system).not.toContain('group: session_active');
      expect(call.system).not.toContain('\nvp: vp-linus');
      expect(call.system).not.toContain('\nmembers: vp-omni');
    });

    it('loads session topics from memory topic scopes when not passed explicitly', async () => {
      const yeaftDir = mkdtempSync(join(tmpdir(), 'yeaft-engine-topics-'));
      try {
        mkdirSync(join(yeaftDir, 'memory', 'sessions', 'session_active', 'topic', 'dream', 'segments'), { recursive: true });
        writeFileSync(join(yeaftDir, 'memory', 'sessions', 'session_active', 'topic', 'dream', 'segments', 'memory.md'), 'segment memory');

        mockAdapter.pushResponse([
          { type: 'text_delta', text: 'ok' },
          { type: 'stop', stopReason: 'end_turn' },
        ]);

        const engine = new Engine({
          adapter: mockAdapter,
          trace,
          yeaftDir,
          config: { model: 'test-model', maxOutputTokens: 1024, language: 'en' },
        });

        for await (const _event of engine.query({
          prompt: 'test',
          sessionId: 'session_active',
          sessionMembers: ['vp-linus'],
          vpPersona: { vpId: 'vp-linus', displayName: 'Linus' },
        })) {
          // consume
        }

        const call = mockAdapter.callLog[0];
        expect(call.system).toContain('Current focus: Dream memory segment extraction and organization');
        expect(call.system).not.toContain('session_topics: dream/segments');
      } finally {
        rmSync(yeaftDir, { recursive: true, force: true });
      }
    });
  });

  describe('language in system prompt', () => {
    it('should use English system prompt by default', async () => {
      mockAdapter.pushResponse([
        { type: 'text_delta', text: 'ok' },
        { type: 'stop', stopReason: 'end_turn' },
      ]);

      const engine = new Engine({
        adapter: mockAdapter,
        trace,
        config: { model: 'test-model', maxOutputTokens: 1024 },
      });

      for await (const _event of engine.query({ prompt: 'test' })) {
        // consume
      }

      const call = mockAdapter.callLog[0];
      expect(call.system).toContain('Session Participant');
      expect(call.system).not.toContain('Yeaft — AI');
      expect(call.system).not.toContain('核心原则');
    });

    it('should use Chinese system prompt when language is zh', async () => {
      mockAdapter.pushResponse([
        { type: 'text_delta', text: 'ok' },
        { type: 'stop', stopReason: 'end_turn' },
      ]);

      const engine = new Engine({
        adapter: mockAdapter,
        trace,
        config: { model: 'test-model', maxOutputTokens: 1024, language: 'zh' },
      });

      for await (const _event of engine.query({ prompt: 'test' })) {
        // consume
      }

      const call = mockAdapter.callLog[0];
      expect(call.system).toContain('会话参与者');
      expect(call.system).not.toContain('Session Participant');
      expect(call.system).not.toContain('Yeaft — AI');
      expect(call.system).toContain('核心原则');
      expect(call.system).not.toContain('统一模式');
      expect(call.system).not.toContain('你是一个持续伴随的 AI 伙伴');
    });

    it('should include configured tools and dependency-aware TodoWrite guidance', async () => {
      mockAdapter.pushResponse([
        { type: 'text_delta', text: 'ok' },
        { type: 'stop', stopReason: 'end_turn' },
      ]);

      const engine = new Engine({
        adapter: mockAdapter,
        trace,
        config: { model: 'test-model', maxOutputTokens: 1024, language: 'zh' },
      });

      engine.registerTool({
        name: 'search',
        description: 'Search',
        parameters: {},
        execute: async () => 'results',
      });

      for await (const _event of engine.query({ prompt: 'test' })) {
        // consume
      }

      const call = mockAdapter.callLog[0];
      expect(call.system).toContain('可用工具：search');

      const enSystem = buildSystemPrompt({ language: 'en', toolNames: ['TodoWrite'] });
      const zhSystem = buildSystemPrompt({ language: 'zh', toolNames: ['TodoWrite'] });

      expect(enSystem).toContain('Avoid an intermediate `TodoWrite`-only model round');
      expect(enSystem).toMatch(/mark work completed only after\s+evidence/);
      expect(enSystem).toContain('A standalone `TodoWrite` remains valid');
      expect(zhSystem).toContain('不要让中间状态的 `TodoWrite` 单独占一个');
      expect(zhSystem).toContain('只有已有证据时才能把工作标记为完成');
      expect(zhSystem).toContain('`TodoWrite` 仍可单独调用');

      expect(todoWriteTool.description.en).toContain('BATCH WITH WORK');
      expect(todoWriteTool.description.en).toContain('same assistant response');
      expect(todoWriteTool.description.en).toContain('only after evidence');
      expect(todoWriteTool.description.en).toContain('standalone TodoWrite remains valid');
      expect(todoWriteTool.description.zh).toContain('和工作工具合批');
      expect(todoWriteTool.description.zh).toContain('同一个 assistant response');
      expect(todoWriteTool.description.zh).toContain('只有已有证据时');
      expect(todoWriteTool.description.zh).toContain('TodoWrite 仍可单独调用');

      const enPlan = await startPlanTool.execute(
        { topic: 'Batch plan setup with its first investigation' },
        { config: { language: 'en' }, vpPersona: {} },
      );
      const zhPlan = await startPlanTool.execute(
        { topic: '把计划建立和第一批调查工具合批' },
        { config: { language: 'zh-CN' }, vpPersona: {} },
      );

      expect(enPlan).toContain('emit `TodoWrite` and those independent tool calls in the same assistant response');
      expect(enPlan).toContain('Stop after the plan only when the first step must ask the user');
      expect(zhPlan).toContain('在同一个 assistant response 中发出 `TodoWrite`');
      expect(zhPlan).toContain('只有第一步必须询问用户时才在计划后停下');
    });
  });
});
