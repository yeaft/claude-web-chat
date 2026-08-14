import { homedir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parseContainerArgs, runContainerCli } from '../../agent/container-cli.js';
import {
  createContainerAgent,
  DEFAULT_AGENT_SLICE,
  detectHostResources,
  ensureAgentSlice,
  inspectContainerAgent,
  isAgentSliceReady,
  resolveDiskSize,
  writeAgentSecretFile,
} from '../../agent/container-manager.js';

vi.mock('../../agent/container-manager.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    createContainerAgent: vi.fn(),
    inspectContainerAgent: vi.fn(),
    logsContainerAgent: vi.fn(),
    removeContainerAgent: vi.fn(),
    startContainerAgent: vi.fn(),
    stopContainerAgent: vi.fn(),
    writeAgentSecretFile: vi.fn(),
    isAgentSliceReady: vi.fn(),
    ensureAgentSlice: vi.fn(),
    detectHostResources: vi.fn(),
    resolveDiskSize: vi.fn(),
    runDocker: vi.fn(),
  };
});

describe('container CLI install', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createContainerAgent.mockResolvedValue({ exists: true, status: 'running', running: true });
    isAgentSliceReady.mockResolvedValue(true);
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
    expect(isAgentSliceReady).toHaveBeenCalledWith();
    expect(createContainerAgent).toHaveBeenCalledWith({
      name: 'worker',
      serverUrl: 'wss://example.test',
      secretFile: join(homedir(), '.yeaft', 'container-agents', 'worker', 'agent-secret'),
      image: undefined,
      cgroupParent: DEFAULT_AGENT_SLICE,
      diskSizeBytes: undefined,
    });
  });

  it('refuses to install when the shared slice is not initialized', async () => {
    isAgentSliceReady.mockResolvedValue(false);
    await expect(runContainerCli([
      'install', '--server', 'wss://example.test', '--name', 'worker', '--secret', 'top-secret',
    ])).rejects.toThrow('setup-limits');
    expect(createContainerAgent).not.toHaveBeenCalled();
  });

  it('skips the slice entirely with --no-slice', async () => {
    await runContainerCli([
      'install', '--server', 'wss://example.test', '--name', 'worker', '--secret', 'top-secret', '--no-slice',
    ]);
    expect(isAgentSliceReady).not.toHaveBeenCalled();
    expect(createContainerAgent).toHaveBeenCalledWith(expect.objectContaining({
      cgroupParent: undefined,
    }));
  });

  it('honors an explicit --cgroup-parent without the ready check', async () => {
    await runContainerCli([
      'install', '--server', 'wss://example.test', '--name', 'worker', '--secret', 'top-secret',
      '--cgroup-parent', 'team.slice',
    ]);
    expect(isAgentSliceReady).not.toHaveBeenCalled();
    expect(createContainerAgent).toHaveBeenCalledWith(expect.objectContaining({
      cgroupParent: 'team.slice',
    }));
  });

  it('resolves and forwards --disk-size', async () => {
    resolveDiskSize.mockResolvedValue(20 * 1024 ** 3);
    await runContainerCli([
      'install', '--server', 'wss://example.test', '--name', 'worker', '--secret', 'top-secret',
      '--disk-size', '20G',
    ]);
    expect(resolveDiskSize).toHaveBeenCalledWith('20G', { dockerRoot: undefined });
    expect(createContainerAgent).toHaveBeenCalledWith(expect.objectContaining({
      diskSizeBytes: 20 * 1024 ** 3,
    }));
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

  it('parses --no-slice and --cgroup-parent as install options', () => {
    const { action, options } = parseContainerArgs([
      'install', '--name', 'worker', '--secret', 's', '--server', 'wss://x.test',
      '--no-slice', '--cgroup-parent', 'team.slice', '--disk-size', '80%',
    ]);
    expect(action).toBe('install');
    expect(options).toMatchObject({
      noSlice: true,
      cgroupParent: 'team.slice',
      diskSize: '80%',
    });
  });

  it('runs setup-limits as root with detected host resources', async () => {
    const getuidSpy = typeof process.getuid === 'function'
      ? vi.spyOn(process, 'getuid').mockReturnValue(0)
      : null;
    try {
      detectHostResources.mockResolvedValue({ cpuCores: 8, memTotalBytes: 16 * 1024 ** 3 });
      ensureAgentSlice.mockResolvedValue({
        slice: DEFAULT_AGENT_SLICE,
        limits: { cpuQuotaUs: 720000, cpuPeriodUs: 100000, memoryMaxBytes: 1, pidsMax: 4096 },
        controllers: ['cpu', 'memory', 'pids'],
      });
      await runContainerCli(['setup-limits', '--cpu-percent', '90', '--memory-percent', '70', '--pids', '4096']);
      expect(detectHostResources).toHaveBeenCalledWith();
      expect(ensureAgentSlice).toHaveBeenCalledWith(expect.objectContaining({
        cpuPercent: 90,
        memoryPercent: 70,
        pidsLimit: 4096,
        resources: { cpuCores: 8, memTotalBytes: 16 * 1024 ** 3 },
      }));
    } finally {
      getuidSpy?.mockRestore();
    }
  });

  it('rejects setup-limits without root', async () => {
    if (typeof process.getuid !== 'function') return;
    const getuidSpy = vi.spyOn(process, 'getuid').mockReturnValue(1000);
    try {
      await expect(runContainerCli(['setup-limits'])).rejects.toThrow('root');
      expect(ensureAgentSlice).not.toHaveBeenCalled();
    } finally {
      getuidSpy.mockRestore();
    }
  });
});
