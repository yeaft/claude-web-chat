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
let serviceImageId = null;

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

function expectFailure(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    timeout: options.timeout ?? 30_000,
    ...options,
  });
  if (result.status === 0) throw new Error(`${command} unexpectedly succeeded`);
}

function compose(args, options = {}) {
  return run('docker', ['compose', '--project-name', project, '--env-file', envFile, '-f', composeFile, ...args], options);
}

try {
  const secret = '0123456789abcdef'.repeat(4);
  await writeFile(secretFile, `${secret}\n`, { mode: 0o640 });
  await chmod(secretFile, 0o640);
  await writeFile(envFile, [
    `BROWSER_TURN_CONTAINER=${container}`,
    'BROWSER_TURN_EXTERNAL_IP=127.0.0.1',
    'BROWSER_TURN_RELAY_IP=127.0.0.1',
    'BROWSER_TURN_REALM=turn.test',
    `BROWSER_TURN_SECRET_FILE=${secretFile}`,
    `BROWSER_TURN_SECRET_GID=${process.getgid()}`,
    'BROWSER_TURN_LISTEN_PORT=4478',
    'BROWSER_TURN_MIN_PORT=49260',
    'BROWSER_TURN_MAX_PORT=49270',
    '',
  ].join('\n'), { mode: 0o600 });

  compose(['config', '--quiet']);
  compose(['up', '-d'], { timeout: 120_000 });
  serviceImageId = run('docker', ['inspect', container, '--format', '{{.Image}}']);
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

  const statusFields = '^Uid:|^Gid:|^CapInh:|^CapPrm:|^CapEff:|^CapBnd:|^CapAmb:|^NoNewPrivs:';
  const processStatus = run('docker', ['exec', container, 'sh', '-c',
    `awk '/${statusFields}/ {print}' /proc/1/status`]);
  const healthcheckStatus = run('docker', ['exec', container, 'cat', '/run/yeaft-turn/healthcheck-status']);
  for (const [name, statusText] of [['TURN service', processStatus], ['TURN healthcheck', healthcheckStatus]]) {
    if (!/^Uid:\s+10001\s+10001\s+10001\s+10001$/m.test(statusText)
        || !/^Gid:\s+10001\s+10001\s+10001\s+10001$/m.test(statusText)) {
      throw new Error(`${name} did not run as uid/gid 10001:\n${statusText}`);
    }
    for (const capability of ['CapInh', 'CapPrm', 'CapEff', 'CapBnd', 'CapAmb']) {
      if (!new RegExp(`^${capability}:\\s+0+$`, 'm').test(statusText)) {
        throw new Error(`${name} retained ${capability}:\n${statusText}`);
      }
    }
    if (!/^NoNewPrivs:\s+1$/m.test(statusText)) {
      throw new Error(`${name} lacks no-new-privileges:\n${statusText}`);
    }
  }

  const configUser = run('docker', ['inspect', container, '--format', '{{.Config.User}}']);
  if (configUser !== '10001:10001') throw new Error(`TURN container user is ${configUser}, expected 10001:10001`);
  const inspection = run('docker', ['inspect', container]);
  if (inspection.includes(secret)) throw new Error('TURN secret leaked into container configuration');
  run('docker', ['exec', container, 'turnutils_stunclient', '-p', '4478', '127.0.0.1']);
  expectFailure('docker', ['exec', container, 'turnutils_uclient',
    '-W', 'wrong-secret-for-negative-auth-check', '-I', '-Y', 'alloc', '-n', '1', '-p', '4478', '127.0.0.1']);
  run('docker', ['exec', container, 'turnutils_uclient',
    '-W', secret, '-I', '-Y', 'alloc', '-n', '1', '-p', '4478', '127.0.0.1']);
  console.log(`Browser TURN smoke passed: health=${health}; REST authentication accepts the configured secret and rejects a wrong one; service/healthcheck uid-capability fences and container-config secret isolation verified.`);
} finally {
  try { compose(['down', '--remove-orphans'], { timeout: 60_000 }); } catch {}
  if (serviceImageId) {
    try { run('docker', ['image', 'rm', serviceImageId], { timeout: 60_000 }); } catch {}
  }
  await rm(sandbox, { recursive: true, force: true });
}
