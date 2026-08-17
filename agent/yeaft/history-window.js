/**
 * history-window.js — deterministic history shaping for provider requests.
 *
 * This module never calls an LLM, writes a summary, archives transcript rows,
 * or changes the persisted conversation. It only builds a bounded copy of the
 * recent transcript for one provider request. The persisted message history
 * remains authoritative; Memory/Dream is the long-lived semantic context.
 */

import { estimateTokens } from './conversation/persist.js';
import { pairSanitize } from './pair-sanitize.js';
import { truncateToolResultIfNeeded } from './tools/registry.js';
import { indexOfNthTurnFromEnd, sliceLastNTurns } from './turn-utils.js';

const DEFAULT_KEEP_TOOL_TURNS = 3;
const DEFAULT_RECENT_TURN_CAP = 25;
const DEFAULT_MESSAGE_TOKEN_BUDGET = 32768;

function hasContentAfterToolStrip(content) {
  if (typeof content === 'string') return content.trim().length > 0;
  if (Array.isArray(content)) return content.length > 0;
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
 * Estimate the provider-token weight of one message. This is only a guardrail;
 * the provider remains authoritative about the actual context limit.
 *
 * @param {object} message
 * @returns {number}
 */
export function estimateMessageTokens(message) {
  if (!message || typeof message !== 'object') return 0;
  let total = 2;
  if (typeof message.content === 'string') total += estimateTokens(message.content);
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
 *   1. keep at most `recentTurnCap` turns;
 *   2. drop oldest turns until the configured approximate message budget fits;
 *   3. remove old tool noise;
 *   4. bound large tool-result bodies;
 *   5. remove orphan tool pairs.
 *
 * @param {Array<object>} snapshot
 * @param {{ messageTokenBudget?: number, recentTurnCap?: number, keepToolTurns?: number, language?: string }} [options]
 * @returns {Array<object>}
 */
export function trimSnapshotForBudget(snapshot, options = {}) {
  if (!Array.isArray(snapshot) || snapshot.length === 0) return [];

  const recentTurnCap = Number.isFinite(options.recentTurnCap) && options.recentTurnCap > 0
    ? options.recentTurnCap
    : DEFAULT_RECENT_TURN_CAP;
  const messageTokenBudget = Number.isFinite(options.messageTokenBudget) && options.messageTokenBudget > 0
    ? options.messageTokenBudget
    : DEFAULT_MESSAGE_TOKEN_BUDGET;

  let trimmed = sliceLastNTurns(snapshot, recentTurnCap);
  let remainingTurnCap = recentTurnCap;
  let tokens = estimateMessagesTokens(trimmed);
  while (tokens > messageTokenBudget && remainingTurnCap > 1) {
    remainingTurnCap -= 1;
    trimmed = sliceLastNTurns(trimmed, remainingTurnCap);
    tokens = estimateMessagesTokens(trimmed);
  }

  trimmed = stripToolNoiseFromOlderTurns(trimmed, {
    keepToolTurns: options.keepToolTurns,
  });
  trimmed = truncateToolResultsForModel(trimmed, { language: options.language });
  return pairSanitize(trimmed);
}
