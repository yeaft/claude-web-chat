import { existsSync, unlinkSync } from 'node:fs';
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
export function buildUpgradeInstallArgs(packageSpec, { global = true } = {}) {
  return [
    'install',
    ...(global ? ['-g'] : []),
    packageSpec,
    `--registry=${DEFAULT_UPGRADE_REGISTRY}`,
  ];
}

/** Build argv for updating an installed package through the Yeaft registry. */
export function buildUpgradeUpdateArgs(packageName, { global = true } = {}) {
  return [
    'update',
    ...(global ? ['-g'] : []),
    packageName,
    `--registry=${DEFAULT_UPGRADE_REGISTRY}`,
  ];
}

/** Build the npm metadata command used by `yeaft-agent upgrade`. */
export function buildUpgradeVersionCommand(packageName) {
  return ['npm', ...buildUpgradeMetadataArgs(packageName, 'version')].join(' ');
}

/** Build an npm install command against the Yeaft registry. */
export function buildUpgradeInstallCommand(packageSpec, options) {
  return ['npm', ...buildUpgradeInstallArgs(packageSpec, options)].join(' ');
}

/** Build the npm update command used after a Windows Agent has exited. */
export function buildUpgradeUpdateCommand(packageName) {
  return ['npm', ...buildUpgradeUpdateArgs(packageName)].join(' ');
}

function quoteCmdPath(path) {
  return `"${String(path).replace(/"/g, '""')}"`;
}

/**
 * Build the exact CreateProcess contract for a batch file path. cmd.exe needs
 * the full command string quoted once; windowsVerbatimArguments prevents Node
 * from escaping those quotes a second time when the path contains spaces.
 */
export function buildWindowsUpgradeInvocation(batPath) {
  return {
    command: 'cmd.exe',
    args: ['/d', '/s', '/c', quoteCmdPath(batPath)],
    options: {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      windowsVerbatimArguments: true,
    },
  };
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
 * Launch the detached Windows updater and wait for the batch script itself to
 * confirm execution before the caller stops PM2 or exits. `spawn` only proves
 * that cmd.exe was created; the handoff file proves the updater took control.
 */
export async function launchWindowsUpgradeScript({
  batPath,
  handoffPath,
  spawnProcess,
  fileExists = existsSync,
  removeFile = unlinkSync,
  sleep = delay,
  timeoutMs = 5000,
  pollIntervalMs = 50,
  onHandoff,
}) {
  if (typeof spawnProcess !== 'function') throw new TypeError('spawnProcess is required');
  if (!handoffPath) throw new TypeError('handoffPath is required');

  try { removeFile(handoffPath); } catch (err) {
    if (err?.code !== 'ENOENT') throw err;
  }

  const invocation = buildWindowsUpgradeInvocation(batPath);
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
  return 'cmd.exe';
}

/** Build the URL used by the startup-only update notification. */
export function buildUpgradeMetadataUrl(packageName) {
  return `${DEFAULT_UPGRADE_REGISTRY}${encodeURIComponent(packageName)}/latest`;
}
