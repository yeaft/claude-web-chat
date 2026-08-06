#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

const image = process.env.SANDBOX_DOCKER_TEST_IMAGE || 'ghcr.io/yeaft/yeaft-web-code-agent:dev';
const prefix = `yeaft-sandbox-e2e-${randomUUID().slice(0, 8)}`;
const lifecycleName = `${prefix}-lifecycle`;
const pressureName = `${prefix}-pressure`;
const root = await mkdtemp(join(tmpdir(), 'yeaft-sandbox-docker-'));
const home = join(root, 'home');
const workspace = join(root, 'workspace');
const created = new Set();

function run(args, { allowFailure = false, timeoutMs = 60_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const stdout = [];
    const stderr = [];
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', chunk => stdout.push(chunk));
    child.stderr.on('data', chunk => stderr.push(chunk));
    child.on('error', error => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', code => {
      clearTimeout(timer);
      const result = {
        code,
        stdout: Buffer.concat(stdout).toString('utf8').trim(),
        stderr: Buffer.concat(stderr).toString('utf8').trim()
      };
      if (code === 0 || allowFailure) resolve(result);
      else reject(Object.assign(new Error(`docker ${args[0]} failed with code ${code}`), result));
    });
  });
}

async function inspect(name, format) {
  return (await run(['inspect', '--format', format, name])).stdout;
}

class MemoryAdmission {
  constructor({ availableMiB, reserveMiB }) {
    this.availableMiB = availableMiB;
    this.reserveMiB = reserveMiB;
    this.startingMiB = 0;
    this.createCalls = 0;
  }

  async create(memoryMiB, name) {
    if (this.availableMiB - this.reserveMiB - this.startingMiB < memoryMiB) {
      const error = new Error('SANDBOX_CAPACITY_UNAVAILABLE');
      error.code = 'SANDBOX_CAPACITY_UNAVAILABLE';
      throw error;
    }
    this.startingMiB += memoryMiB;
    try {
      this.createCalls++;
      await run(['create', '--name', name, '--memory', `${memoryMiB}m`, image, '/bin/sh', '-c', 'sleep 30']);
      created.add(name);
    } finally {
      this.startingMiB -= memoryMiB;
    }
  }
}

async function cleanup() {
  for (const name of created) await run(['rm', '-f', name], { allowFailure: true });
  await rm(root, { recursive: true, force: true });
}

try {
  await run(['info']);
  await run(['image', 'inspect', image]);
  await mkdir(home);
  await mkdir(workspace);
  await chmod(home, 0o777);
  await chmod(workspace, 0o777);
  await writeFile(join(home, 'home-sentinel'), 'home-persisted\n');
  await writeFile(join(workspace, 'workspace-sentinel'), 'workspace-persisted\n');

  await run([
    'create', '--name', lifecycleName,
    '--memory', '128m', '--cpus', '0.5', '--pids-limit', '64',
    '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges',
    '--mount', `type=bind,src=${home},dst=/sandbox-home`,
    '--mount', `type=bind,src=${workspace},dst=/workspace`,
    '--entrypoint', '/bin/sh', image, '-c', 'printf ready > /workspace/agent-ready; while :; do sleep 5; done'
  ]);
  created.add(lifecycleName);
  await run(['start', lifecycleName]);

  let ready = false;
  for (let attempt = 0; attempt < 40; attempt++) {
    const marker = await run(['exec', lifecycleName, 'cat', '/workspace/agent-ready'], { allowFailure: true });
    if (marker.code === 0 && marker.stdout === 'ready') {
      ready = true;
      break;
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  if (!ready) throw new Error('Agent readiness marker was not observed');

  const memoryBytes = Number(await inspect(lifecycleName, '{{.HostConfig.Memory}}'));
  if (memoryBytes !== 128 * 1024 * 1024) throw new Error(`Unexpected memory hard limit: ${memoryBytes}`);
  if (await inspect(lifecycleName, '{{.HostConfig.PidsLimit}}') !== '64') throw new Error('PID hard limit was not applied');

  await run(['stop', '--time', '2', lifecycleName]);
  await run(['start', lifecycleName]);
  if (await readFile(join(home, 'home-sentinel'), 'utf8') !== 'home-persisted\n'
    || await readFile(join(workspace, 'workspace-sentinel'), 'utf8') !== 'workspace-persisted\n') {
    throw new Error('Persistent Sandbox sentinels were not restored after Stop/Start');
  }

  await run([
    'create', '--name', pressureName, '--memory', '64m', image,
    'node', '-e', "const a=[]; setInterval(()=>{for(let i=0;i<32;i++){const b=Buffer.alloc(1024*1024);b.fill(1);a.push(b)}},1)"
  ]);
  created.add(pressureName);
  const pressure = await run(['start', '-a', pressureName], { allowFailure: true, timeoutMs: 45_000 });
  const pressureLimit = Number(await inspect(pressureName, '{{.HostConfig.Memory}}'));
  const oomKilled = await inspect(pressureName, '{{.State.OOMKilled}}');
  if (pressureLimit !== 64 * 1024 * 1024 || (pressure.code === 0 && oomKilled !== 'true')) {
    throw new Error('Memory pressure did not encounter the configured container hard limit');
  }

  const lowMemory = new MemoryAdmission({ availableMiB: 191, reserveMiB: 64 });
  await Promise.allSettled([
    lowMemory.create(128, `${prefix}-low-a`),
    lowMemory.create(128, `${prefix}-low-b`)
  ]).then(results => {
    if (results.some(result => result.status !== 'rejected' || result.reason?.code !== 'SANDBOX_CAPACITY_UNAVAILABLE')) {
      throw new Error('Low-memory admission did not fail closed');
    }
  });
  if (lowMemory.createCalls !== 0) throw new Error('Low-memory admission called docker create');
  const leaked = (await run(['ps', '-a', '--filter', `name=${prefix}-low-`, '--format', '{{.Names}}'])).stdout;
  if (leaked) throw new Error(`Low-memory admission leaked containers: ${leaked}`);

  await run(['rm', '-f', lifecycleName]);
  created.delete(lifecycleName);
  const absent = await run(['inspect', lifecycleName], { allowFailure: true });
  if (absent.code === 0) throw new Error('Removed Sandbox container is still present');

  console.log(JSON.stringify({
    passed: true,
    image,
    lifecycle: { ready: true, stopStartSentinels: true, removeAbsent: true },
    limits: { memoryBytes, pressureLimitBytes: pressureLimit, oomKilled: oomKilled === 'true' },
    lowMemory: { errorCode: 'SANDBOX_CAPACITY_UNAVAILABLE', dockerCreateCalls: lowMemory.createCalls, leakedContainers: false }
  }, null, 2));
} catch (error) {
  console.error(`Sandbox Docker E2E failed: ${error.message}`);
  if (error.stderr) console.error(error.stderr);
  process.exitCode = 1;
} finally {
  await cleanup();
}
