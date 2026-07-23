// grep.js — Search file contents for patterns using ripgrep or a Node fallback.

import { defineTool } from './types.js';
import { spawn } from 'child_process';
import { readdir, readFile, stat } from 'fs/promises';
import { existsSync } from 'fs';
import { resolve, join, relative, extname } from 'path';
import { StringDecoder } from 'string_decoder';

const MAX_LINES = 250;
const OUTPUT_BYTE_BUDGET = 32 * 1024;
const RAW_OUTPUT_HARD_CAP = 512 * 1024;
const FALLBACK_CONCURRENCY = 8;

const BINARY_EXTS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.webp',
  '.mp3', '.mp4', '.avi', '.mov', '.wav',
  '.zip', '.tar', '.gz', '.bz2', '.7z', '.rar',
  '.exe', '.dll', '.so', '.dylib', '.o',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx',
  '.woff', '.woff2', '.ttf', '.otf', '.sqlite', '.db',
]);
const SKIP_DIRS = new Set([
  'node_modules', '.git', '__pycache__', '.next', 'dist', 'build', '.cache',
]);
const TYPE_EXTENSIONS = {
  js: ['.js', '.jsx', '.mjs', '.cjs'], ts: ['.ts', '.tsx', '.mts', '.cts'],
  py: ['.py'], rust: ['.rs'], go: ['.go'], java: ['.java'], ruby: ['.rb'],
  json: ['.json'], yaml: ['.yaml', '.yml'], markdown: ['.md', '.markdown'],
  html: ['.html', '.htm'], css: ['.css'], shell: ['.sh', '.bash', '.zsh'],
};

let ripgrepAvailability;

/** Test seam: pass true/false to inject availability, or undefined to reset. */
export function setRipgrepAvailabilityForTests(value) {
  ripgrepAvailability = value;
}

function hasRipgrep() {
  if (typeof ripgrepAvailability === 'boolean') return Promise.resolve(ripgrepAvailability);
  if (ripgrepAvailability) return ripgrepAvailability;

  ripgrepAvailability = new Promise((done) => {
    const proc = spawn('rg', ['--version'], { stdio: 'ignore' });
    proc.once('close', (code) => done(code === 0));
    proc.once('error', () => done(false));
  }).then((available) => {
    ripgrepAvailability = available;
    return available;
  });
  return ripgrepAvailability;
}

function truncateUtf8(value, maxBytes) {
  const buffer = Buffer.from(value);
  if (buffer.length <= maxBytes) return value;
  return new StringDecoder('utf8').write(buffer.subarray(0, maxBytes));
}

function runRipgrep(pattern, searchPath, options) {
  return new Promise((done, reject) => {
    const args = [pattern, searchPath, '--no-heading', '--line-number', '--color', 'never'];
    if (options.caseInsensitive) args.push('-i');
    if (options.fixedStrings) args.push('-F');
    if (options.glob) args.push('--glob', options.glob);
    if (options.type) args.push('--type', options.type);
    if (options.filesOnly) args.push('-l');
    if (options.count) args.push('-c');
    if (options.context) args.push('-C', String(options.context));
    if (options.before) args.push('-B', String(options.before));
    if (options.after) args.push('-A', String(options.after));
    if (options.multiline) args.push('-U', '--multiline-dotall');

    const proc = spawn('rg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const decoder = new StringDecoder('utf8');
    const lines = [];
    let pending = '';
    let outputBytes = 0;
    let rawBytes = 0;
    let stderr = '';
    let stopped = false;
    let settled = false;

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };
    const stop = () => {
      if (stopped) return;
      stopped = true;
      try { proc.kill(); } catch {}
    };
    const addLine = (line) => {
      const separatorBytes = lines.length ? 1 : 0;
      const available = options.byteBudget - outputBytes - separatorBytes;
      if (available <= 0) return false;
      const safeLine = truncateUtf8(line, available);
      lines.push(safeLine);
      outputBytes += separatorBytes + Buffer.byteLength(safeLine);
      return safeLine === line && lines.length < options.maxResults && outputBytes < options.byteBudget;
    };
    const consume = (text) => {
      pending += text;
      let newline;
      while ((newline = pending.indexOf('\n')) !== -1) {
        const line = pending.slice(0, newline).replace(/\r$/, '');
        pending = pending.slice(newline + 1);
        if (!addLine(line)) { stop(); return; }
      }
    };

    proc.stdout.on('data', (chunk) => {
      rawBytes += chunk.length;
      if (rawBytes > RAW_OUTPUT_HARD_CAP) { stop(); return; }
      consume(decoder.write(chunk));
    });
    proc.stderr.on('data', (chunk) => {
      if (stderr.length < OUTPUT_BYTE_BUDGET) stderr += chunk.toString('utf8');
    });
    proc.once('error', (err) => finish(reject, err));
    proc.once('close', (code) => {
      consume(decoder.end());
      if (pending && lines.length < options.maxResults && outputBytes < options.byteBudget) addLine(pending);
      if (code === 0 || code === 1 || stopped) finish(done, lines.join('\n'));
      else finish(reject, new Error(stderr || `rg exited with code ${code}`));
    });
  });
}

function globRegex(pattern) {
  const source = pattern.replace(/\\/g, '/')
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\0').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]')
    .replace(/\0/g, '.*');
  return new RegExp(`^${source}$`);
}

function matchesFilters(filePath, basePath, options) {
  const rel = relative(basePath, filePath).replace(/\\/g, '/');
  if (options.glob && !globRegex(options.glob).test(rel) && !globRegex(options.glob).test(rel.split('/').pop())) return false;
  if (options.type) {
    const extensions = TYPE_EXTENSIONS[options.type];
    if (!extensions || !extensions.includes(extname(filePath).toLowerCase())) return false;
  }
  return true;
}

