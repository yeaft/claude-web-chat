import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync, existsSync, linkSync, lstatSync, mkdirSync, rmSync, mkdtempSync, writeFileSync, readFileSync,
  readdirSync, symlinkSync, utimesSync,
} from 'fs';
import { delimiter, join } from 'path';
import { tmpdir } from 'os';
import { gzipSync } from 'node:zlib';
import { lstat as lstatAsync, readdir as readdirAsync, stat as statAsync } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { ActiveMemorySet } from '../../../agent/yeaft/memory/ams.js';
import { filterMemoryPromptTextForPrompt } from '../../../agent/yeaft/memory/prompt-cleanup.js';
import { Engine, buildResidentEntries, selectResidentTopicScopes } from '../../../agent/yeaft/engine.js';
import { flushAgentPerfTrace } from '../../../agent/yeaft/perf-trace.js';
import { ConversationStore } from '../../../agent/yeaft/conversation/persist.js';
import { AmsRegistry } from '../../../agent/yeaft/memory/ams-registry.js';
import { writeSummary } from '../../../agent/yeaft/memory/store.js';
import { NullTrace, DebugTrace } from '../../../agent/yeaft/debug-trace.js';
import { buildMcpFlattenedTools } from '../../../agent/yeaft/tools/mcp-tools.js';
import { buildSystemPrompt } from '../../../agent/yeaft/prompts.js';
import todoWriteTool from '../../../agent/yeaft/tools/todo-write.js';
import startPlanTool from '../../../agent/yeaft/tools/start-plan.js';
import {
  cleanupManagedCliRuntimePaths,
  ensureManagedCliTools,
  extractManagedCliBinary,
  managedCliBinDir,
  managedCliToolSpecs,
  prepareManagedCliToolEnvironment,
  prependManagedCliBinToPath,
  resolveManagedCliCommand,
  runAfterManagedCliRuntimeCleanup,
} from '../../../agent/yeaft/managed-cli.js';
import { createFullRegistry } from '../../../agent/yeaft/tools/index.js';
import { ToolRegistry } from '../../../agent/yeaft/tools/registry.js';
import { TaskManager } from '../../../agent/yeaft/tasks/manager.js';
import {
  createOutputCollector,
  listRipgrepCandidatePaths,
  nodeGrep,
  runRipgrep,
} from '../../../agent/yeaft/tools/grep.js';
import { nodeDiskUsage, runDust } from '../../../agent/yeaft/tools/disk-usage.js';
import { listFilesWithFd } from '../../../agent/yeaft/tools/glob.js';
import { runProcess } from '../../../agent/yeaft/tools/process-runner.js';
import bashTool, { createBashTool } from '../../../agent/yeaft/tools/bash.js';
import fileReadTool from '../../../agent/yeaft/tools/file-read.js';
import fileWriteTool from '../../../agent/yeaft/tools/file-write.js';
import {
  SearchBackendLimitError,
  SEARCH_SKIP_DIRS,
} from '../../../agent/yeaft/tools/search-paths.js';

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
  it('normalizes current and related Session summaries into separate resident sources', () => {
    const currentEntries = buildResidentEntries({
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

    expect(currentEntries).toEqual([
      { scope: 'sessions/s1', summary: 'Useful session fact.' },
      { scope: 'sessions/s1/topic/dream/recall', summary: 'Topic detail stays.' },
    ]);

    const relatedEntries = buildResidentEntries({
      sessionId: 's1',
      ownVpId: 'linus',
      summaries: {
        session: 'Current Session memory.',
        relatedSessions: [
          { sessionId: 's2', summary: 'Past Session experience: verify the remote tag target.' },
          { sessionId: 's1', summary: 'Duplicate current Session summary must not be re-added.' },
          { sessionId: 's3', summary: '<!-- dream-state -->\nold metadata\n<!-- /dream-state -->\nKeep this sibling lesson.' },
        ],
      },
    });

    expect(relatedEntries).toEqual([
      { scope: 'sessions/s1', summary: 'Current Session memory.' },
      { scope: 'sessions/s2', summary: 'Past Session experience: verify the remote tag target.' },
      { scope: 'sessions/s3', summary: 'Keep this sibling lesson.' },
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

  it('keeps onDemand memory when resident entries are over budget or only prefixes', () => {
    const overBudget = new ActiveMemorySet({
      budget: { total: 100, resident: 1, recent: 1, onDemand: 80 },
    });
    const repeated = 'Budget-sensitive Dream memory detail should remain available from onDemand when the resident copy is too large for the resident budget.';
    overBudget.setResident([{ scope: 'sessions/s1', summary: repeated }]);
    overBudget.setOnDemand([
      { id: 'od-1', scope: 'sessions/s1/topic/dream', body: repeated, kind: 'context', tags: [], sourceMessages: [] },
    ]);
    const overBudgetSnap = overBudget.snapshot();
    expect(overBudgetSnap.resident).toEqual([]);
    expect(overBudgetSnap.onDemand.map(seg => seg.body)).toEqual([repeated]);

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

    const related = filterMemoryPromptTextForPrompt(
      [
        '- Stable preference: user wants Dream memory topic labels compact.',
        '- Current Work Item #884: build billing dashboard export. Next step: merge PR #884.',
      ].join('\n'),
      '继续 billing dashboard export 的 work item',
    );
    expect(related).toBe([
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

        flushAgentPerfTrace({ yeaftDir });
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
    it('should register, list, and unregister tools', () => {
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
      engine.unregisterTool('search');
      expect(engine.toolNames).toEqual([]);
    });
  });

  describe('input validation', () => {
    it('should yield terminal errors and return a failed one-shot CLI status', async () => {
      const engine = new Engine({
        adapter: mockAdapter,
        trace,
        config: { model: 'test-model', maxOutputTokens: 1024 },
      });

      const events = [];
      for await (const event of engine.query({ prompt: '' })) {
        events.push(event);
      }

      expect(events).toHaveLength(2);
      expect(events[0].type).toBe('error');
      expect(events[0].error.message).toContain('prompt is required');
      expect(events[1]).toMatchObject({
        type: 'turn_end',
        turnNumber: 0,
        stopReason: 'error',
        terminal: true,
      });
      // Should NOT have called adapter
      expect(mockAdapter.callLog).toHaveLength(0);

      const cliDir = mkdtempSync(join(tmpdir(), 'yeaft-cli-error-'));
      const serverScript = join(cliDir, 'server.mjs');
      const portPath = join(cliDir, 'port');
      const requestLogPath = join(cliDir, 'provider-requests.jsonl');
      writeFileSync(requestLogPath, '');
      writeFileSync(serverScript, [
        "import { createServer } from 'node:http';",
        "import { appendFileSync, writeFileSync } from 'node:fs';",
        "const server = createServer((req, res) => {",
        "  let body = '';",
        "  req.on('data', chunk => { body += chunk; });",
        "  req.on('end', () => {",
        "    let latestUser = '';",
        "    try {",
        "      const parsed = JSON.parse(body);",
        "      const users = (parsed.messages || []).filter(message => message.role === 'user');",
        "      latestUser = JSON.stringify(users.at(-1)?.content || '');",
        "    } catch {}",
        "    appendFileSync(process.argv[3], `${latestUser}\\n`);",
        "    const delayMs = latestUser.includes('delayed') ? 1000 : 0;",
        "    setTimeout(() => {",
        "      if (latestUser.includes('must-write')) {",
        "        const marker = latestUser.match(/marker=([^\\\"\\s]+)/)?.[1] || '';",
        "        const toolInput = JSON.stringify({ file_path: marker, content: 'unexpected write' });",
        "        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });",
        "        res.end([",
        "          'event: message_start',",
        "          'data: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":1,\"output_tokens\":0}}}',",
        "          '',",
        "          'event: content_block_start',",
        "          'data: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"tool_use\",\"id\":\"write-after-exit\",\"name\":\"FileWrite\"}}',",
        "          '',",
        "          'event: content_block_delta',",
        "          `data: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: toolInput } })}` ,",
        "          '',",
        "          'event: content_block_stop',",
        "          'data: {\"type\":\"content_block_stop\",\"index\":0}',",
        "          '',",
        "          'event: message_delta',",
        "          'data: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"tool_use\"},\"usage\":{\"output_tokens\":1}}',",
        "          '',",
        "          'event: message_stop',",
        "          'data: {\"type\":\"message_stop\"}',",
        "          '',",
        "        ].join('\\n'));",
        "        return;",
        "      }",
        "      if (!latestUser.includes('succeed')) {",
        "        res.writeHead(401, { 'content-type': 'application/json' });",
        "        res.end(JSON.stringify({ error: { message: 'forced cli auth failure' } }));",
        "        return;",
        "      }",
        "      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });",
        "      res.end([",
        "      'event: message_start',",
        "      'data: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":1,\"output_tokens\":0}}}',",
        "      '',",
        "      'event: content_block_start',",
        "      'data: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}',",
        "      '',",
        "      'event: content_block_delta',",
        "      'data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"success\"}}',",
        "      '',",
        "      'event: content_block_stop',",
        "      'data: {\"type\":\"content_block_stop\",\"index\":0}',",
        "      '',",
        "      'event: message_delta',",
        "      'data: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"},\"usage\":{\"output_tokens\":1}}',",
        "      '',",
        "      'event: message_stop',",
        "      'data: {\"type\":\"message_stop\"}',",
        "      '',",
        "    ].join('\\n'));",
        "    }, delayMs);",
        "  });",
        "});",
        "server.listen(0, '127.0.0.1', () => writeFileSync(process.argv[2], String(server.address().port)));",
        "process.on('SIGTERM', () => server.close(() => process.exit(0)));",
      ].join('\n'));
      const cliServer = spawn(process.execPath, [serverScript, portPath, requestLogPath], { stdio: 'ignore' });
      let cliResult = null;
      try {
        for (let i = 0; i < 200 && !existsSync(portPath); i += 1) {
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        expect(existsSync(portPath)).toBe(true);
        const cliPort = readFileSync(portPath, 'utf8').trim();
        writeFileSync(join(cliDir, 'config.json'), JSON.stringify({
          providers: [{
            name: 'mock',
            baseUrl: `http://127.0.0.1:${cliPort}`,
            apiKey: 'test',
            protocol: 'anthropic',
            models: ['claude-test'],
          }],
          primaryModel: 'mock/claude-test',
          llmRetry: { maxRetries: 0, forbiddenRetryDelaysMs: [] },
        }));
        writeFileSync(join(cliDir, 'models_dev_cache.json'), '{}');
        cliResult = spawn(process.execPath, [
          join(process.cwd(), 'agent', 'yeaft', 'cli.js'),
          '--skip-mcp',
          '--skip-skills',
          'trigger auth failure',
        ], {
          cwd: process.cwd(),
          env: {
            ...process.env,
            YEAFT_DIR: cliDir,
            YEAFT_SKIP_MANAGED_CLI_INSTALLS: 'true',
          },
        });
        let cliStdout = '';
        let cliStderr = '';
        cliResult.stdout.on('data', chunk => { cliStdout += chunk; });
        cliResult.stderr.on('data', chunk => { cliStderr += chunk; });
        const cliExit = await new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            cliResult.kill('SIGKILL');
            reject(new Error(`CLI timed out; stdout=${cliStdout}; stderr=${cliStderr}`));
          }, 30_000);
          cliResult.once('error', reject);
          cliResult.once('close', (code, signal) => {
            clearTimeout(timer);
            resolve({ code, signal });
          });
        });
        expect(cliExit).toEqual({ code: 1, signal: null });
        expect(cliStderr).toContain('Error: LLM provider returned HTTP 401');

        const providerRequests = () => readFileSync(requestLogPath, 'utf8')
          .split('\n')
          .filter(Boolean)
          .map(line => JSON.parse(line));
        const runCli = (args, input) => {
          const child = spawn(process.execPath, [
            join(process.cwd(), 'agent', 'yeaft', 'cli.js'),
            '--skip-mcp',
            '--skip-skills',
            ...args,
          ], {
            cwd: process.cwd(),
            env: {
              ...process.env,
              YEAFT_DIR: cliDir,
              YEAFT_SKIP_MANAGED_CLI_INSTALLS: 'true',
            },
          });
          let stdout = '';
          let stderr = '';
          child.stdout.on('data', chunk => { stdout += chunk; });
          child.stderr.on('data', chunk => { stderr += chunk; });
          child.stdin.end(input);
          return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
              child.kill('SIGKILL');
              reject(new Error(`CLI timed out; stdout=${stdout}; stderr=${stderr}`));
            }, 30_000);
            child.once('error', reject);
            child.once('close', (code, signal) => {
              clearTimeout(timer);
              resolve({ code, signal, stdout, stderr });
            });
          });
        };
        const streamResult = await runCli([
          '--input-format', 'stream-json',
          '--output-format', 'stream-json',
        ], [
          JSON.stringify({ type: 'prompt', prompt: 'fail first' }),
          JSON.stringify({ type: 'prompt', prompt: 'succeed second' }),
          '',
        ].join('\n'));
        const streamEvents = streamResult.stdout.trim().split('\n').map(line => JSON.parse(line));
        expect(streamEvents.filter(event => event.type === 'result').map(event => event.is_error))
          .toEqual([true, false]);
        expect(streamResult).toMatchObject({ code: 1, signal: null });

        const defaultExitMarker = join(cliDir, 'default-exit-marker');
        const requestsBeforeImmediateExit = providerRequests().length;
        const immediateExit = await runCli(
          ['-i'],
          `/exit\nmust-write marker=${defaultExitMarker}\n`,
        );
        expect(immediateExit).toMatchObject({ code: 0, signal: null });
        expect(immediateExit.stdout).toContain('Bye!');
        expect(existsSync(defaultExitMarker)).toBe(false);
        expect(providerRequests()).toHaveLength(requestsBeforeImmediateExit);

        const delayedExitMarker = join(cliDir, 'default-delayed-exit-marker');
        const requestsBeforeDefaultSuccess = providerRequests().length;
        const defaultSuccessStartedAt = Date.now();
        const defaultSuccess = await runCli(
          ['-i'],
          `delayed succeed\n/exit\nmust-write marker=${delayedExitMarker}\n`,
        );
        expect(Date.now() - defaultSuccessStartedAt).toBeGreaterThanOrEqual(900);
        expect(defaultSuccess.stdout).toContain('success');
        expect(defaultSuccess.stderr).not.toContain('ERR_USE_AFTER_CLOSE');
        expect(defaultSuccess).toMatchObject({ code: 0, signal: null });
        expect(existsSync(delayedExitMarker)).toBe(false);
        const defaultSuccessRequests = providerRequests().slice(requestsBeforeDefaultSuccess);
        expect(defaultSuccessRequests.some(request => request.includes('delayed succeed'))).toBe(true);
        expect(defaultSuccessRequests.some(request => request.includes('must-write'))).toBe(false);

        const defaultFailureStartedAt = Date.now();
        const defaultFailure = await runCli(['-i'], 'delayed fail\n/exit\n');
        expect(Date.now() - defaultFailureStartedAt).toBeGreaterThanOrEqual(900);
        expect(defaultFailure.stderr).toContain('Error:');
        expect(defaultFailure.stderr).not.toContain('ERR_USE_AFTER_CLOSE');
        expect(defaultFailure).toMatchObject({ code: 1, signal: null });

        const sessionId = 'session_cli_exit_status';
        const sessionDir = join(cliDir, 'sessions', sessionId);
        mkdirSync(sessionDir, { recursive: true });
        writeFileSync(join(sessionDir, 'session.json'), JSON.stringify({
          id: sessionId,
          name: 'CLI exit status',
          roster: ['linus'],
          defaultVpId: 'linus',
          announcement: '',
          workDir: '',
          createdAt: new Date().toISOString(),
        }));
        const sessionExitMarker = join(cliDir, 'session-delayed-exit-marker');
        const requestsBeforeSessionSuccess = providerRequests().length;
        const sessionSuccessStartedAt = Date.now();
        const sessionSuccess = await runCli(
          ['-i', '--session-id', sessionId],
          `delayed succeed\n/exit\nmust-write marker=${sessionExitMarker}\n`,
        );
        expect(Date.now() - sessionSuccessStartedAt).toBeGreaterThanOrEqual(900);
        expect(sessionSuccess.stdout).toContain('success');
        expect(sessionSuccess.stderr).not.toContain('ERR_USE_AFTER_CLOSE');
        expect(sessionSuccess).toMatchObject({ code: 0, signal: null });
        expect(existsSync(sessionExitMarker)).toBe(false);
        const sessionSuccessRequests = providerRequests().slice(requestsBeforeSessionSuccess);
        expect(sessionSuccessRequests.some(request => request.includes('delayed succeed'))).toBe(true);
        expect(sessionSuccessRequests.some(request => request.includes('must-write'))).toBe(false);

        const sessionFailureStartedAt = Date.now();
        const sessionFailure = await runCli(['-i', '--session-id', sessionId], 'delayed fail\n/exit\n');
        expect(Date.now() - sessionFailureStartedAt).toBeGreaterThanOrEqual(900);
        expect(sessionFailure.stderr).toContain('Error:');
        expect(sessionFailure.stderr).not.toContain('ERR_USE_AFTER_CLOSE');
        expect(sessionFailure).toMatchObject({ code: 1, signal: null });
      } finally {
        cliServer.kill('SIGTERM');
        await new Promise(resolve => cliServer.once('close', resolve));
        rmSync(cliDir, { recursive: true, force: true });
      }
    }, 30_000);

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

      expect(events).toHaveLength(2);
      expect(events[0].type).toBe('error');
      expect(events[1]).toMatchObject({ type: 'turn_end', stopReason: 'error', terminal: true });
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
      expect(turnEnd).toMatchObject({
        stopReason: 'end_turn',
        turnNumber: 1,
        terminal: true,
      });

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
      expect(system).toContain('## Relevant Context');
      expect(system).toContain('### Relevant Memory');
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

      const debugYeaftDir = mkdtempSync(join(tmpdir(), 'yeaft-engine-memory-debug-'));
      try {
        const memoryRows = [
          {
            id: 'billing-work-item',
            scope: 'sessions/g1',
            kind: 'context',
            tags: ['billing'],
            body: 'Work Item #884: billing dashboard export is in progress and awaiting review.',
            rank: 0,
          },
          ...Array.from({ length: 9 }, (_, index) => ({
            id: `dream-relevance-${index + 1}`,
            scope: 'sessions/g1',
            kind: 'context',
            tags: ['dream', 'memory'],
            body: `Dream relevance loaded memory item ${index + 1}.`,
            rank: index + 1,
          })),
        ];
        const memoryIndex = {
          search({ scopeFilter }) {
            return memoryRows
              .filter(row => scopeFilter.includes(row.scope))
              .map(row => ({
                ...row,
                sourceMessages: [],
                createdAt: '2026-07-01T00:00:00.000Z',
                updatedAt: '2026-07-01T00:00:00.000Z',
              }));
          },
        };
        mockAdapter.pushResponse([
          { type: 'text_delta', text: 'ok' },
          { type: 'stop', stopReason: 'end_turn' },
        ]);

        const debugEngine = new Engine({
          adapter: mockAdapter,
          trace,
          yeaftDir: debugYeaftDir,
          sessionId: 'g1',
          config: { model: 'claude-test', maxOutputTokens: 2048, language: 'en' },
          memoryIndex,
          amsRegistry: new AmsRegistry({ yeaftDir: debugYeaftDir, config: {} }),
        });

        const debugEvents = [];
        for await (const event of debugEngine.query({
          prompt: 'optimize Dream memory relevance',
          sessionId: 'g1',
          vpPersona: { vpId: 'vp1', name: 'VP One' },
        })) {
          debugEvents.push(event);
        }

        const debugSystem = mockAdapter.callLog.at(-1).system;
        expect(debugSystem).toContain('Dream relevance loaded memory item 1.');
        expect(debugSystem).toContain('Dream relevance loaded memory item 7.');
        expect(debugSystem).not.toContain('billing dashboard export');
        expect(debugSystem).not.toContain('Dream relevance loaded memory item 8.');

        const memoryUsed = debugEvents.find(e => e.type === 'memory_used');
        expect(memoryUsed).toBeTruthy();
        expect(memoryUsed.meta).toMatchObject({ recallLimit: 8, recallCandidates: 10 });
        expect(memoryUsed.loaded).toHaveLength(7);
        expect(memoryUsed.loaded[0]).toMatchObject({
          id: 'dream-relevance-1',
          layer: 'onDemand',
          scope: 'sessions/g1',
          label: 'session',
          body: 'Dream relevance loaded memory item 1.',
        });
        expect(memoryUsed.loaded[0].score).toEqual(expect.any(Number));
        expect(memoryUsed.loaded.map(entry => entry.body).join('\n')).not.toContain('billing dashboard export');
      } finally {
        rmSync(debugYeaftDir, { recursive: true, force: true });
      }

      mockAdapter.callLog.length = 0;
      await verifyReadableContextWithoutPersistentAms();
    });

    async function verifyReadableContextWithoutPersistentAms() {
      const yeaftDir = mkdtempSync(join(tmpdir(), 'yeaft-engine-readable-context-'));
      try {
        await writeSummary(
          { kind: 'session', id: 'sibling-session' },
          'Reusable release experience: verify origin/main and the remote tag target before publishing.',
          { root: join(yeaftDir, 'memory'), language: 'zh' },
        );
        const memoryIndex = {
          search({ scopeFilter }) {
            if (!scopeFilter.includes('sessions/current-session')) return [];
            return [{
              id: 'timeout-memory',
              scope: 'sessions/current-session',
              kind: 'context',
              tags: ['timeout'],
              sourceMessages: [],
              body: 'Timeout cleanup failures must return a tool result so the Engine can continue.',
              rank: -1,
              createdAt: '2026-08-01T00:00:00.000Z',
              updatedAt: '2026-08-01T00:00:00.000Z',
            }];
          },
        };
        const taskManager = new TaskManager({ yeaftDir });
        const task = taskManager.startTask({
          sessionId: 'current-session',
          ownerVpId: 'linus',
          kind: 'sub_agent',
          title: 'Review timeout recovery and verify Engine continuation',
          runtime: { name: 'timeout-reviewer' },
          logPath: '/private/sub-agent/events.jsonl',
        });
        taskManager.store.appendLog('current-session', task.id, '{"type":"sub_agent_status","status":"running"}\n');
        taskManager.refreshTaskLog('current-session', task.id);
        mockAdapter.pushResponse([
          { type: 'text_delta', text: 'ok' },
          { type: 'stop', stopReason: 'end_turn' },
        ]);
        const engine = new Engine({
          adapter: mockAdapter,
          trace,
          yeaftDir,
          sessionId: 'current-session',
          config: { model: 'claude-test', maxOutputTokens: 2048, language: 'zh' },
          memoryIndex,
          taskManager,
        });

        const events = [];
        for await (const event of engine.query({
          prompt: '检查 timeout cleanup failure',
          sessionId: 'current-session',
          projectSessionIds: ['sibling-session'],
          vpPersona: { vpId: 'linus', name: 'Linus' },
        })) {
          events.push(event);
        }

        const system = mockAdapter.callLog.at(-1).system;
        expect(system).toContain('## 相关上下文');
        expect(system).toContain('### 过去 Session 的经验总结');
        expect(system).toContain('**sibling-session**: Reusable release experience');
        expect(system).toContain('### 相关记忆');
        expect(system).toContain('Timeout cleanup failures must return a tool result');
        expect(system).toContain('## 可能相关的任务');
        expect(system).toContain('- 子 Agent timeout-reviewer (子 Agent，运行中)');
        expect(system).not.toContain('Review timeout recovery and verify Engine continuation');
        expect(system).not.toContain('<active_tasks>');
        expect(system).not.toContain('/private/sub-agent/events.jsonl');
        expect(system).not.toContain('sub_agent_status');
        expect(events.find(event => event.type === 'memory_used')?.loaded).toEqual(expect.arrayContaining([
          expect.objectContaining({ category: 'experience', scope: 'sessions/sibling-session' }),
          expect.objectContaining({ layer: 'onDemand', id: 'timeout-memory' }),
        ]));
        expect(mockAdapter.callLog).toHaveLength(1);
        expect(existsSync(join(yeaftDir, 'memory', 'sessions', 'current-session', 'ams.json'))).toBe(false);
      } finally {
        rmSync(yeaftDir, { recursive: true, force: true });
      }
    }

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
      for await (const event of engine.query({
        prompt: 'test',
        projectLabel: 'Yeaft (project-123)',
        projectInstruction: 'Run the shared Project verification before release.',
      })) {
        events.push(event);
      }

      expect(mockAdapter.callLog).toHaveLength(1);
      const call = mockAdapter.callLog[0];
      expect(call.model).toBe('claude-test');
      expect(call.system).toContain('Session Participant');
      expect(call.system).not.toContain('Yeaft — AI');
      expect(call.system).toContain('work');
      expect(call.system).toContain('[Project Instruction]');
      expect(call.system).toContain('The current Session belongs to Project Yeaft (project-123). The unified instruction for this Project is:');
      expect(call.system).toContain('Run the shared Project verification before release.');
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

      // A result-producing task can outlive the visible turn. If its terminal
      // event is lost, the parent must eventually release same-turn ownership
      // and finish; the task keeps running and its later completion can use the
      // bridge's existing rescue-turn path.
      const stalledTaskAdapter = new MockAdapter();
      stalledTaskAdapter.pushResponse([
        { type: 'tool_call', id: 'call_stalled_task', name: 'launch_stalled_task', input: {} },
        { type: 'stop', stopReason: 'tool_use' },
      ]);
      stalledTaskAdapter.pushResponse([
        { type: 'text_delta', text: 'The delegated task is still running.' },
        { type: 'stop', stopReason: 'end_turn' },
      ]);
      const stalledTaskEngine = new Engine({
        adapter: stalledTaskAdapter,
        trace,
        config: {
          model: 'test-model',
          maxOutputTokens: 1024,
          asyncTaskWaitTimeoutMs: 20,
        },
      });
      const deferredTasks = [];
      stalledTaskEngine.setAsyncTaskCoordinator({
        onDeferred(taskId) { deferredTasks.push(taskId); },
      });
      stalledTaskEngine.registerTool({
        name: 'launch_stalled_task',
        description: 'launch a task whose terminal event never arrives',
        parameters: { type: 'object', properties: {} },
        execute: async (_input, ctx) => {
          ctx.registerAsyncTask('task_stalled');
          return 'task started';
        },
      });

      const stalledEvents = [];
      await Promise.race([
        (async () => {
          for await (const event of stalledTaskEngine.query({ prompt: 'delegate this work' })) {
            stalledEvents.push(event);
          }
        })(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('async task wait stayed pinned')), 500)),
      ]);

      expect(stalledEvents).toContainEqual(expect.objectContaining({
        type: 'async_task_wait_end',
        timedOut: true,
        deferredTaskIds: ['task_stalled'],
      }));
      expect(stalledEvents).toContainEqual(expect.objectContaining({
        type: 'turn_end',
        stopReason: 'end_turn',
        terminal: true,
      }));
      expect(stalledEvents.at(-1)).toMatchObject({ type: 'turn_close' });
      expect(stalledTaskEngine.hasPendingAsyncTasks()).toBe(false);
      expect(stalledTaskEngine.notifyAsyncTaskCompleted('task_stalled', 'late result')).toBe(false);
      expect(deferredTasks).toEqual(['task_stalled']);

      // Long-running child work is not itself a stall. TaskManager activity
      // refreshes the silence deadline; a completion after the first timeout
      // window must still resume in the same turn.
      const activeTaskAdapter = new MockAdapter();
      activeTaskAdapter.pushResponse([
        { type: 'tool_call', id: 'call_active_task', name: 'launch_active_task', input: {} },
        { type: 'stop', stopReason: 'tool_use' },
      ]);
      activeTaskAdapter.pushResponse([
        { type: 'text_delta', text: 'The delegated result was consumed.' },
        { type: 'stop', stopReason: 'end_turn' },
      ]);
      const activeTaskEngine = new Engine({
        adapter: activeTaskAdapter,
        trace,
        config: { model: 'test-model', maxOutputTokens: 1024, asyncTaskWaitTimeoutMs: 20 },
        taskManager: {
          getTask() {
            return { status: 'running', updatedAt: new Date().toISOString() };
          },
          renderActiveTasksForPrompt() { return ''; },
        },
        sessionId: 'session-active-task',
      });
      activeTaskEngine.registerTool({
        name: 'launch_active_task',
        description: 'launch a task that keeps reporting activity',
        parameters: { type: 'object', properties: {} },
        execute: async (_input, ctx) => {
          ctx.registerAsyncTask('task_active');
          return 'task started';
        },
      });

      const activeEvents = [];
      let activeCompletionAccepted = null;
      for await (const event of activeTaskEngine.query({ prompt: 'delegate active work' })) {
        activeEvents.push(event);
        if (event.type === 'async_task_wait_start') {
          setTimeout(() => {
            activeCompletionAccepted = activeTaskEngine.notifyAsyncTaskCompleted(
              'task_active',
              '<task-result id="task_active">done</task-result>',
            );
          }, 45);
        }
      }

      expect(activeCompletionAccepted).toBe(true);
      expect(activeEvents.find(event => event.type === 'async_task_wait_end')).toMatchObject({
        timedOut: false,
        deferredTaskIds: [],
      });
      expect(activeTaskAdapter.callLog).toHaveLength(3);

      // Multiple owned tasks use independent silence leases. Expiring one stale
      // child must not evict an active sibling; the active result remains in the
      // same parent turn while only the stale task is deferred.
      const mixedTaskAdapter = new MockAdapter();
      mixedTaskAdapter.pushResponse([
        { type: 'tool_call', id: 'call_mixed_tasks', name: 'launch_mixed_tasks', input: {} },
        { type: 'stop', stopReason: 'tool_use' },
      ]);
      mixedTaskAdapter.pushResponse([
        { type: 'text_delta', text: 'Waiting for the active task.' },
        { type: 'stop', stopReason: 'end_turn' },
      ]);
      mixedTaskAdapter.pushResponse([
        { type: 'text_delta', text: 'The active task result was consumed.' },
        { type: 'stop', stopReason: 'end_turn' },
      ]);
      const mixedTaskEngine = new Engine({
        adapter: mixedTaskAdapter,
        trace,
        config: { model: 'test-model', maxOutputTokens: 1024, asyncTaskWaitTimeoutMs: 20 },
        taskManager: {
          getTask(_sessionId, taskId) {
            return taskId === 'task_stale_sibling'
              ? { status: 'running', updatedAt: new Date(0).toISOString() }
              : { status: 'running', updatedAt: new Date().toISOString() };
          },
          renderActiveTasksForPrompt() { return ''; },
        },
        sessionId: 'session-mixed-tasks',
      });
      const mixedDeferredTasks = [];
      mixedTaskEngine.setAsyncTaskCoordinator({
        onDeferred(taskId) { mixedDeferredTasks.push(taskId); },
      });
      mixedTaskEngine.registerTool({
        name: 'launch_mixed_tasks',
        description: 'launch one stale task and one active task',
        parameters: { type: 'object', properties: {} },
        execute: async (_input, ctx) => {
          ctx.registerAsyncTask('task_stale_sibling');
          ctx.registerAsyncTask('task_active_sibling');
          return 'tasks started';
        },
      });

      const mixedEvents = [];
      let mixedActiveAccepted = null;
      for await (const event of mixedTaskEngine.query({ prompt: 'delegate mixed work' })) {
        mixedEvents.push(event);
        if (event.type === 'async_task_wait_start') {
          setTimeout(() => {
            mixedActiveAccepted = mixedTaskEngine.notifyAsyncTaskCompleted(
              'task_active_sibling',
              '<task-result id="task_active_sibling">done</task-result>',
            );
          }, 45);
        }
      }

      expect(mixedDeferredTasks).toEqual(['task_stale_sibling']);
      expect(mixedActiveAccepted).toBe(true);
      expect(mixedTaskEngine.notifyAsyncTaskCompleted('task_stale_sibling', 'late')).toBe(false);
      expect(mixedEvents.find(event => event.type === 'async_task_wait_end')).toMatchObject({
        timedOut: true,
        deferredTaskIds: ['task_stale_sibling'],
        remainingTaskIds: [],
      });
      expect(mixedTaskAdapter.callLog).toHaveLength(3);
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
      expect(lastTurnEnd).toMatchObject({ stopReason: 'end_turn', terminal: true });

      // A timed-out side-effecting tool cannot be replayed safely because its
      // underlying promise may still be running. It must nevertheless produce
      // a diagnostic terminal boundary instead of escaping query() after the
      // tool_end event and leaving the VP half-open.
      const timeoutAdapter = new MockAdapter();
      timeoutAdapter.pushResponse([
        { type: 'tool_call', id: 'call_timeout', name: 'slow_side_effect', input: {} },
        { type: 'stop', stopReason: 'tool_use' },
      ]);
      const timeoutRegistry = new ToolRegistry();
      timeoutRegistry.register({
        name: 'slow_side_effect',
        description: 'Never settles',
        parameters: {},
        timeoutMs: 5,
        sideEffectScope: 'external',
        isReadOnly: () => false,
        execute: async () => new Promise(() => {}),
      });
      const timeoutEngine = new Engine({
        adapter: timeoutAdapter,
        trace,
        config: { model: 'test-model', maxOutputTokens: 1024 },
        toolRegistry: timeoutRegistry,
      });
      const timeoutEvents = [];
      for await (const event of timeoutEngine.query({ prompt: 'run the slow tool' })) {
        timeoutEvents.push(event);
      }
      expect(timeoutEvents.find(event => event.type === 'tool_end')).toMatchObject({
        id: 'call_timeout',
        isError: true,
      });
      expect(timeoutEvents.find(event => event.type === 'error')).toMatchObject({
        retryable: false,
        error: expect.objectContaining({ name: 'ToolExecutionTimeoutError' }),
      });
      expect(timeoutEvents.filter(event => event.type === 'turn_end').at(-1)).toMatchObject({
        turnNumber: 1,
        stopReason: 'error',
        terminal: true,
        detail: expect.objectContaining({ errorName: 'ToolExecutionTimeoutError' }),
      });

      expect(bashTool.timeoutMs).toBe(0);

      const systemdChild = new EventEmitter();
      systemdChild.pid = 4344;
      systemdChild.stdout = new PassThrough();
      systemdChild.stderr = new PassThrough();
      systemdChild.kill = () => true;
      const systemdCalls = [];
      const slowSystemctl = (_command, args) => {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
        systemdCalls.push(args.includes('kill')
          ? args.find(arg => arg.startsWith('--signal='))
          : 'show');
        return args.includes('show')
          ? { status: 0, stdout: 'active\n' }
          : { status: 0 };
      };
      const ownedTimeoutBash = createBashTool({
        runProcessImpl: (_command, _args, options) => {
          expect(options.timeoutMs).toBe(600_000);
          return runProcess('systemd-run', [], {
            ...options,
            timeoutMs: 1,
            killGraceMs: 1,
            forceSettleMs: 5,
            platform: 'linux',
            systemdScope: {
              unit: 'yeaft-test.scope',
              systemctlPath: '/usr/bin/systemctl',
              env: {},
            },
            spawnProcess: () => systemdChild,
            spawnProcessSync: slowSystemctl,
          });
        },
      });
      const ownedTimeoutRegistry = new ToolRegistry();
      ownedTimeoutRegistry.register(ownedTimeoutBash);
      const ownedTimeoutResult = await ownedTimeoutRegistry.execute('Bash', {
        command: 'sleep 600',
        timeout_ms: 600_000,
      }, {
        cwd: process.cwd(),
        runtimePlatform: {
          platform: 'linux',
          isLinux: true,
          isWindows: false,
          shellFamily: 'posix',
          defaultShell: '/bin/sh',
        },
      });
      expect(ownedTimeoutResult).toContain('Exit code: 124');
      expect(ownedTimeoutResult).toContain('Process tree did not exit within 5ms after SIGKILL: systemd-run');
      expect(systemdCalls).toContain('--signal=SIGTERM');
      expect(systemdCalls).toContain('--signal=SIGKILL');
      expect(systemdCalls).toContain('show');
      expect(systemdChild.listenerCount('close')).toBe(0);
      expect(systemdChild.listenerCount('error')).toBe(0);
      expect(systemdChild.stdout.listenerCount('data')).toBe(0);
      expect(systemdChild.stderr.listenerCount('data')).toBe(0);

      const barrierRequests = [];
      const confirmedTimeoutOutput = await createBashTool({
        runProcessImpl: async () => ({
          stdout: '', stderr: '', code: 124, timedOut: true, terminationError: null,
        }),
      }).execute({ command: 'sleep 600', timeout_ms: 1000 }, {
        cwd: process.cwd(),
        requestToolBatchBarrier: reason => barrierRequests.push(reason),
      });
      const ordinaryFailureOutput = await createBashTool({
        runProcessImpl: async () => ({
          stdout: '', stderr: 'failed', code: 2, timedOut: false, terminationError: null,
        }),
      }).execute({ command: 'exit 2' }, {
        cwd: process.cwd(),
        requestToolBatchBarrier: reason => barrierRequests.push(reason),
      });
      expect(confirmedTimeoutOutput).toContain('Exit code: 124');
      expect(ordinaryFailureOutput).toContain('Exit code: 2');
      expect(barrierRequests).toEqual([
        expect.objectContaining({ kind: 'owned_timeout' }),
      ]);

      const terminationChild = new EventEmitter();
      terminationChild.pid = 4444;
      terminationChild.stdout = new PassThrough();
      terminationChild.stderr = new PassThrough();
      terminationChild.kill = () => true;
      const terminationCalls = [];
      const recoveringBash = createBashTool({
        runProcessImpl: (_command, _args, options) => {
          terminationCalls.push({ signal: options.signal, timeoutMs: options.timeoutMs });
          return runProcess('powershell.exe', [], {
            ...options,
            timeoutMs: 1,
            forceSettleMs: 5,
            platform: 'win32',
            systemdScope: null,
            spawnProcess: () => terminationChild,
            spawnProcessSync: () => ({ status: 0 }),
          });
        },
      });
      const startedTasks = [];
      const bashTaskManager = {
        renderActiveTasksForPrompt: () => '',
        startShellTask: input => {
          startedTasks.push(input);
          return { id: 'task_after_timeout', status: 'running', log: { path: '/tmp/task.log' } };
        },
      };
      const recoveryAdapter = new MockAdapter();
      recoveryAdapter.pushResponse([
        {
          type: 'tool_call',
          id: 'call_unconfirmed_timeout',
          name: 'Bash',
          input: { command: 'Start-Sleep -Seconds 30', timeout_ms: 1000 },
        },
        { type: 'stop', stopReason: 'tool_use' },
      ]);
      recoveryAdapter.pushResponse([
        {
          type: 'tool_call',
          id: 'call_background_after_timeout',
          name: 'Bash',
          input: {
            command: 'Start-Sleep -Seconds 30',
            timeout_ms: 1000,
            background: true,
            taskTitle: 'continue in background',
          },
        },
        { type: 'stop', stopReason: 'tool_use' },
      ]);
      recoveryAdapter.pushResponse([
        { type: 'text_delta', text: 'The foreground command timed out, so I moved it to a background task.' },
        { type: 'stop', stopReason: 'end_turn' },
      ]);
      const recoveryRegistry = new ToolRegistry();
      recoveryRegistry.register(recoveringBash);
      const recoveryEngine = new Engine({
        adapter: recoveryAdapter,
        trace,
        config: { model: 'test-model', maxOutputTokens: 1024 },
        toolRegistry: recoveryRegistry,
        taskManager: bashTaskManager,
      });
      const recoveryEvents = [];
      for await (const event of recoveryEngine.query({ prompt: 'run the long command' })) {
        recoveryEvents.push(event);
      }
      expect(terminationCalls).toHaveLength(1);
      expect(terminationCalls[0]).toMatchObject({ timeoutMs: 1000 });
      expect(startedTasks).toHaveLength(1);
      expect(startedTasks[0]).toMatchObject({
        command: 'Start-Sleep -Seconds 30',
        title: 'continue in background',
      });
      expect(recoveryAdapter.callLog).toHaveLength(3);
      const timeoutToolMessage = recoveryAdapter.callLog[1].messages
        .find(message => message.toolCallId === 'call_unconfirmed_timeout');
      expect(timeoutToolMessage).toMatchObject({ isError: false });
      expect(timeoutToolMessage.content).toContain('Exit code: 124');
      expect(timeoutToolMessage.content).toContain('Process tree did not exit within 5ms after SIGKILL: powershell.exe');
      expect(timeoutToolMessage.content).toContain('The command may still be running.');
      expect(timeoutToolMessage.content).toContain('use background=true');
      expect(recoveryAdapter.callLog[2].messages
        .find(message => message.toolCallId === 'call_background_after_timeout')).toMatchObject({
          isError: false,
          content: expect.stringContaining('Started background task task_after_timeout'),
        });
      expect(recoveryEvents.filter(event => event.type === 'tool_end')).toHaveLength(2);
      expect(recoveryEvents.find(event => event.type === 'error')).toBeUndefined();
      expect(recoveryEvents.filter(event => event.type === 'turn_end').at(-1)).toMatchObject({
        stopReason: 'end_turn',
        terminal: true,
      });

      const batchBarrierRoot = mkdtempSync(join(tmpdir(), 'yeaft-bash-batch-barrier-'));
      const batchBarrierMarker = join(batchBarrierRoot, 'must-not-write.txt');
      try {
        const batchBarrierChild = new EventEmitter();
        batchBarrierChild.pid = 4544;
        batchBarrierChild.stdout = new PassThrough();
        batchBarrierChild.stderr = new PassThrough();
        batchBarrierChild.kill = () => true;
        const batchBarrierBash = createBashTool({
          runProcessImpl: (_command, _args, options) => runProcess('powershell.exe', [], {
            ...options,
            timeoutMs: 1,
            forceSettleMs: 5,
            platform: 'win32',
            systemdScope: null,
            spawnProcess: () => batchBarrierChild,
            spawnProcessSync: () => ({ status: 0 }),
          }),
        });
        const batchBarrierAdapter = new MockAdapter();
        batchBarrierAdapter.pushResponse([
          {
            type: 'tool_call',
            id: 'call_batch_timeout',
            name: 'Bash',
            input: { command: 'Start-Sleep -Seconds 30', timeout_ms: 1000 },
          },
          {
            type: 'tool_call',
            id: 'call_write_after_timeout',
            name: 'FileWrite',
            input: { file_path: batchBarrierMarker, content: 'must not be written' },
          },
          {
            type: 'tool_call',
            id: 'call_second_write_after_timeout',
            name: 'FileWrite',
            input: { file_path: `${batchBarrierMarker}.second`, content: 'must not be written either' },
          },
          { type: 'stop', stopReason: 'tool_use' },
        ]);
        batchBarrierAdapter.pushResponse([
          { type: 'text_delta', text: 'The write was skipped, so I will inspect the timed-out command first.' },
          { type: 'stop', stopReason: 'end_turn' },
        ]);
        const batchBarrierRegistry = new ToolRegistry();
        batchBarrierRegistry.register(batchBarrierBash);
        batchBarrierRegistry.register(fileWriteTool);
        const batchBarrierEngine = new Engine({
          adapter: batchBarrierAdapter,
          trace,
          config: { model: 'test-model', maxOutputTokens: 1024 },
          toolRegistry: batchBarrierRegistry,
        });
        const batchBarrierEvents = [];
        for await (const event of batchBarrierEngine.query({ prompt: 'run then write' })) {
          batchBarrierEvents.push(event);
        }

        expect(existsSync(batchBarrierMarker)).toBe(false);
        expect(existsSync(`${batchBarrierMarker}.second`)).toBe(false);
        expect(batchBarrierAdapter.callLog).toHaveLength(2);
        const barrierProviderMessages = batchBarrierAdapter.callLog[1].messages;
        expect(barrierProviderMessages
          .find(message => message.toolCallId === 'call_batch_timeout')).toMatchObject({
            isError: false,
            content: expect.stringContaining('The command may still be running.'),
          });
        expect(barrierProviderMessages
          .find(message => message.toolCallId === 'call_write_after_timeout')).toMatchObject({
            isError: true,
            content: expect.stringContaining('This tool was not executed.'),
          });
        expect(barrierProviderMessages
          .find(message => message.toolCallId === 'call_second_write_after_timeout')).toMatchObject({
            isError: true,
            content: expect.stringContaining('This tool was not executed.'),
          });
        expect(barrierProviderMessages.filter(message => message.toolCallId).map(message => message.toolCallId))
          .toEqual([
            'call_batch_timeout',
            'call_write_after_timeout',
            'call_second_write_after_timeout',
          ]);
        expect(batchBarrierEvents.filter(event => event.type === 'tool_start').map(event => event.name))
          .toEqual(['Bash']);
        expect(batchBarrierEvents.filter(event => event.type === 'tool_end')).toEqual([
          expect.objectContaining({ id: 'call_batch_timeout', name: 'Bash', isError: false }),
          expect.objectContaining({
            id: 'call_write_after_timeout',
            name: 'FileWrite',
            isError: true,
            skipped: true,
          }),
          expect.objectContaining({
            id: 'call_second_write_after_timeout',
            name: 'FileWrite',
            isError: true,
            skipped: true,
          }),
        ]);
        expect(batchBarrierEvents.filter(event => event.type === 'turn_end').at(-1)).toMatchObject({
          stopReason: 'end_turn',
          terminal: true,
        });
      } finally {
        rmSync(batchBarrierRoot, { recursive: true, force: true });
      }

      if (process.platform === 'linux') {
        const canary = `pr1483-${Date.now()}-${process.pid}`;
        const probeRoot = mkdtempSync(join(tmpdir(), 'yeaft-systemd-payload-'));
        const bashModuleUrl = new URL('../../../agent/yeaft/tools/bash.js', import.meta.url).href;
        const probe = spawn(process.execPath, [
          '--input-type=module',
          '-e',
          `import bashTool from ${JSON.stringify(bashModuleUrl)}; await bashTool.execute({ command: 'sleep 3' }, { cwd: ${JSON.stringify(probeRoot)} });`,
        ], {
          cwd: process.cwd(),
          env: {
            ...process.env,
            YEAFT_DISABLE_SYSTEMD_SCOPE: '1',
            PR1483_CANARY: canary,
          },
          stdio: ['ignore', 'ignore', 'pipe'],
        });
        let probeStderr = '';
        probe.stderr.on('data', chunk => { probeStderr += chunk; });
        try {
          let systemdRunCmdline = '';
          const deadline = Date.now() + 2000;
          while (!systemdRunCmdline && Date.now() < deadline) {
            let childPids = [];
            try {
              const children = readFileSync(`/proc/${probe.pid}/task/${probe.pid}/children`, 'utf8').trim();
              childPids = children ? children.split(/\s+/).map(Number) : [];
            } catch {}
            for (const childPid of childPids) {
              try {
                const cmdline = readFileSync(`/proc/${childPid}/cmdline`).toString('utf8').replace(/\0/g, ' ');
                if (cmdline.includes('systemd-run')) systemdRunCmdline = cmdline;
              } catch {}
            }
            if (!systemdRunCmdline) await new Promise(resolve => setTimeout(resolve, 20));
          }
          expect(systemdRunCmdline).toContain('systemd-run');
          expect(systemdRunCmdline).not.toContain(canary);
          expect(systemdRunCmdline).not.toContain('--setenv=PR1483_CANARY');
          const probeExit = await new Promise(resolve => probe.once('close', (code, signal) => resolve({ code, signal })));
          expect(probeExit, probeStderr).toEqual({ code: 0, signal: null });
        } finally {
          if (probe.exitCode === null && probe.signalCode === null) probe.kill('SIGKILL');
          rmSync(probeRoot, { recursive: true, force: true });
        }

        const priorDisableScope = process.env.YEAFT_DISABLE_SYSTEMD_SCOPE;
        try {
          for (const disableSystemdScope of [true, false]) {
            if (disableSystemdScope) process.env.YEAFT_DISABLE_SYSTEMD_SCOPE = '1';
            else delete process.env.YEAFT_DISABLE_SYSTEMD_SCOPE;
            const bashRoot = mkdtempSync(join(tmpdir(), 'yeaft-bash-timeout-'));
            const markerPath = join(bashRoot, 'survived');
            const pidPath = join(bashRoot, 'pid');
            const escapedMarker = JSON.stringify(markerPath);
            const escapedPid = JSON.stringify(pidPath);
            const bashAdapter = new MockAdapter();
            bashAdapter.pushResponse([
              {
                type: 'tool_call',
                id: 'call_bash_timeout',
                name: 'Bash',
                input: {
                  command: `setsid env -i PATH="$PATH" sh -c 'trap "" TERM; sleep 3; printf survived > "$1"' sh ${escapedMarker} >/dev/null 2>&1 & echo $! > ${escapedPid}; wait`,
                  timeout_ms: 1000,
                },
              },
              { type: 'stop', stopReason: 'tool_use' },
            ]);
            bashAdapter.pushResponse([
              { type: 'text_delta', text: 'The command timed out; use a background task for long-running work.' },
              { type: 'stop', stopReason: 'end_turn' },
            ]);
            const bashRegistry = new ToolRegistry();
            bashRegistry.register(bashTool);
            const bashEngine = new Engine({
              adapter: bashAdapter,
              trace,
              config: { model: 'test-model', maxOutputTokens: 1024 },
              toolRegistry: bashRegistry,
            });
            const bashEvents = [];
            try {
              for await (const event of bashEngine.query({ prompt: 'run the command', workDir: bashRoot })) {
                bashEvents.push(event);
              }
              expect(existsSync(markerPath)).toBe(false);
              expect(bashEvents.find(event => event.type === 'tool_end')?.output)
                .toContain('Exit code: 124');
              const pid = Number.parseInt(readFileSync(pidPath, 'utf8'), 10);
              expect(() => process.kill(pid, 0)).toThrow();
              await new Promise(resolve => setTimeout(resolve, 2250));
              expect(existsSync(markerPath)).toBe(false);
              expect(bashAdapter.callLog).toHaveLength(2);
              expect(bashAdapter.callLog[1].messages.find(message => message.role === 'tool')).toMatchObject({
                toolCallId: 'call_bash_timeout',
                isError: false,
              });
              expect(bashAdapter.callLog[1].messages.find(message => message.role === 'tool').content)
                .toContain('Exit code: 124');
              expect(bashEvents.find(event => event.type === 'tool_end')).toMatchObject({
                id: 'call_bash_timeout',
                isError: false,
              });
              expect(bashEvents.find(event => event.type === 'error')).toBeUndefined();
              expect(bashEvents.filter(event => event.type === 'turn_end').at(-1)).toMatchObject({
                stopReason: 'end_turn',
                terminal: true,
              });
            } finally {
              rmSync(bashRoot, { recursive: true, force: true });
            }
          }
        } finally {
          if (priorDisableScope === undefined) delete process.env.YEAFT_DISABLE_SYSTEMD_SCOPE;
          else process.env.YEAFT_DISABLE_SYSTEMD_SCOPE = priorDisableScope;
        }
      }
    }, 30_000);

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
    async function verifyIdenticalReadReuse() {
      mockAdapter.pushResponse([
        { type: 'tool_call', id: 'read-1', name: 'read', input: { path: 'same.txt' } },
        { type: 'stop', stopReason: 'tool_use' },
      ]);
      mockAdapter.pushResponse([
        { type: 'tool_call', id: 'read-2', name: 'read', input: { path: 'same.txt' } },
        { type: 'stop', stopReason: 'tool_use' },
      ]);
      mockAdapter.pushResponse([
        { type: 'text_delta', text: 'done' },
        { type: 'stop', stopReason: 'end_turn' },
      ]);

      const engine = new Engine({
        adapter: mockAdapter,
        trace,
        config: { model: 'test-model', maxOutputTokens: 1024 },
      });
      let executions = 0;
      engine.registerTool({
        name: 'read',
        description: 'Read',
        parameters: { type: 'object', properties: { path: { type: 'string' } } },
        isReadOnly: () => true,
        cacheWithinQuery: () => true,
        execute: async () => { executions += 1; return 'file contents'; },
      });

      const events = [];
      for await (const event of engine.query({ prompt: 'read it' })) events.push(event);

      expect(executions).toBe(1);
      expect(events.filter(event => event.type === 'tool_exec').map(event => event.reused)).toEqual([undefined, true]);
      expect(mockAdapter.callLog).toHaveLength(3);
      expect(mockAdapter.callLog[2].messages.at(-1).content).toContain('file contents');
    }

    it('reuses identical deterministic reads and ends a plan-only control batch', async () => {
      await verifyIdenticalReadReuse();
      mockAdapter = new MockAdapter();
      mockAdapter.pushResponse([
        { type: 'tool_call', id: 'plan-1', name: 'StartPlan', input: { topic: 'inspect the issue' } },
        { type: 'tool_call', id: 'todo-1', name: 'TodoWrite', input: {
          todos: [{ content: 'Inspect the issue', status: 'in_progress', activeForm: 'Inspecting the issue' }],
        } },
        { type: 'stop', stopReason: 'tool_use' },
      ]);

      const engine = new Engine({
        adapter: mockAdapter,
        trace,
        config: { model: 'test-model', maxOutputTokens: 1024 },
      });
      engine.registerTool({
        name: 'StartPlan',
        description: 'Start plan',
        parameters: { type: 'object' },
        isReadOnly: () => true,
        execute: async () => 'plan instruction',
      });
      engine.registerTool({
        name: 'TodoWrite',
        description: 'Write todos',
        parameters: { type: 'object' },
        isReadOnly: () => true,
        execute: async () => '{"success":true}',
      });

      const events = [];
      for await (const event of engine.query({ prompt: 'inspect the issue' })) events.push(event);

      expect(mockAdapter.callLog).toHaveLength(1);
      expect(events.find(event => event.type === 'turn_end' && event.stopReason === 'plan_recorded')).toMatchObject({ terminal: true });
    });

    it('invalidates cached reads before successful and failed workspace mutations', async () => {
      const workDir = mkdtempSync(join(tmpdir(), 'yeaft-read-cache-mutation-'));
      const filePath = join(workDir, 'state.txt');
      writeFileSync(filePath, 'before');
      try {
        mockAdapter.pushResponse([
          { type: 'tool_call', id: 'read-before', name: 'FileRead', input: { file_path: 'state.txt' } },
          { type: 'tool_call', id: 'write', name: 'FileWrite', input: { file_path: 'state.txt', content: 'after' } },
          { type: 'tool_call', id: 'read-after', name: 'FileRead', input: { file_path: 'state.txt' } },
          { type: 'stop', stopReason: 'tool_use' },
        ]);
        mockAdapter.pushResponse([
          { type: 'text_delta', text: 'done' },
          { type: 'stop', stopReason: 'end_turn' },
        ]);

        const registry = new ToolRegistry();
        registry.register(fileReadTool).register(fileWriteTool);
        const engine = new Engine({
          adapter: mockAdapter,
          trace,
          config: { model: 'test-model', maxOutputTokens: 1024 },
          toolRegistry: registry,
        });

        const events = [];
        for await (const event of engine.query({ prompt: 'update and reread the file', workDir })) events.push(event);

        const toolStarts = events.filter(event => event.type === 'tool_start');
        const toolEnds = events.filter(event => event.type === 'tool_end');
        expect(toolStarts.find(event => event.id === 'read-after')?.reused).not.toBe(true);
        expect(toolEnds.find(event => event.id === 'read-before')?.output).toContain('before');
        expect(toolEnds.find(event => event.id === 'read-after')?.output).toContain('after');
        expect(readFileSync(filePath, 'utf8')).toBe('after');

        let contents = 'before';
        mockAdapter = new MockAdapter();
        mockAdapter.pushResponse([
          { type: 'tool_call', id: 'read-before-failure', name: 'read', input: { path: 'state.txt' } },
          { type: 'tool_call', id: 'write-and-fail', name: 'write', input: { path: 'state.txt' } },
          { type: 'tool_call', id: 'read-after-failure', name: 'read', input: { path: 'state.txt' } },
          { type: 'stop', stopReason: 'tool_use' },
        ]);
        mockAdapter.pushResponse([
          { type: 'text_delta', text: 'done' },
          { type: 'stop', stopReason: 'end_turn' },
        ]);

        const failingEngine = new Engine({
          adapter: mockAdapter,
          trace,
          config: { model: 'test-model', maxOutputTokens: 1024 },
        });
        failingEngine.registerTool({
          name: 'read',
          description: 'Read state',
          parameters: { type: 'object', properties: { path: { type: 'string' } } },
          isReadOnly: () => true,
          cacheWithinQuery: true,
          execute: async () => contents,
        });
        failingEngine.registerTool({
          name: 'write',
          description: 'Write state',
          parameters: { type: 'object', properties: { path: { type: 'string' } } },
          isReadOnly: () => false,
          execute: async () => {
            contents = 'after';
            throw new Error('write failed after changing state');
          },
        });

        const failingEvents = [];
        for await (const event of failingEngine.query({ prompt: 'update and reread the state' })) failingEvents.push(event);

        const failingToolStarts = failingEvents.filter(event => event.type === 'tool_start');
        const failingToolEnds = failingEvents.filter(event => event.type === 'tool_end');
        expect(failingToolStarts.find(event => event.id === 'read-after-failure')?.reused).not.toBe(true);
        expect(failingToolEnds.find(event => event.id === 'write-and-fail')).toMatchObject({
          isError: true,
          output: 'Error: write failed after changing state',
        });
        expect(failingToolEnds.find(event => event.id === 'read-after-failure')?.output).toBe('after');
      } finally {
        rmSync(workDir, { recursive: true, force: true });
      }
    });

    it('executes the complete tool batch before appending live user input', async () => {
      mockAdapter.pushResponse([
        { type: 'text_delta', text: 'Searching both...' },
        { type: 'tool_call', id: 'call_1', name: 'search', input: { q: 'foo' } },
        { type: 'tool_call', id: 'call_2', name: 'search', input: { q: 'bar' } },
        { type: 'stop', stopReason: 'tool_use' },
      ]);

      mockAdapter.pushResponse([
        { type: 'text_delta', text: 'Found both results and handled the update.' },
        { type: 'stop', stopReason: 'end_turn' },
      ]);

      const pendingUserMessages = [];
      const baseStream = mockAdapter.stream.bind(mockAdapter);
      let appendedDuringStream = false;
      mockAdapter.stream = async function* streamWithUserAppend(params) {
        for await (const event of baseStream(params)) {
          yield event;
          if (!appendedDuringStream && event.type === 'tool_call' && event.id === 'call_2') {
            appendedDuringStream = true;
            pendingUserMessages.push({
              content: 'Include the new requirement after both searches.',
              preview: 'Include the new requirement after both searches.',
            });
          }
        }
      };

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
      for await (const event of engine.query({
        prompt: 'search foo and bar',
        drainPendingUserMessages: () => pendingUserMessages.splice(0),
      })) {
        events.push(event);
      }

      const toolEnds = events.filter(e => e.type === 'tool_end');
      expect(toolEnds).toHaveLength(2);
      expect(toolEnds[0].output).toBe('Results: foo');
      expect(toolEnds[1].output).toBe('Results: bar');

      expect(mockAdapter.callLog).toHaveLength(2);
      const secondCall = mockAdapter.callLog[1];
      expect(secondCall.messages.map(message => message.role)).toEqual([
        'user',
        'assistant',
        'tool',
        'tool',
        'user',
      ]);
      expect(secondCall.messages[1].toolCalls.map(call => call.id)).toEqual(['call_1', 'call_2']);
      expect(secondCall.messages.slice(2, 4).map(message => message.toolCallId)).toEqual(['call_1', 'call_2']);
      expect(secondCall.messages.at(-1)).toMatchObject({
        role: 'user',
        content: 'Include the new requirement after both searches.',
      });

      const appendEventIndex = events.findIndex(event => event.type === 'user_append');
      const lastToolEndIndex = events.reduce(
        (last, event, index) => event.type === 'tool_end' ? index : last,
        -1,
      );
      expect(appendEventIndex).toBeGreaterThan(lastToolEndIndex);
      expect(events.filter(event => event.type === 'turn_end').at(-1)).toMatchObject({
        stopReason: 'end_turn',
        terminal: true,
      });
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

    it('retries generic 403 with the dedicated schedule then exposes the final status', async () => {
      const { LLMAuthError } = await import('../../../agent/yeaft/llm/adapter.js');
      let attempts = 0;
      const engine = new Engine({
        adapter: {
          async *stream() {
            attempts += 1;
            throw new LLMAuthError('LLM provider returned HTTP 403 (unknown_forbidden)', 403, {
              reasonCode: 'unknown_forbidden',
              temporary: true,
            });
          },
        },
        trace,
        config: {
          model: 'test-model',
          maxOutputTokens: 1024,
          llmRetry: { forbiddenRetryDelaysMs: [0, 0] },
        },
      });

      const events = [];
      for await (const event of engine.query({ prompt: 'hello' })) events.push(event);

      expect(attempts).toBe(3);
      expect(events.filter(e => e.type === 'llm_retry')).toEqual([
        expect.objectContaining({ reason: 'temporary_forbidden', attempt: 1, maxRetries: 2, statusCode: 403 }),
        expect.objectContaining({ reason: 'temporary_forbidden', attempt: 2, maxRetries: 2, statusCode: 403 }),
      ]);
      const finalError = events.find(e => e.type === 'error');
      expect(finalError.error.statusCode).toBe(403);
      expect(finalError.error.reasonCode).toBe('unknown_forbidden');
      expect(finalError.retryable).toBe(false);
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
      // Static credentials cannot self-heal; waiting would only delay the same failure.
      expect(errorEvents[0].retryable).toBe(false);
      expect(errorEvents[0].error.statusCode).toBe(401);
    });

    it('does not retry a policy-denied 403', async () => {
      const { LLMAuthError } = await import('../../../agent/yeaft/llm/adapter.js');
      let attempts = 0;
      const engine = new Engine({
        adapter: {
          async *stream() {
            attempts += 1;
            throw new LLMAuthError('LLM provider returned HTTP 403 (permission_denied)', 403, {
              reasonCode: 'permission_denied',
              temporary: false,
            });
          },
        },
        trace,
        config: {
          model: 'test-model',
          maxOutputTokens: 1024,
          llmRetry: { forbiddenRetryDelaysMs: [0, 0] },
        },
      });

      const events = [];
      for await (const event of engine.query({ prompt: 'hello' })) events.push(event);

      expect(attempts).toBe(1);
      expect(events.filter(e => e.type === 'llm_retry')).toHaveLength(0);
      expect(events.find(e => e.type === 'error').error.reasonCode).toBe('permission_denied');
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

      dbTrace.refreshConfig({ traceTextMaxBytes: 64 });
      const boundedTurn = dbTrace.startTurn({ traceId: 'trace-bounded', turnNumber: 3 });
      dbTrace.endTurn(boundedTurn, {
        systemPrompt: 'system',
        messages: [{ role: 'user', content: '😀'.repeat(200) }],
        responseText: 'ok',
        stopReason: 'end_turn',
      });
      await dbTrace.flush();
      const bounded = await dbTrace.fetchRecentDebugHistory({ detailTurnId: 'trace-bounded' });
      expect(Buffer.byteLength(JSON.stringify(bounded.loops[0]?.messages || []), 'utf8')).toBeLessThanOrEqual(64);

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
    async function verifyEnglishSystemPrompt() {
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
    }

    it('uses English and Chinese system prompts with configured tool guidance', async () => {
      await verifyEnglishSystemPrompt();
      mockAdapter = new MockAdapter();
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
      mockAdapter = new MockAdapter();

      mockAdapter.pushResponse([
        { type: 'text_delta', text: 'ok' },
        { type: 'stop', stopReason: 'end_turn' },
      ]);

      const toolGuidanceEngine = new Engine({
        adapter: mockAdapter,
        trace,
        config: { model: 'test-model', maxOutputTokens: 1024, language: 'zh' },
      });

      toolGuidanceEngine.registerTool({
        name: 'search',
        description: 'Search',
        parameters: {},
        execute: async () => 'results',
      });

      for await (const _event of toolGuidanceEngine.query({ prompt: 'test' })) {
        // consume
      }

      const toolGuidanceCall = mockAdapter.callLog[0];
      expect(toolGuidanceCall.system).toContain('可用工具：search');

      const enSystem = buildSystemPrompt({
        language: 'en',
        toolNames: ['TodoWrite'],
        projectLabel: 'Yeaft (project-123)',
        projectInstruction: 'Run the shared Project verification before release.',
      });
      const zhSystem = buildSystemPrompt({
        language: 'zh',
        projectLabel: 'Yeaft（project-123）',
        projectInstruction: '发布前执行统一验证。',
        toolNames: ['TodoWrite'],
      });

      expect(enSystem).toContain('[Project Instruction]');
      expect(enSystem).toContain('The current Session belongs to Project Yeaft (project-123). The unified instruction for this Project is:');
      expect(enSystem).toContain('Run the shared Project verification before release.');
      expect(buildSystemPrompt({
        language: 'en',
        projectInstruction: 'Use the current Project instruction.',
      })).toContain('The current Session belongs to the current Project. The unified instruction for this Project is:');
      expect(buildSystemPrompt({
        language: 'zh',
        projectLabel: '   ',
        projectInstruction: '使用当前 Project 指令。',
      })).toContain('当前 Session 隶属于当前 Project。当前 Project 的统一 instruction 是：');
      expect(buildSystemPrompt({ language: 'en', projectInstruction: '   ' }))
        .not.toContain('[Project Instruction]');
      expect(enSystem).toContain('Avoid an intermediate `TodoWrite`-only model round');
      expect(enSystem).toMatch(/mark work completed only after\s+evidence/);
      expect(enSystem).toContain('A standalone `TodoWrite` remains valid');
      expect(zhSystem).toContain('当前 Session 隶属于 Project Yeaft（project-123）。当前 Project 的统一 instruction 是：');
      expect(zhSystem).toContain('发布前执行统一验证。');
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
const managedCliTempDirs = [];

function tempDir(name) {
  const dir = mkdtempSync(join(tmpdir(), `yeaft-${name}-`));
  managedCliTempDirs.push(dir);
  return dir;
}

function tarArchive(path, content) {
  const data = Buffer.from(content);
  const header = Buffer.alloc(512);
  header.write(path, 0, 100, 'utf8');
  header.write('0000755\0', 100, 8, 'ascii');
  header.write('0000000\0', 108, 8, 'ascii');
  header.write('0000000\0', 116, 8, 'ascii');
  header.write(`${data.length.toString(8).padStart(11, '0')}\0`, 124, 12, 'ascii');
  header.fill(32, 148, 156);
  header[156] = 48;
  header.write('ustar\0', 257, 6, 'ascii');
  const checksum = [...header].reduce((sum, byte) => sum + byte, 0);
  header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
  return gzipSync(Buffer.concat([
    header,
    data,
    Buffer.alloc((512 - data.length % 512) % 512),
    Buffer.alloc(1024),
  ]));
}

function emptyPathEnv() {
  return { ...process.env, PATH: '' };
}

function trustManagedCliFixtures(yeaftDir, names) {
  const statePath = join(yeaftDir, 'managed-cli.json');
  let state = {};
  try { state = JSON.parse(readFileSync(statePath, 'utf8')); } catch {}
  const installations = { ...(state.installations || {}) };
  for (const name of names) {
    const path = join(managedCliBinDir(yeaftDir), name);
    const [assetFileName, archiveSha256] = managedCliToolSpecs[name].assets[
      `${process.platform}-${process.arch}`
    ];
    installations[name] = {
      version: managedCliToolSpecs[name].version,
      platform: process.platform,
      arch: process.arch,
      assetFileName,
      archiveSha256,
      binarySha256: createHash('sha256').update(readFileSync(path)).digest('hex'),
    };
  }
  writeFileSync(statePath, `${JSON.stringify({
    ...state,
    version: 2,
    installations,
  }, null, 2)}\n`);
}

function zipArchive(path, content) {
  const name = Buffer.from(path);
  const data = Buffer.from(content);
  const local = Buffer.alloc(30 + name.length + data.length);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0, 6);
  local.writeUInt16LE(0, 8);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(name.length, 26);
  name.copy(local, 30);
  data.copy(local, 30 + name.length);

  const central = Buffer.alloc(46 + name.length);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0, 8);
  central.writeUInt16LE(0, 10);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(name.length, 28);
  name.copy(central, 46);

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(local.length, 16);
  return Buffer.concat([local, central, end]);
}

afterEach(() => {
  for (const dir of managedCliTempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('managed CLI setup and fast tool integration', () => {
  async function verifyProcessTermination() {
    const preAborted = new AbortController();
    preAborted.abort();
    await expect(runProcess(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], {
      signal: preAborted.signal,
    })).rejects.toMatchObject({ name: 'AbortError' });

    const crScript = "process.stdout.write('out\\r\\n'); process.stderr.write('err\\r\\n')";
    await expect(runProcess(process.execPath, ['-e', crScript])).resolves.toMatchObject({
      stdout: 'out\n',
      stderr: 'err\n',
    });
    const replacementScript = "process.stdout.write('valid \\ufffd value')";
    await expect(runProcess(process.execPath, ['-e', replacementScript])).resolves.toMatchObject({
      stdout: 'valid \ufffd value',
    });
    await expect(runProcess(process.execPath, ['-e', crScript], {
      preserveCarriageReturns: true,
    })).resolves.toMatchObject({
      stdout: 'out\r\n',
      stderr: 'err\n',
    });

    if (process.platform !== 'win32') {
      const termResistant = "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)";
      const startedAt = Date.now();
      const timedOut = await runProcess(process.execPath, ['-e', termResistant], {
        timeoutMs: 50,
        killGraceMs: 25,
      });
      expect(timedOut).toMatchObject({ code: 124, timedOut: true });
      expect(Date.now() - startedAt).toBeLessThan(1000);

      const controller = new AbortController();
      const pending = runProcess(process.execPath, ['-e', termResistant], {
        signal: controller.signal,
        killGraceMs: 25,
      });
      setTimeout(() => controller.abort(), 50);
      await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    }
  }

  async function verifyWindowsProcessTreeTermination() {
    for (const taskkillFailure of ['nonzero', 'throw']) {
      const calls = [];
      const child = new EventEmitter();
      child.pid = 4242;
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = signal => {
        calls.push(`proc.kill ${signal}`);
        setImmediate(() => child.emit('close', 1));
        return true;
      };
      const spawnProcess = () => child;
      const spawnProcessSync = (command, args) => {
        calls.push(`${command} ${args.join(' ')}`);
        if (taskkillFailure === 'throw') throw new Error('taskkill unavailable');
        return { status: 1 };
      };

      const result = await runProcess('ignored.exe', [], {
        timeoutMs: 1,
        platform: 'win32',
        spawnProcess,
        spawnProcessSync,
      });
      expect(result).toMatchObject({ code: 124, timedOut: true });
      expect(calls).toEqual([
        'taskkill /pid 4242 /t /f',
        'proc.kill SIGKILL',
      ]);
      expect(child.listenerCount('close')).toBe(0);
      expect(child.listenerCount('error')).toBe(0);
      expect(child.stdout.listenerCount('data')).toBe(0);
      expect(child.stderr.listenerCount('data')).toBe(0);
    }

    const child = new EventEmitter();
    child.pid = 4343;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => true;
    const result = await runProcess('powershell.exe', [], {
      timeoutMs: 1,
      forceSettleMs: 5,
      requireExitConfirmation: true,
      platform: 'win32',
      spawnProcess: () => child,
      spawnProcessSync: () => ({ status: 0 }),
    });
    expect(result).toMatchObject({
      code: 124,
      timedOut: true,
      terminationError: 'Process tree did not exit within 5ms after SIGKILL: powershell.exe',
    });
    expect(child.listenerCount('close')).toBe(0);
    expect(child.listenerCount('error')).toBe(0);
    expect(child.stdout.listenerCount('data')).toBe(0);
    expect(child.stderr.listenerCount('data')).toBe(0);

    const abortedChild = new EventEmitter();
    abortedChild.pid = 4545;
    abortedChild.stdout = new PassThrough();
    abortedChild.stderr = new PassThrough();
    abortedChild.kill = () => true;
    const controller = new AbortController();
    const aborted = runProcess('powershell.exe', [], {
      signal: controller.signal,
      timeoutMs: 1,
      forceSettleMs: 20,
      requireExitConfirmation: true,
      platform: 'win32',
      spawnProcess: () => abortedChild,
      spawnProcessSync: () => ({ status: 0 }),
    });
    setTimeout(() => controller.abort(), 5);
    await expect(aborted).rejects.toMatchObject({ name: 'AbortError' });
    expect(abortedChild.listenerCount('close')).toBe(0);
    expect(abortedChild.listenerCount('error')).toBe(0);
    expect(abortedChild.stdout.listenerCount('data')).toBe(0);
    expect(abortedChild.stderr.listenerCount('data')).toBe(0);

    const overflowChild = new EventEmitter();
    overflowChild.pid = 4646;
    overflowChild.stdout = new PassThrough();
    overflowChild.stderr = new PassThrough();
    overflowChild.kill = () => true;
    const overflowed = runProcess('powershell.exe', [], {
      timeoutMs: 5,
      forceSettleMs: 20,
      maxBytes: 1,
      requireExitConfirmation: true,
      platform: 'win32',
      spawnProcess: () => overflowChild,
      spawnProcessSync: () => ({ status: 0 }),
    });
    overflowChild.stdout.write('too much output');
    await expect(overflowed).rejects.toMatchObject({ name: 'ProcessTerminationError' });
    expect(overflowChild.listenerCount('close')).toBe(0);
    expect(overflowChild.listenerCount('error')).toBe(0);
    expect(overflowChild.stdout.listenerCount('data')).toBe(0);
    expect(overflowChild.stderr.listenerCount('data')).toBe(0);
  }

  function verifyGrepExactBudget() {
    const marker = '\n\n[Output truncated]';
    for (const finalSize of [32767, 32768]) {
      const collector = createOutputCollector(32768);
      const lastSize = finalSize - 24002;
      expect(collector.add('x'.repeat(12000))).toBe(true);
      expect(collector.add('x'.repeat(12000))).toBe(true);
      expect(collector.add('x'.repeat(lastSize))).toBe(true);
      expect(Buffer.byteLength(collector.toString())).toBe(finalSize);
      expect(collector.toString()).not.toContain(marker);
    }
    const overflow = createOutputCollector(32768);
    expect(overflow.add('x'.repeat(12000))).toBe(true);
    expect(overflow.add('x'.repeat(12000))).toBe(true);
    expect(overflow.add('x'.repeat(8767))).toBe(false);
    expect(Buffer.byteLength(overflow.toString())).toBe(32768);
    expect(overflow.toString().endsWith(marker)).toBe(true);
    const settled = overflow.toString();
    expect(overflow.add('late')).toBe(false);
    expect(overflow.toString()).toBe(settled);

    for (const maxBytes of [0, 1, Buffer.byteLength(marker) - 1, Buffer.byteLength(marker)]) {
      const tiny = createOutputCollector(maxBytes);
      expect(tiny.add('x'.repeat(maxBytes + 1))).toBe(false);
      expect(Buffer.byteLength(tiny.toString())).toBe(maxBytes);
      expect(tiny.toString()).not.toContain('\ufffd');
    }

    const unicode = createOutputCollector(16);
    expect(unicode.add('界'.repeat(6))).toBe(false);
    expect(Buffer.byteLength(unicode.toString())).toBe(16);
    expect(unicode.toString()).not.toContain('\ufffd');
  }

  async function verifyRipgrepRecordFraming() {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => {};
    const pending = runRipgrep('needle', process.cwd(), {
      fixedStrings: true,
      filesOnly: false,
      maxResults: 10,
      byteBudget: 32768,
      cwd: process.cwd(),
      structured: true,
    }, () => child);
    const raw = Buffer.from(
      'C:/a.js\u00001:needle\nsrc/界\nbreak.js\u00002:needle\nsrc/a:12:b.js\u00003:needle\n',
      'utf8',
    );
    for (const byte of raw) child.stdout.write(Buffer.from([byte]));
    child.stdout.end();
    child.stderr.end();
    child.emit('close', 0);
    await expect(pending).resolves.toMatchObject({
      records: [
        { path: 'C:/a.js', suffix: '1:needle', kind: 'match' },
        { path: 'src/界\nbreak.js', suffix: '2:needle', kind: 'match' },
        { path: 'src/a:12:b.js', suffix: '3:needle', kind: 'match' },
      ],
      resultCount: 3,
      truncated: false,
    });
  }

  async function verifyRipgrepFilteredLongLineFraming() {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    let killCalls = 0;
    child.kill = () => { killCalls += 1; };
    const pending = runRipgrep('needle', process.cwd(), {
      fixedStrings: true,
      filesOnly: false,
      glob: '**/*.js',
      maxResults: 10,
      byteBudget: 32768,
      cwd: process.cwd(),
      structured: true,
    }, () => child);
    child.stdout.write(Buffer.from(`a.txt\u0000${'x'.repeat(17000)}`));
    await new Promise(resolve => setImmediate(resolve));
    expect(killCalls).toBe(0);
    child.stdout.write(Buffer.from('tail\nb.js\u00001:needle\n'));
    child.stdout.end();
    child.stderr.end();
    child.emit('close', 0);
    await expect(pending).resolves.toMatchObject({
      records: [{ path: 'b.js', suffix: '1:needle', kind: 'match' }],
      resultCount: 1,
      truncated: false,
    });
    expect(killCalls).toBe(0);
  }

  async function verifyRipgrepLongLineStopsDuringCapture() {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    let killCalls = 0;
    child.kill = () => { killCalls += 1; };
    const pending = runRipgrep('needle', process.cwd(), {
      fixedStrings: true,
      filesOnly: false,
      maxResults: 10,
      byteBudget: 32768,
      cwd: process.cwd(),
      structured: true,
    }, () => child);
    child.stdout.write(Buffer.from(`src/a.js\u0000${'界'.repeat(7000)}`));
    await new Promise(resolve => setImmediate(resolve));
    expect(killCalls).toBe(1);
    child.stdout.end();
    child.stderr.end();
    child.emit('close', null);
    const result = await pending;
    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(result.output)).toBeLessThanOrEqual(32768);
    expect(result.output).toContain('[Output truncated]');
    expect(result.output).not.toContain('\ufffd');
  }

  async function verifyRipgrepAbortReentry() {
    for (const event of ['close', 'error']) {
      const controller = new AbortController();
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      let killCalls = 0;
      child.kill = () => {
        killCalls += 1;
        if (event === 'close') child.emit('close', 130);
        else child.emit('error', new Error('sync process error'));
      };
      const pending = runRipgrep('needle', process.cwd(), {
        fixedStrings: true,
        filesOnly: true,
        maxResults: 10,
        byteBudget: 32768,
        cwd: process.cwd(),
        signal: controller.signal,
      }, () => child);
      controller.abort('user');
      await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
      expect(killCalls).toBe(1);
      child.emit('error', new Error('late process error'));
      child.emit('close', 0);
      expect(killCalls).toBe(1);
    }
  }

  async function verifyRipgrepParity() {
    if (process.platform === 'win32') return;
    const root = tempDir('grep-semantic-parity');
    const binDir = join(root, 'bin');
    mkdirSync(join(root, '.hidden'), { recursive: true });
    mkdirSync(join(root, 'node_modules'), { recursive: true });
    mkdirSync(join(root, '.git'), { recursive: true });
    mkdirSync(join(root, '.yeaft', 'worktrees', 'ignored'), { recursive: true });
    mkdirSync(join(root, 'src', '.yeaft', 'worktrees', 'ignored'), { recursive: true });
    mkdirSync(binDir);
    writeFileSync(join(root, 'src', 'a.txt'), 'needle\n');
    writeFileSync(join(root, '.hidden', 'h.txt'), 'needle\n');
    writeFileSync(join(root, 'node_modules', 'n.txt'), 'needle\n');
    writeFileSync(join(root, '.git', 'g.txt'), 'needle\n');
    writeFileSync(join(root, '.yeaft', 'worktrees', 'ignored', 'w.txt'), 'needle\n');
    writeFileSync(join(root, 'src', '.yeaft', 'worktrees', 'ignored', 'w.txt'), 'needle\n');
    const rgPath = join(binDir, 'rg');
    const capturedArgs = join(tmpdir(), `yeaft-rg-args-${process.pid}-${Date.now()}.txt`);
    writeFileSync(rgPath, `#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(capturedArgs)}\nprintf 'src/a.txt\\000.hidden/h.txt\\000'\n`, { mode: 0o755 });
    const options = {
      caseInsensitive: false,
      fixedStrings: true,
      filesOnly: true,
      count: false,
      multiline: false,
      maxResults: 50,
      byteBudget: 32 * 1024,
      cwd: root,
    };
    const fast = (await runRipgrep('needle', root, options, undefined, rgPath)).trim().split('\n').sort();
    const fallback = (await nodeGrep('needle', root, options)).trim().split('\n').sort();
    expect(fast).toEqual(fallback);
    expect(fast).toEqual(['.hidden/h.txt', 'src/a.txt']);
    const args = readFileSync(capturedArgs, 'utf8').trim().split('\n');
    expect(args).toContain('--hidden');
    expect(args).toContain('--no-ignore');
    expect(args).toContain('!**/node_modules/**');
    expect(args).toContain('!.yeaft/worktrees/**');
    expect(args).toContain('!**/.yeaft/worktrees/**');
    options.glob = '**/*.txt';
    const filteredFallback = (await nodeGrep('needle', root, options)).trim().split('\n').sort();
    expect(filteredFallback).toEqual(['.hidden/h.txt', 'src/a.txt']);
    await runRipgrep('needle', root, options, undefined, rgPath);
    const filteredArgs = readFileSync(capturedArgs, 'utf8').trim().split('\n');
    expect(filteredArgs).not.toContain('**/*.txt');
    expect(filteredArgs).toContain('!**/node_modules/**');
    expect(filteredArgs).toContain('!.yeaft/worktrees/**');
    expect(filteredArgs).toContain('!**/.yeaft/worktrees/**');
    rmSync(capturedArgs, { force: true });
  }

  async function verifyManagedRgEnvironment() {
    if (process.platform === 'win32') return;

    const yeaftDir = tempDir('cli-rg-environment');
    const binDir = managedCliBinDir(yeaftDir);
    mkdirSync(binDir, { recursive: true });
    writeFileSync(join(binDir, 'rg'), '#!/bin/sh\necho ripgrep 15.2.0\n', { mode: 0o755 });
    writeFileSync(join(binDir, 'git'), '#!/bin/sh\necho UNTRUSTED-GIT\n', { mode: 0o755 });
    writeFileSync(join(binDir, 'fd'), '#!/bin/sh\necho UNVERIFIED-FD\n', { mode: 0o755 });
    trustManagedCliFixtures(yeaftDir, ['rg']);

    const systemBin = join(yeaftDir, 'system-bin');
    mkdirSync(systemBin);
    writeFileSync(join(systemBin, 'git'), '#!/bin/sh\necho SYSTEM-GIT\n', { mode: 0o755 });
    writeFileSync(join(systemBin, 'fd'), '#!/bin/sh\necho SYSTEM-FD\n', { mode: 0o755 });

    let markReady;
    const rgReady = new Promise(resolveReady => { markReady = resolveReady; });
    const ready = Promise.resolve([]);
    ready.toolReady = { rg: rgReady };
    const originalPath = process.env.PATH;
    process.env.PATH = [systemBin, '/usr/bin', '/bin'].join(delimiter);
    try {
      const pending = prepareManagedCliToolEnvironment(ready, 'rg', { yeaftDir });
      await new Promise(resolveTick => setImmediate(resolveTick));
      expect(process.env.PATH.split(delimiter)).not.toContain(binDir);

      markReady({ name: 'rg', status: 'available', path: join(binDir, 'rg') });
      const environment = await pending;
      expect(environment).toMatchObject({ name: 'rg', activated: true });
      expect(environment.command).toBe(join(environment.binDir, 'rg'));
      expect(environment.binDir).not.toBe(binDir);
      expect(readdirSync(environment.binDir)).toEqual(['rg']);
      expect(process.env.PATH.split(delimiter)[0]).toBe(environment.binDir);
      expect(process.env.PATH.split(delimiter)).not.toContain(binDir);
      const inheritedPathBash = createBashTool({
        runProcessImpl: async (_command, _args, options) => {
          const result = spawnSync('/bin/sh', ['-c', 'rg --version; git --version; fd --version'], {
            encoding: 'utf8',
            env: options.env,
          });
          return {
            code: result.status,
            stdout: result.stdout.trim(),
            stderr: result.stderr.trim(),
            timedOut: false,
            terminationError: null,
          };
        },
      });
      await expect(inheritedPathBash.execute({
        command: 'rg --version',
        cwd: yeaftDir,
        timeout_ms: 5000,
      }, {})).resolves.toBe('ripgrep 15.2.0\nSYSTEM-GIT\nSYSTEM-FD');
    } finally {
      process.env.PATH = originalPath;
      cleanupManagedCliRuntimePaths();
    }
  }

  async function verifyManagedRgSignalCleanup() {
    if (process.platform === 'win32') return;

    for (const signal of ['SIGTERM', 'SIGINT']) {
      const cliDir = tempDir(`cli-rg-${signal.toLowerCase()}`);
      const binDir = managedCliBinDir(cliDir);
      mkdirSync(binDir, { recursive: true });
      writeFileSync(join(binDir, 'rg'), '#!/bin/sh\necho ripgrep 15.2.0\n', { mode: 0o755 });
      trustManagedCliFixtures(cliDir, ['rg']);
      const tmpRoot = join(cliDir, 'tmp');
      mkdirSync(tmpRoot);
      const child = spawn(process.execPath, [
        join(process.cwd(), 'agent', 'yeaft', 'cli.js'),
        '--skip-mcp',
        '--skip-skills',
        '--input-format', 'stream-json',
        '--output-format', 'stream-json',
      ], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          TMPDIR: tmpRoot,
          YEAFT_DIR: cliDir,
          YEAFT_SKIP_MANAGED_CLI_INSTALLS: 'true',
        },
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', chunk => { stdout += chunk; });
      child.stderr.on('data', chunk => { stderr += chunk; });
      try {
        for (let i = 0; i < 500; i += 1) {
          if (readdirSync(tmpRoot).some(name => name.startsWith('yeaft-managed-cli-'))) break;
          await new Promise(resolveDelay => setTimeout(resolveDelay, 10));
        }
        const runtimeDirectories = readdirSync(tmpRoot)
          .filter(name => name.startsWith('yeaft-managed-cli-'));
        expect(runtimeDirectories).toHaveLength(1);
        for (let i = 0; i < 500; i += 1) {
          if (stdout.includes('"subtype":"init"')) break;
          await new Promise(resolveDelay => setTimeout(resolveDelay, 10));
        }
        const stdoutEvents = stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
        expect(stdoutEvents).toEqual(expect.arrayContaining([
          expect.objectContaining({ type: 'system', subtype: 'init' }),
        ]));
        child.kill(signal);
        const outcome = await new Promise((resolveClose, rejectClose) => {
          const timer = setTimeout(() => {
            child.kill('SIGKILL');
            rejectClose(new Error(`CLI did not preserve ${signal}; stdout=${stdout}; stderr=${stderr}`));
          }, 10_000);
          child.once('error', rejectClose);
          child.once('close', (code, closeSignal) => {
            clearTimeout(timer);
            resolveClose({ code, signal: closeSignal });
          });
        });
        expect(outcome).toEqual({ code: null, signal });
        expect(readdirSync(tmpRoot)).toEqual([]);
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      }
    }
  }

  async function verifyManagedRgCleanupRetry() {
    if (process.platform === 'win32') return;

    const yeaftDir = tempDir('cli-rg-cleanup-retry');
    const binDir = managedCliBinDir(yeaftDir);
    mkdirSync(binDir, { recursive: true });
    writeFileSync(join(binDir, 'rg'), '#!/bin/sh\necho ripgrep 15.2.0\n', { mode: 0o755 });
    trustManagedCliFixtures(yeaftDir, ['rg']);
    const runtimeRoot = join(yeaftDir, 'runtime-root');
    mkdirSync(runtimeRoot);
    const originalTmpDir = process.env.TMPDIR;
    process.env.TMPDIR = runtimeRoot;
    try {
      const environment = await prepareManagedCliToolEnvironment(Promise.resolve([]), 'rg', {
        yeaftDir,
        env: { PATH: '/usr/bin:/bin' },
      });
      expect(existsSync(environment.binDir)).toBe(true);

      chmodSync(runtimeRoot, 0o500);
      cleanupManagedCliRuntimePaths();
      expect(existsSync(environment.binDir)).toBe(true);

      chmodSync(runtimeRoot, 0o700);
      cleanupManagedCliRuntimePaths();
      expect(existsSync(environment.binDir)).toBe(false);
    } finally {
      chmodSync(runtimeRoot, 0o700);
      cleanupManagedCliRuntimePaths();
      if (originalTmpDir === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = originalTmpDir;
    }
  }

  async function verifyManagedRgAgentShutdownOrder() {
    if (process.platform === 'win32') return;

    const yeaftDir = tempDir('cli-rg-agent-shutdown-order');
    const binDir = managedCliBinDir(yeaftDir);
    mkdirSync(binDir, { recursive: true });
    writeFileSync(join(binDir, 'rg'), '#!/bin/sh\necho ripgrep 15.2.0\n', { mode: 0o755 });
    trustManagedCliFixtures(yeaftDir, ['rg']);
    const runtimeRoot = join(yeaftDir, 'runtime-root');
    mkdirSync(runtimeRoot);
    const originalTmpDir = process.env.TMPDIR;
    process.env.TMPDIR = runtimeRoot;
    try {
      const environment = await prepareManagedCliToolEnvironment(Promise.resolve([]), 'rg', {
        yeaftDir,
        env: { PATH: '/usr/bin:/bin' },
      });
      expect(existsSync(environment.binDir)).toBe(true);

      let laterShutdownStarted = false;
      const laterShutdown = new Promise(() => {});
      const shutdown = runAfterManagedCliRuntimeCleanup(() => {
        laterShutdownStarted = true;
        return laterShutdown;
      });

      expect(laterShutdownStarted).toBe(true);
      expect(existsSync(environment.binDir)).toBe(false);
      await expect(Promise.race([
        shutdown.then(() => 'settled'),
        new Promise(resolveDelay => setTimeout(() => resolveDelay('pending'), 25)),
      ])).resolves.toBe('pending');
    } finally {
      cleanupManagedCliRuntimePaths();
      if (originalTmpDir === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = originalTmpDir;
    }
  }

  async function verifyManagedRgNormalExitCleanup() {
    if (process.platform === 'win32') return;

    for (const scenario of [
      { name: 'success', input: '', expectedCode: 0 },
      { name: 'failure', input: 'not-json\n', expectedCode: 1 },
    ]) {
      const cliDir = tempDir(`cli-rg-normal-${scenario.name}`);
      const binDir = managedCliBinDir(cliDir);
      mkdirSync(binDir, { recursive: true });
      writeFileSync(join(binDir, 'rg'), [
        '#!/bin/sh',
        `printf '%s' "$0" > "$YEAFT_DIR/runtime-command"`,
        'echo ripgrep 15.2.0',
        '',
      ].join('\n'), { mode: 0o755 });
      trustManagedCliFixtures(cliDir, ['rg']);
      const tmpRoot = join(cliDir, 'tmp');
      mkdirSync(tmpRoot);
      const child = spawn(process.execPath, [
        join(process.cwd(), 'agent', 'yeaft', 'cli.js'),
        '--skip-mcp',
        '--skip-skills',
        '--input-format', 'stream-json',
        '--output-format', 'stream-json',
      ], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          TMPDIR: tmpRoot,
          YEAFT_DIR: cliDir,
          YEAFT_SKIP_MANAGED_CLI_INSTALLS: 'true',
        },
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', chunk => { stdout += chunk; });
      child.stderr.on('data', chunk => { stderr += chunk; });
      child.stdin.end(scenario.input);
      const outcome = await new Promise((resolveClose, rejectClose) => {
        const timer = setTimeout(() => {
          child.kill('SIGKILL');
          rejectClose(new Error(`CLI ${scenario.name} timed out; stdout=${stdout}; stderr=${stderr}`));
        }, 10_000);
        child.once('error', rejectClose);
        child.once('close', (code, signal) => {
          clearTimeout(timer);
          resolveClose({ code, signal });
        });
      });
      expect(outcome).toEqual({ code: scenario.expectedCode, signal: null });
      const runtimeCommand = readFileSync(join(cliDir, 'runtime-command'), 'utf8');
      expect(runtimeCommand.startsWith(`${tmpRoot}${process.platform === 'win32' ? '\\' : '/'}`)).toBe(true);
      expect(existsSync(runtimeCommand)).toBe(false);
      expect(readdirSync(tmpRoot)).toEqual([]);
      const stdoutEvents = stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
      expect(stdoutEvents).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'system', subtype: 'init' }),
      ]));
      if (scenario.expectedCode !== 0) {
        expect(stderr).toContain('Invalid stream-json input');
      }
    }
  }

  async function verifyUnverifiedManagedRgIsNotExposed() {
    if (process.platform === 'win32') return;

    const unverifiedDir = tempDir('cli-rg-unverified');
    const unverifiedBin = managedCliBinDir(unverifiedDir);
    mkdirSync(unverifiedBin, { recursive: true });
    writeFileSync(join(unverifiedBin, 'rg'), '#!/bin/sh\necho unverified\n', { mode: 0o755 });
    const unverifiedEnv = { PATH: '' };
    await expect(prepareManagedCliToolEnvironment(Promise.resolve([]), 'rg', {
      yeaftDir: unverifiedDir,
      env: unverifiedEnv,
    })).resolves.toEqual({ name: 'rg', activated: false, command: null });
    expect(unverifiedEnv.PATH).toBe('');

    const systemDir = tempDir('cli-rg-system');
    const systemBin = join(systemDir, 'system-bin');
    mkdirSync(systemBin);
    const systemRg = join(systemBin, 'rg');
    writeFileSync(systemRg, '#!/bin/sh\necho system rg\n', { mode: 0o755 });
    const systemEnv = { PATH: systemBin };
    await expect(prepareManagedCliToolEnvironment(Promise.resolve([]), 'rg', {
      yeaftDir: systemDir,
      env: systemEnv,
    })).resolves.toEqual({ name: 'rg', activated: false, command: systemRg });
    expect(systemEnv.PATH).toBe(systemBin);
  }

  it('keeps managed CLI filters, process, and fallback boundaries', async () => {
    await verifyManagedRgEnvironment();
    await verifyManagedRgSignalCleanup();
    await verifyManagedRgCleanupRetry();
    await verifyManagedRgAgentShutdownOrder();
    await verifyManagedRgNormalExitCleanup();
    await verifyUnverifiedManagedRgIsNotExposed();

    const processResult = (overrides = {}) => ({
      code: 0,
      stdout: '',
      stderr: '',
      truncated: false,
      timedOut: false,
      ...overrides,
    });

    const fdRoot = tempDir('fd-pattern');
    let fdCall;
    const fdOutput = await listFilesWithFd('fd', fdRoot, 'src/**/*.{js,md}', undefined,
      async (command, args, options) => {
        fdCall = { command, args, options };
        return processResult({
          stdout: `src${process.platform === 'win32' ? '\\' : '/'}a.js\0`,
        });
      });
    expect(fdOutput).toEqual([join('src', 'a.js')]);
    expect(fdCall.args).toContain('--full-path');
    expect(fdCall.args).toContain('--case-sensitive');
    expect(fdCall.args.at(-1)).toBe('.');
    const pushedPattern = fdCall.args.at(-2);
    expect(new RegExp(pushedPattern).test(join(fdRoot, 'src', 'nested', 'a.js'))).toBe(true);
    expect(new RegExp(pushedPattern).test(join(fdRoot, 'src', 'nested', 'a.txt'))).toBe(false);

    const rgRoot = tempDir('rg-candidates');
    mkdirSync(join(rgRoot, 'src'));
    writeFileSync(join(rgRoot, 'src', 'hit.js'), 'needle\n');
    writeFileSync(join(rgRoot, 'src', 'miss.js'), 'needle\n');
    let rgCall;
    const candidatePaths = await listRipgrepCandidatePaths('rg', rgRoot, {
      pattern: 'needle', fixedStrings: true,
    }, async (command, args, options) => {
      rgCall = { command, args, options };
      return processResult({
        stdout: `src${process.platform === 'win32' ? '\\' : '/'}hit.js\0`,
      });
    });
    expect(rgCall.args).toContain('--files-with-matches');
    expect(rgCall.args).toContain('--max-filesize');
    expect(rgCall.args).not.toContain('--sort');
    const rgResult = await nodeGrep('needle', rgRoot, {
      fixedStrings: true,
      filesOnly: true,
      count: false,
      multiline: false,
      maxResults: 10,
      structured: true,
      candidatePaths,
    });
    expect(rgResult.records.map(record => record.path)).toEqual(['src/hit.js']);

    const dustRoot = tempDir('dust-limit');
    let dustCall;
    const dustRows = await runDust('dust', dustRoot, { depth: 2, limit: 5 },
      async (command, args, options) => {
        dustCall = { command, args, options };
        return processResult({
          stdout: JSON.stringify({
            size: '10B',
            name: dustRoot,
            children: [{ size: '5B', name: join(dustRoot, 'child'), children: [] }],
          }),
        });
      });
    const lineLimit = dustCall.args.indexOf('--number-of-lines');
    expect(lineLimit).toBeGreaterThanOrEqual(0);
    expect(Number(dustCall.args[lineLimit + 1])).toBe(200);
    expect(dustRows.map(row => row.path)).toEqual(['.', 'child']);

    for (const invoke of [
      runner => listFilesWithFd('fd', tempDir('fd-limit'), '**/*', undefined, runner),
      runner => listRipgrepCandidatePaths('rg', tempDir('rg-limit'), {
        pattern: 'needle', fixedStrings: true,
      }, runner),
      runner => runDust('dust', tempDir('dust-output-limit'), {
        depth: 2, limit: 20,
      }, runner),
    ]) {
      let calls = 0;
      const runner = async () => {
        calls += 1;
        return processResult({ truncated: true });
      };
      await expect(invoke(runner)).rejects.toBeInstanceOf(SearchBackendLimitError);
      expect(calls).toBe(1);
    }

    await verifyProcessTermination();
    await verifyWindowsProcessTreeTermination();
    verifyGrepExactBudget();
    await verifyRipgrepRecordFraming();
    await verifyRipgrepFilteredLongLineFraming();
    await verifyRipgrepLongLineStopsDuringCapture();
    await verifyRipgrepAbortReentry();
    const yeaftDir = tempDir('cli-path');
    const systemBin = join(yeaftDir, 'system-bin');
    mkdirSync(systemBin);
    const fdfind = join(systemBin, 'fdfind');
    writeFileSync(fdfind, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const env = { PATH: systemBin };
    const binDir = prependManagedCliBinToPath(yeaftDir, env);
    prependManagedCliBinToPath(yeaftDir, env);
    expect(env.PATH.split(delimiter)).toEqual([binDir, systemBin]);
    const windowsEnv = { Path: systemBin };
    prependManagedCliBinToPath(yeaftDir, windowsEnv, 'win32');
    expect(windowsEnv.PATH).toBe(windowsEnv.Path);
    expect(resolveManagedCliCommand('fd', { yeaftDir, env, platform: 'linux' })).toBe(fdfind);

    const tar = tarArchive('ripgrep-15.2.0/rg', '#!/bin/sh\necho ripgrep 15.2.0\n');
    expect(extractManagedCliBinary(tar, 'ripgrep.tar.gz', 'rg', 'linux').toString())
      .toContain('ripgrep 15.2.0');
    const zip = zipArchive('fd-v10.3.0/fd.exe', Buffer.from('MZ-test-binary'));
    expect(extractManagedCliBinary(zip, 'fd.zip', 'fd', 'win32').toString())
      .toBe('MZ-test-binary');

    if (process.platform !== 'win32') {
      const installDir = tempDir('cli-successful-install');
      const archives = {
        rg: tarArchive('package/rg', '#!/bin/sh\necho ripgrep 15.2.0\n'),
        fd: tarArchive('package/fd', '#!/bin/sh\necho fd 10.3.0\n'),
        dust: tarArchive('package/dust', '#!/bin/sh\necho Dust 1.2.4\n'),
      };
      const originalAssets = {};
      const archiveByFileName = new Map();
      for (const [name, archive] of Object.entries(archives)) {
        originalAssets[name] = managedCliToolSpecs[name].assets['linux-x64'];
        const fileName = originalAssets[name][0];
        managedCliToolSpecs[name].assets['linux-x64'] = [
          fileName,
          createHash('sha256').update(archive).digest('hex'),
        ];
        archiveByFileName.set(fileName, archive);
      }
      try {
        let successfulFetches = 0;
        const installOptions = {
          yeaftDir: installDir,
          platform: 'linux',
          arch: 'x64',
          env: emptyPathEnv(),
          force: true,
          fetchFn: async url => {
            successfulFetches += 1;
            const fileName = String(url).split('/').at(-1);
            return new Response(archiveByFileName.get(fileName));
          },
        };
        const [firstInstall, joinedInstall] = await Promise.all([
          ensureManagedCliTools(installOptions),
          ensureManagedCliTools(installOptions),
        ]);
        expect(firstInstall).toEqual(joinedInstall);
        expect(firstInstall.every(result => result.status === 'installed')).toBe(true);
        expect(successfulFetches).toBe(3);
        const installedState = JSON.parse(
          readFileSync(join(installDir, 'managed-cli.json'), 'utf8'),
        );
        expect(Object.keys(installedState.installations).sort()).toEqual(['dust', 'fd', 'rg']);
        for (const name of ['rg', 'fd', 'dust']) {
          const installation = installedState.installations[name];
          expect(installation).toMatchObject({
            version: managedCliToolSpecs[name].version,
            platform: 'linux',
            arch: 'x64',
            assetFileName: managedCliToolSpecs[name].assets['linux-x64'][0],
            archiveSha256: managedCliToolSpecs[name].assets['linux-x64'][1],
          });
          expect(installation.binarySha256).toBe(
            createHash('sha256')
              .update(readFileSync(join(managedCliBinDir(installDir), name)))
              .digest('hex'),
          );
        }
        const available = await ensureManagedCliTools({
          ...installOptions,
          fetchFn: async () => { throw new Error('valid installs must not redownload'); },
        });
        expect(available.every(result => result.status === 'available')).toBe(true);
      } finally {
        for (const [name, asset] of Object.entries(originalAssets)) {
          managedCliToolSpecs[name].assets['linux-x64'] = asset;
        }
      }

      const windowsInstallDir = tempDir('cli-windows-install');
      const windowsBinDir = managedCliBinDir(windowsInstallDir);
      mkdirSync(windowsBinDir, { recursive: true });
      writeFileSync(join(windowsBinDir, 'fd.exe'), 'old fd binary');
      const windowsScripts = {
        rg: '#!/bin/sh\necho ripgrep 15.2.0\n',
        fd: '#!/bin/sh\necho fd 10.3.0\n',
        dust: '#!/bin/sh\necho dust 1.2.4\n',
      };
      const windowsArchives = Object.fromEntries(Object.entries(windowsScripts).map(([name, script]) => [
        name,
        zipArchive(`package/${name}.exe`, script),
      ]));
      const originalWindowsAssets = {};
      try {
        const windowsArchiveByFileName = new Map();
        for (const [name, archive] of Object.entries(windowsArchives)) {
          originalWindowsAssets[name] = managedCliToolSpecs[name].assets['win32-x64'];
          const fileName = originalWindowsAssets[name][0];
          managedCliToolSpecs[name].assets['win32-x64'] = [
            fileName,
            createHash('sha256').update(archive).digest('hex'),
          ];
          windowsArchiveByFileName.set(fileName, archive);
        }
        const windowsInstall = await ensureManagedCliTools({
          yeaftDir: windowsInstallDir,
          platform: 'win32',
          arch: 'x64',
          env: emptyPathEnv(),
          force: true,
          fetchFn: async url => new Response(
            windowsArchiveByFileName.get(String(url).split('/').at(-1)),
          ),
        });
        expect(windowsInstall.map(result => [result.name, result.status])).toEqual([
          ['rg', 'installed'],
          ['fd', 'installed'],
          ['dust', 'installed'],
        ]);
        for (const [name, script] of Object.entries(windowsScripts)) {
          expect(readFileSync(join(windowsBinDir, `${name}.exe`), 'utf8')).toBe(script);
        }

        const rollbackDir = tempDir('cli-windows-rollback');
        const rollbackBinDir = managedCliBinDir(rollbackDir);
        mkdirSync(rollbackBinDir, { recursive: true });
        const oldRg = 'old rg binary';
        writeFileSync(join(rollbackBinDir, 'rg.exe'), oldRg);
        const rollbackArchives = {
          ...windowsArchives,
          rg: zipArchive(
            'package/rg.exe',
            '#!/bin/sh\nrm -- "$0"\necho ripgrep 15.2.0\n',
          ),
        };
        const rollbackArchiveByFileName = new Map();
        for (const [name, archive] of Object.entries(rollbackArchives)) {
          const fileName = originalWindowsAssets[name][0];
          managedCliToolSpecs[name].assets['win32-x64'] = [
            fileName,
            createHash('sha256').update(archive).digest('hex'),
          ];
          rollbackArchiveByFileName.set(fileName, archive);
        }
        const rollbackInstall = await ensureManagedCliTools({
          yeaftDir: rollbackDir,
          platform: 'win32',
          arch: 'x64',
          env: emptyPathEnv(),
          force: true,
          fetchFn: async url => new Response(
            rollbackArchiveByFileName.get(String(url).split('/').at(-1)),
          ),
        });
        expect(rollbackInstall.find(result => result.name === 'rg')).toMatchObject({
          status: 'failed',
        });
        expect(rollbackInstall.filter(result => result.name !== 'rg')
          .every(result => result.status === 'installed')).toBe(true);
        expect(readFileSync(join(rollbackBinDir, 'rg.exe'), 'utf8')).toBe(oldRg);
        expect(readdirSync(rollbackBinDir).some(name => name.includes('.backup'))).toBe(false);
      } finally {
        for (const [name, asset] of Object.entries(originalWindowsAssets)) {
          managedCliToolSpecs[name].assets['win32-x64'] = asset;
        }
      }
    }

    let unsupportedRequests = 0;
    const unsupported = await ensureManagedCliTools({
      yeaftDir: tempDir('cli-unsupported'),
      platform: 'aix',
      arch: 'ppc64',
      env: emptyPathEnv(),
      force: true,
      fetchFn: async () => {
        unsupportedRequests += 1;
        throw new Error('must not download');
      },
    });
    expect(unsupported.every(result => result.status === 'unsupported')).toBe(true);
    expect(unsupportedRequests).toBe(0);

    const flightDir = tempDir('cli-single-flight');
    const flightBinDir = managedCliBinDir(flightDir);
    mkdirSync(flightBinDir, { recursive: true });
    for (const name of ['rg', 'fd', 'dust']) {
      writeFileSync(join(flightBinDir, name), `#!/bin/sh\necho ${name} 0.0.0\n`, { mode: 0o755 });
    }
    let flightRequests = 0;
    const flightOptions = {
      yeaftDir: flightDir,
      platform: 'linux',
      arch: 'x64',
      env: emptyPathEnv(),
      force: true,
      fetchFn: async () => {
        flightRequests += 1;
        await new Promise(resolve => setTimeout(resolve, 20));
        return new Response(Buffer.from('invalid archive'));
      },
    };
    const [left, right] = await Promise.all([
      ensureManagedCliTools(flightOptions),
      ensureManagedCliTools(flightOptions),
    ]);
    expect(left).toEqual(right);
    expect(flightRequests).toBe(3);

    const cooldownDir = tempDir('cli-cooldown');
    let cooldownRequests = 0;
    const cooldownOptions = {
      yeaftDir: cooldownDir,
      platform: 'linux',
      arch: 'x64',
      env: emptyPathEnv(),
      now: () => 1000,
      fetchFn: async () => {
        cooldownRequests += 1;
        return new Response(Buffer.from('not an official archive'));
      },
    };
    const first = await ensureManagedCliTools({ ...cooldownOptions, force: true });
    const second = await ensureManagedCliTools(cooldownOptions);
    expect(first.every(result => result.status === 'failed')).toBe(true);
    expect(second.every(result => result.status === 'cooldown')).toBe(true);
    expect(cooldownRequests).toBe(3);

    const busyDir = tempDir('cli-busy');
    const busyBinDir = managedCliBinDir(busyDir);
    mkdirSync(busyBinDir, { recursive: true });
    for (const name of ['rg', 'fd', 'dust']) mkdirSync(join(busyBinDir, `.install-${name}.lock`));
    const busyOptions = {
      yeaftDir: busyDir,
      platform: 'linux',
      arch: 'x64',
      env: emptyPathEnv(),
      lockWaitMs: 0,
      fetchFn: async () => { throw new Error('busy must not download'); },
    };
    const busyFirst = await ensureManagedCliTools(busyOptions);
    const busySecond = await ensureManagedCliTools(busyOptions);
    expect(busyFirst.every(result => result.status === 'busy')).toBe(true);
    expect(busySecond.every(result => result.status === 'busy')).toBe(true);
    expect(JSON.parse(readFileSync(join(busyDir, 'managed-cli.json'), 'utf8')).failures).toEqual({});

    if (process.platform !== 'win32') {
      const managedCliModuleUrl = new URL(
        '../../../agent/yeaft/managed-cli.js',
        import.meta.url,
      ).href;
      const runLockWatchdog = (yeaftDir, skipInstall = false) => {
        const script = `
          import { ensureManagedCliTools } from ${JSON.stringify(managedCliModuleUrl)};
          let fetches = 0;
          let timerFired = false;
          setTimeout(() => { timerFired = true; }, 0);
          const env = { ...process.env, PATH: '', YEAFT_SKIP_MANAGED_CLI_INSTALLS: ${skipInstall ? "'true'" : "'false'"} };
          const results = await ensureManagedCliTools({
            yeaftDir: ${JSON.stringify(yeaftDir)},
            platform: 'linux',
            arch: 'x64',
            env,
            force: true,
            lockWaitMs: 0,
            fetchFn: async () => {
              fetches += 1;
              throw new Error('lock watchdog must not download');
            },
          });
          await new Promise(resolve => setTimeout(resolve, 0));
          console.log(JSON.stringify({
            fetches,
            timerFired,
            statuses: results.map(result => result.status),
          }));
        `;
        const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
          cwd: process.cwd(),
          encoding: 'utf8',
          timeout: 1500,
        });
        expect(child.error).toBeUndefined();
        expect(child.signal).toBeNull();
        expect(child.status, child.stderr).toBe(0);
        return JSON.parse(child.stdout.trim());
      };

      const danglingInstallDir = tempDir('cli-dangling-install-lock');
      const danglingInstallBin = managedCliBinDir(danglingInstallDir);
      mkdirSync(danglingInstallBin, { recursive: true });
      const danglingInstallLocks = ['rg', 'fd', 'dust'].map(name => (
        join(danglingInstallBin, `.install-${name}.lock`)
      ));
      for (const lockPath of danglingInstallLocks) {
        symlinkSync(`${lockPath}.missing`, lockPath, 'dir');
      }
      expect(runLockWatchdog(danglingInstallDir)).toEqual({
        fetches: 0,
        timerFired: true,
        statuses: ['busy', 'busy', 'busy'],
      });
      for (const lockPath of danglingInstallLocks) {
        expect(() => lstatSync(lockPath)).toThrow();
      }

      const danglingStateDir = tempDir('cli-dangling-state-lock');
      const danglingStateLock = join(danglingStateDir, '.managed-cli-state.lock');
      symlinkSync(`${danglingStateLock}.missing`, danglingStateLock, 'dir');
      expect(runLockWatchdog(danglingStateDir, true)).toEqual({
        fetches: 0,
        timerFired: true,
        statuses: ['skipped', 'skipped', 'skipped'],
      });
      expect(() => lstatSync(danglingStateLock)).toThrow();

      const directoryLockDir = tempDir('cli-directory-lock-watchdog');
      const directoryLockBin = managedCliBinDir(directoryLockDir);
      mkdirSync(directoryLockBin, { recursive: true });
      for (const name of ['rg', 'fd', 'dust']) {
        mkdirSync(join(directoryLockBin, `.install-${name}.lock`));
      }
      expect(runLockWatchdog(directoryLockDir)).toEqual({
        fetches: 0,
        timerFired: true,
        statuses: ['busy', 'busy', 'busy'],
      });
    }

    const identityDir = tempDir('cli-identity');
    const identityBinDir = managedCliBinDir(identityDir);
    mkdirSync(identityBinDir, { recursive: true });
    for (const name of ['rg', 'fd', 'dust']) {
      writeFileSync(join(identityBinDir, name), `#!/bin/sh\necho ${name} 0.0.0\n`, { mode: 0o755 });
      expect(resolveManagedCliCommand(name, {
        yeaftDir: identityDir, env: emptyPathEnv(), platform: 'linux',
      })).toBeNull();
    }
    const identityEnv = emptyPathEnv();
    prependManagedCliBinToPath(identityDir, identityEnv, 'linux');
    expect(resolveManagedCliCommand('rg', {
      yeaftDir: identityDir, env: identityEnv, platform: 'linux', arch: 'x64',
    })).toBeNull();
    const managedBinAlias = join(identityDir, 'bin-alias');
    symlinkSync(identityBinDir, managedBinAlias, 'dir');
    expect(resolveManagedCliCommand('rg', {
      yeaftDir: identityDir,
      env: { ...process.env, PATH: managedBinAlias },
      platform: 'linux',
      arch: 'x64',
    })).toBeNull();
    let identityFetches = 0;
    const identityResults = await ensureManagedCliTools({
      yeaftDir: identityDir,
      platform: 'linux',
      arch: 'x64',
      env: identityEnv,
      force: true,
      fetchFn: async () => {
        identityFetches += 1;
        return new Response(Buffer.from('invalid repair archive'));
      },
    });
    expect(identityResults.every(result => result.status === 'failed')).toBe(true);
    expect(identityFetches).toBe(3);
    trustManagedCliFixtures(identityDir, ['rg', 'fd', 'dust']);
    expect(resolveManagedCliCommand('rg', {
      yeaftDir: identityDir, env: emptyPathEnv(), platform: 'linux',
    })).toBe(join(identityBinDir, 'rg'));
    const identityStatePath = join(identityDir, 'managed-cli.json');
    const oldVersionState = JSON.parse(readFileSync(identityStatePath, 'utf8'));
    oldVersionState.installations.rg.version = '0.0.0';
    writeFileSync(identityStatePath, `${JSON.stringify(oldVersionState, null, 2)}\n`);
    expect(resolveManagedCliCommand('rg', {
      yeaftDir: identityDir, env: emptyPathEnv(), platform: 'linux',
    })).toBeNull();
    trustManagedCliFixtures(identityDir, ['rg']);
    writeFileSync(join(identityBinDir, 'rg'), '\n# bit flip\n', { flag: 'a' });
    expect(resolveManagedCliCommand('rg', {
      yeaftDir: identityDir, env: emptyPathEnv(), platform: 'linux',
    })).toBeNull();

    if (process.platform !== 'win32') {
      const verifyRejectedManagedAliases = async (aliasKind, createAlias) => {
        const aliasStateDir = tempDir(`cli-${aliasKind}-alias`);
        const aliasManagedBin = managedCliBinDir(aliasStateDir);
        const aliasBin = join(aliasStateDir, 'external-bin');
        const corruptLog = join(aliasStateDir, 'corrupt.log');
        mkdirSync(aliasManagedBin, { recursive: true });
        mkdirSync(aliasBin);
        for (const name of ['rg', 'fd', 'dust']) {
          writeFileSync(
            join(aliasManagedBin, name),
            `#!/bin/sh\necho ${name} >> ${JSON.stringify(corruptLog)}\n${name === 'dust'
              ? "printf '{\"size\":\"0B\",\"name\":\".\",\"children\":[]}'"
              : 'exit 0'}\n`,
            { mode: 0o755 },
          );
        }
        for (const [alias, target] of [
          ['rg', 'rg'],
          ['fd', 'fd'],
          ['fdfind', 'fd'],
          ['dust', 'dust'],
        ]) createAlias(join(aliasManagedBin, target), join(aliasBin, alias));

        const aliasEnv = { ...process.env, PATH: aliasBin };
        const processPathBeforeRepair = process.env.PATH;
        for (const name of ['rg', 'fd', 'dust']) {
          expect(resolveManagedCliCommand(name, {
            yeaftDir: aliasStateDir,
            env: aliasEnv,
            platform: 'linux',
            arch: 'x64',
          })).toBeNull();
        }
        rmSync(join(aliasBin, 'fd'));
        expect(resolveManagedCliCommand('fd', {
          yeaftDir: aliasStateDir,
          env: aliasEnv,
          platform: 'linux',
          arch: 'x64',
        })).toBeNull();
        createAlias(join(aliasManagedBin, 'fd'), join(aliasBin, 'fd'));

        let offlineRepairFetches = 0;
        const offlineRepair = await ensureManagedCliTools({
          yeaftDir: aliasStateDir,
          platform: 'linux',
          arch: 'x64',
          env: aliasEnv,
          force: true,
          fetchFn: async () => {
            offlineRepairFetches += 1;
            throw new Error('offline');
          },
        });
        expect(offlineRepair.every(result => result.status === 'failed')).toBe(true);
        expect(offlineRepairFetches).toBe(3);
        expect(aliasEnv.PATH).toBe(aliasBin);
        expect(process.env.PATH).toBe(processPathBeforeRepair);

        const aliasSearchRoot = tempDir(`cli-${aliasKind}-alias-search`);
        mkdirSync(join(aliasSearchRoot, 'src'));
        writeFileSync(join(aliasSearchRoot, 'src', 'hit.js'), 'needle\n');
        writeFileSync(join(aliasSearchRoot, 'src', 'data.bin'), Buffer.alloc(4096));
        const aliasRegistry = createFullRegistry();
        const aliasContext = {
          cwd: aliasSearchRoot,
          yeaftDir: aliasStateDir,
          managedCliReady: Promise.resolve(offlineRepair),
        };
        const previousProcessPath = process.env.PATH;
        process.env.PATH = aliasBin;
        try {
          expect(await aliasRegistry.execute('Grep', {
            pattern: 'needle',
            path: aliasSearchRoot,
            output_mode: 'content',
            fixed_strings: true,
          }, aliasContext)).toBe('src/hit.js:1:needle');
          expect(await aliasRegistry.execute('Glob', {
            pattern: '**/*.js',
            path: aliasSearchRoot,
          }, aliasContext)).toBe('src/hit.js');
          const aliasDiskUsage = await aliasRegistry.execute('DiskUsage', {
            path: aliasSearchRoot,
            depth: 1,
            limit: 10,
          }, aliasContext);
          expect(aliasDiskUsage).toContain('src');
          expect(aliasDiskUsage).not.toContain('0B  .');
        } finally {
          process.env.PATH = previousProcessPath;
        }
        expect(existsSync(corruptLog)).toBe(false);
        return { aliasContext, aliasRegistry, aliasSearchRoot, aliasStateDir, offlineRepair };
      };

      await verifyRejectedManagedAliases(
        'symlink',
        (target, alias) => symlinkSync(target, alias, 'file'),
      );
      const hardLinkCase = await verifyRejectedManagedAliases('hard-link', linkSync);

      const systemBin = join(hardLinkCase.aliasStateDir, 'system-bin');
      const systemLog = join(hardLinkCase.aliasStateDir, 'system.log');
      mkdirSync(systemBin);
      writeFileSync(join(systemBin, 'rg'), `#!/bin/sh\necho rg >> ${JSON.stringify(systemLog)}\nprintf 'src/hit.js\\0'\n`, { mode: 0o755 });
      writeFileSync(join(systemBin, 'fdfind'), `#!/bin/sh\necho fd >> ${JSON.stringify(systemLog)}\nprintf 'src/hit.js\\0'\n`, { mode: 0o755 });
      writeFileSync(join(systemBin, 'dust'), `#!/bin/sh\necho dust >> ${JSON.stringify(systemLog)}\nprintf '{\"size\":\"4096B\",\"name\":${JSON.stringify(hardLinkCase.aliasSearchRoot)},\"children\":[{\"size\":\"4096B\",\"name\":${JSON.stringify(join(hardLinkCase.aliasSearchRoot, 'src'))},\"children\":[]}]}'\n`, { mode: 0o755 });
      for (const [name, commandName] of [
        ['rg', 'rg'],
        ['fd', 'fdfind'],
        ['dust', 'dust'],
      ]) {
        expect(resolveManagedCliCommand(name, {
          yeaftDir: hardLinkCase.aliasStateDir,
          env: { ...process.env, PATH: systemBin },
          platform: 'linux',
          arch: 'x64',
        })).toBe(join(systemBin, commandName));
      }
      const previousProcessPath = process.env.PATH;
      process.env.PATH = systemBin;
      try {
        expect(await hardLinkCase.aliasRegistry.execute('Grep', {
          pattern: 'needle',
          path: hardLinkCase.aliasSearchRoot,
          output_mode: 'content',
          fixed_strings: true,
        }, hardLinkCase.aliasContext)).toBe('src/hit.js:1:needle');
        expect(await hardLinkCase.aliasRegistry.execute('Glob', {
          pattern: '**/*.js',
          path: hardLinkCase.aliasSearchRoot,
        }, hardLinkCase.aliasContext)).toBe('src/hit.js');
        expect(await hardLinkCase.aliasRegistry.execute('DiskUsage', {
          path: hardLinkCase.aliasSearchRoot,
          depth: 1,
          limit: 10,
        }, hardLinkCase.aliasContext)).toContain('src');
      } finally {
        process.env.PATH = previousProcessPath;
      }
      expect(readFileSync(systemLog, 'utf8').trim().split('\n')).toEqual(['rg', 'fd', 'dust']);
    }

    const root = tempDir('fast-tools');
    mkdirSync(join(root, 'large'));
    mkdirSync(join(root, 'small'));
    writeFileSync(join(root, 'large', 'a.bin'), Buffer.alloc(2048));
    writeFileSync(join(root, 'small', 'b.bin'), Buffer.alloc(32));
    const registry = createFullRegistry();
    const fallbackOutput = await registry.execute('DiskUsage', { path: root, depth: 2, limit: 2 }, {
      cwd: root,
      yeaftDir: join(root, '.fallback'),
      managedCliReady: Promise.resolve([]),
    });
    expect(registry.getToolNames()).toContain('DiskUsage');
    expect(fallbackOutput).toContain('large');
    expect(fallbackOutput.trim().split('\n')).toHaveLength(4);

    if (process.platform !== 'win32') {
      const toolDir = join(root, '.yeaft');
      const toolBinDir = managedCliBinDir(toolDir);
      const log = join(root, 'calls.log');
      mkdirSync(join(root, 'src'), { recursive: true });
      writeFileSync(join(root, 'src', 'a.js'), 'needle\n');
      mkdirSync(toolBinDir, { recursive: true });
      writeFileSync(join(toolBinDir, 'rg'), `#!/bin/sh\necho rg >> ${JSON.stringify(log)}\nprintf 'src/a.js\\000'\n`, { mode: 0o755 });
      writeFileSync(join(toolBinDir, 'fd'), `#!/bin/sh\necho fd >> ${JSON.stringify(log)}\nprintf 'src/a.js\\0src/b.txt\\0'\n`, { mode: 0o755 });
      writeFileSync(join(toolBinDir, 'dust'), `#!/bin/sh\necho dust >> ${JSON.stringify(log)}\nprintf '{"size":"2080B","name":${JSON.stringify(root)},"children":[{"size":"2048B","name":${JSON.stringify(join(root, 'large'))},"children":[]}]}'\n`, { mode: 0o755 });
      trustManagedCliFixtures(toolDir, ['rg', 'fd', 'dust']);
      const neverReady = new Promise(() => {});
      const ctx = { cwd: root, yeaftDir: toolDir, managedCliReady: neverReady };
      expect(await Promise.race([
        registry.execute('Grep', { pattern: 'needle', path: root }, ctx),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Grep waited for unrelated installs')), 500)),
      ])).toContain('src/a.js');
      const globOutput = await Promise.race([
        registry.execute('Glob', { pattern: '**/*.js', path: root }, ctx),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Glob waited for unrelated installs')), 500)),
      ]);
      expect(globOutput).toContain('src/a.js');
      expect(globOutput).not.toContain('b.txt');
      const dustOutput = await Promise.race([
        registry.execute('DiskUsage', { path: root, depth: 2, limit: 2 }, ctx),
        new Promise((_, reject) => setTimeout(() => reject(new Error('DiskUsage waited for unrelated installs')), 500)),
      ]);
      expect(dustOutput).toContain('large');
      expect(readFileSync(log, 'utf8').trim().split('\n')).toEqual(['rg', 'fd', 'dust']);

      const rg = resolveManagedCliCommand('rg', { yeaftDir: toolDir, env: emptyPathEnv() });
      expect(execFileSync(rg, ['--version'], { encoding: 'utf8' })).toContain('src/a.js');
      expect(createHash('sha256').update(readFileSync(rg)).digest('hex')).toHaveLength(64);
      expect(existsSync(rg)).toBe(true);
    }
    const parityRoot = tempDir('search-backend-parity');
    mkdirSync(join(parityRoot, 'src', '.yeaft', 'worktrees', 'nested'), { recursive: true });
    mkdirSync(join(parityRoot, '.yeaft', 'worktrees', 'root'), { recursive: true });
    writeFileSync(join(parityRoot, 'root.txt'), 'needle\n');
    writeFileSync(join(parityRoot, 'src', 'a.js'), 'needle\n');
    writeFileSync(join(parityRoot, 'src', 'a.txt'), 'needle\n');
    writeFileSync(join(parityRoot, 'src', '.yeaft', 'worktrees', 'nested', 'nested.js'), 'needle\n');
    writeFileSync(join(parityRoot, '.yeaft', 'worktrees', 'root', 'root.js'), 'needle\n');
    const realBinDir = managedCliBinDir(parityRoot);
    mkdirSync(realBinDir, { recursive: true });
    const realRg = process.env.YEAFT_TEST_RG;
    const realFd = process.env.YEAFT_TEST_FD;
    const realDust = process.env.YEAFT_TEST_DUST;
    if (realRg && realFd) {
      writeFileSync(join(realBinDir, 'rg'), readFileSync(realRg), { mode: 0o755 });
      writeFileSync(join(realBinDir, 'fd'), readFileSync(realFd), { mode: 0o755 });
      trustManagedCliFixtures(parityRoot, ['rg', 'fd']);
      const fastCtx = { cwd: parityRoot, yeaftDir: parityRoot, managedCliReady: Promise.resolve([]) };
      const fallbackCtx = { cwd: parityRoot, yeaftDir: join(parityRoot, 'fallback'), managedCliReady: Promise.resolve([]) };
      for (const filters of [
        { glob: '**/*.txt', type: 'js' },
        { glob: 'src/**', type: 'js' },
        { glob: '*.{js,txt}' },
        { glob: '**/*.txt' },
      ]) {
        const input = { pattern: 'needle', path: parityRoot, output_mode: 'files_with_matches', fixed_strings: true, ...filters };
        const fast = (await registry.execute('Grep', input, fastCtx)).split('\n').sort();
        const fallback = (await registry.execute('Grep', input, fallbackCtx)).split('\n').sort();
        expect(fast).toEqual(fallback);
      }

      writeFileSync(join(parityRoot, 'src', 'a[0-9].js'), 'needle\n');
      for (const directory of SEARCH_SKIP_DIRS) {
        mkdirSync(join(parityRoot, directory), { recursive: true });
        writeFileSync(join(parityRoot, directory, 'hit.js'), 'needle\n');
      }
      const skipInput = {
        pattern: 'needle', path: parityRoot, glob: '**/*.js',
        output_mode: 'files_with_matches', fixed_strings: true, head_limit: 50,
      };
      expect(await registry.execute('Grep', skipInput, fastCtx))
        .toBe(await registry.execute('Grep', skipInput, fallbackCtx));
      for (const directory of SEARCH_SKIP_DIRS) {
        expect(await registry.execute('Grep', skipInput, fastCtx))
          .not.toContain(`${directory}/hit.js`);
      }
      const literalBracketInput = {
        pattern: 'needle', path: parityRoot, glob: 'a[0-9].js',
        output_mode: 'files_with_matches', fixed_strings: true,
      };
      const literalBracketFast = await registry.execute('Grep', literalBracketInput, fastCtx);
      const literalBracketFallback = await registry.execute('Grep', literalBracketInput, fallbackCtx);
      expect(literalBracketFast).toBe('src/a[0-9].js');
      expect(literalBracketFast).toBe(literalBracketFallback);

      writeFileSync(join(parityRoot, 'src', 'line\nbreak.js'), 'needle\n');
      mkdirSync(join(parityRoot, 'C:'));
      writeFileSync(join(parityRoot, 'C:', 'a.js'), 'needle\n');
      for (const outputMode of ['files_with_matches', 'count', 'content']) {
        const input = {
          pattern: 'needle', path: parityRoot, glob: '**/*.js',
          output_mode: outputMode, fixed_strings: true, head_limit: 20,
        };
        const fast = await registry.execute('Grep', input, fastCtx);
        const fallback = await registry.execute('Grep', input, fallbackCtx);
        expect(fast).toBe(fallback);
        expect(fast).toContain('C:/a.js');
        expect(fast).toContain('src/line\nbreak.js');
      }
      writeFileSync(join(parityRoot, 'src', 'context.js'), 'zero\r\nneedle\r\ntwo\r\n');
      for (const contextOptions of [{}, { context: 1 }, { before: 1 }, { after: 1 }]) {
        const input = {
          pattern: 'needle', path: parityRoot, glob: '**/*.js',
          output_mode: 'content', fixed_strings: true, head_limit: 20,
          ...contextOptions,
        };
        const fast = await registry.execute('Grep', input, fastCtx);
        const fallback = await registry.execute('Grep', input, fallbackCtx);
        expect(fast).toBe(fallback);
        expect(fast).not.toContain('\r');
      }
      writeFileSync(join(parityRoot, 'src', 'count.js'), 'needle needle\nneedle\n');
      const countInput = {
        pattern: 'needle', path: parityRoot, glob: 'count.js',
        output_mode: 'count', fixed_strings: true,
      };
      expect(await registry.execute('Grep', countInput, fastCtx)).toBe('src/count.js:3');
      expect(await registry.execute('Grep', countInput, fastCtx))
        .toBe(await registry.execute('Grep', countInput, fallbackCtx));

      writeFileSync(join(parityRoot, 'src', 'multiline.js'), 'alpha\nbeta\nalpha\nbeta\n');
      for (const outputMode of ['files_with_matches', 'count', 'content']) {
        for (const search of [
          { pattern: 'alpha.*beta', fixed_strings: false, expectedCount: 1 },
          { pattern: 'alpha\nbeta', fixed_strings: true, expectedCount: 2 },
        ]) {
          const input = {
            ...search, path: parityRoot, glob: 'multiline.js',
            output_mode: outputMode, multiline: true, head_limit: 20,
          };
          const fast = await registry.execute('Grep', input, fastCtx);
          const fallback = await registry.execute('Grep', input, fallbackCtx);
          const expected = outputMode === 'files_with_matches'
            ? 'src/multiline.js'
            : outputMode === 'count'
              ? `src/multiline.js:${search.expectedCount}`
              : [1, 2, 3, 4]
                  .map(line => `src/multiline.js:${line}:${line % 2 ? 'alpha' : 'beta'}`)
                  .join('\n');
          expect(fast).toBe(expected);
          expect(fast).toBe(fallback);
        }
      }
      writeFileSync(join(parityRoot, 'src', 'anchor.js'), 'alpha\nbeta\ngamma\n^beta$\n');
      for (const pattern of ['^beta$', '(?m)^beta$']) {
        for (const multiline of [false, true]) {
          for (const outputMode of ['files_with_matches', 'count', 'content']) {
            const input = {
              pattern, path: parityRoot, glob: 'anchor.js',
              output_mode: outputMode, multiline, head_limit: 20,
            };
            const expected = outputMode === 'files_with_matches'
              ? 'src/anchor.js'
              : outputMode === 'count'
                ? 'src/anchor.js:1'
                : 'src/anchor.js:2:beta';
            const fast = await registry.execute('Grep', input, fastCtx);
            const fallback = await registry.execute('Grep', input, fallbackCtx);
            expect(fast).toBe(expected);
            expect(fast).toBe(fallback);
          }
        }
      }
      for (const pattern of ['\\^beta\\$', 'beta[$]']) {
        const input = {
          pattern, path: parityRoot, glob: 'anchor.js',
          output_mode: 'content', multiline: true, head_limit: 20,
        };
        const fast = await registry.execute('Grep', input, fastCtx);
        const fallback = await registry.execute('Grep', input, fallbackCtx);
        expect(fast).toBe('src/anchor.js:4:^beta$');
        expect(fast).toBe(fallback);
      }
      const disabledAnchorInput = {
        pattern: '(?-m)^beta$', path: parityRoot, glob: 'anchor.js',
        output_mode: 'content', multiline: true, head_limit: 20,
      };
      expect(await registry.execute('Grep', disabledAnchorInput, fastCtx)).toBe('(no matches)');
      expect(await registry.execute('Grep', disabledAnchorInput, fallbackCtx)).toBe('(no matches)');

      for (const pattern of [
        '(?-m:^beta$)',
        '(?m:(?-m:^beta$)|^gamma$)',
        '(?m:^beta(?-m:$))',
      ]) {
        for (const outputMode of ['files_with_matches', 'count', 'content']) {
          const input = {
            pattern, path: parityRoot, glob: 'anchor.js',
            output_mode: outputMode, multiline: true, head_limit: 20,
          };
          const fast = await registry.execute('Grep', input, fastCtx);
          const fallback = await registry.execute('Grep', input, fallbackCtx);
          expect(fast).toBe(fallback);
          if (process.version.startsWith('v20.')) expect(fast).toContain('Invalid regular expression');
          else expect(fast).not.toContain('unsupported');
        }
      }

      writeFileSync(join(parityRoot, 'src', 'multiline-crlf.js'), 'alpha\r\nbeta\r\n');
      const scopedCrlfInput = {
        pattern: '(?m:^beta$)', path: parityRoot, glob: 'multiline-crlf.js',
        output_mode: 'content', multiline: false, head_limit: 20,
      };
      const scopedCrlfFast = await registry.execute('Grep', scopedCrlfInput, fastCtx);
      expect(scopedCrlfFast).toBe(await registry.execute('Grep', scopedCrlfInput, fallbackCtx));
      if (!process.version.startsWith('v20.')) expect(scopedCrlfFast).toBe('src/multiline-crlf.js:2:beta');
      for (const multiline of [false, true]) {
        const input = {
          pattern: 'beta$', path: parityRoot, glob: 'multiline-crlf.js',
          output_mode: 'content', multiline, head_limit: 20,
        };
        const fast = await registry.execute('Grep', input, fastCtx);
        expect(fast).toBe('src/multiline-crlf.js:2:beta');
        expect(fast).toBe(await registry.execute('Grep', input, fallbackCtx));
      }
      for (const fixedStrings of [false, true]) {
        for (const outputMode of ['files_with_matches', 'count', 'content']) {
          const input = {
            pattern: 'alpha\nbeta', path: parityRoot, glob: 'multiline-crlf.js',
            output_mode: outputMode, fixed_strings: fixedStrings,
            multiline: true, head_limit: 20,
          };
          expect(await registry.execute('Grep', input, fastCtx)).toBe('(no matches)');
          expect(await registry.execute('Grep', input, fallbackCtx)).toBe('(no matches)');
        }
      }

      writeFileSync(join(parityRoot, 'src', 'isolated-cr.js'), 'alpha\rbeta\n');
      for (const outputMode of ['files_with_matches', 'count', 'content']) {
        const input = {
          pattern: 'alpha.*beta', path: parityRoot, glob: 'isolated-cr.js',
          output_mode: outputMode, multiline: true, head_limit: 20,
        };
        const expected = outputMode === 'files_with_matches'
          ? 'src/isolated-cr.js'
          : outputMode === 'count'
            ? 'src/isolated-cr.js:1'
            : 'src/isolated-cr.js:1:alpha\nsrc/isolated-cr.js:2:beta';
        const fast = await registry.execute('Grep', input, fastCtx);
        const fallback = await registry.execute('Grep', input, fallbackCtx);
        expect(fast).toBe(expected);
        expect(fast).toBe(fallback);
      }

      const zeroLengthRoot = tempDir('grep-zero-length');
      mkdirSync(join(zeroLengthRoot, 'src'));
      writeFileSync(join(zeroLengthRoot, 'src', 'empty.js'), '');
      writeFileSync(join(zeroLengthRoot, 'src', 'only-newline.js'), '\n');
      writeFileSync(join(zeroLengthRoot, 'src', 'middle.js'), 'alpha\n\nbeta\n');
      writeFileSync(join(zeroLengthRoot, 'src', 'trailing.js'), 'alpha\nbeta\n');
      writeFileSync(join(zeroLengthRoot, 'src', 'no-trailing.js'), 'alpha\nbeta');
      writeFileSync(join(zeroLengthRoot, 'src', 'crlf-empty.js'), 'alpha\r\n\r\nbeta\r\n');
      writeFileSync(join(zeroLengthRoot, 'src', 'regex-backref.js'), 'aa\n');
      writeFileSync(join(zeroLengthRoot, 'src', 'regex-legacy.js'), 'Aalpha\n');
      writeFileSync(join(zeroLengthRoot, 'src', 'regex-literal.js'), '(?x)^a b$\n');
      writeFileSync(join(zeroLengthRoot, 'src', 'unicode-only.js'), '界\n');
      const zeroLengthBinDir = managedCliBinDir(zeroLengthRoot);
      mkdirSync(zeroLengthBinDir, { recursive: true });
      writeFileSync(join(zeroLengthBinDir, 'rg'), readFileSync(realRg), { mode: 0o755 });
      trustManagedCliFixtures(zeroLengthRoot, ['rg']);
      const zeroLengthContexts = [
        { cwd: zeroLengthRoot, yeaftDir: zeroLengthRoot, managedCliReady: Promise.resolve([]) },
        { cwd: zeroLengthRoot, yeaftDir: join(zeroLengthRoot, 'fallback'), managedCliReady: Promise.resolve([]) },
      ];
      for (const pattern of [
        '(?m)^$', '(?m)^|$', '\\b', 'a*', 'a?', 'a{0}', 'a{00,2}',
        '(?:alpha|)', '(?:a*)+', '(?<name>a*)', '(?=alpha)',
      ]) {
        for (const outputMode of ['files_with_matches', 'count', 'content']) {
          const input = {
            pattern, path: zeroLengthRoot, glob: '**/*.js',
            output_mode: outputMode, multiline: true, head_limit: 50,
          };
          const outputs = await Promise.all(zeroLengthContexts.map(context => (
            registry.execute('Grep', input, context)
          )));
          expect(outputs[0]).toBe(outputs[1]);
          expect(outputs[0]).not.toContain('Grep failed');
        }
      }
      for (const context of zeroLengthContexts) {
        for (const pattern of ['(?P<name>alpha)', '(?x)^a b$']) {
          expect(await registry.execute('Grep', {
            pattern, path: zeroLengthRoot, glob: 'no-trailing.js',
            output_mode: 'content', multiline: true,
          }, context)).toContain('Invalid regular expression');
        }
        expect(await registry.execute('Grep', {
          pattern: '(?x)^a b$', path: zeroLengthRoot, glob: 'regex-literal.js',
          output_mode: 'content', multiline: true, fixed_strings: true,
        }, context)).toBe('src/regex-literal.js:1:(?x)^a b$');
      }
      let managedCliLookupCount = 0;
      const lookupProbeContext = {
        cwd: zeroLengthRoot,
        get yeaftDir() {
          managedCliLookupCount += 1;
          return zeroLengthRoot;
        },
        managedCliReady: Promise.resolve([]),
      };
      expect(await registry.execute('Grep', {
        pattern: '(?=(a))\\1', path: zeroLengthRoot, glob: 'regex-backref.js',
        output_mode: 'content', multiline: true,
      }, lookupProbeContext)).toBe('src/regex-backref.js:1:aa');
      expect(managedCliLookupCount).toBe(0);
      expect(await registry.execute('Grep', {
        pattern: 'alpha', path: zeroLengthRoot, glob: 'no-trailing.js',
        output_mode: 'content', multiline: false,
      }, lookupProbeContext)).toBe('src/no-trailing.js:1:alpha');
      expect(managedCliLookupCount).toBeGreaterThan(0);
      for (const pattern of ['\ud800', '\0', '\r', '\n']) {
        managedCliLookupCount = 0;
        await registry.execute('Grep', {
          pattern, path: zeroLengthRoot, output_mode: 'content', fixed_strings: true,
        }, lookupProbeContext);
        expect(managedCliLookupCount).toBe(0);
      }

      const eligibilityRoot = tempDir('grep-file-eligibility');
      mkdirSync(join(eligibilityRoot, 'src'));
      writeFileSync(join(eligibilityRoot, 'src', 'large.txt'), `${'x'.repeat(1024 * 1024 + 1)}\nneedle\n`);
      writeFileSync(join(eligibilityRoot, 'src', 'fake.pdf'), 'needle\n');
      writeFileSync(join(eligibilityRoot, 'src', 'invalid.txt'), Buffer.concat([
        Buffer.from('needle\n'), Buffer.from([0xff]),
      ]));
      writeFileSync(join(eligibilityRoot, 'src', 'replacement.txt'), 'x\ufffdy\n');
      const eligibilityBinDir = managedCliBinDir(eligibilityRoot);
      const eligibilityRgLog = join(tmpdir(), `yeaft-rg-candidate-${process.pid}-${Date.now()}.log`);
      managedCliTempDirs.push(eligibilityRgLog);
      mkdirSync(eligibilityBinDir, { recursive: true });
      writeFileSync(join(eligibilityBinDir, 'rg'), `#!/bin/sh\nprintf 'env=%s\\n' "\${RIPGREP_CONFIG_PATH-unset}" >> ${JSON.stringify(eligibilityRgLog)}\nprintf 'arg=%s\\n' "$@" >> ${JSON.stringify(eligibilityRgLog)}\nexec ${JSON.stringify(realRg)} "$@"\n`, { mode: 0o755 });
      trustManagedCliFixtures(eligibilityRoot, ['rg']);
      const eligibilityContexts = [
        { cwd: eligibilityRoot, yeaftDir: eligibilityRoot, managedCliReady: Promise.resolve([]) },
        { cwd: eligibilityRoot, yeaftDir: join(eligibilityRoot, 'fallback'), managedCliReady: Promise.resolve([]) },
      ];
      const hostileRgConfig = join(eligibilityRoot, 'ripgrep.rc');
      writeFileSync(hostileRgConfig, '--max-filesize=1\n--glob=!large.txt\n');
      const previousRgConfig = process.env.RIPGREP_CONFIG_PATH;
      process.env.RIPGREP_CONFIG_PATH = hostileRgConfig;
      try {
        const fast = await registry.execute('Grep', {
          pattern: 'needle', path: eligibilityRoot, glob: 'large.txt',
          output_mode: 'content', fixed_strings: true,
        }, eligibilityContexts[0]);
        const fallback = await registry.execute('Grep', {
          pattern: 'needle', path: eligibilityRoot, glob: 'large.txt',
          output_mode: 'content', fixed_strings: true,
        }, eligibilityContexts[1]);
        expect(fast).toBe('src/large.txt:2:needle');
        expect(fast).toBe(fallback);
        const candidateLog = readFileSync(eligibilityRgLog, 'utf8');
        expect(candidateLog).toContain('env=unset');
        expect(candidateLog).toContain('arg=--no-config');
        expect(candidateLog).toContain('arg=--files-with-matches');
      } finally {
        if (previousRgConfig === undefined) delete process.env.RIPGREP_CONFIG_PATH;
        else process.env.RIPGREP_CONFIG_PATH = previousRgConfig;
      }
      for (const input of [
        { pattern: 'needle', fixed_strings: true },
        { pattern: 'needl.', fixed_strings: false },
      ]) {
        for (const outputMode of ['files_with_matches', 'count', 'content']) {
          const outputs = await Promise.all(eligibilityContexts.map(context => registry.execute('Grep', {
            ...input, path: eligibilityRoot, output_mode: outputMode, head_limit: 50,
          }, context)));
          expect(outputs[0]).toBe(outputs[1]);
          expect(outputs[0]).toContain('src/large.txt');
          expect(outputs[0]).not.toContain('fake.pdf');
          expect(outputs[0]).not.toContain('invalid.txt');
        }
      }
      const surrogateOutputs = await Promise.all(eligibilityContexts.map(context => registry.execute('Grep', {
        pattern: '\ud800', path: eligibilityRoot, output_mode: 'content', fixed_strings: true,
      }, context)));
      expect(surrogateOutputs).toEqual(['(no matches)', '(no matches)']);

      for (const [file, content] of [
        ['empty.txt', ''],
        ['trailing.txt', 'alpha\n'],
        ['crlf.txt', 'alpha\r\nbeta\r\n'],
        ['cr.txt', 'alpha\rbeta\r'],
        ['line-separators.txt', 'alpha\u2028beta\u2029'],
      ]) writeFileSync(join(eligibilityRoot, 'src', file), content);
      for (const [glob, pattern, expectedContent, expectedCount] of [
        ['empty.txt', '(?m)^$', 'src/empty.txt:1:', 1],
        ['trailing.txt', '(?m)^$', 'src/trailing.txt:2:', 1],
        ['crlf.txt', '^beta$', 'src/crlf.txt:2:beta', 1],
        ['cr.txt', '^beta$', 'src/cr.txt:2:beta', 1],
        ['line-separators.txt', '^beta$', 'src/line-separators.txt:2:beta', 1],
      ]) {
        for (const outputMode of ['files_with_matches', 'count', 'content']) {
          const outputs = await Promise.all(eligibilityContexts.map(context => registry.execute('Grep', {
            pattern, path: eligibilityRoot, glob, output_mode: outputMode, multiline: true,
          }, context)));
          const expected = outputMode === 'files_with_matches'
            ? `src/${glob}`
            : outputMode === 'count' ? `src/${glob}:${expectedCount}` : expectedContent;
          expect(outputs).toEqual([expected, expected]);
        }
      }
      for (const context of eligibilityContexts) {
        for (const [outputMode, expected] of [
          ['files_with_matches', 'large.txt'],
          ['count', 'large.txt:1'],
          ['content', 'large.txt:2:needle'],
        ]) {
          expect(await registry.execute('Grep', {
            pattern: 'needle', path: join(eligibilityRoot, 'src', 'large.txt'),
            output_mode: outputMode, fixed_strings: true,
          }, context)).toBe(expected);
        }
      }
      const linkPath = join(eligibilityRoot, 'src', 'large-link.txt');
      symlinkSync(join(eligibilityRoot, 'src', 'large.txt'), linkPath);
      for (const context of eligibilityContexts) {
        expect(await registry.execute('Grep', {
          pattern: 'needle', path: linkPath, output_mode: 'content', fixed_strings: true,
        }, context)).toBe('(no matches)');
      }
      const zeroWidthCounts = await Promise.all(eligibilityContexts.map(context => registry.execute('Grep', {
        pattern: '(?:)', path: eligibilityRoot, glob: 'trailing.txt',
        output_mode: 'count', multiline: true,
      }, context)));
      expect(zeroWidthCounts).toEqual(['src/trailing.txt:7', 'src/trailing.txt:7']);
      for (const [pattern, outputMode, expected] of [
        ['(?:)', 'count', 'src/crlf.txt:14'],
        ['(?:)', 'content', 'src/crlf.txt:1:alpha\nsrc/crlf.txt:2:beta\nsrc/crlf.txt:3:'],
        ['(?m)^$', 'count', 'src/crlf.txt:3'],
        ['(?m)^$', 'content', 'src/crlf.txt:2:\nsrc/crlf.txt:3:'],
        ['$', 'count', 'src/crlf.txt:5'],
        ['$', 'content', 'src/crlf.txt:1:alpha\nsrc/crlf.txt:2:beta\nsrc/crlf.txt:3:'],
      ]) {
        const outputs = await Promise.all(eligibilityContexts.map(context => registry.execute('Grep', {
          pattern, path: eligibilityRoot, glob: 'crlf.txt',
          output_mode: outputMode, multiline: true,
        }, context)));
        expect(outputs).toEqual([expected, expected]);
      }

      const safeRegexCases = [
        { pattern: '(?i)(?m)^BETA$', glob: 'no-trailing.js', expected: 'src/no-trailing.js:2:beta' },
        { pattern: '(?:alpha|beta)+', glob: 'no-trailing.js', expected: 'src/no-trailing.js:1:alpha' },
        { pattern: '(?:alpha)?beta', glob: 'no-trailing.js', expected: 'src/no-trailing.js:2:beta' },
        { pattern: '(?:alpha|beta){1,2}', glob: 'no-trailing.js', expected: 'src/no-trailing.js:1:alpha' },
        { pattern: '(?<name>alpha)', glob: 'no-trailing.js', expected: 'src/no-trailing.js:1:alpha' },
        { pattern: '(?=alpha)alpha', glob: 'no-trailing.js', expected: 'src/no-trailing.js:1:alpha' },
        { pattern: '(?=(a))\\1', glob: 'regex-backref.js', expected: 'src/regex-backref.js:1:aa' },
        { pattern: '(?<=(a))\\1', glob: 'regex-backref.js', expected: 'src/regex-backref.js:1:aa' },
        { pattern: '(?<letter>a)\\k<letter>', glob: 'regex-backref.js', expected: 'src/regex-backref.js:1:aa' },
        { pattern: '\\Aalpha', glob: 'regex-legacy.js', expected: 'src/regex-legacy.js:1:Aalpha' },
        { pattern: '^\\w+$', glob: 'unicode-only.js', expected: '(no matches)' },
        { pattern: '\\b界', glob: 'unicode-only.js', expected: '(no matches)' },
        { pattern: '[a*]+', glob: 'no-trailing.js', expected: 'src/no-trailing.js:1:alpha' },
        { pattern: '\\^', glob: 'no-trailing.js', expected: '(no matches)' },
      ];
      for (const { pattern, glob, expected } of safeRegexCases) {
        const input = {
          pattern, path: zeroLengthRoot, glob,
          output_mode: 'content', multiline: true, head_limit: 50,
        };
        const outputs = await Promise.all(zeroLengthContexts.map(context => (
          registry.execute('Grep', input, context)
        )));
        expect(outputs[0].split('\n')[0]).toBe(expected);
        expect(outputs[0]).toBe(outputs[1]);
      }

      for (const headLimit of [1, 2]) {
        const input = {
          pattern: 'needle', path: parityRoot, glob: '**/*.js',
          output_mode: 'files_with_matches', fixed_strings: true, head_limit: headLimit,
        };
        const fast = await registry.execute('Grep', input, fastCtx);
        const fallback = await registry.execute('Grep', input, fallbackCtx);
        expect(fast).toBe(fallback);
        expect(fast).toContain('(more results omitted)');
      }

      const contextLimitRoot = tempDir('grep-context-limit');
      for (const name of ['a.txt', 'b.txt']) {
        writeFileSync(join(contextLimitRoot, name), `${name}-0\n${name}-1\nHIT\n${name}-3\n${name}-4\n`);
      }
      const contextLimitBin = managedCliBinDir(contextLimitRoot);
      mkdirSync(contextLimitBin, { recursive: true });
      writeFileSync(join(contextLimitBin, 'rg'), readFileSync(realRg), { mode: 0o755 });
      trustManagedCliFixtures(contextLimitRoot, ['rg']);
      const contextLimitContexts = [
        { cwd: contextLimitRoot, yeaftDir: contextLimitRoot, managedCliReady: Promise.resolve([]) },
        { cwd: contextLimitRoot, yeaftDir: join(contextLimitRoot, 'fallback'), managedCliReady: Promise.resolve([]) },
      ];
      for (const contextOptions of [{ before: 2 }, { after: 2 }, { context: 2 }]) {
        for (const headLimit of [1, 2]) {
          const outputs = await Promise.all(contextLimitContexts.map(context => registry.execute('Grep', {
            pattern: 'HIT', path: contextLimitRoot, output_mode: 'content', fixed_strings: true,
            head_limit: headLimit, ...contextOptions,
          }, context)));
          expect(outputs[0]).toBe(outputs[1]);
          expect(outputs[0].split('\n').filter(line => line.endsWith(':3:HIT'))).toHaveLength(headLimit);
          expect(outputs[0]).toContain('a.txt:3:HIT');
          if (headLimit === 2) expect(outputs[0]).toContain('b.txt:3:HIT');
        }
      }
      writeFileSync(join(contextLimitRoot, 'adjacent.txt'), 'HIT\nHIT\nafter\n');
      for (const context of contextLimitContexts) {
        const output = await registry.execute('Grep', {
          pattern: 'HIT', path: contextLimitRoot, glob: 'adjacent.txt',
          output_mode: 'content', fixed_strings: true, after: 2, head_limit: 1,
        }, context);
        expect(output.split('\n').filter(line => line.includes(':HIT'))).toHaveLength(1);
        expect(output).toContain('adjacent.txt:1:HIT');
        expect(output).toContain('adjacent.txt-3-after');
        expect(output).toContain('(more results omitted)');
      }
      rmSync(join(contextLimitRoot, 'adjacent.txt'));
      writeFileSync(join(contextLimitRoot, 'a.txt'), `${'界'.repeat(6000)}\nHIT\n`);
      writeFileSync(join(contextLimitRoot, 'b.txt'), `${'界'.repeat(6000)}\nHIT\n`);
      for (const context of contextLimitContexts) {
        const output = await registry.execute('Grep', {
          pattern: 'HIT', path: contextLimitRoot, output_mode: 'content', fixed_strings: true,
          before: 1, head_limit: 2,
        }, context);
        expect(output).toContain('a.txt:2:HIT');
        expect(output).toContain('b.txt:2:HIT');
        expect(Buffer.byteLength(output)).toBeLessThanOrEqual(32 * 1024);
      }

      const orderingRoot = tempDir('search-order-parity');
      mkdirSync(join(orderingRoot, 'a'));
      writeFileSync(join(orderingRoot, 'z1.js'), 'needle\n');
      writeFileSync(join(orderingRoot, 'z2.js'), 'needle\n');
      writeFileSync(join(orderingRoot, 'z3.js'), 'needle\n');
      writeFileSync(join(orderingRoot, 'a', 'a.js'), 'needle\n');
      const orderingBinDir = managedCliBinDir(orderingRoot);
      mkdirSync(orderingBinDir, { recursive: true });
      writeFileSync(join(orderingBinDir, 'rg'), readFileSync(realRg), { mode: 0o755 });
      trustManagedCliFixtures(orderingRoot, ['rg']);
      const orderingInput = {
        pattern: 'needle', path: orderingRoot, glob: '**/*.js',
        output_mode: 'files_with_matches', fixed_strings: true, head_limit: 1,
      };
      const orderingFast = await registry.execute('Grep', orderingInput, {
        cwd: orderingRoot, yeaftDir: orderingRoot, managedCliReady: Promise.resolve([]),
      });
      const orderingFallback = await registry.execute('Grep', orderingInput, {
        cwd: orderingRoot, yeaftDir: join(orderingRoot, 'fallback'), managedCliReady: Promise.resolve([]),
      });
      expect(orderingFast).toBe('a/a.js\n\n... (more results omitted)');
      expect(orderingFast).toBe(orderingFallback);
      const budgetRoot = tempDir('grep-render-budget');
      mkdirSync(join(budgetRoot, 'src'));
      const exactFirstMatch = `${'界'.repeat(5455)}aa`;
      const exactSecondMatch = `${'界'.repeat(5455)}a`;
      writeFileSync(join(budgetRoot, 'src', 'a.js'), `needle${exactFirstMatch}\n`);
      writeFileSync(join(budgetRoot, 'src', 'b.js'), `needle${exactSecondMatch}\n`);
      const budgetBinDir = managedCliBinDir(budgetRoot);
      mkdirSync(budgetBinDir, { recursive: true });
      writeFileSync(join(budgetBinDir, 'rg'), readFileSync(realRg), { mode: 0o755 });
      trustManagedCliFixtures(budgetRoot, ['rg']);
      const budgetInput = {
        pattern: 'needle', path: budgetRoot, glob: '**/*.js',
        output_mode: 'content', fixed_strings: true, head_limit: 2,
      };
      const budgetContexts = [budgetRoot, join(budgetRoot, 'fallback')];
      for (const yeaftDir of budgetContexts) {
        const output = await registry.execute('Grep', budgetInput, {
          cwd: budgetRoot, yeaftDir, managedCliReady: Promise.resolve([]),
        });
        expect(Buffer.byteLength(output)).toBe(32768);
        expect(output).not.toContain('[Output truncated]');
        expect(output).not.toContain('\ufffd');
      }

      const longMatch = '界'.repeat(5451);
      writeFileSync(join(budgetRoot, 'src', 'a.js'), `needle${longMatch}\n`);
      writeFileSync(join(budgetRoot, 'src', 'b.js'), `needle${longMatch}\n`);
      writeFileSync(join(budgetRoot, 'src', 'c.js'), 'needle\n');
      for (const yeaftDir of budgetContexts) {
        const output = await registry.execute('Grep', budgetInput, {
          cwd: budgetRoot, yeaftDir, managedCliReady: Promise.resolve([]),
        });
        expect(Buffer.byteLength(output)).toBe(32768);
        expect(output).toContain('[Output truncated]');
        expect(output).not.toContain('\ufffd');
      }
      const fastGlob = await registry.execute('Glob', { pattern: '**/*.js', path: parityRoot }, fastCtx);
      const fallbackGlob = await registry.execute('Glob', { pattern: '**/*.js', path: parityRoot }, fallbackCtx);
      expect(fastGlob).toBe(fallbackGlob);
      expect(fastGlob).toContain('src/a.js');
      expect(fastGlob).not.toContain('.yeaft/worktrees');

      const equalMtimeRoot = tempDir('glob-equal-mtime');
      for (const name of ['c.js', 'b.js', 'a.js']) writeFileSync(join(equalMtimeRoot, name), 'value\n');
      const equalTime = new Date('2026-08-01T00:00:00.000Z');
      for (const name of ['c.js', 'b.js', 'a.js']) utimesSync(join(equalMtimeRoot, name), equalTime, equalTime);
      const equalMtimeBin = managedCliBinDir(equalMtimeRoot);
      mkdirSync(equalMtimeBin, { recursive: true });
      writeFileSync(join(equalMtimeBin, 'fd'), '#!/bin/sh\nprintf "c.js\\0b.js\\0a.js\\0"\n', { mode: 0o755 });
      trustManagedCliFixtures(equalMtimeRoot, ['fd']);
      for (const limit of [1, 2]) {
        const input = { pattern: '*.js', path: equalMtimeRoot, limit };
        const fast = await registry.execute('Glob', input, {
          cwd: equalMtimeRoot, yeaftDir: equalMtimeRoot, managedCliReady: Promise.resolve([]),
        });
        const fallback = await registry.execute('Glob', input, {
          cwd: equalMtimeRoot, yeaftDir: join(equalMtimeRoot, 'fallback'), managedCliReady: Promise.resolve([]),
        });
        expect(fast).toBe(fallback);
        expect(fast).toBe(limit === 1 ? 'a.js' : 'a.js\nb.js');
      }

      const specialPathRoot = tempDir('glob-special-paths');
      mkdirSync(join(specialPathRoot, 'src'));
      writeFileSync(join(specialPathRoot, 'src', 'car\rriage.js'), 'value\n');
      writeFileSync(join(specialPathRoot, 'src', 'line\nbreak.js'), 'value\n');
      const specialPathBinDir = managedCliBinDir(specialPathRoot);
      mkdirSync(specialPathBinDir, { recursive: true });
      writeFileSync(join(specialPathBinDir, 'fd'), readFileSync(realFd), { mode: 0o755 });
      trustManagedCliFixtures(specialPathRoot, ['fd']);
      for (const expected of ['src/car\rriage.js', 'src/line\nbreak.js']) {
        const input = { pattern: expected, path: specialPathRoot };
        const fast = await registry.execute('Glob', input, {
          cwd: specialPathRoot, yeaftDir: specialPathRoot, managedCliReady: Promise.resolve([]),
        });
        const fallback = await registry.execute('Glob', input, {
          cwd: specialPathRoot, yeaftDir: join(specialPathRoot, 'fallback'), managedCliReady: Promise.resolve([]),
        });
        expect(fast).toBe(expected);
        expect(fast).toBe(fallback);
      }

      if (realDust) {
        const equalSizeDiskRoot = tempDir('disk-usage-equal-size');
        for (const name of ['A', 'a', 'Z', 'z', 'ä', 'é']) {
          mkdirSync(join(equalSizeDiskRoot, name));
          writeFileSync(join(equalSizeDiskRoot, name, 'data.bin'), Buffer.alloc(16));
        }
        const equalSizeDiskBin = managedCliBinDir(equalSizeDiskRoot);
        mkdirSync(equalSizeDiskBin, { recursive: true });
        writeFileSync(join(equalSizeDiskBin, 'dust'), readFileSync(realDust), { mode: 0o755 });
        trustManagedCliFixtures(equalSizeDiskRoot, ['dust']);
        for (const limit of [2, 3, 6]) {
          const input = { path: equalSizeDiskRoot, depth: 1, limit };
          const fast = await registry.execute('DiskUsage', input, {
            cwd: equalSizeDiskRoot, yeaftDir: equalSizeDiskRoot, managedCliReady: Promise.resolve([]),
          });
          const fallback = await registry.execute('DiskUsage', input, {
            cwd: equalSizeDiskRoot, yeaftDir: join(equalSizeDiskRoot, 'fallback'), managedCliReady: Promise.resolve([]),
          });
          expect(fast).toBe(fallback);
        }

        const diskConcurrencyRoot = tempDir('disk-usage-concurrency');
        let diskLevel = [diskConcurrencyRoot];
        for (let level = 0; level < 3; level += 1) {
          const next = [];
          for (const parent of diskLevel) {
            for (let index = 0; index < 8; index += 1) {
              const child = join(parent, `d${index}`);
              mkdirSync(child);
              next.push(child);
            }
          }
          diskLevel = next;
        }
        let activeFs = 0;
        let maxActiveFs = 0;
        const wrapFs = operation => async (...args) => {
          activeFs += 1;
          maxActiveFs = Math.max(maxActiveFs, activeFs);
          await new Promise(resolve => setTimeout(resolve, 1));
          try { return await operation(...args); } finally { activeFs -= 1; }
        };
        await nodeDiskUsage(diskConcurrencyRoot, 3, 20, undefined, {
          lstat: wrapFs(lstatAsync),
          readdir: wrapFs(readdirAsync),
          stat: wrapFs(statAsync),
        });
        expect(maxActiveFs).toBeLessThanOrEqual(16);
        expect(activeFs).toBe(0);

        const diskAbort = new AbortController();
        activeFs = 0;
        const abortingFs = operation => async (...args) => {
          activeFs += 1;
          await new Promise(resolve => setTimeout(resolve, 5));
          try { return await operation(...args); } finally { activeFs -= 1; }
        };
        const abortedScan = nodeDiskUsage(diskConcurrencyRoot, 3, 20, diskAbort.signal, {
          lstat: abortingFs(lstatAsync),
          readdir: abortingFs(readdirAsync),
          stat: abortingFs(statAsync),
        });
        setImmediate(() => diskAbort.abort('user'));
        await expect(abortedScan).rejects.toMatchObject({ name: 'AbortError' });
        expect(activeFs).toBe(0);

        const symlinkRoot = tempDir('disk-usage-symlink');
        mkdirSync(join(symlinkRoot, 'target'));
        writeFileSync(join(symlinkRoot, 'target', 'data.bin'), Buffer.alloc(16));
        writeFileSync(join(symlinkRoot, 'target-file.bin'), Buffer.alloc(8));
        symlinkSync('target', join(symlinkRoot, 'linkdir'), 'dir');
        symlinkSync('target-file.bin', join(symlinkRoot, 'filelink'), 'file');
        symlinkSync('missing-target', join(symlinkRoot, 'broken'));
        const symlinkBinDir = managedCliBinDir(symlinkRoot);
        mkdirSync(symlinkBinDir, { recursive: true });
        writeFileSync(join(symlinkBinDir, 'dust'), readFileSync(realDust), { mode: 0o755 });
        trustManagedCliFixtures(symlinkRoot, ['dust']);
        const diskInput = { path: symlinkRoot, depth: 2, limit: 20 };
        const fast = await registry.execute('DiskUsage', diskInput, {
          cwd: symlinkRoot, yeaftDir: symlinkRoot, managedCliReady: Promise.resolve([]),
        });
        const fallback = await registry.execute('DiskUsage', diskInput, {
          cwd: symlinkRoot, yeaftDir: join(symlinkRoot, 'fallback'), managedCliReady: Promise.resolve([]),
        });
        const fastLinkRow = fast.split('\n').find(line => line.endsWith('  linkdir'));
        const fallbackLinkRow = fallback.split('\n').find(line => line.endsWith('  linkdir'));
        expect(fastLinkRow).toBeDefined();
        expect(fallbackLinkRow).toBe(fastLinkRow);
        for (const nonDirectoryLink of ['filelink', 'broken']) {
          expect(fast.split('\n').some(line => line.endsWith(`  ${nonDirectoryLink}`))).toBe(false);
          expect(fallback.split('\n').some(line => line.endsWith(`  ${nonDirectoryLink}`))).toBe(false);
        }
        for (const { depth, limit } of [
          { depth: 0, limit: 1 },
          { depth: 1, limit: 2 },
          { depth: 2, limit: 20 },
        ]) {
          const boundedInput = { path: symlinkRoot, depth, limit };
          const boundedFast = await registry.execute('DiskUsage', boundedInput, {
            cwd: symlinkRoot, yeaftDir: symlinkRoot, managedCliReady: Promise.resolve([]),
          });
          const boundedFallback = await registry.execute('DiskUsage', boundedInput, {
            cwd: symlinkRoot, yeaftDir: join(symlinkRoot, 'fallback'), managedCliReady: Promise.resolve([]),
          });
          expect(boundedFast).toBe(boundedFallback);
        }

        const regularFileInput = { path: join(symlinkRoot, 'target-file.bin'), depth: 2, limit: 20 };
        for (const yeaftDir of [symlinkRoot, join(symlinkRoot, 'fallback')]) {
          expect(await registry.execute('DiskUsage', regularFileInput, {
            cwd: symlinkRoot, yeaftDir, managedCliReady: Promise.resolve([]),
          })).toContain('path must be a directory or a directory symlink');
        }

        const rootLink = join(symlinkRoot, 'rootlink');
        symlinkSync(join(symlinkRoot, 'target'), rootLink, 'dir');
        const rootInput = { path: rootLink, depth: 2, limit: 20 };
        const fastRoot = await registry.execute('DiskUsage', rootInput, {
          cwd: symlinkRoot, yeaftDir: symlinkRoot, managedCliReady: Promise.resolve([]),
        });
        const fallbackRoot = await registry.execute('DiskUsage', rootInput, {
          cwd: symlinkRoot, yeaftDir: join(symlinkRoot, 'fallback'), managedCliReady: Promise.resolve([]),
        });
        const fastRootRow = fastRoot.split('\n').find(line => line.endsWith('  .'));
        const fallbackRootRow = fallbackRoot.split('\n').find(line => line.endsWith('  .'));
        expect(fastRootRow).toBeDefined();
        expect(fallbackRootRow).toBe(fastRootRow);
      }
    }

    for (const name of ['Grep', 'Glob', 'DiskUsage']) {
      const controller = new AbortController();
      controller.abort();
      const input = name === 'Grep'
        ? { pattern: 'needle', path: parityRoot }
        : name === 'Glob' ? { pattern: '**/*', path: parityRoot } : { path: parityRoot };
      await expect(registry.execute(name, input, {
        cwd: parityRoot,
        yeaftDir: join(parityRoot, 'fallback'),
        managedCliReady: Promise.resolve([]),
        signal: controller.signal,
      })).rejects.toMatchObject({ name: 'AbortError' });
    }

    const fallbackAbortDir = tempDir('search-fallback-mid-abort');
    for (let dir = 0; dir < 32; dir += 1) {
      const dirPath = join(fallbackAbortDir, `d${dir}`);
      mkdirSync(dirPath);
      for (let file = 0; file < 16; file += 1) {
        writeFileSync(join(dirPath, `f${file}.txt`), 'needle\n');
      }
    }
    for (const name of ['Grep', 'Glob', 'DiskUsage']) {
      const controller = new AbortController();
      const input = name === 'Grep'
        ? { pattern: 'needle', path: fallbackAbortDir }
        : name === 'Glob' ? { pattern: '**/*.txt', path: fallbackAbortDir } : { path: fallbackAbortDir };
      const pending = registry.execute(name, input, {
        cwd: fallbackAbortDir,
        yeaftDir: join(fallbackAbortDir, 'missing'),
        managedCliReady: Promise.resolve([]),
        signal: controller.signal,
      });
      setImmediate(() => controller.abort('user'));
      await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    }

    if (process.platform !== 'win32') {
      const abortDir = tempDir('search-mid-abort');
      const abortBinDir = managedCliBinDir(abortDir);
      mkdirSync(abortBinDir, { recursive: true });
      for (const name of ['rg', 'fd', 'dust']) {
        writeFileSync(join(abortBinDir, name), '#!/bin/sh\ntrap "exit 130" TERM\nwhile :; do :; done\n', { mode: 0o755 });
      }
      trustManagedCliFixtures(abortDir, ['rg', 'fd', 'dust']);
      for (const name of ['Grep', 'Glob', 'DiskUsage']) {
        const controller = new AbortController();
        const input = name === 'Grep'
          ? { pattern: 'needle', path: abortDir }
          : name === 'Glob' ? { pattern: '**/*', path: abortDir } : { path: abortDir };
        const pending = registry.execute(name, input, {
          cwd: abortDir,
          yeaftDir: abortDir,
          managedCliReady: Promise.resolve([]),
          signal: controller.signal,
        });
        setTimeout(() => controller.abort('user'), 20);
        await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
      }
    }
    await verifyRipgrepParity();
  }, 120_000);
});
