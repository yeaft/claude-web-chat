import { promises as fsp } from 'node:fs';
import { dirname, join } from 'node:path';

import { readContent, readSummary, writeContent, writeSummary } from '../memory/store.js';
import { readScope, writeScope } from '../memory/segment-store.js';
import { computeSegmentId } from '../memory/segment.js';
import { syncScope } from '../memory/segment-sync.js';
import { snapshotScope } from './snapshot.js';
import { render } from './prompts/index.js';
import { parseJsonSafe } from './triage.js';

const MIN_TOPICS_FOR_CONSOLIDATION = 24;
const MAX_TOPICS_PER_BATCH = 240;
const MAX_CONSOLIDATION_GROUPS_PER_SESSION = 12;

export async function consolidateSessionTopics(opts) {
  const topics = normalizeTopics(opts?.topics);
  if (!opts?.root || !opts?.sessionId || typeof opts?.llm !== 'function') {
    throw new Error('consolidateSessionTopics: root, sessionId, and llm are required');
  }
  if (topics.length < MIN_TOPICS_FOR_CONSOLIDATION) {
    return { considered: topics.length, merged: 0, groups: [] };
  }

  const groups = [];
  const batchStep = topics.length <= MAX_TOPICS_PER_BATCH
    ? MAX_TOPICS_PER_BATCH
    : MAX_TOPICS_PER_BATCH - Math.min(40, MAX_TOPICS_PER_BATCH - 1);
  for (let start = 0; start < topics.length; start += batchStep) {
    const batch = topics.length <= MAX_TOPICS_PER_BATCH
      ? topics
      : buildOverlappingBatch(topics, start, MAX_TOPICS_PER_BATCH);
    const raw = await opts.llm({
      pass: 'topic-consolidation',
      system: consolidationSystem(opts.language),
      prompt: render('consolidateTopics', {
        topics: batch.map(topic => `- ${topic.path} — ${oneLine(topic.summary)}`).join('\n'),
      }, { language: opts.language }),
    });
    const parsed = parseJsonSafe(raw);
    if (!parsed || !Array.isArray(parsed.groups)) continue;
    groups.push(...normalizeGroups(parsed.groups, new Set(batch.map(topic => topic.path))));
  }

  let merged = 0;
  const applied = [];
  for (const group of nonOverlappingGroups(groups).slice(0, MAX_CONSOLIDATION_GROUPS_PER_SESSION)) {
    const result = await mergeTopicGroup(group, opts);
    if (!result) continue;
    merged += result.removed.length;
    applied.push(result);
  }
  return { considered: topics.length, merged, groups: applied };
}

async function mergeTopicGroup(group, opts) {
  const allPaths = [group.canonical, ...group.merge].filter(Boolean);
  const records = await Promise.all(allPaths.map(path => loadTopic(path, opts)));
  const available = records.filter(record => record.content || record.summary || record.segments.length > 0);
  if (available.length < 2) return null;

  const raw = await opts.llm({
    pass: 'topic-consolidation-merge',
    system: consolidationSystem(opts.language),
    prompt: render('mergeTopics', {
      canonical: group.canonical,
      topicContents: available.map(record => [
        `## ${record.path}`,
        record.content || '(no canonical content yet)',
        '',
        `Catalog summary: ${record.summary || '(none)'}`,
      ].join('\n')).join('\n\n'),
    }, { language: opts.language }),
  });
  const parsed = parseJsonSafe(raw);
  if (!parsed || typeof parsed.content_md !== 'string' || typeof parsed.summary_md !== 'string') return null;

  for (const record of available) await snapshotScope(opts.root, opts.ts, record.scope);
  const canonical = available.find(record => record.path === group.canonical);
  if (!canonical) return null;
  const mergedSegments = dedupeSegments(available.flatMap(record => record.segments), canonical.scope);
  const mergedContent = parsed.content_md.trim();
  const mergedSummary = parsed.summary_md.trim();
  if (!mergedContent || !mergedSummary) return null;
  await writeContent(canonical.scopeObject, `${mergedContent}\n`, { root: opts.root });
  await writeSummary(canonical.scopeObject, mergedSummary, { root: opts.root, language: opts.language });
  writeScope(opts.root, canonical.scope, mergedSegments);

  const removed = [];
  for (const record of available) {
    if (record.scope === canonical.scope) continue;
    await fsp.rm(record.dir, { recursive: true, force: true });
    removed.push(record.path);
    await removeEmptyParents(record.dir, join(opts.root, 'sessions', opts.sessionId, 'topic'));
  }
  if (opts.segmentIndex) {
    for (const record of available) {
      if (record.scope !== canonical.scope) opts.segmentIndex.deleteScope(record.scope);
    }
    syncScope(opts.root, opts.segmentIndex, canonical.scope);
  }
  return { canonical: canonical.path, removed };
}

