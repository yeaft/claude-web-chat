import { randomUUID } from 'node:crypto';

const REQUEST_TTL_MS = 2 * 60 * 1000;
const MAX_PENDING = 4096;

const pendingRequests = new Map();
const terminalOwners = new Map();

function requestKey(agentId, requestId) {
  return `${String(agentId || '')}\u0000${String(requestId || '')}`;
}

function terminalKey(agentId, terminalId) {
  return `${String(agentId || '')}\u0000${String(terminalId || '')}`;
}

function releasePendingTerminalReservation(pending) {
  if (pending?.timeout) clearTimeout(pending.timeout);
  if (!pending?.terminalId) return;
  const key = terminalKey(pending.agentId, pending.terminalId);
  const owner = terminalOwners.get(key);
  if (owner?.pendingRequestId === pending.requestId) terminalOwners.delete(key);
}

function expirePending(key, pending, reason = 'timeout') {
  if (pendingRequests.get(key) !== pending) return false;
  pendingRequests.delete(key);
  if (pending.timeout) clearTimeout(pending.timeout);
  pending.timeout = null;
  releasePendingTerminalReservation(pending);
  if (typeof pending?.onTimeout === 'function') {
    Promise.resolve(pending.onTimeout(pending, reason)).catch(error => {
      console.error('[Server] Failed to report Workbench request timeout:', error);
    });
  }
  return true;
}

function prune(now = Date.now()) {
  for (const [key, pending] of pendingRequests) {
    if (pending && pending.expiresAt > now) continue;
    expirePending(key, pending);
  }
}

export function registerWorkbenchRequest({
  agentId,
  clientId,
  userId,
  routeKey,
  conversationId,
  workspaceGeneration,
  route,
  role = null,
  requestType,
  expectedResponseTypes,
  publicRequestId = null,
  terminalId = null,
  onTimeout = null,
}) {
  if (!agentId || !clientId || !userId || !routeKey || !conversationId
      || !workspaceGeneration || !requestType) return null;
  const expected = Array.isArray(expectedResponseTypes)
    ? expectedResponseTypes.filter(Boolean)
    : [];
  if (expected.length === 0) return null;
  prune();
  while (pendingRequests.size >= MAX_PENDING) {
    const oldest = pendingRequests.keys().next().value;
    if (oldest == null) break;
    expirePending(oldest, pendingRequests.get(oldest), 'capacity');
  }
  const requestId = randomUUID();
  const key = requestKey(agentId, requestId);
  const pending = {
    agentId,
    requestId,
    clientId,
    userId,
    routeKey,
    conversationId,
    workspaceGeneration,
    route: route ? { ...route } : null,
    role,
    requestType,
    expectedResponseTypes: new Set(expected),
    publicRequestId,
    terminalId,
    onTimeout,
    expiresAt: Date.now() + REQUEST_TTL_MS,
    timeout: null,
  };
  pending.timeout = setTimeout(() => {
    expirePending(key, pending);
  }, REQUEST_TTL_MS);
  pending.timeout.unref?.();
  pendingRequests.set(key, pending);
  return requestId;
}

function consumePending(key, pending) {
  pendingRequests.delete(key);
  if (pending.timeout) clearTimeout(pending.timeout);
  pending.timeout = null;
  return pending;
}

export function consumeWorkbenchRequest({ agentId, requestId, responseType, routeKey = null }) {
  if (!agentId || !requestId || !responseType) return null;
  prune();
  const key = requestKey(agentId, requestId);
  const pending = pendingRequests.get(key);
  if (!pending || !pending.expectedResponseTypes.has(responseType)) return null;
  if (routeKey && pending.routeKey !== routeKey) return null;
  return consumePending(key, pending);
}

/**
 * Correlate responses from the short-lived Agent release window that supported
 * Session Workbench routes but did not echo `_workbenchRequestId`. Agent fields
 * only filter Server-owned pending records; they never directly select a Web
 * client. Ambiguous matches are intentionally left pending to time out.
 */
