/**
 * history-search.js — Search conversation history.
 *
 * Searches through persisted conversation messages for keywords.
 * Uses the ConversationStore's search functionality.
 */

import { defineTool } from './types.js';
import { searchMessages } from '../conversation/search.js';

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

function buildSnippet(content, keyword, maxChars = MAX_SNIPPET_CHARS) {
  const text = String(content || '');
  if (text.length <= maxChars) return text;

  const terms = String(keyword || '').trim().toLocaleLowerCase().split(/\s+/u).filter(Boolean);
  const lower = text.toLocaleLowerCase();
  const positions = terms.map(term => lower.indexOf(term)).filter(pos => pos >= 0);
  const matchAt = positions.length > 0 ? Math.min(...positions) : 0;
  const start = Math.max(0, Math.min(matchAt - Math.floor(maxChars / 3), text.length - maxChars));
  const end = Math.min(text.length, start + maxChars);
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

Searches message content for all whitespace-separated terms (case-insensitive).
Tool-result messages are excluded. Useful for finding previous discussions, decisions, or code snippets.

Results are returned newest-first with a bounded matching snippet and source metadata.`,
    zh: `搜索历史对话记录。

在已持久化消息的正文中搜索全部空格分隔的关键词（不区分大小写），并排除工具结果消息。用于查找之前的讨论、决策或代码片段。

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
      const telemetry = {};
      const results = searchMessages(yeaftDir, keyword, limit, { telemetry });
      const searchTelemetry = {
        resultCount: results.length,
        scannedFiles: telemetry.scannedFiles || 0,
        scannedMessages: telemetry.scannedMessages || 0,
        scannedBytes: telemetry.scannedBytes || 0,
      };

      if (results.length === 0) {
        return serializeHistorySearchOutput({
          results: [],
          message: `No matches found for "${keyword}"`,
          telemetry: searchTelemetry,
        });
      }

      return serializeHistorySearchOutput({
        results: results.map(msg => ({
          messageId: msg.id || null,
          sessionId: msg.sessionId || null,
          role: msg.role,
          content: buildSnippet(msg.content, keyword),
          mode: msg.mode,
          time: msg.time || msg.timestamp || null,
          source: msg.historySource || null,
        })),
        totalResults: results.length,
        keyword,
        telemetry: searchTelemetry,
      });
    } catch (err) {
      return JSON.stringify({ error: `History search failed: ${err.message}` });
    }
  },
});
