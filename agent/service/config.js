/*
 * Service — shared configuration and utility functions
 */
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { platform, homedir, hostname } from 'os';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const SERVICE_NAME = 'yeaft-agent';
export const DEFAULT_INSTANCE_ID = 'default';

export function getDefaultAgentName(machineName = hostname()) {
  const raw = String(machineName || '');
  if (!raw) return DEFAULT_INSTANCE_ID;
  return raw.replace(/[^A-Za-z0-9._-]/gu, '-');
}

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

export function normalizeInstanceId(instanceId) {
  const raw = String(instanceId || '').trim();
  return raw || DEFAULT_INSTANCE_ID;
}

export function isDefaultInstance(instanceId) {
  return normalizeInstanceId(instanceId) === DEFAULT_INSTANCE_ID;
}

export function validateInstanceId(instanceId) {
  const normalized = normalizeInstanceId(instanceId);
  if (!/^[A-Za-z0-9_.-]+$/.test(normalized)) {
    throw new Error('Instance id may only contain letters, numbers, dot, underscore, or dash');
  }
  return normalized;
}

function readIdentityArgs(args = []) {
  let deprecatedInstanceId = null;
  let explicitName = null;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];
    if (arg !== '--instance' && arg !== '--name') continue;
    if (!next || next.startsWith('-')) {
      throw new Error(`${arg} requires a value`);
    }
    if (arg === '--name') {
      explicitName = validateInstanceId(next);
    } else {
      deprecatedInstanceId = validateInstanceId(next);
    }
    i++;
  }
  return { deprecatedInstanceId, explicitName };
}

export function resolveDisplayName(args = [], env = process.env, fallbackName = getDefaultAgentName()) {
  const { explicitName } = readIdentityArgs(args);
  return explicitName
    || env.AGENT_NAME
    || fallbackName
    || getDefaultAgentName();
}

export function resolveRuntimeIdentity(fileConfig = {}, env = process.env) {
  const agentName = resolveDisplayName([], env, fileConfig.agentName || getDefaultAgentName());
  const instanceId = validateInstanceId(env.YEAFT_AGENT_INSTANCE || fileConfig.instanceId || DEFAULT_INSTANCE_ID);
  return { agentName, instanceId };
}

export function shouldLoadLegacyLocalConfig(env = process.env) {
  return !String(env.YEAFT_AGENT_INSTANCE || '').trim();
}

export function resolveServiceInstanceId(args = [], env = process.env, options = {}) {
  const { deprecatedInstanceId, explicitName } = readIdentityArgs(args);
  if (explicitName) return explicitName;
  if (deprecatedInstanceId) return deprecatedInstanceId;
  if (env.YEAFT_AGENT_INSTANCE) return validateInstanceId(env.YEAFT_AGENT_INSTANCE);
  if (options.management) return DEFAULT_INSTANCE_ID;
  if (env.AGENT_NAME) return validateInstanceId(env.AGENT_NAME);
  return validateInstanceId(options.fallbackName || getDefaultAgentName());
}

/** Resolve the CLI/env/default Yeaft data root for one Agent instance. */
export function resolveYeaftDir(args = [], env = process.env, instanceId = DEFAULT_INSTANCE_ID) {
  let explicitYeaftDir = null;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== '--yeaft-dir') continue;
    const value = args[index + 1];
    if (!value || value.startsWith('-')) throw new Error('--yeaft-dir requires a value');
    explicitYeaftDir = value;
    index += 1;
  }
  return explicitYeaftDir || env.YEAFT_DIR || getDefaultYeaftDir(instanceId);
}

/** Legacy alias for resolveServiceInstanceId(). */
export function getInstanceIdFromArgs(args = [], env = process.env, options = {}) {
  return resolveServiceInstanceId(args, env, options);
}

export function applyAgentIdentityToEnv(args = [], env = process.env) {
  const { deprecatedInstanceId, explicitName } = readIdentityArgs(args);
  if (explicitName) {
    env.YEAFT_AGENT_INSTANCE = explicitName;
    env.AGENT_NAME = explicitName;
  } else if (deprecatedInstanceId) {
    env.YEAFT_AGENT_INSTANCE = deprecatedInstanceId;
  } else if (!env.YEAFT_AGENT_INSTANCE && env.AGENT_NAME) {
    env.YEAFT_AGENT_INSTANCE = validateInstanceId(env.AGENT_NAME);
  } else if (env.YEAFT_AGENT_INSTANCE) {
    env.YEAFT_AGENT_INSTANCE = validateInstanceId(env.YEAFT_AGENT_INSTANCE);
  }
  return env.YEAFT_AGENT_INSTANCE || null;
}

export function warnDeprecatedInstanceArg(args = [], warn = console.warn) {
  if (args.includes('--instance')) {
    warn('Warning: --instance is deprecated; use --name instead. --name takes precedence when both are provided.');
  }
}

export function getServiceName(instanceId = DEFAULT_INSTANCE_ID) {
  const normalized = validateInstanceId(instanceId);
  return isDefaultInstance(normalized) ? SERVICE_NAME : `${SERVICE_NAME}@${normalized}`;
}

