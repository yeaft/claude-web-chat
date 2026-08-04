import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildWindowsUpgradeInvocation,
  launchWindowsUpgradeScript,
  prepareWindowsUpgradeRunner,
} from '../../agent/upgrade-command.js';
import {
  runWindowsUpgrade,
  stopPm2Service,
} from '../../agent/windows-upgrade-runner.js';

const tempDirs = [];

function makeTempDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function waitForFile(path, timeoutMs = 5000) {
  return waitForCondition(() => existsSync(path), timeoutMs);
}

async function waitForCondition(condition, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return true;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  return condition();
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('Windows upgrade handoff', () => {
  it('enforces a shell-free live-runner handoff and safe service ordering', async () => {
    {
      const nodePath = 'C:\\Program Files\\nodejs\\node.exe';
      const bootstrapPath = 'C:\\runtime\\windows-upgrade-bootstrap.js';
      const runnerPath = 'C:\\runtime\\windows-upgrade-runner.js';
      const payloadPath = 'C:\\runtime\\payload.json';
      const logPath = 'C:\\runtime\\upgrade.log';
      const invocation = buildWindowsUpgradeInvocation({
        nodePath, bootstrapPath, runnerPath, payloadPath, logPath,
      });
      expect(invocation).toMatchObject({
        command: nodePath,
        args: [bootstrapPath, runnerPath, payloadPath],
        options: { stdio: 'ignore', windowsHide: true },
      });
      expect(invocation.options).not.toHaveProperty('shell');
      expect(invocation.options).not.toHaveProperty('detached');

      const handoffDir = makeTempDir('yeaft-upgrade-handoff-unit-');
      const handoffPath = join(handoffDir, 'started');
      const cancelPath = join(handoffDir, 'cancelled');
      writeFileSync(handoffPath, JSON.stringify({ runnerPid: 4242 }));
      const child = new EventEmitter();
      child.exitCode = null;
      child.signalCode = null;
      child.kill = vi.fn();
      const spawnProcess = vi.fn(() => {
        queueMicrotask(() => {
          child.emit('spawn');
          queueMicrotask(() => {
            child.exitCode = 0;
            child.emit('exit', 0, null);
          });
        });
        return child;
      });

      await expect(launchWindowsUpgradeScript({
        nodePath,
        bootstrapPath,
        runnerPath,
        payloadPath,
        logPath,
        handoffPath,
        cancelPath,
        spawnProcess,
        processRunning: pid => pid === 4242,
        sleep: async () => {},
      })).resolves.toBe(nodePath);
      expect(spawnProcess).toHaveBeenCalledOnce();
      expect(child.kill).not.toHaveBeenCalled();
    }

    {
      const dir = makeTempDir('yeaft-upgrade-handoff-failure-');
      const handoffPath = join(dir, 'started');
      const cancelPath = join(dir, 'cancelled');
      writeFileSync(handoffPath, JSON.stringify({ runnerPid: 99 }));
      const child = new EventEmitter();
      child.exitCode = null;
      child.signalCode = null;
      child.kill = vi.fn();

      await expect(launchWindowsUpgradeScript({
        nodePath: process.execPath,
        bootstrapPath: join(dir, 'bootstrap.js'),
        runnerPath: join(dir, 'runner.js'),
        payloadPath: join(dir, 'payload.json'),
        logPath: join(dir, 'upgrade.log'),
        handoffPath,
        cancelPath,
        spawnProcess: () => {
          queueMicrotask(() => child.emit('spawn'));
          return child;
        },
        processRunning: () => false,
        sleep: async () => {},
        timeoutMs: 1,
      })).rejects.toThrow('did not confirm handoff');
      expect(child.kill).toHaveBeenCalledOnce();
      expect(existsSync(cancelPath)).toBe(true);
    }

    {
      const dir = makeTempDir('yeaft-upgrade-runtime-copy-');
      const bootstrapPath = join(dir, 'windows-upgrade-bootstrap.js');
      const runnerPath = join(dir, 'windows-upgrade-runner.js');
      const commandPath = join(dir, 'upgrade-command.js');
      const payloadPath = join(dir, 'payload.json');
      const handoffPath = join(dir, 'started');
      const cancelPath = join(dir, 'cancelled');
      const payload = { handoffPath, cancelPath, bootstrapPath, runnerPath, commandPath, payloadPath };

      prepareWindowsUpgradeRunner({
        sourceBootstrapPath: fileURLToPath(new URL('../../agent/windows-upgrade-bootstrap.js', import.meta.url)),
        sourceRunnerPath: fileURLToPath(new URL('../../agent/windows-upgrade-runner.js', import.meta.url)),
        sourceCommandPath: fileURLToPath(new URL('../../agent/upgrade-command.js', import.meta.url)),
        bootstrapPath,
        runnerPath,
        commandPath,
        payloadPath,
        payload,
      });

      expect(existsSync(bootstrapPath)).toBe(true);
      expect(existsSync(runnerPath)).toBe(true);
      expect(existsSync(commandPath)).toBe(true);
      expect(JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))).toEqual({ type: 'module' });
      expect(JSON.parse(readFileSync(payloadPath, 'utf8'))).toEqual(payload);
    }

    {
      const dir = makeTempDir('yeaft-upgrade-runner-order-');
      const options = {
        parentPid: 42,
        packageSpec: '@yeaft/webchat-agent@1.0.999',
        globalInstall: true,
        installDir: dir,
        logPath: join(dir, 'upgrade.log'),
        handoffPath: join(dir, 'started'),
        cancelPath: join(dir, 'cancelled'),
        bootstrapPath: join(dir, 'windows-upgrade-bootstrap.js'),
        runnerPath: join(dir, 'windows-upgrade-runner.js'),
        commandPath: join(dir, 'upgrade-command.js'),
        payloadPath: join(dir, 'payload.json'),
        nodePath: process.execPath,
        npmCliPath: 'npm-cli.js',
        pm2CliPath: 'pm2-cli.js',
        pm2AppName: 'yeaft-agent-test',
        ecosystemPath: join(dir, 'ecosystem.config.cjs'),
      };
      const stop = vi.fn();
      const install = vi.fn();
      await expect(runWindowsUpgrade(options, {
        waitForProcessExit: vi.fn().mockResolvedValue(false),
        stopPm2Service: stop,
        installWindowsUpgrade: install,
      })).resolves.toMatchObject({ exitCode: 1, restarted: false });
      expect(stop).not.toHaveBeenCalled();
      expect(install).not.toHaveBeenCalled();

      const order = [];
      await expect(runWindowsUpgrade(options, {
        waitForProcessExit: vi.fn().mockResolvedValue(true),
        stopPm2Service: vi.fn(async () => { order.push('stop'); return true; }),
        installWindowsUpgrade: vi.fn(async () => { order.push('install'); return { exitCode: 0, attempts: 1 }; }),
        startPm2Service: vi.fn(async () => { order.push('start'); return true; }),
      })).resolves.toMatchObject({ exitCode: 0, restarted: true });
      expect(order).toEqual(['stop', 'install', 'start']);

      writeFileSync(options.cancelPath, 'cancelled');
      const cancelledStop = vi.fn();
      const cancelledInstall = vi.fn();
      await expect(runWindowsUpgrade(options, {
        waitForProcessExit: vi.fn().mockResolvedValue(true),
        stopPm2Service: cancelledStop,
        installWindowsUpgrade: cancelledInstall,
      })).resolves.toMatchObject({ exitCode: 1, restarted: false });
      expect(cancelledStop).not.toHaveBeenCalled();
      expect(cancelledInstall).not.toHaveBeenCalled();
    }

    await verifyRuntimeOnNode225();
    await verifyRunnerWithFakeServiceCli();

    {
      const run = vi.fn().mockResolvedValue(0);
      await expect(stopPm2Service({
        nodePath: process.execPath,
        pm2CliPath: 'C:\\npm\\node_modules\\pm2\\bin\\pm2',
        pm2AppName: 'yeaft-agent-test',
        logPath: 'C:\\upgrade.log',
        run,
      })).resolves.toBe(true);
      expect(run).toHaveBeenCalledWith(
        process.execPath,
        ['C:\\npm\\node_modules\\pm2\\bin\\pm2', 'delete', 'yeaft-agent-test'],
        expect.not.objectContaining({ shell: expect.anything() }),
      );
    }

    if (process.platform === 'win32') {
      await verifyWindowsTreeKill();
    }
  }, 10_000);
});

