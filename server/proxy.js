import { randomUUID } from 'crypto';
import { WebSocket, WebSocketServer } from 'ws';
import { agents, pendingProxyRequests, proxyWsConnections } from './context.js';
import { sendToAgent, findAgentByName } from './ws-utils.js';

export function registerProxyRoutes(app) {
  app.all('/agent/:agentName/:port/*', handleProxyRequest);
  app.all('/agent/:agentName/:port', handleProxyRequest);
}

async function handleProxyRequest(req, res) {
  // No JWT authentication for proxy routes — external services need direct access.
  // Access control is enforced by the port enable/disable mechanism in ProxyTab.

  const { agentName, port } = req.params;
  const portNum = parseInt(port);
  if (isNaN(portNum) || portNum < 1 || portNum > 65535) {
    return res.status(400).send('Invalid port');
  }

  const found = findAgentByName(agentName);
  if (!found || found.agent.ws.readyState !== WebSocket.OPEN) {
    return res.status(502).send('Agent not connected');
  }

  // Check if this port is enabled for proxy
  const proxyPorts = found.agent.proxyPorts || [];
  const portConfig = proxyPorts.find(p => p.port === portNum);
  if (!portConfig || !portConfig.enabled) {
    return res.status(403).send('Port not enabled for proxy');
  }

  // Handle CORS preflight — respond immediately without forwarding to agent
  if (req.method === 'OPTIONS') {
    const origin = req.headers.origin || '*';
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, PATCH, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', req.headers['access-control-request-headers'] || 'Content-Type, Authorization');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Max-Age', '86400');
    return res.status(204).end();
  }

  const requestId = randomUUID();
  const requestOrigin = req.headers.origin || null;

  // Collect raw body
  const bodyChunks = [];
  req.on('data', chunk => bodyChunks.push(chunk));
  req.on('end', async () => {
    const body = Buffer.concat(bodyChunks);

    // Build proxy path: strip /agent/:name/:port prefix
    const proxyPath = req.params[0] ? ('/' + req.params[0]) : '/';
    const queryString = req.url.includes('?') ? req.url.substring(req.url.indexOf('?')) : '';

    // Clean headers for forwarding
    const fwdHeaders = { ...req.headers };
    delete fwdHeaders['host'];
    const proxyHost = portConfig.host || 'localhost';
    fwdHeaders['host'] = `${proxyHost}:${portNum}`;
    delete fwdHeaders['connection'];

    await sendToAgent(found.agent, {
      type: 'proxy_request',
      requestId,
      port: portNum,
      host: portConfig.host || 'localhost',
      scheme: portConfig.scheme || 'http',
      basePath: `/agent/${agentName}/${portNum}`,
      method: req.method,
      path: proxyPath + queryString,
      headers: fwdHeaders,
      body: body.length > 0 ? body.toString('base64') : null
    });

    const timeout = setTimeout(() => {
      pendingProxyRequests.delete(requestId);
      if (!res.headersSent) res.status(504).send('Proxy timeout');
    }, 60000);

    pendingProxyRequests.set(requestId, { res, timeout, streaming: false, origin: requestOrigin });
  });

  req.on('error', () => {
    pendingProxyRequests.delete(requestId);
  });
}

// Overwrite CORS headers so browser accepts proxied responses
function applyCorsHeaders(headers, origin) {
  if (origin) {
    headers['access-control-allow-origin'] = origin;
    headers['access-control-allow-credentials'] = 'true';
  }
}

// Handle proxy response messages from agent
export function handleProxyResponse(msg) {
  const pending = pendingProxyRequests.get(msg.requestId);
  if (!pending) return;
  clearTimeout(pending.timeout);
  pendingProxyRequests.delete(msg.requestId);

  const headers = msg.headers || {};
  delete headers['transfer-encoding'];
  delete headers['connection'];
  applyCorsHeaders(headers, pending.origin);

  try {
    pending.res.status(msg.statusCode || 500);
    for (const [k, v] of Object.entries(headers)) {
      try { pending.res.setHeader(k, v); } catch(e) {}
    }
    if (msg.body) {
      pending.res.end(Buffer.from(msg.body, 'base64'));
    } else {
      pending.res.end();
    }
  } catch(e) {
    console.error('[Proxy] Error sending response:', e.message);
  }
}

