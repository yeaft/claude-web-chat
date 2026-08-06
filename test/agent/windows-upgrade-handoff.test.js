import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildWindowsUpgradeInvocation,
  createWindowsUpgradeRun,
  launchWindowsUpgradeScript,
  prepareWindowsUpgradeRunner,
  releaseWindowsUpgradeLock,
} from '../../agent/upgrade-command.js';
import { spawnWindowsUpgradeRunner } from '../../agent/windows-upgrade-bootstrap.js';
import {
  runWindowsUpgrade,
  startPm2Service,
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
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
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
        options: { cwd: dirname(bootstrapPath), stdio: 'ignore', windowsHide: true },
      });
      expect(invocation.options).not.toHaveProperty('shell');
      expect(invocation.options).not.toHaveProperty('detached');

      const runnerChild = new EventEmitter();
      runnerChild.pid = 4242;
      runnerChild.unref = vi.fn();
      const spawnRunner = vi.fn(() => {
        queueMicrotask(() => runnerChild.emit('spawn'));
        return runnerChild;
      });
      await expect(spawnWindowsUpgradeRunner({
        nodePath, runnerPath, payloadPath, logPath,
      }, spawnRunner)).resolves.toBe(4242);
      expect(spawnRunner).toHaveBeenCalledWith(nodePath, [runnerPath, payloadPath], expect.objectContaining({
        cwd: dirname(runnerPath),
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      }));
      expect(runnerChild.unref).toHaveBeenCalledOnce();

      const handoffDir = makeTempDir('yeaft-upgrade-handoff-unit-');
      const handoffPath = join(handoffDir, 'started');
      const authorizePath = join(handoffDir, 'authorized');
      const cancelPath = join(handoffDir, 'cancelled');
      const lockPath = join(handoffDir, 'lock');
      const runId = 'unit-success';
      const child = new EventEmitter();
      child.exitCode = null;
      child.signalCode = null;
      child.kill = vi.fn();
      const spawnProcess = vi.fn(() => {
        queueMicrotask(() => {
          child.emit('spawn');
          child.exitCode = 0;
          child.emit('exit', 0, null);
        });
        return child;
      });
      const sleep = vi.fn(async () => {
        if (!existsSync(handoffPath)) {
          expect(child.exitCode).toBe(0);
          writeFileSync(handoffPath, JSON.stringify({ runId, runnerPid: 4242 }));
        }
      });

      await expect(launchWindowsUpgradeScript({
        runId,
        nodePath,
        bootstrapPath,
        runnerPath,
        payloadPath,
        logPath,
        handoffPath,
        authorizePath,
        cancelPath,
        lockPath,
        spawnProcess,
        processRunning: pid => pid === 4242,
        sleep,
      })).resolves.toBe(nodePath);
      expect(JSON.parse(readFileSync(authorizePath, 'utf8'))).toMatchObject({ runId });
      expect(spawnProcess).toHaveBeenCalledOnce();
      expect(sleep).toHaveBeenCalled();
      expect(child.kill).not.toHaveBeenCalled();
    }

    {
      const dir = makeTempDir('yeaft-upgrade-handoff-failure-');
      const runId = 'unit-timeout';
      const handoffPath = join(dir, 'started');
      const authorizePath = join(dir, 'authorized');
      const cancelPath = join(dir, 'cancelled');
      const lockPath = join(dir, 'lock');
      writeFileSync(handoffPath, JSON.stringify({ runId, runnerPid: 99 }));
      const child = new EventEmitter();
      child.exitCode = null;
      child.signalCode = null;
      child.kill = vi.fn();

      await expect(launchWindowsUpgradeScript({
        runId,
        nodePath: process.execPath,
        bootstrapPath: join(dir, 'bootstrap.js'),
        runnerPath: join(dir, 'runner.js'),
        payloadPath: join(dir, 'payload.json'),
        logPath: join(dir, 'upgrade.log'),
        handoffPath,
        authorizePath,
        cancelPath,
        lockPath,
        spawnProcess: () => {
          queueMicrotask(() => child.emit('spawn'));
          return child;
        },
        processRunning: () => false,
        sleep: async () => {},
        timeoutMs: 1,
      })).rejects.toThrow('did not confirm handoff');
      expect(child.kill).toHaveBeenCalledOnce();
      expect(JSON.parse(readFileSync(cancelPath, 'utf8'))).toMatchObject({ runId });
    }

    {
      const dir = makeTempDir('yeaft-upgrade-bootstrap-error-');
      const runId = 'unit-bootstrap-error';
      const child = new EventEmitter();
      child.exitCode = null;
      child.signalCode = null;
      child.kill = vi.fn();
      const sleep = vi.fn(async () => {});

      await expect(launchWindowsUpgradeScript({
        runId,
        nodePath: process.execPath,
        bootstrapPath: join(dir, 'bootstrap.js'),
        runnerPath: join(dir, 'runner.js'),
        payloadPath: join(dir, 'payload.json'),
        logPath: join(dir, 'upgrade.log'),
        handoffPath: join(dir, 'started'),
        authorizePath: join(dir, 'authorized'),
        cancelPath: join(dir, 'cancelled'),
        lockPath: join(dir, 'lock'),
        spawnProcess: () => {
          queueMicrotask(() => {
            child.emit('spawn');
            child.exitCode = 1;
            child.emit('exit', 1, null);
          });
          return child;
        },
        sleep,
      })).rejects.toThrow('exited before handoff (code 1)');
      expect(sleep).not.toHaveBeenCalled();
      expect(child.kill).toHaveBeenCalledOnce();
    }

    {
      const dir = makeTempDir('yeaft-upgrade-spawn-failure-');
      const run = createWindowsUpgradeRun(join(dir, 'upgrade-runtime'), {
        runId: 'spawn-failure',
        parentPid: process.pid,
      });
      await expect(launchWindowsUpgradeScript({
        ...run,
        nodePath: process.execPath,
        logPath: join(dir, 'upgrade.log'),
        spawnProcess: () => { throw new Error('spawn failed'); },
      })).rejects.toThrow('Windows upgrade bootstrap failed: spawn failed');
      expect(existsSync(run.lockPath)).toBe(false);
    }

    {
      const dir = makeTempDir('yeaft-upgrade-single-flight-');
      const upgradeRoot = join(dir, 'upgrade-runtime');
      const first = createWindowsUpgradeRun(upgradeRoot, {
        runId: 'run-one',
        parentPid: 101,
        processRunning: pid => pid === 101,
      });
      expect(first.runDir).toBe(join(upgradeRoot, 'runs', 'run-one'));
      expect(() => createWindowsUpgradeRun(upgradeRoot, {
        runId: 'run-two',
        parentPid: 202,
      })).toThrow('lock already exists');
      expect(releaseWindowsUpgradeLock(first.lockPath, 'wrong-run')).toBe(false);
      expect(releaseWindowsUpgradeLock(first.lockPath, first.runId)).toBe(true);

      const second = createWindowsUpgradeRun(upgradeRoot, {
        runId: 'run-two',
        parentPid: 202,
        processRunning: () => false,
      });
      expect(second.runDir).not.toBe(first.runDir);
      expect(releaseWindowsUpgradeLock(second.lockPath, second.runId)).toBe(true);

      const stale = createWindowsUpgradeRun(upgradeRoot, {
        runId: 'stale-run',
        parentPid: 303,
      });
      expect(() => createWindowsUpgradeRun(upgradeRoot, {
        runId: 'recovered-run',
        parentPid: 404,
      })).toThrow('lock already exists');
      expect(releaseWindowsUpgradeLock(stale.lockPath, stale.runId)).toBe(true);
      expect(() => createWindowsUpgradeRun(upgradeRoot, { runId: '../escape' })).toThrow('invalid path');
    }

    {
      const dir = makeTempDir('yeaft-upgrade-runtime-copy-');
      const bootstrapPath = join(dir, 'windows-upgrade-bootstrap.js');
      const runnerPath = join(dir, 'windows-upgrade-runner.js');
      const commandPath = join(dir, 'upgrade-command.js');
      const payloadPath = join(dir, 'payload.json');
      const runId = 'runtime-copy';
      const lockPath = join(dir, 'active.lock');
      const handoffPath = join(dir, 'started');
      const authorizePath = join(dir, 'authorized');
      const cancelPath = join(dir, 'cancelled');
      const payload = { runId, lockPath, handoffPath, authorizePath, cancelPath, bootstrapPath, runnerPath, commandPath, payloadPath };

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
        runId: 'runner-order',
        lockPath: join(dir, 'active.lock'),
        parentPid: 42,
        packageSpec: '@yeaft/webchat-agent@1.0.999',
        globalInstall: true,
        installDir: dir,
        logPath: join(dir, 'upgrade.log'),
        handoffPath: join(dir, 'started'),
        authorizePath: join(dir, 'authorized'),
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
      const runnerDependencies = {
        waitForHandoffAuthorization: vi.fn().mockResolvedValue(true),
        releaseWindowsUpgradeLock: vi.fn().mockReturnValue(true),
      };
      const stop = vi.fn();
      const install = vi.fn();
      await expect(runWindowsUpgrade(options, {
        ...runnerDependencies,
        waitForProcessExit: vi.fn().mockResolvedValue(false),
        stopPm2Service: stop,
        installWindowsUpgrade: install,
      })).resolves.toMatchObject({ exitCode: 1, restarted: false });
      expect(stop).not.toHaveBeenCalled();
      expect(install).not.toHaveBeenCalled();

      const order = [];
      await expect(runWindowsUpgrade(options, {
        ...runnerDependencies,
        waitForProcessExit: vi.fn().mockResolvedValue(true),
        stopPm2Service: vi.fn(async () => { order.push('stop'); return true; }),
        installWindowsUpgrade: vi.fn(async () => { order.push('install'); return { exitCode: 0, attempts: 1 }; }),
        startPm2Service: vi.fn(async () => { order.push('start'); return true; }),
      })).resolves.toMatchObject({ exitCode: 0, restarted: true });
      expect(order).toEqual(['stop', 'install', 'start']);

      writeFileSync(options.cancelPath, JSON.stringify({ runId: options.runId }));
      const cancelledStop = vi.fn();
      const cancelledInstall = vi.fn();
      await expect(runWindowsUpgrade(options, {
        ...runnerDependencies,
        waitForProcessExit: vi.fn().mockResolvedValue(true),
        stopPm2Service: cancelledStop,
        installWindowsUpgrade: cancelledInstall,
      })).resolves.toMatchObject({ exitCode: 1, restarted: false });
      expect(cancelledStop).not.toHaveBeenCalled();
      expect(cancelledInstall).not.toHaveBeenCalled();
    }

    const subprocessChecks = [
      verifyRealLauncherHandoff(),
      verifyRuntimeOnNode225(),
      verifyRunnerWithFakeServiceCli(),
    ];
    if (process.platform === 'win32') {
      subprocessChecks.push(verifyWindowsTreeKill());
      subprocessChecks.push(verifyPackageDirectoryCanBeReplaced());
    }
    await Promise.all(subprocessChecks);

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

      const pm2Run = vi.fn()
        .mockResolvedValueOnce(1)
        .mockResolvedValueOnce(1)
        .mockResolvedValueOnce(0)
        .mockResolvedValueOnce(1)
        .mockResolvedValueOnce(1)
        .mockResolvedValueOnce(1);
      const pm2Sleep = vi.fn(async () => {});
      await expect(startPm2Service({
        nodePath: process.execPath,
        pm2CliPath: 'pm2-cli.js',
        ecosystemPath: 'ecosystem.config.cjs',
        logPath: join(makeTempDir('yeaft-pm2-retry-'), 'upgrade.log'),
        run: pm2Run,
        sleep: pm2Sleep,
      })).resolves.toBe(false);
      expect(pm2Run.mock.calls.map(call => call[1].slice(1))).toEqual([
        ['start', 'ecosystem.config.cjs'],
        ['start', 'ecosystem.config.cjs'],
        ['start', 'ecosystem.config.cjs'],
        ['save'],
        ['save'],
        ['save'],
      ]);
      expect(pm2Sleep.mock.calls.map(call => call[0])).toEqual([250, 750, 250, 750]);

      const restoreFailureDir = makeTempDir('yeaft-restore-failure-');
      const restoreFailure = {
        runId: 'restore-failure',
        lockPath: join(restoreFailureDir, 'active.lock'),
        parentPid: 42,
        packageSpec: '@yeaft/webchat-agent@1.0.999',
        globalInstall: true,
        installDir: restoreFailureDir,
        logPath: join(restoreFailureDir, 'upgrade.log'),
        handoffPath: join(restoreFailureDir, 'started'),
        authorizePath: join(restoreFailureDir, 'authorized'),
        cancelPath: join(restoreFailureDir, 'cancelled'),
        bootstrapPath: join(restoreFailureDir, 'bootstrap.js'),
        runnerPath: join(restoreFailureDir, 'runner.js'),
        commandPath: join(restoreFailureDir, 'command.js'),
        payloadPath: join(restoreFailureDir, 'payload.json'),
        nodePath: process.execPath,
        npmCliPath: 'npm-cli.js',
        pm2CliPath: 'pm2-cli.js',
        pm2AppName: 'yeaft-agent-test',
        ecosystemPath: 'ecosystem.config.cjs',
      };
      await expect(runWindowsUpgrade(restoreFailure, {
        waitForHandoffAuthorization: vi.fn().mockResolvedValue(true),
        waitForProcessExit: vi.fn().mockResolvedValue(true),
        stopPm2Service: vi.fn().mockResolvedValue(true),
        installWindowsUpgrade: vi.fn().mockResolvedValue({ exitCode: 0, attempts: 1 }),
        startPm2Service: vi.fn().mockResolvedValue(false),
        releaseWindowsUpgradeLock: vi.fn().mockReturnValue(true),
      })).resolves.toMatchObject({ exitCode: 1, restarted: false });
    }

  }, 15_000);
});

