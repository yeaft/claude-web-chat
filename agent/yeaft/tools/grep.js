/**
 * grep.js — Search file contents for patterns.
 *
 * Searches for regex patterns in files. Tries to use ripgrep (rg) if
 * available for performance, falls back to a Node.js implementation.
 */

import { defineTool } from './types.js';
import { spawn } from 'child_process';
import { readdir, readFile, stat } from 'fs/promises';
import { StringDecoder } from 'string_decoder';
import { existsSync } from 'fs';
import { resolve, join, relative, extname } from 'path';

/** Max output lines. */
const MAX_LINES = 250;

/** Hard cap before Grep output reaches history, debug events, or WebSocket. */
const MAX_OUTPUT_BYTES = 512 * 1024;
const SEARCH_RESULT_BYTES = 32 * 1024;
const OUTPUT_TRUNCATED_MARKER = '\n\n[Output truncated]';
const MAX_CAPTURE_BYTES = MAX_OUTPUT_BYTES - Buffer.byteLength(OUTPUT_TRUNCATED_MARKER, 'utf8');

/** Keep one pathological source line from consuming the whole output budget. */
const MAX_LINE_BYTES = 16 * 1024;
const FALLBACK_CONCURRENCY = 8;
const SKIP_DIRS = new Set(['node_modules', '.git', '__pycache__', '.next', 'dist', 'build', '.cache']);
let ripgrepAvailability;

/** Binary extensions to skip. */
const BINARY_EXTS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.webp',
  '.mp3', '.mp4', '.avi', '.mov', '.wav',
  '.zip', '.tar', '.gz', '.bz2', '.7z', '.rar',
  '.exe', '.dll', '.so', '.dylib', '.o',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx',
  '.woff', '.woff2', '.ttf', '.otf',
  '.sqlite', '.db',
]);

const utf8Decoder = new TextDecoder('utf-8', { fatal: true });

function decodeTextFile(buffer) {
  // Extension lists are only a fast path. Generated artifacts and renamed
  // binaries commonly have no useful extension, especially on Windows.
  if (buffer.includes(0)) return null;
  try { return utf8Decoder.decode(buffer); } catch { return null; }
}

function truncateUtf8(text, maxBytes) {
  if (maxBytes <= 0) return '';
  const buffer = Buffer.from(text, 'utf8');
  if (buffer.length <= maxBytes) return text;
  return new StringDecoder('utf8').write(buffer.subarray(0, maxBytes));
}

function boundToolOutput(text) {
  if (Buffer.byteLength(text, 'utf8') <= MAX_OUTPUT_BYTES) return text;
  return truncateUtf8(text, MAX_CAPTURE_BYTES) + OUTPUT_TRUNCATED_MARKER;
}

