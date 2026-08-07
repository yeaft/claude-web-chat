/**
 * memory/preflow.js — DESIGN-H2-AMS §6. Pre-turn memory recall.
 *
 * Pure-CPU pipeline (no LLM). Runs on every turn:
 *
 *   userMsg
 *     → extractKeywords (rule-based tokeniser)
 *     → SQLite FTS5 MATCH (scope-filtered, bm25 ranked)
 *     → rerank by (scope match + tag overlap + recency)
 *     → onDemand layer (budget-clamped)
 *
 * Latency target: < 10ms p95 on a 10k-segment index.
 *
 * Honours `vp/<other>` privacy: caller passes `ownVpId` and the scope
 * filter excludes foreign VP scopes.
 */

import { extractKeywords } from './keywords.js';
import { approxTokens } from './budget.js';
import { isVpForeign } from './store.js';
import { isTransientMemoryText, promptRelevanceTokens } from './prompt-cleanup.js';

export const DEFAULT_PICK_LIMIT = 8;
const STRICT_SCOPE_MIN_QUERY_TERMS = 2;

/**
 * @typedef {object} PreflowOptions
 * @property {string}        userMsg
 * @property {string[]}      relevantScopes      e.g. ['user', 'sessions/s1', 'sessions/s1/vp/alice']
 * @property {string|null}  [ownVpId]
 * @property {string[]}     [currentTags]        tags from the current Session context
 * @property {number}       [topK]               max FTS rows to fetch (default 200)
 * @property {number}       [budgetTokens]       onDemand budget (caller-supplied)
 * @property {number}       [pickLimit]          max picked segments (default 8)
 * @property {boolean}      [uniqueScopes]       pick at most one best hit per scope
 * @property {boolean}      [canonicalOnly]      search canonical content records only
 * @property {string[]}     [strictScopes]       scopes that require multiple distinct query-term matches
 */

/**
 * @typedef {object} PreflowResult
 * @property {string[]}                                  keywords
 * @property {string}                                     ftsQuery
 * @property {import('./index-db.js').SearchHit[]}       hits
 * @property {import('./segment.js').Segment[]}          picked
 * @property {number}                                     pickedTokens
 * @property {number}                                     droppedCount
 * @property {number}                                     droppedByRelevance
 */

/**
 * Run the pre-flow against a segment index.
 *
 * @param {import('./index-db.js').SegmentIndex} index
 * @param {PreflowOptions} opts
 * @returns {PreflowResult}
 */
export function runPreflow(index, opts) {
  const userMsg = (opts.userMsg || '').trim();
  const relevantScopes = Array.isArray(opts.relevantScopes) ? opts.relevantScopes : [];
  const ownVpId = opts.ownVpId || null;
  const currentTags = Array.isArray(opts.currentTags) ? opts.currentTags : [];
  const topK = Number.isFinite(opts.topK) && opts.topK > 0 ? opts.topK : 200;
  const budgetTokens = Number.isFinite(opts.budgetTokens) && opts.budgetTokens > 0
    ? opts.budgetTokens : Infinity;
  const pickLimit = Number.isFinite(opts.pickLimit) && opts.pickLimit > 0
    ? Math.floor(opts.pickLimit) : DEFAULT_PICK_LIMIT;
  const strictScopes = new Set(Array.isArray(opts.strictScopes) ? opts.strictScopes : []);

  const keywords = extractKeywords(userMsg);
  if (keywords.length === 0) {
    return {
      keywords: [], ftsQuery: '', hits: [],
      picked: [], pickedTokens: 0, droppedCount: 0, droppedByRelevance: 0,
    };
  }

  const ftsQuery = buildFtsQuery(keywords);
  const scopeFilter = filterScopes(relevantScopes, ownVpId);
  if (scopeFilter.length === 0) {
    return {
      keywords, ftsQuery, hits: [],
      picked: [], pickedTokens: 0, droppedCount: 0, droppedByRelevance: 0,
    };
  }

  const hits = index.search({
    query: ftsQuery,
    scopeFilter,
    limit: topK,
    ...(opts.canonicalOnly ? { requiredTag: 'canonical-content' } : {}),
  });
  const reranked = rerank(hits, { currentTags, keywords });

  const picked = [];
  const pickedScopes = new Set();
  let cost = 0;
  let dropped = 0;
  let droppedByRelevance = 0;
  for (const h of reranked) {
    if (strictScopes.has(h.scope) && !passesStrictScopeGate(h, userMsg)) {
      dropped += 1;
      droppedByRelevance += 1;
      continue;
    }
    if (opts.uniqueScopes && pickedScopes.has(h.scope)) {
      dropped += 1;
      continue;
    }
    const tk = approxTokens(h.body);
    if (picked.length < pickLimit && cost + tk <= budgetTokens) {
      picked.push(toSegment(h));
      pickedScopes.add(h.scope);
      cost += tk;
    } else {
      dropped += 1;
    }
  }

  return {
    keywords, ftsQuery, hits: reranked,
    picked, pickedTokens: cost, droppedCount: dropped, droppedByRelevance,
  };
}

