#!/usr/bin/env node

import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import {
  buildUpgradeInstallArgs,
  resolveWindowsNpmCliPath,
} from './upgrade-command.js';

const PID_POLL_INTERVAL_MS = 100;
const PID_WAIT_TIMEOUT_MS = 30_000;
const FILE_LOCK_RETRY_MS = [0, 250, 750, 1_500];

function appendLog(logPath, message) {
  try {
    appendFileSync(logPath, `[Upgrade] ${message}\n`);
  } catch {}
}

export function isProcessRunning(pid, probe = process.kill) {
  try {
    probe(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

export async function waitForProcessExit(pid, {
  timeoutMs = PID_WAIT_TIMEOUT_MS,
  pollIntervalMs = PID_POLL_INTERVAL_MS,
  processRunning = isProcessRunning,
  sleep = delay,
  now = Date.now,
} = {}) {
  const deadline = now() + timeoutMs;
  while (processRunning(pid)) {
    if (now() >= deadline) return false;
    await sleep(pollIntervalMs);
  }
  return true;
}

function runProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const { onStderr, ...spawnOptions } = options;
    const child = spawn(command, args, spawnOptions);
    if (typeof onStderr === 'function') child.stderr?.on('data', onStderr);
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (signal) reject(new Error(`${command} exited with signal ${signal}`));
      else resolve(code ?? 1);
    });
  });
}

function isRetryableWindowsInstallFailure(code, stderr) {
  if (code === 0) return false;
  return /\b(EBUSY|EPERM|EACCES)\b|resource busy|operation not permitted|permission denied/iu.test(stderr);
}

export async function installWindowsUpgrade({
  nodePath,
  npmCliPath,
  packageSpec,
  globalInstall,
  installDir,
  logPath,
  run = runProcess,
  sleep = delay,
  fileExists,
}) {
  const resolvedNpmCliPath = npmCliPath || resolveWindowsNpmCliPath(nodePath, fileExists);
  if (!resolvedNpmCliPath) throw new Error('npm JavaScript CLI entry point could not be resolved');
  const command = nodePath;
  const args = [
    resolvedNpmCliPath,
    ...buildUpgradeInstallArgs(packageSpec, { global: globalInstall, quiet: true }),
  ];
  const cwd = globalInstall ? process.env.TEMP : installDir;

  for (let attempt = 0; attempt < FILE_LOCK_RETRY_MS.length; attempt++) {
    const retryDelayMs = FILE_LOCK_RETRY_MS[attempt];
    if (retryDelayMs) {
      appendLog(logPath, `Retrying npm install after ${retryDelayMs}ms file-lock delay`);
      await sleep(retryDelayMs);
    }

    let stderr = '';
    const exitCode = await run(command, args, {
      cwd,
      env: process.env,
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe'],
      onStderr: chunk => { stderr += String(chunk); },
    });
    if (exitCode === 0) return { exitCode, attempts: attempt + 1, command, args };
    if (!isRetryableWindowsInstallFailure(exitCode, stderr) || attempt === FILE_LOCK_RETRY_MS.length - 1) {
      if (stderr.trim()) appendLog(logPath, `npm stderr: ${stderr.trim()}`);
      return { exitCode, attempts: attempt + 1, command, args };
    }
  }

  return { exitCode: 1, attempts: FILE_LOCK_RETRY_MS.length, command, args };
}

export async function stopPm2Service({ nodePath, pm2CliPath, pm2AppName, logPath, run = runProcess }) {
  if (!pm2CliPath || !pm2AppName) return true;
  appendLog(logPath, `Removing PM2 app ${pm2AppName} before install`);
  const deleteCode = await run(nodePath, [pm2CliPath, 'delete', pm2AppName], {
    env: process.env,
    windowsHide: true,
    stdio: 'ignore',
  });
  return deleteCode === 0;
}

export async function startPm2Service({ nodePath, pm2CliPath, ecosystemPath, logPath, run = runProcess }) {
  if (!pm2CliPath || !ecosystemPath) return true;
  appendLog(logPath, 'Re-registering Agent via PM2');
  const startCode = await run(nodePath, [pm2CliPath, 'start', ecosystemPath], {
    env: process.env,
    windowsHide: true,
    stdio: 'ignore',
  });
  if (startCode !== 0) return false;
  const saveCode = await run(nodePath, [pm2CliPath, 'save'], {
    env: process.env,
    windowsHide: true,
    stdio: 'ignore',
  });
  return saveCode === 0;
}

function removeTransientFiles(handoffPath, payloadPath, cancelPath) {
  for (const path of [handoffPath, payloadPath, cancelPath]) {
    try { rmSync(path, { force: true }); } catch {}
  }
}

