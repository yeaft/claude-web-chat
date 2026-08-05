import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ctx from '../../../agent/context.js';
import { loadConfig, normalizeLlmRetry } from '../../../agent/yeaft/config.js';
import { NullTrace } from '../../../agent/yeaft/debug-trace.js';
import { loadSession } from '../../../agent/yeaft/session.js';
import { __testGetOrCreateVpEngine, __testHooks, __testLoadPluginCatalogMcpConfig, __testResolveVpEffectiveConfig, __testSetSession, handleYeaftCreateSession, refreshLiveSessionConfig } from '../../../agent/yeaft/web-bridge.js';
import { loadSessionConfig, normalizeSessionConfig, resolveSessionConfig, saveSessionConfig } from '../../../agent/yeaft/sessions/session-config.js';
import { createSession } from '../../../agent/yeaft/sessions/session-store.js';
import { registerSessionWorkDir, sessionsRoot, snapshotSessions, updateSessionConfig } from '../../../agent/yeaft/sessions/session-crud.js';

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

afterEach(() => {
  ctx.CONFIG = originalConfig;
  __testSetSession(null);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('Yeaft session-scoped model config', () => {
  it('keeps model and effort isolated per Session', () => {
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
    __testSetSession({
      yeaftDir: root,
      config: { dir: root },
      toolRegistry: null,
      skillManager: null,
      mcpManager: { status: () => [{ name: 'stale-runtime', ready: true, toolCount: 1 }] },
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

  });


  it('ignores project .yeaft Session config and uses the user-level Session config', () => {
    const root = makeDir();
    const workDir = tempRoot('yeaft-session-config-workdir-');
    const { projectYeaftDir, sessionId } = createProjectSessionArtifact(root, workDir, 'session-workdir-first');

    writeFileSync(join(projectYeaftDir, 'sessions', sessionId, 'config.json'), `${JSON.stringify({ model: 'project/claude-sonnet', modelEffort: 'high' }, null, 2)}\n`);
    writeFileSync(join(root, 'sessions', sessionId, 'config.json'), `${JSON.stringify({ model: 'agent/gpt-5', modelEffort: 'low' }, null, 2)}\n`);

    const config = loadSessionConfig(root, sessionId);

    expect(config).toEqual({ model: 'agent/gpt-5', modelEffort: 'low' });
  });


  it('writes Session config only to the user-level root', () => {
    const root = makeDir();
    const workDir = tempRoot('yeaft-session-config-workdir-');
    const { projectYeaftDir, sessionId } = createProjectSessionArtifact(root, workDir, 'session-workdir-update');
    writeFileSync(join(projectYeaftDir, 'sessions', sessionId, 'config.json'), `${JSON.stringify({ model: 'project/stale', modelEffort: 'low' }, null, 2)}\n`);

    const saved = updateSessionConfig(root, sessionId, { model: 'agent/claude-haiku', modelEffort: 'max' });

    expect(saved).toEqual({ model: 'agent/claude-haiku', modelEffort: 'max' });
    expect(loadSessionConfig(root, sessionId)).toEqual({ model: 'agent/claude-haiku', modelEffort: 'max' });
    expect(JSON.parse(readFileSync(join(projectYeaftDir, 'sessions', sessionId, 'config.json'), 'utf8')))
      .toEqual({ model: 'project/stale', modelEffort: 'low' });
    expect(JSON.parse(readFileSync(join(root, 'sessions', sessionId, 'config.json'), 'utf8')))
      .toEqual({ model: 'agent/claude-haiku', modelEffort: 'max', modelSource: 'explicit' });
  });


  it('rejects client-supplied model provenance', () => {
    const root = makeDir();
    mkdirSync(join(root, 'sessions', 'session-provenance'), { recursive: true });

    expect(() => saveSessionConfig(root, 'session-provenance', {
      model: 'github-copilot/gpt-new',
      modelSource: 'explicit',
    })).toThrow('unknown config key: modelSource');
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


  it('loads runtime config from agent root while storing message history under the user-level root', async () => {
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
