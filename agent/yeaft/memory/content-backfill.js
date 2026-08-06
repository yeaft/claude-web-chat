import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { listScopes, readScope } from './segment-store.js';
import {
  KIND_VALUES,
  isValidSegmentScope,
  parseSegments,
  serializeSegments,
} from './segment.js';
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
    const rawMemory = readMemoryFile(memoryRoot, scope);
    const segments = hasSerializedSegmentEnvelope(rawMemory)
      ? readScope(memoryRoot, scope)
      : [];
    const bodies = uniqueBodies(segments);
    if (bodies.length === 0 && rawMemory) bodies.push(rawMemory);
    const canonicalBody = bodies.length > 0 ? `${bodies.join('\n\n')}\n` : '';
    const currentContent = existsSync(contentPath) ? readFileSync(contentPath, 'utf8') : '';
    if (currentContent.trim()) {
      // A canonical document already exists. Preserve the raw legacy file in
      // cold storage, but never leave body-only prose live as evidence.
      if (segments.length === 0 && rawMemory) archivePlainLegacyMemory(memoryRoot, scope);
      continue;
    }
    if (!canonicalBody) continue;
    mkdirSync(dirname(contentPath), { recursive: true });
    const tmp = `${contentPath}.tmp.${process.pid}.${Date.now()}`;
    writeFileSync(tmp, canonicalBody, 'utf8');
    renameSync(tmp, contentPath);
    if (readFileSync(contentPath, 'utf8') !== canonicalBody) {
      throw new Error(`backfillCanonicalContent: canonical write verification failed for ${scope}`);
    }
    if (segments.length === 0 && rawMemory) archivePlainLegacyMemory(memoryRoot, scope);
    created += 1;
  }
  return { created };
}

function archivePlainLegacyMemory(memoryRoot, scope) {
  const source = join(memoryRoot, scope, 'memory.md');
  if (!existsSync(source)) return;
  const archive = join(memoryRoot, '.legacy', 'plain-memory', scope, 'memory.md');
  mkdirSync(dirname(archive), { recursive: true });
  let destination = archive;
  if (existsSync(destination)) {
    destination = `${archive}.${Date.now()}`;
  }
  renameSync(source, destination);
}

function readMemoryFile(memoryRoot, scope) {
  const path = join(memoryRoot, scope, 'memory.md');
  if (!existsSync(path)) return '';
  return stripDreamStateBlocks(readFileSync(path, 'utf8'));
}

function hasSerializedSegmentEnvelope(text) {
  const source = String(text || '').replace(/^﻿/, '').trim();
  if (!source.startsWith('---\n')) return false;

  const segments = parseSegments(source);
  if (segments.length === 0 || segments.some(segment => !isWriterSegment(segment))) return false;

  // The internal writer owns one exact wire format. Re-serializing parsed
  // segments must reproduce the file byte-for-byte after outer trimming;
  // otherwise this is user-authored Markdown and must remain opaque.
  return serializeSegments(segments).trim() === source;
}

function isWriterSegment(segment) {
  return /^seg_[0-9a-f]{8}$/.test(segment.id)
    && isValidSegmentScope(segment.scope)
    && KIND_VALUES.has(segment.kind)
    && isStringArray(segment.tags)
    && isStringArray(segment.sourceMessages)
    && isValidTimestamp(segment.createdAt)
    && isValidTimestamp(segment.updatedAt)
    && typeof segment.body === 'string'
    && segment.body.length > 0;
}

function isStringArray(value) {
  return Array.isArray(value) && value.every(item => typeof item === 'string');
}

function isValidTimestamp(value) {
  return typeof value === 'string'
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)
    && Number.isFinite(Date.parse(value));
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
