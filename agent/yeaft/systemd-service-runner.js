#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';

const payloadPath = process.argv[2];
let payload;
try {
  if (!payloadPath) throw new Error('missing invocation payload path');
  payload = JSON.parse(readFileSync(payloadPath, 'utf8'));
  if (!payload || typeof payload.command !== 'string' || !Array.isArray(payload.args)) {
    throw new Error('invalid invocation payload');
  }
} catch (error) {
  console.error(`Unable to read systemd service command: ${error.message}`);
  process.exit(126);
} finally {
  if (payloadPath) rmSync(dirname(payloadPath), { recursive: true, force: true });
}

const child = spawn(payload.command, payload.args, {
  cwd: payload.cwd || process.cwd(),
  env: payload.env || process.env,
  stdio: 'inherit',
});
const forward = signal => {
  try { child.kill(signal); } catch {}
};
process.on('SIGTERM', () => forward('SIGTERM'));
process.on('SIGINT', () => forward('SIGINT'));
process.on('SIGHUP', () => forward('SIGHUP'));
child.once('error', error => {
  console.error(error.message);
  process.exitCode = 126;
});
child.once('close', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exitCode = code ?? 1;
});
