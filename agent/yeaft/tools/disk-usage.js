import { lstat, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import { defineTool } from './types.js';
import { managedCliToolReady, resolveManagedCliCommand } from '../managed-cli.js';
import { runProcess } from './process-runner.js';
import {
  isAbortError,
  SearchBackendLimitError,
  throwIfAborted,
  waitForAbortable,
} from './search-paths.js';

const FALLBACK_CONCURRENCY = 16;
const MAX_LIMIT = 200;
const MAX_DEPTH = 10;
const MAX_OUTPUT_BYTES = 512 * 1024;
const DUST_RESULT_ROWS = MAX_LIMIT;

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

export async function runDust(
  command,
  baseDir,
  { depth, limit, signal },
  processRunner = runProcess,
) {
  const result = await processRunner(command, [
    '--output-json',
    '--depth', String(depth),
    '--number-of-lines', String(DUST_RESULT_ROWS),
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
  if (result.timedOut) throw new SearchBackendLimitError('dust timed out');
  if (result.truncated) {
    throw new SearchBackendLimitError('dust output exceeded the tool limit');
  }
  if (result.code !== 0) throw new Error(result.stderr.trim() || `dust exited with code ${result.code}`);
  return flattenDustTree(JSON.parse(result.stdout), baseDir, depth, limit);
}

async function validateDiskUsageRoot(path, signal, fsOps = { lstat, stat }) {
  throwIfAborted(signal);
  const rootStat = await fsOps.lstat(path);
  throwIfAborted(signal);
  if (rootStat.isDirectory()) return rootStat;
  if (rootStat.isSymbolicLink()) {
    const targetStat = await fsOps.stat(path);
    throwIfAborted(signal);
    if (targetStat.isDirectory()) return rootStat;
  }
  throw new Error('path must be a directory or a directory symlink');
}

export async function nodeDiskUsage(
  baseDir,
  depth,
  limit,
  signal,
  fsOps = { lstat, readdir, stat },
) {
  const rootStat = await validateDiskUsageRoot(baseDir, signal, fsOps);
  const root = { path: baseDir, level: 0, size: rootStat.size, parent: null };
  const directories = [root];
  const linkedDirectories = [];

  async function scanDirectory(directory) {
    throwIfAborted(signal);
    let entries;
    try { entries = await fsOps.readdir(directory.path, { withFileTypes: true }); } catch (error) {
      if (isAbortError(error)) throw error;
      return;
    }
    throwIfAborted(signal);
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      throwIfAborted(signal);
      const childPath = join(directory.path, entry.name);
      let childStat;
      try { childStat = await fsOps.lstat(childPath); } catch (error) {
        if (isAbortError(error)) throw error;
        continue;
      }
      throwIfAborted(signal);
      if (childStat.isSymbolicLink()) {
        directory.size += childStat.size;
        let targetIsDirectory = false;
        try { targetIsDirectory = (await fsOps.stat(childPath)).isDirectory(); } catch (error) {
          if (isAbortError(error)) throw error;
        }
        throwIfAborted(signal);
        if (targetIsDirectory && directory.level + 1 <= depth) {
          linkedDirectories.push({
            path: relative(baseDir, childPath),
            size: childStat.size,
            level: directory.level + 1,
          });
        }
      } else if (childStat.isDirectory()) {
        directories.push({
          path: childPath,
          level: directory.level + 1,
          size: childStat.size,
          parent: directory,
        });
      } else {
        directory.size += childStat.size;
      }
    }
  }

  let cursor = 0;
  while (cursor < directories.length) {
    throwIfAborted(signal);
    const batch = directories.slice(cursor, cursor + FALLBACK_CONCURRENCY);
    cursor += batch.length;
    const settled = await Promise.allSettled(batch.map(scanDirectory));
    const rejected = settled.find(result => result.status === 'rejected');
    if (rejected) throw rejected.reason;
  }

  for (let index = directories.length - 1; index > 0; index -= 1) {
    directories[index].parent.size += directories[index].size;
  }
  const rows = [
    ...directories
      .filter(directory => directory.level <= depth)
      .map(directory => ({
        path: directory.level === 0 ? '.' : relative(baseDir, directory.path),
        size: directory.size,
        level: directory.level,
      })),
    ...linkedDirectories,
  ];
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
The root total is shown first, followed by the largest descendants. A root directory
symlink is scanned like dust; descendant symlinks are not followed.`,
    zh: `按表观大小显示路径下占用最大的目录。

优先使用 dust 并行扫描磁盘用量，回退到 Node.js 实现。根路径总量排在首行，之后按大小列出后代目录；
根目录符号链接与 dust 一样扫描目标内容，后代符号链接不跟随。`,
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
      await validateDiskUsageRoot(baseDir, ctx?.signal);
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
          if (isAbortError(error) || error instanceof SearchBackendLimitError) throw error;
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
