#!/usr/bin/env node

import { spawn } from 'node:child_process';

let invocation;
try {
  const encoded = process.env.YEAFT_SYSTEMD_INVOCATION;
  if (!encoded) throw new Error('missing YEAFT_SYSTEMD_INVOCATION');
  invocation = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  if (!Array.isArray(invocation) || typeof invocation[0] !== 'string') {
    throw new Error('invalid encoded invocation');
  }
} catch (error) {
  console.error(`Unable to decode systemd service command: ${error.message}`);
  process.exit(126);
}

const child = spawn(invocation[0], Array.isArray(invocation[1]) ? invocation[1] : [], {
  cwd: process.cwd(),
  env: process.env,
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
