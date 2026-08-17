/**
 * history-window.js — deterministic history shaping for provider requests.
 *
 * This module never calls an LLM, writes a summary, archives transcript rows,
 * or changes the persisted conversation. It builds bounded copies; callers may
 * replace a disposable runtime cache with one of those copies. The persisted
 * message history remains authoritative; Memory/Dream is the long-lived
 * semantic context.
 */

import { estimateTokens } from './conversation/persist.js';
import { pairSanitize } from './pair-sanitize.js';
import { truncateToolResultIfNeeded } from './tools/registry.js';
import { countTurns, indexOfNthTurnFromEnd, sliceLastNTurns } from './turn-utils.js';

export const DEFAULT_KEEP_TOOL_TURNS = 3;
export const DEFAULT_RECENT_TURN_CAP = 25;
export const DEFAULT_MESSAGE_TOKEN_BUDGET = 32768;

// Runtime history is a cache, not a second transcript. Keep its hard cap
// independent from a user-configured provider budget so a large config cannot
// turn the bridge cache back into an unbounded transcript.
export const DEFAULT_RUNTIME_CACHE_TURN_CAP = 25;
export const DEFAULT_RUNTIME_CACHE_TOKEN_BUDGET = 32768;
export const DEFAULT_RUNTIME_CACHE_MESSAGE_CAP = 256;

const IMAGE_PART_TOKEN_COST = 1024;
const DOCUMENT_PART_TOKEN_COST = 2048;
const CONTENT_PART_FRAME_TOKENS = 2;
const TEXT_CHARS_PER_TOKEN = 4;
const BINARY_CHARS_PER_TOKEN = 16;
const OVERSIZED_ATTACHMENT_MARKER = '[attachment omitted from provider context budget]';

function safeJsonTokenEstimate(value) {
  try {
    return estimateTokens(JSON.stringify(value ?? ''));
  } catch {
    return 0;
  }
}

function binaryPayloadTokenEstimate(value) {
  if (typeof value !== 'string' || value.length === 0) return 0;
  // Base64/image bytes are not text tokens, so do not charge them at the text
  // ratio. Still count a conservative wire/configuration cost; otherwise a
  // huge content part would bypass the request budget entirely.
  return Math.ceil(value.length / BINARY_CHARS_PER_TOKEN);
}

function partMetadataTokenEstimate(part, fields = []) {
  return fields.reduce((total, field) => {
    const value = part?.[field];
    return total + (typeof value === 'string' ? estimateTokens(value) : 0);
  }, 0);
}

/**
 * Estimate one provider content part. This is a guardrail, not a tokenizer;
 * the provider remains authoritative about the actual context limit.
 *
 * @param {unknown} part
 * @returns {number}
 */
export function estimateContentPartTokens(part) {
  if (typeof part === 'string') return estimateTokens(part);
  if (!part || typeof part !== 'object') return estimateTokens(String(part ?? ''));

  const type = String(part.type || '');
  if (type === 'text' || type === 'input_text' || type === 'output_text') {
    return estimateTokens(typeof part.text === 'string' ? part.text : '');
  }
  if (type === 'thinking') return estimateTokens(part.thinking || '');
  if (type === 'redacted_thinking') {
    return estimateTokens(part.data || '') + 4;
  }
  if (type === 'image' || type === 'input_image') {
    const source = part.source && typeof part.source === 'object' ? part.source : part;
    return IMAGE_PART_TOKEN_COST
      + partMetadataTokenEstimate(part, ['title', 'alt', 'image_url'])
      + partMetadataTokenEstimate(source, ['url', 'media_type', 'mediaType'])
      + binaryPayloadTokenEstimate(source.data);
  }
  if (type === 'document' || type === 'input_file') {
    const source = part.source && typeof part.source === 'object' ? part.source : part;
    return DOCUMENT_PART_TOKEN_COST
      + partMetadataTokenEstimate(part, ['title', 'filename', 'file_data'])
      + partMetadataTokenEstimate(source, ['media_type', 'mediaType', 'url'])
      + binaryPayloadTokenEstimate(source.data);
  }
  if (type === 'tool_result') {
    return 4 + estimateContentTokens(part.content);
  }
  if (type === 'function_call_output') {
    return 4 + estimateTokens(typeof part.output === 'string' ? part.output : '');
  }
  return safeJsonTokenEstimate(part);
}

