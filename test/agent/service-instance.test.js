import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const HOME = '/home/tester';
const APPDATA = 'C:\\Users\\tester\\AppData\\Roaming';

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    homedir: () => HOME,
    platform: () => 'linux',
  };
});

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    existsSync: vi.fn(() => false),
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
    readFileSync: vi.fn(),
  };
});

const configMod = await import('../../agent/service/config.js');

describe('agent service instance config', () => {
  const OLD_ENV = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...OLD_ENV, APPDATA };
    delete process.env.YEAFT_AGENT_INSTANCE;
    delete process.env.SERVER_URL;
    delete process.env.AGENT_NAME;
    delete process.env.AGENT_SECRET;
    delete process.env.WORK_DIR;
    delete process.env.YEAFT_DIR;
  });

  afterEach(() => {
    process.env = { ...OLD_ENV };
  });

  it('keeps default instance on legacy config/log paths', () => {
    expect(configMod.getConfigDir()).toBe(`${HOME}/.config/yeaft-agent`);
    expect(configMod.getLogDir()).toBe(`${HOME}/.config/yeaft-agent/logs`);
    expect(configMod.getConfigPath()).toBe(`${HOME}/.config/yeaft-agent/config.json`);
    expect(configMod.getServiceName()).toBe('yeaft-agent');
    expect(configMod.getPm2AppName()).toBe('yeaft-agent');
    expect(configMod.getLaunchdLabel()).toBe('com.yeaft.agent');
  });

  it('uses isolated paths and service names for named instances', () => {
    expect(configMod.getConfigDir('worker-a')).toBe(`${HOME}/.config/yeaft-agent/instances/worker-a`);
    expect(configMod.getLogDir('worker-a')).toBe(`${HOME}/.config/yeaft-agent/instances/worker-a/logs`);
    expect(configMod.getConfigPath('worker-a')).toBe(`${HOME}/.config/yeaft-agent/instances/worker-a/config.json`);
    expect(configMod.getServiceName('worker-a')).toBe('yeaft-agent@worker-a');
    expect(configMod.getPm2AppName('worker-a')).toBe('yeaft-agent-worker-a');
    expect(configMod.getLaunchdLabel('worker-a')).toBe('com.yeaft.agent.worker-a');
  });

  it('derives the instance id from --name', () => {
    const config = configMod.parseServiceArgs([
      '--server', 'wss://server.example',
      '--name', 'desk-agent',
      '--secret', 'secret',
      '--work-dir', '/repo',
      '--yeaft-dir', '/data/yeaft-target-a',
    ]);

    expect(config).toMatchObject({
      instanceId: 'desk-agent',
      serverUrl: 'wss://server.example',
      agentName: 'desk-agent',
      agentSecret: 'secret',
      workDir: '/repo',
      yeaftDir: '/data/yeaft-target-a',
    });
  });

  it('keeps --instance as a deprecated override for old commands', () => {
    const config = configMod.parseServiceArgs([
      '--instance', 'target-a',
      '--name', 'desk-agent',
      '--server', 'wss://server.example',
      '--secret', 'secret',
    ]);
    const warn = vi.fn();

    configMod.warnDeprecatedInstanceArg(['--instance', 'target-a'], warn);

    expect(config.instanceId).toBe('target-a');
    expect(config.agentName).toBe('desk-agent');
    expect(warn).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('--instance is deprecated'));
  });

  it('supports name and legacy instance id from environment for service commands', () => {
    process.env.AGENT_NAME = 'desk-agent';
    expect(configMod.getInstanceIdFromArgs([])).toBe('desk-agent');

    process.env.YEAFT_AGENT_INSTANCE = 'second';
    expect(configMod.getInstanceIdFromArgs([])).toBe('second');
    expect(configMod.getInstanceIdFromArgs(['--name', 'third'])).toBe('third');
    expect(configMod.getInstanceIdFromArgs(['--instance', 'fourth', '--name', 'third'])).toBe('fourth');
  });

  it('applies explicit --name over stale foreground identity environment', () => {
    const env = {
      YEAFT_AGENT_INSTANCE: 'legacy-id',
      AGENT_NAME: 'legacy-name',
    };

    expect(configMod.applyAgentIdentityToEnv(['--name', 'new-name'], env)).toBe('new-name');
    expect(env).toMatchObject({
      YEAFT_AGENT_INSTANCE: 'new-name',
      AGENT_NAME: 'new-name',
    });
  });

  it('allows explicit --name default to replace a stale foreground instance', () => {
    const env = {
      YEAFT_AGENT_INSTANCE: 'legacy-id',
      AGENT_NAME: 'legacy-name',
    };

    expect(configMod.applyAgentIdentityToEnv(['--name', 'default'], env)).toBe('default');
    expect(env).toMatchObject({
      YEAFT_AGENT_INSTANCE: 'default',
      AGENT_NAME: 'default',
    });
  });

  it('preserves the deprecated instance plus display-name compatibility path', () => {
    const env = {
      YEAFT_AGENT_INSTANCE: 'legacy-id',
      AGENT_NAME: 'legacy-name',
    };

    expect(configMod.applyAgentIdentityToEnv([
      '--instance', 'safe-id',
      '--name', 'Display Name',
    ], env)).toBe('safe-id');
    expect(env).toMatchObject({
      YEAFT_AGENT_INSTANCE: 'safe-id',
      AGENT_NAME: 'Display Name',
    });
  });

  it('rejects unsafe instance ids', () => {
    expect(() => configMod.validateInstanceId('../bad')).toThrow(/Instance id/);
    expect(() => configMod.validateInstanceId('bad/slash')).toThrow(/Instance id/);
    expect(() => configMod.validateInstanceId('ok_1.2-3')).not.toThrow();
  });
});