async function verifyPackageDirectoryCanBeReplaced() {
  const dir = makeTempDir('yeaft upgrade cwd lock-');
  const packageParent = join(dir, 'node_modules', '@yeaft');
  const packageDir = join(packageParent, 'webchat-agent');
  const retiredDir = join(packageParent, '.webchat-agent-retired');
  const upgradeRoot = join(dir, 'upgrade-runtime');
  const runDir = join(upgradeRoot, 'runs', 'cwd-replacement');
  const parentPath = join(packageDir, 'parent.mjs');
  const parentInfoPath = join(dir, 'parent-info.json');
  const launchedPath = join(dir, 'launcher-finished');
  const installedPath = join(packageDir, 'installed-version');
  const logPath = join(dir, 'upgrade.log');
  const eventsPath = join(dir, 'events.jsonl');
  const npmCliPath = join(dir, 'npm-cli.cjs');
  const pm2CliPath = join(dir, 'pm2-cli.cjs');
  const ecosystemPath = join(dir, 'ecosystem.config.cjs');
  const commandModuleUrl = new URL('../../agent/upgrade-command.js', import.meta.url).href;
  const sourceBootstrapPath = fileURLToPath(new URL('../../agent/windows-upgrade-bootstrap.js', import.meta.url));
  const sourceRunnerPath = fileURLToPath(new URL('../../agent/windows-upgrade-runner.js', import.meta.url));
  const sourceCommandPath = fileURLToPath(new URL('../../agent/upgrade-command.js', import.meta.url));

  mkdirSync(packageDir, { recursive: true });
  writeFileSync(join(packageDir, 'old-version'), '1.0.369');
  writeFileSync(ecosystemPath, 'module.exports = { apps: [] };');
  writeFileSync(npmCliPath, [
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    "const event = { tool: 'npm', args: process.argv.slice(2), cwd: process.cwd() };",
    "try {",
    "  fs.renameSync(process.env.YEAFT_TEST_PACKAGE_DIR, process.env.YEAFT_TEST_RETIRED_DIR);",
    "  fs.mkdirSync(process.env.YEAFT_TEST_PACKAGE_DIR, { recursive: true });",
    "  fs.writeFileSync(process.env.YEAFT_TEST_INSTALLED_PATH, '1.0.999');",
    "  event.renamed = true;",
    "} catch (error) {",
    "  event.renamed = false;",
    "  event.code = error.code || null;",
    "  console.error(error.code || error.message);",
    "  process.exitCode = 1;",
    "}",
    "fs.appendFileSync(process.env.YEAFT_TEST_EVENTS, JSON.stringify(event) + '\\n');",
  ].join('\n'));
  writeFileSync(pm2CliPath, [
    "const fs = require('node:fs');",
    "fs.appendFileSync(process.env.YEAFT_TEST_EVENTS, JSON.stringify({ tool: 'pm2', args: process.argv.slice(2), cwd: process.cwd() }) + '\\n');",
  ].join('\n'));
  writeFileSync(parentPath, [
    "import { spawn } from 'node:child_process';",
    "import { writeFileSync } from 'node:fs';",
    `const api = await import(${JSON.stringify(commandModuleUrl)});`,
    `const run = api.createWindowsUpgradeRun(${JSON.stringify(upgradeRoot)}, { runId: 'cwd-replacement', parentPid: process.pid });`,
    "const payload = {",
    "  ...run,",
    "  parentPid: process.pid,",
    "  packageSpec: '@yeaft/webchat-agent@1.0.999',",
    "  globalInstall: true,",
    `  installDir: ${JSON.stringify(dir)},`,
    `  logPath: ${JSON.stringify(logPath)},`,
    "  nodePath: process.execPath,",
    `  npmCliPath: ${JSON.stringify(npmCliPath)},`,
    `  pm2CliPath: ${JSON.stringify(pm2CliPath)},`,
    "  pm2AppName: 'yeaft-agent-cwd-test',",
    `  ecosystemPath: ${JSON.stringify(ecosystemPath)},`,
    "};",
    "api.prepareWindowsUpgradeRunner({",
    `  sourceBootstrapPath: ${JSON.stringify(sourceBootstrapPath)},`,
    `  sourceRunnerPath: ${JSON.stringify(sourceRunnerPath)},`,
    `  sourceCommandPath: ${JSON.stringify(sourceCommandPath)},`,
    "  ...run,",
    "  payload,",
    "});",
    `writeFileSync(${JSON.stringify(parentInfoPath)}, JSON.stringify({ parentPid: process.pid, runDir: run.runDir }));`,
    "await api.launchWindowsUpgradeScript({",
    "  ...run,",
    "  nodePath: process.execPath,",
    `  logPath: ${JSON.stringify(logPath)},`,
    "  spawnProcess: spawn,",
    "});",
    `writeFileSync(${JSON.stringify(launchedPath)}, 'done');`,
  ].join('\n'));

  const parentExitCode = await runChild(process.execPath, [parentPath], {
    cwd: packageDir,
    env: {
      ...process.env,
      YEAFT_TEST_EVENTS: eventsPath,
      YEAFT_TEST_PACKAGE_DIR: packageDir,
      YEAFT_TEST_RETIRED_DIR: retiredDir,
      YEAFT_TEST_INSTALLED_PATH: installedPath,
    },
    stdio: 'ignore',
    windowsHide: true,
  });
  expect(parentExitCode).toBe(0);
  expect(existsSync(launchedPath)).toBe(true);
  expect(JSON.parse(readFileSync(parentInfoPath, 'utf8'))).toMatchObject({ runDir });
  expect(await waitForCondition(() => existsSync(installedPath) && !existsSync(join(upgradeRoot, 'active.lock')), 10_000)).toBe(true);

  const events = readJsonLines(eventsPath);
  expect(events.map(event => [event.tool, event.args[0]])).toEqual([
    ['pm2', 'delete'],
    ['npm', 'install'],
    ['pm2', 'start'],
    ['pm2', 'save'],
  ]);
  expect(events.find(event => event.tool === 'npm')).toMatchObject({ renamed: true });
  expect(events.filter(event => event.tool === 'pm2').every(event => event.cwd === runDir)).toBe(true);
  expect(events.every(event => event.cwd !== packageDir)).toBe(true);
  expect(readFileSync(installedPath, 'utf8')).toBe('1.0.999');
  expect(readFileSync(join(retiredDir, 'old-version'), 'utf8')).toBe('1.0.369');
}

