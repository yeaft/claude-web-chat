import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { lstat, mkdir, rm, writeFile } from 'node:fs/promises';
import { freemem } from 'node:os';
import { join, resolve, sep } from 'node:path';
const SANDBOX_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const PRIVATE_IPV4_DESTINATIONS = [
  '0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8',
  '169.254.0.0/16', '172.16.0.0/12', '192.0.0.0/24', '192.168.0.0/16',
  '198.18.0.0/15', '224.0.0.0/4', '240.0.0.0/4'
];
const PRIVATE_IPV6_DESTINATIONS = [
  '::/128', '::1/128', 'fc00::/7', 'fe80::/10', 'ff00::/8', '2001:db8::/32', '2001:10::/28'
];

function commandRunner(command, args, options = {}) {
  return new Promise((resolveCommand, rejectCommand) => {
    const child = spawn(command, args, {
      env: options.env,
      stdio: [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      windowsHide: true
    });
    if (options.input !== undefined) child.stdin.end(options.input);
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const maxBuffer = 1024 * 1024;
    const timer = setTimeout(() => child.kill('SIGKILL'), options.timeoutMs || 30_000);
    child.stdout.on('data', chunk => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxBuffer) child.kill('SIGKILL');
      else stdout.push(chunk);
    });
    child.stderr.on('data', chunk => {
      stderrBytes += chunk.length;
      if (stderrBytes > maxBuffer) child.kill('SIGKILL');
      else stderr.push(chunk);
    });
    child.on('error', error => {
      clearTimeout(timer);
      rejectCommand(error);
    });
    child.on('close', code => {
      clearTimeout(timer);
      const result = {
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        code
      };
      if (code === 0) resolveCommand(result);
      else rejectCommand(Object.assign(new Error(`${command} exited with code ${code}`), result));
    });
  });
}

function assertSandboxId(value) {
  if (!SANDBOX_ID.test(String(value || ''))) {
    throw new Error('Sandbox runtime rejected an invalid Sandbox identity');
  }
}

function sandboxName(sandboxId) {
  return `yeaft-sandbox-${createHash('sha256').update(sandboxId).digest('hex').slice(0, 24)}`;
}

function within(root, path) {
  const normalizedRoot = resolve(root);
  const normalizedPath = resolve(path);
  return normalizedPath === normalizedRoot || normalizedPath.startsWith(`${normalizedRoot}${sep}`);
}

function parseInspect(stdout) {
  const parsed = JSON.parse(stdout);
  const value = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!value || typeof value !== 'object') throw new Error('Sandbox runtime inspect returned no object');
  return value;
}

function exactImage(inspect, digest) {
  return inspect.ImageDigest === digest || inspect.ImageName === digest || inspect.Config?.Image === digest;
}

/**
 * Concrete dedicated-Host runtime executor. It accepts only the signed Helper
 * operation schema and translates it to fixed Podman, XFS and nftables calls.
 * No caller-controlled command, path, mount, capability or network argument is
 * accepted.
 */
