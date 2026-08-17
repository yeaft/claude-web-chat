/**
 * Internal-control conversation row helpers.
 *
 * Some older transcripts persisted VP-only control prompts without reliable
 * `internal: true` metadata. Treat those legacy content signatures as hidden
 * conversation rows so they never replay into user-visible history or future
 * model context.
 */

export function isInternalControlContent(content) {
  if (typeof content !== 'string') return false;
  const text = content.trimStart();
  return text.startsWith('<task-result ')
    || text.startsWith('[system note] Async task completion for ')
    || /^\[system note\] You have called \S+ with the same arguments \d+ times\./.test(text);
}

export function isHiddenConversationRow(row) {
  if (!row) return true;
  if (row._reflection || row.internal || row.systemOnly || row.systemOnlyMessage) return true;
  // Legacy compact-control rows remain hidden when reading old stores. The
  // current runtime never creates or injects them.
  if (row.kind === 'compact_summary' || row._compactSummary) return true;
  return isInternalControlContent(row.content);
}

/**
 * Whether a persisted row may be shown as a human-authored conversation turn.
 * Legacy user rows predate provenance metadata and remain visible; new Engine
 * protocol rows carry `userAuthored: false` and are model-only.
 */
export function isVisibleConversationRow(row) {
  if (isHiddenConversationRow(row)) return false;
  return row?.role !== 'user' || row.userAuthored !== false;
}
