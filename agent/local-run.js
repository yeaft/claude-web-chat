import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { homedir } from 'os';
import { createServer } from 'net';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { WebSocket } from 'ws';
import { resolveDisplayName, validateInstanceId } from './service/config.js';

const DEFAULT_PORT = 6868;
const LOCAL_HOST = '127.0.0.1';

export function parseLocalArgs(args, env = process.env) {
  const options = {
    name: resolveDisplayName(args, env),
    port: DEFAULT_PORT,
    background: false,
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const value = args[i + 1];
    if (arg === '--name') {
      if (!value || value.startsWith('-')) throw new Error('--name requires a value');
      i++;
    } else if (arg === '--port') {
      if (!value || value.startsWith('-')) throw new Error('--port requires a value');
      if (!/^\d+$/.test(value)) throw new Error(`Invalid port: ${value}`);
      options.port = Number(value);
      if (options.port < 1 || options.port > 65535) throw new Error(`Invalid port: ${value}`);
      i++;
    } else if (arg === '--background' || arg === '-d') {
      options.background = true;
    } else {
      throw new Error(`Unknown local option: ${arg}`);
    }
  }
  options.name = validateInstanceId(options.name);
  return options;
}

function runtimePaths() {
  const agentDir = dirname(fileURLToPath(import.meta.url));
  const packaged = join(agentDir, 'local-runtime');
  if (existsSync(packaged)) {
    return {
      serverEntry: join(packaged, 'server', 'index.js'),
      webDir: join(packaged, 'web'),
    };
  }
  return {
    serverEntry: join(agentDir, '..', 'server', 'index.js'),
    webDir: join(agentDir, '..', 'web'),
  };
}

async function assertPortAvailable(port) {
  const probe = createServer();
  await new Promise((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(port, LOCAL_HOST, resolve);
  }).catch(error => {
    if (error.code === 'EADDRINUSE') {
      throw new Error(`Port ${port} is already in use on ${LOCAL_HOST}`);
    }
    throw error;
  });
  await new Promise((resolve, reject) => probe.close(error => error ? reject(error) : resolve()));
}

async function waitForServer(url, server, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`Local server exited with code ${server.exitCode}`);
    try {
      const response = await fetch(`${url}/api/auth/mode`);
      if (response.ok) {
        const mode = await response.json();
        if (!mode.skipAuth) throw new Error('Local server did not start in no-auth mode');
        return;
      }
    } catch (error) {
      if (error.message === 'Local server did not start in no-auth mode') throw error;
      // Server is still starting.
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Local server did not become ready at ${url}`);
}

async function waitForAgent(wsUrl, name, agent, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (agent.exitCode !== null) throw new Error(`Local agent exited with code ${agent.exitCode}`);
    try {
      const agents = await readAgentList(wsUrl);
      if (agents.some(item => item.name === name || item.agentName === name)) return;
    } catch {
      // Agent is still connecting.
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Local agent did not register as ${name}`);
}

