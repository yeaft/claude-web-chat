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
const OUTPUT_TRUNCATED_MARKER = '\n\n[Output truncated]';
const MAX_CAPTURE_BYTES = MAX_OUTPUT_BYTES - Buffer.byteLength(OUTPUT_TRUNCATED_MARKER, 'utf8');

/** Keep one pathological source line from consuming the whole output budget. */
const MAX_LINE_BYTES = 16 * 1024;

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
function hasRipgrep() {
  return new Promise((resolve) => {
    const proc = spawn('rg', ['--version'], { stdio: 'pipe', windowsHide: true });
    proc.on('close', (code) => resolve(code === 0));
    proc.on('error', () => resolve(false));
  });
}

/**
 * Run ripgrep and return results.
 */
export function runRipgrep(pattern, searchPath, options, spawnProcess = spawn) {
  return new Promise((resolve, reject) => {
    const args = [
      pattern,
      searchPath,
      '--no-heading',
      '--line-number',
      '--color', 'never',
    ];

    if (options.caseInsensitive) args.push('-i');
    if (options.glob) args.push('--glob', options.glob);
    if (options.type) args.push('--type', options.type);
    if (options.filesOnly) args.push('-l');
    if (options.count) args.push('-c');
    if (options.context) args.push('-C', String(options.context));
    if (options.before) args.push('-B', String(options.before));
    if (options.after) args.push('-A', String(options.after));
    if (options.multiline) args.push('-U', '--multiline-dotall');
    args.push('--max-count', String(options.maxResults || 500));

    const proc = spawnProcess('rg', args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const stdoutChunks = [];
    const stderrChunks = [];
    let capturedBytes = 0;
    let truncatedStream = null;
    let settled = false;

    function capture(streamName, chunk, chunks) {
      if (truncatedStream) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const remaining = MAX_CAPTURE_BYTES - capturedBytes;
      if (buffer.length > remaining) {
        if (remaining > 0) chunks.push(buffer.subarray(0, remaining));
        capturedBytes = MAX_CAPTURE_BYTES;
        truncatedStream = streamName;
        try { proc.kill(); } catch {}
        return;
      }
      chunks.push(buffer);
      capturedBytes += buffer.length;
    }

    function decodeCaptured(chunks, wasTruncated) {
      // Buffer decoding normally expands each invalid byte to the three-byte
      // U+FFFD replacement character. Use a one-byte replacement, then enforce
      // the final encoded-byte boundary as a last line of defense.
      const marker = wasTruncated ? OUTPUT_TRUNCATED_MARKER : '';
      const maxTextBytes = MAX_OUTPUT_BYTES - Buffer.byteLength(marker, 'utf8');
      const decoded = Buffer.concat(chunks).toString('utf8').replaceAll('\ufffd', '?').replace(/\r/g, '');
      return truncateUtf8(decoded, maxTextBytes) + marker;
    }

    proc.stdout.on('data', (chunk) => capture('stdout', chunk, stdoutChunks));
    proc.stderr.on('data', (chunk) => capture('stderr', chunk, stderrChunks));
    proc.on('close', (code) => {
      if (settled) return;
      settled = true;
      const stdout = decodeCaptured(stdoutChunks, truncatedStream === 'stdout');
      const stderr = decodeCaptured(stderrChunks, truncatedStream === 'stderr');
      if (code === 0 || code === 1 || truncatedStream === 'stdout') resolve(stdout);
      else reject(new Error(stderr || `rg exited with code ${code}`));
    });
    proc.on('error', (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
  });
}

/**
 * Fallback: Node.js grep implementation.
 */
export async function nodeGrep(pattern, searchPath, options) {
  const regex = new RegExp(pattern, options.caseInsensitive ? 'gi' : 'g');
  const output = createOutputCollector();
  let resultCount = 0;
  const SKIP = new Set(['node_modules', '.git', '__pycache__', '.next', 'dist', 'build', '.cache']);

  async function searchDir(dir) {
    if (resultCount >= (options.maxResults || 500)) return;
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }

    for (const entry of entries) {
      if (resultCount >= (options.maxResults || 500)) return;
      const fullPath = join(dir, entry.name);

      if (entry.isDirectory()) {
        if (SKIP.has(entry.name)) continue;
        await searchDir(fullPath);
      } else {
        const ext = extname(entry.name).toLowerCase();
        if (BINARY_EXTS.has(ext)) continue;

        try {
          const fileStat = await stat(fullPath);
          if (fileStat.size > 1024 * 1024) continue; // skip files > 1MB

          const buffer = await readFile(fullPath);
          const content = decodeTextFile(buffer);
          if (content == null) continue;
          const relPath = relative(searchPath, fullPath);

          if (options.filesOnly) {
            if (regex.test(content)) {
              resultCount += 1;
              if (!output.add(relPath)) return;
            }
            regex.lastIndex = 0;
          } else if (options.count) {
            const matches = content.match(regex);
            if (matches) {
              resultCount += 1;
              if (!output.add(`${relPath}:${matches.length}`)) return;
            }
          } else {
            const lines = content.split('\n');
            for (let i = 0; i < lines.length; i++) {
              if (regex.test(lines[i])) {
                resultCount += 1;
                if (!output.add(`${relPath}:${i + 1}:${lines[i]}`)) return;
              }
              regex.lastIndex = 0;
              if (resultCount >= (options.maxResults || 500)) return;
            }
          }
        } catch {
          // Skip unreadable files
        }
      }
    }
  }

  await searchDir(searchPath);
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
      glob: globFilter, type, case_insensitive = false,
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
      filesOnly: output_mode === 'files_with_matches',
      count: output_mode === 'count',
      context,
      before,
      after,
      multiline,
      maxResults: head_limit * 2,
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
