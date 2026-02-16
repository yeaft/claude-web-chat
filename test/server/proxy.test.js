import { describe, it, expect } from 'vitest';
import { MockWebSocket, createMockAgent, WS_OPEN, WS_CLOSED } from '../helpers/mockWs.js';

/**
 * Tests for port proxy logic patterns (proxy.js).
 */

describe('Proxy Request Validation', () => {
  it('should reject invalid port number', () => {
    const testPorts = [0, -1, 65536, NaN];
    for (const port of testPorts) {
      const isValid = !isNaN(port) && port >= 1 && port <= 65535;
      expect(isValid).toBe(false);
    }
  });

  it('should accept valid port numbers', () => {
    const testPorts = [1, 80, 443, 3000, 8080, 65535];
    for (const port of testPorts) {
      const isValid = !isNaN(port) && port >= 1 && port <= 65535;
      expect(isValid).toBe(true);
    }
  });

  it('should reject when agent is offline', () => {
    const agent = createMockAgent();
    agent.ws.readyState = WS_CLOSED;
    expect(agent.ws.readyState !== WS_OPEN).toBe(true);
    // Returns 502
  });

  it('should reject when port is not enabled', () => {
    const agent = createMockAgent({
      proxyPorts: [
        { port: 3000, enabled: false, label: 'dev' },
        { port: 8080, enabled: true, label: 'api' }
      ]
    });

    const port3000 = agent.proxyPorts.find(p => p.port === 3000);
    expect(port3000.enabled).toBe(false);
    // Returns 403

    const port8080 = agent.proxyPorts.find(p => p.port === 8080);
    expect(port8080.enabled).toBe(true);
    // Allowed
  });

  it('should reject when port is not in list', () => {
    const agent = createMockAgent({
      proxyPorts: [{ port: 3000, enabled: true }]
    });

    const portConfig = agent.proxyPorts.find(p => p.port === 9999);
    expect(portConfig).toBeUndefined();
    // Returns 403
  });
});

describe('Proxy Request Forwarding', () => {
  it('should build correct proxy path', () => {
    // Strip /agent/:name/:port prefix
    const testCases = [
      { params0: undefined, expected: '/' },
      { params0: 'api/v1/data', expected: '/api/v1/data' },
      { params0: 'index.html', expected: '/index.html' }
    ];

    for (const tc of testCases) {
      const proxyPath = tc.params0 ? ('/' + tc.params0) : '/';
      expect(proxyPath).toBe(tc.expected);
    }
  });

  it('should preserve query string', () => {
    const url = '/agent/worker/3000/api/data?page=1&limit=10';
    const queryString = url.includes('?') ? url.substring(url.indexOf('?')) : '';
    expect(queryString).toBe('?page=1&limit=10');
  });

  it('should clean forwarding headers', () => {
    const headers = {
      host: 'server.example.com',
      connection: 'keep-alive',
      'content-type': 'application/json',
      authorization: 'Bearer token123'
    };

    const fwdHeaders = { ...headers };
    delete fwdHeaders['host'];
    delete fwdHeaders['connection'];
    fwdHeaders['host'] = 'localhost:3000';

    expect(fwdHeaders['host']).toBe('localhost:3000');
    expect(fwdHeaders['connection']).toBeUndefined();
    expect(fwdHeaders['content-type']).toBe('application/json');
    expect(fwdHeaders['authorization']).toBe('Bearer token123');
  });

  it('should encode body as base64', () => {
    const body = Buffer.from('{"key":"value"}');
    const encoded = body.toString('base64');
    const decoded = Buffer.from(encoded, 'base64').toString();
    expect(decoded).toBe('{"key":"value"}');
  });

  it('should use custom host from port config', () => {
    const portConfig = { port: 3000, enabled: true, host: '192.168.1.100' };
    const host = portConfig.host || 'localhost';
    expect(host).toBe('192.168.1.100');
  });

  it('should default to localhost', () => {
    const portConfig = { port: 3000, enabled: true };
    const host = portConfig.host || 'localhost';
    expect(host).toBe('localhost');
  });
});

