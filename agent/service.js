/**
 * Cross-platform service management for yeaft-agent
 * Supports: Linux (systemd), macOS (launchd), Windows (Task Scheduler)
 */
import { execSync, spawn } from 'child_process';
import { existsSync, mkdirSync, writeFileSync, readFileSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import { platform, homedir } from 'os';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVICE_NAME = 'yeaft-agent';

/**
 * Load .env file from agent directory (or cwd) into process.env
 * Only sets vars that are not already set (won't override existing env)
 */
function loadDotenv() {
  // Try agent source directory first, then cwd
  const candidates = [join(__dirname, '.env'), join(process.cwd(), '.env')];
  for (const envPath of candidates) {
    if (!existsSync(envPath)) continue;
    try {
      const content = readFileSync(envPath, 'utf-8');
      for (const line of content.split('\n')) {
        const match = line.match(/^\s*([^#][^=]*)\s*=\s*(.*)$/);
        if (match) {
          const key = match[1].trim();
          let value = match[2].trim();
          value = value.replace(/^["']|["']$/g, '');
          // Don't override existing env vars
          if (!process.env[key]) {
            process.env[key] = value;
          }
        }
      }
      return; // loaded successfully, stop
    } catch {
      // continue to next candidate
    }
  }
}

// Standard config/log directory per platform
export function getConfigDir() {
  if (platform() === 'win32') {
    return join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), SERVICE_NAME);
  }
  return join(homedir(), '.config', SERVICE_NAME);
}

export function getLogDir() {
  return join(getConfigDir(), 'logs');
}

export function getConfigPath() {
  return join(getConfigDir(), 'config.json');
}

/** Save agent configuration to standard location */
export function saveServiceConfig(config) {
  const dir = getConfigDir();
  mkdirSync(dir, { recursive: true });
  mkdirSync(getLogDir(), { recursive: true });
  writeFileSync(getConfigPath(), JSON.stringify(config, null, 2));
}

/** Load agent configuration from standard location */
export function loadServiceConfig() {
  const configPath = getConfigPath();
  if (!existsSync(configPath)) return null;
  try {
    return JSON.parse(readFileSync(configPath, 'utf-8'));
  } catch {
    return null;
  }
}

/** Resolve the full path to the node binary */
function getNodePath() {
  return process.execPath;
}

/** Resolve the full path to cli.js */
function getCliPath() {
  return join(__dirname, 'cli.js');
}

/**
 * Parse --server/--name/--secret/--work-dir from args, merge with existing config
 */
export function parseServiceArgs(args) {
  // Load .env if available (for dev / source-based usage)
  loadDotenv();

  const existing = loadServiceConfig() || {};
  const config = {
    serverUrl: existing.serverUrl || '',
    agentName: existing.agentName || '',
    agentSecret: existing.agentSecret || '',
    workDir: existing.workDir || '',
  };

  // Environment variables override saved config
  if (process.env.SERVER_URL) config.serverUrl = process.env.SERVER_URL;
  if (process.env.AGENT_NAME) config.agentName = process.env.AGENT_NAME;
  if (process.env.AGENT_SECRET) config.agentSecret = process.env.AGENT_SECRET;
  if (process.env.WORK_DIR) config.workDir = process.env.WORK_DIR;

  // CLI args override everything
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];
    switch (arg) {
      case '--server': if (next) { config.serverUrl = next; i++; } break;
      case '--name': if (next) { config.agentName = next; i++; } break;
      case '--secret': if (next) { config.agentSecret = next; i++; } break;
      case '--work-dir': if (next) { config.workDir = next; i++; } break;
    }
  }

  return config;
}

function validateConfig(config) {
  if (!config.serverUrl) {
    console.error('Error: --server <url> is required');
    process.exit(1);
  }
  if (!config.agentSecret) {
    console.error('Error: --secret <secret> is required');
    process.exit(1);
  }
}

// ─── Linux (systemd) ─────────────────────────────────────────

function getSystemdServicePath() {
  const dir = join(homedir(), '.config', 'systemd', 'user');
  mkdirSync(dir, { recursive: true });
  return join(dir, `${SERVICE_NAME}.service`);
}

function generateSystemdUnit(config) {
  const nodePath = getNodePath();
  const cliPath = getCliPath();
  const envLines = [];
  if (config.serverUrl) envLines.push(`Environment=SERVER_URL=${config.serverUrl}`);
  if (config.agentName) envLines.push(`Environment=AGENT_NAME=${config.agentName}`);
  if (config.agentSecret) envLines.push(`Environment=AGENT_SECRET=${config.agentSecret}`);
  if (config.workDir) envLines.push(`Environment=WORK_DIR=${config.workDir}`);

  // Include node's bin dir in PATH for claude CLI access
  const nodeBinDir = dirname(nodePath);

  return `[Unit]
Description=Yeaft WebChat Agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${nodePath} ${cliPath}
WorkingDirectory=${config.workDir || homedir()}
Restart=on-failure
RestartSec=10
KillMode=process
${envLines.join('\n')}
Environment=PATH=${nodeBinDir}:${homedir()}/.local/bin:${homedir()}/.npm-global/bin:/usr/local/bin:/usr/bin:/bin

StandardOutput=append:${getLogDir()}/out.log
StandardError=append:${getLogDir()}/error.log

[Install]
WantedBy=default.target
`;
}

function linuxInstall(config) {
  const servicePath = getSystemdServicePath();
  writeFileSync(servicePath, generateSystemdUnit(config));
  execSync('systemctl --user daemon-reload');
  execSync(`systemctl --user enable ${SERVICE_NAME}`);
  execSync(`systemctl --user start ${SERVICE_NAME}`);
  console.log(`Service installed and started.`);
  console.log(`\nManage with:`);
  console.log(`  yeaft-agent status`);
  console.log(`  yeaft-agent logs`);
  console.log(`  yeaft-agent restart`);
  console.log(`  yeaft-agent uninstall`);
  console.log(`\nTo run when not logged in:`);
  console.log(`  sudo loginctl enable-linger $(whoami)`);
}

function linuxUninstall() {
  try { execSync(`systemctl --user stop ${SERVICE_NAME} 2>/dev/null`); } catch {}
  try { execSync(`systemctl --user disable ${SERVICE_NAME} 2>/dev/null`); } catch {}
  const servicePath = getSystemdServicePath();
  if (existsSync(servicePath)) unlinkSync(servicePath);
  try { execSync('systemctl --user daemon-reload'); } catch {}
  console.log('Service uninstalled.');
}

function linuxStart() {
  execSync(`systemctl --user start ${SERVICE_NAME}`, { stdio: 'inherit' });
  console.log('Service started.');
}

function linuxStop() {
  execSync(`systemctl --user stop ${SERVICE_NAME}`, { stdio: 'inherit' });
  console.log('Service stopped.');
}

function linuxRestart() {
  execSync(`systemctl --user restart ${SERVICE_NAME}`, { stdio: 'inherit' });
  console.log('Service restarted.');
}

function linuxStatus() {
  try {
    execSync(`systemctl --user status ${SERVICE_NAME}`, { stdio: 'inherit' });
  } catch {
    // systemctl status returns non-zero when service is stopped
  }
}

function linuxLogs() {
  try {
    execSync(`journalctl --user -u ${SERVICE_NAME} -f --no-pager -n 100`, { stdio: 'inherit' });
  } catch {
    // Fallback to log files
    const logFile = join(getLogDir(), 'out.log');
    if (existsSync(logFile)) {
      execSync(`tail -f -n 100 ${logFile}`, { stdio: 'inherit' });
    } else {
      console.log('No logs found.');
    }
  }
}

// ─── macOS (launchd) ─────────────────────────────────────────

function getLaunchdPlistPath() {
  const dir = join(homedir(), 'Library', 'LaunchAgents');
  mkdirSync(dir, { recursive: true });
  return join(dir, 'com.yeaft.agent.plist');
}

function generateLaunchdPlist(config) {
  const nodePath = getNodePath();
  const cliPath = getCliPath();
  const logDir = getLogDir();

  const envDict = [];
  if (config.serverUrl) envDict.push(`      <key>SERVER_URL</key>\n      <string>${config.serverUrl}</string>`);
  if (config.agentName) envDict.push(`      <key>AGENT_NAME</key>\n      <string>${config.agentName}</string>`);
  if (config.agentSecret) envDict.push(`      <key>AGENT_SECRET</key>\n      <string>${config.agentSecret}</string>`);
  if (config.workDir) envDict.push(`      <key>WORK_DIR</key>\n      <string>${config.workDir}</string>`);

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.yeaft.agent</string>
    <key>ProgramArguments</key>
    <array>
        <string>${nodePath}</string>
        <string>${cliPath}</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${config.workDir || homedir()}</string>
    <key>EnvironmentVariables</key>
    <dict>
${envDict.join('\n')}
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <dict>
        <key>SuccessfulExit</key>
        <false/>
    </dict>
    <key>ThrottleInterval</key>
    <integer>10</integer>
    <key>StandardOutPath</key>
    <string>${logDir}/out.log</string>
    <key>StandardErrorPath</key>
    <string>${logDir}/error.log</string>
</dict>
</plist>
`;
}

function macInstall(config) {
  const plistPath = getLaunchdPlistPath();
  // Unload first if exists
  if (existsSync(plistPath)) {
    try { execSync(`launchctl unload ${plistPath} 2>/dev/null`); } catch {}
  }
  writeFileSync(plistPath, generateLaunchdPlist(config));
  execSync(`launchctl load ${plistPath}`);
  console.log('Service installed and started.');
  console.log(`\nManage with:`);
  console.log(`  yeaft-agent status`);
  console.log(`  yeaft-agent logs`);
  console.log(`  yeaft-agent restart`);
  console.log(`  yeaft-agent uninstall`);
}

function macUninstall() {
  const plistPath = getLaunchdPlistPath();
  if (existsSync(plistPath)) {
    try { execSync(`launchctl unload ${plistPath}`); } catch {}
    unlinkSync(plistPath);
  }
  console.log('Service uninstalled.');
}

function macStart() {
  const plistPath = getLaunchdPlistPath();
  if (!existsSync(plistPath)) {
    console.error('Service not installed. Run "yeaft-agent install" first.');
    process.exit(1);
  }
  execSync(`launchctl load ${plistPath}`);
  console.log('Service started.');
}

function macStop() {
  const plistPath = getLaunchdPlistPath();
  if (existsSync(plistPath)) {
    execSync(`launchctl unload ${plistPath}`);
  }
  console.log('Service stopped.');
}

function macRestart() {
  macStop();
  macStart();
}

function macStatus() {
  try {
    const output = execSync(`launchctl list | grep com.yeaft.agent`, { encoding: 'utf-8' });
    if (output.trim()) {
      const parts = output.trim().split(/\s+/);
      const pid = parts[0];
      const exitCode = parts[1];
      if (pid !== '-') {
        console.log(`Service is running (PID: ${pid})`);
      } else {
        console.log(`Service is stopped (last exit code: ${exitCode})`);
      }
    } else {
      console.log('Service is not installed.');
    }
  } catch {
    console.log('Service is not installed.');
  }
}

function macLogs() {
  const logFile = join(getLogDir(), 'out.log');
  if (existsSync(logFile)) {
    execSync(`tail -f -n 100 ${logFile}`, { stdio: 'inherit' });
  } else {
    console.log('No logs found.');
  }
}

// ─── Windows (Task Scheduler) ────────────────────────────────

const WIN_TASK_NAME = 'YeaftAgent';
const PM2_APP_NAME = 'yeaft-agent';

// Legacy paths for cleanup
function getWinWrapperPath() { return join(getConfigDir(), 'run.vbs'); }
function getWinBatPath() { return join(getConfigDir(), 'run.bat'); }

function ensurePm2() {
  try {
    execSync('pm2 --version', { stdio: 'pipe' });
  } catch {
    console.log('Installing pm2...');
    execSync('npm install -g pm2', { stdio: 'inherit' });
  }
}

function getEcosystemPath() {
  return join(getConfigDir(), 'ecosystem.config.cjs');
}

function generateEcosystem(config) {
  const nodePath = getNodePath();
  const cliPath = getCliPath();
  const cliDir = dirname(cliPath);
  const logDir = getLogDir();

  const env = {};
  if (config.serverUrl) env.SERVER_URL = config.serverUrl;
  if (config.agentName) env.AGENT_NAME = config.agentName;
  if (config.agentSecret) env.AGENT_SECRET = config.agentSecret;
  if (config.workDir) env.WORK_DIR = config.workDir;

  return `module.exports = {
  apps: [{
    name: '${PM2_APP_NAME}',
    script: '${cliPath.replace(/\\/g, '\\\\')}',
    interpreter: '${nodePath.replace(/\\/g, '\\\\')}',
    cwd: '${cliDir.replace(/\\/g, '\\\\')}',
    env: ${JSON.stringify(env, null, 6)},
    autorestart: true,
    watch: false,
    max_restarts: 10,
    restart_delay: 5000,
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
    error_file: '${join(logDir, 'error.log').replace(/\\/g, '\\\\')}',
    out_file: '${join(logDir, 'out.log').replace(/\\/g, '\\\\')}',
    merge_logs: true,
    max_memory_restart: '500M',
  }]
};
`;
}

function winInstall(config) {
  ensurePm2();
  const logDir = getLogDir();
  mkdirSync(logDir, { recursive: true });

  // Generate ecosystem config
  const ecoPath = getEcosystemPath();
  writeFileSync(ecoPath, generateEcosystem(config));

  // Stop existing instance if any
  try { execSync(`pm2 delete ${PM2_APP_NAME}`, { stdio: 'pipe' }); } catch {}

  // Start with pm2
  execSync(`pm2 start "${ecoPath}"`, { stdio: 'inherit' });

  // Save pm2 process list for resurrection
  execSync('pm2 save', { stdio: 'pipe' });

  // Setup auto-start: create startup script in Windows Startup folder
  // pm2-startup doesn't work well on Windows, use Startup folder approach
  const trayScript = join(__dirname, 'scripts', 'agent-tray.ps1');
  const startupDir = join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
  const startupBat = join(startupDir, `${PM2_APP_NAME}.bat`);
  // Resurrect pm2 processes + launch tray icon
  let batContent = `@echo off\r\npm2 resurrect\r\n`;
  if (existsSync(trayScript)) {
    batContent += `start "" powershell -WindowStyle Hidden -ExecutionPolicy Bypass -File "${trayScript}"\r\n`;
  }
  writeFileSync(startupBat, batContent);

  // Launch tray now
  if (existsSync(trayScript)) {
    spawn('powershell', ['-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', trayScript], {
      detached: true, stdio: 'ignore'
    }).unref();
  }

  console.log(`\nService installed and started.`);
  console.log(`  Ecosystem: ${ecoPath}`);
  console.log(`  Startup:   ${startupBat}`);
  console.log(`\nManage with:`);
  console.log(`  yeaft-agent status`);
  console.log(`  yeaft-agent logs`);
  console.log(`  yeaft-agent restart`);
  console.log(`  yeaft-agent uninstall`);
}

function winUninstall() {
  try { execSync(`pm2 delete ${PM2_APP_NAME}`, { stdio: 'pipe' }); } catch {}
  try { execSync('pm2 save', { stdio: 'pipe' }); } catch {}
  // Clean up ecosystem config
  const ecoPath = getEcosystemPath();
  if (existsSync(ecoPath)) unlinkSync(ecoPath);
  // Clean up Startup bat
  const startupBat = join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', `${PM2_APP_NAME}.bat`);
  if (existsSync(startupBat)) unlinkSync(startupBat);
  // Clean up legacy files
  const vbsPath = getWinWrapperPath();
  const batPath = getWinBatPath();
  if (existsSync(vbsPath)) unlinkSync(vbsPath);
  if (existsSync(batPath)) unlinkSync(batPath);
  const startupVbs = join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', `${WIN_TASK_NAME}.vbs`);
  if (existsSync(startupVbs)) unlinkSync(startupVbs);
  console.log('Service uninstalled.');
}

function winStart() {
  try {
    execSync(`pm2 start ${PM2_APP_NAME}`, { stdio: 'inherit' });
  } catch {
    // Try ecosystem file
    const ecoPath = getEcosystemPath();
    if (existsSync(ecoPath)) {
      execSync(`pm2 start "${ecoPath}"`, { stdio: 'inherit' });
    } else {
      console.error('Service not installed. Run "yeaft-agent install" first.');
      process.exit(1);
    }
  }
}

function winStop() {
  try {
    execSync(`pm2 stop ${PM2_APP_NAME}`, { stdio: 'inherit' });
  } catch {
    console.error('Service not running or not installed.');
  }
}

function winRestart() {
  try {
    execSync(`pm2 restart ${PM2_APP_NAME}`, { stdio: 'inherit' });
  } catch {
    console.error('Service not running. Use "yeaft-agent start" to start.');
  }
}

function winStatus() {
  try {
    execSync(`pm2 describe ${PM2_APP_NAME}`, { stdio: 'inherit' });
  } catch {
    console.log('Service is not installed.');
  }
}

function winLogs() {
  const child = spawn('pm2', ['logs', PM2_APP_NAME, '--lines', '100'], {
    stdio: 'inherit',
    shell: true
  });
  child.on('error', () => {
    // Fallback to reading log file directly
    const logFile = join(getLogDir(), 'out.log');
    if (existsSync(logFile)) {
      console.log(readFileSync(logFile, 'utf-8'));
    } else {
      console.log('No logs found.');
    }
  });
}

// ─── Platform dispatcher ─────────────────────────────────────

const os = platform();

function ensureInstalled() {
  if (os === 'linux') {
    if (!existsSync(getSystemdServicePath())) {
      console.error('Service not installed. Run "yeaft-agent install" first.');
      process.exit(1);
    }
  } else if (os === 'darwin') {
    if (!existsSync(getLaunchdPlistPath())) {
      console.error('Service not installed. Run "yeaft-agent install" first.');
      process.exit(1);
    }
  }
  // Windows check is done inside individual functions
}

export function install(args) {
  const config = parseServiceArgs(args);
  validateConfig(config);
  saveServiceConfig(config);

  console.log(`Installing ${SERVICE_NAME} service...`);
  console.log(`  Server: ${config.serverUrl}`);
  console.log(`  Name:   ${config.agentName || '(auto)'}`);
  console.log(`  WorkDir: ${config.workDir || '(home)'}`);
  console.log('');

  if (os === 'linux') linuxInstall(config);
  else if (os === 'darwin') macInstall(config);
  else if (os === 'win32') winInstall(config);
  else {
    console.error(`Unsupported platform: ${os}`);
    console.log('You can run the agent directly: yeaft-agent --server <url> --secret <secret>');
    process.exit(1);
  }
}

export function uninstall() {
  console.log(`Uninstalling ${SERVICE_NAME} service...`);
  if (os === 'linux') linuxUninstall();
  else if (os === 'darwin') macUninstall();
  else if (os === 'win32') winUninstall();
  else { console.error(`Unsupported platform: ${os}`); process.exit(1); }
}

export function start() {
  ensureInstalled();
  if (os === 'linux') linuxStart();
  else if (os === 'darwin') macStart();
  else if (os === 'win32') winStart();
}

export function stop() {
  ensureInstalled();
  if (os === 'linux') linuxStop();
  else if (os === 'darwin') macStop();
  else if (os === 'win32') winStop();
}

export function restart() {
  ensureInstalled();
  if (os === 'linux') linuxRestart();
  else if (os === 'darwin') macRestart();
  else if (os === 'win32') winRestart();
}

export function status() {
  if (os === 'linux') linuxStatus();
  else if (os === 'darwin') macStatus();
  else if (os === 'win32') winStatus();
}

export function logs() {
  if (os === 'linux') linuxLogs();
  else if (os === 'darwin') macLogs();
  else if (os === 'win32') winLogs();
}
