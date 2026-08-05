import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs';
import { execSync } from 'child_process';
import { homedir, platform } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
  getConfigDir,
  getDefaultYeaftDir,
  getNodePath,
  resolveServiceInstanceId,
  resolveYeaftDir,
  validateInstanceId,
} from './service/config.js';

const LOCAL_SERVICE_PREFIX = 'yeaft-local';
const DEFAULT_PORT = 6868;

/** Parse local service identity, runtime port, and resolved persistent data root. */
export function parseLocalServiceArgs(args, env = process.env, options = {}) {
  const parsed = {
    name: resolveServiceInstanceId(args, env),
    port: DEFAULT_PORT,
    yeaftDir: null,
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const value = args[index + 1];
    if (arg === '--name' || arg === '--instance' || arg === '--yeaft-dir') {
      if (!value || value.startsWith('-')) throw new Error(`${arg} requires a value`);
      index += 1;
    } else if (arg === '--port') {
      if (!value || value.startsWith('-')) throw new Error('--port requires a value');
      if (!/^\d+$/.test(value)) throw new Error(`Invalid port: ${value}`);
      parsed.port = Number(value);
      if (parsed.port < 1 || parsed.port > 65535) throw new Error(`Invalid port: ${value}`);
      index += 1;
    } else {
      throw new Error(`Unknown local service option: ${arg}`);
    }
  }
  parsed.name = validateInstanceId(parsed.name);
  const existing = options.existing || null;
  const hasExplicitYeaftDir = args.includes('--yeaft-dir') || Boolean(env.YEAFT_DIR);
  parsed.yeaftDir = hasExplicitYeaftDir
    ? resolveYeaftDir(args, env, parsed.name)
    : existing?.yeaftDir || getDefaultYeaftDir(parsed.name);
  return parsed;
}

export function getLocalServiceName(name) {
  return `${LOCAL_SERVICE_PREFIX}@${validateInstanceId(name)}`;
}

export function getLocalServiceConfigPath(name) {
  return join(getConfigDir(name), 'local.json');
}

export function getLocalSystemdServicePath(name) {
  return join(homedir(), '.config', 'systemd', 'user', `${getLocalServiceName(name)}.service`);
}

export function getLocalSystemdUnitPath(name) {
  return getLocalSystemdServicePath(name);
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function systemdEscape(value) {
  return String(value)
    .replaceAll('%', '%%')
    .replaceAll('\\', '\\\\')
    .replaceAll('"', '\\"');
}

/** Read the persisted local service settings, including its resolved data root. */
export function readLocalServiceConfig(name) {
  const path = getLocalServiceConfigPath(name);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    if (!parsed || typeof parsed !== 'object') return null;
    const configName = validateInstanceId(parsed.name || name);
    return {
      name: configName,
      port: Number(parsed.port) || DEFAULT_PORT,
      yeaftDir: typeof parsed.yeaftDir === 'string' && parsed.yeaftDir
        ? parsed.yeaftDir
        : getDefaultYeaftDir(configName),
    };
  } catch {
    return null;
  }
}

/** Persist the local service settings selected at install time. */
export function writeLocalServiceConfig(config) {
  const path = getLocalServiceConfigPath(config.name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
}

function requireLocalServiceConfig(name) {
  const config = readLocalServiceConfig(name);
  if (!config) {
    throw new Error(`Local service not installed for ${name}. Run "yeaft-agent local install --name ${name}" first.`);
  }
  return config;
}

export function generateLocalSystemdUnit(config, options = {}) {
  const nodePath = getNodePath();
  const cliPath = options.cliPath || join(dirname(fileURLToPath(import.meta.url)), 'cli.js');
  const localDataDir = options.dataDir || join(homedir(), '.yeaft', 'server');
  const yeaftDir = config.yeaftDir || getDefaultYeaftDir(config.name);
  const logDir = join(getConfigDir(config.name), 'logs');
  const workingDirectory = options.workingDirectory || dirname(cliPath);
  const command = [
    shellQuote(nodePath),
    shellQuote(cliPath),
    'local',
    '--name',
    shellQuote(config.name),
    '--port',
    String(config.port),
  ].join(' ');
  return `[Unit]
Description=Yeaft Local Web UI (${config.name})
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${command}
Restart=on-failure
RestartSec=5
WorkingDirectory=${workingDirectory}
Environment="YEAFT_LOCAL_RUN=true"
Environment="YEAFT_AGENT_INSTANCE=${systemdEscape(config.name)}"
Environment="YEAFT_DIR=${systemdEscape(yeaftDir)}"
Environment="SERVER_DATA_DIR=${systemdEscape(localDataDir)}"
StandardOutput=append:${logDir}/out.log
StandardError=append:${logDir}/error.log

[Install]
WantedBy=default.target
`;
}

function installLinux(config) {
  const path = getLocalSystemdServicePath(config.name);
  const logDir = join(getConfigDir(config.name), 'logs');
  mkdirSync(dirname(path), { recursive: true });
  mkdirSync(logDir, { recursive: true });
  writeFileSync(path, generateLocalSystemdUnit(config));
  execSync('systemctl --user daemon-reload');
  execSync(`systemctl --user enable --now ${getLocalServiceName(config.name)}`);
  console.log(`Local service installed and started: ${getLocalServiceName(config.name)}`);
  console.log(`Open http://127.0.0.1:${config.port}`);
  console.log(`For boot without an active login session: sudo loginctl enable-linger $(whoami)`);
}

function uninstallLinux(name) {
  const serviceName = getLocalServiceName(name);
  const path = getLocalSystemdServicePath(name);
  try { execSync(`systemctl --user disable --now ${serviceName}`, { stdio: 'ignore' }); } catch {}
  if (existsSync(path)) unlinkSync(path);
  try { execSync('systemctl --user daemon-reload'); } catch {}
  console.log(`Local service uninstalled: ${serviceName}`);
}

function controlLinux(command, name) {
  const serviceName = getLocalServiceName(name);
  if (command === 'status') {
    try { execSync(`systemctl --user status ${serviceName} --no-pager`, { stdio: 'inherit' }); } catch {}
    return;
  }
  if (command === 'logs') {
    execSync(`journalctl --user -u ${serviceName} -f --no-pager -n 100`, { stdio: 'inherit' });
    return;
  }
  execSync(`systemctl --user ${command} ${serviceName}`, { stdio: 'inherit' });
  const verb = command === 'start' ? 'started'
    : command === 'stop' ? 'stopped'
    : command === 'restart' ? 'restarted'
    : command;
  console.log(`Local service ${verb}: ${serviceName}`);
}

export async function handleLocalServiceCommand(command, args = []) {
  const identity = parseLocalServiceArgs(args);
  if (platform() !== 'linux') {
    throw new Error(`Local managed service is currently supported on Linux only (current platform: ${platform()}). Use \`yeaft-agent local --background\` on this platform.`);
  }
  if (command === 'install') {
    const config = parseLocalServiceArgs(args, process.env, {
      existing: readLocalServiceConfig(identity.name),
    });
    writeLocalServiceConfig(config);
    installLinux(config);
    return;
  }
  if (command === 'uninstall') {
    uninstallLinux(identity.name);
    return;
  }
  const config = requireLocalServiceConfig(identity.name);
  controlLinux(command, config.name);
}
