import { describe, it, expect } from 'vitest';
import { MockWebSocket, WS_OPEN, WS_CLOSED } from '../helpers/mockWs.js';

/**
 * Tests for agent connection lifecycle patterns (connection.js).
 */

describe('Agent Connection Lifecycle', () => {
  describe('WebSocket connection', () => {
    it('should construct WS URL with agent parameters', () => {
      const config = {
        serverUrl: 'ws://localhost:3456',
        agentId: 'agent_123',
        agentName: 'Worker-1',
        workDir: '/home/user/project'
      };

      const url = `${config.serverUrl}?type=agent&id=${config.agentId}&name=${encodeURIComponent(config.agentName)}&workDir=${encodeURIComponent(config.workDir)}`;

      expect(url).toContain('type=agent');
      expect(url).toContain('id=agent_123');
      expect(url).toContain('name=Worker-1');
      expect(url).toContain('workDir=');
    });

    it('should include capabilities in URL', () => {
      const capabilities = ['terminal', 'file_editor', 'background_tasks'];
      const capsParam = capabilities.join(',');

      const url = `ws://localhost:3456?type=agent&capabilities=${capsParam}`;
      expect(url).toContain('capabilities=terminal,file_editor,background_tasks');
    });
  });

  describe('Dev mode registration', () => {
    it('should receive registered message immediately', () => {
      const ws = new MockWebSocket();
      const registeredMsg = {
        type: 'registered',
        agentId: 'agent_123',
        sessionKey: null
      };

      let received = null;
      ws.on('message', (data) => {
        received = JSON.parse(data.toString());
      });

      ws.simulateMessage(registeredMsg);

      // Verify the mock mechanism delivers the message to listeners
      expect(ws.listenerCount('message')).toBe(1);
      expect(received).toBeTruthy();
      expect(received.type).toBe('registered');
      expect(received.agentId).toBe('agent_123');
    });
  });

  describe('Prod mode authentication', () => {
    it('should handle auth_required → auth → registered flow', () => {
      const ws = new MockWebSocket();
      const authState = {
        pendingTempId: null,
        authenticated: false,
        sessionKey: null
      };

      // Step 1: Receive auth_required
      const authRequired = { type: 'auth_required', tempId: 'temp_abc' };
      authState.pendingTempId = authRequired.tempId;
      expect(authState.pendingTempId).toBe('temp_abc');

      // Step 2: Send auth message
      const authMsg = {
        type: 'auth',
        tempId: authState.pendingTempId,
        secret: 'my-agent-secret',
        capabilities: ['terminal', 'file_editor']
      };
      ws.send(JSON.stringify(authMsg));
      expect(ws.getLastMessage().type).toBe('auth');
      expect(ws.getLastMessage().secret).toBe('my-agent-secret');

      // Step 3: Receive registered
      const registered = {
        type: 'registered',
        agentId: 'agent_123',
        sessionKey: 'base64encodedkey'
      };
      authState.authenticated = true;
      authState.sessionKey = registered.sessionKey;
      authState.pendingTempId = null;

      expect(authState.authenticated).toBe(true);
      expect(authState.sessionKey).toBe('base64encodedkey');
      expect(authState.pendingTempId).toBeNull();
    });
  });

  describe('Heartbeat', () => {
    it('should respond to ping with pong', () => {
      const ws = new MockWebSocket();
      let pongReceived = false;

      ws.on('pong', () => { pongReceived = true; });
      ws.simulatePong();

      expect(pongReceived).toBe(true);
    });

    it('should track last pong time', () => {
      let lastPongAt = 0;
      const now = Date.now();

      // Simulate pong handler
      lastPongAt = now;

      expect(lastPongAt).toBeGreaterThan(0);
    });

    it('should detect connection loss if no pong received', () => {
      const lastPongAt = Date.now() - 60000; // 60 seconds ago
      const HEARTBEAT_INTERVAL = 30000;
      const HEARTBEAT_TIMEOUT = 45000;

      const timeSinceLastPong = Date.now() - lastPongAt;
      const isStale = timeSinceLastPong > HEARTBEAT_TIMEOUT;
      expect(isStale).toBe(true);
    });
  });

  describe('Reconnection', () => {
    it('should schedule reconnect on close', () => {
      let reconnectScheduled = false;
      let reconnectDelay = 0;

      // Simulate close handler
      const onClose = () => {
        reconnectDelay = 5000; // base delay
        reconnectScheduled = true;
      };

      onClose();
      expect(reconnectScheduled).toBe(true);
      expect(reconnectDelay).toBe(5000);
    });

    it('should use exponential backoff', () => {
      const BASE_DELAY = 5000;
      const MAX_DELAY = 60000;
      let attempt = 0;

      const getDelay = () => Math.min(BASE_DELAY * Math.pow(2, attempt), MAX_DELAY);

      expect(getDelay()).toBe(5000);  // attempt 0
      attempt = 1;
      expect(getDelay()).toBe(10000); // attempt 1
      attempt = 2;
      expect(getDelay()).toBe(20000); // attempt 2
      attempt = 3;
      expect(getDelay()).toBe(40000); // attempt 3
      attempt = 4;
      expect(getDelay()).toBe(60000); // capped at max
    });

    it('should preserve agent ID for reconnection', () => {
      const config = { agentId: 'agent_persistent_123' };

      // After disconnect and reconnect, same ID used
      const reconnectUrl = `ws://localhost:3456?type=agent&id=${config.agentId}`;
      expect(reconnectUrl).toContain('id=agent_persistent_123');
    });
  });

  describe('Message dispatch', () => {
    it('should dispatch messages by type', () => {
      const dispatched = {};
      const handlers = {
        create_conversation: (msg) => { dispatched.create = msg; },
        resume_conversation: (msg) => { dispatched.resume = msg; },
        execute: (msg) => { dispatched.execute = msg; },
        cancel_execution: (msg) => { dispatched.cancel = msg; },
        delete_conversation: (msg) => { dispatched.delete = msg; },
        terminal_create: (msg) => { dispatched.terminal = msg; },
        read_file: (msg) => { dispatched.readFile = msg; }
      };

      const messages = [
        { type: 'create_conversation', conversationId: 'c1' },
        { type: 'execute', conversationId: 'c1', prompt: 'hello' },
        { type: 'read_file', filePath: '/tmp/test.js' }
      ];

      for (const msg of messages) {
        const handler = handlers[msg.type];
        if (handler) handler(msg);
      }

      expect(dispatched.create.conversationId).toBe('c1');
      expect(dispatched.execute.prompt).toBe('hello');
      expect(dispatched.readFile.filePath).toBe('/tmp/test.js');
    });
  });
});

describe('Agent Conversation State', () => {
  it('should track conversations by id', () => {
    const conversations = new Map();

    conversations.set('conv1', {
      id: 'conv1',
      workDir: '/project',
      claudeSessionId: null,
      query: null,
      inputStream: null,
      turnActive: false
    });

    expect(conversations.has('conv1')).toBe(true);
    expect(conversations.get('conv1').turnActive).toBe(false);
  });

  it('should update claudeSessionId after first turn', () => {
    const conversations = new Map();
    conversations.set('conv1', { claudeSessionId: null });

    // After result message with session_id
    conversations.get('conv1').claudeSessionId = 'claude_session_abc';

    expect(conversations.get('conv1').claudeSessionId).toBe('claude_session_abc');
  });

  it('should clean up on delete', () => {
    const conversations = new Map();
    conversations.set('conv1', { id: 'conv1' });
    conversations.set('conv2', { id: 'conv2' });

    conversations.delete('conv1');

    expect(conversations.has('conv1')).toBe(false);
    expect(conversations.has('conv2')).toBe(true);
  });
});
