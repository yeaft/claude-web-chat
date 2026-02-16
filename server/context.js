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