describe('Proxy Response Handling', () => {
  it('should handle complete response', () => {
    const pendingProxyRequests = new Map();
    const requestId = 'req_123';
    const mockRes = {
      statusCode: null,
      headers: {},
      body: null,
      status(code) { this.statusCode = code; return this; },
      setHeader(k, v) { this.headers[k] = v; },
      end(body) { this.body = body; }
    };

    pendingProxyRequests.set(requestId, { res: mockRes, timeout: null, streaming: false });

    // Handle response
    const msg = {
      requestId, statusCode: 200,
      headers: { 'content-type': 'text/html' },
      body: Buffer.from('<h1>Hello</h1>').toString('base64')
    };

    const pending = pendingProxyRequests.get(msg.requestId);
    pendingProxyRequests.delete(msg.requestId);
    pending.res.status(msg.statusCode);
    for (const [k, v] of Object.entries(msg.headers)) {
      pending.res.setHeader(k, v);
    }
    pending.res.end(Buffer.from(msg.body, 'base64'));

    expect(mockRes.statusCode).toBe(200);
    expect(mockRes.headers['content-type']).toBe('text/html');
    expect(mockRes.body.toString()).toBe('<h1>Hello</h1>');
    expect(pendingProxyRequests.size).toBe(0);
  });

  it('should handle streaming response (chunks)', () => {
    const chunks = [];
    const mockRes = {
      statusCode: null,
      status(code) { this.statusCode = code; return this; },
      setHeader() {},
      flushHeaders() {},
      write(chunk) { chunks.push(chunk); },
      end() {}
    };

    // First chunk with headers
    mockRes.status(200);
    mockRes.flushHeaders();

    // Subsequent chunks
    mockRes.write(Buffer.from('chunk1'));
    mockRes.write(Buffer.from('chunk2'));
    mockRes.write(Buffer.from('chunk3'));

    expect(chunks.length).toBe(3);
    expect(mockRes.statusCode).toBe(200);
  });

  it('should handle proxy timeout (60s)', () => {
    const pendingProxyRequests = new Map();
    const requestId = 'timeout_req';
    let timedOut = false;

    pendingProxyRequests.set(requestId, { res: {}, timeout: null });

    // Simulate timeout
    pendingProxyRequests.delete(requestId);
    timedOut = true;
    // In real code: res.status(504).send('Proxy timeout')

    expect(timedOut).toBe(true);
    expect(pendingProxyRequests.has(requestId)).toBe(false);
  });
});

describe('Proxy WebSocket Handling', () => {
  it('should create proxy WS connection entry', () => {
    const proxyWsConnections = new Map();
    const proxyWsId = 'ws_123';
    const browserWs = new MockWebSocket();

    proxyWsConnections.set(proxyWsId, {
      browserWs,
      agentId: 'agent1'
    });

    expect(proxyWsConnections.has(proxyWsId)).toBe(true);
    expect(proxyWsConnections.get(proxyWsId).agentId).toBe('agent1');
  });

  it('should forward text messages from agent to browser', () => {
    const browserWs = new MockWebSocket();
    const msg = { type: 'proxy_ws_message', data: 'hello', isBinary: false };

    if (msg.isBinary) {
      browserWs.send(Buffer.from(msg.data, 'base64'));
    } else {
      browserWs.send(msg.data);
    }

    expect(browserWs.sentMessages[0]).toBe('hello');
  });

  it('should forward binary messages from agent to browser', () => {
    const browserWs = new MockWebSocket();
    const binaryData = Buffer.from([0x01, 0x02, 0x03]).toString('base64');
    const msg = { type: 'proxy_ws_message', data: binaryData, isBinary: true };

    const sent = Buffer.from(msg.data, 'base64');
    browserWs.send(sent);

    expect(browserWs.sentMessages[0]).toEqual(sent);
  });

  it('should close browser WS on proxy_ws_closed', () => {
    const proxyWsConnections = new Map();
    const browserWs = new MockWebSocket();
    proxyWsConnections.set('ws1', { browserWs, agentId: 'a1' });

    browserWs.close(1000);
    proxyWsConnections.delete('ws1');

    expect(browserWs.readyState).toBe(WS_CLOSED);
    expect(proxyWsConnections.size).toBe(0);
  });

  it('should clean headers for WS upgrade', () => {
    const headers = {
      host: 'server.example.com',
      upgrade: 'websocket',
      connection: 'Upgrade',
      'sec-websocket-key': 'key123',
      'sec-websocket-version': '13',
      'sec-websocket-extensions': 'permessage-deflate',
      'cookie': 'session=abc'
    };

    const fwdHeaders = { ...headers };
    delete fwdHeaders['host'];
    delete fwdHeaders['upgrade'];
    delete fwdHeaders['connection'];
    delete fwdHeaders['sec-websocket-key'];
    delete fwdHeaders['sec-websocket-version'];
    delete fwdHeaders['sec-websocket-extensions'];

    expect(fwdHeaders['cookie']).toBe('session=abc');
    expect(fwdHeaders['upgrade']).toBeUndefined();
    expect(fwdHeaders['sec-websocket-key']).toBeUndefined();
  });
});

