function responseText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return content == null ? '' : String(content);
  return content
    .map((block) => {
      if (typeof block === 'string') return block;
      return block?.type === 'text' && typeof block.text === 'string' ? block.text : '';
    })
    .join('');
}

const FAILED_RESPONSE_REASONS = new Set(['aborted', 'errored', 'error', 'cancelled', 'canceled']);

function matchesTurn(row, event) {
  if (!row || row.type !== 'assistant') return false;
  const rowSessionId = row.sessionId ?? row.groupId ?? null;
  const rowVpId = row.speakerVpId || row.vpId || null;
  if (event.sessionId && rowSessionId !== event.sessionId) return false;
  if (event.vpId && rowVpId !== event.vpId) return false;
  if (event.turnId && row.turnId !== event.turnId) return false;
  return true;
}

/**
 * Stamp the semantic text boundary when a VP turn terminates. The last
 * non-empty assistant row of a normal end_turn is the result; earlier rows
 * are progress emitted around tool calls. Other terminal reasons have no
 * successful result block.
 */
export function markTurnResponseKinds(rows, event = {}) {
  if (!Array.isArray(rows) || !event.turnId) return false;
  const ownedRows = rows.filter(row => matchesTurn(row, event));
  if (ownedRows.length === 0) return false;

  for (const row of ownedRows) row.responseKind = 'progress';
  if (event.reason === 'end_turn') {
    for (let index = ownedRows.length - 1; index >= 0; index -= 1) {
      if (responseText(ownedRows[index].content).trim()) {
        ownedRows[index].responseKind = 'result';
        break;
      }
    }
  }
  return true;
}

/** Preserve assistant message boundaries instead of concatenating Markdown. */
export function appendTurnResponseSegment(turn, message) {
  if (!turn || !message) return;
  const content = responseText(message.content);
  if (!content) return;
  if (!Array.isArray(turn.textSegments)) turn.textSegments = [];
  turn.textSegments.push({
    key: message.messageId || message.id || `response-${turn.textSegments.length}`,
    content,
    kind: message.responseKind === 'result' ? 'result' : 'progress',
    explicitKind: message.responseKind === 'progress' || message.responseKind === 'result',
    isStreaming: message.isStreaming === true,
  });
  turn.textContent = turn.textSegments.map(segment => segment.content).join('\n\n');
}

/**
 * Old persisted rows have no responseKind. Treat their last text row as the
 * result only after history replay or an explicit end_turn lifecycle stamp.
 */
export function finalizeTurnResponseSegments(turn) {
  const segments = Array.isArray(turn?.textSegments) ? turn.textSegments : [];
  if (segments.length === 0) return;

  const messages = Array.isArray(turn?.messages) ? turn.messages : [];
  const stillRunning = turn?.isActive === true
    || turn?.isStreaming === true
    || segments.some(segment => segment.isStreaming === true)
    || messages.some(message => message?.isStreaming === true || message?.status === 'pending');
  const endedUnsuccessfully = messages.some(message => (
    message?.incomplete === true
    || FAILED_RESPONSE_REASONS.has(message?.status)
    || FAILED_RESPONSE_REASONS.has(message?.turnEndReason)
    || FAILED_RESPONSE_REASONS.has(message?.stopReason)
  ));

  // A persisted responseKind cannot make an in-flight or failed turn successful.
  // Live text chunks stop streaming before tool execution, while the VP turn
  // remains pending. Keep every visible row as progress until a real terminal
  // lifecycle event arrives.
  if (stillRunning || endedUnsuccessfully) {
    for (const segment of segments) segment.kind = 'progress';
    return;
  }

  if (segments.some(segment => segment.kind === 'result')) return;
  const endedNormally = messages.some(message => message?.turnEndReason === 'end_turn');
  const hasExplicitKinds = segments.some(segment => segment.explicitKind);
  const legacySingleSegment = segments.length === 1 && !hasExplicitKinds;
  if (endedNormally || legacySingleSegment || (turn.isHistory && !hasExplicitKinds)) {
    segments[segments.length - 1].kind = 'result';
  }
}