/**
 * Estimate string or array provider content, including multimodal parts.
 *
 * @param {unknown} content
 * @returns {number}
 */
export function estimateContentTokens(content) {
  if (typeof content === 'string') return estimateTokens(content);
  if (Array.isArray(content)) {
    return CONTENT_PART_FRAME_TOKENS
      + content.reduce((total, part) => total + estimateContentPartTokens(part), 0);
  }
  if (content == null) return 0;
  return safeJsonTokenEstimate(content);
}

/**
 * Estimate the provider-token weight of one message.
 *
 * @param {object} message
 * @returns {number}
 */
export function estimateMessageTokens(message) {
  if (!message || typeof message !== 'object') return 0;
  let total = 2 + estimateContentTokens(message.content);
  if (Array.isArray(message.toolCalls)) {
    for (const toolCall of message.toolCalls) {
      total += 4;
      try {
        const input = typeof toolCall.input === 'string'
          ? toolCall.input
          : JSON.stringify(toolCall.input || {});
        total += estimateTokens(input);
      } catch {
        // Ignore malformed tool input in the approximate guardrail.
      }
      if (toolCall.name) total += estimateTokens(toolCall.name);
    }
  }
  if (message.toolCallId) total += 2;
  return total;
}

/**
 * @param {Array<object>} messages
 * @returns {number}
 */
export function estimateMessagesTokens(messages) {
  if (!Array.isArray(messages)) return 0;
  return messages.reduce((total, message) => total + estimateMessageTokens(message), 0);
}

function hasContentAfterToolStrip(content) {
  if (typeof content === 'string') return content.trim().length > 0;
  if (Array.isArray(content)) {
    return content.some(part => {
      if (typeof part === 'string') return part.trim().length > 0;
      if (!part || typeof part !== 'object') return part != null;
      return typeof part.text === 'string' ? part.text.trim().length > 0 : true;
    });
  }
  return content != null;
}

function stripToolContentParts(content) {
  if (!Array.isArray(content)) return content;
  return content.filter(part => {
    if (!part || typeof part !== 'object') return true;
    return part.type !== 'tool_use'
      && part.type !== 'tool_result'
      && part.type !== 'function_call'
      && part.type !== 'function_call_output';
  });
}

/**
 * Remove old tool payloads from the provider copy while keeping ordinary user
 * and assistant text. The newest tool turns remain lossless so the active tool
 * protocol stays paired; pairSanitize runs after this transform.
 *
 * @param {Array<object>} messages
 * @param {{ keepToolTurns?: number }} [options]
 * @returns {Array<object>}
 */
export function stripToolNoiseFromOlderTurns(messages, options = {}) {
  if (!Array.isArray(messages) || messages.length === 0) return [];
  const keepToolTurns = Number.isFinite(options.keepToolTurns) && options.keepToolTurns >= 0
    ? options.keepToolTurns
    : DEFAULT_KEEP_TOOL_TURNS;
  const cutIndex = indexOfNthTurnFromEnd(messages, keepToolTurns);
  if (cutIndex <= 0) return messages.map(message => ({ ...message }));

  const older = messages.slice(0, cutIndex);
  const recent = messages.slice(cutIndex);
  const cleanedOlder = [];
  for (const message of older) {
    if (!message || typeof message !== 'object') continue;
    if (message.role === 'tool') continue;

    const next = { ...message };
    if (Array.isArray(next.toolCalls)) delete next.toolCalls;
    if (Array.isArray(next.content)) next.content = stripToolContentParts(next.content);
    if (next.role === 'assistant' && !hasContentAfterToolStrip(next.content)) continue;
    if (next.role === 'user' && Array.isArray(next.content) && next.content.length === 0) continue;
    cleanedOlder.push(next);
  }
  return [...cleanedOlder, ...recent.map(message => ({ ...message }))];
}

