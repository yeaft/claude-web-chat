/**
 * memory/prompt-cleanup.js — prompt-facing memory text hygiene.
 *
 * Disk memory can carry operational metadata such as the per-scope Dream
 * marker. That metadata is useful for schedulers, not for the model. Keep the
 * storage schema compatible and clean only at read / prompt boundaries.
 */

const DREAM_STATE_BLOCK_RE = /<!--\s*dream-state\s*-->[\s\S]*?<!--\s*\/dream-state\s*-->/gi;

/**
 * Remove Dream scheduler metadata blocks from memory text.
 *
 * @param {string} text
 * @returns {string}
 */
export function stripDreamStateBlocks(text) {
  return String(text || '').replace(DREAM_STATE_BLOCK_RE, '').trim();
}

/**
 * Clean text before it is eligible for prompt injection.
 *
 * @param {string} text
 * @returns {string}
 */
export function cleanMemoryPromptText(text) {
  return stripDreamStateBlocks(text)
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Normalized key for conservative prompt dedupe. This is intentionally simple:
 * exact semantic clustering belongs in Dream; prompt assembly only removes
 * obvious repeats and near-contained copies.
 *
 * @param {string} text
 * @returns {string}
 */
export function memoryDedupeKey(text) {
  return cleanMemoryPromptText(text)
    .toLowerCase()
    .replace(/[`*_>#\-\[\]().,，。:：;；!！?？"'“”‘’]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Whether a candidate is redundant with text already emitted to the prompt.
 * Does not mutate `seen`; call `rememberMemoryText` only after the candidate
 * is actually selected into the snapshot.
 *
 * @param {string} candidate
 * @param {Set<string>} seen
 * @returns {boolean}
 */
export function isDuplicateMemoryText(candidate, seen) {
  const key = memoryDedupeKey(candidate);
  if (!key) return true;
  if (seen.has(key)) return true;

  // Avoid dropping tiny generic snippets via containment. A candidate is
  // redundant only when already-selected text covers it. If the candidate is
  // longer and contains the selected text, keep it: actual memory often carries
  // details that a resident summary compressed away.
  if (key.length >= 80) {
    for (const existing of seen) {
      if (existing.length >= 80 && existing.includes(key)) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Mark text as emitted to the prompt for later dedupe checks.
 *
 * @param {string} text
 * @param {Set<string>} seen
 */
export function rememberMemoryText(text, seen) {
  const key = memoryDedupeKey(text);
  if (key) seen.add(key);
}