export function getPm2AppName(instanceId = DEFAULT_INSTANCE_ID) {
  const normalized = validateInstanceId(instanceId);
  return isDefaultInstance(normalized) ? SERVICE_NAME : `${SERVICE_NAME}-${normalized}`;
}

export function getLaunchdLabel(instanceId = DEFAULT_INSTANCE_ID) {
  const normalized = validateInstanceId(instanceId);
  return isDefaultInstance(normalized) ? 'com.yeaft.agent' : `com.yeaft.agent.${normalized}`;
}

export function getDefaultYeaftDir(instanceId = DEFAULT_INSTANCE_ID) {
  const normalized = validateInstanceId(instanceId);
  return isDefaultInstance(normalized)
    ? join(homedir(), '.yeaft')
    : join(homedir(), '.yeaft', 'instances', normalized);
}

function getBaseConfigDir() {
  if (platform() === 'win32') {
    return join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), SERVICE_NAME);
  }
  return join(homedir(), '.config', SERVICE_NAME);
}

// Standard config/log directory per platform. The default instance keeps the
// historical paths for compatibility; named instances live under instances/<id>.
export function getConfigDir(instanceId = process.env.YEAFT_AGENT_INSTANCE || DEFAULT_INSTANCE_ID) {
  const normalized = validateInstanceId(instanceId);
  const base = getBaseConfigDir();
  return isDefaultInstance(normalized) ? base : join(base, 'instances', normalized);
}

export function getLogDir(instanceId = process.env.YEAFT_AGENT_INSTANCE || DEFAULT_INSTANCE_ID) {
  return join(getConfigDir(instanceId), 'logs');
}

export function getConfigPath(instanceId = process.env.YEAFT_AGENT_INSTANCE || DEFAULT_INSTANCE_ID) {
  return join(getConfigDir(instanceId), 'config.json');
}

/** Save agent configuration to standard location */
export function saveServiceConfig(config) {
  const instanceId = validateInstanceId(config.instanceId || DEFAULT_INSTANCE_ID);
  const dir = getConfigDir(instanceId);
  mkdirSync(dir, { recursive: true });
  mkdirSync(getLogDir(instanceId), { recursive: true });
  writeFileSync(getConfigPath(instanceId), JSON.stringify({ ...config, instanceId }, null, 2));
}

/** Load agent configuration from standard location */
export function loadServiceConfig(instanceId = process.env.YEAFT_AGENT_INSTANCE || DEFAULT_INSTANCE_ID) {
  const normalized = validateInstanceId(instanceId);
  const configPath = getConfigPath(normalized);
  if (!existsSync(configPath)) return null;
  try {
    const loaded = JSON.parse(readFileSync(configPath, 'utf-8'));
    return { ...loaded, instanceId: loaded.instanceId || normalized };
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
 * Parse service options from args, merging with the selected instance config.
 */
export function parseServiceArgs(args) {
  // Load .env if available (for dev / source-based usage)
  loadDotenv();

  const instanceId = resolveServiceInstanceId(args, process.env, { management: true });
  const existing = loadServiceConfig(instanceId) || {};
  const explicitIdentity = args.includes('--name') || args.includes('--instance');
  const fallbackName = explicitIdentity
    ? instanceId
    : existing.agentName || getDefaultAgentName();
  const config = {
    instanceId,
    serverUrl: existing.serverUrl || '',
    agentName: resolveDisplayName(
      args,
      explicitIdentity ? { ...process.env, AGENT_NAME: '' } : process.env,
      fallbackName,
    ),
    agentSecret: existing.agentSecret || '',
    workDir: existing.workDir || '',
    yeaftDir: existing.yeaftDir || '',
  };

  // Environment variables override saved config
  if (process.env.SERVER_URL) config.serverUrl = process.env.SERVER_URL;
  if (process.env.AGENT_SECRET) config.agentSecret = process.env.AGENT_SECRET;
  if (process.env.WORK_DIR) config.workDir = process.env.WORK_DIR;
  if (process.env.YEAFT_DIR) config.yeaftDir = process.env.YEAFT_DIR;

  // CLI args override everything
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];
    switch (arg) {
      case '--instance': if (next) { i++; } break;
      case '--server': if (next) { config.serverUrl = next; i++; } break;
      case '--name': if (next) { i++; } break;
      case '--secret': if (next) { config.agentSecret = next; i++; } break;
      case '--work-dir': if (next) { config.workDir = next; i++; } break;
      case '--yeaft-dir': if (next) { config.yeaftDir = next; i++; } break;
    }
  }

  return config;
}

export function validateConfig(config) {
  try {
    validateInstanceId(config.instanceId || DEFAULT_INSTANCE_ID);
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
  if (!config.serverUrl) {
    console.error('Error: --server <url> is required');
    process.exit(1);
  }
  if (!config.agentSecret) {
    console.error('Error: --secret <secret> is required');
    process.exit(1);
  }
}
