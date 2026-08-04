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

export function yeaftHistoryResultIdentity(result) {
  if (typeof result?.entryId === 'string' && result.entryId) return `entry:${result.entryId}`;
  if (result?.role === 'assistant' && result?.turnId) {
    return `live-response:${result.turnId}:${result.speakerVpId || result.vpId || ''}`;
  }
  if (typeof result?.clientMessageId === 'string' && result.clientMessageId) return `client:${result.clientMessageId}`;
  return `message:${result?.messageId || ''}`;
}

export function yeaftPersistedMessageIdentity(agentId, sessionId, messageId) {
  if (typeof messageId !== 'string' || !messageId) return null;
  return `${yeaftHistoryIdentityKey(agentId, sessionId)}${HISTORY_IDENTITY_SEPARATOR}message:${messageId}`;
}

export function yeaftOptimisticMessageIdentity(agentId, sessionId, clientMessageId) {
  if (typeof clientMessageId !== 'string' || !clientMessageId) return null;
  return `${yeaftHistoryIdentityKey(agentId, sessionId)}${HISTORY_IDENTITY_SEPARATOR}client:${clientMessageId}`;
}