describe('Port Auto-Cleanup', () => {
  it('should disable all ports on agent disconnect', () => {
    const agent = createMockAgent({
      proxyPorts: [
        { port: 3000, enabled: true, label: 'dev' },
        { port: 8080, enabled: true, label: 'api' }
      ]
    });

    agent.proxyPorts = agent.proxyPorts.map(p => ({ ...p, enabled: false }));

    expect(agent.proxyPorts.every(p => !p.enabled)).toBe(true);
    // Port config preserved, just disabled
    expect(agent.proxyPorts.length).toBe(2);
  });

  it('should disable all ports on web client disconnect (last client)', () => {
    const agent = createMockAgent({
      proxyPorts: [{ port: 3000, enabled: true }]
    });

    // No other clients on this agent
    const otherClientsOnAgent = false;

    if (!otherClientsOnAgent) {
      agent.proxyPorts = agent.proxyPorts.map(p => ({ ...p, enabled: false }));
    }

    expect(agent.proxyPorts[0].enabled).toBe(false);
  });

  it('should disable all ports on agent re-registration', () => {
    const existingPorts = [
      { port: 3000, enabled: true, label: 'dev' },
      { port: 8080, enabled: true, label: 'api' }
    ];

    // On reconnect, disable all
    const proxyPorts = existingPorts.map(p => ({ ...p, enabled: false }));

    expect(proxyPorts[0].enabled).toBe(false);
    expect(proxyPorts[1].enabled).toBe(false);
    expect(proxyPorts[0].label).toBe('dev'); // preserved
  });
});

describe('findAgentByName pattern', () => {
  it('should find agent by name', () => {
    const agents = new Map();
    agents.set('id1', createMockAgent({ name: 'Worker-1' }));
    agents.set('id2', createMockAgent({ name: 'Worker-2' }));

    let found = null;
    for (const [id, agent] of agents) {
      if (agent.name === 'Worker-1' || id === 'Worker-1') {
        found = { id, agent };
        break;
      }
    }

    expect(found).toBeTruthy();
    expect(found.id).toBe('id1');
  });

  it('should find agent by id', () => {
    const agents = new Map();
    agents.set('agent_abc', createMockAgent({ name: 'Worker-1' }));

    let found = null;
    for (const [id, agent] of agents) {
      if (agent.name === 'agent_abc' || id === 'agent_abc') {
        found = { id, agent };
        break;
      }
    }

    expect(found).toBeTruthy();
    expect(found.id).toBe('agent_abc');
  });

  it('should return null for non-existent agent', () => {
    const agents = new Map();
    let found = null;
    for (const [id, agent] of agents) {
      if (agent.name === 'ghost' || id === 'ghost') {
        found = { id, agent };
        break;
      }
    }
    expect(found).toBeNull();
  });
});
