import { spawn, spawnSync } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

const DEFAULT_MAX_BYTES = 512 * 1024;
const DEFAULT_KILL_GRACE_MS = 250;
const DEFAULT_FORCE_SETTLE_MS = 1000;

function abortError(signal) {
  if (signal?.reason instanceof Error) return signal.reason;
  const error = new Error('The operation was aborted');
  error.name = 'AbortError';
  return error;
}

function killProcessTree(proc, signal) {
  if (!proc.pid) return;
  if (process.platform === 'win32') {
    if (signal === 'SIGTERM') {
      try { proc.kill(); } catch {}
      return;
    }
    try {
      spawnSync('taskkill', ['/pid', String(proc.pid), '/t', '/f'], {
        stdio: 'ignore',
        windowsHide: true,
        timeout: 5000,
      });
    } catch {}
    return;
  }
  try {
    process.kill(-proc.pid, signal);
  } catch {
    try { proc.kill(signal); } catch {}
  }
}

/**
 * Execute a binary directly without a shell and keep captured output bounded.
 *
 * @param {string} command
 * @param {string[]} args
 * @param {{ cwd?: string, signal?: AbortSignal, timeoutMs?: number, maxBytes?: number, env?: NodeJS.ProcessEnv, killGraceMs?: number, forceSettleMs?: number }} [options]
 */
export function runProcess(command, args, options = {}) {
  if (options.signal?.aborted) return Promise.reject(abortError(options.signal));

  return new Promise((resolve, reject) => {
    const maxBytes = Number.isFinite(options.maxBytes)
      ? Math.max(0, options.maxBytes)
      : DEFAULT_MAX_BYTES;
    const killGraceMs = Number.isFinite(options.killGraceMs)
      ? Math.max(0, options.killGraceMs)
      : DEFAULT_KILL_GRACE_MS;
    const forceSettleMs = Number.isFinite(options.forceSettleMs)
      ? Math.max(1, options.forceSettleMs)
      : DEFAULT_FORCE_SETTLE_MS;
    const proc = spawn(command, args, {
      cwd: options.cwd,
      env: options.env || process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      detached: process.platform !== 'win32',
    });
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let truncated = false;
    let settled = false;
    let timedOut = false;
    let aborted = false;
    let stopRequested = false;
    let forceRequested = false;
    let timer = null;
    let forceTimer = null;
    let forceSettleTimer = null;

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      if (forceTimer) clearTimeout(forceTimer);
      if (forceSettleTimer) clearTimeout(forceSettleTimer);
      options.signal?.removeEventListener('abort', onAbort);
    };
    const decode = chunks => new StringDecoder('utf8')
      .end(Buffer.concat(chunks))
      .replaceAll('\ufffd', '?')
      .replace(/\r/g, '');
    const finish = code => {
      if (settled) return;
      settled = true;
      cleanup();
      if (aborted) {
        reject(abortError(options.signal));
        return;
      }
      resolve({
        code: timedOut ? 124 : (code ?? 1),
        stdout: decode(stdout),
        stderr: decode(stderr),
        truncated,
        timedOut,
      });
    };
    const forceStop = () => {
      if (settled || forceRequested) return;
      forceRequested = true;
      killProcessTree(proc, 'SIGKILL');
      forceSettleTimer = setTimeout(() => finish(null), forceSettleMs);
      forceSettleTimer.unref?.();
    };
    const stop = () => {
      if (settled || stopRequested) return;
      stopRequested = true;
      killProcessTree(proc, 'SIGTERM');
      forceTimer = setTimeout(forceStop, killGraceMs);
      forceTimer.unref?.();
    };
    const onAbort = () => {
      aborted = true;
      stop();
    };
    const capture = (target, chunk, isStdout) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const current = isStdout ? stdoutBytes : stderrBytes;
      const remaining = maxBytes - current;
      if (remaining <= 0) {
        truncated = true;
        stop();
        return;
      }
      const bounded = buffer.length > remaining ? buffer.subarray(0, remaining) : buffer;
      target.push(bounded);
      if (isStdout) stdoutBytes += bounded.length;
      else stderrBytes += bounded.length;
      if (bounded.length !== buffer.length) {
        truncated = true;
        stop();
      }
    };

    proc.stdout.on('data', chunk => capture(stdout, chunk, true));
    proc.stderr.on('data', chunk => capture(stderr, chunk, false));
    proc.on('error', error => {
      if (settled) return;
      if (stopRequested) {
        finish(null);
        return;
      }
      settled = true;
      cleanup();
      reject(error);
    });
    proc.on('close', code => {
      if (stopRequested && !forceRequested) {
        // The direct child is gone. Kill any process that remained in its
        // detached group before releasing the tool call.
        forceRequested = true;
        killProcessTree(proc, 'SIGKILL');
      }
      finish(code);
    });

    if (Number.isFinite(options.timeoutMs) && options.timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        stop();
      }, options.timeoutMs);
      timer.unref?.();
    }
    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.signal?.aborted) onAbort();
  });
}