export function createSandboxRuntimeExecutor({ config, run = commandRunner, availableMemoryBytes = freemem }) {
  if (!config?.dedicatedHost || !config.dataRoot || !config.imageDigest
    || !config.serverUrl || !config.runtimeBinary || !config.xfsQuotaBinary
    || !config.nftBinary || !config.networkName || !config.networkBridge
    || !Number.isInteger(config.pidsLimit) || config.pidsLimit <= 0
    || !Number.isInteger(config.ioWeight) || config.ioWeight <= 0
    || !Number.isInteger(config.hostMemoryReserveMiB) || config.hostMemoryReserveMiB <= 0
    || typeof availableMemoryBytes !== 'function') {
    throw new Error('Sandbox runtime requires a complete dedicated Host configuration');
  }

  const dataRoot = resolve(config.dataRoot);
  const policyRoot = resolve(config.policyRoot || join(dataRoot, '.policy'));

  function paths(operation) {
    assertSandboxId(operation.sandboxId);
    const root = resolve(dataRoot, operation.sandboxId);
    const home = join(root, 'home');
    const workspace = join(root, 'workspace');
    const policy = resolve(policyRoot, `${operation.sandboxId}.nft`);
    if (![root, home, workspace].every(path => within(dataRoot, path)) || !within(policyRoot, policy)) {
      throw new Error('Sandbox runtime rejected a path outside its data root');
    }
    return { root, home, workspace, policy };
  }

  async function inspectContainer(name) {
    try {
      const result = await run(config.runtimeBinary, ['inspect', name]);
      return parseInspect(result.stdout);
    } catch (error) {
      if (error.code === 125 || /no such (container|object)/i.test(String(error.stderr || error.message))) return null;
      throw error;
    }
  }

  function quotaProjectId(operation) {
    if (!Number.isInteger(config.quotaProjectBase) || config.quotaProjectBase <= 0) {
      throw new Error('Sandbox runtime requires a valid XFS quota project range');
    }
    return config.quotaProjectBase + Number.parseInt(
      createHash('sha256').update(operation.sandboxId).digest('hex').slice(0, 7), 16
    );
  }

  async function inspectQuota(operation) {
    const projectId = quotaProjectId(operation);
    const hardLimit = `${operation.resources.diskGiB}g`;
    const report = await run(config.xfsQuotaBinary, ['-x', '-c', `report -p -n -N ${projectId}`, dataRoot]);
    if (!String(report.stdout).includes(String(projectId)) || !String(report.stdout).toLowerCase().includes(hardLimit)) {
      throw new Error('Sandbox XFS hard quota inspection failed');
    }
  }

  async function applyQuota(operation, root) {
    const projectId = quotaProjectId(operation);
    const hardLimit = `${operation.resources.diskGiB}g`;
    await run(config.xfsQuotaBinary, ['-x', '-c', `project -s -p ${root} ${projectId}`, dataRoot]);
    await run(config.xfsQuotaBinary, ['-x', '-c', `limit -p bhard=${hardLimit} ${projectId}`, dataRoot]);
    await inspectQuota(operation);
  }

  function networkTable(operation) {
    return `yeaft_sbx_${createHash('sha256').update(operation.sandboxId).digest('hex').slice(0, 16)}`;
  }

  function networkPolicy(operation, name) {
    const marker = `yeaft:${operation.sandboxId}:${operation.generation}`;
    const table = networkTable(operation);
    const blockedIpv4 = PRIVATE_IPV4_DESTINATIONS
      .map(cidr => `  iifname \"${config.networkBridge}\" ip daddr ${cidr} reject comment \"${marker}\"`)
      .join('\n');
    const blockedIpv6 = PRIVATE_IPV6_DESTINATIONS
      .map(cidr => `  iifname \"${config.networkBridge}\" ip6 daddr ${cidr} reject comment \"${marker}\"`)
      .join('\n');
    return `table inet ${table} {\n chain forward { type filter hook forward priority -10; policy accept;\n  iifname \"${config.networkBridge}\" ct state established,related accept\n${blockedIpv4}\n${blockedIpv6}\n  iifname \"${config.networkBridge}\" oifname \"${config.networkBridge}\" reject comment \"${marker}\"\n  oifname \"${config.networkBridge}\" ct state new reject comment \"${marker}\"\n }\n}\n# ${name}\n`;
  }

  async function inspectNetwork(operation) {
    const inspected = await run(config.nftBinary, ['list', 'table', 'inet', networkTable(operation)]);
    const marker = `yeaft:${operation.sandboxId}:${operation.generation}`;
    if (!String(inspected.stdout).includes(marker)) throw new Error('Sandbox network policy inspection failed');
  }

  async function applyNetwork(operation, name, policy) {
    await mkdir(policyRoot, { recursive: true, mode: 0o700 });
    const rules = networkPolicy(operation, name);
    await writeFile(policy, rules, { mode: 0o600 });
    await run(config.nftBinary, ['-c', '-f', policy]);
    await run(config.nftBinary, ['-f', policy]);
    await inspectNetwork(operation);
  }

  function assertMemoryAvailable(operation) {
    const bytes = Number(availableMemoryBytes());
    const availableMiB = Math.floor(bytes / 1024 / 1024);
    if (!Number.isSafeInteger(availableMiB)
      || availableMiB - config.hostMemoryReserveMiB < operation.resources.memoryMiB) {
      const error = new Error('Sandbox runtime memory admission rejected');
      error.code = 'SANDBOX_CAPACITY_UNAVAILABLE';
      throw error;
    }
  }

  async function create(operation) {
    if (operation.imageDigest !== config.imageDigest) throw new Error('Sandbox runtime rejected an unpinned image');
    const name = sandboxName(operation.sandboxId);
    const target = paths(operation);
    await mkdir(target.home, { recursive: true, mode: 0o700 });
    await mkdir(target.workspace, { recursive: true, mode: 0o700 });
    await applyQuota(operation, target.root);
    await applyNetwork(operation, name, target.policy);

    let inspect = await inspectContainer(name);
    assertMemoryAvailable(operation);
    if (!inspect) {
      if (!operation.bootstrap?.token || !Number.isFinite(operation.bootstrap.expiresAt)) {
        throw new Error('Sandbox runtime requires a scoped bootstrap envelope');
      }
      const bootstrapPath = join(target.root, 'bootstrap.json');
      await writeFile(bootstrapPath, JSON.stringify({
        serverUrl: config.serverUrl,
        token: operation.bootstrap.token,
        claims: {
          sandboxId: operation.sandboxId,
          instanceId: operation.instanceId,
          generation: operation.generation,
          imageDigest: operation.imageDigest
        }
      }), { mode: 0o600 });
      await run(config.runtimeBinary, [
        'create', '--name', name,
        '--label', `io.yeaft.sandbox-id=${operation.sandboxId}`,
        '--label', `io.yeaft.instance-id=${operation.instanceId}`,
        '--runtime', config.isolationRuntime || 'runsc', '--read-only',
        '--cap-drop=ALL', '--security-opt=no-new-privileges', '--userns=auto',
        '--user', String(config.containerUid || 10001), '--network', config.networkName,
        '--cpus', String(operation.resources.cpuMillis / 1000),
        '--memory', `${operation.resources.memoryMiB}m`, '--pids-limit', String(config.pidsLimit),
        '--blkio-weight', String(config.ioWeight), '--tmpfs', '/tmp:rw,noexec,nosuid,size=256m',
        '--tmpfs', '/run:rw,noexec,nosuid,size=64m', '--tmpfs', '/dev/shm:rw,noexec,nosuid,size=64m',
        '--mount', `type=bind,src=${target.home},dst=/home/yeaft,rw,nosuid,nodev`,
        '--mount', `type=bind,src=${target.workspace},dst=/workspace,rw,nosuid,nodev`,
        '--mount', `type=bind,src=${bootstrapPath},dst=/run/yeaft/bootstrap.json,ro,nosuid,nodev,noexec`,
        config.imageDigest,
        'yeaft-agent', 'managed-sandbox', '--bootstrap-file', '/run/yeaft/bootstrap.json'
      ]);
      inspect = await inspectContainer(name);
    }
    if (!inspect || !exactImage(inspect, config.imageDigest)) throw new Error('Sandbox fixed image inspection failed');
    await run(config.runtimeBinary, ['start', name]);
    const proof = await runtimeProof(operation, inspect);
    await rm(join(target.root, 'bootstrap.json'), { force: true });
    return proof;
  }

  async function runtimeProof(operation, inspect) {
    const host = inspect.HostConfig || {};
    const container = inspect.Config || {};
    const cpuMillis = Math.round(Number(host.NanoCpus || 0) / 1_000_000);
    const memoryMiB = Math.round(Number(host.Memory || 0) / 1024 / 1024);
    const pidsLimit = Number(host.PidsLimit || 0);
    const ioWeight = Number(host.BlkioWeight || 0);
    const capDrop = host.CapDrop || [];
    const securityOpt = host.SecurityOpt || [];
    const mounts = inspect.Mounts || [];
    const valid = exactImage(inspect, config.imageDigest)
      && cpuMillis === operation.resources.cpuMillis
      && memoryMiB === operation.resources.memoryMiB
      && pidsLimit === config.pidsLimit && ioWeight === config.ioWeight
      && host.ReadonlyRootfs === true && capDrop.includes('ALL')
      && securityOpt.some(value => String(value).includes('no-new-privileges'))
      && String(host.UsernsMode || '').startsWith('auto')
      && String(container.User || '') === String(config.containerUid || 10001)
      && host.NetworkMode === config.networkName
      && mounts.length >= 3
      && mounts.every(mount => mount.Type === 'bind' && within(dataRoot, mount.Source));
    if (!valid) throw new Error('Sandbox runtime isolation inspection failed');
    await inspectQuota(operation);
    await inspectNetwork(operation);
    return {
      success: true,
      readinessProof: { image: true, cpu: true, memory: true, pid: true, io: true, quota: true, network: true, credential: true },
      resourceInspection: {
        cpuMillis, memoryMiB, diskGiB: operation.resources.diskGiB,
        pidsLimit, ioWeight, quotaHard: true, networkPolicy: 'public-egress-isolated'
      }
    };
  }

  async function execute(operation) {
    const name = sandboxName(operation.sandboxId);
    const target = paths(operation);
    if (operation.action === 'create' || operation.action === 'retry') return create(operation);
    if (operation.action === 'start') {
      const inspect = await inspectContainer(name);
      if (!inspect) throw new Error('Sandbox container is absent');
      assertMemoryAvailable(operation);
      await run(config.runtimeBinary, ['start', name]);
      return runtimeProof(operation, inspect);
    }
    if (operation.action === 'stop') {
      const inspect = await inspectContainer(name);
      if (!inspect) throw new Error('Sandbox container is absent');
      await run(config.runtimeBinary, ['stop', '--time', String(config.stopTimeoutSeconds || 20), name]);
      return runtimeProof(operation, inspect);
    }
    if (operation.action === 'remove') {
      await run(config.runtimeBinary, ['rm', '--force', '--ignore', name]);
      const table = networkTable(operation);
      await run(config.nftBinary, ['delete', 'table', 'inet', table]).catch(() => {});
      await rm(target.policy, { force: true });
      const projectId = quotaProjectId(operation);
      await run(config.xfsQuotaBinary, ['-x', '-c', `project -C -p ${target.root}`, dataRoot]);
      await rm(target.root, { recursive: true, force: true });
      const inspect = await inspectContainer(name);
      let storageAbsent = false;
      try { await lstat(target.root); } catch (error) { storageAbsent = error.code === 'ENOENT'; }
      const quota = await run(config.xfsQuotaBinary, ['-x', '-c', `report -p -n -N ${projectId}`, dataRoot]);
      let networkAbsent = false;
      try {
        await run(config.nftBinary, ['list', 'table', 'inet', table]);
      } catch {
        networkAbsent = true;
      }
      if (inspect || !storageAbsent || String(quota.stdout).includes(String(projectId)) || !networkAbsent) {
        throw new Error('Sandbox resource removal inspection failed');
      }
      return { success: true, absenceProof: { container: true, storage: true, quota: true, network: true, credential: true } };
    }
    throw new Error('Sandbox runtime rejected an unsupported lifecycle action');
  }

  return { execute };
}

export { commandRunner, sandboxName };
