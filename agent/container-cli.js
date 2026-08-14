#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  createContainerAgent,
  DEFAULT_AGENT_SLICE,
  detectHostResources,
  ensureAgentSlice,
  inspectContainerAgent,
  isAgentSliceReady,
  logsContainerAgent,
  removeContainerAgent,
  resolveDiskSize,
  runDocker,
  startContainerAgent,
  stopContainerAgent,
  writeAgentSecretFile,
} from './container-manager.js';

function help() {
  console.log(`
Usage:
  yeaft-agent container install --server <ws-url> --name <name> --secret <secret> [--image <image>] [--cgroup-parent <slice>] [--no-slice] [--disk-size <size>]
  yeaft-agent container setup-limits [--cpu-percent <pct>] [--memory-percent <pct>] [--pids <n>]
  yeaft-agent container start|stop|status|remove|logs --name <name>

The container is an ordinary yeaft-agent. This command only manages its Docker lifecycle.
The secret is passed as an argument, like 'yeaft-agent install', and persisted by this
command to a private 0600 file before the container is created.

Resource protection (default): install attaches the container to the shared
'${DEFAULT_AGENT_SLICE}' cgroup slice, which caps the sum of all Yeaft Agent
containers at 90% of host CPU and 70% of host memory. The slice is initialized
automatically on first install (as root directly, otherwise via sudo; you are
prompted for the sudo password once). Pass --no-slice to opt out of protection.

--disk-size <size>: per-volume capacity quota for the data and workspace volumes, e.g.
  20G or 80% of the Docker data-root filesystem. Requires Docker overlay2 on xfs with
  project quotas; unsupported filesystems fail docker create. Applies to newly created
  volumes only (Docker ignores size for existing volumes).

Use --keep-volumes with remove to preserve its Yeaft data and workspace volumes.
`);
}

export function parseContainerArgs(args) {
  const options = {};
  const positionals = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--keep-volumes' || arg === '--follow' || arg === '--no-slice') {
      options[arg.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = true;
      continue;
    }
    if (!arg.startsWith('--')) {
      positionals.push(arg);
      continue;
    }
    const value = args[++i];
    if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value`);
    options[arg.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = value;
  }
  return { action: positionals[0], options };
}

async function dockerDataRoot() {
  const result = await runDocker(['info', '--format', '{{.DockerRootDir}}']);
  if (!result.stdout) throw new Error('docker info did not report a data-root');
  return result.stdout;
}

/**
 * Initialize the shared agent slice during `container install` so users never
 * have to run `setup-limits` by hand. Root can write the slice directly; a
 * non-root user re-invokes this CLI via an interactive sudo so the password
 * prompt happens inline. Non-interactive shells skip sudo and fail with
 * guidance instead of hanging.
 *
 * @param {object} options { spawnImpl, interactive } overrides for tests
 */
export async function ensureAgentSliceAuto({
  spawnImpl = spawn,
  interactive = Boolean(process.stdin?.isTTY),
} = {}) {
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    await ensureAgentSlice();
    return;
  }
  if (!interactive) {
    throw new Error(
      `Agent slice '${DEFAULT_AGENT_SLICE}' is not initialized and this shell is not interactive; ` +
      'run "sudo yeaft-agent container setup-limits" once, ' +
      'or pass --no-slice to install without shared resource limits',
    );
  }
  const code = await runSudoSetupLimits({ spawnImpl });
  if (code !== 0) {
    throw new Error(
      `Failed to initialize Agent slice '${DEFAULT_AGENT_SLICE}' via sudo (exit ${code}); ` +
      'run "sudo yeaft-agent container setup-limits" manually, ' +
      'or pass --no-slice to install without shared resource limits',
    );
  }
}

function runSudoSetupLimits({ spawnImpl = spawn } = {}) {
  return new Promise((resolvePromise, reject) => {
    // `sudo env PATH=...` keeps user-installed runtimes (nvm etc.) reachable
    // even when sudoers sets a secure_path. Re-invoking the current entry
    // script avoids depending on the npm bin being in sudo's PATH.
    const entry = process.argv[1] ? resolve(process.argv[1]) : null;
    const args = ['env', `PATH=${process.env.PATH || ''}`];
    if (entry) args.push(process.execPath, entry);
    else args.push('yeaft-agent');
    args.push('container', 'setup-limits');
    const child = spawnImpl('sudo', args, { stdio: 'inherit' });
    child.once('error', reject);
    child.once('close', code => resolvePromise(code ?? 1));
  });
}

export async function runContainerCli(args) {
  if (args.length === 0 || args[0] === 'help' || args[0] === '--help' || args[0] === '-h') return help();
  const { action, options } = parseContainerArgs(args);
  const name = options.name;
  let result;
  if (action === 'install' || action === 'create') {
    if (options.secretFile) {
      throw new Error('--secret-file is no longer supported; pass the secret directly with --secret');
    }
    const secret = String(options.secret || '').trim();
    if (!secret) throw new Error('--secret <secret> is required');
    const secretFile = join(homedir(), '.yeaft', 'container-agents', name, 'agent-secret');
    await writeAgentSecretFile(secretFile, secret);
    let cgroupParent;
    if (options.noSlice) {
      cgroupParent = undefined;
    } else if (options.cgroupParent) {
      cgroupParent = String(options.cgroupParent).trim();
    } else if (!(await isAgentSliceReady())) {
      await ensureAgentSliceAuto();
      cgroupParent = DEFAULT_AGENT_SLICE;
    } else {
      cgroupParent = DEFAULT_AGENT_SLICE;
    }
    let diskSizeBytes;
    if (options.diskSize) {
      const value = String(options.diskSize).trim();
      diskSizeBytes = await resolveDiskSize(value, {
        dockerRoot: value.includes('%') ? await dockerDataRoot() : undefined,
      });
    }
    result = await createContainerAgent({
      name,
      serverUrl: options.server,
      secretFile,
      image: options.image,
      cgroupParent,
      diskSizeBytes,
    });
  } else if (action === 'setup-limits') {
    if (typeof process.getuid === 'function' && process.getuid() !== 0) {
      throw new Error('setup-limits must run as root; use sudo');
    }
    const resources = await detectHostResources();
    result = await ensureAgentSlice({
      cpuPercent: Number(options.cpuPercent) || 90,
      memoryPercent: Number(options.memoryPercent) || 70,
      pidsLimit: Number(options.pids) || 4096,
      resources,
    });
    result.resources = resources;
  } else if (action === 'start') {
    result = await startContainerAgent(name);
  } else if (action === 'stop') {
    result = await stopContainerAgent(name);
  } else if (action === 'status') {
    result = await inspectContainerAgent(name);
  } else if (action === 'remove') {
    result = await removeContainerAgent(name, { removeVolumes: !options.keepVolumes });
  } else if (action === 'logs') {
    result = await logsContainerAgent(name, { follow: options.follow });
    if (!options.follow && result.stdout) console.log(result.stdout);
    return;
  } else {
    throw new Error(`Unknown container action: ${action}`);
  }
  console.log(JSON.stringify({ name, ...result }, null, 2));
}

if (process.argv[1] && import.meta.url === new URL(`file://${resolve(process.argv[1])}`).href) {
  runContainerCli(process.argv.slice(2)).catch(error => {
    console.error(`Container Agent failed: ${error.code || error.message}`);
    process.exitCode = 1;
  });
}
