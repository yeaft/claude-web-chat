/**
 * Service — shared configuration and utility functions
 */
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { platform, homedir } from 'os';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const SERVICE_NAME = 'yeaft-agent';

/**
 * Load .env file from agent directory (or cwd) into process.env
 * Only sets vars that are not already set (won't override existing env)
 */
function loadDotenv() {
  // Try agent source directory first, then cwd
  const agentDir = join(__dirname, '..');
  const candidates = [join(agentDir, '.env'), join(process.cwd(), '.env')];
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
export function getNodePath() {
  return process.execPath;
}

/** Resolve the full path to cli.js */
export function getCliPath() {
  return join(__dirname, '..', 'cli.js');
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

export function validateConfig(config) {
  if (!config.serverUrl) {
    console.error('Error: --server <url> is required');
    process.exit(1);
  }
  if (!config.agentSecret) {
    console.error('Error: --secret <secret> is required');
    process.exit(1);
  }
}
