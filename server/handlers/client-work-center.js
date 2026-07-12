import { randomUUID } from 'node:crypto';
import { CONFIG } from '../config.js';
import { agents, pendingFiles } from '../context.js';
import { forwardToAgent, sendToWebClient } from '../ws-utils.js';
import {
  assertSupportedWorkItemAttachment,
  assertWorkItemAttachmentSize,
  MAX_WORK_ITEM_ATTACHMENTS,
  MAX_WORK_ITEM_ATTACHMENT_BYTES,
} from '../work-item-attachment-policy.js';

const REQUEST_TIMEOUT_MS = 60_000;
const pendingRequests = new Map();

function prunePendingRequests(now = Date.now()) {
  for (const [requestId, pending] of pendingRequests) {
    if (pending.expiresAt <= now) pendingRequests.delete(requestId);
  }
}

function resolveCreateAttachments(client, payload) {
  const attachments = Array.isArray(payload?.attachments) ? payload.attachments : [];
  if (attachments.length === 0) return { payload, consumedIds: [] };
  if (attachments.length > MAX_WORK_ITEM_ATTACHMENTS) {
    throw new Error(`WorkItem supports at most ${MAX_WORK_ITEM_ATTACHMENTS} attachments`);
  }

  const resolvedFiles = [];
  const consumedIds = [];
  const seen = new Set();
  let totalBytes = 0;
  for (const attachment of attachments) {
    const fileId = typeof attachment?.fileId === 'string' ? attachment.fileId : '';
    if (!fileId || seen.has(fileId)) throw new Error('Invalid WorkItem attachment reference');
    seen.add(fileId);
    const file = pendingFiles.get(fileId);
    if (!file) throw new Error('WorkItem attachment expired; upload it again');
    if (file.userId && !CONFIG.skipAuth && file.userId !== client.userId) {
      throw new Error('WorkItem attachment access denied');
    }
    const buffer = Buffer.isBuffer(file.buffer) ? file.buffer : Buffer.from(file.buffer || '');
    if (buffer.length > CONFIG.maxFileSize) throw new Error('WorkItem attachment exceeds the upload size limit');
    totalBytes += buffer.length;
    if (totalBytes > MAX_WORK_ITEM_ATTACHMENT_BYTES) {
      throw new Error(`WorkItem attachments exceed ${MAX_WORK_ITEM_ATTACHMENT_BYTES} bytes`);
    }
    assertSupportedWorkItemAttachment(file.name, file.mimeType);
    assertWorkItemAttachmentSize(buffer.length);
    resolvedFiles.push({ file, buffer });
    consumedIds.push(fileId);
  }
  const files = resolvedFiles.map(({ file, buffer }) => ({
    name: file.name,
    mimeType: file.mimeType,
    data: buffer.toString('base64'),
    isImage: String(file.mimeType || '').startsWith('image/'),
  }));
  return {
    payload: { ...(payload || {}), files },
    consumedIds,
  };
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
  const op = typeof msg.op === 'string' ? msg.op : '';
  const sourcePayload = msg.payload && typeof msg.payload === 'object' ? msg.payload : {};
  let resolved = { payload: sourcePayload, consumedIds: [] };
  try {
    if (op === 'create' && Object.hasOwn(sourcePayload, 'files')) {
      throw new Error('WorkItem files are server-generated and cannot be supplied by the browser');
    }
    const attachments = Array.isArray(sourcePayload.attachments) ? sourcePayload.attachments : [];
    if (op === 'create' && attachments.length > 0) {
      const capabilities = agents.get(agentId)?.capabilities;
      if (!Array.isArray(capabilities) || !capabilities.includes('work_item_attachments')) {
        throw new Error('The selected Agent does not support WorkItem attachments');
      }
    }
    if (op === 'create') resolved = resolveCreateAttachments(client, sourcePayload);
  } catch (error) {
    await sendToWebClient(client, {
      type: 'work_center_response',
      requestId: typeof msg.requestId === 'string' ? msg.requestId : null,
      agentId,
      op,
      ok: false,
      error: error?.message || String(error),
    });
    return true;
  }

  pendingRequests.set(requestId, {
    client,
    agentId,
    attachmentFileIds: resolved.consumedIds,
    expiresAt: Date.now() + REQUEST_TIMEOUT_MS,
  });

  try {
    await forwardToAgent(agentId, {
      type: 'work_center_request',
      requestId,
      op,
      payload: resolved.payload,
    });
  } catch (error) {
    pendingRequests.delete(requestId);
    throw error;
  }

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
  if (msg.ok === true) {
    for (const fileId of pending.attachmentFileIds || []) pendingFiles.delete(fileId);
  }
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
