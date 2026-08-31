import { inspect } from 'util';

import { isValidTopic } from '../memory/store.js';
/**
 * dream/triage.js.
 *
 * Decide, for one group's diff, which scopes should be touched by Apply.
 * The decision is two-staged on purpose:
 *
 *   1. **Hard rules** (this module, no LLM): everything we can determine
 *      from message metadata. Always include the active session and every VP
 *      that spoke as an assistant in the diff. User-profile scopes are not a
 *      structural property, so they are added only when soft classification
 *      confirms a durable profile signal. (Feature scope was dropped
 *      2026-05-13 along with the rest of the Feature system.)
 *
 *   2. **Soft classification** (LLM, two passes):
 *        Pass-1: high-recall — does the diff carry user-profile signal?
 *                              what topics (category-level) does it touch?
 *        Pass-2: high-precision — for each topic Pass-1 surfaced, bind
 *                              it to an exact existing path or propose
 *                              a new ≤2-level path.
 *
 *      VP / Session are deliberately NOT asked of the LLM — Hard Rules
 *      already cover them, and giving the LLM a chance to drop a
 *      structurally-required scope would weaken the contract.
 *
 *      `user_profile_signals === true` does not need Pass-2: it directly
 *      adds the global `user` scope and, for a real collaborative Session,
 *      the Session-local `sessions/<id>/user` scope. Keeping those scopes
 *      out when the classifier says false avoids two Apply rewrites and two
 *      extraction requests for ordinary task-focused conversation.
 *
 * The LLM is injected as a callable: `llm({ pass, prompt, system })` →
 * Promise<string>. Tests pass a stub; runner injects the real adapter.
 *
 * The triage actions are unioned across segments when one group's diff
 * is split in segment.js — segment-level triage runs N times and the
 * caller dedupes. (Implemented as a thin wrapper `triageGroupSegments`
 * below.)
 */

import { boundDreamPrompt, truncateMessage } from './segment.js';
import { render } from './prompts/index.js';
import { resolveTopicRedirect } from '../memory/topic-redirect.js';

function triageSystem(language) {
  return String(language || '').toLowerCase().startsWith('zh')
    ? '你是梦境流水线的 Triage 阶段，负责判断最近的 session 对话会影响哪些 scope。请只回复严格 JSON，不要输出说明文字或 markdown fence。自然语言内容使用中文；JSON key、scope 和枚举值保持英文。'
    : 'You are the Triage stage of a dream pipeline that decides which scopes a recent session conversation should affect. Reply with strict JSON only — no prose, no markdown fences.';
}

/**
 * Hard rules: deterministically derive must-include scopes from the
 * structure of the diff.
 *
 * Inputs:
 *   - sessionId: the active session ('_no-session' is allowed and skips the
 *     `sessions/<id>` entry — by convention the virtual session has no scope
 *     of its own).
 *   - messages: the diff (already overlap-prefixed if applicable).
 *
 * @param {{ sessionId: string, messages: Array<object> }} args
 * @returns {Array<{ kind: 'update', scope: string }>}
 */
export function applyHardRules({ sessionId, chatId, messages }) {
  const out = new Map();
  const add = (scope) => { if (!out.has(scope)) out.set(scope, { kind: 'update', scope }); };

  // User-profile scopes are content-dependent and are added by soft
  // classification only when the diff contains a durable profile signal.

  // chat path takes precedence: chat sessions have no collaborative session context.
  if (chatId) {
    add(`chat/${chatId}`);
    for (const m of (messages || [])) {
      if (!m || typeof m !== 'object') continue;
      if (m.role === 'assistant') {
        const vp = m.vpId || (m.author && /^vp:(.+)$/.exec(m.author)?.[1]);
        if (vp && /^[A-Za-z0-9_\-.一-鿿]+$/.test(vp)) {
          add(`chat/${chatId}/vp/${vp}`);
        }
      }
    }
    return Array.from(out.values());
  }

  // active collaborative session, except the virtual _no-session bucket.
  if (sessionId && sessionId !== '_no-session') {
    add(`sessions/${sessionId}`);
  }

  for (const m of (messages || [])) {
    if (!m || typeof m !== 'object') continue;
    // Active VP: any assistant message's vpId, isolated inside this session.
    if (m.role === 'assistant') {
      const vp = m.vpId || (m.author && /^vp:(.+)$/.exec(m.author)?.[1]);
      if (vp && /^[A-Za-z0-9_\-.一-鿿]+$/.test(vp) && sessionId && sessionId !== '_no-session') {
        add(`sessions/${sessionId}/vp/${vp}`);
      }
    }
  }

  return Array.from(out.values());
}

// ─── soft classification ──────────────────────────────────────

