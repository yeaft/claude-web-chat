#!/usr/bin/env node

import { mkdtemp, rm, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = resolve(import.meta.dirname, '..');
const composeFile = join(root, 'deploy/browser-turn/docker-compose.yaml');
const project = `yeaft-turn-smoke-${process.pid}`;
const container = `${project}-container`;
const sandbox = await mkdtemp(join(tmpdir(), 'yeaft-turn-smoke-'));
const envFile = join(sandbox, '.env');
const secretFile = join(sandbox, 'turn.secret');

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    timeout: options.timeout ?? 30_000,
    ...options,
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed (${result.status}):\n${result.stdout || ''}${result.stderr || ''}`);
  }
  return result.stdout.trim();
}

function compose(args, options = {}) {
  return run('docker', ['compose', '--project-name', project, '--env-file', envFile, '-f', composeFile, ...args], options);
}

try {
  const secret = '0123456789abcdef'.repeat(4);
  await writeFile(secretFile, `${secret}\n`, { mode: 0o600 });
  await chmod(secretFile, 0o600);
  await writeFile(envFile, [
    `BROWSER_TURN_CONTAINER=${container}`,
    'BROWSER_TURN_EXTERNAL_IP=127.0.0.1',
    'BROWSER_TURN_RELAY_IP=127.0.0.1',
    'BROWSER_TURN_REALM=turn.test',
    `BROWSER_TURN_SECRET_FILE=${secretFile}`,
    'BROWSER_TURN_LISTEN_PORT=4478',
    'BROWSER_TURN_MIN_PORT=49260',
    'BROWSER_TURN_MAX_PORT=49270',
    '',
  ].join('\n'), { mode: 0o600 });

  compose(['config', '--quiet']);
  compose(['up', '-d'], { timeout: 120_000 });
  let health = 'starting';
  for (let attempt = 0; attempt < 20; attempt += 1) {
    health = run('docker', ['inspect', '-f', '{{.State.Health.Status}}', container]);
    if (health === 'healthy') break;
    if (health === 'unhealthy') {
      const healthLog = run('docker', ['inspect', container, '--format', '{{json .State.Health}}']);
      const containerLog = run('docker', ['logs', container]);
      throw new Error(`TURN container unhealthy:\nhealth=${healthLog}\nlogs=${containerLog}`);
    }
    await new Promise(resolveDelay => setTimeout(resolveDelay, 1_000));
  }
  if (health !== 'healthy') {
    const healthLog = run('docker', ['inspect', container, '--format', '{{json .State.Health}}']);
    const containerLog = run('docker', ['logs', container]);
    throw new Error(`TURN container did not become healthy:\nhealth=${healthLog}\nlogs=${containerLog}`);
  }

  const processStatus = run('docker', ['exec', container, 'sh', '-c',
    "awk '/^Uid:|^Gid:|^CapEff:|^NoNewPrivs:/ {print}' /proc/1/status"]);
  if (!/^Uid:\s+65534\s+65534\s+65534\s+65534$/m.test(processStatus)) {
    throw new Error(`TURN did not drop to uid 65534:\n${processStatus}`);
  }
  if (!/^CapEff:\s+0+$/m.test(processStatus)) throw new Error(`TURN retained effective capabilities:\n${processStatus}`);
  if (!/^NoNewPrivs:\s+1$/m.test(processStatus)) throw new Error(`TURN lacks no-new-privileges:\n${processStatus}`);

  const args = run('docker', ['inspect', container, '--format', '{{json .Args}}']);
  if (args.includes(secret)) throw new Error('TURN secret leaked into container argv');
  run('docker', ['exec', container, 'turnutils_stunclient', '-p', '4478', '127.0.0.1']);
  run('docker', ['exec', container, 'turnutils_uclient',
    '-W', secret, '-I', '-Y', 'alloc', '-n', '1', '-p', '4478', '127.0.0.1']);
  console.log(`Browser TURN smoke passed: health=${health}; REST-authenticated allocation, uid/capability fence, and service argv secret isolation verified.`);
} finally {
  try { compose(['down', '--remove-orphans'], { timeout: 60_000 }); } catch {}
  await rm(sandbox, { recursive: true, force: true });
}