function truncateTextToTokens(text, tokenBudget) {
  if (typeof text !== 'string' || tokenBudget <= 0) return '';
  if (estimateTokens(text) <= tokenBudget) return text;
  let out = text.slice(0, Math.max(0, Math.floor(tokenBudget * TEXT_CHARS_PER_TOKEN)));
  while (out && estimateTokens(out) > tokenBudget) out = out.slice(0, -1);
  return out;
}

function attachmentMarkerPart(remainingTokens) {
  if (remainingTokens < estimateTokens(OVERSIZED_ATTACHMENT_MARKER)) return null;
  return { type: 'text', text: OVERSIZED_ATTACHMENT_MARKER };
}

function fitContentToBudget(content, tokenBudget) {
  if (tokenBudget <= 0) return typeof content === 'string' ? '' : [];
  if (typeof content === 'string') return truncateTextToTokens(content, tokenBudget);
  if (!Array.isArray(content)) return content;

  let remaining = Math.max(0, tokenBudget - CONTENT_PART_FRAME_TOKENS);
  const out = [];
  for (const part of content) {
    const cost = estimateContentPartTokens(part);
    if (typeof part === 'string') {
      const text = truncateTextToTokens(part, remaining);
      if (text) {
        out.push(text);
        remaining -= estimateTokens(text);
      }
      continue;
    }
    if (!part || typeof part !== 'object') {
      if (cost <= remaining) {
        out.push(part);
        remaining -= cost;
      }
      continue;
    }

    const type = String(part.type || '');
    if (type === 'text' || type === 'input_text' || type === 'output_text') {
      const text = truncateTextToTokens(typeof part.text === 'string' ? part.text : '', remaining);
      if (text) {
        out.push({ ...part, text });
        remaining -= estimateTokens(text);
      }
      continue;
    }

    if (cost <= remaining) {
      out.push({ ...part });
      remaining -= cost;
      continue;
    }

    // A non-binary structured part may still contain useful text/content.
    // Let the generic text marker path below handle it only when it is
    // genuinely not safely sliceable.
    if (type === 'tool_result' || type === 'function_call_output') {
      const marker = attachmentMarkerPart(remaining);
      if (marker) {
        out.push(marker);
        remaining -= estimateTokens(marker.text);
      }
      continue;
    }

    // A binary part cannot be safely sliced. Replace it with a valid text
    // marker rather than forwarding an oversized/invalid base64 payload.
    const marker = attachmentMarkerPart(remaining);
    if (marker) {
      out.push(marker);
      remaining -= estimateTokens(marker.text);
    }
  }
  return out;
}

function messageOverheadTokens(message) {
  return estimateMessageTokens({ ...message, content: '' });
}

function shrinkMessageToBudget(message, tokenBudget) {
  if (!message || typeof message !== 'object') return message;
  const next = { ...message };
  const contentBudget = Math.max(0, tokenBudget - messageOverheadTokens(message));
  next.content = fitContentToBudget(message.content, contentBudget);

  // If tool metadata alone exceeds the allowance, remove the tool calls from
  // this provider copy. pairSanitize will remove any now-orphaned tool rows;
  // the durable transcript remains untouched.
  if (estimateMessageTokens(next) > tokenBudget && Array.isArray(next.toolCalls)) {
    delete next.toolCalls;
  }
  return next;
}

function dropOldestHistoryUntilBudget(messages, tokenBudget) {
  let out = pairSanitize(messages);
  let turns = countTurns(out);
  while (estimateMessagesTokens(out) > tokenBudget && out.length > 1) {
    if (turns > 1) {
      const next = pairSanitize(sliceLastNTurns(out, turns - 1));
      if (next.length < out.length) {
        out = next;
        turns = countTurns(out);
        continue;
      }
    }
    out = pairSanitize(out.slice(1));
    turns = countTurns(out);
  }
  return out;
}

function fitMessagesToBudget(messages, tokenBudget) {
  let out = dropOldestHistoryUntilBudget(messages, tokenBudget);
  if (estimateMessagesTokens(out) <= tokenBudget) return out;

  // One latest turn can itself exceed the budget (notably a multimodal user
  // message). Shrink message content deterministically instead of allowing a
  // single message to bypass the budget floor.
  for (let index = 0; index < out.length && estimateMessagesTokens(out) > tokenBudget; index += 1) {
    const otherTokens = estimateMessagesTokens(out)
      - estimateMessageTokens(out[index]);
    out[index] = shrinkMessageToBudget(out[index], Math.max(0, tokenBudget - otherTokens));
    out = pairSanitize(out);
  }
  return out;
}

