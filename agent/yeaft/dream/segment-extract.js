/**
 * dream/segment-extract.js.
 *
 * Extract atomic evidence segments for scopes touched by a Dream pass and
 * persist them through memory/segment-store. Dream Apply separately maintains
 * canonical content.md and the short catalog summary.md.
 */

import { readScope, writeScope } from '../memory/segment-store.js';
import { syncScope } from '../memory/segment-sync.js';
import { makeSegment } from '../memory/segment.js';
import { render, extractTemplateForScope } from './prompts/index.js';
import { boundDreamPrompt } from './segment.js';
import { parseJsonSafe } from './triage.js';

const MAX_MESSAGES = 80;
const MAX_BODY_CHARS = 1200;
const MAX_SEGMENTS_PER_SCOPE = 64;
const RECENT_MESSAGE_COUNT = 8;
const VALID_KINDS = new Set([
  'fact',
  'preference',
  'decision',
  'lesson',
  'relation',
  'goal',
  'context',
  'workflow',
  'pitfall',
  'correction',
  'project-convention',
]);

/**
 * @param {{
 *   root: string,
 *   sessionId: string,
 *   messages: Array<object>,
 *   targets?: string[],
 *   llm: Function,
 *   language?: string,
 *   nowIso?: Function,
 *   segmentIndex?: import('../memory/index-db.js').SegmentIndex|null,
 *   limits?: { MAX_DREAM_PROMPT_CHARS?: number },
 * }} opts
 */
export async function extractAndWriteMemorySegments(opts) {
  if (!opts || !opts.root) throw new Error('extractAndWriteMemorySegments: root required');
  if (!opts.sessionId) throw new Error('extractAndWriteMemorySegments: sessionId required');
  if (typeof opts.llm !== 'function') throw new Error('extractAndWriteMemorySegments: llm required');

  const messages = normalizeMessages(opts.messages || []);
  if (messages.length === 0) return { scopes: 0, segments: 0, errors: [] };
  const allowedSourceIds = new Set(messages.map(message => message.id));

  const targetScopes = normalizeTargetScopes(opts.sessionId, opts.targets || []);
  const now = opts.nowIso ? opts.nowIso() : new Date().toISOString();
  let segmentCount = 0;
  let scopeCount = 0;
  const errors = [];

  for (const scope of targetScopes) {
    let extracted = [];
    try {
      extracted = await extractScopeSegments({
        scope,
        sessionId: opts.sessionId,
        messages,
        llm: opts.llm,
        language: opts.language,
        now,
        allowedSourceIds,
        maxPromptChars: opts.limits?.MAX_DREAM_PROMPT_CHARS,
      });
    } catch (err) {
      errors.push({ scope, error: err.message, rawSnippet: err.rawSnippet || '' });
    }

    // Session memory must contain extracted facts and reusable experience, not a
    // serialized transcript tail. Raw message ids, roles, and tool payloads are
    // execution history; copying them into canonical Dream content makes that
    // history re-enter later provider requests as system-prompt prose.
    const recent = scope === `sessions/${opts.sessionId}`
      ? [buildRecentExperienceSegment({ scope, extracted, now })].filter(Boolean)
      : [];
    if (extracted.length === 0 && recent.length === 0) continue;

    const nextSegments = mergeSegments(readScope(opts.root, scope), [...extracted, ...recent]);
    writeScope(opts.root, scope, nextSegments);
    if (opts.segmentIndex) syncScope(opts.root, opts.segmentIndex, scope);
    segmentCount += extracted.length + recent.length;
    scopeCount += 1;
  }

  return { scopes: scopeCount, segments: segmentCount, errors };
}

