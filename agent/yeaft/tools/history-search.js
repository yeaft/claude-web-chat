/**
 * history-search.js — Search conversation history.
 *
 * Searches through persisted conversation messages for keywords.
 * Uses the ConversationStore's search functionality.
 */

import { defineTool } from './types.js';
import { searchConversationIndex } from '../conversation/history-index.js';
import { searchMessages } from '../conversation/search.js';
import { resolveSessionYeaftDir } from '../sessions/session-crud.js';

const DEFAULT_RESULT_LIMIT = 10;
const MAX_SNIPPET_CHARS = 1000;
export const HISTORY_SEARCH_MAX_OUTPUT_BYTES = 32 * 1024;

function truncateUtf8(text, maxBytes) {
  if (maxBytes <= 0) return '';
  const buffer = Buffer.from(String(text), 'utf8');
  if (buffer.length <= maxBytes) return String(text);
  let end = maxBytes;
  while (end > 0 && (buffer[end] & 0xc0) === 0x80) end -= 1;
  return buffer.subarray(0, end).toString('utf8');
}

function isHighSurrogate(codeUnit) {
  return codeUnit >= 0xd800 && codeUnit <= 0xdbff;
}

function isLowSurrogate(codeUnit) {
  return codeUnit >= 0xdc00 && codeUnit <= 0xdfff;
}

function lowercaseWithOriginalOffsets(text) {
  const fullLower = text.toLocaleLowerCase();
  const lowerParts = [];
  const originalOffsets = [];
  for (let offset = 0; offset < text.length;) {
    const codePoint = String.fromCodePoint(text.codePointAt(offset));
    const loweredCodePoint = codePoint.toLocaleLowerCase();
    lowerParts.push(loweredCodePoint);
    for (let i = 0; i < loweredCodePoint.length; i += 1) originalOffsets.push(offset);
    offset += codePoint.length;
  }

  const mappedLower = lowerParts.join('');
  return {
    lower: mappedLower.length === fullLower.length ? fullLower : mappedLower,
    originalOffsets,
  };
}

function buildSnippet(content, keyword, maxChars = MAX_SNIPPET_CHARS) {
  const text = String(content || '');
  if (text.length <= maxChars) return text;

  const terms = String(keyword || '').trim().toLocaleLowerCase().split(/\s+/u).filter(Boolean);
  const { lower, originalOffsets } = lowercaseWithOriginalOffsets(text);
  const positions = terms.map(term => lower.indexOf(term)).filter(pos => pos >= 0);
  const transformedMatchAt = positions.length > 0 ? Math.min(...positions) : 0;
  const matchAt = originalOffsets[transformedMatchAt] ?? 0;
  let start = Math.max(0, Math.min(matchAt - Math.floor(maxChars / 3), text.length - maxChars));
  let end = Math.min(text.length, start + maxChars);

  if (start > 0 && isLowSurrogate(text.charCodeAt(start)) && isHighSurrogate(text.charCodeAt(start - 1))) {
    start -= 1;
  }
  if (end < text.length && isLowSurrogate(text.charCodeAt(end)) && isHighSurrogate(text.charCodeAt(end - 1))) {
    end -= 1;
  }

  return `${start > 0 ? '...' : ''}${text.slice(start, end)}${end < text.length ? '...' : ''}`;
}