/**
 * Build the prompt used for Pass-1.
 *
 * @param {{ sessionId: string, messages: Array<object>, topicSummaries: Array<{ path: string, summary: string }>, maxPromptChars?: number }} ctx
 */
export function buildPass1Prompt(ctx) {
  const topicSummaries = (!ctx.topicSummaries || ctx.topicSummaries.length === 0)
    ? (String(ctx.language || '').toLowerCase().startsWith('zh') ? '  （无）' : '  (none)')
    : ctx.topicSummaries.map(t => `  - ${t.path} — ${oneLine(t.summary)}`).join('\n');
  const conv = [];
  for (const m of (ctx.messages || [])) {
    const head = `[${m.role || 'message'}${m.kind === 'overlap' ? (String(ctx.language || '').toLowerCase().startsWith('zh') ? '（已处理）' : ' (already processed)') : ''}]`;
    conv.push(head);
    conv.push(truncateMessage(m.body || ''));
    conv.push('');
  }
  return boundDreamPrompt(render('triagePass1', {
    sessionId: ctx.sessionId,
    topicSummaries,
    conversation: conv.join('\n').trimEnd(),
  }, { language: ctx.language }), ctx.maxPromptChars);
}

/**
 * Build the Pass-2 prompt for a single topic description.
 *
 * @param {{ description: string, existingTopics: Array<{ path: string, summary: string }> }} ctx
 */
export function buildPass2Prompt(ctx) {
  const existingTopics = (!ctx.existingTopics || ctx.existingTopics.length === 0)
    ? (String(ctx.language || '').toLowerCase().startsWith('zh') ? '  （无）' : '  (none)')
    : ctx.existingTopics.map(t => `  - ${t.path} — ${oneLine(t.summary)}`).join('\n');
  return boundDreamPrompt(render('triagePass2', {
    description: ctx.description,
    existingTopics,
  }, { language: ctx.language }), ctx.maxPromptChars);
}

/**
 * Run soft classification for one segment of one group's diff.
 *
 * @param {{
 *   root?: string,
 *   sessionId: string,
 *   messages: Array<object>,
 *   topicSummaries: Array<{ path: string, summary: string }>,
 *   llm: (req: { pass: string, prompt: string, system: string }) => Promise<string>,
 *   maxPromptChars?: number,
 * }} args
 * @returns {Promise<Array<{ kind: 'update'|'create', scope: string }>>}
 */
export async function classifySoft({ root, sessionId, messages, topicSummaries, llm, language, maxPromptChars }) {
  if (!llm) throw new Error('triage.classifySoft: llm callable required');
  const pass1Prompt = buildPass1Prompt({ sessionId, messages, topicSummaries, language, maxPromptChars });
  const pass1Raw = await llm({ pass: 'triage-pass1', prompt: pass1Prompt, system: triageSystem(language) });
  const pass1 = parseJsonSafe(pass1Raw);
  if (!isValidPass1(pass1)) {
    throw triageContractError('Pass-1', pass1Raw);
  }
  const out = [];

  // User-profile scopes are expensive shared-memory rewrites, not structural
  // Session scopes. Route to them only when Pass-1 finds a durable signal.
  if (pass1.user_profile_signals) {
    out.push({ kind: 'update', scope: 'user' });
    if (sessionId && sessionId !== '_no-session') {
      out.push({ kind: 'update', scope: `sessions/${sessionId}/user` });
    }
  }

  for (const description of pass1.topics) {
    const pass2Prompt = buildPass2Prompt({
      description: description.trim(),
      existingTopics: topicSummaries || [],
      language,
      maxPromptChars,
    });
    const pass2Raw = await llm({ pass: 'triage-pass2', prompt: pass2Prompt, system: triageSystem(language) });
    const pass2 = parseJsonSafe(pass2Raw);
    if (!isValidPass2(pass2, { sessionId, topicSummaries })) {
      throw triageContractError('Pass-2', pass2Raw);
    }
    if (pass2.decision === 'none') continue;
    const path = pass2.path;
    const redirected = root
      ? resolveTopicRedirect(root, sessionId, path)
      : path;
    const scope = `sessions/${sessionId}/topic/${redirected}`;
    if (pass2.decision === 'match') {
      out.push({ kind: 'update', scope });
    } else {
      out.push({ kind: 'create', scope });
    }
  }
  return out;
}

/**
 * Combine hard-rule and soft-classification results for one segment.
 * Dedupes by scope — `update` wins if any source said update.
 *
 * @param {{
 *   sessionId: string,
 *   messages: Array<object>,
 *   topicSummaries: Array<{ path: string, summary: string }>,
 *   llm: (req: { pass: string, prompt: string, system: string }) => Promise<string>,
 * }} args
 * @returns {Promise<Array<{ kind: 'update'|'create', scope: string }>>}
 */
