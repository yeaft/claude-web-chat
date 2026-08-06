import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSandboxRuntimeExecutor, sandboxName } from '../../agent/managed-sandbox/runtime-executor.js';

const roots = [];

function runtime(overrides = {}, availableMemoryBytes = () => 4 * 1024 * 1024 * 1024) {
  const root = mkdtempSync(join(tmpdir(), 'yeaft-sandbox-runtime-'));
  const secretRoot = mkdtempSync(join(tmpdir(), 'yeaft-sandbox-secrets-'));
  roots.push(root, secretRoot);
  const calls = [];
  let exists = false;
  const tables = new Set();
  const run = vi.fn(async (command, args) => {
    calls.push([command, args]);
    if (command === '/usr/bin/podman' && args[0] === 'inspect') {
      if (!exists) throw Object.assign(new Error('no such container'), { code: 125, stderr: 'no such container' });
      return { stdout: JSON.stringify([{
        ImageDigest: 'sha256:fixed',
        Config: { Image: 'sha256:fixed', User: '10001' },
        HostConfig: {
          NanoCpus: 500_000_000,
          Memory: 1024 * 1024 * 1024,
          PidsLimit: 128,
          BlkioWeight: 100,
          ReadonlyRootfs: true,
          CapDrop: ['ALL'],
          SecurityOpt: ['no-new-privileges'],
          UsernsMode: 'auto',
          NetworkMode: 'yeaft-sandbox'
        },
        Mounts: [
          { Type: 'bind', Source: join(root, 'sandbox-1', 'home') },
          { Type: 'bind', Source: join(root, 'sandbox-1', 'workspace') },
          { Type: 'bind', Source: join(secretRoot, 'sandbox-1', 'bootstrap.json') }
        ]
      }]) };
    }
    if (command === '/usr/bin/podman' && args[0] === 'create') exists = true;
    if (command === '/usr/bin/podman' && args[0] === 'rm') exists = false;
    if (command === '/usr/sbin/xfs_quota' && args.some(value => String(value).startsWith('report '))) {
      const projectId = String(args.find(value => String(value).startsWith('report '))).split(' ').at(-1);
      const removed = calls.some(([, calledArgs]) => calledArgs.some(value => String(value).startsWith('project -C')));
      return { stdout: removed ? '' : `${projectId} 0 10g 10g` };
    }
    if (command === '/usr/sbin/nft' && args[0] === '-f') {
      const policy = String(args[1]);
      const sandboxId = policy.split('/').at(-1).replace('.nft', '');
      tables.add(`yeaft_sbx_${createHash('sha256').update(sandboxId).digest('hex').slice(0, 16)}`);
    }
    if (command === '/usr/sbin/nft' && args[0] === 'delete') tables.delete(args.at(-1));
    if (command === '/usr/sbin/nft' && args[0] === 'list') {
      if (!tables.has(args.at(-1))) throw Object.assign(new Error('No such table'), { code: 1 });
      return { stdout: 'comment "yeaft:sandbox-1:1"' };
    }
    return { stdout: '' };
  });
  const instance = createSandboxRuntimeExecutor({
    config: {
      dedicatedHost: true,
      dataRoot: root,
      secretRoot,
      policyRoot: join(root, '.policy'),
      imageDigest: 'sha256:fixed',
      serverUrl: 'https://server.example',
      runtimeBinary: '/usr/bin/podman',
      xfsQuotaBinary: '/usr/sbin/xfs_quota',
      nftBinary: '/usr/sbin/nft',
      networkName: 'yeaft-sandbox',
      networkBridge: 'ysbx0',
      quotaProjectBase: 10000,
      pidsLimit: 128,
      ioWeight: 100,
      hostMemoryReserveMiB: 512,
      ...overrides
    },
    run,
    availableMemoryBytes,
    statfsImpl: async () => ({ type: 0x01021994 }),
  });
  return { instance, run, calls, root, secretRoot };
}

function operation(action = 'create', overrides = {}) {
  return {
    sandboxId: 'sandbox-1',
    instanceId: 'instance-1',
    generation: 1,
    action,
    imageDigest: action === 'remove' ? null : 'sha256:fixed',
    resources: { cpuMillis: 500, memoryMiB: 1024, diskGiB: 10 },
    bootstrap: action === 'create' || action === 'retry'
      ? { token: 'scoped-token', expiresAt: Date.now() + 30_000 }
      : null,
    ...overrides
  };
}

afterEach(() => {
  while (roots.length) rmSync(roots.pop(), { recursive: true, force: true });
});