export function consumeLegacyWorkbenchRequest({
  agentId,
  responseType,
  routeKey,
  userId,
  clientId = null,
  publicRequestId = null,
  terminalId = null,
}) {
  if (!agentId || !responseType || !routeKey || !userId) return null;
  prune();
  const matches = [];
  for (const [key, pending] of pendingRequests) {
    if (pending.agentId !== agentId
        || pending.routeKey !== routeKey
        || pending.userId !== userId
        || !pending.expectedResponseTypes.has(responseType)) continue;
    if (clientId && pending.clientId !== clientId) continue;
    if (publicRequestId && pending.publicRequestId !== publicRequestId) continue;
    if (terminalId && pending.terminalId !== terminalId) continue;
    matches.push([key, pending]);
    if (matches.length > 1) return null;
  }
  if (matches.length !== 1) return null;
  return consumePending(matches[0][0], matches[0][1]);
}

export function deleteWorkbenchRequest({ agentId, requestId }) {
  const key = requestKey(agentId, requestId);
  const pending = pendingRequests.get(key);
  const deleted = pendingRequests.delete(key);
  if (deleted) {
    if (pending.timeout) clearTimeout(pending.timeout);
    pending.timeout = null;
    releasePendingTerminalReservation(pending);
  }
  return deleted;
}

export function registerWorkbenchTerminalOwner(pending) {
  if (!pending?.agentId || !pending?.terminalId || !pending?.clientId
      || !pending?.userId || !pending?.routeKey || !pending?.workspaceGeneration) return false;
  const key = terminalKey(pending.agentId, pending.terminalId);
  const existing = terminalOwners.get(key);
  if (existing && (
    existing.clientId !== pending.clientId
    || existing.userId !== pending.userId
    || existing.routeKey !== pending.routeKey
    || existing.workspaceGeneration !== pending.workspaceGeneration
    || existing.conversationId !== pending.conversationId
  )) return false;
  terminalOwners.set(key, {
    agentId: pending.agentId,
    terminalId: pending.terminalId,
    clientId: pending.clientId,
    userId: pending.userId,
    routeKey: pending.routeKey,
    conversationId: pending.conversationId,
    workspaceGeneration: pending.workspaceGeneration,
    pendingRequestId: pending.requestId || pending.pendingRequestId || null,
  });
  return true;
}

export function getWorkbenchTerminalOwner(agentId, terminalId) {
  return terminalOwners.get(terminalKey(agentId, terminalId)) || null;
}

export function deleteWorkbenchTerminalOwner(agentId, terminalId) {
  return terminalOwners.delete(terminalKey(agentId, terminalId));
}

export function clearWorkbenchCorrelationsForClient(clientId) {
  if (!clientId) return [];
  for (const [key, pending] of pendingRequests) {
    if (pending?.clientId !== clientId) continue;
    pendingRequests.delete(key);
    if (pending.timeout) clearTimeout(pending.timeout);
    pending.timeout = null;
    releasePendingTerminalReservation(pending);
  }
  const terminals = [];
  for (const [key, owner] of terminalOwners) {
    if (owner?.clientId !== clientId) continue;
    terminals.push(owner);
    terminalOwners.delete(key);
  }
  return terminals;
}

export function clearWorkbenchCorrelationsForAgent(agentId) {
  if (!agentId) return;
  for (const [key, pending] of pendingRequests) {
    if (pending?.agentId !== agentId) continue;
    pendingRequests.delete(key);
    if (pending.timeout) clearTimeout(pending.timeout);
    pending.timeout = null;
    releasePendingTerminalReservation(pending);
  }
  for (const [key, owner] of terminalOwners) {
    if (owner?.agentId === agentId) terminalOwners.delete(key);
  }
}

export function __testResetWorkbenchCorrelations() {
  for (const pending of pendingRequests.values()) {
    if (pending.timeout) clearTimeout(pending.timeout);
    pending.timeout = null;
    releasePendingTerminalReservation(pending);
  }
  pendingRequests.clear();
  terminalOwners.clear();
}

export function __testExpireWorkbenchRequest(agentId, requestId) {
  const pending = pendingRequests.get(requestKey(agentId, requestId));
  if (!pending) return false;
  pending.expiresAt = 0;
  return true;
}
