import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join, win32 } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export const DEFAULT_UPGRADE_REGISTRY = 'https://pkg.yeaft.com/';

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

/** Build a shell-free detached Node invocation for the Windows updater. */
export function buildWindowsUpgradeInvocation({ nodePath, runnerPath, payloadPath, logPath }) {
  return {
    command: nodePath,
    args: [runnerPath, payloadPath],
    options: {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: { ...process.env, YEAFT_UPGRADE_LOG: logPath },
    },
  };
}

/**
 * Copy the updater out of the npm package before npm replaces that package.
 * The runner imports only this helper module, so copy both files together.
 */
export function prepareWindowsUpgradeRunner({ sourceRunnerPath, sourceCommandPath, runnerPath, commandPath, payloadPath, payload }) {
  const runtimeDir = dirname(runnerPath);
  const moduleManifestPath = join(runtimeDir, 'package.json');
  mkdirSync(runtimeDir, { recursive: true });
  for (const path of [runnerPath, commandPath, moduleManifestPath, payloadPath, payload.handoffPath]) {
    try { rmSync(path, { force: true }); } catch {}
  }
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

async function waitForUpgradeHandoff({
  handoffPath,
  child,
  fileExists,
  sleep,
  timeoutMs,
  pollIntervalMs,
  getChildError,
}) {
  const deadline = Date.now() + timeoutMs;
  let handoffSeen = false;
  while (Date.now() < deadline) {
    const childError = getChildError();
    if (childError) throw childError;
    if (child.exitCode != null || child.signalCode != null) {
      const status = child.exitCode != null ? `code ${child.exitCode}` : `signal ${child.signalCode}`;
      throw new Error(`Windows upgrade launcher exited before handoff (${status})`);
    }

    // Require the marker on two consecutive polls. A batch file that writes the
    // marker and immediately exits must not be allowed to tear down PM2.
    if (fileExists(handoffPath)) {
      if (handoffSeen) return;
      handoffSeen = true;
    } else {
      handoffSeen = false;
    }
    await sleep(pollIntervalMs);
  }
  throw new Error(`Windows upgrade launcher did not confirm handoff within ${timeoutMs}ms`);
}

/**
 * Launch the detached Windows updater and confirm that its handoff marker
 * remains present before the caller stops PM2 or exits.
 */
export async function launchWindowsUpgradeScript({
  nodePath,
  runnerPath,
  payloadPath,
  logPath,
  handoffPath,
  spawnProcess,
  fileExists = existsSync,
  removeFile = path => rmSync(path, { force: true }),
  sleep = delay,
  timeoutMs = 5000,
  pollIntervalMs = 50,
  onHandoff,
}) {
  if (typeof spawnProcess !== 'function') throw new TypeError('spawnProcess is required');
  if (!handoffPath) throw new TypeError('handoffPath is required');

  const invocation = buildWindowsUpgradeInvocation({ nodePath, runnerPath, payloadPath, logPath });
  let child;
  try {
    child = spawnProcess(invocation.command, invocation.args, invocation.options);
  } catch (err) {
    throw new Error(`Windows upgrade launcher failed: ${err.message}`, { cause: err });
  }

  let childError = null;
  const onChildError = err => { childError = err; };
  child.on('error', onChildError);
  try {
    await waitForSpawn(child);
    await waitForUpgradeHandoff({
      handoffPath,
      child,
      fileExists,
      sleep,
      timeoutMs,
      pollIntervalMs,
      getChildError: () => childError,
    });
    await onHandoff?.();
  } catch (err) {
    try { child.kill(); } catch {}
    try { removeFile(handoffPath); } catch {}
    if (childError === err) {
      throw new Error(`Windows upgrade launcher failed: ${err.message}`, { cause: err });
    }
    throw err;
  } finally {
    child.removeListener('error', onChildError);
  }

  child.unref();
  return nodePath;
}

/** Build the URL used by the startup-only update notification. */
export function buildUpgradeMetadataUrl(packageName) {
  return `${DEFAULT_UPGRADE_REGISTRY}${encodeURIComponent(packageName)}/latest`;
}
