import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ctx from '../../../agent/context.js';
import { loadConfig } from '../../../agent/yeaft/config.js';
import { NullTrace } from '../../../agent/yeaft/debug-trace.js';
import { loadSession } from '../../../agent/yeaft/session.js';
import { __testGetOrCreateVpEngine, __testHooks, __testResolveVpEffectiveConfig, __testSetSession, handleYeaftCreateSession, refreshLiveSessionConfig } from '../../../agent/yeaft/web-bridge.js';
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
  });

  it('falls back to agent default when Session has no model', () => {
    const root = makeDir();
    const userConfig = { model: 'proxy/gpt-5', primaryModel: 'proxy/gpt-5' };

    const effective = resolveSessionConfig(userConfig, loadSessionConfig(root, 'session-empty'));

    expect(effective.model).toBe('proxy/gpt-5');
    expect(effective.primaryModel).toBe('proxy/gpt-5');
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

  it('uses the first available model as an effective default when primaryModel is absent', () => {
    const root = makeDir();
    writeFileSync(join(root, 'config.json'), JSON.stringify({
      providers: [
        { name: 'github-copilot', baseUrl: 'https://api.githubcopilot.com', credentialProvider: 'github-copilot', models: ['gpt-5.5', 'claude-opus-4.8'] },
      ],
    }));

    const config = loadConfig({ dir: root });
    const effective = resolveSessionConfig(config, {});

    expect(config.primaryModel).toBe(null);
    expect(config.model).toBe('github-copilot/gpt-5.5');
    expect(effective.model).toBe('github-copilot/gpt-5.5');
  });

  it('includes user-level Session config in snapshots', () => {
    const root = makeDir();
    const workDir = tempRoot('yeaft-session-config-workdir-');
    const { sessionId } = createProjectSessionArtifact(root, workDir, 'session-workdir-snapshot');
    writeFileSync(join(root, 'sessions', sessionId, 'config.json'), `${JSON.stringify({ model: 'agent/gpt-5', modelEffort: 'low' }, null, 2)}\n`);
    updateSessionConfig(root, sessionId, { model: 'project/claude-sonnet', modelEffort: 'high' });

    const row = snapshotSessions(root).find(s => s.id === sessionId);

    expect(row?.config).toEqual({ model: 'project/claude-sonnet', modelEffort: 'high' });
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

  it('creates a Session without persisting the implicit Agent default', () => {
    const root = makeDir();
    ctx.CONFIG = { yeaftDir: root };
    writeFileSync(join(root, 'config.json'), `${JSON.stringify({
      providers: [{ name: 'github-copilot', credentialProvider: 'github-copilot', models: ['gpt-default'] }],
      primaryModel: 'github-copilot/gpt-default',
    }, null, 2)}\n`);

    handleYeaftCreateSession({
      requestId: 'create-no-model',
      payload: { name: 'No implicit model', roster: [], defaultVpId: null },
    });

    const row = snapshotSessions(root).find(sessionRow => sessionRow.name === 'No implicit model');
    expect(row).toBeTruthy();
    expect(row.config).toEqual({});
    expect(JSON.parse(readFileSync(join(root, 'sessions', row.id, 'config.json'), 'utf8'))).toEqual({});
  });

  it('rejects client-supplied model provenance', () => {
    const root = makeDir();
    mkdirSync(join(root, 'sessions', 'session-provenance'), { recursive: true });

    expect(() => saveSessionConfig(root, 'session-provenance', {
      model: 'github-copilot/gpt-new',
      modelSource: 'explicit',
    })).toThrow('unknown config key: modelSource');
  });

  it('normalizes legacy automatic defaults even when no runtime is loaded', async () => {
    const root = makeDir();
    const sessionId = 'session-unloaded-legacy-default';
    createSession(sessionsRoot(root), {
      id: sessionId,
      name: sessionId,
      roster: [],
      defaultVpId: null,
    }).close();
    writeFileSync(join(root, 'sessions', sessionId, 'config.json'), `${JSON.stringify({
      model: 'github-copilot/gpt-old',
    }, null, 2)}\n`);
    writeFileSync(join(root, 'config.json'), `${JSON.stringify({
      providers: [{ name: 'github-copilot', credentialProvider: 'github-copilot', models: ['gpt-new'] }],
      primaryModel: 'github-copilot/gpt-new',
    }, null, 2)}\n`);
    ctx.CONFIG = { yeaftDir: root };
    __testSetSession(null);

    const fresh = await refreshLiveSessionConfig({
      previousDefaultModel: 'github-copilot/gpt-old',
    });

    expect(fresh.primaryModel).toBe('github-copilot/gpt-new');
    expect(loadSessionConfig(root, sessionId)).toEqual({});
  });

  it('uses the user-level root for VP engine model overrides', () => {
    const root = makeDir();
    const workDir = tempRoot('yeaft-session-config-workdir-');
    const { projectYeaftDir, sessionId } = createProjectSessionArtifact(root, workDir, 'session-workdir-engine');
    writeFileSync(join(root, 'sessions', sessionId, 'config.json'), `${JSON.stringify({ model: 'agent/gpt-5', modelEffort: 'low' }, null, 2)}\n`);
    writeFileSync(join(projectYeaftDir, 'sessions', sessionId, 'config.json'), `${JSON.stringify({ model: 'project/claude-sonnet', modelEffort: 'high' }, null, 2)}\n`);
    ctx.CONFIG = { yeaftDir: root };
    __testSetSession({
      yeaftDir: root,
      config: { dir: root, model: 'agent/default', primaryModel: 'agent/default', modelEffort: 'medium' },
      conversationStore: { loadRecentBySession: () => [] },
    });

    const effective = __testResolveVpEffectiveConfig(sessionId);

    expect(effective.model).toBe('agent/gpt-5');
    expect(effective.primaryModel).toBe('agent/gpt-5');
    expect(effective.modelEffort).toBe('low');
  });

  it('hot-reloads the Agent provider catalog without copying it into Session config', async () => {
    const root = makeDir();
    const sessionId = 'session-catalog-refresh';
    mkdirSync(join(root, 'sessions', sessionId), { recursive: true });
    saveSessionConfig(root, sessionId, { model: 'github-copilot/gpt-new' });
    writeFileSync(join(root, 'config.json'), `${JSON.stringify({
      providers: [{
        name: 'github-copilot',
        credentialProvider: 'github-copilot',
        managed: 'github-copilot',
        models: [{ id: 'gpt-new', protocol: 'openai-responses' }],
      }],
      primaryModel: 'github-copilot/gpt-new',
    }, null, 2)}\n`);
    ctx.CONFIG = { yeaftDir: root };
    const refreshProviders = vi.fn();
    __testSetSession({
      yeaftDir: root,
      config: {
        dir: root,
        model: 'github-copilot/gpt-default',
        primaryModel: 'github-copilot/gpt-default',
        availableModels: [{ id: 'gpt-default', ref: 'github-copilot/gpt-default', provider: 'github-copilot' }],
        providers: [],
      },
      adapter: { refreshProviders },
    });

    const fresh = await refreshLiveSessionConfig();
    const effective = __testResolveVpEffectiveConfig(sessionId);

    expect(fresh.availableModels.map(model => model.ref)).toEqual(['github-copilot/gpt-new']);
    expect(effective.availableModels.map(model => model.ref)).toEqual(['github-copilot/gpt-new']);
    expect(effective.model).toBe('github-copilot/gpt-new');
    expect(refreshProviders).toHaveBeenCalledWith(expect.arrayContaining([
      expect.objectContaining({ name: 'github-copilot' }),
    ]));
    expect(loadSessionConfig(root, sessionId)).toEqual({ model: 'github-copilot/gpt-new' });
  });

  it('normalizes a legacy default and backfills provenance for legacy explicit choices', async () => {
    const root = makeDir();
    const legacySeedId = 'session-legacy-seed';
    const legacyExplicitId = 'session-legacy-explicit';
    const explicitId = 'session-explicit-default';
    for (const sessionId of [legacySeedId, legacyExplicitId, explicitId]) {
      createSession(sessionsRoot(root), {
        id: sessionId,
        name: sessionId,
        roster: [],
        defaultVpId: null,
      }).close();
    }
    writeFileSync(join(root, 'sessions', legacySeedId, 'config.json'), `${JSON.stringify({ model: 'github-copilot/gpt-default' }, null, 2)}\n`);
    writeFileSync(join(root, 'sessions', legacyExplicitId, 'config.json'), `${JSON.stringify({ model: 'github-copilot/gpt-override' }, null, 2)}\n`);
    saveSessionConfig(root, explicitId, { model: 'github-copilot/gpt-default' });
    writeFileSync(join(root, 'config.json'), `${JSON.stringify({
      providers: [{ name: 'github-copilot', credentialProvider: 'github-copilot', models: ['gpt-default', 'gpt-new', 'gpt-override'] }],
      primaryModel: 'github-copilot/gpt-new',
    }, null, 2)}\n`);
    ctx.CONFIG = { yeaftDir: root };
    __testSetSession({
      yeaftDir: root,
      config: {
        dir: root,
        model: 'github-copilot/gpt-default',
        primaryModel: 'github-copilot/gpt-default',
        providers: [{ name: 'github-copilot', credentialProvider: 'github-copilot', models: ['gpt-default'] }],
        availableModels: [{ id: 'gpt-default', ref: 'github-copilot/gpt-default', provider: 'github-copilot' }],
      },
      adapter: { refreshProviders() {} },
    });

    await refreshLiveSessionConfig();

    expect(loadSessionConfig(root, legacySeedId)).toEqual({});
    expect(__testResolveVpEffectiveConfig(legacySeedId).model).toBe('github-copilot/gpt-new');
    expect(loadSessionConfig(root, legacyExplicitId)).toEqual({ model: 'github-copilot/gpt-override' });
    expect(JSON.parse(readFileSync(join(root, 'sessions', legacyExplicitId, 'config.json'), 'utf8')))
      .toEqual({ model: 'github-copilot/gpt-override', modelSource: 'explicit' });
    expect(loadSessionConfig(root, explicitId)).toEqual({ model: 'github-copilot/gpt-default' });
    expect(__testResolveVpEffectiveConfig(explicitId).model).toBe('github-copilot/gpt-default');
  });

  it('preserves an explicit Session override that remains in the refreshed catalog', async () => {
    const root = makeDir();
    const sessionId = 'session-explicit-override';
    mkdirSync(join(root, 'sessions', sessionId), { recursive: true });
    saveSessionConfig(root, sessionId, { model: 'github-copilot/gpt-override' });
    writeFileSync(join(root, 'config.json'), `${JSON.stringify({
      providers: [{ name: 'github-copilot', credentialProvider: 'github-copilot', models: ['gpt-default', 'gpt-override'] }],
      primaryModel: 'github-copilot/gpt-default',
    }, null, 2)}\n`);
    ctx.CONFIG = { yeaftDir: root };
    __testSetSession({
      yeaftDir: root,
      config: {
        dir: root,
        model: 'gpt-old-default',
        primaryModel: 'github-copilot/gpt-old-default',
        availableModels: [{ id: 'gpt-old-default', ref: 'github-copilot/gpt-old-default', provider: 'github-copilot' }],
      },
      adapter: { refreshProviders() {} },
    });

    await refreshLiveSessionConfig();

    expect(__testResolveVpEffectiveConfig(sessionId).model).toBe('github-copilot/gpt-override');
    expect(loadSessionConfig(root, sessionId)).toEqual({ model: 'github-copilot/gpt-override' });
  });

  it('canonicalizes a uniquely owned bare managed model and rejects stale or ambiguous bare refs', () => {
    const managed = {
      providers: [{ name: 'github-copilot', credentialProvider: 'github-copilot', models: ['gpt-new'] }],
      primaryModel: 'github-copilot/gpt-new',
      model: 'gpt-new',
      availableModels: [{ id: 'gpt-new', ref: 'github-copilot/gpt-new', provider: 'github-copilot' }],
    };

    expect(resolveSessionConfig(managed, { model: 'gpt-new' }).primaryModel)
      .toBe('github-copilot/gpt-new');
    expect(resolveSessionConfig(managed, { model: 'gpt-old' }).primaryModel)
      .toBe('github-copilot/gpt-new');

    const ambiguous = {
      ...managed,
      model: 'gpt-default',
      primaryModel: 'github-copilot/gpt-default',
      providers: [
        { ...managed.providers[0], models: ['gpt-default', 'gpt-new'] },
        { name: 'custom', baseUrl: 'http://custom/v1', models: ['gpt-new', 'custom-only'] },
      ],
      availableModels: [
        { id: 'gpt-default', ref: 'github-copilot/gpt-default', provider: 'github-copilot' },
        ...managed.availableModels,
        { id: 'gpt-new', ref: 'custom/gpt-new', provider: 'custom' },
        { id: 'custom-only', ref: 'custom/custom-only', provider: 'custom' },
      ],
    };
    expect(resolveSessionConfig(ambiguous, { model: 'gpt-new' }).primaryModel)
      .toBe('github-copilot/gpt-default');
    expect(resolveSessionConfig(ambiguous, { model: 'custom-only' }).primaryModel)
      .toBe('custom/custom-only');
    expect(resolveSessionConfig(ambiguous, { model: 'custom/gpt-new' }).primaryModel)
      .toBe('custom/gpt-new');
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

  it('rebuilds a cached VP engine when the session model config changes on disk', () => {
    const root = makeDir();
    const sessionId = 'session-engine-refresh';
    mkdirSync(join(root, 'sessions', sessionId), { recursive: true });
    writeFileSync(join(root, 'sessions', sessionId, 'session.json'), `${JSON.stringify({ id: sessionId, name: 'Engine refresh', roster: ['vp-a'], defaultVpId: 'vp-a' }, null, 2)}\n`);
    ctx.CONFIG = { yeaftDir: root };
    __testSetSession({
      yeaftDir: root,
      adapter: { stream: async function* () {}, call: async () => ({ text: '', usage: {} }) },
      trace: new NullTrace(),
      config: { model: 'agent/default', primaryModel: 'agent/default', modelEffort: 'medium', dir: root },
      conversationStore: { loadRecentBySession: () => [], readCompactSummary: () => '' },
      memoryIndex: null,
      amsRegistry: null,
      toolRegistry: null,
      skillManager: null,
      mcpManager: null,
      taskManager: { renderActiveTasksForPrompt: () => '' },
      toolStats: null,
    });
    saveSessionConfig(root, sessionId, { model: 'project/claude-sonnet', modelEffort: 'high' });
    const first = __testGetOrCreateVpEngine(sessionId, 'vp-a', 'main');
    saveSessionConfig(root, sessionId, { model: 'project/gpt-5', modelEffort: 'max' });

    const second = __testGetOrCreateVpEngine(sessionId, 'vp-a', 'main');
    const effective = __testResolveVpEffectiveConfig(sessionId);

    expect(first).toBeTruthy();
    expect(second).toBeTruthy();
    expect(second).not.toBe(first);
    expect(effective.model).toBe('project/gpt-5');
    expect(effective.primaryModel).toBe('project/gpt-5');
    expect(effective.modelEffort).toBe('max');
  });

  it('keeps user-level overrides available after a project runtime booted first', () => {
    const root = makeDir();
    const workDir = tempRoot('yeaft-session-config-workdir-');
    createProjectSessionArtifact(root, workDir, 'session-workdir-first-runtime');
    const agentLocalSessionId = 'session-agent-local-after-workdir';
    createSession(sessionsRoot(root), {
      id: agentLocalSessionId,
      name: 'Agent-local session',
      roster: [],
      defaultVpId: null,
    }).close();
    saveSessionConfig(root, agentLocalSessionId, { model: 'agent/local-sonnet', modelEffort: 'minimal' });
    ctx.CONFIG = { yeaftDir: root };
    __testSetSession({
      yeaftDir: root,
      config: { dir: root, model: 'agent/default', primaryModel: 'agent/default', modelEffort: 'medium' },
      conversationStore: { loadRecentBySession: () => [] },
    });

    const effective = __testResolveVpEffectiveConfig(agentLocalSessionId);

    expect(effective.model).toBe('agent/local-sonnet');
    expect(effective.primaryModel).toBe('agent/local-sonnet');
    expect(effective.modelEffort).toBe('minimal');
  });

  it('uses a longer silence watchdog for high-reasoning session effort', () => {
    expect(__testHooks.queryTimeoutMsForSessionConfig({ modelEffort: 'high' })).toBe(300_000);
    expect(__testHooks.queryTimeoutMsForSessionConfig({ modelEffort: 'xhigh' })).toBe(300_000);
    expect(__testHooks.queryTimeoutMsForSessionConfig({ modelEffort: 'max' })).toBe(300_000);
    expect(__testHooks.queryTimeoutMsForSessionConfig({ modelEffort: 'medium' })).toBe(120_000);
    expect(__testHooks.queryTimeoutMsForSessionConfig({})).toBe(120_000);
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
