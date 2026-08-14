import { homedir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parseContainerArgs, runContainerCli } from '../../agent/container-cli.js';
import {
  createContainerAgent,
  inspectContainerAgent,
  writeAgentSecretFile,
} from '../../agent/container-manager.js';

vi.mock('../../agent/container-manager.js', () => ({
  createContainerAgent: vi.fn(),
  inspectContainerAgent: vi.fn(),
  logsContainerAgent: vi.fn(),
  removeContainerAgent: vi.fn(),
  startContainerAgent: vi.fn(),
  stopContainerAgent: vi.fn(),
  writeAgentSecretFile: vi.fn(),
}));

describe('container CLI install', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createContainerAgent.mockResolvedValue({ exists: true, status: 'running', running: true });
  });

  it('parses an install command with a parameter-passed secret', () => {
    const { action, options } = parseContainerArgs([
      'install', '--server', 'wss://example.test', '--name', 'worker', '--secret', 'top-secret',
    ]);
    expect(action).toBe('install');
    expect(options).toMatchObject({
      server: 'wss://example.test',
      name: 'worker',
      secret: 'top-secret',
    });
  });

  it('runs install by persisting the secret to the managed default path and creating the container', async () => {
    await runContainerCli([
      'install', '--server', 'wss://example.test', '--name', 'worker', '--secret', 'top-secret',
    ]);
    expect(writeAgentSecretFile).toHaveBeenCalledWith(
      join(homedir(), '.yeaft', 'container-agents', 'worker', 'agent-secret'),
      'top-secret',
    );
    expect(createContainerAgent).toHaveBeenCalledWith({
      name: 'worker',
      serverUrl: 'wss://example.test',
      secretFile: join(homedir(), '.yeaft', 'container-agents', 'worker', 'agent-secret'),
      image: undefined,
    });
  });

  it('keeps create as a compatible alias for install', async () => {
    await runContainerCli([
      'create', '--server', 'wss://example.test', '--name', 'worker', '--secret', 'top-secret',
    ]);
    expect(createContainerAgent).toHaveBeenCalledTimes(1);
    expect(writeAgentSecretFile).toHaveBeenCalledTimes(1);
  });

  it('rejects a secret path and requires the secret as an argument', async () => {
    await expect(runContainerCli([
      'install', '--server', 'wss://example.test', '--name', 'worker', '--secret-file', '/tmp/s',
    ])).rejects.toThrow('--secret-file is no longer supported');
    await expect(runContainerCli([
      'install', '--server', 'wss://example.test', '--name', 'worker',
    ])).rejects.toThrow('--secret <secret> is required');
    expect(writeAgentSecretFile).not.toHaveBeenCalled();
    expect(createContainerAgent).not.toHaveBeenCalled();
  });

  it('keeps status on the same lifecycle surface', async () => {
    inspectContainerAgent.mockResolvedValue({ exists: true, status: 'running', running: true });
    await runContainerCli(['status', '--name', 'worker']);
    expect(inspectContainerAgent).toHaveBeenCalledWith('worker');
  });
});
