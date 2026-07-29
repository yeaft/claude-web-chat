const SESSION_IDENTITY_SEPARATOR = '\u001f';

/**
 * Build the strict runtime identity for a Yeaft Session owned by an Agent.
 * Missing fields are rejected so callers cannot silently fall back to a bare
 * sessionId in cross-Agent state.
 */
export function yeaftSessionIdentityKey(agentId, sessionId) {
  if (!agentId || !sessionId) return '';
  return `${agentId}${SESSION_IDENTITY_SEPARATOR}${sessionId}`;
}

export function yeaftAgentSessionIdentityPrefix(agentId) {
  return agentId ? `${agentId}${SESSION_IDENTITY_SEPARATOR}` : '';
}

export function yeaftTurnIdentityKey(agentId, turnId) {
  if (!agentId || !turnId) return '';
  return `${agentId}${SESSION_IDENTITY_SEPARATOR}${turnId}`;
}
