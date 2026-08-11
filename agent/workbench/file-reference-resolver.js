import { readdir, stat } from 'node:fs/promises';
import { basename, join, relative, resolve } from 'node:path';
import { platform } from 'node:os';
import ctx from '../context.js';
import { resolveAndValidatePath } from './utils.js';
import { sendWorkbenchResult } from './request-routing.js';

const MAX_REFERENCES = 32;
const MAX_SCANNED_ENTRIES = 5000;
const MAX_DEPTH = 10;
const SKIP_DIRS = new Set(['.git', 'node_modules', '__pycache__', '.next', '.nuxt', 'dist', 'build', '.cache', 'bin', 'obj']);

async function isFile(path) {
  try { return (await stat(path)).isFile(); } catch { return false; }
}

function comparable(value) {
  const normalized = String(value || '').replaceAll('\\', '/');
  return platform() === 'win32' ? normalized.toLowerCase() : normalized;
}

async function findUniqueBasenames(workDir, requestedPaths, {
  maxScannedEntries = MAX_SCANNED_ENTRIES,
  maxDepth = MAX_DEPTH,
  readDirectory = readdir,
} = {}) {
  const targets = new Set(requestedPaths.map(path => comparable(basename(path))).filter(Boolean));
  const matches = new Map([...targets].map(target => [target, []]));
  if (targets.size === 0) return { matches, complete: true };
  let scanned = 0;
  let complete = true;

  async function walk(dir, depth) {
    if (depth > maxDepth) {
      complete = false;
      return;
    }
    let entries;
    try {
      entries = await readDirectory(dir, { withFileTypes: true });
    } catch {
      complete = false;
      return;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (scanned >= maxScannedEntries) {
        complete = false;
        return;
      }
      scanned += 1;
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) await walk(join(dir, entry.name), depth + 1);
      } else if (entry.isFile()) {
        const target = comparable(entry.name);
        const found = matches.get(target);
        if (found && found.length < 2) found.push(join(dir, entry.name));
      }
    }
  }

  await walk(resolve(workDir), 0);
  return { matches, complete };
}

export async function resolveFileReferences(references, workDir, scanOptions) {
  const unique = [...new Set((Array.isArray(references) ? references : [])
    .map(value => typeof value === 'string' ? value.trim() : '')
    .filter(Boolean))].slice(0, MAX_REFERENCES);
  const exactMatches = await Promise.all(unique.map(async requestedPath => {
    const exactPath = resolveAndValidatePath(requestedPath, workDir);
    return await isFile(exactPath) ? exactPath : null;
  }));
  const unresolved = unique.filter((_path, index) => !exactMatches[index]);
  const basenameScan = await findUniqueBasenames(workDir, unresolved, scanOptions);
  const root = resolve(workDir);

  return unique.flatMap((requestedPath, index) => {
    const matches = basenameScan.matches.get(comparable(basename(requestedPath))) || [];
    const fallbackPath = basenameScan.complete && matches.length === 1 ? matches[0] : null;
    const matchedPath = exactMatches[index] || fallbackPath;
    if (!matchedPath) return [];
    return [{
      requestedPath,
      resolvedPath: relative(root, matchedPath).replaceAll('\\', '/') || basename(matchedPath),
    }];
  });
}

export async function handleResolveFileReferences(msg) {
  const { conversationId, requestId, _requestUserId, _requestClientId } = msg;
  const conv = ctx.conversations.get(conversationId);
  const workDir = msg.workDir || conv?.workDir || ctx.CONFIG.workDir;
  try {
    const references = await resolveFileReferences(msg.references, workDir);
    sendWorkbenchResult(ctx, msg, {
      type: 'file_references_resolved',
      conversationId,
      requestId,
      _requestUserId,
      _requestClientId,
      references,
    });
  } catch (error) {
    sendWorkbenchResult(ctx, msg, {
      type: 'file_references_resolved',
      conversationId,
      requestId,
      _requestUserId,
      _requestClientId,
      references: [],
      error: error.message,
    });
  }
}
