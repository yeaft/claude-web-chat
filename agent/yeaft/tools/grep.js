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
import { managedCliToolReady, resolveManagedCliCommand } from '../managed-cli.js';
import {
  createSearchPathMatcher,
  SEARCH_SKIP_GLOBS,
  isAbortError,
  isSkippedSearchDirectory,
  throwIfAborted,
  waitForAbortable,
} from './search-paths.js';

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

function normalizeRipgrepPath(searchPath, path) {
  const normalized = String(path || '').replace(/\\/g, '/').replace(/^\.\//, '');
  const normalizedSearchPath = String(searchPath || '').replace(/\\/g, '/');
  const isAbsolute = normalized.startsWith('/')
    || (/^[A-Za-z]:\//.test(normalized) && /^[A-Za-z]:\//.test(normalizedSearchPath));
  if (!isAbsolute) return normalized;
  return relative(searchPath, normalized).replace(/\\/g, '/');
}

function createGrepRecord(path, suffix = '', kind = 'match') {
  return { path, suffix, kind };
}

function renderGrepRecord(record, options) {
  if (options.filesOnly) return record.path;
  const separatorAfterPath = record.kind === 'context' ? '-' : ':';
  return record.path + separatorAfterPath + record.suffix;
}

function compareSearchPaths(left, right) {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function compareGrepRecords(left, right) {
  if (left.path !== right.path) return compareSearchPaths(left.path, right.path);
  const leftLine = Number.parseInt(left.suffix, 10);
  const rightLine = Number.parseInt(right.suffix, 10);
  if (Number.isFinite(leftLine) && Number.isFinite(rightLine) && leftLine !== rightLine) {
    return leftLine - rightLine;
  }
  if (left.suffix === right.suffix) return 0;
  return left.suffix < right.suffix ? -1 : 1;
}

function rewriteMultilineAnchors(source) {
  let result = '';
  let escaped = false;
  let inClass = false;
  for (const character of source) {
    if (escaped) {
      result += character;
      escaped = false;
      continue;
    }
    if (character === '\\') {
      result += character;
      escaped = true;
      continue;
    }
    if (character === '[' && !inClass) {
      inClass = true;
      result += character;
      continue;
    }
    if (character === ']' && inClass) {
      inClass = false;
      result += character;
      continue;
    }
    if (!inClass && character === '^') {
      result += '(?:(?<![\\s\\S])|(?<=\\n))';
    } else if (!inClass && character === '$') {
      result += '(?:(?![\\s\\S])|(?=\\n))';
    } else {
      result += character;
    }
  }
  return result;
}

function hasGroupScopedModifiers(source) {
  let escaped = false;
  let inClass = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === '\\') {
      escaped = true;
      continue;
    }
    if (character === '[' && !inClass) {
      inClass = true;
      continue;
    }
    if (character === ']' && inClass) {
      inClass = false;
      continue;
    }
    if (inClass || character !== '(' || source[index + 1] !== '?') continue;
    let modifierEnd = index + 2;
    while (/[A-Za-z-]/.test(source[modifierEnd] || '')) modifierEnd += 1;
    if (modifierEnd > index + 2 && source[modifierEnd] === ':') return true;
  }
  return false;
}

function hasPythonNamedCapture(source) {
  let escaped = false;
  let inClass = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === '\\') {
      escaped = true;
      continue;
    }
    if (character === '[' && !inClass) {
      inClass = true;
      continue;
    }
    if (character === ']' && inClass) {
      inClass = false;
      continue;
    }
    if (!inClass && source.startsWith('(?P<', index)) return true;
  }
  return false;
}

function stripLeadingInlineModifiers(source) {
  let remaining = source;
  while (true) {
    const match = remaining.match(/^\(\?([ims]*)(?:-([ims]*))?\)/);
    if (!match || (!match[1] && !match[2])) return remaining;
    remaining = remaining.slice(match[0].length);
  }
}

