import { randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join, win32 } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export const DEFAULT_UPGRADE_REGISTRY = 'https://pkg.yeaft.com/';
export const SAFE_REMOTE_UPGRADE_CAPABILITY = 'remote_upgrade_safe';
export const CONTAINER_AGENT_CAPABILITY = 'container_agent';
export const CONTAINER_IMAGE_UPGRADE_REASON = 'container_image_upgrade_required';

export function isContainerAgentRuntime(env = process.env) {
  return String(env?.YEAFT_AGENT_RUNTIME || '').trim() === CONTAINER_AGENT_CAPABILITY;
}

export function getAgentUpgradeCapability(env = process.env) {
  return isContainerAgentRuntime(env) ? CONTAINER_AGENT_CAPABILITY : SAFE_REMOTE_UPGRADE_CAPABILITY;
}

export function buildContainerImageUpgradeMessage(version = null) {
  const subject = version ? `Container Agent v${version}` : 'This Container Agent';
  return `${subject} is managed as a Docker image and cannot upgrade itself with npm. ` +
    'On the Docker Host, run "docker pull <configured-agent-image>", then recreate the same container ' +
    'through the existing Server/Sandbox lifecycle or the original "yeaft-agent container install" command. ' +
    'Keep the existing /home/yeaft/.yeaft and /workspace persistent volumes and reuse the original host-side ' +
    '0600 agent-secret file; do not remove those volumes during recreation.';
}

const WINDOWS_UPGRADE_LOCK_NAME = 'active.lock';

const ONLINE_METADATA_FLAGS = [
  '--prefer-online',
  '--prefer-offline=false',
  '--offline=false',
];

/** Build argv for an online npm metadata lookup against the Yeaft registry. */
export function buildUpgradeMetadataArgs(packageSpec, field) {
  return [
    'view',
    packageSpec,
    field,
    `--registry=${DEFAULT_UPGRADE_REGISTRY}`,
    ...ONLINE_METADATA_FLAGS,
  ];
}

/** Build argv for an npm install against the Yeaft registry. */
export function buildUpgradeInstallArgs(packageSpec, { global = true, quiet = false } = {}) {
  return [
    'install',
    ...(global ? ['-g'] : []),
    packageSpec,
    `--registry=${DEFAULT_UPGRADE_REGISTRY}`,
    ...(quiet ? ['--no-audit', '--no-fund', '--loglevel=error'] : []),
  ];
}

function resolveNodeCliPath(nodePath, packageName, relativeCliPaths, fileExists = existsSync, pathValue = process.env.PATH || '') {
  const pathApi = /^[A-Za-z]:[\\/]/.test(String(nodePath)) ? win32 : { dirname, join };
  const nodeDir = pathApi.dirname(String(nodePath));
  const roots = [nodeDir, pathApi.dirname(nodeDir)];
  const pathDelimiter = pathApi === win32 ? ';' : delimiter;
  for (const entry of String(pathValue).split(pathDelimiter)) {
    const trimmed = entry.trim().replace(/^"|"$/g, '');
    if (trimmed) roots.push(trimmed);
  }

  for (const root of [...new Set(roots)]) {
    for (const cliPath of relativeCliPaths) {
      const candidate = pathApi.join(root, 'node_modules', packageName, ...cliPath);
      if (fileExists(candidate)) return candidate;
    }
  }
  return null;
}

/** Resolve npm's JavaScript entry point without a `.cmd` wrapper. */
export function resolveWindowsNpmCliPath(nodePath, fileExists = existsSync, pathValue) {
  return resolveNodeCliPath(nodePath, 'npm', [['bin', 'npm-cli.js']], fileExists, pathValue);
}

/** Resolve PM2's JavaScript entry point without a PowerShell/cmd wrapper. */
export function resolveWindowsPm2CliPath(nodePath, fileExists = existsSync, pathValue) {
  return resolveNodeCliPath(nodePath, 'pm2', [['bin', 'pm2'], ['bin', 'pm2.js']], fileExists, pathValue);
}

/** Build the npm metadata command used by `yeaft-agent upgrade`. */
export function buildUpgradeVersionCommand(packageName) {
  return ['npm', ...buildUpgradeMetadataArgs(packageName, 'version')].join(' ');
}

/** Build an npm install command against the Yeaft registry. */
export function buildUpgradeInstallCommand(packageSpec, options) {
  return ['npm', ...buildUpgradeInstallArgs(packageSpec, options)].join(' ');
}

