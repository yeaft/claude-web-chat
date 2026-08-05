import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs';
import { execSync } from 'child_process';
import { homedir, platform } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
  getConfigDir,
  getDefaultAgentName,
  getDefaultYeaftDir,
  getNodePath,
  resolveDisplayName,
  validateInstanceId,
} from './service/config.js';

const LOCAL_SERVICE_PREFIX = 'yeaft-local';
const DEFAULT_PORT = 6868;

export function parseLocalServiceArgs(args, env = process.env) {
  const options = {
    name: resolveDisplayName(args, env, getDefaultAgentName()),
    port: DEFAULT_PORT,
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const value = args[index + 1];
    if (arg === '--name') {
      if (!value || value.startsWith('-')) throw new Error('--name requires a value');
      index += 1;
    } else if (arg === '--port') {
      if (!value || value.startsWith('-')) throw new Error('--port requires a value');
      if (!/^\d+$/.test(value)) throw new Error(`Invalid port: ${value}`);
      options.port = Number(value);
      if (options.port < 1 || options.port > 65535) throw new Error(`Invalid port: ${value}`);
      index += 1;
    } else {
      throw new Error(`Unknown local service option: ${arg}`);
    }
  }
  options.name = validateInstanceId(options.name);
  return options;
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
  return String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"');
}

function readLocalServiceConfig(name) {
  const path = getLocalServiceConfigPath(name);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    if (!parsed || typeof parsed !== 'object') return null;
    return {
      name: validateInstanceId(parsed.name || name),
      port: Number(parsed.port) || DEFAULT_PORT,
    };
  } catch {
    return null;
  }
}

function writeLocalServiceConfig(config) {
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
Environment="YEAFT_DIR=${systemdEscape(getDefaultYeaftDir(config.name))}"
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
  const config = parseLocalServiceArgs(args);
  if (platform() !== 'linux') {
    throw new Error(`Local managed service is currently supported on Linux only (current platform: ${platform()}). Use \`yeaft-agent local --background\` on this platform.`);
  }
  if (command === 'install') {
    writeLocalServiceConfig(config);
    installLinux(config);
    return;
  }
  if (command === 'uninstall') {
    uninstallLinux(config.name);
    return;
  }
  requireLocalServiceConfig(config.name);
  controlLinux(command, config.name);
}