function formatGrepError(message) {
  const errorMessage = `Grep failed: ${message}`;
  const serialized = JSON.stringify({ error: errorMessage });
  if (Buffer.byteLength(serialized, 'utf8') <= MAX_OUTPUT_BYTES) return serialized;

  const markerBytes = Buffer.byteLength(OUTPUT_TRUNCATED_MARKER, 'utf8');
  let low = 0;
  let high = Math.max(0, Buffer.byteLength(errorMessage, 'utf8') - markerBytes);
  let result = JSON.stringify({ error: OUTPUT_TRUNCATED_MARKER });

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const candidate = JSON.stringify({
      error: truncateUtf8(errorMessage, mid) + OUTPUT_TRUNCATED_MARKER,
    });
    if (Buffer.byteLength(candidate, 'utf8') <= MAX_OUTPUT_BYTES) {
      result = candidate;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  return result;
}

function createOutputCollector(maxBytes = MAX_OUTPUT_BYTES) {
  const parts = [];
  const contentBytes = Math.max(0, maxBytes - Buffer.byteLength(OUTPUT_TRUNCATED_MARKER, 'utf8'));
  let bytes = 0;
  let truncated = false;
  return {
    add(value) {
      if (truncated) return false;
      const normalized = String(value).replace(/\r/g, '');
      const line = truncateUtf8(normalized, MAX_LINE_BYTES);
      const lineWasTruncated = Buffer.byteLength(normalized, 'utf8') > Buffer.byteLength(line, 'utf8');
      const separator = parts.length > 0 ? '\n' : '';
      const remaining = contentBytes - bytes - Buffer.byteLength(separator, 'utf8');
      if (remaining <= 0) { truncated = true; return false; }
      const bounded = truncateUtf8(line, remaining);
      parts.push(separator + bounded);
      bytes += Buffer.byteLength(separator + bounded, 'utf8');
      if (lineWasTruncated || bounded !== line) truncated = true;
      return !truncated;
    },
    toString() { return parts.join('') + (truncated ? OUTPUT_TRUNCATED_MARKER : ''); },
  };
}

/**
 * Check if ripgrep is available.
 */
export function setRipgrepAvailabilityForTests(value) {
  ripgrepAvailability = value;
}

function hasRipgrep() {
  if (typeof ripgrepAvailability === 'boolean') return Promise.resolve(ripgrepAvailability);
  if (ripgrepAvailability) return ripgrepAvailability;
  ripgrepAvailability = new Promise((resolve) => {
    const proc = spawn('rg', ['--version'], { stdio: 'pipe', windowsHide: true });
    proc.on('close', (code) => resolve(code === 0));
    proc.on('error', () => resolve(false));
  }).then((available) => {
    ripgrepAvailability = available;
    return available;
  });
  return ripgrepAvailability;
}

/**
 * Run ripgrep and return results.
 */
export function runRipgrep(pattern, searchPath, options, spawnProcess = spawn) {
  return new Promise((resolve, reject) => {
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

    const proc = spawnProcess('rg', args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const requestedBudget = Number(options.byteBudget);
    const stdoutBudget = Number.isFinite(requestedBudget) && requestedBudget >= 0
      ? Math.min(requestedBudget, MAX_OUTPUT_BYTES)
      : MAX_OUTPUT_BYTES;
    const stdoutMarker = truncateUtf8(OUTPUT_TRUNCATED_MARKER, stdoutBudget);
    const stdoutCaptureLimit = Math.max(0, stdoutBudget - Buffer.byteLength(stdoutMarker, 'utf8'));
    const stdoutChunks = [];
    const stderrChunks = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let stdoutLines = 0;
    let stoppedForLimit = false;
    let settled = false;

    function stop() {
      try { proc.kill(); } catch {}
    }

    function captureStdout(chunk) {
      if (stdoutTruncated || stoppedForLimit) return;
      let buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const maxResults = Math.max(1, options.maxResults || 500);
      let cursor = 0;
      while (stdoutLines < maxResults) {
        const newline = buffer.indexOf(0x0a, cursor);
        if (newline === -1) break;
        stdoutLines += 1;
        cursor = newline + 1;
      }
      if (stdoutLines >= maxResults) {
        buffer = buffer.subarray(0, cursor);
        stoppedForLimit = true;
      }

      const remaining = stdoutCaptureLimit - stdoutBytes;
      if (buffer.length >= remaining) {
        if (remaining > 0) stdoutChunks.push(buffer.subarray(0, remaining));
        stdoutBytes = stdoutCaptureLimit;
        stdoutTruncated = true;
      } else {
        stdoutChunks.push(buffer);
        stdoutBytes += buffer.length;
      }
      if (stdoutTruncated || stoppedForLimit) stop();
    }

    function captureStderr(chunk) {
      if (stderrTruncated) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const remaining = MAX_CAPTURE_BYTES - stderrBytes;
      if (buffer.length >= remaining) {
        if (remaining > 0) stderrChunks.push(buffer.subarray(0, remaining));
        stderrBytes = MAX_CAPTURE_BYTES;
        stderrTruncated = true;
        stop();
        return;
      }
      stderrChunks.push(buffer);
      stderrBytes += buffer.length;
    }

    function decodeCaptured(chunks, maxBytes, wasTruncated, marker = OUTPUT_TRUNCATED_MARKER) {
      const boundedMarker = wasTruncated ? truncateUtf8(marker, maxBytes) : '';
      const maxTextBytes = Math.max(0, maxBytes - Buffer.byteLength(boundedMarker, 'utf8'));
      const decoded = Buffer.concat(chunks).toString('utf8').replaceAll('\ufffd', '?').replace(/\r/g, '');
      return truncateUtf8(decoded, maxTextBytes) + boundedMarker;
    }

    proc.stdout.on('data', captureStdout);
    proc.stderr.on('data', captureStderr);
    proc.on('close', (code) => {
      if (settled) return;
      settled = true;
      const stdout = decodeCaptured(stdoutChunks, stdoutBudget, stdoutTruncated, stdoutMarker);
      const stderr = decodeCaptured(stderrChunks, MAX_OUTPUT_BYTES, stderrTruncated);
      if (code === 0 || code === 1 || stoppedForLimit || stdoutTruncated) resolve(stdout);
      else reject(new Error(stderr || `rg exited with code ${code}`));
    });
    proc.on('error', (err) => {
      if (settled || stdoutTruncated || stoppedForLimit) return;
      settled = true;
      reject(err);
    });
  });
}

/**
 * Fallback: Node.js grep implementation.
 */
export async function nodeGrep(pattern, searchPath, options) {
  const regexSource = options.fixedStrings
    ? pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    : pattern;
  const regex = new RegExp(regexSource, options.caseInsensitive ? 'gi' : 'g');
  const output = createOutputCollector(options.byteBudget || SEARCH_RESULT_BYTES);
  const maxResults = Math.max(1, options.maxResults || 500);
  let resultCount = 0;
  let stopped = false;

  function compileGlob(glob) {
    const escaped = glob.replace(/\\/g, '/')
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*\*/g, '\0').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]')
      .replace(/\0/g, '.*');
    return new RegExp(`^${escaped}$`);
  }
  const globMatcher = options.glob ? compileGlob(options.glob) : null;
  const typeExtensions = {
    js: ['.js', '.jsx', '.mjs', '.cjs'], ts: ['.ts', '.tsx', '.mts', '.cts'],
    py: ['.py'], rust: ['.rs'], go: ['.go'], java: ['.java'],
    json: ['.json'], yaml: ['.yaml', '.yml'], markdown: ['.md', '.markdown'],
    html: ['.html', '.htm'], css: ['.css'], shell: ['.sh', '.bash', '.zsh'],
  };

  function matchesFilters(fullPath) {
    const relPath = relative(searchPath, fullPath).replace(/\\/g, '/');
    if (globMatcher && !globMatcher.test(relPath) && !globMatcher.test(relPath.split('/').pop())) return false;
    if (!options.type) return true;
    const extensions = typeExtensions[options.type];
    return Boolean(extensions?.includes(extname(fullPath).toLowerCase()));
  }

  function addResult(value) {
    resultCount += 1;
    if (!output.add(value) || resultCount >= maxResults) stopped = true;
  }

  async function searchFile(fullPath) {
    if (stopped || !matchesFilters(fullPath) || BINARY_EXTS.has(extname(fullPath).toLowerCase())) return;
    try {
      const fileStat = await stat(fullPath);
      if (fileStat.size > 1024 * 1024 || stopped) return;
      const content = decodeTextFile(await readFile(fullPath));
      if (content == null) return;
      const relPath = relative(searchPath, fullPath);
      regex.lastIndex = 0;
      if (options.filesOnly) {
        if (regex.test(content)) addResult(relPath);
      } else if (options.count) {
        const matches = content.match(regex);
        if (matches) addResult(`${relPath}:${matches.length}`);
      } else {
        const lines = content.split('\n');
        for (let i = 0; i < lines.length && !stopped; i += 1) {
          regex.lastIndex = 0;
          if (regex.test(lines[i])) addResult(`${relPath}:${i + 1}:${lines[i]}`);
        }
      }
    } catch {
      // Skip unreadable files.
    }
  }

  async function searchDir(dir) {
    if (stopped) return;
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    const files = [];
    const directories = [];
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        const relPath = relative(searchPath, fullPath).replace(/\\/g, '/');
        if (!SKIP_DIRS.has(entry.name) && relPath !== '.yeaft/worktrees' && !relPath.startsWith('.yeaft/worktrees/')) directories.push(fullPath);
      } else files.push(fullPath);
    }
    for (let i = 0; i < files.length && !stopped; i += FALLBACK_CONCURRENCY) {
      await Promise.all(files.slice(i, i + FALLBACK_CONCURRENCY).map(searchFile));
    }
    for (const child of directories) {
      if (stopped) break;
      await searchDir(child);
    }
  }

  const rootStat = await stat(searchPath);
  if (rootStat.isDirectory()) await searchDir(searchPath);
  else await searchFile(searchPath);
  return output.toString();
}

