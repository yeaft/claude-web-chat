/**
 * Boundary rules for Yeaft VP turn rendering.
 *
 * A single user turn may fan out to several VPs. Persisted history can reuse
 * the same user-level turnId across those VP replies, so VP owner identity is
 * the hard boundary whenever both sides are explicitly stamped.
 */

function cleanId(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

export function messageVpOwner(msg) {
  return cleanId(msg?.speakerVpId) || cleanId(msg?.vpId);
}

const VP_TURN_MESSAGE_TYPES = new Set([
  'assistant',
  'chat-image',
  'tool-result',
  'tool-summary',
  'tool-use',
  'tool_result',
]);

// Private renderer metadata: marks rows that passed through an explicit
// execution bucket without cloning or writing fields onto store data.
const executionBoundaryRows = new WeakSet();

function vpExecutionKey(msg) {
  const owner = messageVpOwner(msg);
  const turnId = cleanId(msg?.turnId);
  if (!owner || !turnId) return '';
  return [owner, turnId].join('\u0000');
}

/**
 * Make each explicitly identified VP execution contiguous inside the current
 * visible user turn. Parallel fan-out frames arrive in wall-clock order, so a
 * flat stream can be A(tool), B(tool), A(text), B(text). Rendering that stream
 * by adjacency creates four blocks. Stable bucketing keeps one block per
 * execution while preserving both first-execution order and in-execution order.
 *
 * Rows without an explicit VP + turn identity are left in place and fence the
 * reorderable run. That keeps legacy Chat/history behavior unchanged.
 */
export function orderYeaftVpTurnMessagesByExecution(messages) {
  if (!Array.isArray(messages) || messages.length < 2) return messages || [];

  const ordered = [];
  let run = [];
  const flushRun = () => {
    if (run.length === 0) return;
    const buckets = new Map();
    for (const msg of run) {
      const key = vpExecutionKey(msg);
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(msg);
    }
    for (const bucket of buckets.values()) {
      for (const msg of bucket) {
        executionBoundaryRows.add(msg);
        ordered.push(msg);
      }
    }
    run = [];
  };

  for (const msg of messages) {
    if (VP_TURN_MESSAGE_TYPES.has(msg?.type) && vpExecutionKey(msg)) {
      run.push(msg);
      continue;
    }
    flushRun();
    ordered.push(msg);
  }
  flushRun();
  return ordered;
}

export function shouldCloseYeaftVpTurn(currentTurn, msg) {
  if (!currentTurn || !msg) return false;

  const curSpeaker = cleanId(currentTurn.speakerVpId);
  const msgSpeaker = messageVpOwner(msg);
  if (curSpeaker && msgSpeaker && curSpeaker !== msgSpeaker) return true;

  const curTurnId = cleanId(currentTurn.turnId);
  const msgTurnId = cleanId(msg.turnId);
  if (currentTurn.messages?.length > 0
      && executionBoundaryRows.has(msg)
      && curTurnId
      && msgTurnId
      && curTurnId !== msgTurnId) return true;

  // Legacy persisted history can contain several runtime turnIds for one
  // visible user turn: partial writes, abort/retry, and tool-loop continuation
  // all stamp their own delivery id. Keep that compatibility rule for callers
  // without explicit execution metadata. The sorter above marks every real
  // VP + turnId row, so a replayed RouteForward execution still closes here.
  if (currentTurn.isHistory && msg.isHistory) return false;

  if (curTurnId && msgTurnId && curTurnId !== msgTurnId) return true;

  return false;
}
