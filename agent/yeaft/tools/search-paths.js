import { extname } from 'node:path';

export const SEARCH_SKIP_DIRS = new Set([
  'node_modules', '.git', '__pycache__', '.next', '.nuxt',
  'dist', 'build', '.cache', '.venv', 'venv', '.tox',
  'vendor', 'target', '.gradle', '.idea', '.vscode',
]);

export const SEARCH_SKIP_GLOBS = Object.freeze([
  ...[...SEARCH_SKIP_DIRS].flatMap(name => [`!${name}/**`, `!**/${name}/**`]),
  '!.yeaft/worktrees/**',
  '!**/.yeaft/worktrees/**',
]);

const TYPE_EXTENSIONS = {
  js: ['.js', '.jsx', '.mjs', '.cjs'], ts: ['.ts', '.tsx', '.mts', '.cts'],
  py: ['.py'], rust: ['.rs'], go: ['.go'], java: ['.java'],
  json: ['.json'], yaml: ['.yaml', '.yml'], markdown: ['.md', '.markdown'],
  html: ['.html', '.htm'], css: ['.css'], shell: ['.sh', '.bash', '.zsh'],
};

export function isSkippedSearchDirectory(relativePath, name) {
  const normalized = String(relativePath || '').replace(/\\/g, '/');
  return SEARCH_SKIP_DIRS.has(name)
    || normalized === '.yeaft/worktrees'
    || normalized.endsWith('/.yeaft/worktrees');
}

function expandBraces(pattern) {
  const match = pattern.match(/\{([^{}]+)\}/);
  if (!match) return [pattern];
  return match[1].split(',').flatMap(part => expandBraces(
    pattern.slice(0, match.index) + part + pattern.slice(match.index + match[0].length),
  ));
}

function globToRegExpSource(pattern, separator = '/') {
  let source = '';
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === '*' && pattern[index + 1] === '*') {
      index += 1;
      if (pattern[index + 1] === '/') {
        index += 1;
        source += `(?:[\\s\\S]*${separator})?`;
      } else {
        source += '[\\s\\S]*';
      }
    } else if (char === '*') {
      source += separator === '/' ? '[^/]*' : '[^\\\\/]*';
    } else if (char === '?') {
      source += separator === '/' ? '[^/]' : '[^\\\\/]';
    } else if (char === '/') {
      source += separator;
    } else {
      source += char.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
    }
  }
  return source;
}

function globToRegExp(pattern) {
  return new RegExp(`^${globToRegExpSource(pattern)}$`);
}

/** Compile the public glob dialect for fd --full-path on POSIX and Windows. */
export function createFdPathRegex(glob) {
  const normalizedGlob = String(glob || '').replace(/\\/g, '/');
  const alternatives = expandBraces(normalizedGlob || '**/*')
    .map(pattern => globToRegExpSource(pattern, '[\\\\/]'));
  return `(?:^|[\\\\/])(?:${alternatives.join('|')})$`;
}

export function createSearchPathMatcher({ glob, type } = {}) {
  const normalizedGlob = String(glob || '').replace(/\\/g, '/');
  const globMatchers = normalizedGlob
    ? expandBraces(normalizedGlob).map(globToRegExp)
    : [];
  const matchBase = normalizedGlob && !normalizedGlob.includes('/');
  const extensions = type ? TYPE_EXTENSIONS[type] : null;

  return path => {
    const normalized = String(path || '').replace(/\\/g, '/');
    const candidate = matchBase ? normalized.split('/').pop() : normalized;
    if (globMatchers.length && !globMatchers.some(matcher => matcher.test(candidate))) return false;
    if (type && !extensions?.includes(extname(normalized).toLowerCase())) return false;
    return true;
  };
}

export function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error && signal.reason.name === 'AbortError') {
    throw signal.reason;
  }
  const error = new Error(
    signal.reason instanceof Error ? signal.reason.message : 'The operation was aborted',
  );
  error.name = 'AbortError';
  throw error;
}

export function isAbortError(error) {
  return error?.name === 'AbortError';
}

export function waitForAbortable(promise, signal) {
  throwIfAborted(signal);
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      try { throwIfAborted(signal); } catch (error) { reject(error); }
    };
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(promise).then(
      value => { cleanup(); resolve(value); },
      error => { cleanup(); reject(error); },
    );
  });
}

export class SearchBackendLimitError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SearchBackendLimitError';
  }
}