describe('managed Sandbox dedicated Host runtime executor', () => {
  it('creates a fixed-digest isolated container and proves resource, quota, and network enforcement', async () => {
    const { instance, calls, root, secretRoot } = runtime();

    const result = await instance.execute(operation());

    expect(result).toMatchObject({
      success: true,
      readinessProof: { image: true, cpu: true, memory: true, pid: true, io: true, quota: true, network: true },
      resourceInspection: {
        cpuMillis: 500, memoryMiB: 1024, diskGiB: 10,
        pidsLimit: 128, ioWeight: 100, quotaHard: true,
        networkPolicy: 'public-egress-isolated'
      }
    });
    const create = calls.find(([, args]) => args[0] === 'create')[1];
    expect(create).toEqual(expect.arrayContaining([
      '--runtime', 'runsc', '--read-only', '--cap-drop=ALL',
      '--security-opt=no-new-privileges', '--userns=auto', '--network', 'yeaft-sandbox',
      '--pids-limit', '128', '--blkio-weight', '100', 'sha256:fixed',
      'yeaft-agent', 'managed-sandbox', '--bootstrap-file', '/run/yeaft/bootstrap.json'
    ]));
    expect(create.join(' ')).not.toContain('container-run');
    expect(create.join(' ')).not.toContain('docker.sock');
    expect(calls.some(([command, args]) => command === '/usr/sbin/xfs_quota' && args.join(' ').includes('bhard=10g'))).toBe(true);
    expect(calls.some(([command, args]) => command === '/usr/sbin/nft' && args[0] === '-c')).toBe(true);
    const policyPath = calls.find(([, args]) => args[0] === '-f')[1][1];
    const policy = await import('node:fs/promises').then(fs => fs.readFile(policyPath, 'utf8'));
    expect(policy).toContain('ip6 daddr fc00::/7 reject');
    expect(policy).toContain('ip6 daddr fe80::/10 reject');
    expect(policy).toContain('ip6 daddr ::1/128 reject');
    expect(create.join(' ')).toContain(join(secretRoot, 'sandbox-1', 'bootstrap.json'));
    await expect(import('node:fs/promises').then(fs => fs.access(join(secretRoot, 'sandbox-1', 'bootstrap.json'))))
      .rejects.toThrow();
    await expect(import('node:fs/promises').then(fs => fs.access(join(root, 'sandbox-1', 'bootstrap.json'))))
      .rejects.toThrow();
  });

  it('preserves home and workspace across Stop/Start and returns complete absence only after Remove inspection', async () => {
    const { instance, calls, root } = runtime();
    await instance.execute(operation('create'));
    await instance.execute(operation('stop'));
    await instance.execute(operation('start'));

    const removed = await instance.execute(operation('remove'));

    expect(removed).toEqual({
      success: true,
      absenceProof: { container: true, storage: true, quota: true, network: true, credential: true }
    });
    expect(calls.filter(([, args]) => args[0] === 'create')).toHaveLength(1);
    expect(calls.some(([, args]) => args[0] === 'stop')).toBe(true);
    expect(calls.some(([, args]) => args[0] === 'start')).toBe(true);
    expect(calls.some(([, args]) => args[0] === 'rm')).toBe(true);
    expect(calls.find(([, args]) => args[0] === 'create')[1].join(' ')).toContain(join(root, 'sandbox-1', 'home'));
  });

  it.each(['create', 'retry', 'start'])('does not call container create/start for %s when live memory is below reserve', async action => {
    let availableMiB = 4096;
    const lowMemory = runtime({}, () => availableMiB * 1024 * 1024);
    if (action === 'start') {
      await lowMemory.instance.execute(operation('create'));
      lowMemory.calls.length = 0;
    }
    availableMiB = 1535;

    await expect(lowMemory.instance.execute(operation(action))).rejects.toMatchObject({
      code: 'SANDBOX_CAPACITY_UNAVAILABLE'
    });
    expect(lowMemory.calls.some(([, args]) => args[0] === 'create' || args[0] === 'start')).toBe(false);
  });

  it('fails closed outside a dedicated Host and rejects path-like Sandbox identities', async () => {
    expect(() => runtime({ dedicatedHost: false })).toThrow('complete dedicated Host configuration');
    const { instance, run } = runtime();

    await expect(instance.execute(operation('create', { sandboxId: '../escape' })))
      .rejects.toThrow('invalid Sandbox identity');
    expect(sandboxName('sandbox-1')).toMatch(/^yeaft-sandbox-[a-f0-9]{24}$/);
  });

  it('fails closed when runtime inspect does not prove isolation settings', async () => {
    const { instance, run } = runtime();
    const original = run.getMockImplementation();
    run.mockImplementation(async (command, args) => {
      const result = await original(command, args);
      if (command === '/usr/bin/podman' && args[0] === 'inspect' && result.stdout) {
        const inspect = JSON.parse(result.stdout);
        inspect[0].HostConfig.ReadonlyRootfs = false;
        return { stdout: JSON.stringify(inspect) };
      }
      return result;
    });
    await expect(instance.execute(operation())).rejects.toThrow('runtime isolation inspection failed');
  });
});
