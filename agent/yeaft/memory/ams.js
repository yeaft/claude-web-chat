/**
 * memory/ams.js — DESIGN-H2-AMS §5. Active Memory Set.
 *
 * Per-Session prompt state. The data structure retains three compatible
 * layers, but normal query flow now rebuilds only `resident` from ranked,
 * canonical `content.md` files. `recent` and `onDemand` segment membership is
 * cleared before rendering because `memory.md` is evidence, not prompt prose.
 *
 * AMS is in-memory and does not write to disk; Dream owns canonical content,
 * catalog summaries, and evidence persistence.
 *
 * Privacy: `vp/<other>` scopes are ALWAYS filtered out
 * for any worker that isn't `<other>`. The owning code passes its own
 * vpId at construction.
 */

import { approxTokens } from './budget.js';
import {
  cleanMemoryPromptText,
  filterMemoryPromptTextForPrompt,
  isDuplicateMemoryText,
  rememberMemoryText,
} from './prompt-cleanup.js';
import { isVpForeign } from './store.js';

const RECENT_DEFAULT_CAPACITY = 64;

/**
 * @typedef {object} AmsLayers
 * @property {Map<string, { summary: string, category?: string }>} resident
 * @property {Array<{ id: string, seg: import('./segment.js').Segment, ts: number }>} recent
 * @property {Map<string, import('./segment.js').Segment>} onDemand
 */

/**
 * @typedef {object} AmsSnapshot
 * @property {Array<{ scope: string, summary: string, category?: string }>} resident
 * @property {import('./segment.js').Segment[]} recent
 * @property {import('./segment.js').Segment[]} onDemand
 * @property {{ resident: number, recent: number, onDemand: number, total: number }} usage
 */

export class ActiveMemorySet {
  /**
   * @param {{
   *   ownVpId?: string | null,
   *   budget: import('./budget.js').BudgetSplit,
   *   recentCapacity?: number,
   * }} opts
   */
  constructor(opts) {
    if (!opts || !opts.budget) throw new Error('ActiveMemorySet: budget required');
    this.ownVpId = opts.ownVpId || null;
    this.budget = opts.budget;
    this.recentCapacity = opts.recentCapacity || RECENT_DEFAULT_CAPACITY;
    /** @type {Map<string, { summary: string, category?: string }>} */
    this._resident = new Map();          // scope → prompt-facing summary metadata
    /** @type {Map<string, { seg: import('./segment.js').Segment, ts: number }>} */
    this._recent = new Map();            // segId → entry (insertion-order is LRU order)
    /** @type {Map<string, import('./segment.js').Segment>} */
    this._onDemand = new Map();          // segId → segment
  }

  // ────────────────────────── resident ──────────────────────────

  /**
   * Replace the resident layer with a fresh set of scope→summary
   * pairs. Foreign VP scopes are silently dropped.
   *
   * @param {Array<{ scope: string, summary: string, category?: string }>} entries
   */
  setResident(entries) {
    this._resident.clear();
    for (const e of entries) {
      if (this._isForeignVp(e.scope)) continue;
      const summary = cleanMemoryPromptText(e.summary);
      if (!summary) continue;
      this._resident.set(e.scope, {
        summary,
        ...(typeof e.category === 'string' && e.category ? { category: e.category } : {}),
      });
    }
  }

  // ────────────────────────── recent ──────────────────────────

  /**
   * Touch a segment as "used this turn". LRU semantics: most-recent at
   * the end. Trims to capacity automatically.
   *
   * @param {import('./segment.js').Segment} seg
   */
  touchRecent(seg) {
    if (!seg || !seg.id) return;
    if (this._isForeignVp(seg.scope)) return;
    const body = cleanMemoryPromptText(seg.body);
    if (!body) return;
    if (this._recent.has(seg.id)) this._recent.delete(seg.id);
    this._recent.set(seg.id, { seg: { ...seg, body }, ts: Date.now() });
    while (this._recent.size > this.recentCapacity) {
      const firstKey = this._recent.keys().next().value;
      this._recent.delete(firstKey);
    }
  }

  // ────────────────────────── onDemand ──────────────────────────

  /**
   * Replace the onDemand layer with this turn's FTS hits.
   *
   * @param {import('./segment.js').Segment[]} segments
   */
  setOnDemand(segments) {
    this._onDemand.clear();
    for (const seg of segments) {
      if (this._isForeignVp(seg.scope)) continue;
      const body = cleanMemoryPromptText(seg.body);
      if (!body) continue;
      this._onDemand.set(seg.id, { ...seg, body });
    }
  }