function truncateToolResultsForModel(messages, options = {}) {
  if (!Array.isArray(messages) || messages.length === 0) return [];
  return messages.map(message => {
    if (!message || message.role !== 'tool' || typeof message.content !== 'string') {
      return { ...message };
    }
    return {
      ...message,
      content: truncateToolResultIfNeeded(message.content, {
        toolName: message.name || message.toolName || 'tool_result',
        language: options.language,
      }),
    };
  });
}

/**
 * Build a bounded, pair-safe copy for one provider request.
 *
 * The transform is deterministic and non-persistent:
 *   1. keep at most `recentTurnCap` turns and `maxMessageCount` rows;
 *   2. drop oldest turns until the configured approximate message budget fits;
 *   3. remove old tool noise;
 *   4. bound large tool-result bodies and multimodal content;
 *   5. remove orphan tool pairs.
 *
 * @param {Array<object>} snapshot
 * @param {{ messageTokenBudget?: number, recentTurnCap?: number, maxMessageCount?: number, keepToolTurns?: number, language?: string }} [options]
 * @returns {Array<object>}
 */
export function trimSnapshotForBudget(snapshot, options = {}) {
  if (!Array.isArray(snapshot) || snapshot.length === 0) return [];

  const recentTurnCap = Number.isFinite(options.recentTurnCap) && options.recentTurnCap > 0
    ? Math.floor(options.recentTurnCap)
    : DEFAULT_RECENT_TURN_CAP;
  const messageTokenBudget = Number.isFinite(options.messageTokenBudget) && options.messageTokenBudget > 0
    ? Math.floor(options.messageTokenBudget)
    : DEFAULT_MESSAGE_TOKEN_BUDGET;
  const maxMessageCount = Number.isFinite(options.maxMessageCount) && options.maxMessageCount > 0
    ? Math.floor(options.maxMessageCount)
    : DEFAULT_RUNTIME_CACHE_MESSAGE_CAP;

  let trimmed = sliceLastNTurns(snapshot, recentTurnCap);
  if (trimmed.length > maxMessageCount) trimmed = trimmed.slice(-maxMessageCount);
  let remainingTurnCap = recentTurnCap;
  let tokens = estimateMessagesTokens(trimmed);
  while (tokens > messageTokenBudget && remainingTurnCap > 1) {
    const nextTurnCap = remainingTurnCap - 1;
    const next = sliceLastNTurns(trimmed, nextTurnCap);
    if (next.length === trimmed.length) break;
    remainingTurnCap = nextTurnCap;
    trimmed = next;
    tokens = estimateMessagesTokens(trimmed);
  }

  trimmed = stripToolNoiseFromOlderTurns(trimmed, {
    keepToolTurns: options.keepToolTurns,
  });
  trimmed = truncateToolResultsForModel(trimmed, { language: options.language });
  trimmed = pairSanitize(trimmed);
  return fitMessagesToBudget(trimmed, messageTokenBudget);
}

/**
 * Bound the Session-level runtime history cache. This is deliberately stricter
 * than the provider configuration: the cache is only a disposable source
 * snapshot, while ConversationStore retains the complete transcript.
 *
 * @param {Array<object>} snapshot
 * @param {{ language?: string }} [options]
 * @returns {Array<object>}
 */
export function trimHistoryCacheForRuntime(snapshot, options = {}) {
  return trimSnapshotForBudget(snapshot, {
    recentTurnCap: DEFAULT_RUNTIME_CACHE_TURN_CAP,
    messageTokenBudget: DEFAULT_RUNTIME_CACHE_TOKEN_BUDGET,
    maxMessageCount: DEFAULT_RUNTIME_CACHE_MESSAGE_CAP,
    keepToolTurns: DEFAULT_KEEP_TOOL_TURNS,
    language: options.language,
  });
}
