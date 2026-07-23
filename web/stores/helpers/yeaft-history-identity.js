const HISTORY_IDENTITY_SEPARATOR = '\u001f';

/**
 * Key Session history state by its owning Agent and Session id.
 * Missing Agent ids are accepted only for legacy wire messages.
 */
export function yeaftHistoryIdentityKey(agentId, sessionId) {
  const normalizedSessionId = sessionId == null ? '__all__' : String(sessionId);
  return agentId
    ? `${agentId}${HISTORY_IDENTITY_SEPARATOR}${normalizedSessionId}`
    : normalizedSessionId;
}
