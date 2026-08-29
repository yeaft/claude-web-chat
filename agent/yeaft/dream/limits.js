/**
 * dream/limits.js constants.
 *
 * Centralised so tests and runtime share one source of truth. Exposed
 * as both named exports and a `DEFAULT_LIMITS` object for `runDream()`
 * callers that want to override one knob without restating the rest.
 *
 * `loadLimitsFromConfig(config)` merges a `~/.yeaft/config.json`
 * `yeaft.dream` block on top of defaults; unknown keys are ignored,
 * malformed values fall back to default.
 */

export const DREAM_INTERVAL_HOURS = 1;
export const DREAM_OVERLAP = 3;
export const MIN_NEW_PER_GROUP = 20;
export const MAX_SINGLE_MESSAGE_CHARS = 8000;
// Provider tokenizers differ substantially for CJK and serialized tool text.
// Keep an independent character ceiling so the approximate token budget cannot
// turn into a multi-million-token wire request.
export const MAX_DREAM_PROMPT_CHARS = 96000;
export const MAX_DIFF_TOKENS_PER_TRIAGE = 60000;
export const MAX_APPLY_TOKENS = 80000;
// Dream writes compact canonical memory, not long-form user output. Keep the
// response large enough for structured updates while bounding runaway cost.
export const MAX_DREAM_OUTPUT_TOKENS = 8192;
export const DREAM_FAILURE_BACKOFF_HOURS = 2;
export const DREAM_FAILURE_BACKOFF_MAX_HOURS = 24;
export const DREAM_BACKUP_KEEP = 7;

// task-710: nudge dream off the 1h timer when a group has accumulated
// this many user messages since the last successful pass. Keeps memory
// fresh during heavy chat windows without rivalling user latency.
export const DREAM_NUDGE_AFTER_MESSAGES = 50;

export const DEFAULT_LIMITS = Object.freeze({
  DREAM_INTERVAL_HOURS,
  DREAM_OVERLAP,
  MIN_NEW_PER_GROUP,
  MAX_SINGLE_MESSAGE_CHARS,
  MAX_DREAM_PROMPT_CHARS,
  MAX_DIFF_TOKENS_PER_TRIAGE,
  MAX_APPLY_TOKENS,
  MAX_DREAM_OUTPUT_TOKENS,
  DREAM_FAILURE_BACKOFF_HOURS,
  DREAM_FAILURE_BACKOFF_MAX_HOURS,
  DREAM_BACKUP_KEEP,
  DREAM_NUDGE_AFTER_MESSAGES,
});

/**
 * Merge a config object's `yeaft.dream` block on top of defaults.
 * @param {object} [config]
 */
export function loadLimitsFromConfig(config) {
  const out = { ...DEFAULT_LIMITS };
  const ud = config && config.yeaft && config.yeaft.dream;
  if (!ud || typeof ud !== 'object') return out;
  for (const k of Object.keys(out)) {
    if (Object.prototype.hasOwnProperty.call(ud, k)) {
      const v = ud[k];
      if (Number.isFinite(v) && v > 0) out[k] = v;
    }
  }
  return out;
}
