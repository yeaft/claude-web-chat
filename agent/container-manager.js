import { spawn } from 'node:child_process';
import { chmod, mkdir, readFile, statfs, writeFile } from 'node:fs/promises';
import { cpus } from 'node:os';
import { dirname, resolve } from 'node:path';

export const DEFAULT_AGENT_IMAGE = 'ghcr.io/yeaft/yeaft-web-code-agent-agent:dev';
export const DEFAULT_AGENT_SLICE = 'yeaft.slice';
export const SLICE_READY_MARKER = 'yeaft-slice.ready';
const NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/;
const CPU_PERIOD_US = 100_000;

export class ContainerAgentError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = 'ContainerAgentError';
    this.code = code;
  }
}

export function normalizeContainerAgentName(name) {
  const value = String(name || '').trim();
  if (!NAME_PATTERN.test(value)) throw new ContainerAgentError('CONTAINER_AGENT_INVALID_NAME');
  return value;
}

export function containerNameForAgent(name) {
  return `yeaft-agent-${normalizeContainerAgentName(name)}`;
}

export async function runDocker(args, { spawnImpl = spawn, allowFailure = false, stdout = 'pipe' } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawnImpl('docker', args, {
      stdio: ['ignore', stdout, 'pipe'],
      windowsHide: true,
    });
    const output = [];
    const errors = [];
    child.stdout?.on('data', chunk => output.push(chunk));
    child.stderr?.on('data', chunk => errors.push(chunk));
    child.once('error', error => reject(new ContainerAgentError('CONTAINER_AGENT_DOCKER_UNAVAILABLE', error.message)));
    child.once('close', code => {
      const result = {
        code: code ?? 1,
        stdout: Buffer.concat(output).toString('utf8').trim(),
        stderr: Buffer.concat(errors).toString('utf8').trim(),
      };
      if (result.code === 0 || allowFailure) resolvePromise(result);
      else reject(new ContainerAgentError('CONTAINER_AGENT_DOCKER_FAILED', result.stderr || `docker ${args[0]} failed`));
    });
  });
}

export async function writeAgentSecretFile(path, secret) {
  const value = String(secret || '').trim();
  if (!value) throw new ContainerAgentError('CONTAINER_AGENT_SECRET_REQUIRED');
  const absolute = resolve(path);
  await mkdir(dirname(absolute), { recursive: true, mode: 0o700 });
  await writeFile(absolute, `${value}\n`, { mode: 0o600 });
  await chmod(absolute, 0o600);
  return absolute;
}

