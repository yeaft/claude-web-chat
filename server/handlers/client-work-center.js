import { randomUUID } from 'node:crypto';
import { forwardToAgent, sendToWebClient } from '../ws-utils.js';

const REQUEST_TIMEOUT_MS = 60_000;
const pendingRequests = new Map();

function prunePendingRequests(now = Date.now()) {
  for (const [requestId, pending] of pendingRequests) {
    if (pending.expiresAt <= now) pendingRequests.delete(requestId);
  }
}

/**
 * Relay Work Center commands to the selected Agent.
 *
 * WorkItem data is Agent-local. The server owns authentication and routing.
 * Request ownership stays server-side; an Agent can never choose which user
 * receives a response by echoing or forging identity fields.
 */
export async function handleClientWorkCenter(client, msg, checkAgentAccess) {
  if (msg?.type !== 'work_center_request') return false;

  const agentId = typeof msg.agentId === 'string' && msg.agentId.trim()
    ? msg.agentId.trim()
    : client.currentAgent;
  if (!agentId) return true;
  if (!await checkAgentAccess(agentId)) return true;

  prunePendingRequests();
  const requestId = randomUUID();
  pendingRequests.set(requestId, {
    client,
    agentId,
    expiresAt: Date.now() + REQUEST_TIMEOUT_MS,
  });

  await forwardToAgent(agentId, {
    type: 'work_center_request',
    requestId,
    op: typeof msg.op === 'string' ? msg.op : '',
    payload: msg.payload && typeof msg.payload === 'object' ? msg.payload : {},
  });

  // The browser owns the original id; Agent responses carry only the opaque
  // server id. This mapping prevents cross-client response spoofing.
  pendingRequests.get(requestId).clientRequestId = typeof msg.requestId === 'string' ? msg.requestId : null;
  return true;
}

export async function deliverWorkCenterResponse(agentId, msg) {
  prunePendingRequests();
  const pending = typeof msg?.requestId === 'string' ? pendingRequests.get(msg.requestId) : null;
  if (!pending || pending.agentId !== agentId) return false;
  pendingRequests.delete(msg.requestId);
  const { agentId: _untrustedAgentId, requestId: _opaqueRequestId, _requestUserId, ...payload } = msg;
  await sendToWebClient(pending.client, {
    ...payload,
    agentId,
    requestId: pending.clientRequestId,
  });
  return true;
}

export function clearWorkCenterRequestsForClient(client) {
  for (const [requestId, pending] of pendingRequests) {
    if (pending.client === client) pendingRequests.delete(requestId);
  }
}

export function __testResetWorkCenterRequests() {
  pendingRequests.clear();
}
