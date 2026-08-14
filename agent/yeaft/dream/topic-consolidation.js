import {
  existsSync,
  mkdirSync,
  renameSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

import { readContent, readMemory, readSummary } from '../memory/store.js';
import { readScope, writeScope } from '../memory/segment-store.js';
import { computeSegmentId } from '../memory/segment.js';
import { syncScope } from '../memory/segment-sync.js';
import {
  normalizeTopicPath,
  resolveTopicRedirect,
  TOPIC_REDIRECT_FILE,
} from '../memory/topic-redirect.js';
import { render } from './prompts/index.js';
import { boundDreamPrompt } from './segment.js';
import { parseJsonSafe } from './triage.js';
import { snapshotScope } from './snapshot.js';

const MAX_TOPICS_PER_BATCH = 240;
const MAX_CONSOLIDATION_GROUPS_PER_SESSION = 12;

function topicConsolidationSystem(language) {
  return String(language || '').toLowerCase().startsWith('zh')
    ? '你是 Dream 记忆主题整理阶段。只回复严格 JSON，不要输出说明文字或 markdown fence。'
    : 'You are the Dream memory topic-consolidation stage. Reply with strict JSON only, without prose or markdown fences.';
}

export async function consolidateSessionTopics(opts) {
  if (!opts?.root || !opts?.sessionId || typeof opts.llm !== 'function') {
    throw new Error('consolidateSessionTopics: root, sessionId, and llm are required');
  }
  const topics = normalizeTopics(normalizeTopics(opts.topics).map(topic => ({
    ...topic,
    path: resolveTopicRedirect(opts.root, opts.sessionId, topic.path),
  })).filter(topic => topic.path));
  if (topics.length < 2) {
    return { considered: topics.length, checked: topics.length, merged: 0, groups: [] };
  }

  const groups = [];
  const batchStep = topics.length <= MAX_TOPICS_PER_BATCH
    ? MAX_TOPICS_PER_BATCH
    : MAX_TOPICS_PER_BATCH - Math.min(40, MAX_TOPICS_PER_BATCH - 1);
  for (let start = 0; start < topics.length; start += batchStep) {
    const batch = topics.length <= MAX_TOPICS_PER_BATCH
      ? topics
      : buildOverlappingBatch(topics, start, MAX_TOPICS_PER_BATCH);
    if (batch.length < 2) continue;
    const parsed = parseJsonSafe(await opts.llm({
      pass: 'topic-consolidation',
      system: topicConsolidationSystem(opts.language),
      prompt: boundDreamPrompt(render('consolidateTopics', {
        topics: batch.map(topic => `- ${topic.path}: ${topic.summary}`).join('\n'),
      }, { language: opts.language }), opts.maxPromptChars),
    }));
    if (!Array.isArray(parsed?.groups)) continue;
    groups.push(...validateGroups(parsed.groups, topics));
  }

  const applied = [];
  for (const group of nonOverlappingGroups(groups).slice(0, MAX_CONSOLIDATION_GROUPS_PER_SESSION)) {
    const result = await applyConsolidationGroup(group, opts);
    if (result) applied.push(result);
  }
  return {
    considered: topics.length,
    checked: topics.length,
    merged: applied.reduce((count, group) => count + group.merged.length, 0),
    groups: applied,
  };
}

function normalizeTopics(topics) {
  const byPath = new Map();
  for (const topic of Array.isArray(topics) ? topics : []) {
    const path = normalizeTopicPath(topic?.path);
    if (!path || byPath.has(path)) continue;
    byPath.set(path, { path, summary: String(topic?.summary || '').trim() });
  }
  return [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
}

function buildOverlappingBatch(topics, start, limit) {
  const batch = topics.slice(start, start + limit);
  if (start === 0 || batch.length >= limit) return batch;
  const overlap = Math.min(40, start, limit - batch.length);
  return [...topics.slice(start - overlap, start), ...batch];
}

function validateGroups(groups, topics) {
  const known = new Set(topics.map(topic => topic.path));
  const out = [];
  for (const group of groups) {
    const canonical = normalizeTopicPath(group?.canonical);
    const members = [...new Set([
      canonical,
      ...(Array.isArray(group?.merge) ? group.merge.map(normalizeTopicPath) : []),
    ].filter(path => known.has(path)))];
    if (!known.has(canonical) || members.length < 2) continue;
    out.push({ canonical, merge: members.filter(path => path !== canonical) });
  }
  return out;
}

function nonOverlappingGroups(groups) {
  const claimed = new Set();
  const out = [];
  for (const group of groups) {
    const members = [group.canonical, ...group.merge];
    if (members.some(path => claimed.has(path))) continue;
    members.forEach(path => claimed.add(path));
    out.push(group);
  }
  return out;
}

async function applyConsolidationGroup(group, opts) {
  const records = await Promise.all([group.canonical, ...group.merge].map(path => readTopicRecord(path, opts)));
  const available = records.filter(record => record.content || record.summary || record.memory);
  if (available.length < 2) return null;

  const canonical = records[0];
  const raw = await opts.llm({
    pass: 'topic-merge',
    system: topicConsolidationSystem(opts.language),
    prompt: boundDreamPrompt(render('mergeTopics', {
      canonical: canonical.path,
      topicContents: available.map(record => [
        `## ${record.path}`,
        record.content || record.memory || record.summary,
      ].join('\n')).join('\n\n'),
    }, { language: opts.language }), opts.maxPromptChars),
  });
  const parsed = parseJsonSafe(raw);
  const mergedContent = String(parsed?.content_md || '').trim();
  const mergedSummary = String(parsed?.summary_md || '').trim();
  if (!mergedContent) return null;

  for (const record of available) await snapshotScope(opts.root, opts.ts, record.scope);
  const mergedSegments = dedupeSegments(
    available.flatMap(record => record.segments),
    canonical.scope,
  );
  const transaction = stageConsolidationTransaction({
    root: opts.root,
    sessionId: opts.sessionId,
    canonical: canonical.path,
    mergedContent,
    mergedSummary,
    mergedSegments,
    duplicates: available.slice(1).map(record => record.path),
    ts: opts.ts,
    fileOps: opts.fileOps,
  });

  try {
    transaction.activate();
    if (opts.segmentIndex) {
      syncScope(opts.root, opts.segmentIndex, canonical.scope);
      for (const record of available.slice(1)) {
        opts.segmentIndex.deleteScope(record.scope);
        syncScope(opts.root, opts.segmentIndex, record.scope);
      }
    }
    transaction.commit();
    removeEmptyDirectory(join(opts.root, '.topic-consolidation'));
  } catch (error) {
    try {
      transaction.rollback();
      removeEmptyDirectory(join(opts.root, '.topic-consolidation'));
    } catch (rollbackError) {
      error.rollbackError = rollbackError;
    }
    if (opts.segmentIndex) {
      for (const record of available) {
        try { syncScope(opts.root, opts.segmentIndex, record.scope); } catch { /* best effort */ }
      }
    }
    throw error;
  }

  return { canonical: canonical.path, merged: available.slice(1).map(record => record.path) };
}

async function readTopicRecord(path, opts) {
  const scopeObject = { kind: 'session-topic', sessionId: opts.sessionId, path: path.split('/') };
  const scope = `sessions/${opts.sessionId}/topic/${path}`;
  return {
    path,
    scope,
    content: await readContent(scopeObject, { root: opts.root }),
    memory: await readMemory(scopeObject, { root: opts.root }),
    summary: await readSummary(scopeObject, { root: opts.root, language: opts.language }),
    segments: readScope(opts.root, scope),
  };
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

function stageConsolidationTransaction({ root, sessionId, canonical, mergedContent, mergedSummary, mergedSegments, duplicates, ts, fileOps }) {
  const topicRoot = join(root, 'sessions', sessionId, 'topic');
  const nonce = `${String(ts || Date.now()).replace(/[^a-zA-Z0-9_-]/g, '-')}-${Math.random().toString(36).slice(2, 10)}`;
  const transactionRoot = join(root, '.topic-consolidation', nonce);
  const stagedRoot = join(transactionRoot, 'staged');
  const backupRoot = join(transactionRoot, 'backup');
  const operations = [];

  stageFile(join(stagedRoot, canonical, 'content.md'), `${mergedContent}\n`);
  stageFile(join(stagedRoot, canonical, 'summary.md'), `${mergedSummary}\n`);
  writeScope(stagedRoot, canonical, mergedSegments);
  operations.push({ scope: canonical, file: 'content.md', desired: join(stagedRoot, canonical, 'content.md') });
  operations.push({ scope: canonical, file: 'summary.md', desired: join(stagedRoot, canonical, 'summary.md') });
  operations.push({ scope: canonical, file: 'memory.md', desired: join(stagedRoot, canonical, 'memory.md') });
  operations.push({ scope: canonical, file: TOPIC_REDIRECT_FILE, desired: null });

  for (const duplicate of duplicates) {
    const redirectPath = join(stagedRoot, duplicate, TOPIC_REDIRECT_FILE);
    stageFile(redirectPath, `${JSON.stringify({ version: 1, canonical }, null, 2)}\n`);
    operations.push({ scope: duplicate, file: 'content.md', desired: null });
    operations.push({ scope: duplicate, file: 'summary.md', desired: null });
    operations.push({ scope: duplicate, file: 'memory.md', desired: null });
    operations.push({ scope: duplicate, file: TOPIC_REDIRECT_FILE, desired: redirectPath });
  }

  const renameFile = typeof fileOps?.renameSync === 'function'
    ? fileOps.renameSync
    : renameSync;
  const applied = [];
  let closed = false;
  return {
    activate() {
      for (const operation of operations) {
        const live = join(topicRoot, operation.scope, operation.file);
        const backup = join(backupRoot, operation.scope, operation.file);
        const state = {
          ...operation,
          live,
          backup,
          hadLive: existsSync(live),
          liveMoved: false,
          desiredActivated: false,
        };
        // Register before the first live mutation. If staged activation fails
        // after live moved to backup, rollback still owns this operation.
        applied.push(state);
        if (state.hadLive) {
          mkdirSync(dirname(backup), { recursive: true });
          renameFile(live, backup);
          state.liveMoved = true;
        }
        if (operation.desired) {
          mkdirSync(dirname(live), { recursive: true });
          renameFile(operation.desired, live);
          state.desiredActivated = true;
        }
      }
    },
    commit() {
      if (closed) return;
      closed = true;
      rmSync(transactionRoot, { recursive: true, force: true });
    },
    rollback() {
      if (closed) return;
      let firstError = null;
      for (const operation of applied.slice().reverse()) {
        try {
          if (operation.desiredActivated) rmSync(operation.live, { force: true });
          if (operation.liveMoved && existsSync(operation.backup)) {
            mkdirSync(dirname(operation.live), { recursive: true });
            renameFile(operation.backup, operation.live);
          }
        } catch (error) {
          if (!firstError) firstError = error;
        }
      }
      if (firstError) throw firstError;
      rmSync(transactionRoot, { recursive: true, force: true });
      closed = true;
    },
  };
}

function removeEmptyDirectory(path) {
  try { rmdirSync(path); } catch { /* absent or not empty */ }
}

function stageFile(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, 'utf8');
}