async function verifyWindowsTreeKill() {
  const dir = makeTempDir('yeaft-upgrade-tree-kill-');
  const bootstrapPath = fileURLToPath(new URL('../../agent/windows-upgrade-bootstrap.js', import.meta.url));
  const parentPath = join(dir, 'parent.mjs');
  const runnerPath = join(dir, 'runner.mjs');
  const payloadPath = join(dir, 'payload.json');
  const runId = 'tree-kill';
  const handoffPath = join(dir, 'started');
  const survivedPath = join(dir, 'survived');
  const parentInfoPath = join(dir, 'parent.json');
  const logPath = join(dir, 'upgrade.log');

  writeFileSync(runnerPath, [
    "import { writeFileSync } from 'node:fs';",
    "const [payloadPath] = process.argv.slice(2);",
    "const payload = JSON.parse((await import('node:fs')).readFileSync(payloadPath, 'utf8'));",
    "writeFileSync(payload.handoffPath, JSON.stringify({ runId: payload.runId, runnerPid: process.pid }));",
    "setTimeout(() => writeFileSync(payload.survivedPath, String(process.pid)), 400);",
    "setTimeout(() => process.exit(0), 700);",
  ].join('\n'));
  writeFileSync(payloadPath, JSON.stringify({ runId, handoffPath, survivedPath }));
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

async function verifyRealLauncherHandoff() {
  const dir = makeTempDir('yeaft-upgrade-real-launcher-');
  const run = createWindowsUpgradeRun(join(dir, 'upgrade-runtime'), {
    runId: 'real-launcher',
    parentPid: process.pid,
  });
  const {
    runId,
    lockPath,
    bootstrapPath,
    runnerPath,
    commandPath,
    payloadPath,
    handoffPath,
    authorizePath,
    cancelPath,
  } = run;
  const logPath = join(dir, 'upgrade.log');
  const npmCliPath = join(dir, 'npm-cli.cjs');
  const npmCalledPath = join(dir, 'npm-called');
  const releaseNpmPath = join(dir, 'release-npm');
  writeFileSync(npmCliPath, [
    "const { existsSync, writeFileSync } = require('node:fs');",
    `const releasePath = ${JSON.stringify(releaseNpmPath)};`,
    `const calledPath = ${JSON.stringify(npmCalledPath)};`,
    "function finish() {",
    "  if (!existsSync(releasePath)) return setTimeout(finish, 10);",
    "  writeFileSync(calledPath, 'called');",
    "}",
    "finish();",
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
      runId,
      lockPath,
      parentPid: 99999999,
      packageSpec: '@yeaft/webchat-agent@9.9.9-test',
      globalInstall: false,
      installDir: dir,
      logPath,
      handoffPath,
      authorizePath,
      cancelPath,
      bootstrapPath,
      runnerPath,
      commandPath,
      payloadPath,
      nodePath: process.execPath,
      npmCliPath,
      pm2CliPath: null,
      pm2AppName: null,
      ecosystemPath: null,
    },
  });

  try {
    await expect(launchWindowsUpgradeScript({
      runId,
      nodePath: process.execPath,
      bootstrapPath,
      runnerPath,
      payloadPath,
      logPath,
      handoffPath,
      authorizePath,
      cancelPath,
      lockPath,
      spawnProcess: spawn,
    })).resolves.toBe(process.execPath);
    expect(JSON.parse(readFileSync(handoffPath, 'utf8')).runnerPid).toBeGreaterThan(0);
  } finally {
    writeFileSync(releaseNpmPath, 'release');
  }
  expect(await waitForCondition(() => !existsSync(payloadPath), 5000)).toBe(true);
  expect(existsSync(npmCalledPath)).toBe(true);
  expect(existsSync(lockPath)).toBe(false);
}

