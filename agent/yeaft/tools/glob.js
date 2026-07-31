/**
 * glob.js — Find files by pattern matching.
 *
 * Uses fd for traversal when available and the same local glob matcher in both
 * fast and fallback paths. Results are sorted by modification time (newest first).
 */

import { defineTool } from './types.js';
import { readdir, stat } from 'fs/promises';
import { existsSync } from 'fs';
import { resolve, join, relative } from 'path';
import { managedCliToolReady, resolveManagedCliCommand } from '../managed-cli.js';
import { runProcess } from './process-runner.js';

const STAT_CONCURRENCY = 32;
const SKIP_DIRS = new Set([
  'node_modules', '.git', '__pycache__', '.next', '.nuxt',
  'dist', 'build', '.cache', '.venv', 'venv', '.tox',
  'vendor', 'target', '.gradle', '.idea', '.vscode',
]);

/**
 * Simple glob pattern matcher (supports * and **).
 * @param {string} pattern
 * @param {string} str
 * @returns {boolean}
 */
function matchGlob(pattern, str) {
  // Convert glob pattern to regex
  // IMPORTANT: escape dots FIRST before replacing glob chars to avoid
  // corrupting regex tokens like [^/]* and .*
  let regex = pattern
    .replace(/\\/g, '/')
    .replace(/\./g, '\\.')     // Escape dots first (before glob replacements)
    .replace(/\*\*/g, '<<<GLOBSTAR>>>')
    .replace(/\*/g, '[^/]*')
    .replace(/<<<GLOBSTAR>>>/g, '.*')
    .replace(/\?/g, '[^/]');
  regex = '^' + regex + '$';
  return new RegExp(regex).test(str.replace(/\\/g, '/'));
}

/**
 * Recursively walk a directory, yielding relative paths.
 */
async function* walkDir(dir, baseDir, maxDepth = 10, depth = 0) {
  if (depth > maxDepth) return;

  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    const relPath = relative(baseDir, fullPath);

    if (entry.isDirectory()) {
      const normalized = relPath.replace(/\\/g, '/');
      if (SKIP_DIRS.has(entry.name) || normalized === '.yeaft/worktrees' || normalized.startsWith('.yeaft/worktrees/')) continue;
      yield { path: relPath, isDir: true };
      yield* walkDir(fullPath, baseDir, maxDepth, depth + 1);
    } else {
      yield { path: relPath, isDir: false };
    }
  }
}

async function listFilesWithFd(fdCommand, baseDir, signal) {
  const args = [
    '.', baseDir,
    '--type', 'file',
    '--type', 'symlink',
    '--hidden',
    '--no-ignore',
    '--color', 'never',
    '--max-depth', '11',
    '--print0',
  ];
  for (const skipped of SKIP_DIRS) args.push('--exclude', skipped);
  args.push('--exclude', '.yeaft/worktrees');
  const result = await runProcess(fdCommand, args, {
    cwd: baseDir,
    signal,
    timeoutMs: 120_000,
    maxBytes: 16 * 1024 * 1024,
  });
  if (result.timedOut) throw new Error('fd timed out');
  if (result.truncated) throw new Error('fd output exceeded the tool limit');
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || `fd exited with code ${result.code}`);
  }
  return result.stdout
    .split('\0')
    .filter(Boolean)
    .map(path => relative(baseDir, resolve(baseDir, path)));
}

export default defineTool({
  name: 'Glob',
  description: {
    en: `Find files matching a glob pattern.

Supports glob patterns like "**/*.js", "src/**/*.ts", "*.md".
Results are sorted by modification time (newest first).

Guidelines:
- Use "**/" for recursive directory matching
- Common directories (node_modules, .git, etc.) are skipped
- Returns file paths relative to the search directory
- Limited to 500 results by default`,
    zh: `查找匹配 glob 模式的文件。

支持如 "**/*.js"、"src/**/*.ts"、"*.md" 等 glob 模式。结果按修改时间排序（最新优先）。

使用指南：
- 用 "**/" 进行递归目录匹配
- 常见目录（node_modules、.git 等）被跳过
- 返回相对于搜索目录的文件路径
- 默认限制 500 条结果`
  },
  parameters: {
    type: 'object',
    properties: {
      pattern: {
        type: 'string',
        description: {
          en: 'Glob pattern to match files (e.g. "**/*.js")',
          zh: '匹配文件的 glob 模式（如 "**/*.js"）',
        },
      },
      path: {
        type: 'string',
        description: {
          en: 'Directory to search in (default: cwd)',
          zh: '搜索目录（默认当前工作目录）',
        },
      },
      limit: {
        type: 'integer',
        minimum: 1,
        description: {
          en: 'Maximum number of results (default: 500)',
          zh: '最多返回结果数（默认 500）',
        },
      },
    },
    required: ['pattern'],
  },
  isConcurrencySafe: () => true,
  isReadOnly: () => true,
  async execute(input, ctx) {
    const { pattern, path: searchPath, limit = 500 } = input;
    if (!pattern) return JSON.stringify({ error: 'pattern is required' });
    if (!Number.isInteger(limit) || limit < 1) {
      return JSON.stringify({ error: 'limit must be a positive integer' });
    }

    const cwd = ctx?.cwd || process.cwd();
    const baseDir = searchPath ? resolve(cwd, searchPath) : cwd;

    if (!existsSync(baseDir)) {
      return JSON.stringify({ error: `Directory not found: ${baseDir}` });
    }

    try {
      let paths;
      let fdCommand = resolveManagedCliCommand('fd', { yeaftDir: ctx?.yeaftDir });
      if (!fdCommand) {
        await managedCliToolReady(ctx?.managedCliReady, 'fd');
        fdCommand = resolveManagedCliCommand('fd', { yeaftDir: ctx?.yeaftDir });
      }
      if (fdCommand) {
        try {
          paths = (await listFilesWithFd(fdCommand, baseDir, ctx?.signal))
            .filter(path => matchGlob(pattern, path));
        } catch {
          paths = null;
        }
      }
      if (!paths) {
        paths = [];
        for await (const entry of walkDir(baseDir, baseDir)) {
          if (!entry.isDir && matchGlob(pattern, entry.path)) paths.push(entry.path);
        }
      }

      // Exact newest-first semantics require every matching mtime. Batch the
      // metadata reads instead of serializing one syscall per path.
      const matches = [];
      for (let i = 0; i < paths.length; i += STAT_CONCURRENCY) {
        matches.push(...await Promise.all(paths.slice(i, i + STAT_CONCURRENCY).map(async (path) => {
          try {
            const fileStat = await stat(join(baseDir, path));
            return { path, mtime: fileStat.mtimeMs };
          } catch {
            return { path, mtime: 0 };
          }
        })));
      }
      matches.sort((a, b) => b.mtime - a.mtime);
      const trimmed = matches.slice(0, limit);

      return trimmed.map(m => m.path).join('\n') || '(no matches)';
    } catch (err) {
      return JSON.stringify({ error: `Glob search failed: ${err.message}` });
    }
  },
});
