/**
 * Mock WebSocket for testing WS message handlers.
 */
import { EventEmitter } from 'events';

export const WS_OPEN = 1;
export const WS_CLOSED = 3;

export class MockWebSocket extends EventEmitter {
  constructor(readyState = WS_OPEN) {
    super();
    this.readyState = readyState;
    this.sentMessages = [];
    this.closeCode = null;
    this.closeReason = null;
    this._pingCount = 0;
  }

  send(data) {
    if (this.readyState !== WS_OPEN) return;
    this.sentMessages.push(data);
  }

  close(code, reason) {
    this.readyState = WS_CLOSED;
    this.closeCode = code;
    this.closeReason = reason;
    this.emit('close', code, reason);
  }

  ping() {
    this._pingCount++;
  }

  terminate() {
    this.readyState = WS_CLOSED;
    this.emit('close');
  }

  // Simulate receiving a message
  simulateMessage(msg) {
    const data = typeof msg === 'string' ? msg : JSON.stringify(msg);
    this.emit('message', Buffer.from(data));
  }

  // Simulate pong response
  simulatePong() {
    this.emit('pong');
  }

  // Get all sent messages as parsed JSON
  getSentMessages() {
    return this.sentMessages.map(d => {
      try { return JSON.parse(d); }
      catch { return d; }
    });
  }

  // Get last sent message as parsed JSON
  getLastMessage() {
    if (this.sentMessages.length === 0) return null;
    try { return JSON.parse(this.sentMessages[this.sentMessages.length - 1]); }
    catch { return this.sentMessages[this.sentMessages.length - 1]; }
  }

  // Clear sent message history
  clearMessages() {
    this.sentMessages = [];
  }
}

/**
 * Create a mock agent entry for context.agents Map
 */
export function createMockAgent(overrides = {}) {
  return {
    ws: new MockWebSocket(),
    name: overrides.name || 'test-agent',
    workDir: overrides.workDir || '/tmp/test',
    conversations: overrides.conversations || new Map(),
    sessionKey: overrides.sessionKey || null,
    isAlive: true,
    capabilities: overrides.capabilities || ['terminal', 'file_editor', 'background_tasks'],
    proxyPorts: overrides.proxyPorts || [],
    status: overrides.status || 'ready',
    ownerId: overrides.ownerId ?? null,
    ownerUsername: overrides.ownerUsername ?? null,
    latency: overrides.latency ?? null,
    ...overrides
  };
}

/**
 * Create a mock web client entry for context.webClients Map
 */
export function createMockWebClient(overrides = {}) {
  return {
    ws: new MockWebSocket(),
    authenticated: overrides.authenticated ?? true,
    username: overrides.username || 'test-user',
    userId: overrides.userId || 'user_test_123',
    role: overrides.role || 'admin',
    currentAgent: overrides.currentAgent || null,
    currentConversation: overrides.currentConversation || null,
    sessionKey: overrides.sessionKey || null,
    isAlive: true,
    ...overrides
  };
}
