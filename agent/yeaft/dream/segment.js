/**
 * dream/segment.js.
 *
 * Four independent length-control concerns, kept pure so they can be
 * unit-tested without touching disk or any LLM:
 *
 *   1. truncateMessage — clamp a single message body to
 *      MAX_SINGLE_MESSAGE_CHARS, appending a clear notice. The full
 *      body is still preserved in the conversation log; this only
 *      affects what dream sees. (§17.3)
 *
 *   2. estimateTokens — rough chars-to-tokens approximation (we use 4
 *      chars/token, a stable industry approximation that doesn't drag
 *      a tokenizer into this layer; precise counts aren't required for
 *      "should we segment?" decisions and a small over-count is the
 *      safe direction).
 *
 *   3. segmentDiff — split a long per-group diff into K consecutive
 *      slices, each ≤ MAX_DIFF_TOKENS_PER_TRIAGE, with a 3-message
 *      overlap between adjacent slices for context continuity. (§17.1)
 *
 *   4. needsBatchedApply / batchSourcesForApply — when an Apply target's
 *      memory + summary + sources cumulatively exceed MAX_APPLY_TOKENS,
 *      split source messages into bounded batches; the LLM is then called
 *      once per batch, threading the written-back memory.md as input to the
 *      next batch. A single Session source may therefore produce multiple
 *      ordered batches.
 *
 * Dream only needs durable user/assistant prose. Tool results are execution
 * history and can be enormous; `compressDreamMessages()` drops them before
 * triage/apply while preserving the original conversation on disk.
 *
 * No side-effects. All functions are deterministic given their inputs.
 */

import {
  MAX_SINGLE_MESSAGE_CHARS,
  MAX_DREAM_PROMPT_CHARS,
  MAX_DIFF_TOKENS_PER_TRIAGE,
  MAX_APPLY_TOKENS,
  DREAM_OVERLAP,
} from './limits.js';

const TRUNCATION_NOTICE = '\n\n[message truncated for dream, original preserved in conversation log]';

/**
 * Truncate a single message body if it exceeds the per-message char cap.
 * Idempotent: passing in an already-truncated body returns it unchanged.
 *
 * @param {string} body
 * @returns {string}
 */
export function truncateMessage(body) {
  const s = String(body || '');
  if (s.length <= MAX_SINGLE_MESSAGE_CHARS) return s;
  if (s.endsWith(TRUNCATION_NOTICE)) return s;
  // Reserve room for the notice without overflowing the cap.
  const room = Math.max(0, MAX_SINGLE_MESSAGE_CHARS - TRUNCATION_NOTICE.length);
  return s.slice(0, room) + TRUNCATION_NOTICE;
}

/**
 * Conservative chars-to-tokens approximation. We over-count slightly
 * (1 token ≈ 4 chars) to make MAX_*_TOKENS act as a true upper bound.
 *
 * @param {string} text
 * @returns {number}
 */
export function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil(String(text).length / 4);
}

/**
 * Estimate the token cost of an array of messages (header + body for each).
 * @param {Array<{id?: string, role?: string, body?: string}>} msgs
 */
export function estimateMessagesTokens(msgs) {
  if (!Array.isArray(msgs)) return 0;
  let n = 0;
  for (const m of msgs) {
    n += estimateTokens(m.role || '');
    n += estimateTokens(m.body || '');
    n += 2; // separator overhead
  }
  return n;
}

/**
 * Remove execution-only messages from the Dream input. The transcript remains
 * the source of truth; this is only a prompt projection. Overlap messages are
 * retained for triage context but never become new durable evidence.
 *
 * @param {Array<object>} messages
 * @returns {Array<object>}
 */
export function compressDreamMessages(messages) {
  if (!Array.isArray(messages)) return [];
  return messages
    .filter(message => message && typeof message === 'object')
    .filter(message => ['user', 'assistant'].includes(String(message.role || '').toLowerCase()))
    .map(message => ({
      ...message,
      body: truncateMessage(message.body || message.content || ''),
    }))
    .filter(message => String(message.body || '').trim());
}

