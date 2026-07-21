import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ctx from '../../../agent/context.js';
import {
  __testHooks,
  __testResetVpState,
  resetYeaftSession,
} from '../../../agent/yeaft/web-bridge.js';

function deferred() {
  let resolve;
  let reject;
  let settled = false;
  const promise = new Promise((res, rej) => {
    resolve = (value) => {
      if (settled) return;
      settled = true;
      res(value);
    };
    reject = (error) => {
      if (settled) return;
      settled = true;
      rej(error);
    };
  });
  return { promise, resolve, reject, get settled() { return settled; } };
}

function createSkillManager(name, initialSkills = []) {
  let skills = initialSkills.map(skill => ({ ...skill }));
  let changed = false;
  return {
    name,
    get size() { return skills.length; },
    list() { return skills.map(skill => ({ ...skill })); },
    load: vi.fn(() => {
      const result = { changed, loaded: skills.length, errors: [] };
      changed = false;
      return result;
    }),
    setSkills(nextSkills) {
      skills = nextSkills.map(skill => ({ ...skill }));
      changed = true;
    },
  };
}

function createMcpManager(name, connectGate = null) {
  return {
    name,
    connectAll: vi.fn(async () => {
      if (connectGate) await connectGate.promise;
      return { connected: [`${name}-server`], failed: [] };
    }),
    disconnectAll: vi.fn(async () => {}),
    listTools: vi.fn(() => []),
    status: vi.fn(() => []),
    get hasServers() { return false; },
    get toolCount() { return 0; },
  };
}

function createSession(name, {
  skillManager = createSkillManager(`${name}-original-skill`),
  mcpManager = createMcpManager(`${name}-original-mcp`),
} = {}) {
  const registryManagers = [];
  const session = {
    name,
    yeaftDir: `/tmp/${name}`,
    config: {
      model: 'test-model',
      primaryModel: 'test-model',
      availableModels: [],
    },
    status: {
      skills: skillManager.size,
      mcpServers: [],
      mcpFailed: [],
      mcpSkipped: [],
      tools: 0,
    },
    skillManager,
    mcpManager,
    toolRegistry: {
      size: 0,
      replaceMcpTools: vi.fn((manager) => {
        registryManagers.push(manager);
        return { removed: 0, added: 0 };
      }),
    },
    engine: { setRuntimeManagers: vi.fn() },
    taskManager: {
      listActiveTasks: vi.fn(() => []),
      setEventSink: vi.fn(),
    },
    shutdown: vi.fn(async () => {}),
  };
  session.registryManagers = registryManagers;
  return session;
}

function latestSkillFrame() {
  return ctx.messageBuffer.findLast(message => message?.type === 'slash_commands_update') || null;
}

const openGates = new Set();

function trackedDeferred() {
  const gate = deferred();
  openGates.add(gate);
  return gate;
}

beforeEach(async () => {
  await __testHooks.shutdownProjectRuntimes();
  __testHooks.resetRuntimeFactoriesForTest();
  __testHooks.setSessionForTest(null);
  ctx.messageBuffer = [];
});

afterEach(async () => {
  for (const gate of openGates) gate.resolve();
  openGates.clear();
  await __testResetVpState();
  __testHooks.resetRuntimeFactoriesForTest();
  __testHooks.setSessionForTest(null);
  ctx.messageBuffer = [];
  vi.useRealTimers();
});