async function nodeGrep(pattern, searchPath, options) {
  const source = options.fixedStrings ? pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : pattern;
  const regex = new RegExp(source, options.caseInsensitive ? 'gi' : 'g');
  const results = [];
  let outputBytes = 0;
  let stopped = false;

  const addResult = (line) => {
    if (stopped) return false;
    const separatorBytes = results.length ? 1 : 0;
    const available = options.byteBudget - outputBytes - separatorBytes;
    if (available <= 0) { stopped = true; return false; }
    const safeLine = truncateUtf8(line, available);
    results.push(safeLine);
    outputBytes += separatorBytes + Buffer.byteLength(safeLine);
    if (safeLine !== line || results.length >= options.maxResults || outputBytes >= options.byteBudget) stopped = true;
    return !stopped;
  };

  async function searchFile(fullPath) {
    if (stopped || !matchesFilters(fullPath, searchPath, options)) return;
    if (BINARY_EXTS.has(extname(fullPath).toLowerCase())) return;
    try {
      const fileStat = await stat(fullPath);
      if (fileStat.size > 1024 * 1024 || stopped) return;
      const content = await readFile(fullPath, 'utf8');
      const relPath = relative(searchPath, fullPath).replace(/\\/g, '/');
      regex.lastIndex = 0;
      if (options.filesOnly) {
        if (regex.test(content)) addResult(relPath);
      } else if (options.count) {
        const matches = content.match(regex);
        if (matches) addResult(`${relPath}:${matches.length}`);
      } else {
        const lines = content.split('\n');
        for (let i = 0; i < lines.length && !stopped; i++) {
          regex.lastIndex = 0;
          if (regex.test(lines[i])) addResult(`${relPath}:${i + 1}:${lines[i]}`);
        }
      }
    } catch {}
  }

  async function searchDir(dir) {
    if (stopped) return;
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    const files = [];
    const dirs = [];
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        const rel = relative(searchPath, fullPath).replace(/\\/g, '/');
        if (!SKIP_DIRS.has(entry.name) && rel !== '.yeaft/worktrees' && !rel.startsWith('.yeaft/worktrees/')) dirs.push(fullPath);
      } else files.push(fullPath);
    }
    for (let i = 0; i < files.length && !stopped; i += FALLBACK_CONCURRENCY) {
      await Promise.all(files.slice(i, i + FALLBACK_CONCURRENCY).map(searchFile));
    }
    for (const child of dirs) {
      if (stopped) break;
      await searchDir(child);
    }
  }

  const rootStat = await stat(searchPath);
  if (rootStat.isDirectory()) await searchDir(searchPath);
  else await searchFile(searchPath);
  return results.join('\n');
}

export default defineTool({
  name: 'Grep',
  description: {
    en: 'Search file contents for a pattern. Uses ripgrep when available, with a filtered Node.js fallback.',
    zh: '搜索文件内容。优先使用 ripgrep，并提供遵守过滤条件的 Node.js 回退实现。',
  },
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: { en: 'Pattern to search for', zh: '要搜索的模式' } },
      path: { type: 'string', description: { en: 'File or directory to search (default: cwd)', zh: '要搜索的文件或目录（默认当前工作目录）' } },
      output_mode: { type: 'string', enum: ['content', 'files_with_matches', 'count'], description: { en: 'Output format', zh: '输出格式' } },
      glob: { type: 'string', description: { en: 'Glob filter for file names', zh: '文件名 glob 过滤' } },
      type: { type: 'string', description: { en: 'File type filter', zh: '文件类型过滤' } },
      case_insensitive: { type: 'boolean', description: { en: 'Case-insensitive search', zh: '不区分大小写搜索' } },
      fixed_strings: { type: 'boolean', description: { en: 'Treat pattern as a literal string', zh: '将模式视为固定字符串' } },
      context: { type: 'number', description: { en: 'Lines of context around matches', zh: '匹配行周围的上下文行数' } },
      before: { type: 'number', description: { en: 'Lines before each match', zh: '每个匹配之前显示的行数' } },
      after: { type: 'number', description: { en: 'Lines after each match', zh: '每个匹配之后显示的行数' } },
      multiline: { type: 'boolean', description: { en: 'Enable multiline matching', zh: '启用多行匹配' } },
      head_limit: { type: 'number', description: { en: 'Limit output to first N results', zh: '限制输出前 N 条结果' } },
    },
    required: ['pattern'],
  },
  isConcurrencySafe: () => true,
  isReadOnly: () => true,
  async execute(input, ctx) {
    const {
      pattern, path: searchPath, output_mode = 'files_with_matches', glob, type,
      case_insensitive = false, fixed_strings = false, context, before, after,
      multiline = false, head_limit = MAX_LINES,
    } = input;
    if (!pattern) return JSON.stringify({ error: 'pattern is required' });
    const cwd = ctx?.cwd || process.cwd();
    const absPath = searchPath ? resolve(cwd, searchPath) : cwd;
    if (!existsSync(absPath)) return JSON.stringify({ error: `Path not found: ${absPath}` });

    const maxResults = Math.max(1, Math.min(Number(head_limit) || MAX_LINES, 10000));
    const options = {
      caseInsensitive: case_insensitive, fixedStrings: fixed_strings, glob, type,
      filesOnly: output_mode === 'files_with_matches', count: output_mode === 'count',
      context, before, after, multiline, maxResults, byteBudget: OUTPUT_BYTE_BUDGET,
    };
    try {
      const result = await (await hasRipgrep()
        ? runRipgrep(pattern, absPath, options)
        : nodeGrep(pattern, absPath, options));
      return result?.trim() || '(no matches)';
    } catch (err) {
      return JSON.stringify({ error: `Grep failed: ${err.message}` });
    }
  },
});
