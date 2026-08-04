/**
 * Utility functions for Claude Code SDK integration
 * Path resolution, environment setup, and platform compatibility
 */

import { platform, homedir } from 'os';
import { join, win32 } from 'path';
import { existsSync, readFileSync } from 'fs';
import { execSync } from 'child_process';

/**
 * Log debug message
 */
export function logDebug(message) {
  if (process.env.DEBUG) {
    console.log('[SDK Debug]', message);
  }
}

/**
 * Build the full PATH string with common bin directories included.
 * Used by both getDefaultClaudeCodePath() and getCleanEnv().
 */
function getEnhancedPath() {
  if (isWindows()) {
    const systemPaths = [
      'C:\\Windows\\system32',
      'C:\\Windows',
      'C:\\Windows\\System32\\Wbem'
    ];
    const currentPath = process.env.PATH || process.env.Path || '';
    const pathParts = currentPath.split(';').filter(p => p);
    for (const sp of systemPaths) {
      if (!pathParts.some(p => p.toLowerCase() === sp.toLowerCase())) {
        pathParts.push(sp);
      }
    }
    return pathParts.join(';');
  } else {
    const unixPaths = [
      '/usr/local/bin',
      '/usr/bin',
      '/bin',
      '/usr/sbin',
      join(homedir(), '.local', 'bin'),
      join(homedir(), '.npm-global', 'bin'),
    ];
    if (platform() === 'darwin') {
      unixPaths.push('/opt/homebrew/bin');
    }
    // Include the directory where the current node binary lives
    // This catches nvm/fnm/volta managed node installs and their global bins
    const nodeBinDir = join(process.execPath, '..');
    unixPaths.push(nodeBinDir);

    const currentPath = process.env.PATH || '';
    const pathParts = currentPath.split(':').filter(p => p);
    for (const sp of unixPaths) {
      if (!pathParts.includes(sp)) {
        pathParts.push(sp);
      }
    }
    return pathParts.join(':');
  }
}

/**
 * Get default path to Claude Code executable
 * Tries CLAUDE_PATH env var first, then checks common install locations,
 * then auto-discovers via which/where with enhanced PATH.
 */
export function getDefaultClaudeCodePath() {
  if (process.env.CLAUDE_PATH) return process.env.CLAUDE_PATH;

  // Check common locations first (fast, no subprocess)
  if (!isWindows()) {
    const candidates = [
      '/usr/local/bin/claude',
      join(homedir(), '.local', 'bin', 'claude'),
      join(homedir(), '.npm-global', 'bin', 'claude'),
      // nvm/fnm/volta: claude installed globally lives next to node
      join(process.execPath, '..', 'claude'),
    ];
    if (platform() === 'darwin') {
      candidates.push('/opt/homebrew/bin/claude');
    }
    for (const c of candidates) {
      if (existsSync(c)) return c;
    }
  }

  // Try which/where with enhanced PATH (catches nvm, custom installs, etc.)
  try {
    const enhancedPath = getEnhancedPath();
    const cmd = isWindows() ? 'where claude' : 'which claude';
    const output = execSync(cmd, {
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 5000,
      env: { ...process.env, PATH: enhancedPath }
    }).toString().trim();
    const lines = output.split('\n').map(l => l.trim()).filter(Boolean);

    if (isWindows() && lines.length > 1) {
      // On Windows, `where` may return multiple matches. Prefer .cmd/.exe over
      // the extensionless Unix shell script that npm also creates.
      const preferred = lines.find(l => /\.(cmd|exe)$/i.test(l));
      if (preferred) return preferred;
    }

    if (lines[0]) return lines[0];
  } catch {}

  // Fallback: bare command, hope it's on PATH
  return 'claude';
}

/**
 * Create a clean environment
 * Ensures necessary environment variables and PATH entries are present
 */
export function getCleanEnv() {
  const env = { ...process.env };

  if (isWindows()) {
    if (!env.COMSPEC) {
      env.COMSPEC = 'C:\\Windows\\system32\\cmd.exe';
    }
    if (!env.SystemRoot) {
      env.SystemRoot = 'C:\\Windows';
    }
  }

  env.PATH = getEnhancedPath();
  return env;
}

/**
 * Stream async messages to stdin
 */
export async function streamToStdin(stream, stdin, abort) {
  for await (const message of stream) {
    if (abort?.aborted) break;
    stdin.write(JSON.stringify(message) + '\n');
  }
  stdin.end();
}

/**
 * Check if running on Windows
 */
export function isWindows() {
  return platform() === 'win32';
}

/**
 * Resolve a Windows npm .cmd shim to the real Claude entrypoint.
 *
 * Earlier Claude Code releases exposed a JavaScript CLI. Current releases expose
 * a native `bin/claude.exe`. Calling the generated PowerShell shim is unsafe for
 * our long-lived stream-json stdin: the shim pipes `$input` and waits for EOF
 * before starting Claude, so the first user message never reaches the CLI.
 */
export function resolveWindowsClaudeCommand(execPath, {
  readFile = path => readFileSync(path, 'utf-8'),
  fileExists = existsSync,
  nodeExecutable = process.execPath,
} = {}) {
  let cmdContent;
  try {
    cmdContent = readFile(execPath);
  } catch (error) {
    throw new Error(`Failed to read Claude Code command shim at ${execPath}: ${error.message}`);
  }

  const targetPaths = [...cmdContent.matchAll(/%dp0%\\([^"\r\n]+?\.(?:exe|js))(?=["\s])/gi)]
    .map(match => win32.resolve(win32.dirname(execPath), match[1]));
  const targetPath = targetPaths.find(path => path.toLowerCase().endsWith('.js') && fileExists(path))
    || targetPaths.find(path => win32.basename(path).toLowerCase() === 'claude.exe' && fileExists(path));
  if (!targetPath) {
    throw new Error(`Claude Code command shim at ${execPath} could not resolve the executable target`);
  }

  if (targetPath.toLowerCase().endsWith('.js')) {
    return { command: nodeExecutable, prefixArgs: [targetPath], spawnOpts: {} };
  }
  return { command: targetPath, prefixArgs: [], spawnOpts: {} };
}

/**
 * Resolve Claude executable into { command, prefixArgs, spawnOpts } for spawn().
 */
export function resolveClaudeCommand() {
  const execPath = getDefaultClaudeCodePath();

  if (isWindows() && execPath.toLowerCase().endsWith('.cmd')) {
    return resolveWindowsClaudeCommand(execPath);
  }

  return { command: execPath, prefixArgs: [], spawnOpts: {} };
}