async function extractScopeSegments({ scope, sessionId, messages, llm, language, now, allowedSourceIds, maxPromptChars }) {
  const template = extractTemplateForScope(scope);
  const base = render(template, templateVarsForScope(scope, sessionId), { language });
  const prompt = boundDreamPrompt(
    `${base}\n\nTarget scope: ${scope}\n\nConversation diff, oldest first:\n${renderMessages(messages)}\n\nReturn only the JSON array. Do not wrap it in Markdown.`,
    maxPromptChars,
  );
  const firstRaw = await llm({ pass: 'extract-segments', prompt, system: extractSystem(language) });
  const firstParsed = parseJsonSafe(firstRaw);
  if (Array.isArray(firstParsed)) {
    return firstParsed
      .map(item => normalizeExtractedSegment({ item, scope, now, allowedSourceIds }))
      .filter(Boolean);
  }

  const retryPrompt = boundDreamPrompt(`${prompt}\n\nYour previous output was malformed JSON. Previous output snippet:\n${rawSnippet(firstRaw)}\n\nRetry now. Return only a strict JSON array.`, maxPromptChars);
  const retryRaw = await llm({ pass: 'extract-segments-retry', prompt: retryPrompt, system: extractSystem(language) });
  const retryParsed = parseJsonSafe(retryRaw);
  if (!Array.isArray(retryParsed)) {
    const err = new Error(`extract-segments: malformed JSON for ${scope}`);
    err.rawSnippet = rawSnippet(retryRaw || firstRaw);
    throw err;
  }

  return retryParsed
    .map(item => normalizeExtractedSegment({ item, scope, now, allowedSourceIds }))
    .filter(Boolean);
}

function templateVarsForScope(scope, sessionId) {
  const vars = { sessionId, vpId: '', topicId: '' };
  const vpMatch = /^sessions\/[^/]+\/vp\/(.+)$/.exec(scope);
  if (vpMatch) vars.vpId = vpMatch[1];
  const topicMatch = /^sessions\/[^/]+\/topic\/(.+)$/.exec(scope);
  if (topicMatch) vars.topicId = topicMatch[1];
  return vars;
}

function normalizeTargetScopes(sessionId, targets) {
  const out = new Set(['user', `sessions/${sessionId}`, `sessions/${sessionId}/user`]);
  for (const target of targets) {
    if (typeof target !== 'string') continue;
    const clean = target.trim();
    if (!clean) continue;
    if (clean === 'user' || clean.startsWith(`sessions/${sessionId}/`) || clean === `sessions/${sessionId}`) {
      out.add(clean);
    }
  }
  return [...out];
}

function normalizeMessages(messages) {
  return messages
    .filter(m => m && typeof m === 'object')
    .slice(-MAX_MESSAGES)
    .map(m => ({
      id: String(m.id || m.messageId || '').trim(),
      role: String(m.role || m.type || 'unknown'),
      vpId: typeof m.vpId === 'string' ? m.vpId : '',
      body: String(m.body || m.content || '').slice(0, MAX_BODY_CHARS),
      kind: String(m.kind || ''),
    }))
    .filter(m => m.id && m.body.trim());
}

function renderMessages(messages) {
  return JSON.stringify(messages.map(m => ({
    id: m.id,
    role: m.role,
    vpId: m.vpId || undefined,
    kind: m.kind || undefined,
    body: m.body,
  })), null, 2);
}

function normalizeExtractedSegment({ item, scope, now, allowedSourceIds }) {
  if (!item || typeof item !== 'object') return null;
  const body = String(item.body || item.content || item.summary || '').trim();
  if (!body) return null;
  const kind = VALID_KINDS.has(String(item.kind || '')) ? String(item.kind) : 'context';
  const tags = Array.isArray(item.tags) ? item.tags.map(t => String(t).trim()).filter(Boolean) : [];
  const sourceMessages = [...new Set(normalizeSourceMessageIds(item.sourceMessages))];
  if (sourceMessages.length === 0) return null;
  if (sourceMessages.some(id => !allowedSourceIds.has(id))) return null;
  return makeSegment({
    scope,
    kind,
    tags: [...new Set(tags)],
    sourceMessages: [...new Set(sourceMessages)],
    createdAt: typeof item.createdAt === 'string' ? item.createdAt : now,
    updatedAt: now,
    body,
  });
}

function normalizeSourceMessageIds(value) {
  if (!Array.isArray(value)) return [];
  const ids = [];
  for (const item of value) {
    if (typeof item === 'string' || typeof item === 'number') {
      const id = String(item).trim();
      if (id) ids.push(id);
      continue;
    }
    if (item && typeof item === 'object') {
      const id = String(item.id || item.messageId || item.uuid || '').trim();
      if (id) ids.push(id);
    }
  }
  return ids;
}