export function handleProxyResponseChunk(msg) {
  const pending = pendingProxyRequests.get(msg.requestId);
  if (!pending) return;

  try {
    if (!pending.streaming) {
      pending.streaming = true;
      clearTimeout(pending.timeout);
      // Set a longer timeout for streaming responses
      pending.timeout = setTimeout(() => {
        pendingProxyRequests.delete(msg.requestId);
        try { pending.res.end(); } catch(e) {}
      }, 300000); // 5 minutes for streaming

      pending.res.status(msg.statusCode || 200);
      const headers = msg.headers || {};
      delete headers['transfer-encoding'];
      delete headers['connection'];
      applyCorsHeaders(headers, pending.origin);
      for (const [k, v] of Object.entries(headers)) {
        try { pending.res.setHeader(k, v); } catch(e) {}
      }
      pending.res.setHeader('X-Accel-Buffering', 'no');
      pending.res.flushHeaders();
    }

    if (msg.chunk) {
      pending.res.write(Buffer.from(msg.chunk, 'base64'));
    }
  } catch(e) {
    console.error('[Proxy] Error writing chunk:', e.message);
    pendingProxyRequests.delete(msg.requestId);
  }
}

export function handleProxyResponseEnd(msg) {
  const pending = pendingProxyRequests.get(msg.requestId);
  if (!pending) return;
  clearTimeout(pending.timeout);
  pendingProxyRequests.delete(msg.requestId);
  try { pending.res.end(); } catch(e) {}
}

// Handle proxy WebSocket messages from agent to browser
export function handleProxyWsAgentMessage(msg) {
  const conn = proxyWsConnections.get(msg.proxyWsId);
  if (!conn || !conn.browserWs) return;

  switch (msg.type) {
    case 'proxy_ws_opened':
      break;
    case 'proxy_ws_message':
      try {
        if (msg.isBinary) {
          conn.browserWs.send(Buffer.from(msg.data, 'base64'));
        } else {
          conn.browserWs.send(msg.data);
        }
      } catch(e) {}
      break;
    case 'proxy_ws_closed':
      try { conn.browserWs.close(msg.code || 1000); } catch(e) {}
      proxyWsConnections.delete(msg.proxyWsId);
      break;
    case 'proxy_ws_error':
      try { conn.browserWs.close(1011, msg.error); } catch(e) {}
      proxyWsConnections.delete(msg.proxyWsId);
      break;
  }
}

// Handle WebSocket upgrade for proxy connections
export async function handleProxyWebSocketUpgrade(req, socket, head, match) {
  const agentName = match[1];
  const port = parseInt(match[2]);
  const path = match[3] || '/';

  const found = findAgentByName(agentName);
  if (!found || found.agent.ws.readyState !== WebSocket.OPEN) {
    socket.destroy();
    return;
  }

  // Check if port is enabled
  const proxyPorts = found.agent.proxyPorts || [];
  const portConfig = proxyPorts.find(p => p.port === port);
  if (!portConfig || !portConfig.enabled) {
    socket.destroy();
    return;
  }

  // Create a temporary WSS for this upgrade
  const proxyWss = new WebSocketServer({ noServer: true });
  proxyWss.handleUpgrade(req, socket, head, async (browserWs) => {
    const proxyWsId = randomUUID();

    proxyWsConnections.set(proxyWsId, {
      browserWs,
      agentId: found.id
    });

    // Forward browser messages to agent
    browserWs.on('message', async (data, isBinary) => {
      await sendToAgent(found.agent, {
        type: 'proxy_ws_message',
        proxyWsId,
        data: isBinary ? data.toString('base64') : data.toString(),
        isBinary
      });
    });

    browserWs.on('close', async (code) => {
      proxyWsConnections.delete(proxyWsId);
      await sendToAgent(found.agent, {
        type: 'proxy_ws_close',
        proxyWsId,
        code
      });
    });

    browserWs.on('error', () => {
      proxyWsConnections.delete(proxyWsId);
    });

    // Tell agent to open WS connection to localhost:port
    const fwdHeaders = { ...req.headers };
    delete fwdHeaders['host'];
    delete fwdHeaders['upgrade'];
    delete fwdHeaders['connection'];
    delete fwdHeaders['sec-websocket-key'];
    delete fwdHeaders['sec-websocket-version'];
    delete fwdHeaders['sec-websocket-extensions'];

    await sendToAgent(found.agent, {
      type: 'proxy_ws_open',
      proxyWsId,
      port,
      host: portConfig.host || 'localhost',
      scheme: portConfig.scheme || 'http',
      path,
      headers: fwdHeaders
    });
  });
}
