import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ctx from '../../../agent/context.js';
import { loadConfig, loadMCPConfig, normalizeLlmRetry, normaliseTelemetrySection } from '../../../agent/yeaft/config.js';
import { getPluginConfig, getTelemetrySettings, updatePluginConfig, updateTelemetrySettings } from '../../../agent/yeaft/config-api.js';
import { handleMessage } from '../../../agent/connection/message-router.js';
import { flushAllAgentPerfTraces } from '../../../agent/yeaft/perf-trace.js';
import { NullTrace } from '../../../agent/yeaft/debug-trace.js';
import { closeConversationHistoryIndexes } from '../../../agent/yeaft/conversation/history-index.js';
import { estimateTokens } from '../../../agent/yeaft/dream/segment.js';
import { buildPluginCatalog } from '../../../agent/yeaft/plugins.js';
import { loadSession } from '../../../agent/yeaft/session.js';
import { MCPManager } from '../../../agent/yeaft/mcp.js';
import { __testGetOrCreateVpEngine, __testHooks, __testLoadPluginCatalogMcpConfig, __testResetVpState, __testResolveVpEffectiveConfig, __testSetSession, handleYeaftCreateSession, handleYeaftLoadHistoryOutline, handleYeaftSubAgentPrompt, handleYeaftTaskCancel, handleYeaftVpSubscribe, refreshLiveSessionConfig } from '../../../agent/yeaft/web-bridge.js';
import { _resetAgentRegistry, getAgentRegistry } from '../../../agent/yeaft/tools/agent.js';
import { loadSessionConfig, normalizeSessionConfig, resolveSessionConfig, saveSessionConfig } from '../../../agent/yeaft/sessions/session-config.js';
import { createSession } from '../../../agent/yeaft/sessions/session-store.js';
import { registerSessionWorkDir, renameSession, sessionsRoot, snapshotSessions, updateSessionConfig } from '../../../agent/yeaft/sessions/session-crud.js';
import {
  createProject,
  deleteProject,
  loadProjects,
  moveSessionToProject,
  removeSessionFromProjects,
  renameProject,
  reorderProjects,
  sharedSessionIdsForProject,
  updateProjectInstruction,
} from '../../../agent/yeaft/projects/store.js';

const roots = [];
const originalConfig = ctx.CONFIG;

function tempRoot(prefix) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function makeDir() {
  return tempRoot('yeaft-session-config-');
}

function createProjectSessionArtifact(root, workDir, sessionId = 'session-workdir-config') {
  const projectYeaftDir = join(workDir, '.yeaft');
  createSession(sessionsRoot(root), {
    id: sessionId,
    name: 'Stale agent-local session',
    roster: [],
    defaultVpId: null,
  }).close();
  createSession(sessionsRoot(projectYeaftDir), {
    id: sessionId,
    name: 'Ignored project session artifact',
    roster: [],
    defaultVpId: null,
    workDir,
  }).close();
  registerSessionWorkDir(root, sessionId, workDir);
  return { projectYeaftDir, sessionId };
}

afterEach(async () => {
  flushAllAgentPerfTraces();
  await __testResetVpState();
  await closeConversationHistoryIndexes();
  ctx.CONFIG = originalConfig;
  __testSetSession(null);
  _resetAgentRegistry();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 });
});

