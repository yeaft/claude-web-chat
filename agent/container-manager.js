import { spawn } from 'node:child_process';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

export const DEFAULT_AGENT_IMAGE = 'ghcr.io/yeaft/yeaft-web-code-agent-agent:dev';
const NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/;

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
}) {
  const agentName = normalizeContainerAgentName(name);
  if (!String(serverUrl || '').match(/^wss?:\/\//)) {
    throw new ContainerAgentError('CONTAINER_AGENT_INVALID_SERVER_URL');
  }
  if (!secretFile) throw new ContainerAgentError('CONTAINER_AGENT_SECRET_REQUIRED');
  const containerName = containerNameForAgent(agentName);
  const safeImage = String(image || '').trim();
  if (!safeImage || safeImage.startsWith('-')) throw new ContainerAgentError('CONTAINER_AGENT_INVALID_IMAGE');
  return [
    'create', '--name', containerName,
    '--label', 'io.yeaft.container-agent=true',
    '--label', `io.yeaft.agent-name=${agentName}`,
    '--restart', restart,
    '--init',
    '--mount', `type=volume,src=${dataVolume || `${containerName}-data`},dst=/home/yeaft/.yeaft`,
    '--mount', `type=volume,src=${workspaceVolume || `${containerName}-workspace`},dst=/workspace`,
    '--mount', `type=bind,src=${resolve(secretFile)},dst=/run/secrets/yeaft-agent-secret,readonly`,
    '--env', `SERVER_URL=${serverUrl}`,
    '--env', `AGENT_NAME=${agentName}`,
    '--env', 'AGENT_SECRET_FILE=/run/secrets/yeaft-agent-secret',
    '--env', 'YEAFT_DIR=/home/yeaft/.yeaft',
    '--env', 'WORK_DIR=/workspace',
    safeImage,
  ];
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

export async function removeContainerAgent(name, { removeVolumes = true, ...runtime } = {}) {
  const containerName = containerNameForAgent(name);
  const current = await inspectContainerAgent(name, runtime);
  if (current.exists) await runDocker(['rm', '-f', containerName], runtime);
  if (removeVolumes) {
    await runDocker(['volume', 'rm', `${containerName}-data`, `${containerName}-workspace`], {
      ...runtime,
      allowFailure: true,
    });
  }
  return { exists: false, status: 'absent', running: false };
}

export async function logsContainerAgent(name, { follow = false, ...runtime } = {}) {
  const args = ['logs'];
  if (follow) args.push('--follow');
  args.push(containerNameForAgent(name));
  return runDocker(args, { ...runtime, stdout: follow ? 'inherit' : 'pipe' });
}

export async function readSecretInput({ secret, secretFile }) {
  if (secretFile) return (await readFile(resolve(secretFile), 'utf8')).trim();
  return String(secret || '').trim();
}
