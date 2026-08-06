#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const uid = process.getuid?.();
const gid = process.getgid?.();
const separator = process.argv.indexOf('--');
const command = separator >= 0 ? process.argv[separator + 1] : null;
const args = separator >= 0 ? process.argv.slice(separator + 2) : [];
const unsharePath = process.env.YEAFT_UNSHARE_PATH || '/usr/bin/unshare';

if (!Number.isSafeInteger(uid) || !Number.isSafeInteger(gid) || !command) {
  console.error('linux-process-namespace requires a POSIX uid/gid and a command after --');
  process.exit(126);
}

// The child creates user + PID namespaces, then blocks before exec. The parent
// writes same-uid mappings through /proc while it still owns the new user
// namespace. A small init process remains PID 1 so the user shell keeps normal
// signal semantics while namespace teardown remains an unescapable kill boundary.
const initScript = [
  'printf ready >&3',
  'IFS= read -r _ <&4',
  '"$@" & child=$!',
  'term() { kill -TERM "$child" 2>/dev/null; }',
  'trap term TERM INT HUP',
  'while kill -0 "$child" 2>/dev/null; do wait "$child"; rc=$?; done',
  'exit "${rc:-1}"',
].join('; ');
const child = spawn(unsharePath, [
  '--user',
  '--pid',
  '--fork',
  '--kill-child=SIGKILL',
  '--',
  'sh',
  '-c',
  initScript,
  'yeaft-namespace-init',
  command,
  ...args,
], {
  stdio: ['ignore', 'inherit', 'inherit', 'pipe', 'pipe'],
  env: process.env,
  cwd: process.cwd(),
});

let started = false;
const fail = (error) => {
  if (started) return;
  started = true;
  console.error(`Unable to create an isolated process namespace: ${error.message}`);
  try { child.kill('SIGKILL'); } catch {}
  process.exitCode = 126;
};

child.stdio[3].once('data', () => {
  if (started) return;
  try {
    const pid = child.pid;
    try { writeFileSync(`/proc/${pid}/setgroups`, 'deny\n'); } catch {}
    writeFileSync(`/proc/${pid}/uid_map`, `${uid} ${uid} 1\n`);
    writeFileSync(`/proc/${pid}/gid_map`, `${gid} ${gid} 1\n`);
    const uidMap = readFileSync(`/proc/${pid}/uid_map`, 'utf8');
    const gidMap = readFileSync(`/proc/${pid}/gid_map`, 'utf8');
    if (!uidMap.includes(`${uid}`) || !gidMap.includes(`${gid}`)) {
      throw new Error('uid/gid namespace mapping was not applied');
    }
    started = true;
    child.stdio[4].end('go\n');
  } catch (error) {
    fail(error);
  }
});
child.once('error', fail);

const forward = (signal) => {
  try { child.kill(signal); } catch {}
};
process.on('SIGTERM', () => {
  forward('SIGTERM');
  setTimeout(() => forward('SIGKILL'), 200);
});
process.on('SIGINT', () => forward('SIGINT'));
process.on('SIGHUP', () => forward('SIGHUP'));
child.once('close', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exitCode = code ?? 1;
});
