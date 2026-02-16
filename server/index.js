import express from 'express';
import compression from 'compression';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { CONFIG, isEmailConfigured, validateProductionConfig } from './config.js';
import { agents, webClients, userFileTabs } from './context.js';
import { invitationDb } from './database.js';
import { registerApiRoutes } from './api.js';
import { registerProxyRoutes, handleProxyWebSocketUpgrade } from './proxy.js';
import { handleAgentConnection } from './ws-agent.js';
import { handleWebConnection } from './ws-client.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ noServer: true });

// =====================
// WebSocket 心跳机制
// =====================
const HEARTBEAT_INTERVAL = 30000;

setInterval(() => {
  // 检查 agents
  for (const [agentId, agent] of agents) {
    if (agent.isAlive === false) {
      console.log(`[Heartbeat] Agent ${agentId} not responding, terminating`);
      agent.ws.terminate();
      continue;
    }
    agent.isAlive = false;
    agent.pingSentAt = Date.now();
    agent.ws.ping();
  }

  // 检查 web clients
  for (const [clientId, client] of webClients) {
    if (client.isAlive === false) {
      console.log(`[Heartbeat] Web client ${clientId} not responding, terminating`);
      client.ws.terminate();
      continue;
    }
    client.isAlive = false;
    client.ws.ping();
  }
}, HEARTBEAT_INTERVAL);

// ★ Phase 5: 每小时清理超过 24 小时的 file tab 状态
setInterval(() => {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  for (const [key, state] of userFileTabs) {
    if (state.timestamp < cutoff) userFileTabs.delete(key);
  }
}, 60 * 60 * 1000);

// ★ Phase 6: 每小时清理过期的未使用邀请码
setInterval(() => {
  invitationDb.cleanup();
}, 60 * 60 * 1000);

// Gzip 压缩中间件
app.use(compression({
  level: 6,
  threshold: 1024,
  filter: (req, res) => {
    if (req.headers['x-no-compression']) return false;
    // Skip compression for proxy routes (avoid buffering SSE/streaming)
    if (req.path.startsWith('/agent/')) return false;
    return compression.filter(req, res);
  }
}));

// 静态文件服务
const webDir = process.env.SERVE_DIST === 'true'
  ? join(__dirname, '../web/dist')
  : join(__dirname, '../web');
app.use(express.static(webDir, {
  maxAge: process.env.SERVE_DIST === 'true' ? '1d' : 0,
  etag: true
}));

// Port proxy routes (must be before express.json() to get raw body)
registerProxyRoutes(app);

// JSON body parser — after proxy routes
app.use(express.json());

// API routes (auth, sessions, users, upload)
registerApiRoutes(app);

// =====================
// WebSocket 连接处理
// =====================
wss.on('connection', (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const clientType = url.searchParams.get('type');

  if (clientType === 'agent') {
    handleAgentConnection(ws, url);
  } else if (clientType === 'web') {
    handleWebConnection(ws, url);
  } else {
    ws.close(1008, 'Invalid client type');
  }
});

// =====================
// HTTP Upgrade handler
// =====================
server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  // Check if this is a proxy WebSocket request
  const proxyMatch = url.pathname.match(/^\/agent\/([^/]+)\/(\d+)(\/.*)?$/);
  if (proxyMatch) {
    handleProxyWebSocketUpgrade(req, socket, head, proxyMatch);
    return;
  }

  // Otherwise, hand off to the main WebSocket server
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req);
  });
});

// Validate production configuration before starting
const configValidation = validateProductionConfig();
if (!configValidation.valid) {
  console.error('\n========================================');
  console.error('SECURITY CONFIGURATION ERROR');
  console.error('========================================');
  for (const error of configValidation.errors) {
    console.error(`  - ${error}`);
  }
  console.error('\nServer cannot start with default secrets in production mode.');
  console.error('Please configure the following environment variables:');
  console.error('  - JWT_SECRET: A secure random string for JWT signing');
  console.error('\nOr set SKIP_AUTH=true for development mode (NOT recommended for production).');
  console.error('========================================\n');
  process.exit(1);
}
if (configValidation.warnings) {
  console.warn('\n⚠ Configuration warnings:');
  for (const w of configValidation.warnings) {
    console.warn(`  - ${w}`);
  }
  console.warn('');
}

server.listen(CONFIG.port, () => {
  console.log(`Server running on http://0.0.0.0:${CONFIG.port}`);
  console.log(`Auth mode: ${CONFIG.skipAuth ? 'SKIP (development)' : 'ENABLED'}`);
  if (!CONFIG.skipAuth) {
    console.log(`Users configured: ${CONFIG.users.length}`);
    console.log(`Email verification: ${isEmailConfigured() ? 'ENABLED' : 'DISABLED'}`);
  }
});
