function cleanString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function publicError(value) {
  if (!value) return null;
  if (typeof value === 'string') return { name: 'Error', message: value };
  return {
    name: cleanString(value.name) || 'Error',
    message: cleanString(value.message) || String(value),
  };
}

/**
 * Project one sub-agent event onto the public lifecycle boundary.
 * Provider envelopes, accumulated messages, prompts, tool input/output, and
 * raw loop diagnostics are intentionally not part of this projection.
 */
export function projectPublicSubAgentEvent(event) {
  if (!event || typeof event !== 'object') return null;
  const agentId = cleanString(event.agentId);
  const agentName = cleanString(event.agentName);
  const source = {
    sessionId: cleanString(event.parentSessionId) || cleanString(event.sessionId),
    vpId: cleanString(event.parentVpId) || cleanString(event.ownerVpId) || cleanString(event.vpId),
    threadId: cleanString(event.parentThreadId) || cleanString(event.threadId) || 'main',
  };
  const base = {
    type: event.type,
    ...(agentId ? { agentId } : {}),
    ...(agentName ? { agentName } : {}),
    parentSessionId: source.sessionId,
    parentVpId: source.vpId,
    parentThreadId: source.threadId,
  };

  switch (event.type) {
    case 'sub_agent_status':
      return {
        ...base,
        status: cleanString(event.status) || 'unknown',
        ...(event.error ? { error: publicError(event.error) } : {}),
      };
    case 'sub_agent_turn_end':
      return {
        ...base,
        status: cleanString(event.status) || 'idle',
        content: typeof event.content === 'string' ? event.content : '',
      };
    case 'text_delta':
      return {
        ...base,
        text: typeof event.text === 'string' ? event.text : '',
      };
    case 'sub_agent_spawned':
      return { ...base, status: 'running' };
    case 'turn_open':
      return {
        ...base,
        turnId: cleanString(event.turnId),
        ...(event.at ? { at: event.at } : {}),
      };
    case 'turn_close':
      return {
        ...base,
        turnId: cleanString(event.turnId),
        totalMs: Number.isFinite(event.totalMs) ? event.totalMs : null,
        totalTokens: Number.isFinite(event.totalTokens) ? event.totalTokens : null,
        loopCount: Number.isFinite(event.loopCount) ? event.loopCount : null,
      };
    case 'tool_start':
    case 'tool_end':
      return {
        ...base,
        id: cleanString(event.id),
        name: cleanString(event.name),
        ...(event.type === 'tool_end' ? { isError: event.isError === true } : {}),
      };
    case 'usage':
      return {
        ...base,
        inputTokens: Number(event.inputTokens) || 0,
        outputTokens: Number(event.outputTokens) || 0,
        cacheReadTokens: Number(event.cacheReadTokens) || 0,
        cacheWriteTokens: Number(event.cacheWriteTokens) || 0,
      };
    case 'stop':
      return { ...base, stopReason: cleanString(event.stopReason) || 'unknown' };
    case 'error':
      return { ...base, error: publicError(event.error), retryable: event.retryable === true };
    case 'fallback':
      return {
        ...base,
        from: cleanString(event.from),
        to: cleanString(event.to),
        reason: cleanString(event.reason),
      };
    case 'llm_retry':
      return {
        ...base,
        attempt: Number(event.attempt) || 0,
        maxRetries: Number(event.maxRetries) || 0,
        delayMs: Number(event.delayMs) || 0,
        errorClass: cleanString(event.errorClass),
      };
    default:
      return null;
  }
}

export function buildStreamSubAgentFrame({ event, sessionId, vpId = null, threadId = 'main', agentId = null } = {}) {
  const payload = projectPublicSubAgentEvent({
    ...event,
    ...(agentId && !event?.agentId ? { agentId } : {}),
    parentSessionId: event?.parentSessionId || sessionId || null,
    parentVpId: event?.parentVpId || vpId || null,
    parentThreadId: event?.parentThreadId || threadId || 'main',
  });
  if (!payload || !payload.agentId || !payload.parentSessionId) return null;
  if (sessionId && payload.parentSessionId !== sessionId) return null;
  return {
    type: 'sub_agent',
    subtype: payload.type === 'sub_agent_status' ? 'status' : 'event',
    session_id: payload.parentSessionId,
    agent_id: payload.agentId,
    ...(payload.parentVpId ? { vp_id: payload.parentVpId, vpId: payload.parentVpId } : {}),
    thread_id: payload.parentThreadId || 'main',
    threadId: payload.parentThreadId || 'main',
    payload,
  };
}