export function serializeHistorySearchOutput(payload, maxBytes = HISTORY_SEARCH_MAX_OUTPUT_BYTES) {
  const serialize = value => JSON.stringify(value, null, 2);
  let output = serialize(payload);
  if (Buffer.byteLength(output, 'utf8') <= maxBytes) return output;

  const originalResultCount = payload.results.length;
  const bounded = {
    ...payload,
    results: [],
    truncated: true,
    omittedResults: originalResultCount,
  };

  for (const result of payload.results) {
    const candidate = {
      ...bounded,
      results: [...bounded.results, result],
      omittedResults: originalResultCount - bounded.results.length - 1,
    };
    const candidateOutput = serialize(candidate);
    if (Buffer.byteLength(candidateOutput, 'utf8') <= maxBytes) {
      bounded.results.push(result);
      bounded.omittedResults -= 1;
      continue;
    }

    const emptyContentCandidate = {
      ...candidate,
      results: [...bounded.results, { ...result, content: '' }],
    };
    const emptyOutput = serialize(emptyContentCandidate);
    if (Buffer.byteLength(emptyOutput, 'utf8') > maxBytes) break;

    let low = 0;
    let high = Buffer.byteLength(result.content || '', 'utf8');
    let best = '';
    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      const content = truncateUtf8(result.content || '', mid);
      const partialOutput = serialize({
        ...candidate,
        results: [...bounded.results, { ...result, content }],
      });
      if (Buffer.byteLength(partialOutput, 'utf8') <= maxBytes) {
        best = content;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
    bounded.results.push({ ...result, content: best });
    bounded.omittedResults -= 1;
    break;
  }

  output = serialize(bounded);
  if (Buffer.byteLength(output, 'utf8') > maxBytes) {
    throw new Error('History search output metadata exceeds the 32 KiB budget');
  }
  return output;
}

export default defineTool({
  name: 'HistorySearch',
  description: {
    en: `Search through past conversation history.

Searches message content for all whitespace-separated terms (case-insensitive) using the Session's indexed history when a Session context is available.
Inside a Session, search is limited to that Session plus sibling Sessions in the same Project on this Agent. Tool-result messages are excluded. Useful for finding previous discussions, decisions, or code snippets.

Results are returned newest-first with a bounded matching snippet and source metadata.`,
    zh: `搜索历史对话记录。

在已持久化消息的正文中搜索全部空格分隔的关键词（不区分大小写）；有 Session 上下文时使用该 Session 的历史索引。在 Session 内仅搜索当前 Session，以及同一 Agent 上同 Project 的兄弟 Session；排除工具结果消息。用于查找之前的讨论、决策或代码片段。

结果按最新优先返回，包含有界的命中片段和来源信息。`
  },
  parameters: {
    type: 'object',
    properties: {
      keyword: {
        type: 'string',
        description: {
          en: 'Search terms (case-insensitive, whitespace-separated terms use AND semantics)',
          zh: '搜索关键词（不区分大小写，空格分隔的多个词采用 AND 语义）',
        },
      },
      limit: {
        type: 'number',
        description: {
          en: 'Maximum number of results (default: 10, maximum: 100)',
          zh: '最多返回结果数（默认 10，最大 100）',
        },
      },
    },
    required: ['keyword'],
  },
  isConcurrencySafe: () => true,
  isReadOnly: () => true,
  async execute(input, ctx) {
    const { keyword, limit = DEFAULT_RESULT_LIMIT } = input;
    if (!keyword) return JSON.stringify({ error: 'keyword is required' });

    const yeaftDir = ctx?.yeaftDir;
    if (!yeaftDir) {
      return JSON.stringify({ error: 'Yeaft directory not configured — no conversation history available' });
    }

    try {
      const projectSessionIds = Array.isArray(ctx?.projectSessionIds)
        ? ctx.projectSessionIds.filter(id => typeof id === 'string' && id.trim()).map(id => id.trim())
        : [];
      const scopedSessionIds = ctx?.sessionId
        ? Array.from(new Set([ctx.sessionId, ...projectSessionIds]))
        : null;
      const telemetry = {};
      let indexedResults = [];

      if (scopedSessionIds) {
        // Conversation history already has a per-Session FTS index. Use it
        // instead of synchronously opening every markdown/JSONL file for each
        // HistorySearch call. Each Session keeps its own index and worker, so
        // project-wide search still respects the owner/session boundary.
        const indexed = await Promise.all(scopedSessionIds.map(async sessionId => {
          const storeDir = resolveSessionYeaftDir(yeaftDir, sessionId);
          const page = await searchConversationIndex(storeDir, sessionId, keyword, {
            limit: Math.min(100, Math.max(1, Number(limit) || DEFAULT_RESULT_LIMIT)),
          });
          return { sessionId, page };
        }));
        for (const { sessionId, page } of indexed) {
          const stats = page || {};
          telemetry.indexedSessions = (telemetry.indexedSessions || 0) + 1;
          telemetry.indexSourceFiles = (telemetry.indexSourceFiles || 0) + (Number(stats.indexSourceFiles) || 0);
          telemetry.indexSourceBytes = (telemetry.indexSourceBytes || 0) + (Number(stats.indexSourceBytes) || 0);
          telemetry.indexEntryCount = (telemetry.indexEntryCount || 0) + (Number(stats.indexEntryCount) || 0);
          telemetry.candidateRowsRead = (telemetry.candidateRowsRead || 0) + (Number(stats.candidateRowsRead) || 0);
          telemetry.candidateBytesRead = (telemetry.candidateBytesRead || 0) + (Number(stats.candidateBytesRead) || 0);
          for (const result of Array.isArray(stats.results) ? stats.results : []) {
            indexedResults.push({
              messageId: result.messageId || null,
              sessionId: result.sessionId || sessionId,
              role: result.role,
              content: buildSnippet(result.snippet || '', keyword),
              mode: null,
              time: result.timestamp || null,
              source: 'session-index',
              turnId: result.turnId || null,
              _seq: Number(result.seq) || 0,
            });
          }
        }
      } else {
        // CLI and legacy callers without a Session context retain the old
        // global search path. The indexed path requires an explicit session
        // because it is intentionally scoped and owner-safe.
        const legacyResults = searchMessages(yeaftDir, keyword, limit, { telemetry });
        indexedResults = legacyResults.map(msg => ({
          messageId: msg.id || null,
          sessionId: msg.sessionId || null,
          role: msg.role,
          content: buildSnippet(msg.content, keyword),
          mode: msg.mode,
          time: msg.time || msg.timestamp || null,
          source: msg.historySource || null,
          _seq: 0,
        }));
      }

      indexedResults.sort((a, b) => {
        const time = String(b.time || '').localeCompare(String(a.time || ''));
        if (time !== 0) return time;
        return (b._seq || 0) - (a._seq || 0);
      });
      const results = indexedResults.slice(0, Math.max(1, Math.min(100, Number(limit) || DEFAULT_RESULT_LIMIT)));
      const searchTelemetry = {
        resultCount: results.length,
        ...(scopedSessionIds
          ? {
              indexedSessions: telemetry.indexedSessions || 0,
              indexSourceFiles: telemetry.indexSourceFiles || 0,
              indexSourceBytes: telemetry.indexSourceBytes || 0,
              indexEntryCount: telemetry.indexEntryCount || 0,
              candidateRowsRead: telemetry.candidateRowsRead || 0,
              candidateBytesRead: telemetry.candidateBytesRead || 0,
            }
          : {
              scannedFiles: telemetry.scannedFiles || 0,
              scannedMessages: telemetry.scannedMessages || 0,
              scannedBytes: telemetry.scannedBytes || 0,
            }),
      };

      if (results.length === 0) {
        return serializeHistorySearchOutput({
          results: [],
          message: `No matches found for "${keyword}"`,
          telemetry: searchTelemetry,
        });
      }

      return serializeHistorySearchOutput({
        results: results.map(({ _seq, ...result }) => result),
        totalResults: results.length,
        keyword,
        telemetry: searchTelemetry,
      });
    } catch (err) {
      return JSON.stringify({ error: `History search failed: ${err.message}` });
    }
  },
});