/**
 * Keep only newly observed messages when applying/extracting. Triage may use
 * overlap context, but re-feeding it to Apply causes old Dreamed content to be
 * processed again on every pass.
 *
 * @param {Array<object>} messages
 * @returns {Array<object>}
 */
export function selectDreamNewMessages(messages) {
  return (Array.isArray(messages) ? messages : [])
    .filter(message => message && message.kind !== 'overlap');
}

/**
 * Hard cap the final Dream prompt at the provider boundary. Keep both the
 * prompt contract (head) and the JSON/output instruction (tail); discard only
 * the middle source transcript. The durable transcript and canonical memory
 * remain on disk.
 *
 * @param {string} prompt
 * @param {number} [maxChars=MAX_DREAM_PROMPT_CHARS]
 * @returns {string}
 */
export function boundDreamPrompt(prompt, maxChars = MAX_DREAM_PROMPT_CHARS) {
  const text = String(prompt || '');
  const cap = Number.isFinite(maxChars) && maxChars > 0
    ? Math.floor(maxChars)
    : MAX_DREAM_PROMPT_CHARS;
  if (text.length <= cap) return text;
  const marker = '\n\n[Dream prompt compressed: middle transcript omitted; durable source remains on disk]\n\n';
  if (cap <= marker.length) {
    const head = Math.ceil(cap / 2);
    const tail = cap - head;
    return text.slice(0, head) + (tail > 0 ? text.slice(-tail) : '');
  }
  const room = cap - marker.length;
  const head = Math.ceil(room * 0.62);
  const tail = room - head;
  return text.slice(0, head) + marker + (tail > 0 ? text.slice(-tail) : '');
}

/**
 * Split a contiguous group diff into ≤MAX-token segments, with a
 * DREAM_OVERLAP-message tail/head overlap between consecutive segments.
 *
 * Returns segments in temporal order. Each segment is `{ messages, kind }`
 * where `kind` is 'overlap' for messages that exist only as continuity
 * preamble (because they appeared in a prior segment), and 'new' for
 * the rest. The first segment has no overlap header.
 *
 * Properties:
 *   - The union of `kind: 'new'` messages across all segments equals
 *     the input diff exactly, in order, with no duplicates.
 *   - Each segment's total token estimate ≤ MAX_DIFF_TOKENS_PER_TRIAGE
 *     unless a single message alone exceeds the cap, in which case
 *     that message gets its own segment (we never split a message).
 *
 * @param {Array<{id?: string, role?: string, body?: string}>} diff
 * @param {number} [maxTokens=MAX_DIFF_TOKENS_PER_TRIAGE]
 * @param {number} [overlap=DREAM_OVERLAP]
 * @param {number} [maxPromptChars=MAX_DREAM_PROMPT_CHARS]
 * @returns {Array<{ messages: Array<object>, overlapCount: number, newCount: number }>}
 */
