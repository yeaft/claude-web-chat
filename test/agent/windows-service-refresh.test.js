import { beforeEach, describe, expect, it, vi } from 'vitest';

const { execSync, mkdirSync, writeFileSync } = vi.hoisted(() => ({
  execSync: vi.fn(),
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
}));

vi.mock('child_process', () => ({
  execSync,
  spawn: vi.fn(),
}));

vi.mock('fs', () => ({
  existsSync: vi.fn(() => true),
  mkdirSync,
  writeFileSync,
  readFileSync: vi.fn(() => JSON.stringify({
    instanceId: 'worker-a',
    serverUrl: 'wss://server.example',
    agentName: 'Worker A',
    agentSecret: 'secret',
  })),
  unlinkSync: vi.fn(),
}));

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    homedir: () => 'C:\\Users\\tester',
    platform: () => 'win32',
  };
});

const { winRestart, winStart } = await import('../../agent/service/windows.js');

describe('Windows service package refresh', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.APPDATA = 'C:\\Users\\tester\\AppData\\Roaming';
  });

  it.each([
    ['start', winStart],
    ['restart', winRestart],
  ])('re-registers the current CLI on %s', (_command, run) => {
    run('worker-a');

    expect(mkdirSync).toHaveBeenCalledWith(expect.stringContaining('logs'), { recursive: true });
    expect(writeFileSync).toHaveBeenCalledOnce();

    const [ecosystemPath, ecosystem] = writeFileSync.mock.calls[0];
    expect(ecosystemPath).toContain('ecosystem.config.cjs');
    expect(ecosystem).toContain("name: 'yeaft-agent-worker-a'");
    expect(ecosystem).toContain('cli.js');
    expect(ecosystem).toContain('YEAFT_AGENT_INSTANCE');

    expect(execSync.mock.calls).toEqual([
      ['pm2 delete yeaft-agent-worker-a', { stdio: 'pipe' }],
      [`pm2 start "${ecosystemPath}"`, { stdio: 'inherit' }],
      ['pm2 save', { stdio: 'pipe' }],
    ]);
  });
});
