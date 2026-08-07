/**
 * memory/segment-store.js — disk I/O for segment evidence in memory.md.
 *
 * Bridges between the on-disk evidence format (memory.md per scope, multiple
 * segment blocks) and the SQLite segment index. Canonical prompt-facing prose
 * is stored separately in content.md. This layer handles scope <-> file path
 * mapping; the index layer is scope-agnostic.
 *
 * Path conventions:
 *   ~/.yeaft/memory/user/memory.md
 *   ~/.yeaft/memory/vp/<id>/memory.md
 *   ~/.yeaft/memory/group/<id>/memory.md
 *   ~/.yeaft/memory/feature/<id>/memory.md
 *   ~/.yeaft/memory/topic/<l1>/memory.md
 *   ~/.yeaft/memory/topic/<l1>/<l2>/memory.md
 */

import {
  readFileSync, writeFileSync, existsSync, mkdirSync,
  readdirSync, statSync, renameSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname, relative, sep } from 'node:path';
import { stripDreamStateBlocks } from './prompt-cleanup.js';
import { extractKeywords } from './keywords.js';
import { parseSegments, serializeSegments } from './segment.js';

/**
 * Read all segments for a given scope from disk.
 *
 * @param {string} memoryRoot   e.g. ~/.yeaft/memory
 * @param {string} scope
 * @returns {import('./segment.js').Segment[]}
 */
export function readScope(memoryRoot, scope) {
  const path = scopeFilePath(memoryRoot, scope);
  if (!existsSync(path)) return [];
  const text = readFileSync(path, 'utf8');
  const stripped = stripDreamStateBlocks(text);
  if (!stripped.trimStart().startsWith('---')) return [];
  return parseSegments(stripped, { defaultScope: scope });
}

/**
 * Atomically write segments for a scope. Creates the directory if
 * needed. Empty array → empties the file (we keep the file so absence
 * means "scope never existed").
 *
 * @param {string} memoryRoot
 * @param {string} scope
 * @param {import('./segment.js').Segment[]} segments
 */
export function writeScope(memoryRoot, scope, segments) {
  const path = scopeFilePath(memoryRoot, scope);
  mkdirSync(dirname(path), { recursive: true });
  const text = serializeSegments(segments);
  // atomic-ish write: tmp file + rename
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, text, 'utf8');
  renameSync(tmp, path);
}

/**
 * Read canonical content as a derived FTS record. The stable id lets normal
 * sync delete or update it without changing the segment schema. This record is
 * a scope selector only; Engine always reloads prompt text from content.md.
 *
 * @param {string} memoryRoot
 * @param {string} scope
 * @returns {import('./segment.js').Segment|null}
 */
export function readCanonicalContentRecord(memoryRoot, scope) {
  const path = join(memoryRoot, scope, 'content.md');
  if (!existsSync(path)) return null;
  const body = readFileSync(path, 'utf8');
  if (!body.trim()) return null;
  const stat = statSync(path);
  const timestamp = stat.mtime.toISOString();
  const digest = createHash('sha256').update(scope).digest('hex').slice(0, 12);
  return {
    id: `content_${digest}`,
    scope,
    kind: 'context',
    tags: ['canonical-content', ...extractKeywords(`${scope} ${body}`).slice(0, 128)],
    sourceMessages: [],
    createdAt: timestamp,
    updatedAt: timestamp,
    body,
  };
}

/**
 * Walk the memory root and return all scopes that have evidence memory.md or
 * canonical content.md. Either representation must be queryable.
 *
 * @param {string} memoryRoot
 * @returns {string[]}
 */
export function listScopes(memoryRoot) {
  if (!existsSync(memoryRoot)) return [];
  const out = [];
  walk(memoryRoot, memoryRoot, out);
  return out;
}

function walk(root, dir, out) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) {
      if (entry.startsWith('.')) continue;
      walk(root, full, out);
    } else if (entry === 'memory.md' || entry === 'content.md') {
      const rel = relative(root, dir).split(sep).join('/');
      if (rel && !out.includes(rel)) out.push(rel);
    }
  }
}

/**
 * @param {string} memoryRoot
 * @param {string} scope
 * @returns {string}
 */
export function scopeFilePath(memoryRoot, scope) {
  return join(memoryRoot, scope, 'memory.md');
}