export function buildCreateArgs({
  name,
  serverUrl,
  secretFile,
  image = DEFAULT_AGENT_IMAGE,
  dataVolume,
  workspaceVolume,
  restart = 'unless-stopped',
  cgroupParent,
  diskSizeBytes,
}) {
  const agentName = normalizeContainerAgentName(name);
  if (!String(serverUrl || '').match(/^wss?:\/\//)) {
    throw new ContainerAgentError('CONTAINER_AGENT_INVALID_SERVER_URL');
  }
  if (!secretFile) throw new ContainerAgentError('CONTAINER_AGENT_SECRET_REQUIRED');
  const containerName = containerNameForAgent(agentName);
  const safeImage = String(image || '').trim();
  if (!safeImage || safeImage.startsWith('-')) throw new ContainerAgentError('CONTAINER_AGENT_INVALID_IMAGE');
  const args = [
    'create', '--name', containerName,
    '--label', 'io.yeaft.container-agent=true',
    '--label', `io.yeaft.agent-name=${agentName}`,
    '--restart', restart,
    '--init',
  ];
  if (cgroupParent) {
    const slice = String(cgroupParent).trim();
    if (!slice) throw new ContainerAgentError('CONTAINER_AGENT_INVALID_CGROUP_PARENT');
    args.push('--cgroup-parent', slice);
  }
  let diskOpt = '';
  if (diskSizeBytes) {
    const size = Math.floor(Number(diskSizeBytes));
    if (!Number.isFinite(size) || size <= 0) {
      throw new ContainerAgentError('CONTAINER_AGENT_INVALID_DISK_SIZE');
    }
    diskOpt = `,volume-opt=size=${size}`;
  }
  args.push(
    '--mount', `type=volume,src=${dataVolume || `${containerName}-data`},dst=/home/yeaft/.yeaft${diskOpt}`,
    '--mount', `type=volume,src=${workspaceVolume || `${containerName}-workspace`},dst=/workspace${diskOpt}`,
    '--mount', `type=bind,src=${resolve(secretFile)},dst=/run/yeaft-host-secret,readonly`,
    '--env', `SERVER_URL=${serverUrl}`,
    '--env', `AGENT_NAME=${agentName}`,
    '--env', 'AGENT_SECRET_FILE=/run/yeaft-host-secret',
    '--env', 'YEAFT_DIR=/home/yeaft/.yeaft',
    '--env', 'WORK_DIR=/workspace',
    safeImage,
  );
  return args;
}

/**
 * Verify that the Docker client can reach a daemon before the Server advertises
 * container Agent lifecycle support.
 *
 * @param {object} options runDocker overrides used by tests and alternate runtimes
 * @returns {Promise<{serverVersion: string|null}>}
 */
export async function checkContainerAgentRuntime(options = {}) {
  const result = await runDocker(['version', '--format', '{{.Server.Version}}'], options);
  return { serverVersion: result.stdout || null };
}

export async function inspectContainerAgent(name, options = {}) {
  const result = await runDocker([
    'inspect', '--format', '{{json .State}}', containerNameForAgent(name),
  ], { ...options, allowFailure: true });
  if (result.code !== 0) {
    if (/no such (object|container)/i.test(result.stderr)) {
      return { exists: false, status: 'absent', running: false };
    }
    throw new ContainerAgentError('CONTAINER_AGENT_DOCKER_FAILED', result.stderr || 'docker inspect failed');
  }
  try {
    const state = JSON.parse(result.stdout);
    return {
      exists: true,
      status: state.Status || 'unknown',
      running: state.Running === true,
      startedAt: state.StartedAt || null,
      error: state.Error || null,
    };
  } catch {
    throw new ContainerAgentError('CONTAINER_AGENT_INVALID_DOCKER_RESPONSE');
  }
}

export async function createContainerAgent(options, runtime = {}) {
  const current = await inspectContainerAgent(options.name, runtime);
  if (current.exists) throw new ContainerAgentError('CONTAINER_AGENT_ALREADY_EXISTS');
  const containerName = containerNameForAgent(options.name);
  await runDocker(buildCreateArgs(options), runtime);
  try {
    await runDocker(['start', containerName], runtime);
  } catch (error) {
    await runDocker(['rm', '-f', containerName], { ...runtime, allowFailure: true });
    throw error;
  }
  return inspectContainerAgent(options.name, runtime);
}

export async function startContainerAgent(name, runtime = {}) {
  await runDocker(['start', containerNameForAgent(name)], runtime);
  return inspectContainerAgent(name, runtime);
}

export async function stopContainerAgent(name, runtime = {}) {
  await runDocker(['stop', '--time', '10', containerNameForAgent(name)], runtime);
  return inspectContainerAgent(name, runtime);
}

function isMissingDockerVolume(stderr) {
  return /no such volume/i.test(String(stderr || ''));
}

export async function removeContainerAgent(name, { removeVolumes = true, ...runtime } = {}) {
  const containerName = containerNameForAgent(name);
  const current = await inspectContainerAgent(name, runtime);
  if (current.exists) await runDocker(['rm', '-f', containerName], runtime);
  if (removeVolumes) {
    for (const volume of [`${containerName}-data`, `${containerName}-workspace`]) {
      const result = await runDocker(['volume', 'rm', volume], {
        ...runtime,
        allowFailure: true,
      });
      if (result.code !== 0 && !isMissingDockerVolume(result.stderr)) {
        throw new ContainerAgentError(
          'CONTAINER_AGENT_DOCKER_FAILED',
          result.stderr || `docker volume rm ${volume} failed`,
        );
      }
    }
  }
  return { exists: false, status: 'absent', running: false };
}

export async function logsContainerAgent(name, { follow = false, ...runtime } = {}) {
  const args = ['logs'];
  if (follow) args.push('--follow');
  args.push(containerNameForAgent(name));
  return runDocker(args, { ...runtime, stdout: follow ? 'inherit' : 'pipe' });
}

function clampPercent(value, fallback) {
  const n = Number(value);
  const safe = Number.isFinite(n) ? n : fallback;
  return Math.min(100, Math.max(1, safe));
}

/**
 * Compute cgroup v2 slice limits from host resources. Pure function so the
 * 90% CPU / 70% memory policy is directly testable.
 *
 * @param {object} policy cpuPercent (default 90), memoryPercent (default 70), pidsLimit (default 4096)
 * @param {object} resources { cpuCores, memTotalBytes } from detectHostResources
 * @returns {{cpuQuotaUs: number, cpuPeriodUs: number, memoryMaxBytes: number, pidsMax: number}}
 */
export function buildSliceLimits(
  { cpuPercent = 90, memoryPercent = 70, pidsLimit = 4096 } = {},
  { cpuCores = 0, memTotalBytes = 0 } = {},
) {
  const cores = Math.max(1, Math.floor(Number(cpuCores) || 0) || 1);
  const cpuPct = clampPercent(cpuPercent, 90);
  const memPct = clampPercent(memoryPercent, 70);
  return {
    cpuQuotaUs: Math.floor((cores * cpuPct / 100) * CPU_PERIOD_US),
    cpuPeriodUs: CPU_PERIOD_US,
    memoryMaxBytes: Math.floor((Number(memTotalBytes) || 0) * memPct / 100),
    pidsMax: Math.max(64, Math.floor(Number(pidsLimit) || 0) || 4096),
  };
}

/**
 * Detect host resources: logical CPU count plus MemTotal from /proc/meminfo.
 * MemTotal may be 0 on non-Linux or unreadable /proc; callers must treat a
 * zero memory limit as "no memory constraint" rather than OOM-ing containers.
 *
 * @param {object} options { readFileImpl, cpuCount } overrides for tests
 * @returns {Promise<{cpuCores: number, memTotalBytes: number}>}
 */
export async function detectHostResources({ readFileImpl = readFile, cpuCount = cpus().length } = {}) {
  let memTotalBytes = 0;
  try {
    const meminfo = await readFileImpl('/proc/meminfo', 'utf8');
    const match = String(meminfo || '').match(/^MemTotal:\s+(\d+)\s*kB/m);
    if (match) memTotalBytes = Number(match[1]) * 1024;
  } catch {
    // Non-Linux or restricted /proc; memory limiting is skipped downstream.
  }
  return { cpuCores: Math.max(1, Math.floor(Number(cpuCount) || 0) || 1), memTotalBytes };
}

/**
 * Create or refresh a cgroup v2 slice that all Yeaft Agent containers share.
 * Requires root (writes under /sys/fs/cgroup). Writes a ready marker so
 * `container install` can refuse to create unprotected containers by default.
 *
 * @param {object} options slice, cpuPercent, memoryPercent, pidsLimit,
 *   resources (pre-detected), fsImpl { mkdir, readFile, writeFile } for tests
 * @returns {Promise<{slice: string, limits: object, controllers: string[]}>}
 */
export async function ensureAgentSlice({
  slice = DEFAULT_AGENT_SLICE,
  cpuPercent = 90,
  memoryPercent = 70,
  pidsLimit = 4096,
  resources,
  fsImpl = { mkdir, readFile, writeFile },
} = {}) {
  const slicePath = `/sys/fs/cgroup/${String(slice).replace(/^\/+/, '')}`;
  let controllers = [];
  try {
    const text = await fsImpl.readFile('/sys/fs/cgroup/cgroup.controllers', 'utf8');
    controllers = String(text || '').trim().split(/\s+/).filter(Boolean);
  } catch {
    // Treat missing controller list as "no controllers writable".
  }
  const wanted = ['cpu', 'memory', 'pids'].filter(name => controllers.includes(name));
  if (wanted.length === 0) {
    throw new ContainerAgentError(
      'CONTAINER_AGENT_CGROUP_UNAVAILABLE',
      'cgroup v2 controllers (cpu/memory/pids) are unavailable; setup-limits requires a host running cgroup v2 and root access to /sys/fs/cgroup',
    );
  }
  await fsImpl.mkdir(slicePath, { recursive: true, mode: 0o755 });
  await fsImpl.writeFile(
    `${slicePath}/cgroup.subtree_control`,
    wanted.map(name => `+${name}`).join(' '),
    'utf8',
  );
  const detected = resources || await detectHostResources({ readFileImpl: fsImpl.readFile });
  const limits = buildSliceLimits({ cpuPercent, memoryPercent, pidsLimit }, detected);
  if (wanted.includes('cpu') && limits.cpuQuotaUs > 0) {
    await fsImpl.writeFile(`${slicePath}/cpu.max`, `${limits.cpuQuotaUs} ${limits.cpuPeriodUs}`, 'utf8');
  }
  if (wanted.includes('memory') && limits.memoryMaxBytes > 0) {
    await fsImpl.writeFile(`${slicePath}/memory.max`, String(limits.memoryMaxBytes), 'utf8');
    // No swap escape hatch: the 70% RAM hard cap is the whole memory budget.
    await fsImpl.writeFile(`${slicePath}/memory.swap.max`, '0', 'utf8');
  }
  if (wanted.includes('pids') && limits.pidsMax > 0) {
    await fsImpl.writeFile(`${slicePath}/pids.max`, String(limits.pidsMax), 'utf8');
  }
  const marker = {
    slice,
    cpuQuotaUs: limits.cpuQuotaUs,
    cpuPeriodUs: limits.cpuPeriodUs,
    memoryMaxBytes: limits.memoryMaxBytes,
    pidsMax: limits.pidsMax,
    updatedAt: new Date().toISOString(),
  };
  await fsImpl.writeFile(`${slicePath}/${SLICE_READY_MARKER}`, JSON.stringify(marker, null, 2), 'utf8');
  return { slice, limits, controllers: wanted };
}

/**
 * Whether `container setup-limits` has initialized the given slice.
 *
 * @param {object} options slice, readFileImpl for tests
 * @returns {Promise<boolean>}
 */
export async function isAgentSliceReady({ slice = DEFAULT_AGENT_SLICE, readFileImpl = readFile } = {}) {
  const slicePath = `/sys/fs/cgroup/${String(slice).replace(/^\/+/, '')}`;
  try {
    await readFileImpl(`${slicePath}/${SLICE_READY_MARKER}`, 'utf8');
    return true;
  } catch {
    return false;
  }
}

const DISK_SIZE_RE = /^(\d+(?:\.\d+)?)\s*(%|[kmgt](?:i?b)?|b)?$/i;

/**
 * Resolve a disk size like "20G" or "80%" to bytes. Percentages are computed
 * against the Docker data-root filesystem and require statfsImpl (node:fs
 * statfs) plus the docker root path.
 *
 * @param {string|number} value
 * @param {object} options { dockerRoot, statfsImpl } for percent resolution and tests
 * @returns {Promise<number>}
 */
export async function resolveDiskSize(value, { dockerRoot, statfsImpl = statfs } = {}) {
  const input = String(value ?? '').trim();
  const match = input.match(DISK_SIZE_RE);
  if (!match) throw new ContainerAgentError('CONTAINER_AGENT_INVALID_DISK_SIZE', `Invalid disk size: ${input}`);
  const amount = Number(match[1]);
  const unit = (match[2] || 'b').toLowerCase();
  if (unit === 'b') return Math.floor(amount);
  if (unit === '%') {
    if (!dockerRoot) throw new ContainerAgentError('CONTAINER_AGENT_INVALID_DISK_SIZE', 'Percent disk size requires the Docker data-root');
    const info = await statfsImpl(dockerRoot);
    const totalBytes = Number(info.bsize) * Number(info.blocks);
    return Math.floor(totalBytes * amount / 100);
  }
  const multipliers = { k: 1024, kb: 1024, kib: 1024, m: 1024 ** 2, mb: 1024 ** 2, mib: 1024 ** 2, g: 1024 ** 3, gb: 1024 ** 3, gib: 1024 ** 3, t: 1024 ** 4, tb: 1024 ** 4, tib: 1024 ** 4 };
  const multiplier = multipliers[unit];
  if (!multiplier) throw new ContainerAgentError('CONTAINER_AGENT_INVALID_DISK_SIZE', `Invalid disk size: ${input}`);
  return Math.floor(amount * multiplier);
}