function readAgentList(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${wsUrl}?type=web`);
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error('Timed out waiting for agent list'));
    }, 1000);
    ws.on('open', () => ws.send(JSON.stringify({ type: 'client_hello', plaintextOk: true })));
    ws.on('message', data => {
      try {
        const message = JSON.parse(data.toString());
        if (message.type !== 'agent_list') return;
        clearTimeout(timer);
        ws.close();
        resolve(message.agents || []);
      } catch (error) {
        clearTimeout(timer);
        ws.terminate();
        reject(error);
      }
    });
    ws.on('error', error => {
      clearTimeout(timer);
      ws.terminate();
      reject(error);
    });
  });
}

export async function runLocal(args, options = {}) {
  const config = parseLocalArgs(args);
  if (config.background && options.backgroundHandled !== true) {
    return launchLocalInBackground(args, options);
  }
  const paths = options.paths || runtimePaths();
  const dataDir = options.dataDir || join(homedir(), '.yeaft', 'server');
  const yeaftDir = options.yeaftDir || process.env.YEAFT_DIR || join(homedir(), '.yeaft', 'instances', config.name);
  const url = `http://${LOCAL_HOST}:${config.port}`;
  const children = new Set();
  const signalHandlers = new Map();
  let stopping = false;
  let stopPromise = null;

  const stop = (exitCode = 0) => {
    if (stopPromise) return stopPromise;
    stopping = true;
    stopPromise = (async () => {
      for (const [signal, handler] of signalHandlers) process.removeListener(signal, handler);
      for (const child of children) {
        if (child.exitCode === null && !child.killed) child.kill('SIGTERM');
      }
      await Promise.all([...children].map(child => new Promise(resolve => {
        if (child.exitCode !== null) return resolve();
        const timer = setTimeout(() => {
          if (child.exitCode === null) child.kill('SIGKILL');
          resolve();
        }, 6000);
        child.once('exit', () => { clearTimeout(timer); resolve(); });
      })));
      if (options.exit !== false) process.exit(exitCode);
    })();
    return stopPromise;
  };

  await assertPortAvailable(config.port);

  signalHandlers.set('SIGINT', () => void stop(0));
  signalHandlers.set('SIGTERM', () => void stop(0));
  for (const [signal, handler] of signalHandlers) process.once(signal, handler);

  const spawnChild = options.spawn || spawn;
  try {
    const server = spawnChild(process.execPath, [paths.serverEntry], {
      stdio: 'inherit',
      env: {
        ...process.env,
        PORT: String(config.port),
        SERVER_HOST: LOCAL_HOST,
        SERVER_DATA_DIR: dataDir,
        PERF_TRACE_DIR: join(dataDir, 'perf-traces'),
        SKIP_AUTH: 'true',
        YEAFT_LOCAL_RUN: 'true',
        WEB_DIR: paths.webDir,
      },
    });
    children.add(server);

    await (options.waitForServer || waitForServer)(url, server);

    const agentDir = dirname(fileURLToPath(import.meta.url));
    const agent = spawnChild(process.execPath, [join(agentDir, 'index.js')], {
      stdio: 'inherit',
      env: {
        ...process.env,
        SERVER_URL: `ws://${LOCAL_HOST}:${config.port}`,
        AGENT_NAME: config.name,
        YEAFT_AGENT_INSTANCE: config.name,
        AGENT_SECRET: '',
        YEAFT_DIR: yeaftDir,
        YEAFT_LOCAL_RUN: 'true',
        YEAFT_SKIP_STARTUP_INSTALLS: 'true',
      },
    });
    children.add(agent);

    const fail = childName => code => {
      if (!stopping) {
        console.error(`${childName} exited unexpectedly with code ${code}`);
        void stop(code || 1);
      }
    };
    server.once('exit', fail('Local server'));
    agent.once('exit', fail('Local agent'));

    await waitForAgent(`ws://${LOCAL_HOST}:${config.port}`, config.name, agent);

    console.log(`Yeaft local is available at ${url}`);
    return { url, server, agent, stop };
  } catch (error) {
    await stop(1);
    throw error;
  }
}

function localDaemonArgs(args) {
  return args.filter(arg => arg !== '--background' && arg !== '-d');
}

export async function launchLocalInBackground(args, options = {}) {
  const config = parseLocalArgs(args);
  const spawnProcess = options.spawn || spawn;
  const cliPath = options.cliPath || join(dirname(fileURLToPath(import.meta.url)), 'cli.js');
  const child = spawnProcess(process.execPath, [cliPath, 'local', ...localDaemonArgs(args)], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: {
      ...process.env,
      YEAFT_LOCAL_RUN_BACKGROUND: 'true',
    },
  });
  child.unref();
  const url = `http://${LOCAL_HOST}:${config.port}`;
  const result = { url, pid: child.pid, background: true };
  if (options.quiet !== true) {
    console.log(`Yeaft local is starting in the background at ${url} (PID ${child.pid}).`);
  }
  return result;
}
