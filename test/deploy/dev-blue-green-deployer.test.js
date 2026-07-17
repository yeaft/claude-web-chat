import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const testDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(testDir, '../..');
const sourceDeployDir = join(repoRoot, 'deploy', 'dev');

function writeExecutable(file, content) {
  writeFileSync(file, content, { mode: 0o755 });
}

function parseCalls(file) {
  const value = readFileSync(file, 'utf8').trim();
  return value ? value.split('\n').map(line => line.split('\t')) : [];
}

function getStopTargets(calls) {
  return calls
    .filter(call => call[0] === 'stop')
    .map(call => call[1]);
}

function makeHarness({
  reloadPlan = '0',
  composeExit = '0',
  holdPullSeconds = '0',
  upstreamSide = 'blue',
} = {}) {
  const root = mkdtempSync(join(tmpdir(), 'yeaft-dev-deployer-'));
  const deployDir = join(root, 'deploy');
  const binDir = join(root, 'bin');
  const dataDir = join(root, 'data');
  const stateDir = join(root, 'state');
  const homeDir = join(root, 'home');
  const callsFile = join(root, 'calls.tsv');
  const reloadCountFile = join(root, 'reload-count');
  const upstreamFile = join(root, 'dev-cc.conf');
  const envFile = join(root, 'webchat.env');
  const configFile = join(deployDir, 'deployer.env');
  const deployLockFile = join(homeDir, '.local', 'state', 'yeaft', 'dev-blue-green.lock');
  const legacyDeployCommand = join(root, 'legacy', 'deploy-blue-green.sh');

  for (const directory of [
    deployDir,
    binDir,
    dataDir,
    stateDir,
    homeDir,
    dirname(deployLockFile),
    dirname(legacyDeployCommand),
  ]) {
    mkdirSync(directory, { recursive: true });
  }

  for (const name of ['deploy-blue-green.sh', 'install-cron.sh', 'docker-compose.yaml']) {
    copyFileSync(join(sourceDeployDir, name), join(deployDir, name));
  }
  chmodSync(join(deployDir, 'deploy-blue-green.sh'), 0o755);
  chmodSync(join(deployDir, 'install-cron.sh'), 0o755);

  writeFileSync(envFile, 'AUTH_MODE=none\n');
  writeFileSync(upstreamFile, `# Blue-green upstream for test\n# Active side: ${upstreamSide}\nupstream dev_cc_backend {\n    server claude-webchat-dev-${upstreamSide}:3456;\n}\n`);
  writeFileSync(callsFile, '');
  writeFileSync(configFile, [
    'IMAGE=test/image:dev',
    `WEBCHAT_ENV_FILE=${envFile}`,
    `WEBCHAT_DATA_DIR=${dataDir}`,
    'DOCKER_NETWORK=test-network',
    'NGINX_CONTAINER=test-nginx',
    `UPSTREAM_FILE=${upstreamFile}`,
    'UPSTREAM_NAME=dev_cc_backend',
    `STATE_DIR=${stateDir}`,
    `LEGACY_DEPLOY_COMMAND=${legacyDeployCommand}`,
    'DEPLOY_HANDOFF_TIMEOUT=3',
    'DEPLOY_HANDOFF_QUIET_PERIOD=0',
    'HEALTH_TIMEOUT=1',
    'HEALTH_INTERVAL=1',
    'DRAIN_WAIT=0',
    'COMPOSE_PROJECT_NAME=test-project',
    '',
  ].join('\n'));

  writeExecutable(join(binDir, 'sleep'), '#!/usr/bin/env bash\nexit 0\n');
  writeExecutable(join(binDir, 'logger'), '#!/usr/bin/env bash\nexit 0\n');
  writeExecutable(join(binDir, 'docker'), `#!/usr/bin/env bash
set -u
args=("$@")
command="\${args[0]:-}"
arguments="\${args[*]}"
{
  printf '%s' "$command"
  for ((argument_index = 1; argument_index < \${#args[@]}; argument_index++)); do
    printf '\\t%s' "\${args[$argument_index]}"
  done
  printf '\\n'
} >> "$CALLS_FILE"
case "$command" in
  pull)
    if [[ "$HOLD_PULL_SECONDS" != "0" ]]; then /bin/sleep "$HOLD_PULL_SECONDS"; fi
    exit 0
    ;;
  image)
    printf '%s\\n' 'sha256:new'
    exit 0
    ;;
  inspect)
    if [[ "$arguments" == *'{{.State.Health.Status}}'* ]]; then
      printf '%s\\n' healthy
    elif [[ "$arguments" == *'{{.Image}}'* ]]; then
      printf '%s\\n' 'sha256:old'
    fi
    exit 0
    ;;
  network)
    exit 0
    ;;
  compose)
    if [[ " $arguments " == *' config --quiet '* ]]; then exit 0; fi
    exit "$COMPOSE_EXIT"
    ;;
  exec)
    if [[ "$arguments" == *' nginx -t'* ]]; then exit 0; fi
    if [[ "$arguments" == *' nginx -s reload'* ]]; then
      count=0
      if [[ -f "$RELOAD_COUNT_FILE" ]]; then count=$(cat "$RELOAD_COUNT_FILE"); fi
      count=$((count + 1))
      printf '%s\\n' "$count" > "$RELOAD_COUNT_FILE"
      IFS=',' read -r -a plan <<< "$RELOAD_PLAN"
      index=$((count - 1))
      status="\${plan[$index]:-0}"
      exit "$status"
    fi
    exit 0
    ;;
  stop|rm)
    exit 0
    ;;
esac
exit 0
`);

  const env = {
    ...process.env,
    HOME: homeDir,
    PATH: `${binDir}:${process.env.PATH}`,
    YEAFT_DEV_DEPLOY_CONFIG: configFile,
    CALLS_FILE: callsFile,
    RELOAD_COUNT_FILE: reloadCountFile,
    RELOAD_PLAN: reloadPlan,
    COMPOSE_EXIT: composeExit,
    HOLD_PULL_SECONDS: holdPullSeconds,
  };

  return {
    root,
    deployDir,
    script: join(deployDir, 'deploy-blue-green.sh'),
    installer: join(deployDir, 'install-cron.sh'),
    composeFile: join(deployDir, 'docker-compose.yaml'),
    configFile,
    deployLockFile,
    legacyDeployCommand,
    callsFile,
    upstreamFile,
    stateFile: join(stateDir, 'dev.state'),
    failureFile: join(stateDir, 'dev.failure'),
    switchFile: join(stateDir, 'dev.switch'),
    env,
  };
}

