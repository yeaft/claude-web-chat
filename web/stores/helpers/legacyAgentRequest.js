const STORAGE_KEY = 'yeaft:legacy-agent-requests';

function storage() {
  try {
    return globalThis.localStorage || null;
  } catch {
    return null;
  }
}

function readActiveRequests(now = Date.now()) {
  const target = storage();
  if (!target) return [];
  try {
    const parsed = JSON.parse(target.getItem(STORAGE_KEY) || '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(item => item && typeof item.requestId === 'string' && Number(item.expiresAt) > now);
  } catch {
    return [];
  }
}

function writeRequests(requests) {
  const target = storage();
  if (!target) return false;
  try {
    if (requests.length === 0) target.removeItem(STORAGE_KEY);
    else target.setItem(STORAGE_KEY, JSON.stringify(requests));
    return true;
  } catch {
    return false;
  }
}

export function registerLegacyAgentRequest(agentId, operation, requestId, ttlMs) {
  if (!agentId || !operation || !requestId) return;
  const requests = readActiveRequests().filter(item => item.requestId !== requestId);
  requests.push({ agentId, operation, requestId, expiresAt: Date.now() + ttlMs });
  writeRequests(requests);
}

export function unregisterLegacyAgentRequest(requestId) {
  if (!requestId) return;
  const requests = readActiveRequests();
  writeRequests(requests.filter(item => item.requestId !== requestId));
}

export function isUniqueLegacyAgentRequest(agentId, operation, requestId) {
  if (!agentId || !operation || !requestId) return false;
  const matches = readActiveRequests().filter(item => item.agentId === agentId && item.operation === operation);
  return matches.length === 1 && matches[0].requestId === requestId;
}