async function loadTopic(path, opts) {
  const parts = path.split('/').filter(Boolean);
  const scopeObject = { kind: 'session-topic', sessionId: opts.sessionId, path: parts };
  const scope = `sessions/${opts.sessionId}/topic/${parts.join('/')}`;
  return {
    path,
    scope,
    scopeObject,
    dir: join(opts.root, scope),
    content: await readContent(scopeObject, { root: opts.root }).catch(() => ''),
    summary: await readSummary(scopeObject, { root: opts.root, language: opts.language }).catch(() => ''),
    segments: readScope(opts.root, scope),
  };
}

function buildOverlappingBatch(topics, start, size) {
  const anchorCount = Math.min(40, Math.max(0, size - 1));
  const anchor = topics.slice(0, anchorCount);
  const windowStart = Math.max(anchorCount, start);
  const window = topics.slice(windowStart, windowStart + (size - anchor.length));
  return normalizeTopics([...anchor, ...window]);
}

function normalizeTopics(topics) {
  const byPath = new Map();
  for (const topic of Array.isArray(topics) ? topics : []) {
    const path = normalizePath(topic?.path);
    if (!path || byPath.has(path)) continue;
    byPath.set(path, { path, summary: String(topic?.summary || '').trim() });
  }
  return [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
}

function normalizeGroups(groups, allowed) {
  const out = [];
  for (const group of groups) {
    const canonical = normalizePath(group?.canonical);
    const merge = [...new Set((Array.isArray(group?.merge) ? group.merge : [])
      .map(normalizePath)
      .filter(path => path && path !== canonical && allowed.has(path)))];
    if (!canonical || !allowed.has(canonical) || merge.length === 0) continue;
    out.push({ canonical, merge });
  }
  return out;
}

function nonOverlappingGroups(groups) {
  const used = new Set();
  const out = [];
  for (const group of groups) {
    const paths = [group.canonical, ...group.merge];
    if (paths.some(path => used.has(path))) continue;
    paths.forEach(path => used.add(path));
    out.push(group);
  }
  return out;
}

function dedupeSegments(segments, canonicalScope) {
  const out = new Map();
  for (const segment of segments) {
    if (!segment?.id || !segment?.body) continue;
    const key = `${segment.kind || 'context'}\u0000${segment.body.trim().toLowerCase()}`;
    const current = out.get(key);
    const sourceMessages = [...new Set([
      ...(current?.sourceMessages || []),
      ...(segment.sourceMessages || []),
    ].map(String).filter(Boolean))];
    out.set(key, { ...(current || segment), scope: canonicalScope, sourceMessages });
  }
  return [...out.values()].map(segment => ({
    ...segment,
    id: computeSegmentId({
      scope: canonicalScope,
      kind: segment.kind || 'context',
      body: segment.body,
    }),
  }));
}

function normalizePath(value) {
  const path = String(value || '').trim().replace(/^topic\//, '');
  const parts = path.split('/').filter(Boolean);
  if (parts.length < 1 || parts.length > 2) return '';
  if (parts.some(part => !/^[A-Za-z0-9_\-.一-鿿]+$/.test(part))) return '';
  return parts.join('/');
}

async function removeEmptyParents(dir, stop) {
  let current = dirname(dir);
  while (current.startsWith(stop) && current !== stop) {
    try {
      const entries = await fsp.readdir(current);
      if (entries.length > 0) return;
      await fsp.rmdir(current);
    } catch { return; }
    current = dirname(current);
  }
}

function consolidationSystem(language) {
  return String(language || '').toLowerCase().startsWith('zh')
    ? '你是 Dream topic consolidation 阶段。只输出严格 JSON。只能合并语义相同、可由同一 canonical topic 完整承载的主题；不确定就不合并。'
    : 'You are the Dream topic consolidation stage. Return strict JSON only. Merge only topics with the same durable subject that one canonical topic can represent without information loss; when uncertain, do not merge.';
}

function oneLine(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, 320);
}
