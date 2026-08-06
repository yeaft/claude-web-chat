import { appendFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

function appendLog(logPath, message) {
  if (!logPath) return;
  try {
    appendFileSync(logPath, `[Upgrade] ${message}\n`);
  } catch {}
}

/**
 * Spawn the real updater from a short-lived intermediate process. Once this
 * bootstrap exits, the updater is no longer in the live process tree rooted at
 * the PM2-managed Agent, so PM2's Windows tree kill cannot terminate it.
 */
export function spawnWindowsUpgradeRunner({
  nodePath,
  runnerPath,
  payloadPath,
  logPath,
}, spawnProcess = spawn) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnProcess(nodePath, [runnerPath, payloadPath], {
        // Never inherit the Agent's package cwd. Windows will otherwise keep
        // that directory locked while npm tries to replace it.
        cwd: dirname(runnerPath),
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        env: { ...process.env, YEAFT_UPGRADE_LOG: logPath },
      });
    } catch (err) {
      reject(err);
      return;
    }

    const onError = err => {
      child.removeListener('spawn', onSpawn);
      reject(err);
    };
    const onSpawn = () => {
      child.removeListener('error', onError);
      child.unref();
      resolve(child.pid);
    };
    child.once('error', onError);
    child.once('spawn', onSpawn);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [runnerPath, payloadPath] = process.argv.slice(2);
  const logPath = process.env.YEAFT_UPGRADE_LOG;
  try {
    if (!runnerPath || !payloadPath) throw new Error('runner path and payload path are required');
    const runnerPid = await spawnWindowsUpgradeRunner({
      nodePath: process.execPath,
      runnerPath,
      payloadPath,
      logPath,
    });
    appendLog(logPath, `Bootstrap launched updater PID ${runnerPid}`);
  } catch (err) {
    appendLog(logPath, `Bootstrap failed: ${err?.stack || err}`);
    process.exitCode = 1;
  }
}