export function segmentDiff(diff, maxTokens = MAX_DIFF_TOKENS_PER_TRIAGE, overlap = DREAM_OVERLAP, maxPromptChars = MAX_DREAM_PROMPT_CHARS) {
  const msgs = Array.isArray(diff) ? diff : [];
  const boundedPromptChars = Number.isFinite(maxPromptChars) && maxPromptChars > 0
    ? maxPromptChars
    : MAX_DREAM_PROMPT_CHARS;
  const boundedMaxTokens = Math.min(maxTokens, Math.max(1, Math.floor(boundedPromptChars / 4) - 2048));
  if (msgs.length === 0) return [];

  // Fast path: whole diff fits in one segment.
  if (estimateMessagesTokens(msgs) <= boundedMaxTokens) {
    return [{ messages: msgs, overlapCount: 0, newCount: msgs.length }];
  }

  const segments = [];
  let cursor = 0;
  while (cursor < msgs.length) {
    const overlapHead = segments.length > 0
      ? msgs.slice(Math.max(0, cursor - overlap), cursor)
      : [];
    let used = estimateMessagesTokens(overlapHead);
    let end = cursor;
    while (end < msgs.length) {
      const cost = estimateTokens(msgs[end].body || '') + estimateTokens(msgs[end].role || '') + 2;
      if (used + cost > boundedMaxTokens && end > cursor) break;
      used += cost;
      end += 1;
    }
    // If we made no progress (single oversized message), advance by 1.
    if (end === cursor) end = cursor + 1;
    segments.push({
      messages: [...overlapHead, ...msgs.slice(cursor, end)],
      overlapCount: overlapHead.length,
      newCount: end - cursor,
    });
    cursor = end;
  }
  return segments;
}

// ─── apply batching ───────────────────────────────────────────

/**
 * Decide whether a merged apply target needs to be split into batches.
 *
 * @param {{ memoryMd?: string, summaryMd?: string, sources: Array<{ sessionId: string, diff: any }> }} merged
 * @param {number} [maxTokens=MAX_APPLY_TOKENS]
 */
export function needsBatchedApply(merged, maxTokens = MAX_APPLY_TOKENS) {
  return totalApplyTokens(merged) > maxTokens;
}

function totalApplyTokens(merged) {
  let n = estimateTokens(merged.memoryMd || '') + estimateTokens(merged.summaryMd || '');
  for (const src of merged.sources || []) n += estimateMessagesTokens(src.diff || []);
  return n;
}

/**
 * Pack `merged.sources` into ordered batches such that each batch's
 * (memoryMd + summaryMd + that batch's sources) ≤ maxTokens. The first
 * batch uses the original memoryMd; subsequent batches assume the LLM's
 * previous-batch output replaces memoryMd, so we account for the same
 * baseline cost in each batch.
 *
 * Sources are split into ordered message chunks when one Session's diff is
 * larger than the apply budget. This is required because a single Session
 * can contribute thousands of messages after a long gap between Dream runs.
 *
 * @param {{ memoryMd?: string, summaryMd?: string, sources: Array<{ sessionId: string, diff: any }> }} merged
 * @param {number} [maxTokens=MAX_APPLY_TOKENS]
 * @returns {Array<{ sessionId: string, diff: any }[]>}
 */
export function batchSourcesForApply(merged, maxTokens = MAX_APPLY_TOKENS) {
  const sources = Array.isArray(merged.sources) ? merged.sources : [];
  if (sources.length === 0) return [];
  const baseline = estimateTokens(merged.memoryMd || '') + estimateTokens(merged.summaryMd || '');
  const sourceChunks = sources.flatMap(source => splitApplySource(source, Math.max(1, maxTokens - baseline)));
  const batches = [];
  let cur = [];
  let used = baseline;
  for (const src of sourceChunks) {
    const cost = estimateMessagesTokens(src.diff || []);
    if (cur.length > 0 && used + cost > maxTokens) {
      batches.push(cur);
      cur = [];
      used = baseline;
    }
    cur.push(src);
    used += cost;
  }
  if (cur.length > 0) batches.push(cur);
  return batches;
}

function splitApplySource(source, budget) {
  const messages = Array.isArray(source?.diff) ? source.diff : [];
  if (messages.length === 0) return [{ ...source, diff: [] }];
  const chunks = [];
  let current = [];
  let used = 0;
  for (const message of messages) {
    const cost = estimateMessagesTokens([message]);
    if (current.length > 0 && used + cost > budget) {
      chunks.push({ ...source, diff: current });
      current = [];
      used = 0;
    }
    current.push(message);
    used += cost;
  }
  if (current.length > 0) chunks.push({ ...source, diff: current });
  return chunks;
}