async function verifyRuntimeOnNode225() {
  if (process.platform !== 'win32') return;
  const nodePath = process.env.YEAFT_NODE_22_5_PATH;
  if (!nodePath) return;

  const dir = makeTempDir('yeaft-upgrade-node225-');
  const run = createWindowsUpgradeRun(join(dir, 'upgrade-runtime'), {
    runId: 'node225',
    parentPid: process.pid,
  });
  const {
    runId,
    lockPath,
    bootstrapPath,
    runnerPath,
    commandPath,
    payloadPath,
    handoffPath,
    authorizePath,
    cancelPath,
  } = run;
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
      runId,
      lockPath,
      parentPid: 99999999,
      packageSpec,
      globalInstall: true,
      installDir: dir,
      logPath,
      handoffPath,
      authorizePath,
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
  writeFileSync(authorizePath, JSON.stringify({ runId }));

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
  expect(existsSync(lockPath)).toBe(false);
}

async function verifyRunnerWithFakeServiceCli() {
  const dir = makeTempDir('yeaft-upgrade-fake-service-');
  const run = createWindowsUpgradeRun(join(dir, 'upgrade-runtime'), {
    runId: 'fake-service',
    parentPid: process.pid,
  });
  const {
    runId,
    lockPath,
    runnerPath,
    commandPath,
    payloadPath,
    handoffPath,
    authorizePath,
    cancelPath,
  } = run;
  const logPath = join(dir, 'upgrade.log');
  const npmCliPath = join(dir, 'npm-cli.cjs');
  const pm2CliPath = join(dir, 'pm2-cli.cjs');
  const ecosystemPath = join(dir, 'ecosystem.config.cjs');
  const eventsPath = join(dir, 'events.jsonl');
  const packageSpec = '@yeaft/webchat-agent@9.9.9-test';

  copyRuntimeFile('../../agent/windows-upgrade-runner.js', runnerPath);
  copyRuntimeFile('../../agent/upgrade-command.js', commandPath);
  writeFileSync(join(dirname(runnerPath), 'package.json'), JSON.stringify({ type: 'module' }));
  writeFileSync(ecosystemPath, 'module.exports = { apps: [] };');
  writeFileSync(npmCliPath, [
    "const fs = require('node:fs');",
    "fs.appendFileSync(process.env.YEAFT_TEST_EVENTS, JSON.stringify({ tool: 'npm', args: process.argv.slice(2) }) + '\\n');",
  ].join('\n'));
  writeFileSync(pm2CliPath, [
    "const fs = require('node:fs');",
    "const args = process.argv.slice(2);",
    "fs.appendFileSync(process.env.YEAFT_TEST_EVENTS, JSON.stringify({ tool: 'pm2', args }) + '\\n');",
    "if (process.env.YEAFT_TEST_FAIL_PM2 === args[0]) process.exitCode = 1;",
  ].join('\n'));
  writeFileSync(payloadPath, JSON.stringify({
    runId,
    lockPath,
    parentPid: 99999999,
    packageSpec,
    globalInstall: true,
    installDir: dir,
    logPath,
    handoffPath,
    authorizePath,
    cancelPath,
    bootstrapPath: join(dirname(runnerPath), 'windows-upgrade-bootstrap.js'),
    runnerPath,
    commandPath,
    payloadPath,
    nodePath: process.execPath,
    npmCliPath,
    pm2CliPath,
    pm2AppName: 'yeaft-upgrade-test-agent',
    ecosystemPath,
  }));
  writeFileSync(authorizePath, JSON.stringify({ runId }));

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
  expect(existsSync(lockPath)).toBe(false);

  await verifyRunnerRestoreFailure(dir, { npmCliPath, pm2CliPath, ecosystemPath, packageSpec }, 'start');
  await verifyRunnerRestoreFailure(dir, { npmCliPath, pm2CliPath, ecosystemPath, packageSpec }, 'save');
}

