import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runProcess } from '../yeaft/tools/process-runner.js';

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const WINDOWS_JOB_SCRIPT = join(MODULE_DIR, 'windows-version-job.ps1');
const WINDOWS_WORKER = join(MODULE_DIR, 'windows-version-worker.js');
const DEFAULT_WINDOWS_CLEANUP_MS = 500;

export function resolveWindowsPowerShell({ env = process.env, fileExists = existsSync } = {}) {
  const systemRoot = env.SystemRoot || env.WINDIR || 'C:\\Windows';
  const candidates = [
    join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    'powershell.exe',
  ];
  return candidates.find(candidate => candidate === 'powershell.exe' || fileExists(candidate));
}

function remaining(deadline, fallback) {
  if (!Number.isFinite(deadline)) return fallback;
  return Math.max(1, deadline - Date.now());
}

export async function readWindowsBrowserExecutableVersion(executablePath, {
  signal = null,
  terminationDeadline = null,
  run = runProcess,
  powershellPath = resolveWindowsPowerShell(),
  nodePath = process.execPath,
  workerPath = WINDOWS_WORKER,
  jobScriptPath = WINDOWS_JOB_SCRIPT,
  env = process.env,
} = {}) {
  const cleanupMs = Number.isFinite(terminationDeadline)
    ? Math.min(DEFAULT_WINDOWS_CLEANUP_MS, remaining(terminationDeadline, DEFAULT_WINDOWS_CLEANUP_MS))
    : DEFAULT_WINDOWS_CLEANUP_MS;
  const timeoutMs = remaining(terminationDeadline, 20_000);
  const result = await run(powershellPath, [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    jobScriptPath,
    '-NodePath',
    nodePath,
    '-WorkerPath',
    workerPath,
    '-ExecutablePath',
    executablePath,
    '-CleanupTimeoutMs',
    String(cleanupMs),
  ], {
    signal,
    timeoutMs,
    maxBytes: 128 * 1024,
    env,
    killGraceMs: 0,
    gracefulTerminationDeadline: terminationDeadline,
    terminationDeadline,
    forceSettleMs: cleanupMs,
    treeKillTimeoutMs: cleanupMs,
    requireExitConfirmation: true,
  });
  if (result.code !== 0) {
    const termination = result.terminationError ? ` ${result.terminationError}` : '';
    throw new Error(`Managed Chrome version job failed (${result.code}): ${result.stderr.slice(0, 500)}${termination}`);
  }

  const line = result.stdout.trim().split(/\r?\n/).at(-1);
  let payload;
  try {
    payload = JSON.parse(line);
  } catch {
    throw new Error(`Managed Chrome version job returned invalid output: ${result.stdout.slice(0, 500)}`);
  }
  if (!payload?.ok) throw new Error(`Managed Chrome version check failed: ${payload?.error || 'unknown worker error'}`);
  if (payload.code !== 0) {
    throw new Error(`Managed Chrome version check failed (${payload.code}): ${String(payload.stderr || '').slice(0, 200)}`);
  }
  if (payload.truncated) throw new Error('Managed Chrome version output exceeded its bounded capture');
  return String(payload.stdout || '').trim();
}