describe('Yeaft session-scoped model config', () => {
  it('normalizes and persists bounded telemetry settings without touching other config', () => {
    expect(normaliseTelemetrySection({
      enabled: false,
      retentionDays: 0,
      flushIntervalMs: 99_999,
      maxQueueSize: 1,
      rawExchangeMaxBytes: 99 * 1024 * 1024,
      traceTextMaxBytes: -1,
      ignored: true,
    })).toEqual({
      enabled: false,
      retentionDays: 1,
      flushIntervalMs: 60_000,
      maxQueueSize: 100,
      rawExchangeMaxBytes: 4 * 1024 * 1024,
      traceTextMaxBytes: 0,
    });
    const root = makeDir();
    writeFileSync(join(root, 'config.json'), JSON.stringify({ primaryModel: 'proxy/model', debug: true }));
    expect(updateTelemetrySettings({ flushIntervalMs: 250, rawExchangeMaxBytes: 65_536 }, root)).toMatchObject({
      flushIntervalMs: 250,
      rawExchangeMaxBytes: 65_536,
    });
    expect(getTelemetrySettings(root)).toMatchObject({ flushIntervalMs: 250, rawExchangeMaxBytes: 65_536 });
    const persisted = JSON.parse(readFileSync(join(root, 'config.json'), 'utf8'));
    expect(persisted.primaryModel).toBe('proxy/model');
    expect(persisted.debug).toBe(true);
    expect(persisted.telemetry).toMatchObject({ flushIntervalMs: 250 });
  });

  it('rejects malformed plugin config reads and preserves the file on save attempts', () => {
    const root = makeDir();
    const configPath = join(root, 'config.json');
    const malformed = '{"plugins":{"tools":["FileRead"]}';
    writeFileSync(configPath, malformed);

    expect(getPluginConfig(root)).toMatchObject({ error: expect.stringContaining('Failed to read plugin config') });
    expect(updatePluginConfig({ tools: ['Bash'] }, root)).toMatchObject({
      error: expect.stringContaining('Failed to read plugin config'),
    });
    expect(readFileSync(configPath, 'utf8')).toBe(malformed);
  });

  it('disables bridge traces through the telemetry update message immediately', async () => {
    const root = makeDir();
    writeFileSync(join(root, 'config.json'), JSON.stringify({
      primaryModel: 'session-test/gpt-5',
      telemetry: { enabled: true, flushIntervalMs: 60_000 },
    }, null, 2));
    const previousTransport = {
      ws: ctx.ws,
      serverEncryptionRequired: ctx.serverEncryptionRequired,
      outboundSendQueue: ctx.outboundSendQueue,
      outboundSendQueueActive: ctx.outboundSendQueueActive,
    };
    const sent = [];
    ctx.CONFIG = { yeaftDir: root, telemetry: { enabled: true, flushIntervalMs: 60_000 } };
    ctx.ws = { readyState: 1, send(raw) { sent.push(JSON.parse(raw)); } };
    ctx.serverEncryptionRequired = false;
    ctx.outboundSendQueue = [];
    ctx.outboundSendQueueActive = false;

    try {
      await handleMessage({ type: 'update_telemetry_settings', settings: { enabled: false } });
      await new Promise(resolve => setImmediate(resolve));
      expect(ctx.CONFIG.telemetry).toMatchObject({ enabled: false });
      expect(sent).toContainEqual(expect.objectContaining({
        type: 'telemetry_settings_updated',
        enabled: false,
      }));

      await handleYeaftLoadHistoryOutline({
        type: 'yeaft_load_history_outline',
        sessionId: 'session-telemetry-disabled',
        perfTraceId: 'trace-disabled-bridge',
      });
      await new Promise(resolve => setImmediate(resolve));
      flushAllAgentPerfTraces();
      expect(existsSync(join(root, 'perf-traces'))).toBe(false);
    } finally {
      ctx.ws = previousTransport.ws;
      ctx.serverEncryptionRequired = previousTransport.serverEncryptionRequired;
      ctx.outboundSendQueue = previousTransport.outboundSendQueue;
      ctx.outboundSendQueueActive = previousTransport.outboundSendQueueActive;
    }
  });

  it('keeps model and effort isolated per Session', async () => {
    expect(normalizeLlmRetry(null, null)).toMatchObject({
      maxRetries: 3,
      streamIdleTimeoutMs: 90_000,
    });
    const root = makeDir();
    const userConfig = {
      model: 'proxy/gpt-5',
      primaryModel: 'proxy/gpt-5',
      modelEffort: 'medium',
      providers: [{ name: 'proxy', models: ['gpt-5', 'claude-opus-4.8'] }],
    };

    mkdirSync(join(root, 'sessions', 'session-a'), { recursive: true });
    mkdirSync(join(root, 'sessions', 'session-b'), { recursive: true });
    saveSessionConfig(root, 'session-a', { model: 'github-copilot/gpt-5.5', modelEffort: 'minimal' });
    saveSessionConfig(root, 'session-b', { model: 'github-copilot/claude-opus-4.8', modelEffort: 'max' });

    const configA = resolveSessionConfig(userConfig, loadSessionConfig(root, 'session-a'));
    const configB = resolveSessionConfig(userConfig, loadSessionConfig(root, 'session-b'));

    expect(configA.model).toBe('github-copilot/gpt-5.5');
    expect(configA.primaryModel).toBe('github-copilot/gpt-5.5');
    expect(configA.modelEffort).toBe('minimal');
    expect(configB.model).toBe('github-copilot/claude-opus-4.8');
    expect(configB.primaryModel).toBe('github-copilot/claude-opus-4.8');
    expect(configB.modelEffort).toBe('max');

    // Simulate an already-loaded runtime whose MCP manager still reflects the
    // pre-CRUD connection set. The catalog must read the saved Agent config.
    const staleMcpManager = {
      status: () => [{ name: 'stale-runtime', ready: true, toolCount: 1 }],
    };
    __testSetSession({
      yeaftDir: root,
      config: { dir: root },
      toolRegistry: null,
      skillManager: null,
      mcpManager: staleMcpManager,
    });
    writeFileSync(join(root, 'config.json'), `${JSON.stringify({
      mcpServers: [
        { name: 'github', command: 'node', args: ['github.js'] },
        { name: 'slack', command: 'node', args: ['slack.js'] },
      ],
    }, null, 2)}\n`);
    const firstCatalog = __testLoadPluginCatalogMcpConfig(root);
    expect(firstCatalog.servers.map(server => server.name)).toEqual(expect.arrayContaining(['github', 'slack']));
    expect(firstCatalog.servers.map(server => server.name)).not.toContain('stale-runtime');

    writeFileSync(join(root, 'config.json'), `${JSON.stringify({
      mcpServers: [{ name: 'github', command: 'node', args: ['github-v2.js'] }],
    }, null, 2)}\n`);
    const refreshedCatalog = __testLoadPluginCatalogMcpConfig(root);
    expect(refreshedCatalog.servers.find(server => server.name === 'github')).toMatchObject({
      args: ['github-v2.js'],
    });
    expect(refreshedCatalog.servers.map(server => server.name)).not.toContain('slack');

    writeFileSync(join(root, 'config.json'), `${JSON.stringify({ providers: [] }, null, 2)}\n`);
    writeFileSync(join(root, 'mcp.json'), `${JSON.stringify({
      servers: [{ name: 'legacy', command: 'node', args: ['legacy.js'] }],
    }, null, 2)}\n`);
    const legacyCatalog = __testLoadPluginCatalogMcpConfig(root);
    expect(legacyCatalog.servers).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'legacy', args: ['legacy.js'] }),
    ]));

    writeFileSync(join(root, 'config.json'), `${JSON.stringify({ mcpServers: [] }, null, 2)}\n`);
    const explicitEmptyCatalog = __testLoadPluginCatalogMcpConfig(root);
    expect(explicitEmptyCatalog.servers).toEqual([]);
    expect(loadMCPConfig(root, undefined).servers.map(server => server.name)).not.toContain('legacy');
    expect(buildPluginCatalog({
      mcpConfig: explicitEmptyCatalog,
      mcpManager: staleMcpManager,
    }).mcpServers).toEqual([]);

    const alpha = createProject(root, 'Alpha');
    const beta = createProject(root, 'Beta');
    expect(reorderProjects(root, [beta.id, alpha.id]).map(project => project.id))
      .toEqual([beta.id, alpha.id]);
    expect(loadProjects(root).map(project => project.id)).toEqual([beta.id, alpha.id]);
    expect(() => reorderProjects(root, [alpha.id])).toThrow('Complete Project order is required');
    expect(() => reorderProjects(root, [alpha.id, alpha.id])).toThrow('Complete Project order is required');
    expect(loadProjects(root).map(project => project.id)).toEqual([beta.id, alpha.id]);
    reorderProjects(root, [alpha.id, beta.id]);
    moveSessionToProject(root, 'session-a', alpha.id);
    moveSessionToProject(root, 'session-b', alpha.id);
    moveSessionToProject(root, 'session-a', beta.id);
    expect(loadProjects(root)).toEqual([
      expect.objectContaining({ id: alpha.id, sessionIds: ['session-b'] }),
      expect.objectContaining({ id: beta.id, sessionIds: ['session-a'] }),
    ]);
    moveSessionToProject(root, 'session-b', beta.id);
    expect(sharedSessionIdsForProject(root, 'session-a')).toEqual(['session-b']);
    const siblingSummary = join(root, 'memory', 'sessions', 'session-b');
    mkdirSync(siblingSummary, { recursive: true });
    writeFileSync(join(siblingSummary, 'summary.zh.md'), '共享发布决策\n');
    expect(await __testHooks.sharedProjectContext(root, 'session-a', { language: 'zh' }))
      .toBe('[Session session-b]\n共享发布决策');
    expect(await __testHooks.sharedProjectContext(root, 'session-a', {
      language: 'zh',
      sessionIds: [],
    })).toBe('');
    expect(__testHooks.normalizeProjectContext({
      projectId: beta.id,
      projectName: 'Beta',
      projectInstruction: '  Use the shared release checklist.  ',
      sessionIds: ['session-a', 'session-b', 'session-b'],
    }, 'session-a')).toEqual({
      projectId: beta.id,
      projectName: 'Beta',
      projectInstruction: 'Use the shared release checklist.',
      sessionIds: ['session-b'],
    });
    __testHooks.handleProjectContextSyncForTest({
      contexts: [{
        sessionId: 'session-a',
        projectContext: {
          projectId: beta.id,
          projectName: 'Beta',
          projectInstruction: 'Use the shared release checklist.',
          sessionIds: ['session-a', 'session-b'],
        },
      }],
    });
    expect(__testHooks.projectContextForSessionForTest('session-a')).toEqual({
      projectId: beta.id,
      projectName: 'Beta',
      projectInstruction: 'Use the shared release checklist.',
      sessionIds: ['session-b'],
    });
    const bridgeAgent = {
      id: 'agent-project-prompt',
      name: 'project-prompt',
      status: 'idle',
      parentSessionId: 'session-a',
      parentVpId: 'vp-project',
      parentThreadId: 'main',
      pendingPrompts: [],
      messages: [],
    };
    getAgentRegistry().set(bridgeAgent.id, bridgeAgent);
    __testSetSession({
      taskManager: {
        getTask(sessionId, taskId) {
          return sessionId === 'session-a' && taskId === 'task-project'
            ? {
                id: taskId,
                kind: 'sub_agent',
                status: 'running',
                ownerVpId: 'vp-project',
                runtime: { subAgentId: bridgeAgent.id },
                source: { threadId: 'main' },
              }
            : null;
        },
        refreshTaskLog() {},
      },
    });
    handleYeaftSubAgentPrompt({
      sessionId: 'session-a',
      taskId: 'task-project',
      subAgentId: bridgeAgent.id,
      message: 'use current Project context',
    });
    expect(bridgeAgent.pendingPrompts[0]).toEqual({
      prompt: 'use current Project context',
      projectSessionIds: ['session-b'],
      projectLabel: `Beta (${beta.id})`,
      projectInstruction: 'Use the shared release checklist.',
    });
    __testHooks.handleProjectContextSyncForTest({
      contexts: [{ sessionId: 'session-a', projectContext: null }],
    });
    handleYeaftSubAgentPrompt({
      sessionId: 'session-a',
      taskId: 'task-project',
      subAgentId: bridgeAgent.id,
      message: 'clear Project context',
    });
    expect(bridgeAgent.pendingPrompts[1]).toEqual({
      prompt: 'clear Project context',
      projectSessionIds: [],
      projectLabel: '',
      projectInstruction: '',
    });

    const abortController = new AbortController();
    bridgeAgent.status = 'running';
    bridgeAgent.abortController = abortController;
    const completedTask = {
      id: 'task-project',
      sessionId: 'session-a',
      kind: 'sub_agent',
      status: 'cancelled',
      ownerVpId: 'vp-project',
      runtime: { subAgentId: bridgeAgent.id },
      source: { threadId: 'main' },
    };
    const completeTask = vi.fn(() => completedTask);
    __testSetSession({
      taskManager: {
        getTask: () => ({ ...completedTask, status: 'running' }),
        completeTask,
        cancelTask: vi.fn(),
      },
    });
    handleYeaftTaskCancel({
      sessionId: 'session-a',
      taskId: 'task-project',
      clientRequestId: 'stop-project-agent',
    });
    expect(abortController.signal.aborted).toBe(true);
    expect(abortController.signal.reason).toBe('stopped_by_user');
    expect(bridgeAgent.status).toBe('closed');
    expect(completeTask).toHaveBeenCalledWith('session-a', 'task-project', { status: 'cancelled' });
    expect(ctx.messageBuffer.some(frame => frame.event?.type === 'yeaft_task_cancel_result'
      && frame.event.success === true
      && frame.event.task?.status === 'cancelled')).toBe(true);

    expect(__testHooks.buildProjectSharedBlock({
      projectId: beta.id,
      projectName: 'Beta',
      sessionIds: [],
    })).toContain(`Project: Beta (${beta.id})`);
    expect(__testHooks.buildProjectSharedBlock({
      projectId: beta.id,
      projectName: 'Beta',
      sessionIds: ['session-b'],
    }, '[Session session-b]\n共享发布决策')).toContain('this Project on this Agent only');
    expect(await __testHooks.sharedProjectContext(root, 'session-outside', {
      language: 'zh',
      sessionIds: ['session-b'],
    })).toBe('[Session session-b]\n共享发布决策');
    rmSync(join(siblingSummary, 'summary.zh.md'));
    writeFileSync(join(siblingSummary, 'summary.md'), 'English fallback decision\n');
    expect(await __testHooks.sharedProjectContext(root, 'session-a', { language: 'zh' }))
      .toBe('[Session session-b]\nEnglish fallback decision');
    writeFileSync(join(siblingSummary, 'memory.md'), 'private transcript and tool output\n');
    expect(await __testHooks.sharedProjectContext(root, 'session-a', { language: 'zh' }))
      .not.toContain('private transcript and tool output');
    writeFileSync(join(siblingSummary, 'summary.md'), 'x'.repeat(32_000));
    const smallBudgetContext = await __testHooks.sharedProjectContext(root, 'session-a', { tokenBudget: 64 });
    expect(smallBudgetContext).toContain('[Summary truncated to Project context budget]');
    expect(estimateTokens(smallBudgetContext)).toBeLessThanOrEqual(64);
    const defaultBudgetContext = await __testHooks.sharedProjectContext(root, 'session-a');
    expect(defaultBudgetContext).toContain('[Summary truncated to Project context budget]');
    expect(estimateTokens(defaultBudgetContext)).toBeLessThanOrEqual(4096);
    expect(estimateTokens(defaultBudgetContext)).toBeGreaterThan(64);
    renameProject(root, beta.id, 'Beta 2');
    updateProjectInstruction(root, beta.id, '  Follow the Project release checklist.  ');
    removeSessionFromProjects(root, 'session-a');
    expect(loadProjects(root)[1]).toEqual(expect.objectContaining({
      name: 'Beta 2',
      instruction: 'Follow the Project release checklist.',
      sessionIds: ['session-b'],
    }));
    expect(() => updateProjectInstruction(root, beta.id, 'x'.repeat(20_001)))
      .toThrow('must not exceed 20000 characters');
    deleteProject(root, beta.id);
    expect(loadProjects(root).map(project => project.id)).toEqual([alpha.id]);
  });


  it('connects only allowlisted MCP servers for a normal Session', async () => {
    const root = makeDir();
    writeFileSync(join(root, 'config.json'), `${JSON.stringify({
      providers: [{
        name: 'test-provider',
        baseUrl: 'https://example.invalid/v1',
        apiKey: 'test-key',
        protocol: 'openai-responses',
        models: ['gpt-5'],
      }],
      primaryModel: 'test-provider/gpt-5',
      plugins: { mcpServers: ['github'] },
      mcpServers: [
        { name: 'github', command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'] },
        { name: 'slack', command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'] },
      ],
    }, null, 2)}\n`);

    const connected = [];
    const originalConnectAll = MCPManager.prototype.connectAll;
    const originalDisconnectAll = MCPManager.prototype.disconnectAll;
    MCPManager.prototype.connectAll = async function connectAll(servers) {
      connected.push(...servers.map(server => server.name));
      return { connected: servers.map(server => server.name), failed: [] };
    };
    MCPManager.prototype.disconnectAll = async function disconnectAll() {};
    let session = null;
    try {
      session = await loadSession({ dir: root, skipSkills: true });
      expect(connected).toEqual(['github']);
      expect(session.status.mcpServers).toEqual(['github']);
    } finally {
      await session?.shutdown?.();
      MCPManager.prototype.connectAll = originalConnectAll;
      MCPManager.prototype.disconnectAll = originalDisconnectAll;
    }
  });

  it('uses the user-level Session config for reads, writes, and metadata updates', () => {
    {
      const root = makeDir();
      const workDir = tempRoot('yeaft-session-config-workdir-');
      const { projectYeaftDir, sessionId } = createProjectSessionArtifact(root, workDir, 'session-workdir-first');

      writeFileSync(join(projectYeaftDir, 'sessions', sessionId, 'config.json'), `${JSON.stringify({ model: 'project/claude-sonnet', modelEffort: 'high' }, null, 2)}\n`);
      writeFileSync(join(root, 'sessions', sessionId, 'config.json'), `${JSON.stringify({ model: 'agent/gpt-5', modelEffort: 'low' }, null, 2)}\n`);

      const config = loadSessionConfig(root, sessionId);

      expect(config).toEqual({ model: 'agent/gpt-5', modelEffort: 'low' });
    }

    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-07-29T10:00:00.000Z'));
      const root = makeDir();
      const workDir = tempRoot('yeaft-session-config-workdir-');
      const { projectYeaftDir, sessionId } = createProjectSessionArtifact(root, workDir, 'session-workdir-update');
      writeFileSync(join(projectYeaftDir, 'sessions', sessionId, 'config.json'), `${JSON.stringify({ model: 'project/stale', modelEffort: 'low' }, null, 2)}\n`);
      expect(snapshotSessions(root).find(session => session.id === sessionId).metadataUpdatedAt)
        .toBe('2026-07-29T10:00:00.000Z');

      vi.setSystemTime(new Date('2026-07-29T11:00:00.000Z'));
      renameSession(root, sessionId, 'Renamed');
      expect(snapshotSessions(root).find(session => session.id === sessionId).metadataUpdatedAt)
        .toBe('2026-07-29T11:00:00.000Z');

      vi.setSystemTime(new Date('2026-07-29T12:00:00.000Z'));
      const saved = updateSessionConfig(root, sessionId, { model: 'agent/claude-haiku', modelEffort: 'max' });

      expect(saved).toEqual({ model: 'agent/claude-haiku', modelEffort: 'max' });
      expect(loadSessionConfig(root, sessionId)).toEqual({ model: 'agent/claude-haiku', modelEffort: 'max' });
      expect(JSON.parse(readFileSync(join(projectYeaftDir, 'sessions', sessionId, 'config.json'), 'utf8')))
        .toEqual({ model: 'project/stale', modelEffort: 'low' });
      expect(JSON.parse(readFileSync(join(root, 'sessions', sessionId, 'config.json'), 'utf8')))
        .toEqual({ model: 'agent/claude-haiku', modelEffort: 'max', modelSource: 'explicit' });
      expect(snapshotSessions(root).find(session => session.id === sessionId).metadataUpdatedAt)
        .toBe('2026-07-29T12:00:00.000Z');
    } finally {
      vi.useRealTimers();
    }

    const provenanceRoot = makeDir();
    mkdirSync(join(provenanceRoot, 'sessions', 'session-provenance'), { recursive: true });
    expect(() => saveSessionConfig(provenanceRoot, 'session-provenance', {
      model: 'github-copilot/gpt-new',
      modelSource: 'explicit',
    })).toThrow('unknown config key: modelSource');
  });


  it('rebuilds the live normal Session runtime with the updated MCP allowlist', async () => {
    const root = makeDir();
    const connectedByRuntime = [];
    const disconnectedRuntimes = [];
    let nextRuntimeId = 0;
    const createMcpManager = () => {
      const id = ++nextRuntimeId;
      return {
        async connectAll(servers) {
          connectedByRuntime.push({ id, servers: servers.map(server => server.name) });
          return { connected: servers.map(server => server.name), failed: [] };
        },
        async disconnectAll() { disconnectedRuntimes.push(id); },
        status: () => [],
      };
    };
    const liveSession = {
      yeaftDir: root,
      config: {
        dir: root,
        model: 'test-provider/gpt-5',
        primaryModel: 'test-provider/gpt-5',
        plugins: { mcpServers: ['github'] },
      },
      adapter: { refreshProviders() {} },
      engine: { refreshConfig: vi.fn() },
      trace: { refreshConfig() {} },
      toolRegistry: { size: 0, replaceMcpTools: vi.fn(() => ({})) },
      skillManager: { size: 0, list: () => [] },
      mcpManager: { disconnectAll: vi.fn() },
      status: {},
    };
    writeFileSync(join(root, 'config.json'), `${JSON.stringify({
      providers: [{
        name: 'test-provider',
        baseUrl: 'https://example.invalid/v1',
        apiKey: 'test-key',
        protocol: 'openai-responses',
        models: ['gpt-5'],
      }],
      primaryModel: 'test-provider/gpt-5',
      mcpServers: [
        { name: 'github', command: 'github' },
        { name: 'slack', command: 'slack' },
      ],
      plugins: { mcpServers: ['slack'] },
    }, null, 2)}\n`);
    ctx.CONFIG = { yeaftDir: root };
    __testSetSession(liveSession);
    __testHooks.setRuntimeFactoriesForTest({
      createSkillManager: () => ({ size: 0, list: () => [] }),
      createMcpManager,
      loadMcpConfig: () => ({
        servers: [
          { name: 'github', command: 'github' },
          { name: 'slack', command: 'slack' },
        ],
        skipped: [],
      }),
    });
    try {
      await refreshLiveSessionConfig();
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(connectedByRuntime).toHaveLength(1);
      expect(connectedByRuntime[0].servers).toEqual(['slack']);
      expect(disconnectedRuntimes).toEqual([]);
    } finally {
      __testHooks.resetRuntimeFactoriesForTest();
    }
  });

  it('removes a stale bare managed override from persisted Session config', () => {
    const root = makeDir();
    const sessionId = 'session-stale-bare';
    mkdirSync(join(root, 'sessions', sessionId), { recursive: true });
    saveSessionConfig(root, sessionId, { model: 'gpt-old' });
    const currentConfig = {
      providers: [{ name: 'github-copilot', credentialProvider: 'github-copilot', models: ['gpt-new'] }],
      primaryModel: 'github-copilot/gpt-new',
      availableModels: [{ id: 'gpt-new', ref: 'github-copilot/gpt-new', provider: 'github-copilot' }],
    };

    expect(normalizeSessionConfig(root, sessionId, currentConfig)).toEqual({});
    expect(loadSessionConfig(root, sessionId)).toEqual({});
  });

  it('never sends a removed managed-catalog override on the next turn', async () => {
    const root = makeDir();
    const sessionId = 'session-live-request';
    mkdirSync(join(root, 'sessions', sessionId), { recursive: true });
    saveSessionConfig(root, sessionId, { model: 'github-copilot/gpt-old' });
    writeFileSync(join(root, 'config.json'), `${JSON.stringify({
      providers: [{ name: 'github-copilot', credentialProvider: 'github-copilot', models: ['gpt-new'] }],
      primaryModel: 'github-copilot/gpt-new',
    }, null, 2)}\n`);
    ctx.CONFIG = { yeaftDir: root };
    const streamCalls = [];
    const adapter = {
      refreshProviders() {},
      async *stream(params) {
        streamCalls.push(params);
        yield { type: 'text_delta', text: 'ok' };
        yield { type: 'stop', stopReason: 'end_turn' };
      },
      async call() { return { text: '', usage: {} }; },
    };
    __testSetSession({
      yeaftDir: root,
      adapter,
      trace: new NullTrace(),
      config: {
        dir: root,
        model: 'gpt-old',
        primaryModel: 'github-copilot/gpt-old',
        fastModel: 'github-copilot/gpt-old',
        fastModelId: 'gpt-old',
        providers: [{ name: 'github-copilot', models: ['gpt-old'] }],
        availableModels: [{ id: 'gpt-old', ref: 'github-copilot/gpt-old', provider: 'github-copilot' }],
        _readOnly: true,
      },
      engine: { refreshConfig: vi.fn() },
      conversationStore: { loadRecentBySession: () => [], readCompactSummary: () => '' },
      memoryIndex: null,
      amsRegistry: null,
      toolRegistry: null,
      skillManager: null,
      mcpManager: null,
      taskManager: { renderActiveTasksForPrompt: () => '' },
      toolStats: null,
    });

    await refreshLiveSessionConfig();
    const engine = __testGetOrCreateVpEngine(sessionId, 'vp-a', 'main');
    for await (const _event of engine.query({ prompt: 'use the new model', sessionId })) {}

    expect(streamCalls).toHaveLength(1);
    expect(streamCalls[0].model).toBe('github-copilot/gpt-new');
    expect(streamCalls[0].model).not.toBe('github-copilot/gpt-old');
    expect(engine.fastConfig.model).toBe('gpt-new');
    expect(loadSessionConfig(root, sessionId)).toEqual({});
  });


  it('flushes lifecycle telemetry through a Session config dir', async () => {
    const root = makeDir();
    const originalFetch = global.fetch;
    let session = null;
    writeFileSync(join(root, 'config.json'), JSON.stringify({
      providers: [{
        name: 'session-test',
        baseUrl: 'https://session-test.invalid/v1',
        apiKey: 'test-key',
        protocol: 'openai-responses',
        models: ['gpt-5'],
      }],
      primaryModel: 'session-test/gpt-5',
      telemetry: { flushIntervalMs: 60_000 },
    }, null, 2));

    try {
      global.fetch = async () => new Response([
        'data: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":1,"output_tokens":1}}}',
        '',
      ].join('\n'), { status: 200, headers: { 'content-type': 'text/event-stream' } });
      session = await loadSession({ dir: root, skipMCP: true, skipSkills: true });
      expect(session.config.dir).toBe(root);
      expect(session.config.yeaftDir).toBeUndefined();

      for await (const _event of session.engine.query({
        prompt: 'trace this lifecycle',
        sessionId: 'session-perf-trace',
        inboundEnvelope: { _perfTraceId: 'session-config-dir-trace' },
      })) { /* consume */ }
      await session.shutdown();
      session = null;

      const day = new Date().toISOString().slice(0, 10);
      const tracePath = join(root, 'perf-traces', `${day}.jsonl`);
      expect(existsSync(tracePath)).toBe(true);
      const rows = readFileSync(tracePath, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      expect(rows.filter(row => row.traceId === 'session-config-dir-trace').map(row => row.phase)).toEqual(expect.arrayContaining([
        'llm.request_start',
        'llm.first_event',
        'llm.request_complete',
      ]));
    } finally {
      global.fetch = originalFetch;
      await session?.shutdown?.();
    }
  });

  it('seeds stock VPs before loading the user-level runtime', async () => {
    const seedRoot = makeDir();
    const previousTransport = {
      ws: ctx.ws,
      serverEncryptionRequired: ctx.serverEncryptionRequired,
      outboundSendQueue: ctx.outboundSendQueue,
      outboundSendQueueActive: ctx.outboundSendQueueActive,
    };
    const send = vi.fn();
    ctx.CONFIG = { yeaftDir: seedRoot };
    ctx.ws = { readyState: 1, send };
    ctx.serverEncryptionRequired = false;
    ctx.outboundSendQueue = [];
    ctx.outboundSendQueueActive = false;

    try {
      handleYeaftVpSubscribe({ requestId: 'vp-cold-start' });
      await vi.waitFor(() => expect(send).toHaveBeenCalled());
      const frames = send.mock.calls.map(([raw]) => JSON.parse(raw));
      const snapshot = frames.find(frame => frame.event?.type === 'vp_snapshot');
      expect(snapshot.requestId).toBe('vp-cold-start');
      expect(snapshot.event.emptyLibrary).toBe(false);
      expect(snapshot.event.vps).toHaveLength(34);
      expect(snapshot.event.vps.some(vp => vp.vpId === 'omni')).toBe(true);
      expect(existsSync(join(seedRoot, 'virtual-persons', 'omni', 'role.md'))).toBe(true);
    } finally {
      await __testResetVpState();
      ctx.ws = previousTransport.ws;
      ctx.serverEncryptionRequired = previousTransport.serverEncryptionRequired;
      ctx.outboundSendQueue = previousTransport.outboundSendQueue;
      ctx.outboundSendQueueActive = previousTransport.outboundSendQueueActive;
    }

    const root = makeDir();
    const workDir = mkdtempSync(join(tmpdir(), 'yeaft-session-config-workdir-'));
    writeFileSync(join(root, 'config.json'), JSON.stringify({
      providers: [
        { name: 'global-provider', baseUrl: 'http://global.example/v1', apiKey: 'test', protocol: 'openai-responses', models: ['gpt-5'] },
      ],
      primaryModel: 'global-provider/gpt-5',
      language: 'zh',
    }, null, 2));

    let session = null;
    try {
      session = await loadSession({ dir: root, workDir, skipMCP: true, skipSkills: true });
      expect(session.config.dir).toBe(root);
      expect(session.config.primaryModel).toBe('global-provider/gpt-5');
      expect(session.config.providers?.[0]?.name).toBe('global-provider');
      expect(session.yeaftDir).toBe(root);
      expect(session.skillManager.skillsDir).toBe(join(root, 'skills'));

      session.conversationStore.append({ role: 'user', content: 'user-level message', sessionId: 'session_cfg' });
      const userSegmentPath = join(root, 'sessions', 'session_cfg', 'conversation', 'segments', '000001.jsonl');
      const projectSegmentPath = join(workDir, '.yeaft', 'sessions', 'session_cfg', 'conversation', 'segments', '000001.jsonl');
      expect(existsSync(userSegmentPath)).toBe(true);
      expect(readFileSync(userSegmentPath, 'utf8')).toContain('user-level message');
      expect(existsSync(projectSegmentPath)).toBe(false);
    } finally {
      await session?.shutdown?.();
      rmSync(workDir, { recursive: true, force: true });
    }
  });

});