function runDeploy(harness, args = []) {
  return spawnSync('bash', [harness.script, ...args], {
    env: harness.env,
    encoding: 'utf8',
  });
}

function installCrontabStub(harness, initialCrontab) {
  const crontabState = join(harness.root, 'crontab.txt');
  const crontabHistory = join(harness.root, 'crontab-history.txt');

  writeFileSync(crontabState, initialCrontab);
  writeFileSync(crontabHistory, '');
  writeExecutable(join(harness.root, 'bin', 'crontab'), `#!/usr/bin/env bash
if [[ "\${1:-}" == '-l' ]]; then
  cat "$CRONTAB_STATE"
else
  cat > "$CRONTAB_STATE"
  {
    printf '%s\\n' '--- crontab write ---'
    cat "$CRONTAB_STATE"
  } >> "$CRONTAB_HISTORY"
fi
`);

  return { crontabState, crontabHistory };
}

async function waitUntil(predicate, timeoutMs = 1500) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error('Timed out waiting for test condition');
    }
    await new Promise(resolvePromise => setTimeout(resolvePromise, 10));
  }
}

describe('Yeaft dev blue-green deployer', () => {
  const roots = [];

  beforeEach(() => {
    execFileSync('bash', ['-n', join(sourceDeployDir, 'deploy-blue-green.sh')]);
    execFileSync('bash', ['-n', join(sourceDeployDir, 'install-cron.sh')]);
  });

  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('uses the dedicated compose file and keeps the active side on compose failure', () => {
    const harness = makeHarness({ composeExit: '19' });
    roots.push(harness.root);

    const result = runDeploy(harness);
    const calls = parseCalls(harness.callsFile);
    const composeCall = calls.find(call => call[0] === 'compose');

    expect(result.status).toBe(1);
    expect(composeCall).toEqual(expect.arrayContaining([
      '--project-name',
      'test-project',
      '-f',
      harness.composeFile,
      'up',
      '-d',
      'claude-webchat-dev-green',
    ]));
    expect(getStopTargets(calls)).not.toContain('claude-webchat-dev-blue');
    expect(readFileSync(harness.upstreamFile, 'utf8')).toContain('# Active side: blue');
    expect(readFileSync(harness.failureFile, 'utf8')).toContain('count=1');
  });

  it('retries after an image was pulled but the previous compose start failed', () => {
    const harness = makeHarness({ composeExit: '19' });
    roots.push(harness.root);

    const first = runDeploy(harness);
    const second = runDeploy(harness);
    let calls = parseCalls(harness.callsFile);

    expect(first.status).toBe(1);
    expect(second.status).toBe(1);
    expect(calls.filter(call => call[0] === 'compose')).toHaveLength(2);
    expect(readFileSync(harness.failureFile, 'utf8')).toContain('count=2');

    harness.env.COMPOSE_EXIT = '0';
    const third = runDeploy(harness);
    calls = parseCalls(harness.callsFile);

    expect(third.status).toBe(0);
    expect(calls.filter(call => call[0] === 'compose')).toHaveLength(3);
    expect(() => statSync(harness.failureFile)).toThrow();
  });

  it('restores and verifies the previous upstream when the new reload fails', () => {
    const harness = makeHarness({ reloadPlan: '42,0' });
    roots.push(harness.root);

    const result = runDeploy(harness);
    const calls = parseCalls(harness.callsFile);

    expect(result.status).toBe(1);
    expect(readFileSync(harness.upstreamFile, 'utf8')).toContain('# Active side: blue');
    expect(getStopTargets(calls)).not.toContain('claude-webchat-dev-blue');
    expect(getStopTargets(calls)).toContain('claude-webchat-dev-green');
    expect(calls.filter(call => call.join(' ').includes('nginx -s reload'))).toHaveLength(2);
  });

  it('leaves both app containers running when rollback reload cannot be verified', () => {
    const harness = makeHarness({ reloadPlan: '42,43' });
    roots.push(harness.root);

    const result = runDeploy(harness);
    const calls = parseCalls(harness.callsFile);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('leaving both app containers running');
    expect(readFileSync(harness.upstreamFile, 'utf8')).toContain('# Active side: blue');
    expect(getStopTargets(calls)).toEqual([]);
  });

  it('recovers an interrupted upstream transaction before checking for an image', () => {
    const harness = makeHarness({ upstreamSide: 'green' });
    roots.push(harness.root);
    writeFileSync(harness.switchFile, 'blue\n');

    const result = runDeploy(harness);
    const calls = parseCalls(harness.callsFile);
    const reloadIndex = calls.findIndex(call => call.join(' ').includes('nginx -s reload'));
    const pullIndex = calls.findIndex(call => call[0] === 'pull');

    expect(result.status).toBe(0);
    expect(readFileSync(harness.upstreamFile, 'utf8')).toContain('# Active side: green');
    expect(() => statSync(harness.switchFile)).toThrow();
    expect(reloadIndex).toBeGreaterThanOrEqual(0);
    expect(pullIndex).toBeGreaterThan(reloadIndex);
    expect(calls.filter(call => call.join(' ').includes('nginx -s reload'))).toHaveLength(2);
  });

  it('switches state before draining and only then stops the old side', () => {
    const harness = makeHarness();
    roots.push(harness.root);

    const result = runDeploy(harness);
    const calls = parseCalls(harness.callsFile);

    expect(result.status).toBe(0);
    expect(readFileSync(harness.upstreamFile, 'utf8')).toContain('# Active side: green');
    expect(readFileSync(harness.stateFile, 'utf8')).toBe('green\n');
    expect(getStopTargets(calls)).toContain('claude-webchat-dev-blue');
    expect(() => statSync(harness.failureFile)).toThrow();
  });

  it('serializes overlapping invocations from different checkouts with one host-global lock', async () => {
    const firstHarness = makeHarness({ holdPullSeconds: '1' });
    const secondHarness = makeHarness();
    roots.push(firstHarness.root, secondHarness.root);

    secondHarness.env.HOME = firstHarness.env.HOME;
    secondHarness.env.CALLS_FILE = firstHarness.callsFile;

    const first = spawn('bash', [firstHarness.script], {
      env: firstHarness.env,
      stdio: 'ignore',
    });

    await waitUntil(() => readFileSync(firstHarness.callsFile, 'utf8').includes('pull'));

    const second = runDeploy(secondHarness);
    const firstStatus = await new Promise(resolvePromise => first.once('exit', resolvePromise));
    const calls = parseCalls(firstHarness.callsFile);

    expect(second.status).toBe(0);
    expect(firstStatus).toBe(0);
    expect(calls.filter(call => call[0] === 'pull')).toHaveLength(1);
  });

  it('validates config without pulling or changing containers', () => {
    const harness = makeHarness();
    roots.push(harness.root);

    const result = runDeploy(harness, ['--check']);
    const calls = parseCalls(harness.callsFile);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('configuration is valid');
    expect(calls.some(call => call[0] === 'pull')).toBe(false);
    expect(getStopTargets(calls)).toEqual([]);
  });

  it('installer quiesces a running legacy transaction before enabling the new scheduler', async () => {
    const harness = makeHarness();
    roots.push(harness.root);
    const { crontabState, crontabHistory } = installCrontabStub(harness, [
      '0 0 * * * /usr/local/bin/backup',
      `* * * * * ${harness.legacyDeployCommand} dev >> old.log 2>&1`,
      '',
    ].join('\n'));

    writeExecutable(harness.legacyDeployCommand, '#!/usr/bin/env bash\nwhile true; do /bin/sleep 1; done\n');
    const legacy = spawn(harness.legacyDeployCommand, ['dev'], { stdio: 'ignore' });
    const installer = spawn('bash', [harness.installer], {
      env: {
        ...harness.env,
        CRONTAB_STATE: crontabState,
        CRONTAB_HISTORY: crontabHistory,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    await waitUntil(() => readFileSync(crontabHistory, 'utf8').includes('--- crontab write ---'));
    const disabled = readFileSync(crontabState, 'utf8');
    expect(disabled).toContain('/usr/local/bin/backup');
    expect(disabled).not.toContain('deploy-blue-green.sh dev');
    expect(disabled).not.toContain('yeaft-dev-blue-green-deploy');
    expect(installer.exitCode).toBeNull();

    legacy.kill('SIGTERM');
    await new Promise(resolvePromise => legacy.once('exit', resolvePromise));
    const installerStatus = await new Promise(resolvePromise => installer.once('exit', resolvePromise));
    const installed = readFileSync(crontabState, 'utf8');

    expect(installerStatus).toBe(0);
    expect(installed).toContain('/usr/local/bin/backup');
    expect(installed).not.toContain('deploy-blue-green.sh dev');
    expect(installed.match(/yeaft-dev-blue-green-deploy/g)).toHaveLength(1);
    expect(installed).toContain('/usr/bin/logger -t yeaft-dev-deployer');
  });

  it('rejects a legacy command that does not match the scheduler before changing crontab', () => {
    const harness = makeHarness();
    roots.push(harness.root);
    const originalCrontab = '* * * * * /different/deploy-blue-green.sh dev >> old.log 2>&1\n';
    const { crontabState, crontabHistory } = installCrontabStub(harness, originalCrontab);

    const result = spawnSync('bash', [harness.installer], {
      env: {
        ...harness.env,
        CRONTAB_STATE: crontabState,
        CRONTAB_HISTORY: crontabHistory,
      },
      encoding: 'utf8',
    });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('does not match the scheduler being replaced');
    expect(readFileSync(crontabState, 'utf8')).toBe(originalCrontab);
    expect(readFileSync(crontabHistory, 'utf8')).toBe('');
  });

  it('restores the original scheduler when legacy quiescence times out', async () => {
    const harness = makeHarness();
    roots.push(harness.root);
    const originalCrontab = `* * * * * ${harness.legacyDeployCommand} dev >> old.log 2>&1\n`;
    const { crontabState, crontabHistory } = installCrontabStub(harness, originalCrontab);
    const timeoutConfig = readFileSync(harness.configFile, 'utf8')
      .replace(/^DEPLOY_HANDOFF_TIMEOUT=.*$/m, 'DEPLOY_HANDOFF_TIMEOUT=1');
    writeFileSync(harness.configFile, timeoutConfig);
    writeExecutable(harness.legacyDeployCommand, '#!/usr/bin/env bash\nwhile true; do /bin/sleep 1; done\n');

    const legacy = spawn(harness.legacyDeployCommand, ['dev'], { stdio: 'ignore' });
    const result = spawnSync('bash', [harness.installer], {
      env: {
        ...harness.env,
        CRONTAB_STATE: crontabState,
        CRONTAB_HISTORY: crontabHistory,
      },
      encoding: 'utf8',
    });
    legacy.kill('SIGTERM');
    await new Promise(resolvePromise => legacy.once('exit', resolvePromise));

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Timed out waiting for the legacy dev deployment');
    expect(readFileSync(crontabState, 'utf8')).toBe(originalCrontab);
  });

  it('installs the same absolute alternate config used by preflight', () => {
    const harness = makeHarness();
    roots.push(harness.root);
    const alternateDir = join(harness.root, 'alternate config');
    const alternateConfig = join(alternateDir, 'deployer.env');
    mkdirSync(alternateDir, { recursive: true });
    copyFileSync(harness.configFile, alternateConfig);
    rmSync(harness.configFile);

    const { crontabState, crontabHistory } = installCrontabStub(
      harness,
      '0 0 * * * /usr/local/bin/backup\n',
    );
    const result = spawnSync('bash', [harness.installer], {
      env: {
        ...harness.env,
        YEAFT_DEV_DEPLOY_CONFIG: alternateConfig,
        CRONTAB_STATE: crontabState,
        CRONTAB_HISTORY: crontabHistory,
      },
      encoding: 'utf8',
    });
    const installed = readFileSync(crontabState, 'utf8');

    expect(result.status).toBe(0);
    expect(installed).toContain(`YEAFT_DEV_DEPLOY_CONFIG='${alternateConfig}'`);
    expect(installed).not.toContain(`${harness.deployDir}/deployer.env`);

    writeFileSync(harness.callsFile, '');
    const cronCommand = installed.split('\n').find(line => line.includes('yeaft-dev-blue-green-deploy'));
    const cronResult = spawnSync('bash', ['-c', cronCommand.replace(/^\* \* \* \* \* /, '')], {
      env: harness.env,
      encoding: 'utf8',
    });

    expect(cronResult.status).toBe(0);
    expect(parseCalls(harness.callsFile).some(call => call[0] === 'pull')).toBe(true);
  });

  it('rejects an alternate config path that cannot be represented safely in crontab', () => {
    const harness = makeHarness();
    roots.push(harness.root);
    const unsupportedDir = join(harness.root, "quote'path");
    const unsupportedConfig = join(unsupportedDir, 'deployer.env');
    mkdirSync(unsupportedDir, { recursive: true });
    copyFileSync(harness.configFile, unsupportedConfig);

    const result = spawnSync('bash', [harness.installer], {
      env: { ...harness.env, YEAFT_DEV_DEPLOY_CONFIG: unsupportedConfig },
      encoding: 'utf8',
    });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('unsupported by crontab');
  });

  it('compose and example config define the complete dev host contract', () => {
    const content = readFileSync(join(sourceDeployDir, 'docker-compose.yaml'), 'utf8');
    const exampleConfig = readFileSync(join(sourceDeployDir, 'deployer.env.example'), 'utf8');

    expect(exampleConfig).toContain('WEBCHAT_DATA_DIR=');
    expect(exampleConfig).toContain('DOCKER_NETWORK=');
    expect(exampleConfig).not.toContain('DEPLOY_LOCK_FILE=');
    expect(exampleConfig).toContain('LEGACY_DEPLOY_COMMAND=');
    expect(content).toContain('claude-webchat-dev-blue:');
    expect(content).toContain('claude-webchat-dev-green:');
    expect(content).toContain('external: true');
    expect(content).not.toContain('watchtower:');
    expect(content).not.toContain('claude-webchat-blue:');
    expect(readdirSync(sourceDeployDir)).not.toContain('docker-compose.yml');
  });
});