/** Allocate one isolated runtime directory and atomically lock the instance. */
export function createWindowsUpgradeRun(upgradeRoot, {
  runId = randomUUID(),
  parentPid = process.pid,
} = {}) {
  if (!/^[A-Za-z0-9._-]+$/u.test(runId)) throw new TypeError('runId contains invalid path characters');
  if (!Number.isInteger(parentPid) || parentPid <= 0) throw new TypeError('parentPid must be a positive integer');
  const lockPath = join(upgradeRoot, WINDOWS_UPGRADE_LOCK_NAME);
  mkdirSync(upgradeRoot, { recursive: true });

  try {
    mkdirSync(lockPath);
  } catch (err) {
    if (err?.code !== 'EEXIST') throw err;
    let owner = null;
    try { owner = JSON.parse(readFileSync(join(lockPath, 'owner.json'), 'utf8')); } catch {}
    const detail = /^[A-Za-z0-9._-]+$/u.test(owner?.runId || '') ? ` (run ${owner.runId})` : '';
    throw new Error(`A Windows upgrade lock already exists for this instance${detail} at ${lockPath}; remove it only after confirming no upgrade is running`);
  }

  const runDir = join(upgradeRoot, 'runs', runId);
  try {
    writeFileSync(join(lockPath, 'owner.json'), JSON.stringify({ runId, parentPid, createdAt: Date.now() }));
    mkdirSync(dirname(runDir), { recursive: true });
    mkdirSync(runDir);
    return {
      runId,
      runDir,
      lockPath,
      bootstrapPath: join(runDir, 'windows-upgrade-bootstrap.js'),
      runnerPath: join(runDir, 'windows-upgrade-runner.js'),
      commandPath: join(runDir, 'upgrade-command.js'),
      payloadPath: join(runDir, 'payload.json'),
      handoffPath: join(runDir, 'started'),
      authorizePath: join(runDir, 'authorized'),
      cancelPath: join(runDir, 'cancelled'),
    };
  } catch (err) {
    try { rmSync(lockPath, { recursive: true, force: true }); } catch {}
    throw err;
  }
}