function buildRecentExperienceSegment({ scope, extracted, now }) {
  const experienceSegments = extracted
    .filter(isExperienceSegment)
    .slice(-RECENT_MESSAGE_COUNT);
  if (experienceSegments.length === 0) return null;

  const lines = experienceSegments
    .map(seg => oneLine(seg.body))
    .filter(Boolean);
  if (lines.length === 0) return null;

  const sourceMessages = [...new Set(experienceSegments.flatMap(seg => (
    Array.isArray(seg.sourceMessages) ? seg.sourceMessages.map(String).filter(Boolean) : []
  )))];
  const body = [
    'Reusable session experience from the latest Dream pass:',
    ...lines.map(line => `- ${line}`),
  ].join('\n');

  return makeSegment({
    scope,
    kind: 'lesson',
    tags: ['recent', 'experience', 'workflow'],
    sourceMessages,
    createdAt: now,
    updatedAt: now,
    body,
  });
}

function isExperienceSegment(seg) {
  if (!seg) return false;
  if (['workflow', 'preference', 'pitfall', 'correction', 'project-convention', 'lesson'].includes(seg.kind)) {
    return true;
  }
  const tags = Array.isArray(seg.tags) ? seg.tags.map(tag => String(tag).toLowerCase()) : [];
  return tags.some(tag => ['workflow', 'preference', 'pitfall', 'correction', 'project-convention', 'lesson', 'experience'].includes(tag));
}

function mergeSegments(existing, incoming) {
  const incomingRecent = latestRecentByFamily(incoming.filter(isRecentSegment));
  const incomingPermanent = incoming.filter(seg => !isRecentSegment(seg));
  const byKey = new Map();

  for (const seg of existing) {
    if (isRecentSegment(seg)) continue;
    byKey.set(segmentMergeKey(seg), seg);
  }
  for (const seg of incomingPermanent) {
    byKey.set(segmentMergeKey(seg), seg);
  }

  const permanent = [...byKey.values()]
    .sort((a, b) => segmentTime(b).localeCompare(segmentTime(a)))
    .slice(0, MAX_SEGMENTS_PER_SCOPE)
    .sort((a, b) => segmentTime(a).localeCompare(segmentTime(b)) || String(a.id).localeCompare(String(b.id)));

  return [...permanent, ...incomingRecent];
}

function segmentMergeKey(seg) {
  const sources = Array.isArray(seg.sourceMessages)
    ? seg.sourceMessages.map(String).filter(Boolean).sort().join(',')
    : '';
  const tagFamily = Array.isArray(seg.tags)
    ? seg.tags.map(String).filter(t => t && t !== 'recent' && t !== 'current').sort().join(',')
    : '';
  if (sources) return `src:${seg.kind || 'context'}:${tagFamily}:${sources}`;
  return `id:${seg.id}`;
}

function latestRecentByFamily(segments) {
  const byFamily = new Map();
  for (const seg of segments) {
    byFamily.set(recentFamily(seg), seg);
  }
  return [...byFamily.values()];
}

function recentFamily(seg) {
  const tags = Array.isArray(seg.tags) ? seg.tags.map(String) : [];
  if (tags.includes('experience')) return 'experience';
  if (tags.includes('current')) return 'current';
  return 'recent';
}

function isRecentSegment(seg) {
  return Array.isArray(seg.tags) && seg.tags.includes('recent');
}

function segmentTime(seg) {
  return String(seg.updatedAt || seg.createdAt || '');
}

function rawSnippet(raw) {
  return String(raw || '').replace(/\s+/g, ' ').trim().slice(0, 500);
}

function oneLine(text) {
  return String(text || '').replace(/\s+/g, ' ').trim().slice(0, 280);
}

function extractSystem(language) {
  return String(language || '').toLowerCase().startsWith('zh')
    ? '你是梦境记忆抽取器。只输出严格 JSON 数组，不要 Markdown。保留具体事实、决策、偏好、当前状态和证据 message id。'
    : 'You are the dream memory extractor. Return only a strict JSON array, no Markdown. Preserve concrete facts, decisions, preferences, current status, and evidence message ids.';
}