async function verifyWindowsTreeKill() {
  const dir = makeTempDir('yeaft-upgrade-tree-kill-');
  const bootstrapPath = fileURLToPath(new URL('../../agent/windows-upgrade-bootstrap.js', import.meta.url));
  const parentPath = join(dir, 'parent.mjs');
  const runnerPath = join(dir, 'runner.mjs');
  const payloadPath = join(dir, 'payload.json');
  const handoffPath = join(dir, 'started');
  const survivedPath = join(dir, 'survived');
  const parentInfoPath = join(dir, 'parent.json');
  const logPath = join(dir, 'upgrade.log');

  writeFileSync(runnerPath, [
    "import { writeFileSync } from 'node:fs';",
    "const [payloadPath] = process.argv.slice(2);",
    "const payload = JSON.parse((await import('node:fs')).readFileSync(payloadPath, 'utf8'));",
    "writeFileSync(payload.handoffPath, JSON.stringify({ runnerPid: process.pid }));",
    "setTimeout(() => writeFileSync(payload.survivedPath, String(process.pid)), 400);",
    "setTimeout(() => process.exit(0), 700);",
  ].join('\n'));
  writeFileSync(payloadPath, JSON.stringify({ handoffPath, survivedPath }));
  writeFileSync(parentPath, [
    "import { spawn } from 'node:child_process';",
    "import { writeFileSync } from 'node:fs';",
    "const [bootstrapPath, runnerPath, payloadPath, logPath, parentInfoPath] = process.argv.slice(2);",
    "const child = spawn(process.execPath, [bootstrapPath, runnerPath, payloadPath], { stdio: 'ignore', windowsHide: true, env: { ...process.env, YEAFT_UPGRADE_LOG: logPath } });",
    "writeFileSync(parentInfoPath, JSON.stringify({ parentPid: process.pid, bootstrapPid: child.pid }));",
    "setInterval(() => {}, 1000);",
  ].join('\n'));

  const parent = spawn(process.execPath, [parentPath, bootstrapPath, runnerPath, payloadPath, logPath, parentInfoPath], {
    stdio: 'ignore',
    windowsHide: true,
  });
  try {
    expect(await waitForFile(handoffPath)).toBe(true);
    const { parentPid } = JSON.parse(readFileSync(parentInfoPath, 'utf8'));
    execFileSync('taskkill.exe', ['/PID', String(parentPid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    expect(await waitForFile(survivedPath, 5000)).toBe(true);
    expect(readFileSync(survivedPath, 'utf8')).not.toBe(String(parentPid));
  } finally {
    try { parent.kill(); } catch {}
  }
}

async function verifyRuntimeOnNode225() {
  if (process.platform !== 'win32') return;
  const nodePath = process.env.YEAFT_NODE_22_5_PATH;
  if (!nodePath) return;

  const dir = makeTempDir('yeaft-upgrade-node225-');
  const bootstrapPath = join(dir, 'windows-upgrade-bootstrap.js');
  const runnerPath = join(dir, 'windows-upgrade-runner.js');
  const commandPath = join(dir, 'upgrade-command.js');
  const payloadPath = join(dir, 'payload.json');
  const handoffPath = join(dir, 'started');
  const cancelPath = join(dir, 'cancelled');
  const logPath = join(dir, 'upgrade.log');
  const npmCliPath = join(dir, 'npm-cli.cjs');
  const resultPath = join(dir, 'npm-result.json');
  const packageSpec = '@yeaft/webchat-agent@9.9.9-test';

  writeFileSync(npmCliPath, [
    "const fs = require('node:fs');",
    "fs.writeFileSync(process.env.YEAFT_TEST_NPM_RESULT, JSON.stringify(process.argv.slice(2)));",
  ].join('\n'));
  prepareWindowsUpgradeRunner({
    sourceBootstrapPath: fileURLToPath(new URL('../../agent/windows-upgrade-bootstrap.js', import.meta.url)),
    sourceRunnerPath: fileURLToPath(new URL('../../agent/windows-upgrade-runner.js', import.meta.url)),
    sourceCommandPath: fileURLToPath(new URL('../../agent/upgrade-command.js', import.meta.url)),
    bootstrapPath,
    runnerPath,
    commandPath,
    payloadPath,
    payload: {
      parentPid: 99999999,
      packageSpec,
      globalInstall: true,
      installDir: dir,
      logPath,
      handoffPath,
      cancelPath,
      bootstrapPath,
      runnerPath,
      commandPath,
      payloadPath,
      nodePath,
      npmCliPath,
      pm2CliPath: null,
      pm2AppName: null,
      ecosystemPath: null,
    },
  });

  const child = spawn(nodePath, [bootstrapPath, runnerPath, payloadPath], {
    cwd: dirname(nodePath),
    env: { ...process.env, YEAFT_UPGRADE_LOG: logPath, YEAFT_TEST_NPM_RESULT: resultPath },
    stdio: 'ignore',
    windowsHide: true,
  });
  const exitCode = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', code => resolve(code));
  });
  expect(exitCode).toBe(0);
  expect(await waitForFile(resultPath, 5000)).toBe(true);
  expect(JSON.parse(readFileSync(resultPath, 'utf8'))).toEqual([
    'install',
    '-g',
    packageSpec,
    '--registry=https://pkg.yeaft.com/',
    '--no-audit',
    '--no-fund',
    '--loglevel=error',
  ]);
  expect(await waitForCondition(() => !existsSync(payloadPath), 5000)).toBe(true);
}

async function verifyRunnerWithFakeServiceCli() {
  const dir = makeTempDir('yeaft-upgrade-fake-service-');
  const runnerPath = join(dir, 'windows-upgrade-runner.js');
  const commandPath = join(dir, 'upgrade-command.js');
  const payloadPath = join(dir, 'payload.json');
  const handoffPath = join(dir, 'started');
  const cancelPath = join(dir, 'cancelled');
  const logPath = join(dir, 'upgrade.log');
  const npmCliPath = join(dir, 'npm-cli.cjs');
  const pm2CliPath = join(dir, 'pm2-cli.cjs');
  const ecosystemPath = join(dir, 'ecosystem.config.cjs');
  const eventsPath = join(dir, 'events.jsonl');
  const packageSpec = '@yeaft/webchat-agent@9.9.9-test';

  copyRuntimeFile('../../agent/windows-upgrade-runner.js', runnerPath);
  copyRuntimeFile('../../agent/upgrade-command.js', commandPath);
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ type: 'module' }));
  writeFileSync(ecosystemPath, 'module.exports = { apps: [] };');
  writeFileSync(npmCliPath, [
    "const fs = require('node:fs');",
    "fs.appendFileSync(process.env.YEAFT_TEST_EVENTS, JSON.stringify({ tool: 'npm', args: process.argv.slice(2) }) + '\\n');",
  ].join('\n'));
  writeFileSync(pm2CliPath, [
    "const fs = require('node:fs');",
    "fs.appendFileSync(process.env.YEAFT_TEST_EVENTS, JSON.stringify({ tool: 'pm2', args: process.argv.slice(2) }) + '\\n');",
  ].join('\n'));
  writeFileSync(payloadPath, JSON.stringify({
    parentPid: 99999999,
    packageSpec,
    globalInstall: true,
    installDir: dir,
    logPath,
    handoffPath,
    cancelPath,
    bootstrapPath: join(dir, 'windows-upgrade-bootstrap.js'),
    runnerPath,
    commandPath,
    payloadPath,
    nodePath: process.execPath,
    npmCliPath,
    pm2CliPath,
    pm2AppName: 'yeaft-upgrade-test-agent',
    ecosystemPath,
  }));

  const exitCode = await runChild(process.execPath, [runnerPath, payloadPath], {
    cwd: dir,
    env: { ...process.env, YEAFT_TEST_EVENTS: eventsPath },
    stdio: 'ignore',
    windowsHide: true,
  });
  expect(exitCode).toBe(0);
  expect(readJsonLines(eventsPath)).toEqual([
    { tool: 'pm2', args: ['delete', 'yeaft-upgrade-test-agent'] },
    {
      tool: 'npm',
      args: [
        'install',
        '-g',
        packageSpec,
        '--registry=https://pkg.yeaft.com/',
        '--no-audit',
        '--no-fund',
        '--loglevel=error',
      ],
    },
    { tool: 'pm2', args: ['start', ecosystemPath] },
    { tool: 'pm2', args: ['save'] },
  ]);
  expect(existsSync(payloadPath)).toBe(false);
  expect(existsSync(handoffPath)).toBe(false);
}

function copyRuntimeFile(relativeSource, destination) {
  writeFileSync(destination, readFileSync(fileURLToPath(new URL(relativeSource, import.meta.url))));
}

function readJsonLines(path) {
  return readFileSync(path, 'utf8').trim().split(/\r?\n/u).filter(Boolean).map(line => JSON.parse(line));
}

function runChild(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, options);
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (signal) reject(new Error(`${command} exited with signal ${signal}`));
      else resolve(code);
    });
  });
}