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

function getWinWrapperPath() {
  return join(getConfigDir(), 'run.vbs');
}

function getWinBatPath() {
  return join(getConfigDir(), 'run.bat');
}

function winInstall(config) {
  const nodePath = getNodePath();
  const cliPath = getCliPath();
  const logDir = getLogDir();

  // Build environment variable settings for the batch file
  const envLines = [];
  if (config.serverUrl) envLines.push(`set "SERVER_URL=${config.serverUrl}"`);
  if (config.agentName) envLines.push(`set "AGENT_NAME=${config.agentName}"`);
  if (config.agentSecret) envLines.push(`set "AGENT_SECRET=${config.agentSecret}"`);
  if (config.workDir) envLines.push(`set "WORK_DIR=${config.workDir}"`);

  // Create a batch file that sets env vars and starts node
  const batContent = `@echo off\r\n${envLines.join('\r\n')}\r\n"${nodePath}" "${cliPath}"\r\n`;
  const batPath = getWinBatPath();
  writeFileSync(batPath, batContent);

  // Create VBS wrapper to run hidden (no console window)
  const vbsContent = `Set WshShell = CreateObject("WScript.Shell")\r\nWshShell.Run """${batPath}""", 0, False\r\n`;
  const vbsPath = getWinWrapperPath();
  writeFileSync(vbsPath, vbsContent);

  // Remove existing task if any
  try { execSync(`schtasks /delete /tn "${WIN_TASK_NAME}" /f 2>nul`, { stdio: 'pipe' }); } catch {}

  // Create scheduled task that runs at logon
  execSync(
    `schtasks /create /tn "${WIN_TASK_NAME}" /tr "wscript.exe \\"${vbsPath}\\"" /sc onlogon /rl highest /f`,
    { stdio: 'pipe' }
  );

  // Also start it now
  execSync(`schtasks /run /tn "${WIN_TASK_NAME}"`, { stdio: 'pipe' });

  console.log('Service installed and started.');
  console.log(`\nManage with:`);
  console.log(`  yeaft-agent status`);
  console.log(`  yeaft-agent logs`);
  console.log(`  yeaft-agent restart`);
  console.log(`  yeaft-agent uninstall`);
}

function winUninstall() {
  try { winStop(); } catch {}
  try { execSync(`schtasks /delete /tn "${WIN_TASK_NAME}" /f`, { stdio: 'pipe' }); } catch {}
  // Clean up wrapper files
  const vbsPath = getWinWrapperPath();
  const batPath = getWinBatPath();
  if (existsSync(vbsPath)) unlinkSync(vbsPath);
  if (existsSync(batPath)) unlinkSync(batPath);
  console.log('Service uninstalled.');
}

function winStart() {
  try {
    execSync(`schtasks /run /tn "${WIN_TASK_NAME}"`, { stdio: 'pipe' });
    console.log('Service started.');
  } catch {
    console.error('Service not installed. Run "yeaft-agent install" first.');
    process.exit(1);
  }
}

function winStop() {
  // Find and kill the node process running cli.js
  try {
    const output = execSync('wmic process where "name=\'node.exe\'" get processid,commandline /format:csv', {
      encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe']
    });
    for (const line of output.split('\n')) {
      if (line.includes('cli.js') && line.includes(SERVICE_NAME)) {
        const pid = line.trim().split(',').pop();
        if (pid && /^\d+$/.test(pid)) {
          execSync(`taskkill /pid ${pid} /f`, { stdio: 'pipe' });
        }
      }
    }
  } catch {}
  // Also try to end the task
  try { execSync(`schtasks /end /tn "${WIN_TASK_NAME}"`, { stdio: 'pipe' }); } catch {}
  console.log('Service stopped.');
}

function winRestart() {
  winStop();
  // Brief pause to ensure cleanup
  execSync('ping -n 2 127.0.0.1 >nul', { stdio: 'pipe' });
  winStart();
}

function winStatus() {
  try {
    const output = execSync(`schtasks /query /tn "${WIN_TASK_NAME}" /fo csv /v`, {
      encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe']
    });
    const lines = output.trim().split('\n');
    if (lines.length >= 2) {
      // Parse CSV header + data
      const headers = lines[0].split('","').map(h => h.replace(/"/g, ''));
      const values = lines[1].split('","').map(v => v.replace(/"/g, ''));
      const statusIdx = headers.indexOf('Status');
      const status = statusIdx >= 0 ? values[statusIdx] : 'Unknown';
      console.log(`Service status: ${status}`);
      console.log(`Task name: ${WIN_TASK_NAME}`);
    }
  } catch {
    console.log('Service is not installed.');
  }
}

function winLogs() {
  const logFile = join(getLogDir(), 'out.log');
  if (existsSync(logFile)) {
    // Windows: use PowerShell Get-Content -Wait (like tail -f)
    const child = spawn('powershell', ['-Command', `Get-Content -Path "${logFile}" -Tail 100 -Wait`], {
      stdio: 'inherit'
    });
    child.on('error', () => {
      console.log(readFileSync(logFile, 'utf-8'));
    });
  } else {
    console.log('No logs found.');
  }
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