/** Release the instance lock only when it still belongs to this run. */
export function releaseWindowsUpgradeLock(lockPath, runId) {
  if (!lockPath || !runId) return false;
  let owner;
  try {
    owner = JSON.parse(readFileSync(join(lockPath, 'owner.json'), 'utf8'));
  } catch {
    return false;
  }
  if (owner?.runId !== runId) return false;
  try {
    rmSync(lockPath, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    return true;
  } catch {
    return false;
  }
}

/** Build a shell-free Node invocation for the short-lived bootstrap. */
export function buildWindowsUpgradeInvocation({ nodePath, bootstrapPath, runnerPath, payloadPath, logPath }) {
  return {
    command: nodePath,
    args: [bootstrapPath, runnerPath, payloadPath],
    options: {
      // PM2 starts the Agent inside the installed package. A child that inherits
      // that cwd keeps the package directory locked against npm's rename step.
      cwd: dirname(bootstrapPath),
      stdio: 'ignore',
      windowsHide: true,
      env: { ...process.env, YEAFT_UPGRADE_LOG: logPath },
    },
  };
}

/** Copy the bootstrap and updater out of the package before npm replaces it. */
export function prepareWindowsUpgradeRunner({
  sourceBootstrapPath,
  sourceRunnerPath,
  sourceCommandPath,
  bootstrapPath,
  runnerPath,
  commandPath,
  payloadPath,
  payload,
}) {
  const runtimeDir = dirname(runnerPath);
  const moduleManifestPath = join(runtimeDir, 'package.json');
  mkdirSync(runtimeDir, { recursive: true });
  for (const path of [
    bootstrapPath,
    runnerPath,
    commandPath,
    moduleManifestPath,
    payloadPath,
    payload.handoffPath,
    payload.authorizePath,
    payload.cancelPath,
  ]) {
    try { rmSync(path, { force: true }); } catch {}
  }
  copyFileSync(sourceBootstrapPath, bootstrapPath);
  copyFileSync(sourceRunnerPath, runnerPath);
  copyFileSync(sourceCommandPath, commandPath);
  writeFileSync(moduleManifestPath, JSON.stringify({ type: 'module' }));
  writeFileSync(payloadPath, JSON.stringify(payload));
}

function waitForSpawn(child) {
  return new Promise((resolve, reject) => {
    const onError = err => {
      child.removeListener('spawn', onSpawn);
      reject(err);
    };
    const onSpawn = () => {
      child.removeListener('error', onError);
      resolve();
    };
    child.once('error', onError);
    child.once('spawn', onSpawn);
  });
}

function waitForExit(child, timeoutMs) {
  return new Promise((resolve, reject) => {
    if (child.exitCode != null || child.signalCode != null) {
      resolve({ code: child.exitCode, signal: child.signalCode });
      return;
    }
    const timer = setTimeout(() => {
      child.removeListener('error', onError);
      child.removeListener('exit', onExit);
      reject(new Error(`Windows upgrade bootstrap did not exit within ${timeoutMs}ms`));
    }, timeoutMs);
    const onError = err => {
      clearTimeout(timer);
      child.removeListener('exit', onExit);
      reject(err);
    };
    const onExit = (code, signal) => {
      clearTimeout(timer);
      child.removeListener('error', onError);
      resolve({ code, signal });
    };
    child.once('error', onError);
    child.once('exit', onExit);
  });
}

function readHandoff(handoffPath, runId) {
  try {
    const handoff = JSON.parse(readFileSync(handoffPath, 'utf8'));
    if (handoff?.runId !== runId) return null;
    if (!Number.isInteger(handoff.runnerPid) || handoff.runnerPid <= 0) return null;
    return handoff;
  } catch {
    return null;
  }
}

function isProcessRunning(pid, probe = process.kill) {
  try {
    probe(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

async function waitForUpgradeHandoff({
  handoffPath,
  runId,
  child,
  fileExists,
  sleep,
  timeoutMs,
  pollIntervalMs,
  getChildError,
  processRunning,
}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const childError = getChildError();
    if (childError) throw childError;

    const handoff = fileExists(handoffPath) ? readHandoff(handoffPath, runId) : null;
    if (handoff && processRunning(handoff.runnerPid)) return handoff;
    // A clean bootstrap exit only confirms the detached spawn. The runner may
    // still be starting and must get the rest of the handoff timeout to reply.
    if (child.signalCode != null || (child.exitCode != null && child.exitCode !== 0)) {
      const status = child.signalCode != null ? `signal ${child.signalCode}` : `code ${child.exitCode}`;
      throw new Error(`Windows upgrade bootstrap exited before handoff (${status})`);
    }
    await sleep(pollIntervalMs);
  }
  throw new Error(`Windows upgrade runner did not confirm handoff within ${timeoutMs}ms`);
}

/**
 * Launch a short-lived bootstrap, verify the updater PID, wait for the bootstrap
 * to exit, and verify the updater again. Only then may the caller exit or let
 * the updater remove the PM2 app.
 */
export async function launchWindowsUpgradeScript({
  runId,
  nodePath,
  bootstrapPath,
  runnerPath,
  payloadPath,
  logPath,
  handoffPath,
  authorizePath,
  cancelPath,
  lockPath,
  spawnProcess,
  fileExists = existsSync,
  removeFile = path => rmSync(path, { force: true }),
  writeCancel = (path, id) => writeFileSync(path, JSON.stringify({ runId: id, cancelledAt: Date.now() })),
  writeAuthorize = (path, id) => writeFileSync(path, JSON.stringify({ runId: id, authorizedAt: Date.now() })),
  sleep = delay,
  processRunning = isProcessRunning,
  timeoutMs = 5000,
  pollIntervalMs = 50,
}) {
  if (!runId) throw new TypeError('runId is required');
  if (typeof spawnProcess !== 'function') throw new TypeError('spawnProcess is required');
  if (!handoffPath) throw new TypeError('handoffPath is required');
  if (!authorizePath) throw new TypeError('authorizePath is required');
  if (!cancelPath) throw new TypeError('cancelPath is required');
  if (!lockPath) throw new TypeError('lockPath is required');

  const invocation = buildWindowsUpgradeInvocation({ nodePath, bootstrapPath, runnerPath, payloadPath, logPath });
  let child;
  try {
    child = spawnProcess(invocation.command, invocation.args, invocation.options);
  } catch (err) {
    releaseWindowsUpgradeLock(lockPath, runId);
    throw new Error(`Windows upgrade bootstrap failed: ${err.message}`, { cause: err });
  }

  let childError = null;
  let bootstrapSpawned = false;
  const onChildError = err => { childError = err; };
  child.on('error', onChildError);
  try {
    await waitForSpawn(child);
    bootstrapSpawned = true;
    const handoff = await waitForUpgradeHandoff({
      handoffPath,
      runId,
      child,
      fileExists,
      sleep,
      timeoutMs,
      pollIntervalMs,
      getChildError: () => childError,
      processRunning,
    });
    const status = await waitForExit(child, timeoutMs);
    if (status.code !== 0) {
      const detail = status.signal ? `signal ${status.signal}` : `code ${status.code}`;
      throw new Error(`Windows upgrade bootstrap exited with ${detail}`);
    }
    if (!processRunning(handoff.runnerPid)) {
      throw new Error('Windows upgrade runner did not survive bootstrap exit');
    }
    writeAuthorize(authorizePath, runId);
  } catch (err) {
    try { writeCancel(cancelPath, runId); } catch {}
    try { child.kill(); } catch {}
    try { removeFile(handoffPath); } catch {}
    if (!bootstrapSpawned) releaseWindowsUpgradeLock(lockPath, runId);
    if (childError === err) {
      throw new Error(`Windows upgrade bootstrap failed: ${err.message}`, { cause: err });
    }
    throw err;
  } finally {
    child.removeListener('error', onChildError);
  }

  return nodePath;
}

/** Build the URL used by the startup-only update notification. */
export function buildUpgradeMetadataUrl(packageName) {
  return `${DEFAULT_UPGRADE_REGISTRY}${encodeURIComponent(packageName)}/latest`;
}