describe('Yeaft runtime loader lifecycle', () => {
  it('keeps a stale base loader from mutating the replacement session after reset', async () => {
    vi.useFakeTimers();
    const staleConnect = trackedDeferred();
    const staleSkillManager = createSkillManager('stale-skill', [
      { name: 'stale-only', description: 'Stale Skill', tier: 'user' },
    ]);
    const freshSkillManager = createSkillManager('fresh-skill', [
      { name: 'fresh-only', description: 'Fresh Skill', tier: 'user' },
    ]);
    const staleMcpManager = createMcpManager('stale', staleConnect);
    const freshMcpManager = createMcpManager('fresh');
    const oldSession = createSession('session-old');
    const newSession = createSession('session-new');
    const skillManagers = [staleSkillManager, freshSkillManager];
    const mcpManagers = [staleMcpManager, freshMcpManager];
    const mcpConfigs = [
      { servers: [{ name: 'stale-server' }], skipped: [] },
      { servers: [], skipped: [] },
    ];

    __testHooks.setSessionForTest(oldSession);
    __testHooks.setRuntimeFactoriesForTest({
      createSkillManager: () => skillManagers.shift(),
      createMcpManager: () => mcpManagers.shift(),
      loadMcpConfig: () => mcpConfigs.shift(),
      loadSession: async () => newSession,
    });

    const staleLoader = __testHooks.scheduleBaseRuntimeLoadForTest();
    await vi.advanceTimersByTimeAsync(0);
    expect(staleMcpManager.connectAll).toHaveBeenCalledTimes(1);

    const oldRetargetCount = oldSession.engine.setRuntimeManagers.mock.calls.length;
    ctx.messageBuffer = [];
    let resetSettled = false;
    const reset = resetYeaftSession().then(() => { resetSettled = true; });
    await Promise.resolve();
    expect(resetSettled).toBe(false);

    staleConnect.resolve();
    await staleLoader;
    await reset;
    await vi.advanceTimersByTimeAsync(0);

    expect(staleMcpManager.disconnectAll).toHaveBeenCalledTimes(1);
    expect(oldSession.engine.setRuntimeManagers).toHaveBeenCalledTimes(oldRetargetCount);
    expect(newSession.skillManager).toBe(freshSkillManager);
    expect(newSession.mcpManager).toBe(freshMcpManager);
    expect(newSession.registryManagers).not.toContain(staleMcpManager);
    expect(ctx.messageBuffer.some(message => (
      message?.type === 'slash_commands_update'
      && message.slashCommands?.includes('yeaft-skills:stale-only')
    ))).toBe(false);
    const snapshot = __testHooks.runtimeLifecycleSnapshotForTest();
    expect(snapshot.ownerSession).toBe(newSession);
    expect(snapshot.timerOwnerSession).toBe(newSession);
  });

  it('does not let an old project loader delete or repopulate a new same-key loader', async () => {
    const oldConnect = trackedDeferred();
    const newConnect = trackedDeferred();
    const oldMcpManager = createMcpManager('old-project', oldConnect);
    const newMcpManager = createMcpManager('new-project', newConnect);
    const oldSkillManager = createSkillManager('old-project-skill');
    const newSkillManager = createSkillManager('new-project-skill');
    const oldSession = createSession('project-owner-old');
    const newSession = createSession('project-owner-new');

    __testHooks.setSessionForTest(oldSession);
    __testHooks.setRuntimeFactoriesForTest({
      createSkillManager: () => oldSkillManager,
      createMcpManager: () => oldMcpManager,
      loadMcpConfig: () => ({ servers: [{ name: 'old-project' }], skipped: [] }),
    });
    const oldLoader = __testHooks.scheduleProjectRuntimeLoadForTest('/tmp/shared-project');
    expect(oldMcpManager.connectAll).toHaveBeenCalledTimes(1);

    const shutdown = __testHooks.shutdownProjectRuntimes();
    __testHooks.setSessionForTest(newSession);
    __testHooks.setRuntimeFactoriesForTest({
      createSkillManager: () => newSkillManager,
      createMcpManager: () => newMcpManager,
      loadMcpConfig: () => ({ servers: [{ name: 'new-project' }], skipped: [] }),
    });
    const newLoader = __testHooks.scheduleProjectRuntimeLoadForTest('/tmp/shared-project');
    expect(newMcpManager.connectAll).toHaveBeenCalledTimes(1);
    expect(newLoader).not.toBe(oldLoader);

    oldConnect.resolve();
    await oldLoader;
    await shutdown;

    let snapshot = __testHooks.runtimeLifecycleSnapshotForTest('/tmp/shared-project');
    expect(snapshot.projectPromise).toBe(newLoader);
    expect(snapshot.projectRuntime?.mcpManager).toBe(newMcpManager);
    expect(snapshot.ownerSession).toBe(newSession);
    expect(snapshot.activeRuntimeKey).toBe('/tmp/shared-project');
    expect(oldMcpManager.disconnectAll).toHaveBeenCalledTimes(1);
    expect(newMcpManager.disconnectAll).not.toHaveBeenCalled();

    newConnect.resolve();
    await newLoader;
    snapshot = __testHooks.runtimeLifecycleSnapshotForTest('/tmp/shared-project');
    expect(snapshot.projectPromise).toBeNull();
    expect(snapshot.projectRuntime?.mcpManager).toBe(newMcpManager);
  });

  it('keeps the old same-key finally isolated when the new loader settles first', async () => {
    const oldConnect = trackedDeferred();
    const newConnect = trackedDeferred();
    const oldMcpManager = createMcpManager('old-project-late', oldConnect);
    const newMcpManager = createMcpManager('new-project-early', newConnect);
    const oldSession = createSession('late-owner-old');
    const newSession = createSession('early-owner-new');

    __testHooks.setSessionForTest(oldSession);
    __testHooks.setRuntimeFactoriesForTest({
      createSkillManager: () => createSkillManager('old-late-skill'),
      createMcpManager: () => oldMcpManager,
      loadMcpConfig: () => ({ servers: [{ name: 'old-project-late' }], skipped: [] }),
    });
    const oldLoader = __testHooks.scheduleProjectRuntimeLoadForTest('/tmp/same-key-project');
    const shutdown = __testHooks.shutdownProjectRuntimes();

    __testHooks.setSessionForTest(newSession);
    __testHooks.setRuntimeFactoriesForTest({
      createSkillManager: () => createSkillManager('new-early-skill'),
      createMcpManager: () => newMcpManager,
      loadMcpConfig: () => ({ servers: [{ name: 'new-project-early' }], skipped: [] }),
    });
    const newLoader = __testHooks.scheduleProjectRuntimeLoadForTest('/tmp/same-key-project');

    newConnect.resolve();
    await newLoader;
    let snapshot = __testHooks.runtimeLifecycleSnapshotForTest('/tmp/same-key-project');
    expect(snapshot.projectPromise).toBeNull();
    expect(snapshot.projectRuntime?.mcpManager).toBe(newMcpManager);

    oldConnect.resolve();
    await oldLoader;
    await shutdown;
    snapshot = __testHooks.runtimeLifecycleSnapshotForTest('/tmp/same-key-project');
    expect(snapshot.projectPromise).toBeNull();
    expect(snapshot.projectRuntime?.mcpManager).toBe(newMcpManager);
    expect(snapshot.ownerSession).toBe(newSession);
    expect(oldMcpManager.disconnectAll).toHaveBeenCalledTimes(1);
    expect(newMcpManager.disconnectAll).not.toHaveBeenCalled();
  });

  it('waits for rejected loaders to finish cleanup without leaking an unhandled rejection', async () => {
    const rejectedConnect = trackedDeferred();
    const staleMcpManager = createMcpManager('rejecting-project', rejectedConnect);
    const oldSession = createSession('reject-owner-old');
    const newSession = createSession('reject-owner-new');
    const unhandled = [];
    const onUnhandled = reason => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);

    try {
      __testHooks.setSessionForTest(oldSession);
      __testHooks.setRuntimeFactoriesForTest({
        createSkillManager: () => createSkillManager('rejecting-skill'),
        createMcpManager: () => staleMcpManager,
        loadMcpConfig: () => ({ servers: [{ name: 'rejecting-project' }], skipped: [] }),
        loadSession: async () => newSession,
      });
      __testHooks.scheduleProjectRuntimeLoadForTest('/tmp/rejecting-project');

      let resetSettled = false;
      const reset = resetYeaftSession().then(() => { resetSettled = true; });
      await Promise.resolve();
      expect(resetSettled).toBe(false);

      rejectedConnect.reject(new Error('expected project startup failure'));
      await reset;
      await Promise.resolve();

      expect(staleMcpManager.disconnectAll).toHaveBeenCalledTimes(1);
      expect(unhandled).toEqual([]);
      expect(__testHooks.runtimeLifecycleSnapshotForTest().ownerSession).toBe(newSession);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('keeps one current-owner timer when an old loader settles after shutdown', async () => {
    vi.useFakeTimers();
    const staleConnect = trackedDeferred();
    const staleSkillManager = createSkillManager('stale-timer-skill');
    const currentSkillManager = createSkillManager('current-timer-skill');
    const staleMcpManager = createMcpManager('stale-timer-mcp', staleConnect);
    const oldSession = createSession('timer-owner-old');
    const newSession = createSession('timer-owner-new', { skillManager: currentSkillManager });

    __testHooks.setSessionForTest(oldSession);
    __testHooks.setRuntimeFactoriesForTest({
      createSkillManager: () => staleSkillManager,
      createMcpManager: () => staleMcpManager,
      loadMcpConfig: () => ({ servers: [{ name: 'stale-timer' }], skipped: [] }),
    });
    const oldLoader = __testHooks.scheduleBaseRuntimeLoadForTest();
    vi.advanceTimersByTime(0);
    await Promise.resolve();
    await Promise.resolve();
    expect(staleMcpManager.connectAll).toHaveBeenCalledTimes(1);

    const shutdown = __testHooks.shutdownProjectRuntimes();
    __testHooks.setSessionForTest(newSession);
    __testHooks.startSkillHotReloadForTest();
    staleSkillManager.load.mockClear();
    currentSkillManager.load.mockClear();
    ctx.messageBuffer = [];

    staleConnect.resolve();
    await oldLoader;
    await shutdown;
    await vi.advanceTimersByTimeAsync(2_001);

    expect(staleSkillManager.load).not.toHaveBeenCalled();
    expect(currentSkillManager.load).toHaveBeenCalledTimes(1);
    expect(staleMcpManager.disconnectAll).toHaveBeenCalledTimes(1);
    expect(ctx.messageBuffer.some(message => (
      message?.type === 'slash_commands_update'
      && message.slashCommands?.includes('yeaft-skills:stale-timer-skill')
    ))).toBe(false);
    const snapshot = __testHooks.runtimeLifecycleSnapshotForTest();
    expect(snapshot.timerActive).toBe(true);
    expect(snapshot.timerOwnerGeneration).toBe(snapshot.generation);
    expect(snapshot.timerOwnerSession).toBe(newSession);
    expect(vi.getTimerCount()).toBe(1);
  });

  it('polls only the active manager and reloads inactive runtimes when reactivated', async () => {
    vi.useFakeTimers();
    const baseManager = createSkillManager('base', [
      { name: 'base-skill', description: 'Base Skill', tier: 'user' },
    ]);
    const managerA = createSkillManager('project-a', [
      { name: 'project-a', description: 'Project A', tier: 'project' },
    ]);
    const managerB = createSkillManager('project-b', [
      { name: 'project-b', description: 'Project B', tier: 'project' },
    ]);
    const session = createSession('active-only-owner', { skillManager: baseManager });
    __testHooks.setSessionForTest(session);
    __testHooks.seedProjectRuntime('/tmp/project-a', { skillManager: managerA });
    __testHooks.seedProjectRuntime('/tmp/project-b', { skillManager: managerB });

    __testHooks.activateProjectRuntimeForTest('/tmp/project-a');
    baseManager.load.mockClear();
    managerA.load.mockClear();
    managerB.load.mockClear();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(managerA.load).toHaveBeenCalledTimes(1);
    expect(managerB.load).not.toHaveBeenCalled();
    expect(baseManager.load).not.toHaveBeenCalled();

    managerB.setSkills([{ name: 'project-b-new', description: 'Project B New', tier: 'project' }]);
    expect(latestSkillFrame()?.slashCommands).toEqual(['project-a']);
    __testHooks.activateProjectRuntimeForTest('/tmp/project-b');
    expect(managerB.load).toHaveBeenCalledTimes(1);
    expect(latestSkillFrame()).toMatchObject({ slashCommands: ['project-b-new'] });

    managerA.load.mockClear();
    managerB.load.mockClear();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(managerB.load).toHaveBeenCalledTimes(1);
    expect(managerA.load).not.toHaveBeenCalled();
    expect(baseManager.load).not.toHaveBeenCalled();

    __testHooks.activateProjectRuntimeForTest('/tmp/project-a');
    managerB.setSkills([]);
    ctx.messageBuffer = [];
    __testHooks.activateProjectRuntimeForTest('/tmp/project-b');
    expect(latestSkillFrame()).toMatchObject({
      slashCommands: [],
      slashCommandDescriptions: {},
    });

    baseManager.load.mockClear();
    managerA.load.mockClear();
    managerB.load.mockClear();
    __testHooks.activateBaseRuntimeForTest();
    expect(baseManager.load).toHaveBeenCalledTimes(1);
    expect(latestSkillFrame()).toMatchObject({ slashCommands: ['yeaft-skills:base-skill'] });
    baseManager.load.mockClear();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(baseManager.load).toHaveBeenCalledTimes(1);
    expect(managerA.load).not.toHaveBeenCalled();
    expect(managerB.load).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(1);
  });
});
