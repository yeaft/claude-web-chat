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
    for (const bucket of buckets.values()) ordered.push(...bucket);
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
  // Persisted history can contain several runtime turnIds for one visible
  // reply: partial writes, abort/retry, and tool-loop continuation all stamp
  // their own delivery id. Only a durable RouteForward origin proves that a
  // same-speaker history row starts a new semantic execution.
  if (currentTurn.isHistory && msg.isHistory) {
    return currentTurn.messages?.length > 0
      && msg.executionOrigin === 'route_forward'
      && curTurnId
      && msgTurnId
      && curTurnId !== msgTurnId;
  }

  if (curTurnId && msgTurnId && curTurnId !== msgTurnId) return true;

  return false;
}