function passesStrictScopeGate(hit, userMsg) {
  const queryTerms = promptRelevanceTokens(userMsg);
  if (matchedStrictQueryTermCount(hit, queryTerms) >= STRICT_SCOPE_MIN_QUERY_TERMS) return true;

  // Broad scopes still need a narrow path for exact entity lookups. The
  // canonical record's tags are derived from its entire body, so an exact tag is
  // not strong evidence. Require the whole one-term query to equal an authored
  // Markdown heading instead; generic sentences and body-only hits stay gated.
  return isSingleDiscriminativeQuery(userMsg, queryTerms) && hasExactCanonicalHeading(hit, userMsg);
}

function isSingleDiscriminativeQuery(userMsg, queryTerms) {
  if (queryTerms.size !== 1 || isTransientMemoryText(userMsg)) return false;
  const words = String(userMsg || '')
    .normalize('NFKC')
    .toLowerCase()
    .match(/[\p{L}\p{N}_]+/gu) || [];
  return words.length === 1;
}

function matchedStrictQueryTermCount(hit, queryTerms) {
  const haystack = promptRelevanceTokens(
    `${hit?.body || ''}\n${Array.isArray(hit?.tags) ? hit.tags.join(' ') : ''}`,
  );
  let matched = 0;
  for (const term of queryTerms) {
    if (haystack.has(term)) matched += 1;
  }
  return matched;
}

function hasExactCanonicalHeading(hit, userMsg) {
  const query = normalizeStrongEvidenceText(userMsg);
  if (!query) return false;

  let fence = null;
  for (const line of String(hit?.body || '').split(/\r?\n/)) {
    if (fence) {
      const closing = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
      if (closing && closing[1][0] === fence.marker && closing[1].length >= fence.length) {
        fence = null;
      }
      continue;
    }

    const opening = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (opening && !(opening[1][0] === '`' && opening[2].includes('`'))) {
      fence = { marker: opening[1][0], length: opening[1].length };
      continue;
    }
    if (/^(?: {4}| {0,3}\t)/.test(line)) continue;

    const match = /^ {0,3}#{1,6}[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/.exec(line);
    if (match && normalizeStrongEvidenceText(match[1]) === query) return true;
  }
  return false;
}

function normalizeStrongEvidenceText(text) {
  return String(text || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[`*_~[\]()<>{}.,，。:：;；!！?？"'“”‘’]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Compose an FTS5 MATCH query from keywords. Each keyword is OR'd with
 * a prefix wildcard so morphological variants match. We escape any
 * FTS5-special characters by quoting tokens.
 *
 * @param {string[]} keywords
 * @returns {string}
 */
export function buildFtsQuery(keywords) {
  const cleaned = keywords
    .map(k => k.replace(/"/g, ''))
    .filter(k => k.length > 1)
    .slice(0, 8);   // top-8 keywords — avoid query bloat
  if (cleaned.length === 0) return '';
  return cleaned.map(k => `"${k}"*`).join(' OR ');
}

/**
 * Strip foreign VP scopes from the filter list (privacy).
 *
 * @param {string[]} scopes
 * @param {string|null} ownVpId
 * @returns {string[]}
 */
export function filterScopes(scopes, ownVpId) {
  return scopes.filter(s => !isVpForeign(s, ownVpId));
}

/**
 * Rerank FTS hits with two soft signals on top of bm25:
 *   - tag overlap with the current Session context (subtract penalty)
 *   - recency: recent items get a small bonus
 *
 * SQLite FTS5 bm25 returns NEGATIVE numbers (more negative = better
 * match). We treat lower score as better. To make overlap & recency
 * push hits ahead, we SUBTRACT bonuses from the bm25 base (making the
 * score more negative).
 *
 * @param {import('./index-db.js').SearchHit[]} hits
 * @param {{ currentTags: string[], keywords?: string[] }} ctx
 * @returns {import('./index-db.js').SearchHit[]}
 */
export function rerank(hits, ctx) {
  const tagSet = new Set((ctx.currentTags || []).map(t => String(t).toLowerCase()));
  const now = Date.now();
  return [...hits]
    .map(h => {
      const overlap = (h.tags || []).reduce(
        (n, t) => n + (tagSet.has(String(t).toLowerCase()) ? 1 : 0), 0,
      );
      const queryTerms = new Set((ctx.keywords || []).map(term => String(term).toLowerCase()));
      const canonicalOverlap = (h.tags || []).reduce(
        (n, tag) => n + (queryTerms.has(String(tag).toLowerCase()) ? 1 : 0), 0,
      );
      const tagBonus = Math.min(2, overlap * 0.5) + Math.min(1.5, canonicalOverlap * 0.15);
      const ageDays = Math.max(0, (now - Date.parse(h.updatedAt || h.createdAt || '')) / 86400000);
      const recencyBonus = Math.min(0.5, 0.2 / Math.max(0.5, ageDays + 1));
      const base = h.rank ?? 0;
      const score = base - tagBonus - recencyBonus;
      return { ...h, _score: score };
    })
    .sort((a, b) => a._score - b._score)
    .map(({ _score, ...rest }) => ({ ...rest, score: _score }));
}

function toSegment(h) {
  return {
    id: h.id,
    scope: h.scope,
    kind: h.kind,
    tags: h.tags,
    sourceMessages: h.sourceMessages,
    body: h.body,
    score: typeof h.score === 'number' ? h.score : (typeof h.rank === 'number' ? h.rank : undefined),
    createdAt: h.createdAt,
    updatedAt: h.updatedAt,
  };
}
