import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ctx from '../../../agent/context.js';
import { loadConfig, loadMCPConfig, normalizeLlmRetry, normaliseTelemetrySection } from '../../../agent/yeaft/config.js';
import { readLocalLlmConfig, writeLocalLlmConfig } from '../../../agent/llm-config-cli.js';
import {
  getPluginConfig,
  getTelemetrySettings,
  listMcpServers,
  removeMcpServer,
  updateLlmConfig,
  updatePluginConfig,
  updateSearchSettings,
  updateTelemetrySettings,
  updateYeaftSettings,
  upsertMcpServer,
} from '../../../agent/yeaft/config-api.js';
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
import { ToolRegistry } from '../../../agent/yeaft/tools/registry.js';
import { defineTool } from '../../../agent/yeaft/tools/types.js';
import { loadSessionConfig, normalizeSessionConfig, resolveSessionConfig, saveSessionConfig } from '../../../agent/yeaft/sessions/session-config.js';
import { createSession } from '../../../agent/yeaft/sessions/session-store.js';
import { isMultiVpEnabled, setMultiVpEnabled } from '../../../agent/yeaft/sessions/feature-flag.js';
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
  async function assertMcpBootstrapRemoveDoesNotRestoreServer({ workDir = '' } = {}) {
    const root = makeDir();
    const configPath = join(root, 'config.json');
    const previousTransport = {
      ws: ctx.ws,
      serverEncryptionRequired: ctx.serverEncryptionRequired,
      outboundSendQueue: ctx.outboundSendQueue,
      outboundSendQueueActive: ctx.outboundSendQueueActive,
      CONFIG: ctx.CONFIG,
    };
    const sent = [];
    const hotSwapSnapshots = [];
    let releaseConnect;
    const mayConnect = new Promise(resolve => { releaseConnect = resolve; });
    let markConnectStarted;
    const connectStarted = new Promise(resolve => { markConnectStarted = resolve; });
    const connected = new Set();
    const mcpManager = {
      get hasServers() { return connected.size > 0; },
      get toolCount() { return connected.size; },
      status: () => [...connected].map(name => ({ name, ready: true, toolCount: 1 })),
      async connectAll(servers) {
        markConnectStarted();
        await mayConnect;
        for (const server of servers) connected.add(server.name);
        return { connected: [...connected], failed: [] };
      },
      async connect() {},
      async disconnect(name) { connected.delete(name); },
      async disconnectAll() { connected.clear(); },
    };
    const liveSession = {
      yeaftDir: root,
      config: { dir: root, plugins: {} },
      skillManager: { size: 0, list: () => [] },
      mcpManager: { status: () => [], hasServers: false, async disconnect() {}, async disconnectAll() {}, async connect() {} },
      toolRegistry: {
        size: 0,
        replaceMcpTools(manager) {
          hotSwapSnapshots.push((manager?.status?.() || []).map(status => status.name));
          return { removed: 0, added: hotSwapSnapshots.at(-1).length };
        },
      },
      engine: { setRuntimeManagers() {} },
      status: { skills: 0, mcpServers: [], mcpFailed: [], mcpSkipped: [], tools: 0 },
    };
    writeFileSync(configPath, JSON.stringify({
      mcpServers: [{ name: 'github', command: 'node', args: [], env: {} }],
      plugins: {},
    }));
    ctx.CONFIG = { yeaftDir: root };
    ctx.ws = { readyState: 1, send(raw) { sent.push(JSON.parse(raw)); } };
    ctx.serverEncryptionRequired = false;
    ctx.outboundSendQueue = [];
    ctx.outboundSendQueueActive = false;
    __testSetSession(liveSession);
    __testHooks.setRuntimeFactoriesForTest({
      createSkillManager: () => ({ size: 0, list: () => [] }),
      createMcpManager: () => mcpManager,
      loadMcpConfig: () => ({
        servers: JSON.parse(readFileSync(configPath, 'utf8')).mcpServers,
        skipped: [],
      }),
    });

    try {
      const boot = workDir
        ? __testHooks.scheduleProjectRuntimeLoadForTest(workDir)
        : __testHooks.scheduleBaseRuntimeLoadForTest();
      await connectStarted;
      const remove = handleMessage({
        type: 'yeaft_mcp_remove',
        requestId: workDir ? 'remove-project-bootstrap-github' : 'remove-base-bootstrap-github',
        name: 'github',
      });
      await Promise.resolve();
      // The queued remove must not pass the loader while its old config is
      // still blocked in connectAll.
      expect(JSON.parse(readFileSync(configPath, 'utf8')).mcpServers.map(server => server.name))
        .toEqual(['github']);
      releaseConnect();
      await Promise.all([boot, remove]);
      await vi.waitFor(() => expect(sent.some(frame => (
        frame.type === 'yeaft_mcp_updated' && frame.reason === 'remove'
      ))).toBe(true));

      const finalBroadcast = sent.filter(frame => frame.type === 'yeaft_mcp_updated').at(-1);
      expect(JSON.parse(readFileSync(configPath, 'utf8')).mcpServers).toEqual([]);
      expect(connected).toEqual(new Set());
      expect(hotSwapSnapshots.at(-1)).toEqual([]);
      expect(finalBroadcast).toMatchObject({
        reason: 'remove',
        servers: [],
        runtime: { connected: false, perServer: [] },
        error: null,
      });
    } finally {
      releaseConnect?.();
      __testHooks.resetRuntimeFactoriesForTest();
      ctx.ws = previousTransport.ws;
      ctx.serverEncryptionRequired = previousTransport.serverEncryptionRequired;
      ctx.outboundSendQueue = previousTransport.outboundSendQueue;
      ctx.outboundSendQueueActive = previousTransport.outboundSendQueueActive;
      ctx.CONFIG = previousTransport.CONFIG;
    }
  }

  async function assertMcpReloadRetiresInactiveRuntime({ active = 'project' } = {}) {
    const root = makeDir();
    const projectWorkDir = 'project-runtime';
    const configPath = join(root, 'config.json');
    const previousTransport = {
      ws: ctx.ws,
      serverEncryptionRequired: ctx.serverEncryptionRequired,
      outboundSendQueue: ctx.outboundSendQueue,
      outboundSendQueueActive: ctx.outboundSendQueueActive,
      CONFIG: ctx.CONFIG,
    };
    const sent = [];
    const hotSwapSnapshots = [];
    const managers = [];
    const makeManager = (label) => {
      const connected = new Set();
      return {
        label,
        get hasServers() { return connected.size > 0; },
        get toolCount() { return connected.size; },
        names: () => [...connected],
        status: () => [...connected].map(name => ({ name, ready: true, toolCount: 1 })),
        async connectAll(servers) {
          for (const server of servers) connected.add(server.name);
          return { connected: [...connected], failed: [] };
        },
        async connect(server) { connected.add(server.name); },
        async disconnect(name) { connected.delete(name); },
        async disconnectAll() { connected.clear(); },
      };
    };
    const liveSession = {
      yeaftDir: root,
      config: { dir: root, plugins: {} },
      skillManager: { size: 0, list: () => [] },
      mcpManager: {
        hasServers: false,
        status: () => [],
        async connect() {},
        async disconnect() {},
        async disconnectAll() {},
      },
      toolRegistry: {
        size: 0,
        replaceMcpTools(manager) {
          const snapshot = {
            label: manager?.label || 'none',
            names: (manager?.status?.() || []).map(status => status.name),
          };
          hotSwapSnapshots.push(snapshot);
          return { removed: 0, added: snapshot.names.length };
        },
      },
      engine: { setRuntimeManagers() {} },
      status: { skills: 0, mcpServers: [], mcpFailed: [], mcpSkipped: [], tools: 0 },
    };

    writeFileSync(configPath, JSON.stringify({
      mcpServers: [{ name: 'github', command: 'node', args: [], env: {} }],
      plugins: {},
    }));
    ctx.CONFIG = { yeaftDir: root };
    ctx.ws = { readyState: 1, send(raw) { sent.push(JSON.parse(raw)); } };
    ctx.serverEncryptionRequired = false;
    ctx.outboundSendQueue = [];
    ctx.outboundSendQueueActive = false;
    __testSetSession(liveSession);
    __testHooks.setRuntimeFactoriesForTest({
      createSkillManager: () => ({ size: 0, list: () => [] }),
      createMcpManager: () => {
        const manager = makeManager(`runtime-${managers.length}`);
        managers.push(manager);
        return manager;
      },
      loadMcpConfig: () => ({
        servers: JSON.parse(readFileSync(configPath, 'utf8')).mcpServers,
        skipped: [],
      }),
    });

    try {
      await __testHooks.scheduleBaseRuntimeLoadForTest();
      await __testHooks.scheduleProjectRuntimeLoadForTest(projectWorkDir);
      expect(managers).toHaveLength(2);
      expect(managers.map(manager => manager.names())).toEqual([['github'], ['github']]);

      if (active === 'base') __testHooks.activateBaseRuntimeForTest();
      const activeIndex = active === 'base' ? 0 : 1;
      const inactiveIndex = active === 'base' ? 1 : 0;
      expect(hotSwapSnapshots.at(-1)).toMatchObject({
        label: `runtime-${activeIndex}`,
        names: ['github'],
      });

      // Simulate an Agent config/CLI/external edit, then exercise the normal
      // MCP Settings Reload all wire path rather than the CRUD writers.
      writeFileSync(configPath, JSON.stringify({ mcpServers: [], plugins: {} }));
      await handleMessage({
        type: 'yeaft_mcp_reload',
        requestId: `reload-retire-${active}`,
      });
      await vi.waitFor(() => expect(sent.some(frame => (
        frame.type === 'yeaft_mcp_updated' && frame.reason === 'reload'
      ))).toBe(true));

      const reloadResult = sent.find(frame => frame.type === 'yeaft_mcp_reload_result');
      const reloadBroadcast = sent.filter(frame => (
        frame.type === 'yeaft_mcp_updated' && frame.reason === 'reload'
      )).at(-1);
      expect(reloadResult).toMatchObject({
        requestId: `reload-retire-${active}`,
        servers: [],
        runtime: { connected: false, perServer: [] },
        error: null,
      });
      expect(reloadBroadcast).toMatchObject({
        servers: [],
        runtime: { connected: false, perServer: [] },
        error: null,
      });
      expect(managers[activeIndex].names()).toEqual([]);
      expect(managers[inactiveIndex].names()).toEqual([]);

      // A real next turn must rebuild the retired inactive runtime from the
      // current disk config, not merely fall back to an empty manager.
      if (active === 'base') {
        await __testHooks.scheduleProjectRuntimeLoadForTest(projectWorkDir);
        __testHooks.activateProjectRuntimeForTest(projectWorkDir);
      } else {
        await __testHooks.scheduleBaseRuntimeLoadForTest();
        __testHooks.activateBaseRuntimeForTest();
      }
      expect(managers).toHaveLength(3);
      expect(managers[2].names()).toEqual([]);
      expect(hotSwapSnapshots.at(-1)).toMatchObject({
        label: 'runtime-2',
        names: [],
      });
    } finally {
      __testHooks.resetRuntimeFactoriesForTest();
      ctx.ws = previousTransport.ws;
      ctx.serverEncryptionRequired = previousTransport.serverEncryptionRequired;
      ctx.outboundSendQueue = previousTransport.outboundSendQueue;
      ctx.outboundSendQueueActive = previousTransport.outboundSendQueueActive;
      ctx.CONFIG = previousTransport.CONFIG;
    }
  }

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

  it('fails closed for an invalid config.json root and preserves every bad file', () => {
    const root = makeDir();
    const configPath = join(root, 'config.json');
    for (const invalidRoot of ['{"plugins":{"tools":["FileRead"]}', '[]']) {
      writeFileSync(configPath, invalidRoot);

      expect(loadConfig({ dir: root })).toMatchObject({
        plugins: { tools: [], skills: [], mcpServers: [] },
        pluginConfigError: expect.stringContaining('config.json is invalid'),
      });
      expect(getPluginConfig(root)).toMatchObject({ error: expect.stringContaining('Failed to read plugin config') });
      expect(updatePluginConfig({ tools: ['Bash'] }, root)).toMatchObject({
        error: expect.stringContaining('Failed to read plugin config'),
      });
      expect(readFileSync(configPath, 'utf8')).toBe(invalidRoot);
    }
  });

  it('inherits only a missing plugins field and fails closed for invalid plugin schemas', () => {
    const root = makeDir();
    const configPath = join(root, 'config.json');
    writeFileSync(configPath, JSON.stringify({ providers: [] }, null, 2));
    expect(loadConfig({ dir: root })).toMatchObject({ plugins: {}, pluginConfigError: null });
    expect(getPluginConfig(root)).toEqual({ plugins: {} });

    for (const [plugins, error] of [
      [null, 'plugins must be an object'],
      [{ tools: 'not-an-array' }, 'plugins.tools must be an array'],
    ]) {
      const invalidSchema = JSON.stringify({ providers: [], plugins }, null, 2);
      writeFileSync(configPath, invalidSchema);

      expect(loadConfig({ dir: root })).toMatchObject({
        plugins: { tools: [], skills: [], mcpServers: [] },
        pluginConfigError: error,
      });
      expect(getPluginConfig(root)).toMatchObject({ error: expect.stringContaining(error) });
      expect(updatePluginConfig({ tools: ['FileRead'] }, root)).toMatchObject({
        error: expect.stringContaining(error),
      });
      expect(readFileSync(configPath, 'utf8')).toBe(invalidSchema);
    }
  });

  it('rejects unrelated config writes over invalid Plugin policies', () => {
    const root = makeDir();
    const configPath = join(root, 'config.json');
    const writers = [
      { write: () => updateLlmConfig({ debug: true }, root), error: 'Failed to read config.json' },
      { write: () => updateYeaftSettings({ maxConcurrentThreads: 2 }, root), error: 'Failed to read config.json' },
      { write: () => updateTelemetrySettings({ enabled: false }, root), error: 'Failed to read config.json' },
      { write: () => updateSearchSettings({ backend: 'tavily' }, root), error: 'Failed to read config.json' },
      { write: () => updatePluginConfig({ tools: ['FileRead'] }, root), error: 'Failed to read plugin config' },
      { write: () => upsertMcpServer({ name: 'github', command: 'node', args: [] }, root), error: 'Failed to read config.json' },
      { write: () => removeMcpServer('github', root), error: 'Failed to read config.json' },
    ];

    for (const invalidConfig of [
      '{"plugins":{"tools":["FileRead"]}',
      'null',
      JSON.stringify({ plugins: { tools: 'not-an-array' } }),
    ]) {
      writeFileSync(configPath, invalidConfig);
      for (const { write, error } of writers) {
        expect(write()).toMatchObject({ error: expect.stringContaining(error) });
        expect(readFileSync(configPath, 'utf8')).toBe(invalidConfig);
      }
      expect(listMcpServers(root)).toMatchObject({ error: expect.stringContaining('Failed to read config.json') });
      expect(loadConfig({ dir: root })).toMatchObject({
        plugins: { tools: [], skills: [], mcpServers: [] },
        pluginConfigError: expect.any(String),
      });
    }
  });

  it('keeps missing config.json writable through strict config API writers', () => {
    const root = makeDir();
    const writes = [
      () => updateLlmConfig({ debug: true }, root),
      () => updateYeaftSettings({ maxConcurrentThreads: 2 }, root),
      () => updateTelemetrySettings({ enabled: false }, root),
      () => updateSearchSettings({ backend: 'tavily' }, root),
      () => removeMcpServer('github', root),
      () => upsertMcpServer({ name: 'github', command: 'node', args: [] }, root),
      () => updatePluginConfig({ tools: ['FileRead'] }, root),
    ];
    for (const write of writes) expect(write().error).toBeUndefined();

    expect(JSON.parse(readFileSync(join(root, 'config.json'), 'utf8'))).toMatchObject({
      debug: true,
      yeaft: expect.objectContaining({ maxConcurrentThreads: 2 }),
      telemetry: expect.objectContaining({ enabled: false }),
      search: expect.objectContaining({ backend: 'tavily' }),
      mcpServers: [expect.objectContaining({ name: 'github' })],
      plugins: { tools: ['FileRead'] },
    });
  });

  it('rejects fail-open writes through the MCP and telemetry message routes', async () => {
    const root = makeDir();
    const configPath = join(root, 'config.json');
    const previousTransport = {
      ws: ctx.ws,
      serverEncryptionRequired: ctx.serverEncryptionRequired,
      outboundSendQueue: ctx.outboundSendQueue,
      outboundSendQueueActive: ctx.outboundSendQueueActive,
      CONFIG: ctx.CONFIG,
    };
    const sent = [];
    ctx.CONFIG = { yeaftDir: root, telemetry: { enabled: true } };
    ctx.ws = { readyState: 1, send(raw) { sent.push(JSON.parse(raw)); } };
    ctx.serverEncryptionRequired = false;
    ctx.outboundSendQueue = [];
    ctx.outboundSendQueueActive = false;
    try {
      const cases = [
        {
          config: '{"plugins":{"tools":["FileRead"]}',
          message: {
            type: 'yeaft_mcp_add',
            requestId: 'broken-json',
            server: { name: 'github', command: 'node', args: [] },
          },
          resultType: 'yeaft_mcp_add_result',
        },
        {
          config: 'null',
          message: {
            type: 'yeaft_mcp_add',
            requestId: 'null-root',
            server: { name: 'github', command: 'node', args: [] },
          },
          resultType: 'yeaft_mcp_add_result',
        },
        {
          config: JSON.stringify({ plugins: { tools: 'not-an-array' } }),
          message: {
            type: 'yeaft_mcp_add',
            requestId: 'invalid-plugin-schema',
            server: { name: 'github', command: 'node', args: [] },
          },
          resultType: 'yeaft_mcp_add_result',
        },
        {
          config: 'null',
          message: {
            type: 'update_telemetry_settings',
            settings: { enabled: false },
          },
          resultType: 'telemetry_settings_updated',
        },
      ];
      for (const testCase of cases) {
        sent.length = 0;
        writeFileSync(configPath, testCase.config);
        await handleMessage(testCase.message);
        await new Promise(resolve => setImmediate(resolve));
        expect(sent).toContainEqual(expect.objectContaining({
          type: testCase.resultType,
          error: expect.stringContaining('Failed to read config.json'),
        }));
        expect(readFileSync(configPath, 'utf8')).toBe(testCase.config);
        expect(loadConfig({ dir: root })).toMatchObject({
          plugins: { tools: [], skills: [], mcpServers: [] },
          pluginConfigError: expect.any(String),
        });
      }
    } finally {
      ctx.ws = previousTransport.ws;
      ctx.serverEncryptionRequired = previousTransport.serverEncryptionRequired;
      ctx.outboundSendQueue = previousTransport.outboundSendQueue;
      ctx.outboundSendQueueActive = previousTransport.outboundSendQueueActive;
      ctx.CONFIG = previousTransport.CONFIG;
    }
  });

  it('does not let a base runtime bootstrap restore an MCP removed during startup', async () => {
    await assertMcpBootstrapRemoveDoesNotRestoreServer();
  });

  it('does not let a project runtime bootstrap restore an MCP removed during startup', async () => {
    await assertMcpBootstrapRemoveDoesNotRestoreServer({ workDir: 'project-runtime' });
  });

  it('does not let full MCP reload revive a stale base cache after a project runtime is active', async () => {
    await assertMcpReloadRetiresInactiveRuntime({ active: 'project' });
  });

  it('does not let full MCP reload revive a stale project cache after the base runtime is active', async () => {
    await assertMcpReloadRetiresInactiveRuntime({ active: 'base' });
  });

  it('rejects MCP reload before touching a live runtime when config is invalid', async () => {
    const root = makeDir();
    const configPath = join(root, 'config.json');
    const previousTransport = {
      ws: ctx.ws,
      serverEncryptionRequired: ctx.serverEncryptionRequired,
      outboundSendQueue: ctx.outboundSendQueue,
      outboundSendQueueActive: ctx.outboundSendQueueActive,
      CONFIG: ctx.CONFIG,
    };
    const sent = [];
    const disconnectAll = vi.fn(async () => {});
    const disconnect = vi.fn(async () => {});
    const connect = vi.fn(async () => {});
    const replaceMcpTools = vi.fn(() => ({ removed: 0, added: 0 }));
    const mcpManager = {
      hasServers: true,
      status: () => [{ name: 'github', ready: true, toolCount: 1 }],
      disconnectAll,
      disconnect,
      connect,
    };
    ctx.CONFIG = { yeaftDir: root };
    ctx.ws = { readyState: 1, send(raw) { sent.push(JSON.parse(raw)); } };
    ctx.serverEncryptionRequired = false;
    ctx.outboundSendQueue = [];
    ctx.outboundSendQueueActive = false;
    __testSetSession({
      config: { plugins: {} },
      mcpManager,
      toolRegistry: { replaceMcpTools },
    });

    try {
      for (const [requestId, invalidConfig] of [
        ['reload-malformed', '{"plugins":{"tools":["FileRead"]}'],
        ['reload-invalid-plugins', JSON.stringify({ plugins: { tools: 'not-an-array' } })],
      ]) {
        sent.length = 0;
        disconnectAll.mockClear();
        disconnect.mockClear();
        connect.mockClear();
        replaceMcpTools.mockClear();
        writeFileSync(configPath, invalidConfig);

        await handleMessage({ type: 'yeaft_mcp_reload', requestId });
        await new Promise(resolve => setImmediate(resolve));

        expect(sent).toContainEqual(expect.objectContaining({
          type: 'yeaft_mcp_reload_result',
          requestId,
          servers: [],
          error: expect.stringContaining('Failed to read config.json'),
        }));
        expect(sent).not.toContainEqual(expect.objectContaining({
          type: 'yeaft_mcp_updated',
          reason: 'reload',
        }));
        expect(disconnectAll).not.toHaveBeenCalled();
        expect(disconnect).not.toHaveBeenCalled();
        expect(connect).not.toHaveBeenCalled();
        expect(replaceMcpTools).not.toHaveBeenCalled();
        expect(readFileSync(configPath, 'utf8')).toBe(invalidConfig);
        expect(loadConfig({ dir: root })).toMatchObject({
          plugins: { tools: [], skills: [], mcpServers: [] },
          pluginConfigError: expect.any(String),
        });
      }
    } finally {
      ctx.ws = previousTransport.ws;
      ctx.serverEncryptionRequired = previousTransport.serverEncryptionRequired;
      ctx.outboundSendQueue = previousTransport.outboundSendQueue;
      ctx.outboundSendQueueActive = previousTransport.outboundSendQueueActive;
      ctx.CONFIG = previousTransport.CONFIG;
    }
  });

  it('serializes overlapping MCP add and remove mutations through runtime publication', async () => {
    const root = makeDir();
    const configPath = join(root, 'config.json');
    const previousTransport = {
      ws: ctx.ws,
      serverEncryptionRequired: ctx.serverEncryptionRequired,
      outboundSendQueue: ctx.outboundSendQueue,
      outboundSendQueueActive: ctx.outboundSendQueueActive,
      CONFIG: ctx.CONFIG,
    };
    const sent = [];
    const connected = new Set(['github']);
    let releaseLinearConnect;
    const linearConnectStarted = new Promise(resolve => {
      releaseLinearConnect = () => resolve();
    });
    let markLinearConnectStarted;
    const waitingForLinearConnect = new Promise(resolve => {
      markLinearConnectStarted = resolve;
    });
    const connect = vi.fn(async server => {
      if (server.name === 'linear') {
        markLinearConnectStarted();
        await linearConnectStarted;
      }
      connected.add(server.name);
    });
    const disconnect = vi.fn(async name => { connected.delete(name); });
    const replaceMcpTools = vi.fn(() => ({ removed: 0, added: connected.size }));
    const mcpManager = {
      get hasServers() { return connected.size > 0; },
      status: () => [...connected].map(name => ({ name, ready: true, toolCount: 1 })),
      connect,
      disconnect,
    };
    ctx.CONFIG = { yeaftDir: root };
    ctx.ws = { readyState: 1, send(raw) { sent.push(JSON.parse(raw)); } };
    ctx.serverEncryptionRequired = false;
    ctx.outboundSendQueue = [];
    ctx.outboundSendQueueActive = false;
    __testSetSession({
      config: { plugins: {} },
      mcpManager,
      toolRegistry: { replaceMcpTools },
    });

    try {
      writeFileSync(configPath, JSON.stringify({
        mcpServers: [{ name: 'github', command: 'node', args: [], env: {} }],
        plugins: {},
      }));
      const add = handleMessage({
        type: 'yeaft_mcp_add',
        requestId: 'add-linear',
        server: { name: 'linear', command: 'node', args: [], env: {} },
      });
      await waitingForLinearConnect;

      const remove = handleMessage({
        type: 'yeaft_mcp_remove',
        requestId: 'remove-github',
        name: 'github',
      });
      await Promise.resolve();
      expect(disconnect).not.toHaveBeenCalled();
      expect(JSON.parse(readFileSync(configPath, 'utf8')).mcpServers.map(server => server.name))
        .toEqual(['github', 'linear']);

      releaseLinearConnect();
      await Promise.all([add, remove]);
      await vi.waitFor(() => expect(sent.some(frame => frame.type === 'yeaft_mcp_remove_result')).toBe(true));
      await vi.waitFor(() => expect(sent.some(frame => (
        frame.type === 'yeaft_mcp_updated' && frame.reason === 'remove'
      ))).toBe(true));

      const persisted = JSON.parse(readFileSync(configPath, 'utf8'));
      const mutationFrames = sent.filter(frame => (
        frame.type === 'yeaft_mcp_add_result'
        || frame.type === 'yeaft_mcp_remove_result'
        || frame.type === 'yeaft_mcp_updated'
      ));
      const finalResult = mutationFrames.at(-2);
      const finalFrame = mutationFrames.at(-1);
      const removeResult = sent.find(frame => frame.type === 'yeaft_mcp_remove_result');
      expect(persisted.mcpServers.map(server => server.name)).toEqual(['linear']);
      expect([...connected]).toEqual(['linear']);
      expect(disconnect).toHaveBeenCalledWith('github');
      expect(finalResult).toBe(removeResult);
      expect(finalResult).toMatchObject({
        type: 'yeaft_mcp_remove_result',
        requestId: 'remove-github',
        servers: [expect.objectContaining({ name: 'linear' })],
        runtime: expect.objectContaining({
          connected: true,
          perServer: [expect.objectContaining({ name: 'linear', ready: true })],
        }),
        error: null,
      });
      expect(finalFrame).toMatchObject({
        type: 'yeaft_mcp_updated',
        reason: 'remove',
        servers: [expect.objectContaining({ name: 'linear' })],
        runtime: expect.objectContaining({
          connected: true,
          perServer: [expect.objectContaining({ name: 'linear', ready: true })],
        }),
        error: null,
      });
      expect(finalFrame.servers.map(server => server.name)).toEqual(['linear']);
    } finally {
      releaseLinearConnect?.();
      ctx.ws = previousTransport.ws;
      ctx.serverEncryptionRequired = previousTransport.serverEncryptionRequired;
      ctx.outboundSendQueue = previousTransport.outboundSendQueue;
      ctx.outboundSendQueueActive = previousTransport.outboundSendQueueActive;
      ctx.CONFIG = previousTransport.CONFIG;
    }
  });

  it('serializes overlapping MCP reload and add mutations without restoring a stale server set', async () => {
    const root = makeDir();
    const configPath = join(root, 'config.json');
    const previousTransport = {
      ws: ctx.ws,
      serverEncryptionRequired: ctx.serverEncryptionRequired,
      outboundSendQueue: ctx.outboundSendQueue,
      outboundSendQueueActive: ctx.outboundSendQueueActive,
      CONFIG: ctx.CONFIG,
    };
    const sent = [];
    const connected = new Set(['github']);
    let releaseDisconnectAll;
    const reloadMayContinue = new Promise(resolve => {
      releaseDisconnectAll = () => resolve();
    });
    let markDisconnectAllStarted;
    const disconnectAllStarted = new Promise(resolve => {
      markDisconnectAllStarted = resolve;
    });
    const disconnectAll = vi.fn(async () => {
      markDisconnectAllStarted();
      await reloadMayContinue;
      connected.clear();
    });
    const connect = vi.fn(async server => { connected.add(server.name); });
    const replaceMcpTools = vi.fn(() => ({ removed: 0, added: connected.size }));
    const mcpManager = {
      get hasServers() { return connected.size > 0; },
      status: () => [...connected].map(name => ({ name, ready: true, toolCount: 1 })),
      disconnectAll,
      connect,
    };
    ctx.CONFIG = { yeaftDir: root };
    ctx.ws = { readyState: 1, send(raw) { sent.push(JSON.parse(raw)); } };
    ctx.serverEncryptionRequired = false;
    ctx.outboundSendQueue = [];
    ctx.outboundSendQueueActive = false;
    __testSetSession({
      config: { plugins: {} },
      mcpManager,
      toolRegistry: { replaceMcpTools },
    });

    try {
      writeFileSync(configPath, JSON.stringify({
        mcpServers: [{ name: 'github', command: 'node', args: [], env: {} }],
        plugins: {},
      }));
      const reload = handleMessage({ type: 'yeaft_mcp_reload', requestId: 'reload-before-add' });
      await disconnectAllStarted;

      const add = handleMessage({
        type: 'yeaft_mcp_add',
        requestId: 'add-linear-after-reload',
        server: { name: 'linear', command: 'node', args: [], env: {} },
      });
      await Promise.resolve();
      expect(connect).not.toHaveBeenCalledWith(expect.objectContaining({ name: 'linear' }));
      expect(JSON.parse(readFileSync(configPath, 'utf8')).mcpServers.map(server => server.name))
        .toEqual(['github']);

      releaseDisconnectAll();
      await Promise.all([reload, add]);
      await vi.waitFor(() => expect(sent.some(frame => (
        frame.type === 'yeaft_mcp_updated' && frame.reason === 'add'
      ))).toBe(true));

      const persisted = JSON.parse(readFileSync(configPath, 'utf8'));
      const mutationFrames = sent.filter(frame => (
        frame.type === 'yeaft_mcp_reload_result'
        || frame.type === 'yeaft_mcp_add_result'
        || frame.type === 'yeaft_mcp_updated'
      ));
      const finalResult = mutationFrames.at(-2);
      const finalBroadcast = mutationFrames.at(-1);
      expect(persisted.mcpServers.map(server => server.name)).toEqual(['github', 'linear']);
      expect([...connected]).toEqual(['github', 'linear']);
      expect(finalResult).toMatchObject({
        type: 'yeaft_mcp_add_result',
        requestId: 'add-linear-after-reload',
        servers: [
          expect.objectContaining({ name: 'github' }),
          expect.objectContaining({ name: 'linear' }),
        ],
        runtime: expect.objectContaining({
          connected: true,
          perServer: [
            expect.objectContaining({ name: 'github', ready: true }),
            expect.objectContaining({ name: 'linear', ready: true }),
          ],
        }),
        error: null,
      });
      expect(finalBroadcast).toMatchObject({
        type: 'yeaft_mcp_updated',
        reason: 'add',
        servers: [
          expect.objectContaining({ name: 'github' }),
          expect.objectContaining({ name: 'linear' }),
        ],
        runtime: expect.objectContaining({
          connected: true,
          perServer: [
            expect.objectContaining({ name: 'github', ready: true }),
            expect.objectContaining({ name: 'linear', ready: true }),
          ],
        }),
        error: null,
      });
    } finally {
      releaseDisconnectAll?.();
      ctx.ws = previousTransport.ws;
      ctx.serverEncryptionRequired = previousTransport.serverEncryptionRequired;
      ctx.outboundSendQueue = previousTransport.outboundSendQueue;
      ctx.outboundSendQueueActive = previousTransport.outboundSendQueueActive;
      ctx.CONFIG = previousTransport.CONFIG;
    }
  });

  it('keeps the reload snapshot when config becomes invalid during runtime work', async () => {
    const root = makeDir();
    const configPath = join(root, 'config.json');
    const previousTransport = {
      ws: ctx.ws,
      serverEncryptionRequired: ctx.serverEncryptionRequired,
      outboundSendQueue: ctx.outboundSendQueue,
      outboundSendQueueActive: ctx.outboundSendQueueActive,
      CONFIG: ctx.CONFIG,
    };
    const initialConfig = JSON.stringify({
      mcpServers: [{ name: 'github', command: 'node', args: [], env: {} }],
      plugins: {},
    });
    const sent = [];
    const connected = new Set(['github']);
    const disconnectAll = vi.fn(async () => {
      connected.clear();
      writeFileSync(configPath, JSON.stringify({
        mcpServers: [{ name: 'github', command: 'node', args: [], env: {} }],
        plugins: { tools: 'invalid-after-reload-started' },
      }));
    });
    const connect = vi.fn(async server => { connected.add(server.name); });
    const replaceMcpTools = vi.fn(() => ({ removed: 0, added: 1 }));
    const mcpManager = {
      get hasServers() { return connected.size > 0; },
      status: () => [...connected].map(name => ({ name, ready: true, toolCount: 1 })),
      disconnectAll,
      disconnect: vi.fn(async name => { connected.delete(name); }),
      connect,
    };
    ctx.CONFIG = { yeaftDir: root };
    ctx.ws = { readyState: 1, send(raw) { sent.push(JSON.parse(raw)); } };
    ctx.serverEncryptionRequired = false;
    ctx.outboundSendQueue = [];
    ctx.outboundSendQueueActive = false;
    __testSetSession({
      config: { plugins: {} },
      mcpManager,
      toolRegistry: { replaceMcpTools },
    });

    try {
      writeFileSync(configPath, initialConfig);
      await handleMessage({ type: 'yeaft_mcp_reload', requestId: 'reload-snapshot-race' });
      await new Promise(resolve => setImmediate(resolve));

      await vi.waitFor(() => expect(sent.some(frame => (
        frame.type === 'yeaft_mcp_updated' && frame.reason === 'reload'
      ))).toBe(true));
      const reloadResult = sent.find(frame => frame.type === 'yeaft_mcp_reload_result');
      const reloadBroadcast = sent.find(frame => frame.type === 'yeaft_mcp_updated' && frame.reason === 'reload');
      expect(disconnectAll).toHaveBeenCalledTimes(1);
      expect(connect).toHaveBeenCalledWith(expect.objectContaining({ name: 'github' }));
      expect(replaceMcpTools).toHaveBeenCalledTimes(1);
      expect(reloadResult).toMatchObject({
        requestId: 'reload-snapshot-race',
        servers: [expect.objectContaining({ name: 'github' })],
        error: null,
        runtime: expect.objectContaining({ connected: true }),
      });
      expect(reloadBroadcast).toMatchObject({
        reason: 'reload',
        servers: [expect.objectContaining({ name: 'github' })],
        error: null,
        runtime: expect.objectContaining({ connected: true }),
      });
      expect(reloadBroadcast).not.toMatchObject({ servers: [] });
      expect(readFileSync(configPath, 'utf8')).not.toBe(initialConfig);
      expect(loadConfig({ dir: root })).toMatchObject({
        plugins: { tools: [], skills: [], mcpServers: [] },
        pluginConfigError: 'plugins.tools must be an array',
      });
    } finally {
      ctx.ws = previousTransport.ws;
      ctx.serverEncryptionRequired = previousTransport.serverEncryptionRequired;
      ctx.outboundSendQueue = previousTransport.outboundSendQueue;
      ctx.outboundSendQueueActive = previousTransport.outboundSendQueueActive;
      ctx.CONFIG = previousTransport.CONFIG;
    }
  });

  it('reports fallback MCP broadcast read errors without an empty server list', async () => {
    const root = makeDir();
    const configPath = join(root, 'config.json');
    const previousTransport = {
      ws: ctx.ws,
      serverEncryptionRequired: ctx.serverEncryptionRequired,
      outboundSendQueue: ctx.outboundSendQueue,
      outboundSendQueueActive: ctx.outboundSendQueueActive,
      CONFIG: ctx.CONFIG,
    };
    const sent = [];
    ctx.CONFIG = { yeaftDir: root };
    ctx.ws = { readyState: 1, send(raw) { sent.push(JSON.parse(raw)); } };
    ctx.serverEncryptionRequired = false;
    ctx.outboundSendQueue = [];
    ctx.outboundSendQueueActive = false;
    __testSetSession({
      mcpManager: {
        hasServers: true,
        status: () => [{ name: 'github', ready: true, toolCount: 1 }],
      },
    });

    try {
      writeFileSync(configPath, JSON.stringify({ plugins: { tools: 'not-an-array' } }));
      await __testHooks.broadcastMcpUpdatedForTest({ reason: 'base-runtime-load' });

      const update = sent.find(frame => frame.type === 'yeaft_mcp_updated');
      expect(update).toMatchObject({
        reason: 'base-runtime-load',
        error: expect.stringContaining('Failed to read config.json'),
        runtime: expect.objectContaining({ connected: true }),
      });
      expect(update).not.toHaveProperty('servers');
    } finally {
      ctx.ws = previousTransport.ws;
      ctx.serverEncryptionRequired = previousTransport.serverEncryptionRequired;
      ctx.outboundSendQueue = previousTransport.outboundSendQueue;
      ctx.outboundSendQueueActive = previousTransport.outboundSendQueueActive;
      ctx.CONFIG = previousTransport.CONFIG;
    }
  });

  it('rejects feature flag writes that would overwrite an invalid Agent config', () => {
    const root = makeDir();
    const configPath = join(root, 'config.json');
    for (const invalidConfig of [
      '{"plugins":{"tools":["FileRead"]}',
      'null',
      JSON.stringify({ plugins: { tools: 'not-an-array' } }, null, 2),
    ]) {
      writeFileSync(configPath, invalidConfig);
      expect(isMultiVpEnabled(root)).toBe(false);
      expect(setMultiVpEnabled(root, true)).toMatchObject({
        error: expect.stringContaining('Failed to read config.json'),
      });
      expect(readFileSync(configPath, 'utf8')).toBe(invalidConfig);
      expect(loadConfig({ dir: root })).toMatchObject({
        plugins: { tools: [], skills: [], mcpServers: [] },
        pluginConfigError: expect.any(String),
      });
    }
  });

  it('writes a feature flag only after a valid config precondition', () => {
    const root = makeDir();
    expect(setMultiVpEnabled(root, true)).toEqual({ enabled: true });
    expect(isMultiVpEnabled(root)).toBe(true);
    expect(JSON.parse(readFileSync(join(root, 'config.json'), 'utf8'))).toMatchObject({
      yeaft: { multiVp: { enabled: true } },
    });
  });

  it('rejects CLI writes that would overwrite an invalid Agent config', () => {
    const root = makeDir();
    const configPath = join(root, 'config.json');
    for (const invalidConfig of [
      '{"plugins":{"tools":["FileRead"]}',
      'null',
      JSON.stringify({ plugins: { tools: 'not-an-array' } }, null, 2),
    ]) {
      writeFileSync(configPath, invalidConfig);
      expect(() => readLocalLlmConfig(configPath)).toThrow();
      expect(() => writeLocalLlmConfig({ primaryModel: 'proxy/gpt-5' }, configPath)).toThrow();
      expect(readFileSync(configPath, 'utf8')).toBe(invalidConfig);
      expect(loadConfig({ dir: root })).toMatchObject({
        plugins: { tools: [], skills: [], mcpServers: [] },
        pluginConfigError: expect.any(String),
      });
    }
  });

  it('preserves a valid CLI Plugin allowlist when an LLM write omits it', () => {
    const root = makeDir();
    const configPath = join(root, 'config.json');
    writeFileSync(configPath, JSON.stringify({
      plugins: { tools: ['FileRead'] },
      providers: [{ name: 'old', baseUrl: 'https://example.invalid/v1', models: ['gpt-4'] }],
    }, null, 2));

    writeLocalLlmConfig({ primaryModel: 'new/gpt-5' }, configPath);
    expect(JSON.parse(readFileSync(configPath, 'utf8'))).toMatchObject({
      primaryModel: 'new/gpt-5',
      plugins: { tools: ['FileRead'] },
    });
  });

  it('rejects falsy plugin update payloads instead of resetting the allowlist', async () => {
    const root = makeDir();
    const configPath = join(root, 'config.json');
    const original = JSON.stringify({ plugins: { tools: ['FileRead'] } }, null, 2);
    writeFileSync(configPath, original);
    const previousTransport = {
      ws: ctx.ws,
      serverEncryptionRequired: ctx.serverEncryptionRequired,
      outboundSendQueue: ctx.outboundSendQueue,
      outboundSendQueueActive: ctx.outboundSendQueueActive,
      CONFIG: ctx.CONFIG,
    };
    const sent = [];
    ctx.CONFIG = { yeaftDir: root };
    ctx.ws = { readyState: 1, send(raw) { sent.push(JSON.parse(raw)); } };
    ctx.serverEncryptionRequired = false;
    ctx.outboundSendQueue = [];
    ctx.outboundSendQueueActive = false;
    try {
      for (const payload of [null, false, '']) {
        await handleMessage({ type: 'update_yeaft_plugins', plugins: payload });
        await new Promise(resolve => setImmediate(resolve));
      }
      expect(sent.filter(frame => frame.type === 'yeaft_plugins_updated')).toEqual([
        expect.objectContaining({ error: expect.stringContaining('plugins must be an object') }),
        expect.objectContaining({ error: expect.stringContaining('plugins must be an object') }),
        expect.objectContaining({ error: expect.stringContaining('plugins must be an object') }),
      ]);
      expect(readFileSync(configPath, 'utf8')).toBe(original);
    } finally {
      ctx.ws = previousTransport.ws;
      ctx.serverEncryptionRequired = previousTransport.serverEncryptionRequired;
      ctx.outboundSendQueue = previousTransport.outboundSendQueue;
      ctx.outboundSendQueueActive = previousTransport.outboundSendQueueActive;
      ctx.CONFIG = previousTransport.CONFIG;
    }
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

  it('refreshes an existing VP Engine through update_yeaft_plugins before its next turn', async () => {
    const root = makeDir();
    const sessionId = 'session-live-plugin-policy';
    const streamCalls = [];
    let executions = 0;
    const registry = new ToolRegistry();
    registry.register(defineTool({
      name: 'SensitiveTool',
      description: 'Sensitive Tool',
      parameters: { type: 'object', properties: {} },
      execute: async () => { executions += 1; return 'executed'; },
    }));
    const adapter = {
      refreshProviders() {},
      async *stream(request) {
        streamCalls.push(request);
        if (streamCalls.length === 1) {
          yield { type: 'text_delta', text: 'initial turn' };
          yield { type: 'stop', stopReason: 'end_turn' };
          return;
        }
        if (streamCalls.length === 2) {
          yield { type: 'tool_call', id: 'blocked-tool', name: 'SensitiveTool', input: {} };
          yield { type: 'stop', stopReason: 'tool_use' };
          return;
        }
        if (streamCalls.length === 3) {
          yield { type: 'text_delta', text: 'blocked turn complete' };
          yield { type: 'stop', stopReason: 'end_turn' };
          return;
        }
        yield { type: 'text_delta', text: 'restored turn' };
        yield { type: 'stop', stopReason: 'end_turn' };
      },
      async call() { return { text: '', usage: {} }; },
    };
    const transport = {
      ws: ctx.ws,
      serverEncryptionRequired: ctx.serverEncryptionRequired,
      outboundSendQueue: ctx.outboundSendQueue,
      outboundSendQueueActive: ctx.outboundSendQueueActive,
      CONFIG: ctx.CONFIG,
    };
    const sent = [];
    writeFileSync(join(root, 'config.json'), `${JSON.stringify({
      providers: [{ name: 'test-provider', baseUrl: 'https://example.invalid/v1', apiKey: 'test-key', protocol: 'openai-responses', models: ['gpt-5'] }],
      primaryModel: 'test-provider/gpt-5',
    }, null, 2)}\n`);
    ctx.CONFIG = { yeaftDir: root };
    ctx.ws = { readyState: 1, send(raw) { sent.push(JSON.parse(raw)); } };
    ctx.serverEncryptionRequired = false;
    ctx.outboundSendQueue = [];
    ctx.outboundSendQueueActive = false;
    __testSetSession({
      yeaftDir: root,
      adapter,
      trace: new NullTrace(),
      config: loadConfig({ dir: root }),
      engine: { refreshConfig: vi.fn() },
      conversationStore: {
        append: record => ({ id: `message-${record.role}`, ...record }),
        loadRecentBySession: () => [],
        readCompactSummary: () => '',
      },
      memoryIndex: null,
      amsRegistry: null,
      toolRegistry: registry,
      skillManager: null,
      mcpManager: { disconnectAll: async () => {}, status: () => [] },
      taskManager: { renderActiveTasksForPrompt: () => '' },
      toolStats: null,
      status: { skills: 0, mcpServers: [], mcpFailed: [], tools: 1 },
    });
    __testHooks.setRuntimeFactoriesForTest({
      createSkillManager: () => ({ size: 0, list: () => [] }),
      createMcpManager: () => ({
        connectAll: async () => ({ connected: [], failed: [] }),
        disconnectAll: async () => {},
        status: () => [],
      }),
      loadMcpConfig: () => ({ servers: [], skipped: [] }),
    });
    try {
      const engine = __testGetOrCreateVpEngine(sessionId, 'vp-a', 'main');
      for await (const _event of engine.query({ prompt: 'initial', sessionId })) {}
      expect(streamCalls[0].tools?.map(tool => tool.name) || []).toEqual(['SensitiveTool']);

      await handleMessage({ type: 'update_yeaft_plugins', plugins: { tools: [] } });
      await new Promise(resolve => setTimeout(resolve, 10));
      const blockedEvents = [];
      for await (const event of engine.query({ prompt: 'attempt after disable', sessionId })) blockedEvents.push(event);
      expect(streamCalls[1].tools).toBeUndefined();
      expect(executions).toBe(0);
      expect(blockedEvents.find(event => event.type === 'tool_end')).toMatchObject({
        name: 'SensitiveTool',
        isError: true,
        output: expect.stringContaining('unknown tool'),
      });

      await handleMessage({ type: 'update_yeaft_plugins', plugins: {} });
      await new Promise(resolve => setTimeout(resolve, 10));
      for await (const _event of engine.query({ prompt: 'after restore', sessionId })) {}
      expect(streamCalls.at(-1).tools.map(tool => tool.name)).toEqual(['SensitiveTool']);
      expect(sent.filter(frame => frame.type === 'yeaft_plugins_updated')).toHaveLength(2);
    } finally {
      __testHooks.resetRuntimeFactoriesForTest();
      ctx.ws = transport.ws;
      ctx.serverEncryptionRequired = transport.serverEncryptionRequired;
      ctx.outboundSendQueue = transport.outboundSendQueue;
      ctx.outboundSendQueueActive = transport.outboundSendQueueActive;
      ctx.CONFIG = transport.CONFIG;
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
