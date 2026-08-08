import { spawn } from 'node:child_process';

const MAX_OUTPUT_BYTES = 64 * 1024;

function writeResult(result) {
  process.stdout.write(`${JSON.stringify(result)}\n`, () => process.exit(0));
}

function capture(chunks, chunk, state) {
  const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  const remaining = MAX_OUTPUT_BYTES - state.bytes;
  if (remaining <= 0) {
    state.truncated = true;
    return;
  }
  const bounded = buffer.length > remaining ? buffer.subarray(0, remaining) : buffer;
  chunks.push(bounded);
  state.bytes += bounded.length;
  if (bounded.length !== buffer.length) state.truncated = true;
}

function run(executablePath) {
  return new Promise(resolve => {
    let child;
    try {
      child = spawn(executablePath, ['--version'], {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (error) {
      resolve({ ok: false, error: String(error?.message || error) });
      return;
    }
    const stdout = [];
    const stderr = [];
    const stdoutState = { bytes: 0, truncated: false };
    const stderrState = { bytes: 0, truncated: false };
    const stopOnOverflow = state => {
      if (!state.truncated) return;
      try { child.kill('SIGKILL'); } catch {}
    };
    child.stdout.on('data', chunk => {
      capture(stdout, chunk, stdoutState);
      stopOnOverflow(stdoutState);
    });
    child.stderr.on('data', chunk => {
      capture(stderr, chunk, stderrState);
      stopOnOverflow(stderrState);
    });
    let settled = false;
    const finish = result => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    child.once('error', error => finish({ ok: false, error: String(error?.message || error) }));
    child.once('close', code => finish({
      ok: true,
      code: code ?? 1,
      stdout: Buffer.concat(stdout).toString('utf8').replace(/\r/g, ''),
      stderr: Buffer.concat(stderr).toString('utf8').replace(/\r/g, ''),
      truncated: stdoutState.truncated || stderrState.truncated,
    }));
  });
}

let started = false;
process.stdin.setEncoding('utf8');
process.stdin.on('data', async chunk => {
  if (started || !String(chunk).split(/\r?\n/).includes('go')) return;
  started = true;
  const result = await run(process.argv[2]);
  writeResult(result);
});
process.stdin.resume();
