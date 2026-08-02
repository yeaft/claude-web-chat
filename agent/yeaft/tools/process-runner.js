import { spawn, spawnSync } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

const DEFAULT_MAX_BYTES = 512 * 1024;
const DEFAULT_KILL_GRACE_MS = 250;
const DEFAULT_FORCE_SETTLE_MS = 1000;

export class ProcessTerminationError extends Error {
  constructor(command, forceSettleMs) {
    super(`Process did not exit within ${forceSettleMs}ms after SIGKILL: ${command}`);
    this.name = 'ProcessTerminationError';
    this.command = command;
    this.forceSettleMs = forceSettleMs;
  }
}

function abortError(signal) {
  if (signal?.reason instanceof Error && signal.reason.name === 'AbortError') return signal.reason;
  const error = new Error(
    signal?.reason instanceof Error ? signal.reason.message : 'The operation was aborted',
  );
  error.name = 'AbortError';
  return error;
}

function killProcessTree(proc, signal, platform, spawnProcessSync) {
  if (!proc.pid) return false;
  if (platform === 'win32') {
    try {
      const result = spawnProcessSync('taskkill', ['/pid', String(proc.pid), '/t', '/f'], {
        stdio: 'ignore',
        windowsHide: true,
        timeout: 5000,
      });
      if (!result.error && result.status === 0) return true;
    } catch {}
    try { return proc.kill(signal) !== false; } catch { return false; }
  }
  try {
    process.kill(-proc.pid, signal);
    return true;
  } catch {
    try { return proc.kill(signal) !== false; } catch { return false; }
  }
}

/**
 * Execute a binary directly without a shell and keep captured output bounded.
 *
 * @param {string} command
 * @param {string[]} args
 * @param {{ cwd?: string, signal?: AbortSignal, timeoutMs?: number, maxBytes?: number, env?: NodeJS.ProcessEnv, preserveCarriageReturns?: boolean, killGraceMs?: number, forceSettleMs?: number, requireExitConfirmation?: boolean, platform?: NodeJS.Platform, spawnProcess?: typeof spawn, spawnProcessSync?: typeof spawnSync }} [options]
 */
export function runProcess(command, args, options = {}) {
  if (options.signal?.aborted) return Promise.reject(abortError(options.signal));

  return new Promise((resolve, reject) => {
    const platform = options.platform || process.platform;
    const spawnProcess = options.spawnProcess || spawn;
    const spawnProcessSync = options.spawnProcessSync || spawnSync;
    const maxBytes = Number.isFinite(options.maxBytes)
      ? Math.max(0, options.maxBytes)
      : DEFAULT_MAX_BYTES;
    const killGraceMs = Number.isFinite(options.killGraceMs)
      ? Math.max(0, options.killGraceMs)
      : DEFAULT_KILL_GRACE_MS;
    const forceSettleMs = Number.isFinite(options.forceSettleMs)
      ? Math.max(1, options.forceSettleMs)
      : DEFAULT_FORCE_SETTLE_MS;
    const proc = spawnProcess(command, args, {
      cwd: options.cwd,
      env: options.env || process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      detached: platform !== 'win32',
    });
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let truncated = false;
    let settled = false;
    let timedOut = false;
    let aborted = false;
    let stopRequested = false;
    let forceRequested = false;
    let timer = null;
    let forceTimer = null;
    let forceSettleTimer = null;

    let onStdout;
    let onStderr;
    let onError;
    let onClose;
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      if (forceTimer) clearTimeout(forceTimer);
      if (forceSettleTimer) clearTimeout(forceSettleTimer);
      timer = null;
      forceTimer = null;
      forceSettleTimer = null;
      options.signal?.removeEventListener('abort', onAbort);
      if (onStdout) proc.stdout?.off('data', onStdout);
      if (onStderr) proc.stderr?.off('data', onStderr);
      if (onError) proc.off('error', onError);
      if (onClose) proc.off('close', onClose);
    };
    const decode = (chunks, wasTruncated, preserveCarriageReturns = false) => {
      const decoder = new StringDecoder('utf8');
      let value = decoder.write(Buffer.concat(chunks));
      if (!wasTruncated) value += decoder.end();
      return preserveCarriageReturns ? value : value.replace(/\r/g, '');
    };
    const finish = (code, error = null) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) {
        reject(error);
        return;
      }
      if (aborted) {
        reject(abortError(options.signal));
        return;
      }
      resolve({
        code: timedOut ? 124 : (code ?? 1),
        stdout: decode(stdout, stdoutTruncated, options.preserveCarriageReturns),
        stderr: decode(stderr, stderrTruncated),
        truncated,
        timedOut,
      });
    };
    const forceStop = () => {
      if (settled || forceRequested) return;
      forceRequested = true;
      killProcessTree(proc, 'SIGKILL', platform, spawnProcessSync);
      forceSettleTimer = setTimeout(() => {
        finish(
          null,
          options.requireExitConfirmation
            ? new ProcessTerminationError(command, forceSettleMs)
            : null,
        );
      }, forceSettleMs);
      forceSettleTimer.unref?.();
    };
    const stop = () => {
      if (settled || stopRequested) return;
      stopRequested = true;
      if (platform === 'win32') {
        // taskkill must run while the parent PID still identifies the tree.
        // It is already forceful, so do not wait for the direct child to exit.
        forceRequested = true;
        killProcessTree(proc, 'SIGKILL', platform, spawnProcessSync);
        if (!settled) {
          forceSettleTimer = setTimeout(() => {
            finish(
              null,
              options.requireExitConfirmation
                ? new ProcessTerminationError(command, forceSettleMs)
                : null,
            );
          }, forceSettleMs);
          forceSettleTimer.unref?.();
        }
        return;
      }
      killProcessTree(proc, 'SIGTERM', platform, spawnProcessSync);
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
        if (isStdout) stdoutTruncated = true;
        else stderrTruncated = true;
        stop();
        return;
      }
      const bounded = buffer.length > remaining ? buffer.subarray(0, remaining) : buffer;
      target.push(bounded);
      if (isStdout) stdoutBytes += bounded.length;
      else stderrBytes += bounded.length;
      if (bounded.length !== buffer.length) {
        truncated = true;
        if (isStdout) stdoutTruncated = true;
        else stderrTruncated = true;
        stop();
      }
    };

    onStdout = chunk => capture(stdout, chunk, true);
    onStderr = chunk => capture(stderr, chunk, false);
    onError = error => {
      if (settled) return;
      if (stopRequested) {
        finish(null);
        return;
      }
      settled = true;
      cleanup();
      reject(error);
    };
    onClose = code => {
      if (stopRequested && !forceRequested) {
        // The direct child is gone. Kill any process that remained in its
        // detached group before releasing the tool call.
        forceRequested = true;
        killProcessTree(proc, 'SIGKILL', platform, spawnProcessSync);
      }
      finish(code);
    };
    proc.stdout.on('data', onStdout);
    proc.stderr.on('data', onStderr);
    proc.on('error', onError);
    proc.on('close', onClose);

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