async function verifyRunnerRestoreFailure(dir, runtime, failedCommand) {
  const run = createWindowsUpgradeRun(join(dir, `failure-${failedCommand}`), {
    runId: `fail-${failedCommand}`,
    parentPid: process.pid,
  });
  const runnerPath = join(run.runDir, 'windows-upgrade-runner.js');
  const commandPath = join(run.runDir, 'upgrade-command.js');
  const eventsPath = join(run.runDir, 'events.jsonl');
  copyRuntimeFile('../../agent/windows-upgrade-runner.js', runnerPath);
  copyRuntimeFile('../../agent/upgrade-command.js', commandPath);
  writeFileSync(join(run.runDir, 'package.json'), JSON.stringify({ type: 'module' }));
  writeFileSync(run.payloadPath, JSON.stringify({
    ...run,
    parentPid: 99999999,
    packageSpec: runtime.packageSpec,
    globalInstall: true,
    installDir: dir,
    logPath: join(run.runDir, 'upgrade.log'),
    nodePath: process.execPath,
    npmCliPath: runtime.npmCliPath,
    pm2CliPath: runtime.pm2CliPath,
    pm2AppName: 'yeaft-upgrade-test-agent',
    ecosystemPath: runtime.ecosystemPath,
  }));
  writeFileSync(run.authorizePath, JSON.stringify({ runId: run.runId }));

  const exitCode = await runChild(process.execPath, [runnerPath, run.payloadPath], {
    cwd: run.runDir,
    env: {
      ...process.env,
      YEAFT_TEST_EVENTS: eventsPath,
      YEAFT_TEST_FAIL_PM2: failedCommand,
    },
    stdio: 'ignore',
    windowsHide: true,
  });
  expect(exitCode).toBe(1);
  expect(existsSync(run.lockPath)).toBe(false);
  const events = readJsonLines(eventsPath);
  expect(events.filter(event => event.tool === 'pm2' && event.args[0] === failedCommand)).toHaveLength(3);
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