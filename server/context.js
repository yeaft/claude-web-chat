import { WebSocket } from 'ws';

// 存储所有连接的 agents
// agentId -> { ws, name, workDir, conversations: Map<convId, {workDir, claudeSessionId}>, sessionKey, isAlive, capabilities }
export const agents = new Map();

// 存储所有 web 客户端
// clientId -> { ws, authenticated, currentAgent, currentConversation, sessionKey, isAlive }
export const webClients = new Map();

// 临时文件存储: fileId -> { name, mimeType, buffer, uploadedAt, userId }
export const pendingFiles = new Map();

// Port proxy
export const pendingProxyRequests = new Map(); // requestId → { res, timeout, streaming }
export const proxyWsConnections = new Map(); // proxyWsId → { browserWs, agentId }

// Store pending agent connections (waiting for auth message)
// tempId -> { ws, agentId, agentName, workDir, timeout }
export const pendingAgentConnections = new Map();

// ★ Phase 3: Server-side message queues
// conversationId → [{id, prompt, workDir, userId, clientId, queuedAt, files}]
export const serverMessageQueues = new Map();

// ★ Phase 4: Directory listing cache
// key: `${agentId}:${normalizedDirPath}` → { entries, timestamp }
export const directoryCache = new Map();
export const DIR_CACHE_TTL = 5 * 60 * 1000; // 5 minutes
export const DIR_CACHE_MAX_SIZE = 500;

// ★ Phase 5: File Tab state storage
// key: `${userId}:${agentId}` → { files: [{path}], activeIndex, timestamp }
export const userFileTabs = new Map();

// Preview file cache for binary file preview (Office/PDF/Image)
// fileId → { buffer, mimeType, filename, createdAt, token }
export const previewFiles = new Map();

// ★ Admin Dashboard: in-memory stats deltas (flushed to DB periodically)
// userId → { requests, bytesSent, bytesReceived, messages, sessions }
export const userStatsDeltas = new Map();

/**
 * Get or initialize a stats delta entry for a user.
 */
function getOrCreateDelta(userId) {
  let delta = userStatsDeltas.get(userId);
  if (!delta) {
    delta = { requests: 0, bytesSent: 0, bytesReceived: 0, messages: 0, sessions: 0 };
    userStatsDeltas.set(userId, delta);
  }
  return delta;
}

/**
 * Record a WS request received from a user.
 */
export function trackRequest(userId, bytesReceived) {
  if (!userId) return;
  const delta = getOrCreateDelta(userId);
  delta.requests++;
  delta.bytesReceived += bytesReceived;
}

/**
 * Record bytes sent to a user via WS.
 */
export function trackBytesSent(userId, bytesSent) {
  if (!userId) return;
  const delta = getOrCreateDelta(userId);
  delta.bytesSent += bytesSent;
}

/**
 * Record a user message (role='user') saved to DB.
 */
export function trackMessage(userId) {
  if (!userId) return;
  const delta = getOrCreateDelta(userId);
  delta.messages++;
}

/**
 * Record a new session created by a user.
 */
export function trackSession(userId) {
  if (!userId) return;
  const delta = getOrCreateDelta(userId);
  delta.sessions++;
}