function regexCanMatchEmpty(source) {
  let index = 0;

  function skipClass() {
    index += 1;
    let escaped = false;
    while (index < source.length) {
      const character = source[index];
      index += 1;
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === ']') break;
    }
  }

  function parseGroup(prefixLength, assertion = false) {
    index += prefixLength;
    const nullable = parseDisjunction(')');
    if (source[index] === ')') index += 1;
    return assertion ? true : nullable;
  }

  function parseAtom() {
    const character = source[index];
    if (character === '^' || character === '$') {
      index += 1;
      return true;
    }
    if (character === '\\') {
      index += 1;
      const escaped = source[index] || '';
      index += escaped ? 1 : 0;
      if (escaped === 'b' || escaped === 'B' || /[1-9]/.test(escaped)) return true;
      if (escaped === 'k' && source[index] === '<') {
        const end = source.indexOf('>', index + 1);
        index = end < 0 ? source.length : end + 1;
        return true;
      }
      if ((escaped === 'p' || escaped === 'P') && source[index] === '{') {
        const end = source.indexOf('}', index + 1);
        index = end < 0 ? source.length : end + 1;
      }
      return false;
    }
    if (character === '[') {
      skipClass();
      return false;
    }
    if (character !== '(') {
      index += 1;
      return false;
    }
    if (source.startsWith('(?:', index)) return parseGroup(3);
    if (source.startsWith('(?=', index) || source.startsWith('(?!', index)) {
      return parseGroup(3, true);
    }
    if (source.startsWith('(?<=', index) || source.startsWith('(?<!', index)) {
      return parseGroup(4, true);
    }
    if (source.startsWith('(?<', index) || source.startsWith('(?P<', index)) {
      const nameStart = index + (source.startsWith('(?P<', index) ? 4 : 3);
      const nameEnd = source.indexOf('>', nameStart);
      if (nameEnd >= 0) {
        index = nameEnd + 1;
        const nullable = parseDisjunction(')');
        if (source[index] === ')') index += 1;
        return nullable;
      }
    }
    return parseGroup(1);
  }

  function parseTerm() {
    const atomNullable = parseAtom();
    const quantifier = source.slice(index).match(/^(?:([*?+])|\{(\d+)(?:,(\d*)?)?\})(?:[?+])?/);
    if (!quantifier) return atomNullable;
    index += quantifier[0].length;
    if ((quantifier[1] && quantifier[1] !== '+') || Number(quantifier[2]) === 0) return true;
    return atomNullable;
  }

  function parseSequence(stopCharacter) {
    let nullable = true;
    while (index < source.length && source[index] !== '|' && source[index] !== stopCharacter) {
      nullable = parseTerm() && nullable;
    }
    return nullable;
  }

  function parseDisjunction(stopCharacter = null) {
    let nullable = parseSequence(stopCharacter);
    while (source[index] === '|') {
      index += 1;
      nullable = parseSequence(stopCharacter) || nullable;
    }
    return nullable;
  }

  return parseDisjunction();
}

