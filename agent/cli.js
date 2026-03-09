#!/usr/bin/env node
/**
 * CLI entry point for @yeaft/webchat-agent
 * Parses command-line arguments and starts the agent or runs subcommands
 */
import { execSync, spawn } from 'child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { platform, homedir } from 'os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, 'package.json'), 'utf-8'));

const args = process.argv.slice(2);
const command = args[0];
const subArgs = args.slice(1);

// Service management subcommands
const SERVICE_COMMANDS = ['install', 'uninstall', 'start', 'stop', 'restart', 'status', 'logs'];

if (command === 'upgrade') {
  upgrade();
} else if (command === '--version' || command === '-v') {
  console.log(pkg.version);
} else if (command === '--help' || command === '-h') {
  printHelp();
} else if (SERVICE_COMMANDS.includes(command)) {
  handleServiceCommand(command, subArgs);
} else {
  // Normal agent startup — parse flags and set env vars
  parseAndStart(args);
}

function printHelp() {
  console.log(`
  ${pkg.name} v${pkg.version}

  Usage:
    yeaft-agent [options]              Run agent in foreground
    yeaft-agent install [options]      Install as system service
    yeaft-agent uninstall              Remove system service
    yeaft-agent start                  Start installed service
    yeaft-agent stop                   Stop installed service
    yeaft-agent restart                Restart installed service
    yeaft-agent status                 Show service status
    yeaft-agent logs                   View service logs (follow mode)
    yeaft-agent upgrade                Upgrade to latest version
    yeaft-agent --version              Show version

  Options:
    --server <url>      WebSocket server URL (default: ws://localhost:3456)
    --name <name>       Agent display name (default: Worker-{platform}-{pid})
    --secret <secret>   Agent secret for authentication
    --work-dir <dir>    Default working directory (default: cwd)
    --auto-upgrade      Check for updates on startup

  Environment variables (alternative to flags):
    SERVER_URL          WebSocket server URL
    AGENT_NAME          Agent display name
    AGENT_SECRET        Agent secret
    WORK_DIR            Working directory

  Examples:
    yeaft-agent --server wss://your-server.com --name my-worker --secret xxx
    yeaft-agent install --server wss://your-server.com --name my-worker --secret xxx
    yeaft-agent status
    yeaft-agent logs
`);
}

async function handleServiceCommand(command, args) {
  const service = await import('./service.js');
  switch (command) {
    case 'install':   service.install(args); break;
    case 'uninstall': service.uninstall(); break;
    case 'start':     service.start(); break;
    case 'stop':      service.stop(); break;
    case 'restart':   service.restart(); break;
    case 'status':    service.status(); break;
    case 'logs':      service.logs(); break;
  }
}

function parseAndStart(args) {
  // Parse CLI flags → set environment variables (env vars take precedence over flags)
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];

    switch (arg) {
      case '--server':
        if (next) { process.env.SERVER_URL = process.env.SERVER_URL || next; i++; }
        break;
      case '--name':
        if (next) { process.env.AGENT_NAME = process.env.AGENT_NAME || next; i++; }
        break;
      case '--secret':
        if (next) { process.env.AGENT_SECRET = process.env.AGENT_SECRET || next; i++; }
        break;
      case '--work-dir':
        if (next) { process.env.WORK_DIR = process.env.WORK_DIR || next; i++; }
        break;
      case '--auto-upgrade':
        checkForUpdates();
        break;
      default:
        if (arg.startsWith('-')) {
          console.warn(`Unknown option: ${arg}`);
          printHelp();
          process.exit(1);
        }
    }
  }

  // Import and start the agent
  import('./index.js');
}

async function checkForUpdates() {
  try {
    const res = await fetch(`https://registry.npmjs.org/${pkg.name}/latest`);
    if (!res.ok) return;
    const data = await res.json();
    const latest = data.version;
    if (latest && latest !== pkg.version) {
      console.log(`\n  Update available: ${pkg.version} → ${latest}`);
      console.log(`  Run "yeaft-agent upgrade" to update\n`);
    }
  } catch {
    // Silently ignore — network may be unavailable
  }
}

function upgrade() {
  console.log(`Current version: ${pkg.version}`);
  console.log('Checking for updates...');

  try {
    const latest = execSync(`npm view ${pkg.name} version`, { encoding: 'utf-8' }).trim();
    if (latest === pkg.version) {
      console.log('Already up to date.');
      return;
    }
    console.log(`Upgrading to ${latest}...`);

    if (platform() === 'win32') {
      // On Windows, the current process locks its own files. npm cannot overwrite
      // them while this process is running. Spawn a detached bat script that waits
      // for us to exit, then runs npm install, then optionally restarts the service.
      upgradeWindows(latest);
    } else {
      execSync(`npm install -g ${pkg.name}@latest`, { stdio: 'inherit' });
      console.log(`Successfully upgraded to ${latest}`);
    }
  } catch (e) {
    console.error('Upgrade failed:', e.message);
    process.exit(1);
  }
}

function upgradeWindows(latestVersion) {
  const configDir = join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'yeaft-agent');
  mkdirSync(configDir, { recursive: true });
  const logDir = join(configDir, 'logs');
  mkdirSync(logDir, { recursive: true });
  const batPath = join(configDir, 'upgrade-cli.bat');
  const logPath = join(logDir, 'upgrade.log');
  const pid = process.pid;
  const pkgSpec = `${pkg.name}@${latestVersion}`;

  const batLines = [
    '@echo off',
    'setlocal',
    `set PID=${pid}`,
    `set PKG=${pkgSpec}`,
    `set LOGFILE=${logPath}`,
    `set MAX_WAIT=30`,
    `set COUNT=0`,
    '',
    ':: Change to temp dir to avoid EBUSY on cwd',
    'cd /d "%TEMP%"',
    '',
    'echo [Upgrade] Started at %date% %time% > "%LOGFILE%"',
    'echo [Upgrade] Waiting for CLI process (PID %PID%) to exit... >> "%LOGFILE%"',
    '',
    ':WAIT_LOOP',
    'tasklist /FI "PID eq %PID%" 2>NUL | findstr /I "%PID%" >NUL',
    'if errorlevel 1 goto PID_EXITED',
    'set /A COUNT+=1',
    'if %COUNT% GEQ %MAX_WAIT% (',
    '  echo [Upgrade] Timeout waiting for PID %PID% to exit >> "%LOGFILE%"',
    '  goto PID_EXITED',
    ')',
    'ping -n 3 127.0.0.1 >NUL',
    'goto WAIT_LOOP',
    ':PID_EXITED',
    '',
    'echo [Upgrade] Process exited, running npm install -g %PKG%... >> "%LOGFILE%"',
    'call npm install -g %PKG% >> "%LOGFILE%" 2>&1',
    'if not "%errorlevel%"=="0" (',
    '  echo [Upgrade] npm install failed with exit code %errorlevel% >> "%LOGFILE%"',
    '  goto END',
    ')',
    'echo [Upgrade] Successfully upgraded. >> "%LOGFILE%"',
    '',
    ':END',
    `del /F /Q "${batPath}" 2>NUL`,
  ];

  writeFileSync(batPath, batLines.join('\r\n'));
  const child = spawn('cmd.exe', ['/c', batPath], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
  console.log(`Upgrade script spawned. This process will exit now.`);
  console.log(`The upgrade will proceed after this process exits.`);
  console.log(`Check upgrade log: ${logPath}`);
  process.exit(0);
}