export async function triageOneSegment(args) {
  const hard = applyHardRules({ sessionId: args.sessionId, messages: args.messages });
  const soft = await classifySoft(args);
  return dedupeActions([...hard, ...soft]);
}

/**
 * Triage a group's diff that has already been split into N segments.
 * Runs each segment serially, accumulates and dedupes actions.
 *
 * @param {{
 *   sessionId: string,
 *   segments: Array<{ messages: Array<object> }>,
 *   topicSummaries: Array<{ path: string, summary: string }>,
 *   llm: (req: { pass: string, prompt: string, system: string }) => Promise<string>,
 *   maxPromptChars?: number,
 *   onProgress?: (event: object) => void,
 * }} args
 * @returns {Promise<Array<{ kind: 'update'|'create', scope: string }>>}
 */
export async function triageGroupSegments({ root, sessionId, segments, topicSummaries, llm, onProgress, language, maxPromptChars }) {
  let acc = [];
  let i = 0;
  for (const seg of (segments || [])) {
    i += 1;
    if (onProgress) onProgress({ phase: 'triage', sessionId, segment: i, total: segments.length });
    const segActions = await triageOneSegment({
      root,
      sessionId,
      messages: seg.messages,
      topicSummaries,
      llm,
      language,
      maxPromptChars,
    });
    acc = dedupeActions([...acc, ...segActions]);
  }
  return acc;
}

// ─── helpers ──────────────────────────────────────────────────

function dedupeActions(list) {
  const map = new Map();
  for (const a of list) {
    if (!a || !a.scope) continue;
    const cur = map.get(a.scope);
    if (!cur) { map.set(a.scope, { ...a }); continue; }
    if (a.kind === 'update') cur.kind = 'update';
  }
  return Array.from(map.values());
}

function oneLine(s) {
  return String(s || '').replace(/\s+/g, ' ').trim().slice(0, 200);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value, expected) {
  const keys = Object.keys(value).sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}

function isValidPass1(value) {
  if (!isPlainObject(value)
    || !hasExactKeys(value, ['topics', 'trivial_only', 'user_profile_signals'])
    || typeof value.user_profile_signals !== 'boolean'
    || typeof value.trivial_only !== 'boolean'
    || !Array.isArray(value.topics)
    || !value.topics.every(topic => typeof topic === 'string' && topic.trim().length > 0)) {
    return false;
  }
  return !value.trivial_only || (!value.user_profile_signals && value.topics.length === 0);
}

function isValidPass2(value, { sessionId, topicSummaries }) {
  if (!isPlainObject(value) || !['match', 'new', 'none'].includes(value.decision)) return false;
  if (value.decision === 'none') {
    return hasExactKeys(value, ['decision']);
  }
  if (!hasExactKeys(value, ['decision', 'path'])
    || !sessionId
    || sessionId === '_no-session'
    || typeof value.path !== 'string'
    || value.path !== value.path.trim()) {
    return false;
  }
  const path = value.path;
  const segments = path.split('/');
  if (!isValidTopic({ kind: 'session-topic', sessionId, path: segments })) return false;
  const pathExists = (topicSummaries || []).some(topic => topic?.path === path);
  return value.decision === 'match' ? pathExists : !pathExists;
}

function triageContractError(pass, raw) {
  const err = new Error(`triage: ${pass} returned malformed JSON`);
  err.rawSnippet = rawResponseSnippet(raw);
  return err;
}

function rawResponseSnippet(raw) {
  if (typeof raw === 'string') return raw.slice(0, 1000);
  if (raw == null) return String(raw);
  return inspect(raw, { depth: 2, maxArrayLength: 10, breakLength: 120 }).slice(0, 1000);
}

/** Lenient JSON parse: tolerate fenced ```json blocks. Returns null on failure. */
export function parseJsonSafe(raw) {
  if (typeof raw !== 'string') return null;
  let s = raw.trim();
  // Strip markdown fences if present.
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(s);
  if (fenced) s = fenced[1].trim();
  try { return JSON.parse(s); }
  catch { /* try to recover the first JSON block */ }

  const objectStart = s.indexOf('{');
  const objectEnd = s.lastIndexOf('}');
  const arrayStart = s.indexOf('[');
  const arrayEnd = s.lastIndexOf(']');
  const candidates = [
    { start: objectStart, end: objectEnd },
    { start: arrayStart, end: arrayEnd },
  ].filter(c => c.start >= 0 && c.end > c.start)
    .sort((a, b) => a.start - b.start);

  for (const c of candidates) {
    try { return JSON.parse(s.slice(c.start, c.end + 1)); }
    catch { /* try next candidate */ }
  }
  return null;
}
