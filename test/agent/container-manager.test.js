import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildCreateArgs,
  buildSliceLimits,
  checkContainerAgentRuntime,
  containerNameForAgent,
  detectHostResources,
  ensureAgentSlice,
  isAgentSliceReady,
  removeContainerAgent,
  resolveDiskSize,
  runDocker,
  writeAgentSecretFile,
} from '../../agent/container-manager.js';

function spawnResult({ code = 0, stdout = '', stderr = '' } = {}) {
  return (_command, _args) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    queueMicrotask(() => {
      if (stdout) child.stdout.emit('data', Buffer.from(stdout));
      if (stderr) child.stderr.emit('data', Buffer.from(stderr));
      child.emit('close', code);
    });
    return child;
  };
}

describe('container Agent manager', () => {
  it('builds the container marker into the Docker environment without exposing the secret', () => {
    const args = buildCreateArgs({
      name: 'remote-worker',
      serverUrl: 'wss://example.test',
      secretFile: '/tmp/agent-secret',
      image: 'example/agent:1',
    });
    expect(args).toContain('YEAFT_AGENT_RUNTIME=container_agent');
    expect(args).not.toContain('remote_upgrade_safe');
  });

  it('builds a fixed Docker Agent container without putting the secret in argv or Env', () => {
    const args = buildCreateArgs({
      name: 'remote-worker',
      serverUrl: 'wss://example.test',
      secretFile: '/tmp/agent-secret',
      image: 'example/agent:1',
    });
    expect(args).toContain('SERVER_URL=wss://example.test');
    expect(args).toContain('AGENT_SECRET_FILE=/run/yeaft-host-secret');
    expect(args.some(arg => arg.includes('dst=/run/yeaft-host-secret,readonly'))).toBe(true);
    expect(args.join(' ')).not.toContain('top-secret');
    expect(args).toContain('example/agent:1');
    expect(containerNameForAgent('remote-worker')).toBe('yeaft-agent-remote-worker');
  });

  it('keeps the npm cache temporary, runtime-owned by UID 10001, and provisions finance query dependencies', () => {
    const dockerfile = readFileSync(resolve(process.cwd(), 'agent/Dockerfile'), 'utf8');
    const entrypoint = readFileSync(resolve(process.cwd(), 'agent/container-entrypoint.sh'), 'utf8');
    expect(dockerfile).toContain('npm_config_cache=/tmp/yeaft-npm-cache npm ci --workspace=agent --omit=dev');
    expect(dockerfile).toContain('rm -rf /tmp/yeaft-npm-cache');
    expect(dockerfile).toContain('install -d -m 0700 -o yeaft -g yeaft /home/yeaft/.npm');
    expect(dockerfile).toContain('YEAFT_AGENT_RUNTIME=container_agent');
    expect(dockerfile).toContain('ca-certificates curl git openssh-client python3 python3-venv tini wget');
    expect(dockerfile).toContain('python3 python3-venv');
    expect(dockerfile).toContain('VIRTUAL_ENV=/opt/yeaft-python');
    expect(dockerfile).toContain('PATH=/opt/yeaft-python/bin:$PATH');
    expect(dockerfile).toContain('"akshare==1.18.91"');
    expect(dockerfile).toContain('"$VIRTUAL_ENV/bin/python" -c "import akshare; assert akshare.__version__ == \'1.18.91\'; assert all(hasattr(akshare, name) for name in (\'stock_info_global_em\', \'futures_display_main_sina\', \'futures_zh_spot\'))"');
    expect(entrypoint).toContain('--reuid=10001 --regid=10001 --init-groups');
  });

  it('writes a private secret file for the read-only container bind', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'yeaft-container-agent-'));
    const path = await writeAgentSecretFile(join(dir, 'secret'), 'top-secret');
    expect(await readFile(path, 'utf8')).toBe('top-secret\n');
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it('executes Docker without a shell and returns bounded process output', async () => {
    const result = await runDocker(['inspect', 'name'], { spawnImpl: spawnResult({ stdout: 'ok\n' }) });
    expect(result).toEqual({ code: 0, stdout: 'ok', stderr: '' });
  });

  it('checks both the Docker client and daemon before advertising availability', async () => {
    const calls = [];
    const result = await checkContainerAgentRuntime({
      spawnImpl: (command, args) => {
        calls.push([command, args]);
        return spawnResult({ stdout: '28.5.1\n' })(command, args);
      },
    });

    expect(calls).toEqual([['docker', ['version', '--format', '{{.Server.Version}}']]]);
    expect(result).toEqual({ serverVersion: '28.5.1' });
  });

  it('treats missing volumes as idempotent removal success', async () => {
    const calls = [];
    const spawnImpl = (command, args) => {
      calls.push([command, args]);
      if (args[0] === 'inspect') {
        return spawnResult({ code: 1, stderr: 'Error: No such object: yeaft-agent-worker' })(command, args);
      }
      return spawnResult({
        code: 1,
        stderr: `Error response from daemon: get ${args.at(-1)}: no such volume`,
      })(command, args);
    };

    await expect(removeContainerAgent('worker', { spawnImpl })).resolves.toEqual({
      exists: false,
      status: 'absent',
      running: false,
    });
    expect(calls.filter(([, args]) => args[0] === 'volume').map(([, args]) => args.at(-1))).toEqual([
      'yeaft-agent-worker-data',
      'yeaft-agent-worker-workspace',
    ]);
  });

  it('propagates non-benign volume removal failures', async () => {
    const spawnImpl = (command, args) => {
      if (args[0] === 'inspect') {
        return spawnResult({ code: 1, stderr: 'Error: No such object: yeaft-agent-worker' })(command, args);
      }
      return spawnResult({
        code: 1,
        stderr: 'Error response from daemon: remove yeaft-agent-worker-data: volume is in use',
      })(command, args);
    };

    await expect(removeContainerAgent('worker', { spawnImpl })).rejects.toMatchObject({
      code: 'CONTAINER_AGENT_DOCKER_FAILED',
    });
  });

  it('adds --cgroup-parent when a shared slice is configured', () => {
    const args = buildCreateArgs({
      name: 'worker',
      serverUrl: 'wss://example.test',
      secretFile: '/tmp/agent-secret',
      cgroupParent: 'yeaft.slice',
    });
    expect(args).toContain('--cgroup-parent');
    expect(args[args.indexOf('--cgroup-parent') + 1]).toBe('yeaft.slice');
  });

  it('omits --cgroup-parent when no slice is configured', () => {
    const args = buildCreateArgs({
      name: 'worker',
      serverUrl: 'wss://example.test',
      secretFile: '/tmp/agent-secret',
    });
    expect(args).not.toContain('--cgroup-parent');
  });

  it('rejects an empty cgroup parent', () => {
    expect(() => buildCreateArgs({
      name: 'worker',
      serverUrl: 'wss://example.test',
      secretFile: '/tmp/agent-secret',
      cgroupParent: '   ',
    })).toThrow('CONTAINER_AGENT_INVALID_CGROUP_PARENT');
  });

  it('applies a per-volume disk quota when diskSizeBytes is set', () => {
    const args = buildCreateArgs({
      name: 'worker',
      serverUrl: 'wss://example.test',
      secretFile: '/tmp/agent-secret',
      diskSizeBytes: 20 * 1024 ** 3,
    });
    const mounts = args.filter(arg => arg.startsWith('type=volume'));
    expect(mounts).toHaveLength(2);
    for (const mount of mounts) {
      expect(mount).toContain(`volume-opt=size=${20 * 1024 ** 3}`);
    }
  });

  it('rejects a non-positive disk size', () => {
    expect(() => buildCreateArgs({
      name: 'worker',
      serverUrl: 'wss://example.test',
      secretFile: '/tmp/agent-secret',
      diskSizeBytes: -1,
    })).toThrow('CONTAINER_AGENT_INVALID_DISK_SIZE');
  });

  it('treats a zero disk size as "no quota"', () => {
    const args = buildCreateArgs({
      name: 'worker',
      serverUrl: 'wss://example.test',
      secretFile: '/tmp/agent-secret',
      diskSizeBytes: 0,
    });
    expect(args.filter(arg => arg.startsWith('type=volume')).join(' ')).not.toContain('volume-opt=size=');
  });

  it('computes slice limits at 90% CPU and 70% memory of the host', () => {
    const limits = buildSliceLimits(
      {},
      { cpuCores: 8, memTotalBytes: 16 * 1024 ** 3 },
    );
    expect(limits.cpuQuotaUs).toBe(Math.floor(8 * 0.9 * 100_000));
    expect(limits.cpuPeriodUs).toBe(100_000);
    expect(limits.memoryMaxBytes).toBe(Math.floor(16 * 1024 ** 3 * 0.7));
    expect(limits.pidsMax).toBe(4096);
  });

  it('clamps cpu/memory percentages and keeps a sane pids floor', () => {
    const limits = buildSliceLimits(
      { cpuPercent: 200, memoryPercent: 0, pidsLimit: 1 },
      { cpuCores: 4, memTotalBytes: 1024 ** 3 },
    );
    expect(limits.cpuQuotaUs).toBe(Math.floor(4 * 1.0 * 100_000));
    expect(limits.memoryMaxBytes).toBe(Math.floor(1024 ** 3 * 0.01));
    expect(limits.pidsMax).toBe(64);
  });

  it('detects host CPU count and MemTotal from /proc/meminfo', async () => {
    const resources = await detectHostResources({
      cpuCount: 12,
      readFileImpl: async () => 'MemTotal:       16297316 kB\nMemFree:        12345 kB\n',
    });
    expect(resources.cpuCores).toBe(12);
    expect(resources.memTotalBytes).toBe(16297316 * 1024);
  });

  it('falls back to a zero memory limit when /proc is unreadable', async () => {
    const resources = await detectHostResources({
      cpuCount: 0,
      readFileImpl: async () => { throw new Error('ENOENT'); },
    });
    expect(resources.cpuCores).toBe(1);
    expect(resources.memTotalBytes).toBe(0);
  });

  it('creates a slice with cpu/memory/pids limits and a ready marker', async () => {
    const written = [];
    const fsImpl = {
      mkdir: async (path, opts) => { written.push(['mkdir', path, opts]); },
      readFile: async (path) => {
        if (path === '/sys/fs/cgroup/cgroup.controllers') return 'cpu memory pids\n';
        throw new Error('ENOENT');
      },
      writeFile: async (path, data) => { written.push(['write', path, String(data)]); },
    };
    const result = await ensureAgentSlice({
      slice: 'yeaft.slice',
      resources: { cpuCores: 8, memTotalBytes: 16 * 1024 ** 3 },
      fsImpl,
    });
    expect(result.controllers).toEqual(['cpu', 'memory', 'pids']);
    expect(result.limits.memoryMaxBytes).toBe(Math.floor(16 * 1024 ** 3 * 0.7));
    const writes = written.filter(([op]) => op === 'write').map(([, path, data]) => [path, data]);
    expect(writes).toContainEqual(['/sys/fs/cgroup/yeaft.slice/cgroup.subtree_control', '+cpu +memory +pids']);
    expect(writes).toContainEqual(['/sys/fs/cgroup/yeaft.slice/cpu.max', `${result.limits.cpuQuotaUs} 100000`]);
    expect(writes).toContainEqual(['/sys/fs/cgroup/yeaft.slice/memory.max', String(result.limits.memoryMaxBytes)]);
    expect(writes).toContainEqual(['/sys/fs/cgroup/yeaft.slice/memory.swap.max', '0']);
    expect(writes).toContainEqual(['/sys/fs/cgroup/yeaft.slice/pids.max', '4096']);
    expect(writes.some(([path]) => path.endsWith('/yeaft-slice.ready'))).toBe(true);
  });

  it('only enables controllers the host exposes', async () => {
    const written = [];
    const fsImpl = {
      mkdir: async () => {},
      readFile: async (path) => {
        if (path === '/sys/fs/cgroup/cgroup.controllers') return 'memory\n';
        throw new Error('ENOENT');
      },
      writeFile: async (path, data) => { written.push([path, String(data)]); },
    };
    await ensureAgentSlice({
      slice: 'yeaft.slice',
      resources: { cpuCores: 2, memTotalBytes: 4 * 1024 ** 3 },
      fsImpl,
    });
    expect(written.map(([path]) => path)).toContain('/sys/fs/cgroup/yeaft.slice/cgroup.subtree_control');
    expect(written.find(([path]) => path.endsWith('cgroup.subtree_control'))[1]).toBe('+memory');
    expect(written.some(([path]) => path.endsWith('cpu.max'))).toBe(false);
  });

  it('reports a cgroup permission failure with host remediation instead of raw EACCES', async () => {
    const fsImpl = {
      mkdir: async () => { throw Object.assign(new Error('permission denied'), { code: 'EACCES' }); },
      readFile: async (path) => {
        if (path === '/sys/fs/cgroup/cgroup.controllers') return 'cpu memory pids\n';
        throw new Error('ENOENT');
      },
      writeFile: async () => {},
    };
    await expect(ensureAgentSlice({
      slice: 'yeaft.slice',
      resources: { cpuCores: 2, memTotalBytes: 4 * 1024 ** 3 },
      fsImpl,
    })).rejects.toMatchObject({
      code: 'CONTAINER_AGENT_CGROUP_PERMISSION_DENIED',
      message: expect.stringContaining('read-write cgroup v2 mount'),
    });
  });

  it('also recognizes a literal EACCES message from a cgroup filesystem shim', async () => {
    const fsImpl = {
      mkdir: async () => { throw new Error('EACCES'); },
      readFile: async (path) => {
        if (path === '/sys/fs/cgroup/cgroup.controllers') return 'cpu memory pids\n';
        throw new Error('ENOENT');
      },
      writeFile: async () => {},
    };
    await expect(ensureAgentSlice({ fsImpl })).rejects.toMatchObject({
      code: 'CONTAINER_AGENT_CGROUP_PERMISSION_DENIED',
    });
  });

  it('does not classify a missing cgroup controller file as a permission error', async () => {
    const fsImpl = {
      mkdir: async () => {},
      readFile: async () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); },
      writeFile: async () => {},
    };
    await expect(ensureAgentSlice({ fsImpl })).rejects.toMatchObject({
      code: 'CONTAINER_AGENT_CGROUP_UNAVAILABLE',
    });
  });

  it('refuses to create a slice when no cgroup controllers are available', async () => {
    const written = [];
    const fsImpl = {
      mkdir: async (path, opts) => { written.push(['mkdir', path, opts]); },
      readFile: async () => { throw new Error('ENOENT'); },
      writeFile: async (path, data) => { written.push(['write', path, String(data)]); },
    };
    await expect(ensureAgentSlice({
      slice: 'yeaft.slice',
      resources: { cpuCores: 2, memTotalBytes: 4 * 1024 ** 3 },
      fsImpl,
    })).rejects.toMatchObject({ code: 'CONTAINER_AGENT_CGROUP_UNAVAILABLE' });
    expect(written).toEqual([]);
  });

  it('reports slice readiness from the marker file', async () => {
    expect(await isAgentSliceReady({ readFileImpl: async () => '{}' })).toBe(true);
    expect(await isAgentSliceReady({ readFileImpl: async () => { throw new Error('ENOENT'); } })).toBe(false);
  });

  it('resolves explicit disk sizes to bytes', async () => {
    expect(await resolveDiskSize('20G')).toBe(20 * 1024 ** 3);
    expect(await resolveDiskSize('20GB')).toBe(20 * 1024 ** 3);
    expect(await resolveDiskSize('512M')).toBe(512 * 1024 ** 2);
    expect(await resolveDiskSize('512MB')).toBe(512 * 1024 ** 2);
    expect(await resolveDiskSize('1t')).toBe(1024 ** 4);
    expect(await resolveDiskSize('1tb')).toBe(1024 ** 4);
    expect(await resolveDiskSize(4096)).toBe(4096);
    await expect(resolveDiskSize('12GBQ')).rejects.toMatchObject({
      code: 'CONTAINER_AGENT_INVALID_DISK_SIZE',
    });
  });

  it('resolves percent disk sizes against the Docker data-root filesystem', async () => {
    const size = await resolveDiskSize('80%', {
      dockerRoot: '/var/lib/docker',
      statfsImpl: async () => ({ bsize: 4096, blocks: 10_000_000 }),
    });
    expect(size).toBe(Math.floor(4096 * 10_000_000 * 0.8));
  });

  it('requires a docker root for percent sizes', async () => {
    await expect(resolveDiskSize('80%')).rejects.toMatchObject({
      code: 'CONTAINER_AGENT_INVALID_DISK_SIZE',
    });
  });
});
