import { defineTool } from './types.js';

export const TOOL_DISCOVERY_MAX_RESULTS = 24;
export const TOOL_DISCOVERY_MAX_NAME_CHARS = 256;
export const TOOL_DISCOVERY_MAX_DESCRIPTION_CHARS = 320;
export const TOOL_DISCOVERY_MAX_OUTPUT_BYTES = 12 * 1024;

const TOKEN_RE = /[\p{L}\p{N}]+/gu;
const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'can', 'do', 'for', 'from',
  'how', 'i', 'in', 'is', 'it', 'me', 'my', 'of', 'on', 'or', 'the', 'this',
  'to', 'us', 'we', 'what', 'when', 'where', 'which', 'who', 'why', 'with', 'you',
]);

function lowerTokens(value) {
  const text = String(value || '');
  if (!text) return [];
  const expanded = text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ');
  return (expanded.match(TOKEN_RE) || []).map(token => token.toLocaleLowerCase());
}

function tokens(value) {
  return lowerTokens(value).filter(token => token.length > 1 && !STOP_WORDS.has(token));
}

function truncate(value, maxChars) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length <= maxChars ? text : `${text.slice(0, maxChars - 1)}…`;
}

function toolSearchText(tool) {
  return [
    tool.name,
    tool.description,
    ...Object.keys(tool.parameters?.properties || {}),
  ].map(value => String(value || '')).join(' ');
}

function scoreTool(tool, queryTokens) {
  if (queryTokens.length === 0) return 0;
  const name = String(tool.name || '').toLocaleLowerCase();
  const text = toolSearchText(tool).toLocaleLowerCase();
  const haystackTokens = new Set(tokens(text));
  let score = 0;
  for (const token of queryTokens) {
    if (name.includes(token)) score += 8;
    else if (haystackTokens.has(token)) score += 4;
    else if (token.length >= 5 && text.includes(token)) score += 1;
  }
  return score;
}

function normalizeCursor(value) {
  if (value == null || value === '') return 0;
  const cursor = Number(value);
  return Number.isInteger(cursor) && cursor >= 0 ? cursor : null;
}

function validCandidate(tool) {
  return typeof tool?.name === 'string'
    && tool.name.length > 0
    && tool.name.length <= TOOL_DISCOVERY_MAX_NAME_CHARS;
}

function byteLength(value) {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

/**
 * Return one deterministic page from the complete hidden tool directory.
 * Lexical scoring only improves ordering; it never decides reachability.
 */
export function discoverToolCapabilities({
  query,
  candidates = [],
  cursor = 0,
  maxResults = TOOL_DISCOVERY_MAX_RESULTS,
} = {}) {
  const boundedMax = Math.max(1, Math.min(Number(maxResults) || TOOL_DISCOVERY_MAX_RESULTS, TOOL_DISCOVERY_MAX_RESULTS));
  const queryTokens = [...new Set(tokens(query))];
  let omittedInvalid = 0;
  const scored = [];
  for (const tool of Array.isArray(candidates) ? candidates : []) {
    if (!validCandidate(tool)) {
      omittedInvalid += 1;
      continue;
    }
    scored.push({
      tool,
      score: scoreTool(tool, queryTokens),
    });
  }
  scored.sort((a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name));

  const normalizedCursor = normalizeCursor(cursor);
  if (normalizedCursor == null || normalizedCursor > scored.length) {
    return {
      tools: [],
      next_cursor: null,
      total: scored.length,
      omitted_invalid: omittedInvalid,
      restart_required: true,
      message: 'The hidden tool directory changed or the cursor is invalid. Restart discovery without a cursor.',
    };
  }
  const start = normalizedCursor;
  const tools = [];
  let index = start;
  while (index < scored.length && tools.length < boundedMax) {
    const tool = scored[index].tool;
    const item = {
      name: tool.name,
      description: truncate(tool.description, TOOL_DISCOVERY_MAX_DESCRIPTION_CHARS),
    };
    const hasMoreAfterItem = index + 1 < scored.length;
    const tentative = {
      tools: [...tools, item],
      next_cursor: hasMoreAfterItem ? index + 1 : null,
      total: scored.length,
      omitted_invalid: omittedInvalid,
    };
    if (byteLength(tentative) > TOOL_DISCOVERY_MAX_OUTPUT_BYTES) break;
    tools.push(item);
    index += 1;
  }

  const nextCursor = index < scored.length && tools.length > 0 ? index : null;
  const result = {
    tools,
    next_cursor: nextCursor,
    total: scored.length,
    omitted_invalid: omittedInvalid,
  };
  if (byteLength(result) > TOOL_DISCOVERY_MAX_OUTPUT_BYTES) {
    return { tools: [], next_cursor: null, total: 0, omitted_invalid: omittedInvalid };
  }
  return result;
}

export default defineTool({
  name: 'DiscoverTools',
  description: {
    en: `Discover registered tools whose full schemas are not currently active.

Use this when the visible tools do not clearly cover the user's request. Search by the user's goal or capability, not by a guessed tool name. The result is a bounded page from the complete hidden tool directory, ordered by likely relevance; lexical similarity affects ordering only and never removes capabilities. If the target is absent, continue with next_cursor until found or the directory is exhausted. If restart_required is true, discard the cursor and restart without one because the registered directory changed. Returned tool schemas become available on the next model loop.`,
    zh: `发现已注册但当前未激活完整 schema 的工具。

当可见工具不能明确覆盖用户请求时使用。应按用户目标或能力搜索，不要猜工具名。结果是完整隐藏工具目录中的有界分页，并按可能相关性排序；词法相似度只影响顺序，绝不会让能力不可达。如果当前页没有目标，应使用 next_cursor 继续翻页直到找到或目录耗尽。如果 restart_required 为 true，说明注册目录已变化，应丢弃游标并在不带游标的情况下重新开始。返回工具的 schema 会在下一轮模型调用中可用。`,
  },
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: {
          en: 'User goal or capability used to rank the complete hidden directory',
          zh: '用于排序完整隐藏目录的用户目标或能力',
        },
      },
      cursor: {
        type: 'number',
        description: {
          en: 'Pagination cursor returned by a previous discovery page',
          zh: '上一页发现结果返回的分页游标',
        },
      },
      max_results: {
        type: 'number',
        description: {
          en: 'Maximum directory entries to activate (default and maximum: 24)',
          zh: '最多激活的目录项数（默认及上限为 24）',
        },
      },
    },
    required: ['query'],
  },
  isConcurrencySafe: () => true,
  isReadOnly: () => true,
  async execute(input, ctx = {}) {
    const query = typeof input?.query === 'string' ? input.query.trim() : '';
    if (!query) return JSON.stringify({ error: 'query is required' });
    if (typeof ctx?.discoverTools !== 'function') {
      return JSON.stringify({ error: 'Tool discovery is unavailable in this runtime.' });
    }
    const result = await ctx.discoverTools({
      query,
      cursor: input?.cursor,
      maxResults: input?.max_results,
    });
    const output = JSON.stringify(result);
    if (Buffer.byteLength(output, 'utf8') > TOOL_DISCOVERY_MAX_OUTPUT_BYTES) {
      throw new Error('Tool discovery violated its bounded result budget');
    }
    return output;
  },
});