/**
 * Wait for the original Agent to exit, remove its PM2 registration, install the
 * exact package version, and restore the selected PM2 instance. Every process
 * invocation is shell-free.
 */
export async function runWindowsUpgrade(options, dependencies = {}) {
  const {
    parentPid,
    packageSpec,
    globalInstall,
    installDir,
    logPath,
    handoffPath,
    cancelPath,
    bootstrapPath,
    runnerPath,
    commandPath,
    payloadPath,
    nodePath,
    npmCliPath,
    pm2CliPath,
    pm2AppName,
    ecosystemPath,
  } = options;
  const wait = dependencies.waitForProcessExit || waitForProcessExit;
  const install = dependencies.installWindowsUpgrade || installWindowsUpgrade;
  const stopService = dependencies.stopPm2Service || stopPm2Service;
  const startService = dependencies.startPm2Service || startPm2Service;
  const cleanupPaths = [bootstrapPath, runnerPath, commandPath];

  mkdirSync(dirname(handoffPath), { recursive: true });
  if (cancelPath && existsSync(cancelPath)) {
    appendLog(logPath, 'Upgrade was cancelled before handoff; refusing to modify the installation');
    removeTransientFiles(handoffPath, payloadPath, cancelPath);
    return { exitCode: 1, restarted: false, cleanupPaths };
  }
  writeFileSync(handoffPath, JSON.stringify({ runnerPid: process.pid, startedAt: Date.now() }));
  appendLog(logPath, `Started at ${new Date().toISOString()}`);
  appendLog(logPath, `Waiting for PID ${parentPid} to exit`);
  const exited = await wait(parentPid);
  if (!exited) {
    appendLog(logPath, `Timed out waiting for PID ${parentPid}; refusing to modify a live installation`);
    removeTransientFiles(handoffPath, payloadPath, cancelPath);
    return { exitCode: 1, restarted: false, cleanupPaths };
  }
  appendLog(logPath, 'Original process exited');
  if (cancelPath && existsSync(cancelPath)) {
    appendLog(logPath, 'Upgrade was cancelled during handoff; refusing to modify the installation');
    removeTransientFiles(handoffPath, payloadPath, cancelPath);
    return { exitCode: 1, restarted: false, cleanupPaths };
  }

  let stopped = false;
  try {
    stopped = await stopService({ nodePath, pm2CliPath, pm2AppName, logPath });
  } catch (err) {
    appendLog(logPath, `PM2 app removal failed: ${err?.message || err}`);
  }
  if (!stopped) {
    appendLog(logPath, `PM2 app ${pm2AppName} could not be removed; refusing to install`);
    let restored = false;
    try {
      restored = await startService({ nodePath, pm2CliPath, ecosystemPath, logPath });
    } catch (err) {
      appendLog(logPath, `WARNING: PM2 recovery failed: ${err?.message || err}`);
    }
    if (!restored) appendLog(logPath, 'WARNING: PM2 service was not restored after removal failure');
    removeTransientFiles(handoffPath, payloadPath, cancelPath);
    return { exitCode: 1, restarted: restored, cleanupPaths };
  }

  let result;
  try {
    result = await install({ nodePath, npmCliPath, packageSpec, globalInstall, installDir, logPath });
  } catch (err) {
    appendLog(logPath, `npm install failed to start: ${err?.message || err}`);
    result = { exitCode: 1, attempts: 0 };
  }
  appendLog(logPath, `npm install ${result.exitCode === 0 ? 'succeeded' : `failed with exit code ${result.exitCode}`} after ${result.attempts} attempt(s)`);

  let restarted = false;
  try {
    restarted = await startService({ nodePath, pm2CliPath, ecosystemPath, logPath });
  } catch (err) {
    appendLog(logPath, `WARNING: PM2 service restart failed: ${err?.message || err}`);
  }
  if (!restarted) appendLog(logPath, 'WARNING: PM2 service was not restarted');
  appendLog(logPath, `Finished at ${new Date().toISOString()}`);

  removeTransientFiles(handoffPath, payloadPath, cancelPath);
  return { exitCode: result.exitCode, restarted, cleanupPaths };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let payload;
  try {
    payload = JSON.parse(readFileSync(process.argv[2], 'utf8'));
    const result = await runWindowsUpgrade(payload);
    process.exitCode = result.exitCode;
  } catch (err) {
    const logPath = payload?.logPath || process.env.YEAFT_UPGRADE_LOG;
    if (logPath) appendLog(logPath, `Runner failed: ${err?.stack || err}`);
    process.exitCode = 1;
  }
}
