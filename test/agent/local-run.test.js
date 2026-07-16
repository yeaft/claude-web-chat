import { execFile, spawn } from 'child_process';
import { EventEmitter } from 'events';
import { mkdtemp, readFile, rm, stat, writeFile } from 'fs/promises';
import { createServer } from 'net';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { promisify } from 'util';
import { WebSocket } from 'ws';
import { describe, expect, it } from 'vitest';
import { parseLocalArgs, runLocal } from '../../agent/local-run.js';

const testDir = dirname(fileURLToPath(import.meta.url));
const rootDir = join(testDir, '..', '..');
const agentDir = join(rootDir, 'agent');
const agentCli = join(agentDir, 'cli.js');
const execFileAsync = promisify(execFile);

async function getFreePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function waitForLocalReady(child, port, name) {
  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Local run exited with code ${child.exitCode}`);
    try {
      const response = await fetch(`${url}/api/auth/mode`);
      if (response.ok && (await response.json()).skipAuth) {
        const agents = await readAgentList(`ws://127.0.0.1:${port}`);
        if (agents.some(agent => agent.name === name)) return url;
      }
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Local run did not become ready on port ${port}`);
}

function readAgentList(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${url}?type=web`);
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error('Timed out waiting for agent_list'));
    }, 2000);
    ws.on('open', () => ws.send(JSON.stringify({ type: 'client_hello', plaintextOk: true })));
    ws.on('message', data => {
      const message = JSON.parse(data.toString());
      if (message.type !== 'agent_list') return;
      clearTimeout(timer);
      ws.close();
      resolve(message.agents || []);
    });
    ws.on('error', error => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function stopChild(child) {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  await new Promise(resolve => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve();
    }, 10000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function startLocal(home, port, name, cwd = rootDir) {
  const child = spawn(process.execPath, [agentCli, 'local', '--name', name, '--port', String(port)], {
    cwd,
    env: {
      ...process.env,
      HOME: home,
      TEST_DB_DIR: join(home, 'must-not-be-used'),
      TEST_DB_PATH: join(home, 'must-not-be-used.db'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  return { child, getOutput: () => output };
}

describe('local run CLI', () => {
  it('requires a valid name and accepts a custom port', () => {
    expect(parseLocalArgs(['--name', 'dev-box'])).toEqual({ name: 'dev-box', port: 6868 });
    expect(parseLocalArgs(['--port', '7000', '--name', 'dev.box'])).toEqual({ name: 'dev.box', port: 7000 });
    expect(() => parseLocalArgs([])).toThrow('local requires --name <name>');
    expect(() => parseLocalArgs(['--name', 'bad name'])).toThrow('Invalid name');
    expect(() => parseLocalArgs(['--name', 'dev', '--port', '0'])).toThrow('Invalid port: 0');
    expect(() => parseLocalArgs(['--name', 'dev', '--other'])).toThrow('Unknown local option');
  });

  it('rejects an occupied loopback port before spawning children', async () => {
    const listener = createServer();
    await new Promise((resolve, reject) => {
      listener.once('error', reject);
      listener.listen(0, '127.0.0.1', resolve);
    });
    const { port } = listener.address();
    let spawnCalls = 0;

    try {
      await expect(runLocal(['--name', 'dev', '--port', String(port)], {
        exit: false,
        spawn: () => { spawnCalls++; },
      })).rejects.toThrow(`Port ${port} is already in use on 127.0.0.1`);
      expect(spawnCalls).toBe(0);
    } finally {
      await new Promise(resolve => listener.close(resolve));
    }
  });

  it('cleans up the server when interrupted during startup', async () => {
    const port = await getFreePort();
    const server = new EventEmitter();
    server.exitCode = null;
    server.killed = false;
    server.kill = signal => {
      server.killed = true;
      server.exitCode = signal === 'SIGKILL' ? 137 : 143;
      queueMicrotask(() => server.emit('exit', server.exitCode));
      return true;
    };
    let startupStarted;
    const waitingForServer = new Promise(resolve => { startupStarted = resolve; });
    const run = runLocal(['--name', 'startup-stop', '--port', String(port)], {
      exit: false,
      spawn: () => server,
      waitForServer: async () => {
        startupStarted();
        await new Promise((resolve, reject) => {
          server.once('exit', () => reject(new Error('server stopped during startup')));
        });
      },
    });

    await waitingForServer;
    process.emit('SIGTERM');
    await expect(run).rejects.toThrow('server stopped during startup');

    expect(server.killed).toBe(true);
    expect(server.exitCode).toBe(143);
  });

  it('serves the production UI, skips auth, registers the agent, and persists server data', async () => {
    const home = await mkdtemp(join(tmpdir(), 'yeaft-local-home-'));
    const port = await getFreePort();
    const name = 'e2e-local';
    const firstRun = startLocal(home, port, name);
    const { child } = firstRun;

    try {
      const url = await waitForLocalReady(child, port, name);
      const page = await fetch(url);
      expect(page.status).toBe(200);
      expect(await page.text()).toContain('<div id="app">');

      const mode = await fetch(`${url}/api/auth/mode`).then(response => response.json());
      expect(mode).toMatchObject({ skipAuth: true, registrationEnabled: false });
      const dbPath = join(home, '.yeaft', 'server', 'webchat.db');
      expect(await stat(dbPath)).toBeTruthy();
      await expect(stat(join(home, 'must-not-be-used'))).rejects.toThrow();
      expect(firstRun.getOutput()).toContain(`Yeaft local is available at ${url}`);

      const db = new DatabaseSync(dbPath);
      db.exec("INSERT INTO users (id, username, display_name, created_at) VALUES ('local-user', 'local-user', 'Local User', 1)");
      db.close();
      await stopChild(child);

      const secondRun = startLocal(home, port, name);
      try {
        await waitForLocalReady(secondRun.child, port, name);
        const reopenedDb = new DatabaseSync(dbPath, { readOnly: true });
        const persisted = reopenedDb.prepare("SELECT username FROM users WHERE id = 'local-user'").get();
        reopenedDb.close();
        expect(persisted).toEqual({ username: 'local-user' });
      } finally {
        await stopChild(secondRun.child);
      }
    } finally {
      await stopChild(child);
      await rm(home, { recursive: true, force: true });
    }
  }, 45000);

  it('does not read or overwrite the remote agent config', async () => {
    const temp = await mkdtemp(join(tmpdir(), 'yeaft-local-config-'));
    const home = join(temp, 'home');
    const configPath = join(temp, '.claude-agent.json');
    const remoteConfig = JSON.stringify({
      serverUrl: 'wss://remote.example.test',
      agentName: 'remote-agent',
      workDir: '/remote/workdir',
      reconnectInterval: 9000,
    }, null, 2);
    const port = await getFreePort();
    const name = 'isolated-local';
    await writeFile(configPath, remoteConfig);
    const local = startLocal(home, port, name, temp);

    try {
      await waitForLocalReady(local.child, port, name);
      expect(await readFile(configPath, 'utf8')).toBe(remoteConfig);
    } finally {
      await stopChild(local.child);
      await rm(temp, { recursive: true, force: true });
    }
  }, 45000);

  it('runs from a clean npm pack installation without monorepo paths', async () => {
    const temp = await mkdtemp(join(tmpdir(), 'yeaft-local-pack-'));
    const installDir = join(temp, 'app');
    const home = join(temp, 'home');
    let tarballPath;
    let child;

    try {
      await writeFile(join(temp, 'package.json'), '{"private":true}\n');
      const { stdout } = await execFileAsync('npm', ['pack', '--silent'], {
        cwd: agentDir,
        maxBuffer: 10 * 1024 * 1024,
      });
      const filename = stdout.trim().split('\n').at(-1);
      tarballPath = join(agentDir, filename);
      await execFileAsync('npm', [
        'install', '--ignore-scripts', '--no-audit', '--no-fund', '--prefix', installDir, tarballPath,
      ], { cwd: temp, maxBuffer: 10 * 1024 * 1024 });

      const packageDir = join(installDir, 'node_modules', '@yeaft', 'webchat-agent');
      const packagedVersion = JSON.parse(await readFile(join(packageDir, 'local-runtime', 'version.json'), 'utf8'));
      expect(packagedVersion).toEqual({ version: '1.0.0' });
      await expect(stat(join(packageDir, 'local-runtime', 'server', 'index.js'))).resolves.toBeTruthy();
      await expect(stat(join(packageDir, 'local-runtime', 'web', 'index.html'))).resolves.toBeTruthy();

      const port = await getFreePort();
      const name = 'packed-local';
      child = spawn(process.execPath, [join(packageDir, 'cli.js'), 'local', '--name', name, '--port', String(port)], {
        cwd: installDir,
        env: { ...process.env, HOME: home },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const url = await waitForLocalReady(child, port, name);
      expect(await fetch(url).then(response => response.text())).toContain('<div id="app">');
      expect(await fetch(`${url}/api/version`).then(response => response.json())).toEqual({ version: '1.0.0' });
    } finally {
      if (child) await stopChild(child);
      if (tarballPath) await rm(tarballPath, { force: true });
      await rm(temp, { recursive: true, force: true });
    }
  }, 120000);

  it('reports invalid arguments without starting local services', async () => {
    const child = spawn(process.execPath, [agentCli, 'local', '--name', 'dev', '--port', '70000'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    const [code] = await new Promise(resolve => child.once('exit', (...args) => resolve(args)));
    expect(code).not.toBe(0);
    expect(output).toContain('Local run failed: Invalid port: 70000');
  });
});
