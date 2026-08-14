import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { access, copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

function createRuntime() {
  return {
    check: vi.fn(async () => ({ serverVersion: '28.5.1' })),
    create: vi.fn(),
    ensureSlice: vi.fn(),
    inspect: vi.fn(async () => ({ exists: false, status: 'absent', running: false })),
    isSliceReady: vi.fn(async () => true),
    remove: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
    writeSecret: vi.fn(),
  };
}

function createFakeApp() {
  const routes = new Map();
  return {
    routes,
    get(path, ...handlers) { routes.set(`GET ${path}`, handlers); },
    post(path, ...handlers) { routes.set(`POST ${path}`, handlers); },
  };
}

async function runRoute(app, key, req = {}) {
  const handlers = app.routes.get(key);
  if (!handlers) throw new Error(`Missing route ${key}`);
  const res = {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
  const request = { user: { username: 'owner', role: 'pro' }, body: {}, headers: {}, ...req };
  let index = -1;
  const next = async () => {
    index += 1;
    const handler = handlers[index];
    if (handler) await handler(request, res, next);
  };
  await next();
  return res;
}

describe('Sandbox status routes', () => {
  let ContainerAgentService;
  let registerSandboxRoutes;
  let stateDirs;

  beforeEach(async () => {
    stateDirs = [];
    vi.resetModules();
    vi.doMock('../../server/config.js', () => ({
      CONFIG: {
        sandbox: {
          enabled: false,
          image: 'example.test/agent:dev',
          serverUrl: 'wss://example.test',
          stateDir: '/tmp/yeaft-sandbox-test',
        },
      },
    }));
    vi.doMock('../../server/database.js', () => ({
      userDb: {
        getByUsername: vi.fn(),
        getOrCreate: vi.fn(),
        getAgentSecret: vi.fn(),
        resetAgentSecret: vi.fn(),
        isActive: vi.fn(() => true),
      },
    }));
    ({ ContainerAgentService } = await import('../../server/container-agent-service.js'));
    ({ registerSandboxRoutes } = await import('../../server/routes/sandbox-routes.js'));
  });

  afterEach(async () => {
    await Promise.all(stateDirs.map(dir => rm(dir, { recursive: true, force: true })));
  });

  async function createStateDir() {
    const dir = await mkdtemp(join(tmpdir(), 'yeaft-sandbox-route-'));
    stateDirs.push(dir);
    return dir;
  }

  function createUserDb() {
    return {
      getByUsername: vi.fn(() => ({ id: 'user-1', username: 'owner' })),
      getOrCreate: vi.fn(),
      getAgentSecret: vi.fn(),
      resetAgentSecret: vi.fn(),
      isActive: vi.fn(() => true),
    };
  }

  it('does not touch Docker when Sandbox is disabled', async () => {
    const runtime = createRuntime();
    const service = new ContainerAgentService({ enabled: false }, runtime);

    await expect(service.capability()).resolves.toEqual({
      available: false,
      reasonCode: 'SANDBOX_DISABLED',
      catalog: [],
    });
    await expect(service.snapshot('user-1')).resolves.toBeNull();
    await expect(service.create({ id: 'user-1', agent_secret: 'secret' })).rejects.toMatchObject({
      code: 'SANDBOX_DISABLED',
    });
    for (const action of ['start', 'stop', 'retry', 'remove']) {
      await expect(service.action('user-1', action)).rejects.toMatchObject({
        code: 'SANDBOX_DISABLED',
      });
    }

    expect(runtime.check).not.toHaveBeenCalled();
    expect(runtime.inspect).not.toHaveBeenCalled();
    expect(runtime.writeSecret).not.toHaveBeenCalled();
    expect(runtime.create).not.toHaveBeenCalled();
    expect(runtime.start).not.toHaveBeenCalled();
    expect(runtime.stop).not.toHaveBeenCalled();
    expect(runtime.remove).not.toHaveBeenCalled();
  });

  it('rejects all disabled public action routes without touching Docker', async () => {
    const runtime = createRuntime();
    const sandboxService = new ContainerAgentService({ enabled: false }, runtime);
    const app = createFakeApp();
    registerSandboxRoutes(app, {
      requireAuth: (_req, _res, next) => next(),
      sandboxService,
      sandboxUserDb: createUserDb(),
    });

    for (const action of ['start', 'stop', 'retry', 'remove']) {
      const response = await runRoute(app, `POST /api/sandbox/${action}`);
      expect(response).toMatchObject({ statusCode: 409, body: { code: 'SANDBOX_DISABLED' } });
    }

    expect(runtime.check).not.toHaveBeenCalled();
    expect(runtime.inspect).not.toHaveBeenCalled();
    expect(runtime.start).not.toHaveBeenCalled();
    expect(runtime.stop).not.toHaveBeenCalled();
    expect(runtime.remove).not.toHaveBeenCalled();
  });

  it('rejects public actions when Docker is unavailable without touching lifecycle methods', async () => {
    const runtime = createRuntime();
    runtime.check.mockRejectedValue(new Error('docker socket unavailable'));
    const sandboxService = new ContainerAgentService({ enabled: true }, runtime);
    const app = createFakeApp();
    registerSandboxRoutes(app, {
      requireAuth: (_req, _res, next) => next(),
      sandboxService,
      sandboxUserDb: createUserDb(),
    });

    const createResponse = await runRoute(app, 'POST /api/sandbox');
    expect(createResponse).toMatchObject({
      statusCode: 409,
      body: { code: 'SANDBOX_DOCKER_UNAVAILABLE' },
    });
    for (const action of ['start', 'stop', 'retry', 'remove']) {
      const response = await runRoute(app, `POST /api/sandbox/${action}`);
      expect(response).toMatchObject({
        statusCode: 409,
        body: { code: 'SANDBOX_DOCKER_UNAVAILABLE' },
      });
    }

    expect(runtime.check).toHaveBeenCalledTimes(5);
    expect(runtime.writeSecret).not.toHaveBeenCalled();
    expect(runtime.create).not.toHaveBeenCalled();
    expect(runtime.inspect).not.toHaveBeenCalled();
    expect(runtime.start).not.toHaveBeenCalled();
    expect(runtime.stop).not.toHaveBeenCalled();
    expect(runtime.remove).not.toHaveBeenCalled();
  });

  it('keeps the durable marker after an admitted create attempt fails', async () => {
    const runtime = createRuntime();
    const stateDir = await createStateDir();
    const marker = join(stateDir, 'sandbox-user-1', 'agent-secret');
    runtime.writeSecret.mockImplementation(async (path, secret) => {
      await mkdir(join(stateDir, 'sandbox-user-1'), { recursive: true });
      await writeFile(path, `${secret}\n`);
    });
    runtime.create.mockRejectedValue(new Error('docker create failed'));
    const service = new ContainerAgentService({
      enabled: true,
      stateDir,
      serverUrl: 'wss://example.test',
      image: 'example.test/agent:dev',
    }, runtime);

    await expect(service.create({ id: 'user-1', agent_secret: 'secret' }))
      .rejects.toThrow('docker create failed');

    expect(runtime.check).toHaveBeenCalledOnce();
    await expect(access(marker)).resolves.toBeUndefined();
  });

  it('initializes the shared slice before the first managed create when configured', async () => {
    const runtime = createRuntime();
    runtime.isSliceReady.mockResolvedValue(false);
    const service = new ContainerAgentService({
      enabled: true,
      stateDir: '/tmp/yeaft-test',
      serverUrl: 'wss://example.test',
      image: 'example.test/agent:dev',
      cgroupParent: 'yeaft.slice',
    }, runtime);

    await service.create({ id: 'user-1', agent_secret: 'secret' });

    expect(runtime.isSliceReady).toHaveBeenCalledTimes(1);
    expect(runtime.ensureSlice).toHaveBeenCalledTimes(1);
    expect(runtime.create).toHaveBeenCalledWith(expect.objectContaining({
      cgroupParent: 'yeaft.slice',
    }));
  });

  it('skips slice setup when the shared slice is already ready', async () => {
    const runtime = createRuntime();
    const service = new ContainerAgentService({
      enabled: true,
      stateDir: '/tmp/yeaft-test',
      serverUrl: 'wss://example.test',
      image: 'example.test/agent:dev',
      cgroupParent: 'yeaft.slice',
    }, runtime);

    await service.create({ id: 'user-1', agent_secret: 'secret' });

    expect(runtime.isSliceReady).toHaveBeenCalledTimes(1);
    expect(runtime.ensureSlice).not.toHaveBeenCalled();
  });

  it('does not touch the slice when no cgroup parent is configured', async () => {
    const runtime = createRuntime();
    const service = new ContainerAgentService({
      enabled: true,
      stateDir: '/tmp/yeaft-test',
      serverUrl: 'wss://example.test',
      image: 'example.test/agent:dev',
    }, runtime);

    await service.create({ id: 'user-1', agent_secret: 'secret' });

    expect(runtime.isSliceReady).not.toHaveBeenCalled();
    expect(runtime.ensureSlice).not.toHaveBeenCalled();
    expect(runtime.create).toHaveBeenCalledTimes(1);
  });

  it('rejects create with SANDBOX_CGROUP_SLICE_UNAVAILABLE when slice setup fails', async () => {
    const runtime = createRuntime();
    runtime.isSliceReady.mockResolvedValue(false);
    runtime.ensureSlice.mockRejectedValue(new Error('cgroup v2 unavailable'));
    const sandboxService = new ContainerAgentService({
      enabled: true,
      stateDir: '/tmp/yeaft-test',
      serverUrl: 'wss://example.test',
      image: 'example.test/agent:dev',
      cgroupParent: 'yeaft.slice',
    }, runtime);
    const app = createFakeApp();
    registerSandboxRoutes(app, {
      requireAuth: (_req, _res, next) => next(),
      sandboxService,
      sandboxUserDb: createUserDb(),
    });

    const createResponse = await runRoute(app, 'POST /api/sandbox');

    expect(createResponse).toMatchObject({
      statusCode: 409,
      body: { code: 'SANDBOX_CGROUP_SLICE_UNAVAILABLE' },
    });
    expect(runtime.create).not.toHaveBeenCalled();
  });

  it('admits an enabled public action route after the runtime probe', async () => {
    const runtime = createRuntime();
    runtime.inspect.mockResolvedValue({ exists: true, status: 'running', running: true });
    const sandboxService = new ContainerAgentService({ enabled: true }, runtime);
    const app = createFakeApp();
    registerSandboxRoutes(app, {
      requireAuth: (_req, _res, next) => next(),
      sandboxService,
      sandboxUserDb: createUserDb(),
    });

    const response = await runRoute(app, 'POST /api/sandbox/start');

    expect(response).toMatchObject({
      statusCode: 200,
      body: { snapshot: { desiredState: 'running' }, replayed: false },
    });
    expect(runtime.check).toHaveBeenCalledOnce();
    expect(runtime.start).toHaveBeenCalledWith('sandbox-user-1');
  });

  it('rejects lifecycle side effects after the owner becomes inactive', async () => {
    const runtime = createRuntime();
    const sandboxUserDb = createUserDb();
    sandboxUserDb.isActive.mockReturnValue(false);
    const sandboxService = new ContainerAgentService({ enabled: true }, runtime, sandboxUserDb);
    const app = createFakeApp();
    registerSandboxRoutes(app, {
      requireAuth: (_req, _res, next) => next(),
      sandboxService,
      sandboxUserDb,
    });

    const createResponse = await runRoute(app, 'POST /api/sandbox');
    const actionResponse = await runRoute(app, 'POST /api/sandbox/start');

    expect(createResponse).toMatchObject({ statusCode: 409, body: { code: 'SANDBOX_OWNER_INACTIVE' } });
    expect(actionResponse).toMatchObject({ statusCode: 409, body: { code: 'SANDBOX_OWNER_INACTIVE' } });
    expect(runtime.writeSecret).not.toHaveBeenCalled();
    expect(runtime.create).not.toHaveBeenCalled();
    expect(runtime.start).not.toHaveBeenCalled();
  });

  it('removes the durable marker after an admitted public remove', async () => {
    const runtime = createRuntime();
    const stateDir = await createStateDir();
    const markerDir = join(stateDir, 'sandbox-user-1');
    await mkdir(markerDir, { recursive: true });
    await writeFile(join(markerDir, 'agent-secret'), 'secret\n');
    const sandboxService = new ContainerAgentService({ enabled: true, stateDir }, runtime);

    await expect(sandboxService.action('user-1', 'remove')).resolves.toEqual({
      snapshot: null,
      replayed: false,
    });

    expect(runtime.check).toHaveBeenCalledOnce();
    expect(runtime.remove).toHaveBeenCalledWith('sandbox-user-1');
    await expect(access(markerDir)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('skips internal cleanup without a durable managed marker', async () => {
    const runtime = createRuntime();
    const stateDir = await createStateDir();
    const service = new ContainerAgentService({ enabled: false, stateDir }, runtime);

    await expect(service.cleanupManagedContainer('user-1')).resolves.toEqual({ cleaned: false });

    expect(runtime.check).not.toHaveBeenCalled();
    expect(runtime.inspect).not.toHaveBeenCalled();
    expect(runtime.remove).not.toHaveBeenCalled();
  });

  it('uses internal cleanup for a marked managed container even when public admission is disabled', async () => {
    const runtime = createRuntime();
    const stateDir = await createStateDir();
    const markerDir = join(stateDir, 'sandbox-user-1');
    await mkdir(markerDir, { recursive: true });
    await writeFile(join(markerDir, 'agent-secret'), 'secret\n');
    const service = new ContainerAgentService({ enabled: false, stateDir }, runtime);

    await expect(service.cleanupManagedContainer('user-1')).resolves.toEqual({ cleaned: true });

    expect(runtime.check).not.toHaveBeenCalled();
    expect(runtime.remove).toHaveBeenCalledWith('sandbox-user-1');
    await expect(access(markerDir)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('keeps the durable marker when internal cleanup fails', async () => {
    const runtime = createRuntime();
    runtime.remove.mockRejectedValue(new Error('docker remove failed'));
    const stateDir = await createStateDir();
    const marker = join(stateDir, 'sandbox-user-1', 'agent-secret');
    await mkdir(join(stateDir, 'sandbox-user-1'), { recursive: true });
    await writeFile(marker, 'secret\n');
    const service = new ContainerAgentService({ enabled: false, stateDir }, runtime);

    await expect(service.cleanupManagedContainer('user-1')).rejects.toThrow('docker remove failed');

    expect(runtime.remove).toHaveBeenCalledWith('sandbox-user-1');
    await expect(access(marker)).resolves.toBeUndefined();
  });

  it('serializes an admitted create with owner cleanup and deletion admission', async () => {
    const runtime = createRuntime();
    const stateDir = await createStateDir();
    let releaseCheck;
    const checkBlocked = new Promise(resolve => { releaseCheck = resolve; });
    let checkEntered;
    const checkStarted = new Promise(resolve => { checkEntered = resolve; });
    runtime.check.mockImplementation(async () => {
      checkEntered();
      await checkBlocked;
      return { serverVersion: '28.5.1' };
    });
    runtime.writeSecret.mockImplementation(async (path, secret) => {
      await mkdir(join(stateDir, 'sandbox-user-1'), { recursive: true });
      await writeFile(path, `${secret}\n`);
    });
    const ownerDb = { isActive: vi.fn(() => true) };
    const service = new ContainerAgentService({
      enabled: true,
      stateDir,
      serverUrl: 'wss://example.test',
      image: 'example.test/agent:dev',
    }, runtime, ownerDb);

    const creating = service.create({ id: 'user-1', agent_secret: 'secret' });
    await checkStarted;
    const beginDeletion = vi.fn(() => ({ deletionId: 'deletion-1', status: 'pending' }));
    const deleting = service.prepareOwnerDeletion('user-1', beginDeletion);

    await Promise.resolve();
    expect(beginDeletion).not.toHaveBeenCalled();
    releaseCheck();
    await expect(creating).resolves.toMatchObject({ replayed: false });
    await expect(deleting).resolves.toEqual({ deletionId: 'deletion-1', status: 'pending' });
    expect(runtime.remove).toHaveBeenCalledWith('sandbox-user-1');
    expect(runtime.create.mock.invocationCallOrder[0])
      .toBeLessThan(runtime.remove.mock.invocationCallOrder[0]);
    expect(runtime.remove.mock.invocationCallOrder[0])
      .toBeLessThan(beginDeletion.mock.invocationCallOrder[0]);
  });

  it('keeps the durable marker when volume cleanup reports a partial failure', async () => {
    const runtime = createRuntime();
    runtime.remove.mockRejectedValue(Object.assign(new Error('volume is in use'), {
      code: 'CONTAINER_AGENT_DOCKER_FAILED',
    }));
    const stateDir = await createStateDir();
    const marker = join(stateDir, 'sandbox-user-1', 'agent-secret');
    await mkdir(join(stateDir, 'sandbox-user-1'), { recursive: true });
    await writeFile(marker, 'secret\n');
    const service = new ContainerAgentService({ enabled: false, stateDir }, runtime);
    const beginDeletion = vi.fn();

    await expect(service.prepareOwnerDeletion('user-1', beginDeletion)).rejects.toMatchObject({
      code: 'CONTAINER_AGENT_DOCKER_FAILED',
    });

    expect(beginDeletion).not.toHaveBeenCalled();
    await expect(access(marker)).resolves.toBeUndefined();
  });

  it('renders the documented Compose activation with canonical Server env values', async () => {
    const root = resolve(import.meta.dirname, '../..');
    const fixture = await mkdtemp(join(tmpdir(), 'yeaft-compose-sandbox-'));
    stateDirs.push(fixture);
    await copyFile(join(root, 'docker-compose.yml'), join(fixture, 'docker-compose.yml'));
    await copyFile(join(root, 'docker-compose.sandbox.yml'), join(fixture, 'docker-compose.sandbox.yml'));
    await mkdir(join(fixture, 'server'), { recursive: true });
    const render = values => {
      const envFile = join(fixture, 'server', '.env');
      return writeFile(envFile, `${values.join('\n')}\n`).then(() => spawnSync('docker', [
        'compose', '--env-file', 'server/.env',
        '-f', 'docker-compose.yml', '-f', 'docker-compose.sandbox.yml',
        'config', '--format', 'json',
      ], { cwd: fixture, encoding: 'utf8' }));
    };

    const defaults = await render([
      'SANDBOX_SERVER_URL=wss://sandbox.example.test',
    ]);
    expect(defaults.status, defaults.stderr).toBe(0);
    const defaultWebchat = JSON.parse(defaults.stdout).services.webchat;
    expect(defaultWebchat.environment).toMatchObject({
      SANDBOX_ENABLED: 'true',
      SANDBOX_SERVER_URL: 'wss://sandbox.example.test',
      SANDBOX_STATE_DIR: '/var/lib/yeaft/container-agents',
      SANDBOX_AGENT_IMAGE: 'ghcr.io/yeaft/yeaft-web-code-agent-agent:dev',
    });

    const custom = await render([
      'SANDBOX_SERVER_URL=wss://sandbox.example.test',
      'SANDBOX_STATE_DIR=/srv/yeaft/sandbox-state',
      'SANDBOX_AGENT_IMAGE=registry.example.test/yeaft-agent@sha256:deadbeef',
    ]);
    expect(custom.status, custom.stderr).toBe(0);
    const customWebchat = JSON.parse(custom.stdout).services.webchat;
    expect(customWebchat.environment).toMatchObject({
      SANDBOX_ENABLED: 'true',
      SANDBOX_SERVER_URL: 'wss://sandbox.example.test',
      SANDBOX_STATE_DIR: '/srv/yeaft/sandbox-state',
      SANDBOX_AGENT_IMAGE: 'registry.example.test/yeaft-agent@sha256:deadbeef',
    });
    expect(customWebchat.volumes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        source: '/srv/yeaft/sandbox-state',
        target: '/srv/yeaft/sandbox-state',
      }),
    ]));
  });

  it('reports Docker runtime failures as an unavailable capability', async () => {
    const runtime = createRuntime();
    runtime.check.mockRejectedValueOnce(new Error('docker socket unavailable'));
    const service = new ContainerAgentService({ enabled: true }, runtime);

    await expect(service.capability()).resolves.toEqual({
      available: false,
      reasonCode: 'SANDBOX_DOCKER_UNAVAILABLE',
      catalog: [],
    });
    expect(runtime.check).toHaveBeenCalledOnce();
  });

  it('keeps old concurrent clients loadable when the enabled Docker runtime is unavailable', async () => {
    const runtime = createRuntime();
    runtime.check.mockRejectedValue(new Error('docker socket unavailable'));
    const sandboxService = new ContainerAgentService({ enabled: true }, runtime);
    const sandboxUserDb = {
      getByUsername: vi.fn(() => ({ id: 'user-1', username: 'owner' })),
      getOrCreate: vi.fn(),
      getAgentSecret: vi.fn(),
      resetAgentSecret: vi.fn(),
      isActive: vi.fn(() => true),
    };
    const app = createFakeApp();
    registerSandboxRoutes(app, {
      requireAuth: (_req, _res, next) => next(),
      sandboxService,
      sandboxUserDb,
    });

    const [capability, snapshot] = await Promise.all([
      runRoute(app, 'GET /api/sandbox/capability'),
      runRoute(app, 'GET /api/sandbox'),
    ]);

    expect(capability).toMatchObject({
      statusCode: 200,
      body: { available: false, reasonCode: 'SANDBOX_DOCKER_UNAVAILABLE', catalog: [] },
    });
    expect(snapshot).toMatchObject({ statusCode: 200, body: { sandbox: null } });
    expect(runtime.inspect).not.toHaveBeenCalled();
  });

  it('serves the disabled capability and empty owner snapshot through the real routes', async () => {
    const runtime = createRuntime();
    const sandboxService = new ContainerAgentService({ enabled: false }, runtime);
    const sandboxUserDb = {
      getByUsername: vi.fn(() => ({ id: 'user-1', username: 'owner' })),
      getOrCreate: vi.fn(),
      getAgentSecret: vi.fn(),
      resetAgentSecret: vi.fn(),
      isActive: vi.fn(() => true),
    };
    const app = createFakeApp();
    registerSandboxRoutes(app, {
      requireAuth: (_req, _res, next) => next(),
      sandboxService,
      sandboxUserDb,
    });

    const capability = await runRoute(app, 'GET /api/sandbox/capability');
    const snapshot = await runRoute(app, 'GET /api/sandbox');

    expect(capability).toMatchObject({
      statusCode: 200,
      body: { available: false, reasonCode: 'SANDBOX_DISABLED', catalog: [] },
    });
    expect(snapshot).toMatchObject({ statusCode: 200, body: { sandbox: null } });
    expect(sandboxUserDb.getByUsername).toHaveBeenCalledWith('owner');
    expect(runtime.check).not.toHaveBeenCalled();
    expect(runtime.inspect).not.toHaveBeenCalled();
  });
});