export default defineTool({
  name: 'Grep',
  description: {
    en: `Search file contents for a regex pattern.

Uses ripgrep (rg) when available for fast searching, with a Node.js fallback.

Output modes:
- "content" — show matching lines with file path and line numbers
- "files_with_matches" — show only file paths that match (default)
- "count" — show match count per file

Guidelines:
- Uses regex syntax (escape special chars: \\., \\{, etc.)
- Use glob or type filters to narrow the search
- Skips binary files and common large directories (node_modules, .git)
- Results are limited to 500 matches by default`,
    zh: `用正则表达式搜索文件内容。

优先使用 ripgrep (rg) 快速搜索，回退到 Node.js 实现。

输出模式：
- "content" — 显示匹配行，含文件路径和行号
- "files_with_matches" — 仅显示匹配的文件路径（默认）
- "count" — 显示每个文件的匹配数量

使用指南：
- 使用正则语法（特殊字符需转义：\\.、\\{ 等）
- 用 glob 或 type 过滤缩小搜索范围
- 跳过二进制文件和常见大目录（node_modules、.git）
- 默认结果限制 500 条`
  },
  parameters: {
    type: 'object',
    properties: {
      pattern: {
        type: 'string',
        description: {
          en: 'Regex pattern to search for',
          zh: '要搜索的正则表达式模式',
        },
      },
      path: {
        type: 'string',
        description: {
          en: 'File or directory to search (default: cwd)',
          zh: '要搜索的文件或目录（默认当前工作目录）',
        },
      },
      output_mode: {
        type: 'string',
        enum: ['content', 'files_with_matches', 'count'],
        description: {
          en: 'Output format (default: "files_with_matches")',
          zh: '输出格式（默认 "files_with_matches"）',
        },
      },
      glob: {
        type: 'string',
        description: {
          en: 'Glob filter for file names (e.g. "*.js", "*.{ts,tsx}")',
          zh: '文件名 glob 过滤（如 "*.js"、"*.{ts,tsx}"）',
        },
      },
      type: {
        type: 'string',
        description: {
          en: 'File type filter (e.g. "js", "py", "rust")',
          zh: '文件类型过滤（如 "js"、"py"、"rust"）',
        },
      },
      case_insensitive: {
        type: 'boolean',
        description: {
          en: 'Case-insensitive search (default: false)',
          zh: '不区分大小写搜索（默认 false）',
        },
      },
      fixed_strings: {
        type: 'boolean',
        description: {
          en: 'Treat the pattern as a literal string (default: false)',
          zh: '将模式视为普通字符串而非正则表达式（默认 false）',
        },
      },
      context: {
        type: 'number',
        description: {
          en: 'Lines of context around matches (for "content" mode)',
          zh: '匹配行周围的上下文行数（用于 "content" 模式）',
        },
      },
      before: {
        type: 'number',
        description: {
          en: 'Lines before each match',
          zh: '每个匹配之前显示的行数',
        },
      },
      after: {
        type: 'number',
        description: {
          en: 'Lines after each match',
          zh: '每个匹配之后显示的行数',
        },
      },
      multiline: {
        type: 'boolean',
        description: {
          en: 'Enable multiline matching',
          zh: '启用多行匹配',
        },
      },
      head_limit: {
        type: 'number',
        description: {
          en: 'Limit output to first N results (default: 250)',
          zh: '限制输出前 N 条结果（默认 250）',
        },
      },
    },
    required: ['pattern'],
  },
  isConcurrencySafe: () => true,
  isReadOnly: () => true,
  async execute(input, ctx) {
    const {
      pattern, path: searchPath, output_mode = 'files_with_matches',
      glob: globFilter, type, case_insensitive = false, fixed_strings = false,
      context, before, after, multiline = false,
      head_limit = MAX_LINES,
    } = input;

    if (!pattern) return JSON.stringify({ error: 'pattern is required' });

    const cwd = ctx?.cwd || process.cwd();
    const absPath = searchPath ? resolve(cwd, searchPath) : cwd;

    if (!existsSync(absPath)) {
      return JSON.stringify({ error: `Path not found: ${absPath}` });
    }

    const options = {
      caseInsensitive: case_insensitive,
      glob: globFilter,
      type,
      fixedStrings: fixed_strings,
      filesOnly: output_mode === 'files_with_matches',
      count: output_mode === 'count',
      context,
      before,
      after,
      multiline,
      maxResults: Math.max(1, Math.min(Number(head_limit) || MAX_LINES, 10000)),
      byteBudget: SEARCH_RESULT_BYTES,
    };

    try {
      let result;
      const rgAvailable = await hasRipgrep();

      if (rgAvailable) {
        result = await runRipgrep(pattern, absPath, options);
      } else {
        result = await nodeGrep(pattern, absPath, options);
      }

      if (!result || !result.trim()) {
        return '(no matches)';
      }

      // Limit output lines, then enforce the byte budget at the actual tool
      // boundary so prefixes, JSON escaping, and result markers are included.
      const lines = result.trim().split('\n');
      if (lines.length > head_limit) {
        return boundToolOutput(
          lines.slice(0, head_limit).join('\n') + `\n\n... (${lines.length - head_limit} more results)`,
        );
      }

      return boundToolOutput(result.trim());
    } catch (err) {
      return formatGrepError(err.message);
    }
  },
});
