import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { listScopes, readScope } from './segment-store.js';
import { parseSegments } from './segment.js';
import { stripDreamStateBlocks } from './prompt-cleanup.js';

/**
 * Seed canonical content.md for legacy scopes that only have Dream evidence
 * segments or the old body-only memory.md format. The migration is
 * deterministic, idempotent, and never reads raw transcripts. Dream can later
 * reorganize this seed without losing
 * the segment provenance kept in memory.md.
 */
export function backfillCanonicalContent(memoryRoot) {
  let created = 0;
  for (const scope of listScopes(memoryRoot)) {
    if (scope.startsWith('.legacy/') || scope.startsWith('.dream-bak/')) continue;
    const contentPath = join(memoryRoot, scope, 'content.md');
    if (existsSync(contentPath) && readFileSync(contentPath, 'utf8').trim()) continue;
    const rawMemory = readMemoryFile(memoryRoot, scope);
    const segments = hasSerializedSegmentEnvelope(rawMemory)
      ? readScope(memoryRoot, scope)
      : [];
    const bodies = uniqueBodies(segments);
    if (bodies.length === 0 && rawMemory) bodies.push(rawMemory);
    if (bodies.length === 0) continue;
    mkdirSync(dirname(contentPath), { recursive: true });
    const tmp = `${contentPath}.tmp.${process.pid}.${Date.now()}`;
    writeFileSync(tmp, `${bodies.join('\n\n')}\n`, 'utf8');
    renameSync(tmp, contentPath);
    created += 1;
  }
  return { created };
}

function readMemoryFile(memoryRoot, scope) {
  const path = join(memoryRoot, scope, 'memory.md');
  if (!existsSync(path)) return '';
  return stripDreamStateBlocks(readFileSync(path, 'utf8'));
}

function hasSerializedSegmentEnvelope(text) {
  if (!text || !/^---\s*$/m.test(text)) return false;
  const envelope = /^---\s*\n([\s\S]*?)\n---\s*(?:\n|$)/m.exec(text);
  if (!envelope || !/^\s*(?:id|scope|kind|tags|sourceMessages|createdAt|updatedAt):/m.test(envelope[1])) {
    return false;
  }
  return parseSegments(text, { defaultScope: 'user' }).some(segment => segment.body);
}

function uniqueBodies(segments) {
  const seen = new Set();
  const bodies = [];
  for (const segment of segments) {
    const body = String(segment?.body || '').trim();
    if (!body) continue;
    const key = body.replace(/\s+/g, ' ').toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    bodies.push(body);
  }
  return bodies;
}
