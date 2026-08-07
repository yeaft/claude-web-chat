import { beforeEach, describe, expect, it, vi } from 'vitest';

function createRuntime() {
  return {
    check: vi.fn(async () => ({ serverVersion: '28.5.1' })),
    create: vi.fn(),
    inspect: vi.fn(async () => ({ exists: false, status: 'absent', running: false })),
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

  beforeEach(async () => {
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
      },
    }));
    ({ ContainerAgentService } = await import('../../server/container-agent-service.js'));
    ({ registerSandboxRoutes } = await import('../../server/routes/sandbox-routes.js'));
  });

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

    expect(runtime.check).not.toHaveBeenCalled();
    expect(runtime.inspect).not.toHaveBeenCalled();
    expect(runtime.writeSecret).not.toHaveBeenCalled();
    expect(runtime.create).not.toHaveBeenCalled();
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
