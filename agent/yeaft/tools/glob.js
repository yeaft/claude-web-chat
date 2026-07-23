// glob.js — Find files by glob pattern, sorted newest first.

import { defineTool } from './types.js';
import { readdir, stat } from 'fs/promises';
import { existsSync } from 'fs';
import { resolve, join, relative } from 'path';

const STAT_CONCURRENCY = 32;
const SKIP = new Set([
  'node_modules', '.git', '__pycache__', '.next', '.nuxt',
  'dist', 'build', '.cache', '.venv', 'venv', '.tox',
  'vendor', 'target', '.gradle', '.idea', '.vscode',
]);

function matchGlob(pattern, str) {
  let regex = pattern
    .replace(/\\/g, '/')
    .replace(/\./g, '\\.')
    .replace(/\*\*/g, '<<<GLOBSTAR>>>')
    .replace(/\*/g, '[^/]*')
    .replace(/<<<GLOBSTAR>>>/g, '.*')
    .replace(/\?/g, '[^/]');
  regex = '^' + regex + '$';
  return new RegExp(regex).test(str.replace(/\\/g, '/'));
}

async function* walkDir(dir, baseDir, maxDepth = 10, depth = 0) {
  if (depth > maxDepth) return;
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    const relPath = relative(baseDir, fullPath);
    if (entry.isDirectory()) {
      const normalized = relPath.replace(/\\/g, '/');
      if (SKIP.has(entry.name) || normalized === '.yeaft/worktrees' || normalized.startsWith('.yeaft/worktrees/')) continue;
      yield { path: relPath, isDir: true };
      yield* walkDir(fullPath, baseDir, maxDepth, depth + 1);
    } else {
      yield { path: relPath, isDir: false };
    }
  }
}

export default defineTool({
  name: 'Glob',
  description: {
    en: 'Find files matching a glob pattern. Results are sorted by modification time (newest first).',
    zh: '查找匹配 glob 模式的文件。结果按修改时间排序（最新优先）。',
  },
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: { en: 'Glob pattern to match files', zh: '匹配文件的 glob 模式' } },
      path: { type: 'string', description: { en: 'Directory to search in (default: cwd)', zh: '搜索目录（默认当前工作目录）' } },
      limit: { type: 'number', description: { en: 'Maximum number of results (default: 500)', zh: '最多返回结果数（默认 500）' } },
    },
    required: ['pattern'],
  },
  isConcurrencySafe: () => true,
  isReadOnly: () => true,
  async execute(input, ctx) {
    const { pattern, path: searchPath, limit = 500 } = input;
    if (!pattern) return JSON.stringify({ error: 'pattern is required' });
    const cwd = ctx?.cwd || process.cwd();
    const baseDir = searchPath ? resolve(cwd, searchPath) : cwd;
    if (!existsSync(baseDir)) return JSON.stringify({ error: `Directory not found: ${baseDir}` });

    try {
      const paths = [];
      for await (const entry of walkDir(baseDir, baseDir)) {
        if (!entry.isDir && matchGlob(pattern, entry.path)) paths.push(entry.path);
      }

      // Exact newest-first semantics require all matching mtimes. The expensive
      // metadata reads are bounded and parallel rather than one syscall at a time.
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
      return matches.slice(0, limit).map(match => match.path).join('\n') || '(no matches)';
    } catch (err) {
      return JSON.stringify({ error: `Glob search failed: ${err.message}` });
    }
  },
});
