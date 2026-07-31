import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

const DEFAULT_MAX_BYTES = 512 * 1024;

/**
 * Execute a binary directly without a shell and keep captured output bounded.
 *
 * @param {string} command
 * @param {string[]} args
 * @param {{ cwd?: string, signal?: AbortSignal, timeoutMs?: number, maxBytes?: number, env?: NodeJS.ProcessEnv }} [options]
 */
export function runProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const maxBytes = Number.isFinite(options.maxBytes)
      ? Math.max(0, options.maxBytes)
      : DEFAULT_MAX_BYTES;
    const proc = spawn(command, args, {
      cwd: options.cwd,
      env: options.env || process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let truncated = false;
    let settled = false;
    let timedOut = false;
    let timer = null;

    const stop = () => {
      try { proc.kill('SIGTERM'); } catch {}
    };
    const onAbort = () => stop();
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
    const decode = chunks => new StringDecoder('utf8')
      .end(Buffer.concat(chunks))
      .replaceAll('\ufffd', '?')
      .replace(/\r/g, '');
    const finish = result => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      resolve(result);
    };

    proc.stdout.on('data', chunk => capture(stdout, chunk, true));
    proc.stderr.on('data', chunk => capture(stderr, chunk, false));
    proc.on('error', error => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      reject(error);
    });
    proc.on('close', code => finish({
      code: timedOut ? 124 : (code ?? 1),
      stdout: decode(stdout),
      stderr: decode(stderr),
      truncated,
      timedOut,
    }));

    if (Number.isFinite(options.timeoutMs) && options.timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        stop();
      }, options.timeoutMs);
      timer.unref?.();
    }
    options.signal?.addEventListener('abort', onAbort, { once: true });
  });
}
