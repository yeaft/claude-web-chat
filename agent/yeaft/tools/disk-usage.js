import { lstat, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import { defineTool } from './types.js';
import { managedCliToolReady, resolveManagedCliCommand } from '../managed-cli.js';
import { runProcess } from './process-runner.js';
import { isAbortError, throwIfAborted, waitForAbortable } from './search-paths.js';

const FALLBACK_CONCURRENCY = 16;
const MAX_LIMIT = 200;
const MAX_DEPTH = 10;
const MAX_OUTPUT_BYTES = 512 * 1024;

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)}KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)}MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)}GB`;
}

function parseDustBytes(value) {
  const match = String(value || '').match(/^(\d+)B$/);
  return match ? Number(match[1]) : 0;
}

function flattenDustTree(root, baseDir, depth, limit) {
  const rows = [];
  function visit(node, level) {
    if (!node || level > depth) return;
    rows.push({
      path: level === 0 ? '.' : relative(baseDir, node.name) || basename(node.name),
      size: parseDustBytes(node.size),
      level,
    });
    for (const child of node.children || []) visit(child, level + 1);
  }
  visit(root, 0);
  const total = rows.shift();
  rows.sort((a, b) => b.size - a.size || a.path.localeCompare(b.path));
  return [total, ...rows.slice(0, Math.max(0, limit - 1))].filter(Boolean);
}

async function runDust(command, baseDir, { depth, limit, signal }) {
  const result = await runProcess(command, [
    '--output-json',
    '--depth', String(depth),
    '--number-of-lines', String(limit),
    '--apparent-size',
    '--only-dir',
    '--no-progress',
    '--output-format', 'b',
    baseDir,
  ], {
    cwd: baseDir,
    signal,
    timeoutMs: 120_000,
    maxBytes: MAX_OUTPUT_BYTES,
    env: { ...process.env, NO_COLOR: '1' },
  });
  if (result.timedOut) throw new Error('dust timed out');
  if (result.truncated) throw new Error('dust output exceeded the tool limit');
  if (result.code !== 0) throw new Error(result.stderr.trim() || `dust exited with code ${result.code}`);
  return flattenDustTree(JSON.parse(result.stdout), baseDir, depth, limit);
}

async function measurePath(path, baseDir, depth, level, rows, signal) {
  throwIfAborted(signal);
  let entryStat;
  try { entryStat = await lstat(path); } catch (error) {
    if (isAbortError(error)) throw error;
    return 0;
  }
  throwIfAborted(signal);
  const rootSymlink = entryStat.isSymbolicLink() && level === 0;
  if (entryStat.isSymbolicLink() && !rootSymlink) {
    if (level <= depth) {
      rows.push({
        path: relative(baseDir, path),
        size: entryStat.size,
        level,
      });
    }
    return entryStat.size;
  }
  if (!rootSymlink && !entryStat.isDirectory()) return entryStat.size;

  let entries;
  try { entries = await readdir(path, { withFileTypes: true }); } catch (error) {
    if (isAbortError(error)) throw error;
    return 0;
  }
  throwIfAborted(signal);
  let size = entryStat.size;
  for (let index = 0; index < entries.length; index += FALLBACK_CONCURRENCY) {
    throwIfAborted(signal);
    const batch = entries.slice(index, index + FALLBACK_CONCURRENCY);
    const sizes = await Promise.all(batch.map(entry => measurePath(
      join(path, entry.name),
      baseDir,
      depth,
      level + 1,
      rows,
      signal,
    )));
    size += sizes.reduce((sum, value) => sum + value, 0);
  }
  if (level <= depth) {
    rows.push({
      path: level === 0 ? '.' : relative(baseDir, path),
      size,
      level,
    });
  }
  return size;
}

async function nodeDiskUsage(baseDir, depth, limit, signal) {
  const rows = [];
  await measurePath(baseDir, baseDir, depth, 0, rows, signal);
  const total = rows.find(row => row.level === 0);
  const children = rows
    .filter(row => row.level > 0)
    .sort((a, b) => b.size - a.size || a.path.localeCompare(b.path))
    .slice(0, Math.max(0, limit - 1));
  return [total, ...children].filter(Boolean);
}

function formatRows(baseDir, rows) {
  const lines = rows.map(row => `${formatSize(row.size).padStart(9)}  ${row.path}`);
  return `${baseDir}\n\n${lines.join('\n')}`;
}

export default defineTool({
  name: 'DiskUsage',
  description: {
    en: `Show the largest directories under a path by apparent size.

Uses dust when available for parallel disk-usage scanning, with a Node.js fallback.
The root total is shown first, followed by the largest descendants. Symlinks are not followed.`,
    zh: `按表观大小显示路径下占用最大的目录。

优先使用 dust 并行扫描磁盘用量，回退到 Node.js 实现。根路径总量排在首行，之后按大小列出后代目录；不会跟随符号链接。`,
  },
  parameters: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: { en: 'Directory to inspect (default: cwd)', zh: '要检查的目录（默认当前工作目录）' },
      },
      depth: {
        type: 'integer',
        minimum: 0,
        maximum: MAX_DEPTH,
        description: { en: 'Maximum directory depth to show (default: 2)', zh: '要显示的最大目录深度（默认 2）' },
      },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: MAX_LIMIT,
        description: { en: 'Maximum rows to return (default: 20)', zh: '最多返回行数（默认 20）' },
      },
    },
  },
  isConcurrencySafe: () => true,
  isReadOnly: () => true,
  async execute(input, ctx) {
    const { path, depth = 2, limit = 20 } = input;
    if (!Number.isInteger(depth) || depth < 0 || depth > MAX_DEPTH) {
      return JSON.stringify({ error: `depth must be an integer between 0 and ${MAX_DEPTH}` });
    }
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
      return JSON.stringify({ error: `limit must be an integer between 1 and ${MAX_LIMIT}` });
    }
    const cwd = ctx?.cwd || process.cwd();
    const baseDir = path ? resolve(cwd, path) : cwd;
    if (!existsSync(baseDir)) return JSON.stringify({ error: `Directory not found: ${baseDir}` });

    try {
      throwIfAborted(ctx?.signal);
      let rows;
      let dustCommand = resolveManagedCliCommand('dust', { yeaftDir: ctx?.yeaftDir });
      if (!dustCommand) {
        await waitForAbortable(managedCliToolReady(ctx?.managedCliReady, 'dust'), ctx?.signal);
        dustCommand = resolveManagedCliCommand('dust', { yeaftDir: ctx?.yeaftDir });
      }
      if (dustCommand) {
        try {
          rows = await runDust(dustCommand, baseDir, { depth, limit, signal: ctx?.signal });
        } catch (error) {
          if (isAbortError(error)) throw error;
          rows = null;
        }
      }
      if (!rows) rows = await nodeDiskUsage(baseDir, depth, limit, ctx?.signal);
      return formatRows(baseDir, rows);
    } catch (error) {
      if (isAbortError(error)) throw error;
      return JSON.stringify({ error: `Disk usage scan failed: ${error.message}` });
    }
  },
});
