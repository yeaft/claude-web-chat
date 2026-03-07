/**
 * Utility functions for Claude Code SDK integration
 * Path resolution, environment setup, and platform compatibility
 */

import { platform, homedir } from 'os';
import { join, dirname } from 'path';
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
 * Resolve Claude executable into { command, prefixArgs, spawnOpts } for spawn().
 * On Windows (npm install): parses .cmd wrapper to find cli.js, then calls node directly.
 * This avoids cmd.exe flash and PowerShell script execution policy issues.
 */
export function resolveClaudeCommand() {
  const execPath = getDefaultClaudeCodePath();

  if (isWindows() && execPath.toLowerCase().endsWith('.cmd')) {
    // npm 生成的 .cmd 内容固定格式，核心行是:
    //   "%_prog%" "%dp0%\node_modules\@anthropic-ai\claude-code\cli.js" %*
    // 解析出 cli.js 的相对路径，拼成绝对路径后用 node 直接调用
    try {
      const cmdContent = readFileSync(execPath, 'utf-8');
      const match = cmdContent.match(/%dp0%\\(.+?\.js)"/i) ||
                    cmdContent.match(/%dp0%\\(.+?\.js)/i);
      if (match) {
        const cliJsPath = join(dirname(execPath), match[1]);
        if (existsSync(cliJsPath)) {
          return {
            command: process.execPath, // node
            prefixArgs: [cliJsPath],
            spawnOpts: {},
          };
        }
      }
    } catch {}
    // 解析失败时 fallback: 用 powershell 执行 .ps1
    const ps1Path = execPath.slice(0, -4) + '.ps1';
    if (existsSync(ps1Path)) {
      return {
        command: 'powershell.exe',
        prefixArgs: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1Path],
        spawnOpts: {},
      };
    }
  }

  return { command: execPath, prefixArgs: [], spawnOpts: {} };
}
