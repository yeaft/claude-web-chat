import { defineTool } from './types.js';

export const TOOL_DISCOVERY_MAX_RESULTS = 24;
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
  return expanded.match(TOKEN_RE) || [];
}

const TOOL_DISCOVERY_SYNONYMS = Object.freeze({
  storage: ['disk', 'space', 'directory', 'usage', 'size'],
  full: ['disk', 'space', 'usage'],
  files: ['disk', 'space', 'directory', 'usage'],
  monitor: ['durable', 'persistent', 'tracking', 'continue', 'waiting'],
  days: ['durable', 'persistent', 'tracking', 'cross', 'turn'],
  banner: ['image', 'illustration', 'graphic'],
  opinion: ['reviewer', 'review', 'agent'],
  remind: ['history', 'conversation', 'previous', 'past'],
  handled: ['history', 'conversation', 'previous', 'past'],
});

function tokens(value, { expandSynonyms = false } = {}) {
  const base = lowerTokens(value)
    .map(token => token.toLocaleLowerCase())
    .filter(token => token.length > 1 && !STOP_WORDS.has(token));
  if (!expandSynonyms) return base;
  return base.flatMap(token => [token, ...(TOOL_DISCOVERY_SYNONYMS[token] || [])]);
}

function truncate(value, maxChars) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length <= maxChars ? text : `${text.slice(0, maxChars - 1)}…`;
}

function toolSearchText(tool, language) {
  return [
    tool.name,
    tool.description,
    ...Object.keys(tool.parameters?.properties || {}),
  ].map(value => String(value || '')).join(' ');
}

function scoreTool(tool, query, language) {
  const queryTokens = [...new Set(tokens(query, { expandSynonyms: true }))];
  if (queryTokens.length === 0) return 0;
  const name = String(tool.name || '').toLocaleLowerCase();
  const text = toolSearchText(tool, language).toLocaleLowerCase();
  const haystackTokens = new Set(tokens(text));
  let score = 0;
  for (const token of queryTokens) {
    if (name.includes(token)) score += 8;
    else if (haystackTokens.has(token)) score += 4;
    else if (token.length >= 5 && text.includes(token)) score += 1;
  }
  return score;
}

export function discoverToolCapabilities({
  query,
  candidates = [],
  language = 'en',
  maxResults = TOOL_DISCOVERY_MAX_RESULTS,
} = {}) {
  const boundedMax = Math.max(1, Math.min(Number(maxResults) || TOOL_DISCOVERY_MAX_RESULTS, TOOL_DISCOVERY_MAX_RESULTS));
  const scored = candidates
    .map(tool => ({ tool, score: scoreTool(tool, query, language) }))
    .sort((a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name));
  const selected = scored.filter(entry => entry.score > 0).slice(0, boundedMax);
  return selected.map(({ tool }) => ({
    name: tool.name,
    description: truncate(tool.description, TOOL_DISCOVERY_MAX_DESCRIPTION_CHARS),
  }));
}

export default defineTool({
  name: 'DiscoverTools',
  description: {
    en: `Discover registered tools whose full schemas are not currently active.

Use this when the visible tools do not clearly cover the user's request. Search by the user's goal or capability, not by a guessed tool name. The result returns a bounded set of matching tool names and short descriptions; matching schemas become available on the next model loop. This preserves direct tool calls after one lightweight discovery step without exposing the full catalogue on every request.`,
    zh: `发现已注册但当前未激活完整 schema 的工具。

当可见工具不能明确覆盖用户请求时使用。应按用户目标或能力搜索，不要猜工具名。结果返回有界的匹配工具名称和简短描述；对应 schema 会在下一轮模型调用中可用。这样无需每次暴露完整目录，也能在一次轻量发现后直接调用目标工具。`,
  },
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: {
          en: 'User goal or capability to search for',
          zh: '要搜索的用户目标或能力',
        },
      },
      max_results: {
        type: 'number',
        description: {
          en: 'Maximum matches to activate (default and maximum: 24)',
          zh: '最多激活的匹配项（默认及上限为 24）',
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
      maxResults: input?.max_results,
    });
    const output = JSON.stringify(result);
    if (Buffer.byteLength(output, 'utf8') > TOOL_DISCOVERY_MAX_OUTPUT_BYTES) {
      throw new Error('Tool discovery output exceeded its bounded result budget');
    }
    return output;
  },
});
