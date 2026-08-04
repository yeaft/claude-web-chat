import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { listScopes, readScope } from './segment-store.js';

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
    const segments = readScope(memoryRoot, scope);
    const bodies = uniqueBodies(segments);
    if (bodies.length === 0) {
      const legacyBody = readLegacyPlainBody(memoryRoot, scope);
      if (legacyBody) bodies.push(legacyBody);
    }
    if (bodies.length === 0) continue;
    mkdirSync(dirname(contentPath), { recursive: true });
    const tmp = `${contentPath}.tmp.${process.pid}.${Date.now()}`;
    writeFileSync(tmp, `${bodies.join('\n\n')}\n`, 'utf8');
    renameSync(tmp, contentPath);
    created += 1;
  }
  return { created };
}

function readLegacyPlainBody(memoryRoot, scope) {
  const path = join(memoryRoot, scope, 'memory.md');
  if (!existsSync(path)) return '';
  const body = readFileSync(path, 'utf8').trim();
  if (!body || /^---\s*$/m.test(body)) return '';
  return body;
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
