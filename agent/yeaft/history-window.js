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

function serializeJsonValue(value) {
  if (typeof value === 'string') return value;
  try {
    const serialized = JSON.stringify(value ?? '');
    return typeof serialized === 'string' ? serialized : String(value ?? '');
  } catch {
    return String(value ?? '');
  }
}

function safeJsonTokenEstimate(value) {
  return estimateTokens(serializeJsonValue(value));
}

function thinkingBlockWirePart(block) {
  if (!block || typeof block !== 'object') return null;
  if (typeof block.signature !== 'string' || !block.signature) return null;
  if (block.redacted) {
    if (typeof block.data !== 'string') return null;
    return { type: 'redacted_thinking', data: block.data, signature: block.signature };
  }
  if (typeof block.thinking !== 'string') return null;
  return { type: 'thinking', thinking: block.thinking, signature: block.signature };
}

function validThinkingBlocks(blocks) {
  if (!Array.isArray(blocks)) return [];
  return blocks.filter(block => thinkingBlockWirePart(block));
}

function estimateThinkingBlockTokens(block) {
  const part = thinkingBlockWirePart(block);
  return part ? estimateContentPartTokens(part) : safeJsonTokenEstimate(block);
}

function estimateThinkingBlocksTokens(blocks) {
  if (!Array.isArray(blocks) || blocks.length === 0) return 0;
  return blocks.reduce((total, block) => total + estimateThinkingBlockTokens(block), CONTENT_PART_FRAME_TOKENS);
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
  if (type === 'thinking') {
    return 4 + estimateTokens(part.thinking || '') + estimateTokens(part.signature || '');
  }
  if (type === 'redacted_thinking') {
    return 4 + estimateTokens(part.data || '') + estimateTokens(part.signature || '');
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
    return 4 + estimateTokens(serializeJsonValue(part.output));
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
  total += estimateThinkingBlocksTokens(message.thinkingBlocks);
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

function toolContentPartCallId(part) {
  if (!part || typeof part !== 'object') return null;
  return part.id || part.tool_use_id || part.call_id || null;
}

function stripToolContentParts(content, selectedCallIds = null) {
  if (!Array.isArray(content)) return content;
  return content.filter(part => {
    if (!part || typeof part !== 'object') return true;
    const isToolPart = part.type === 'tool_use'
      || part.type === 'tool_result'
      || part.type === 'function_call'
      || part.type === 'function_call_output';
    if (!isToolPart) return true;
    return selectedCallIds instanceof Set && selectedCallIds.has(toolContentPartCallId(part));
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
    if (Array.isArray(next.thinkingBlocks)) delete next.thinkingBlocks;
    if (Array.isArray(next.content)) next.content = stripToolContentParts(next.content);
    if (next.role === 'assistant' && !hasContentAfterToolStrip(next.content)) continue;
    if (next.role === 'user' && Array.isArray(next.content) && next.content.length === 0) continue;
    cleanedOlder.push(next);
  }
  return [...cleanedOlder, ...recent.map(message => ({ ...message }))];
}

function stripAllToolNoise(messages) {
  const cleaned = [];
  for (const message of messages) {
    if (!message || typeof message !== 'object' || message.role === 'tool') continue;
    const next = { ...message };
    if (Array.isArray(next.toolCalls)) delete next.toolCalls;
    if (Array.isArray(next.thinkingBlocks)) delete next.thinkingBlocks;
    if (Array.isArray(next.content)) next.content = stripToolContentParts(next.content);
    if (next.role === 'assistant' && !hasContentAfterToolStrip(next.content)) continue;
    if (next.role === 'user' && Array.isArray(next.content) && next.content.length === 0) continue;
    cleaned.push(next);
  }
  return cleaned;
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
  if (!Array.isArray(content)) {
    if (content && typeof content === 'object') {
      const serialized = serializeJsonValue(content);
      return estimateTokens(serialized) <= tokenBudget
        ? content
        : truncateTextToTokens(serialized, tokenBudget);
    }
    return content;
  }

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

function hasProviderContent(content) {
  if (typeof content === 'string') return content.trim().length > 0;
  if (Array.isArray(content)) {
    return content.some(part => {
      if (typeof part === 'string') return part.trim().length > 0;
      if (!part || typeof part !== 'object') return part != null;
      if (typeof part.text === 'string') return part.text.trim().length > 0;
      return part.type !== 'tool_use' && part.type !== 'tool_result'
        && part.type !== 'function_call' && part.type !== 'function_call_output';
    });
  }
  return content != null;
}

function dropEmptyAssistantRows(messages) {
  if (!Array.isArray(messages)) return [];
  return messages.filter(message => {
    if (!message || message.role !== 'assistant') return true;
    return hasProviderContent(message.content)
      || (Array.isArray(message.toolCalls) && message.toolCalls.length > 0)
      || (Array.isArray(message.thinkingBlocks) && message.thinkingBlocks.length > 0);
  });
}

function shrinkMessageToBudget(message, tokenBudget) {
  if (!message || typeof message !== 'object') return message;
  const next = { ...message };
  const hadThinkingBlocks = Array.isArray(message.thinkingBlocks) && message.thinkingBlocks.length > 0;
  const originalThinkingBlocks = validThinkingBlocks(message.thinkingBlocks);
  const messageWithoutThinking = { ...message };
  delete messageWithoutThinking.thinkingBlocks;
  const contentBudget = Math.max(0, tokenBudget - messageOverheadTokens(messageWithoutThinking));
  next.content = fitContentToBudget(message.content, contentBudget);

  // Anthropic signed thinking blocks are atomic. Never truncate their payload
  // or signature. Keep the complete block set only if it fits; otherwise omit
  // the private replay state from this provider copy. Historical text/tool
  // context remains usable, and the durable transcript remains untouched.
  let thinkingBlocksKept = false;
  if (hadThinkingBlocks && originalThinkingBlocks.length === 0) {
    delete next.thinkingBlocks;
  } else if (estimateMessageTokens({ ...next, thinkingBlocks: originalThinkingBlocks }) <= tokenBudget) {
    if (originalThinkingBlocks.length > 0) {
      next.thinkingBlocks = originalThinkingBlocks;
      thinkingBlocksKept = true;
    } else {
      delete next.thinkingBlocks;
    }
  } else {
    delete next.thinkingBlocks;
  }

  // Anthropic requires the signed thinking blocks that precede a tool_use
  // within the same assistant turn. If the atomic thinking replay cannot fit,
  // drop the complete tool arc from this provider copy; pairSanitize removes
  // its role:'tool' rows below. Keeping toolCalls without their signed prefix
  // would produce a protocol-invalid request.
  if (hadThinkingBlocks && !thinkingBlocksKept && Array.isArray(next.toolCalls)) {
    delete next.toolCalls;
  }

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
  while (estimateMessagesTokens(out) > tokenBudget && out.length > 0 && turns > 1) {
    const next = pairSanitize(sliceLastNTurns(out, turns - 1));
    if (next.length === out.length) break;
    out = next;
    turns = countTurns(out);
  }
  return out;
}

function dropOldestHistoryUntilMessageCap(messages, maxMessageCount) {
  let out = pairSanitize(messages);
  let turns = countTurns(out);
  while (out.length > maxMessageCount && turns > 1) {
    const next = pairSanitize(sliceLastNTurns(out, turns - 1));
    if (next.length === out.length) break;
    out = next;
    turns = countTurns(out);
  }
  if (out.length > maxMessageCount) {
    out = pairSanitize(out.slice(-maxMessageCount));
  }
  return out;
}

function providerUnits(messages) {
  const units = [];
  for (let index = 0; index < messages.length;) {
    const message = messages[index];
    if (message?.role !== 'assistant' || !Array.isArray(message.toolCalls) || message.toolCalls.length === 0) {
      units.push([message]);
      index += 1;
      continue;
    }

    const callIds = new Set(message.toolCalls.map(call => call?.id).filter(Boolean));
    const unit = [message];
    let nextIndex = index + 1;
    while (nextIndex < messages.length && messages[nextIndex]?.role === 'tool') {
      const toolMessage = messages[nextIndex];
      if (callIds.has(toolMessage.toolCallId)) unit.push(toolMessage);
      nextIndex += 1;
    }
    units.push(unit);
    index = nextIndex;
  }
  return units;
}

function fitProviderUnit(unit, tokenBudget) {
  if (!Array.isArray(unit) || unit.length === 0 || tokenBudget <= 0) return [];
  const [owner, ...toolMessages] = unit;
  const isToolUnit = owner?.role === 'assistant'
    && Array.isArray(owner.toolCalls)
    && owner.toolCalls.length > 0
    && toolMessages.length > 0;
  if (!isToolUnit) {
    const fitted = shrinkMessageToBudget(owner, tokenBudget);
    return dropEmptyAssistantRows([fitted]);
  }

  // Fit the assistant owner first. Signed thinking blocks are atomic; when
  // they cannot fit, shrinkMessageToBudget removes the toolCalls as well, and
  // this whole unit is dropped so no tool_result can become orphaned.
  const fittedOwner = shrinkMessageToBudget(owner, tokenBudget);
  if (!Array.isArray(fittedOwner.toolCalls) || fittedOwner.toolCalls.length === 0) return [];

  const fitted = [fittedOwner];
  let remaining = Math.max(0, tokenBudget - estimateMessageTokens(fittedOwner));
  for (const toolMessage of toolMessages) {
    if (messageOverheadTokens(toolMessage) > remaining) return [];
    const fittedTool = shrinkMessageToBudget(toolMessage, remaining);
    const fittedToolTokens = estimateMessageTokens(fittedTool);
    if (fittedToolTokens > remaining) return [];
    fitted.push(fittedTool);
    remaining -= fittedToolTokens;
  }
  return fitted;
}

function fitMessagesToBudget(messages, tokenBudget) {
  let out = dropOldestHistoryUntilBudget(pairSanitize(messages), tokenBudget);
  if (estimateMessagesTokens(out) <= tokenBudget) return dropEmptyAssistantRows(out);

  // Treat assistant(toolCalls)+tool rows as one provider unit. The newest unit
  // gets the remaining budget first, but its paired tool results share that
  // budget with the assistant owner. This preserves valid tool protocol shape
  // while bounding serialized object output and signed thinking together.
  const units = providerUnits(out);
  const fittedUnits = Array.from({ length: units.length }, () => []);
  let reserved = 0;
  for (let index = units.length - 1; index >= 0; index -= 1) {
    const fitted = fitProviderUnit(units[index], Math.max(0, tokenBudget - reserved));
    fittedUnits[index] = fitted;
    reserved += estimateMessagesTokens(fitted);
  }
  out = fittedUnits.flat();
  return dropEmptyAssistantRows(pairSanitize(out));
}

function truncateToolResultsForModel(messages, options = {}) {
  if (!Array.isArray(messages) || messages.length === 0) return [];
  return messages.map(message => {
    if (!message || message.role !== 'tool') return { ...message };
    return {
      ...message,
      content: truncateToolResultIfNeeded(message.content, {
        toolName: message.name || message.toolName || 'tool_result',
        language: options.language,
      }),
    };
  });
}

const HISTORY_SOURCE_INDEX = Symbol('historySourceIndex');

function withHistorySourceIndexes(messages) {
  return messages.map((message, index) => (
    message && typeof message === 'object'
      ? { ...message, [HISTORY_SOURCE_INDEX]: index }
      : message
  ));
}

function withoutHistorySourceIndexes(messages) {
  return messages.map(message => {
    if (!message || typeof message !== 'object') return message;
    const next = { ...message };
    delete next[HISTORY_SOURCE_INDEX];
    return next;
  });
}

function completeToolCallIds(messages) {
  const resultIds = new Set(messages
    .filter(message => message?.role === 'tool' && typeof message.toolCallId === 'string')
    .map(message => message.toolCallId));
  const ids = [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== 'assistant' || !Array.isArray(message.toolCalls)) continue;
    for (let callIndex = message.toolCalls.length - 1; callIndex >= 0; callIndex -= 1) {
      const id = message.toolCalls[callIndex]?.id;
      if (typeof id === 'string' && resultIds.has(id)) ids.push(id);
    }
  }
  return ids;
}

function enrichTextBaselineWithTools(textBaseline, toolSource, selectedCallIds) {
  const messagesBySourceIndex = new Map();
  for (const message of textBaseline) {
    if (Number.isInteger(message?.[HISTORY_SOURCE_INDEX])) {
      messagesBySourceIndex.set(message[HISTORY_SOURCE_INDEX], { ...message });
    }
  }

  for (const source of toolSource) {
    const sourceIndex = source?.[HISTORY_SOURCE_INDEX];
    if (!Number.isInteger(sourceIndex)) continue;
    if (source.role === 'tool') {
      if (selectedCallIds.has(source.toolCallId)) {
        messagesBySourceIndex.set(sourceIndex, { ...source });
      }
      continue;
    }
    if (source.role !== 'assistant' || !Array.isArray(source.toolCalls)) continue;

    const selectedCalls = source.toolCalls.filter(call => selectedCallIds.has(call?.id));
    if (selectedCalls.length === 0) continue;
    const selectedIds = new Set(selectedCalls.map(call => call.id));
    const baseline = messagesBySourceIndex.get(sourceIndex);
    const owner = baseline ? { ...baseline } : { ...source };
    owner.toolCalls = selectedCalls;
    if (Array.isArray(source.thinkingBlocks)) owner.thinkingBlocks = source.thinkingBlocks;
    if (Array.isArray(source.content)) {
      const baselineContent = Array.isArray(baseline?.content)
        ? baseline.content
        : stripToolContentParts(source.content);
      const selectedParts = source.content.filter(part => selectedIds.has(toolContentPartCallId(part)));
      owner.content = [...baselineContent, ...selectedParts];
    }
    messagesBySourceIndex.set(sourceIndex, owner);
  }

  return pairSanitize([...messagesBySourceIndex.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, message]) => message));
}

function addOptionalRecentToolPairs(textBaseline, toolSource, options) {
  const selectedCallIds = new Set();
  let out = pairSanitize(textBaseline);
  for (const callId of completeToolCallIds(toolSource)) {
    const trialIds = new Set(selectedCallIds);
    trialIds.add(callId);
    const trial = enrichTextBaselineWithTools(textBaseline, toolSource, trialIds);
    if (trial.length > options.maxMessageCount) continue;
    const fitted = fitMessagesToBudget(trial, options.messageTokenBudget);
    if (!completeToolCallIds(fitted).includes(callId)) continue;
    selectedCallIds.add(callId);
    out = fitted;
  }
  return out;
}

/**
 * Build a bounded, pair-safe copy for one provider request.
 *
 * The transform is deterministic and non-persistent:
 *   1. keep at most `recentTurnCap` turns;
 *   2. build the text-only history baseline and fit it to row/token caps;
 *   3. consider complete tool/function pairs from the newest `keepToolTurns`;
 *   4. add each recent pair only while the fitted text baseline still fits;
 *   5. remove orphan tool pairs.
 *
 * Tool replay is optional enrichment. Text history gets the hard row/token
 * budget first so even recent function payloads cannot evict textual turns.
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

  const keepToolTurns = Number.isFinite(options.keepToolTurns) && options.keepToolTurns >= 0
    ? Math.floor(options.keepToolTurns)
    : DEFAULT_KEEP_TOOL_TURNS;
  const bounded = withHistorySourceIndexes(sliceLastNTurns(snapshot, recentTurnCap));
  let textBaseline = stripAllToolNoise(bounded);
  textBaseline = dropOldestHistoryUntilMessageCap(textBaseline, maxMessageCount);
  textBaseline = fitMessagesToBudget(textBaseline, messageTokenBudget);

  const toolCutIndex = indexOfNthTurnFromEnd(bounded, keepToolTurns);
  const recentToolSource = keepToolTurns > 0
    ? bounded.slice(toolCutIndex < 0 ? 0 : toolCutIndex)
    : [];
  const truncatedToolSource = truncateToolResultsForModel(recentToolSource, { language: options.language });
  const enriched = addOptionalRecentToolPairs(textBaseline, truncatedToolSource, {
    maxMessageCount,
    messageTokenBudget,
  });
  return withoutHistorySourceIndexes(enriched);
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
  if (!Array.isArray(snapshot) || snapshot.length === 0) return [];
  let trimmed = sliceLastNTurns(snapshot, DEFAULT_RUNTIME_CACHE_TURN_CAP);
  trimmed = stripToolNoiseFromOlderTurns(trimmed, {
    keepToolTurns: DEFAULT_KEEP_TOOL_TURNS,
  });
  trimmed = dropOldestHistoryUntilMessageCap(trimmed, DEFAULT_RUNTIME_CACHE_MESSAGE_CAP);
  trimmed = truncateToolResultsForModel(trimmed, { language: options.language });
  trimmed = pairSanitize(trimmed);
  return fitMessagesToBudget(trimmed, DEFAULT_RUNTIME_CACHE_TOKEN_BUDGET);
}