function validateGrepPattern(pattern, fixedStrings) {
  if (fixedStrings) return;
  if (hasGroupScopedModifiers(pattern)) {
    throw new Error('group-scoped regex modifiers are unsupported');
  }
  if (hasPythonNamedCapture(pattern)) {
    throw new Error('Python-style named capture groups are unsupported');
  }
  if (regexCanMatchEmpty(stripLeadingInlineModifiers(pattern))) {
    throw new Error('regexes that can match empty text are unsupported');
  }
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

export function createOutputCollector(maxBytes = MAX_OUTPUT_BYTES) {
  const parts = [];
  const marker = truncateUtf8(OUTPUT_TRUNCATED_MARKER, maxBytes);
  const markerBytes = Buffer.byteLength(marker, 'utf8');
  let bytes = 0;
  let truncated = false;

  function truncateExistingParts(contentBytes) {
    let remaining = contentBytes;
    const bounded = [];
    for (const part of parts) {
      if (remaining <= 0) break;
      const value = truncateUtf8(part, remaining);
      if (value) bounded.push(value);
      remaining -= Buffer.byteLength(value, 'utf8');
    }
    parts.length = 0;
    parts.push(...bounded);
    bytes = contentBytes - remaining;
  }

  function markTruncated(part = '') {
    if (truncated) return;
    truncated = true;
    const contentBytes = Math.max(0, maxBytes - markerBytes);
    truncateExistingParts(contentBytes);
    const remaining = contentBytes - bytes;
    if (remaining > 0 && part) {
      const bounded = truncateUtf8(part, remaining);
      if (bounded) {
        parts.push(bounded);
        bytes += Buffer.byteLength(bounded, 'utf8');
      }
    }
  }

  return {
    add(value) {
      if (truncated) return false;
      const normalized = String(value).replace(/\r/g, '');
      const line = truncateUtf8(normalized, MAX_LINE_BYTES);
      const lineWasTruncated = Buffer.byteLength(normalized, 'utf8') > Buffer.byteLength(line, 'utf8');
      const part = (parts.length > 0 ? '\n' : '') + line;
      const partBytes = Buffer.byteLength(part, 'utf8');
      if (lineWasTruncated || bytes + partBytes > maxBytes) {
        markTruncated(part);
        return false;
      }
      parts.push(part);
      bytes += partBytes;
      return true;
    },
    get truncated() { return truncated; },
    toString() { return parts.join('') + (truncated ? marker : ''); },
  };
}

/**
 * Check if ripgrep is available.
 */
/**
 * Run ripgrep and return results.
 */
export function runRipgrep(pattern, searchPath, options, spawnProcess = spawn, command = 'rg') {
  throwIfAborted(options.signal);
  return new Promise((resolve, reject) => {
    const relativeTarget = options.cwd ? relative(options.cwd, searchPath) : null;
    const searchTarget = relativeTarget === '' ? null : (relativeTarget ?? searchPath);
    const args = [
      '--no-heading',
      '--line-number',
      '--color', 'never',
      '--hidden',
      '--no-ignore',
      '--null',
    ];
    if (options.caseInsensitive) args.push('-i');
    if (options.fixedStrings) args.push('-F');
    // User glob and type semantics are defined by the shared matcher below.
    // Do not pass either positive filter to rg: rg's glob dialect and type
    // registry are broader, so either filter could discard a fallback match.
    for (const skipGlob of SEARCH_SKIP_GLOBS) args.push('--glob', skipGlob);
    if (options.filesOnly) args.push('-l');
    if (options.count) args.push('-c');
    if (options.context) args.push('-C', String(options.context));
    if (options.before) args.push('-B', String(options.before));
    if (options.after) args.push('-A', String(options.after));
    if (options.context || options.before || options.after) args.push('--no-context-separator');
    if (options.multiline) args.push('-U', '--multiline-dotall');
    args.push('--sort', 'path');
    args.push('--', pattern);
    if (searchTarget) args.push(searchTarget);

    const proc = spawnProcess(command, args, {
      cwd: options.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const requestedBudget = Number(options.byteBudget);
    const stdoutBudget = Number.isFinite(requestedBudget) && requestedBudget >= 0
      ? Math.min(requestedBudget, MAX_OUTPUT_BYTES)
      : MAX_OUTPUT_BYTES;
    const stdout = createOutputCollector(stdoutBudget);
    const records = [];
    const matchesPath = createSearchPathMatcher(options);
    const stdoutDecoder = new StringDecoder('utf8');
    const stderrChunks = [];
    let pendingStdout = '';
    let stderrBytes = 0;
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let resultCount = 0;
    let pendingPath = null;
    let discardSuffix = false;
    let stoppedForLimit = false;
    let stopRequested = false;
    let settled = false;

    function stop() {
      if (stopRequested) return;
      stopRequested = true;
      try { proc.kill(); } catch {}
    }

    function captureRecord(record) {
      if (stoppedForLimit || stdoutTruncated || !matchesPath(record.path)) return;
      resultCount += 1;
      records.push(record);
      if (!stdout.add(renderGrepRecord(record, options))) stdoutTruncated = true;
      if (resultCount >= Math.max(1, options.maxResults || 500)) stoppedForLimit = true;
      if (stdoutTruncated || stoppedForLimit) stop();
    }

    function captureSuffix(suffix) {
      if (pendingPath == null) return;
      let kind = 'match';
      if (!options.count && suffix.match(/^\d+-/)) kind = 'context';
      captureRecord(createGrepRecord(pendingPath, suffix, kind));
      pendingPath = null;
    }

    function drainStdout(final = false) {
      while (!stdoutTruncated && !stoppedForLimit) {
        if (discardSuffix) {
          const boundary = pendingStdout.indexOf('\n');
          if (boundary < 0) break;
          pendingStdout = pendingStdout.slice(boundary + 1);
          pendingPath = null;
          discardSuffix = false;
          continue;
        }
        if (pendingPath == null) {
          const boundary = pendingStdout.indexOf('\0');
          if (boundary < 0) break;
          pendingPath = normalizeRipgrepPath(searchPath, pendingStdout.slice(0, boundary));
          pendingStdout = pendingStdout.slice(boundary + 1);
          if (options.filesOnly) {
            captureRecord(createGrepRecord(pendingPath));
            pendingPath = null;
          }
          continue;
        }
        const boundary = pendingStdout.indexOf('\n');
        if (boundary < 0) break;
        const suffix = pendingStdout.slice(0, boundary).replace(/\r$/, '');
        pendingStdout = pendingStdout.slice(boundary + 1);
        captureSuffix(suffix);
      }
      if (final && !stdoutTruncated && !stoppedForLimit) {
        if (pendingPath != null && pendingStdout && !discardSuffix) {
          captureSuffix(pendingStdout.replace(/\r$/, ''));
        }
        pendingStdout = '';
        pendingPath = null;
        discardSuffix = false;
      }
    }

    function captureStdout(chunk) {
      if (stdoutTruncated || stoppedForLimit) return;
      pendingStdout += stdoutDecoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      drainStdout();
      if (pendingPath != null && !discardSuffix
        && Buffer.byteLength(pendingStdout, 'utf8') > MAX_LINE_BYTES) {
        if (matchesPath(pendingPath)) {
          captureSuffix(truncateUtf8(pendingStdout, MAX_LINE_BYTES + 1));
          pendingStdout = '';
        } else {
          discardSuffix = true;
          drainStdout();
          if (discardSuffix) pendingStdout = '';
        }
      }
    }

    function captureStderr(chunk) {
      if (stderrTruncated) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const remaining = MAX_OUTPUT_BYTES - stderrBytes;
      if (buffer.length > remaining) {
        if (remaining > 0) stderrChunks.push(buffer.subarray(0, remaining));
        stderrBytes = MAX_OUTPUT_BYTES;
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

    const cleanup = () => options.signal?.removeEventListener('abort', onAbort);
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      let abort;
      try { throwIfAborted(options.signal); } catch (error) { abort = error; }
      stop();
      reject(abort);
    };

    proc.stdout.on('data', captureStdout);
    proc.stderr.on('data', captureStderr);
    proc.on('close', (code) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (!stdoutTruncated && !stoppedForLimit) {
        pendingStdout += stdoutDecoder.end();
        drainStdout(true);
      }
      const output = stdout.toString();
      const stderr = decodeCaptured(stderrChunks, MAX_OUTPUT_BYTES, stderrTruncated);
      if (code === 0 || code === 1 || stoppedForLimit || stdoutTruncated) {
        resolve(options.structured
          ? { output, records, resultCount, truncated: stdout.truncated }
          : output);
      } else reject(new Error(stderr || `rg exited with code ${code}`));
    });
    proc.on('error', (err) => {
      if (settled || stopRequested) return;
      settled = true;
      cleanup();
      reject(err);
    });
    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.signal?.aborted) onAbort();
  });
}

/**
 * Fallback: Node.js grep implementation.
 */
export async function nodeGrep(pattern, searchPath, options) {
  throwIfAborted(options.signal);
  let regexSource = options.fixedStrings
    ? pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    : pattern;
  const regexFlags = new Set(['g']);
  if (options.caseInsensitive) regexFlags.add('i');
  if (options.multiline) {
    regexFlags.add('m');
    regexFlags.add('s');
  }
  if (!options.fixedStrings) {
    while (true) {
      const inlineFlags = regexSource.match(/^\(\?([ims]*)(?:-([ims]*))?\)/);
      if (!inlineFlags || (!inlineFlags[1] && !inlineFlags[2])) break;
      for (const flag of inlineFlags[1]) regexFlags.add(flag);
      for (const flag of inlineFlags[2] || '') regexFlags.delete(flag);
      regexSource = regexSource.slice(inlineFlags[0].length);
    }
    if (regexFlags.has('m')) {
      regexSource = rewriteMultilineAnchors(regexSource);
      regexFlags.delete('m');
    }
  }
  const regex = new RegExp(regexSource, [...regexFlags].join(''));
  const output = createOutputCollector(options.byteBudget || SEARCH_RESULT_BYTES);
  const records = [];
  const maxResults = Math.max(1, options.maxResults || 500);
  const matchesPath = createSearchPathMatcher(options);
  let resultCount = 0;
  let stopped = false;

  function matchesFilters(fullPath) {
    return matchesPath(relative(searchPath, fullPath).replace(/\\/g, '/'));
  }

  function addResult(record) {
    if (stopped) return;
    resultCount += 1;
    records.push(record);
    if (!output.add(renderGrepRecord(record, options)) || resultCount >= maxResults) stopped = true;
  }

  async function collectFileRecords(fullPath) {
    throwIfAborted(options.signal);
    if (!matchesFilters(fullPath) || BINARY_EXTS.has(extname(fullPath).toLowerCase())) return [];
    try {
      const fileStat = await stat(fullPath);
      throwIfAborted(options.signal);
      if (fileStat.size > 1024 * 1024) return [];
      const decoded = decodeTextFile(await readFile(fullPath));
      throwIfAborted(options.signal);
      if (decoded == null) return [];
      const content = decoded;
      const relPath = relative(searchPath, fullPath).replace(/\\/g, '/');
      const rawLines = content.split('\n');
      if (rawLines.at(-1) === '') rawLines.pop();
      const lines = rawLines.map(line => line.replace(/\r/g, ''));
      const matchedLines = new Set();
      const matchStartLines = new Set();

      if (options.multiline && lines.length > 0) {
        const lineStarts = [];
        let offset = 0;
        for (const line of rawLines) {
          lineStarts.push(offset);
          offset += line.length + 1;
        }
        const lineAtOffset = value => {
          let low = 0;
          let high = lineStarts.length - 1;
          while (low < high) {
            const middle = Math.ceil((low + high) / 2);
            if (lineStarts[middle] <= value) low = middle;
            else high = middle - 1;
          }
          return low;
        };
        regex.lastIndex = 0;
        let match;
        while ((match = regex.exec(content)) !== null) {
          const startLine = lineAtOffset(match.index);
          const lastOffset = match[0].length > 0
            ? match.index + match[0].length - 1
            : match.index;
          const endLine = lineAtOffset(lastOffset);
          matchStartLines.add(startLine);
          for (let line = startLine; line <= endLine; line += 1) matchedLines.add(line);
          if (match[0].length === 0) {
            if (regex.lastIndex >= content.length) break;
            regex.lastIndex += content.codePointAt(regex.lastIndex) > 0xffff ? 2 : 1;
          }
        }
      } else {
        for (let line = 0; line < rawLines.length; line += 1) {
          regex.lastIndex = 0;
          if (regex.test(rawLines[line])) {
            matchedLines.add(line);
            matchStartLines.add(line);
          }
        }
      }

      if (options.filesOnly) {
        return matchStartLines.size > 0 ? [createGrepRecord(relPath)] : [];
      }
      if (options.count) {
        return matchStartLines.size > 0
          ? [createGrepRecord(relPath, String(matchStartLines.size))]
          : [];
      }

      const beforeLines = Math.max(0, Number(options.before ?? options.context ?? 0));
      const afterLines = Math.max(0, Number(options.after ?? options.context ?? 0));
      const selected = new Map();
      for (const matchIndex of matchedLines) {
        const start = Math.max(0, matchIndex - beforeLines);
        const end = Math.min(lines.length - 1, matchIndex + afterLines);
        for (let i = start; i <= end; i += 1) {
          const kind = matchedLines.has(i) ? 'match' : 'context';
          if (kind === 'match' || !selected.has(i)) selected.set(i, kind);
        }
      }
      return [...selected.entries()]
        .sort((a, b) => a[0] - b[0])
        .slice(0, maxResults)
        .map(([lineIndex, kind]) => {
          const lineSeparator = kind === 'context' ? '-' : ':';
          return createGrepRecord(
            relPath,
            `${lineIndex + 1}${lineSeparator}${lines[lineIndex]}`,
            kind,
          );
        });
    } catch (error) {
      if (isAbortError(error)) throw error;
      return [];
    }
  }

  async function searchDir(dir) {
    throwIfAborted(options.signal);
    if (stopped) return;
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch (error) {
      if (isAbortError(error)) throw error;
      return;
    }
    throwIfAborted(options.signal);
    entries.sort((left, right) => compareSearchPaths(left.name, right.name));
    let pendingFiles = [];

    async function flushFiles() {
      for (let i = 0; i < pendingFiles.length && !stopped; i += FALLBACK_CONCURRENCY) {
        throwIfAborted(options.signal);
        const batches = await Promise.all(
          pendingFiles.slice(i, i + FALLBACK_CONCURRENCY).map(collectFileRecords),
        );
        for (const batch of batches) {
          for (const record of batch) {
            addResult(record);
            if (stopped) break;
          }
          if (stopped) break;
        }
      }
      pendingFiles = [];
    }

    for (const entry of entries) {
      throwIfAborted(options.signal);
      if (stopped) break;
      const fullPath = join(dir, entry.name);
      if (!entry.isDirectory()) {
        pendingFiles.push(fullPath);
        continue;
      }
      const relPath = relative(searchPath, fullPath).replace(/\\/g, '/');
      if (isSkippedSearchDirectory(relPath, entry.name)) continue;
      await flushFiles();
      if (!stopped) await searchDir(fullPath);
    }
    await flushFiles();
  }

  throwIfAborted(options.signal);
  const rootStat = await stat(searchPath);
  throwIfAborted(options.signal);
  if (rootStat.isDirectory()) await searchDir(searchPath);
  else {
    for (const record of await collectFileRecords(searchPath)) addResult(record);
  }
  const result = output.toString();
  return options.structured
    ? { output: result, records, resultCount, truncated: output.truncated }
    : result;
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
        type: 'integer',
        minimum: 1,
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
    if (!Number.isInteger(head_limit) || head_limit < 1) {
      return JSON.stringify({ error: 'head_limit must be a positive integer' });
    }
    const headLimit = Math.min(head_limit, 10000);

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
      maxResults: headLimit + 1,
      byteBudget: SEARCH_RESULT_BYTES,
      cwd: absPath,
      signal: ctx?.signal,
      structured: true,
    };

    try {
      throwIfAborted(ctx?.signal);
      validateGrepPattern(pattern, fixed_strings);
      let result;
      let rgCommand = resolveManagedCliCommand('rg', { yeaftDir: ctx?.yeaftDir });
      if (!rgCommand) {
        await waitForAbortable(managedCliToolReady(ctx?.managedCliReady, 'rg'), ctx?.signal);
        rgCommand = resolveManagedCliCommand('rg', { yeaftDir: ctx?.yeaftDir });
      }

      if (rgCommand) {
        try {
          result = await runRipgrep(pattern, absPath, options, spawn, rgCommand);
        } catch (error) {
          if (isAbortError(error)) throw error;
          result = await nodeGrep(pattern, absPath, options);
        }
      } else {
        result = await nodeGrep(pattern, absPath, options);
      }

      const {
        output = '', records = [], resultCount = 0, truncated = false,
      } = result || {};
      if (records.length === 0 && !output.trim()) return '(no matches)';
      if (truncated) return output.trim();
      const visibleRecords = [...records]
        .sort(compareGrepRecords)
        .slice(0, headLimit);
      const finalOutput = createOutputCollector(SEARCH_RESULT_BYTES);
      for (const record of visibleRecords) {
        if (!finalOutput.add(renderGrepRecord(record, options))) break;
      }
      if (!finalOutput.truncated && resultCount > headLimit) {
        finalOutput.add('\n... (more results omitted)');
      }
      return finalOutput.toString();
    } catch (err) {
      if (isAbortError(err)) throw err;
      return formatGrepError(err.message);
    }
  },
});