  /**
   * Add segments to onDemand without clearing (used by adjustMemory).
   *
   * @param {import('./segment.js').Segment[]} segments
   */
  addOnDemand(segments) {
    for (const seg of segments) {
      if (this._isForeignVp(seg.scope)) continue;
      const body = cleanMemoryPromptText(seg.body);
      if (!body) continue;
      this._onDemand.set(seg.id, { ...seg, body });
    }
  }

  /**
   * Remove segment ids from onDemand (used by adjustMemory eviction).
   *
   * @param {string[]} ids
   */
  removeOnDemand(ids) {
    for (const id of ids) this._onDemand.delete(id);
  }

  /**
   * Clear persisted segment membership before prompt assembly. Segment ids are
   * retained on disk for migration/debug compatibility, but canonical content
   * is now the only prompt-facing representation.
   */
  clearSegmentLayers() {
    this._recent.clear();
    this._onDemand.clear();
  }

  // ────────────────────────── snapshot ──────────────────────────

  /**
   * Produce a budget-aware snapshot that can be injected into the
   * system prompt. Each layer is greedily packed within its budget;
   * overflow is dropped from this turn but not from disk.
   *
   * @param {{ userMsg?: string }} [opts]
   * @returns {AmsSnapshot}
   */
  snapshot(opts = {}) {
    const userMsg = typeof opts.userMsg === 'string' ? opts.userMsg : '';
    const seenPromptText = new Set();

    // Resident: pack scopes by priority order (caller provides via insert
    // order — current Session's own VP first, then user, etc.).
    const { picked: resPicked, cost: resCost } = pickMemoryItems({
      items: [...this._resident.entries()].map(([scope, entry]) => ({
        scope,
        // Related-Session summaries are explicitly historical context. Keep the
        // bounded prose intact and label it as experience instead of dropping
        // the whole paragraph because it mentions an old PR/tag/task state.
        summary: entry.category === 'experience'
          ? cleanMemoryPromptText(entry.summary)
          : filterMemoryPromptTextForPrompt(entry.summary, userMsg),
        ...(entry.category ? { category: entry.category } : {}),
      })),
      budget: this.budget.resident,
      seen: seenPromptText,
      textOf: e => e.summary,
      costOf: e => approxTokens(e.summary),
    });

    // Recent: insertion order is oldest-first; we want newest first.
    const { picked: recPicked, cost: recCost } = pickMemoryItems({
      items: [...this._recent.values()]
        .reverse()
        .map(e => ({ ...e.seg, body: filterMemoryPromptTextForPrompt(e.seg?.body, userMsg) })),
      budget: this.budget.recent,
      seen: seenPromptText,
      textOf: seg => seg.body,
      costOf: seg => approxTokens(seg.body),
    });

    // OnDemand: insertion order from caller (already FTS-ranked).
    const { picked: odPicked, cost: odCost } = pickMemoryItems({
      items: [...this._onDemand.values()]
        .map(seg => ({ ...seg, body: filterMemoryPromptTextForPrompt(seg?.body, userMsg) })),
      budget: this.budget.onDemand,
      seen: seenPromptText,
      textOf: seg => seg.body,
      costOf: seg => approxTokens(seg.body),
    });

    return {
      resident: resPicked,
      recent: recPicked,
      onDemand: odPicked,
      usage: {
        resident: resCost,
        recent: recCost,
        onDemand: odCost,
        total: resCost + recCost + odCost,
      },
    };
  }

  /**
   * Read-only inspectors (for tests / observability / adjustMemory input).
   */
  residentScopes() { return [...this._resident.keys()]; }
  recentIds()      { return [...this._recent.keys()]; }
  onDemandIds()    { return [...this._onDemand.keys()]; }
  onDemandSegments() { return [...this._onDemand.values()]; }
  size() { return this._resident.size + this._recent.size + this._onDemand.size; }

  // ────────────────────────── privacy ──────────────────────────

  _isForeignVp(scope) {
    return isVpForeign(scope, this.ownVpId);
  }
}

function pickMemoryItems({ items, budget, seen, textOf, costOf }) {
  const picked = [];
  let cost = 0;
  for (const item of items) {
    const text = textOf(item);
    if (!text || isDuplicateMemoryText(text, seen)) continue;
    const itemCost = costOf(item);
    if (cost + itemCost > budget) continue;
    picked.push(item);
    cost += itemCost;
    rememberMemoryText(text, seen);
  }
  return { picked, cost };
}
