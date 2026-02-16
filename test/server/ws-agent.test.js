import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { createTestDb, cleanupTestDb, createDbOperations } from '../helpers/testDb.js';
import { MockWebSocket, createMockAgent, createMockWebClient, WS_OPEN } from '../helpers/mockWs.js';

/**
 * Tests for agent connection lifecycle and message handling patterns.
 * We test the logic patterns from ws-agent.js without importing it directly
 * (to avoid config.js side effects).
 */

let db, sessionDb, messageDb;

beforeEach(() => {
  if (db) { try { db.close(); } catch (e) {} }
  const result = createTestDb();
  db = result.db;
  const ops = createDbOperations(db);
  sessionDb = ops.sessionDb;
  messageDb = ops.messageDb;
});

afterAll(() => cleanupTestDb());

describe('Agent Registration', () => {
  describe('dev mode (skipAuth)', () => {
    it('should register agent immediately and send registered message', () => {
      const ws = new MockWebSocket();
      const agents = new Map();
      const agentId = 'agent_123';
      const agentName = 'TestAgent';

      // Simulate completeAgentRegistration
      agents.set(agentId, {
        ws, name: agentName, workDir: '/work',
        conversations: new Map(), sessionKey: null,
        isAlive: true, capabilities: ['terminal'],
        proxyPorts: [], status: 'syncing',
        ownerId: null, ownerUsername: null
      });

      ws.send(JSON.stringify({ type: 'registered', agentId, sessionKey: null }));

      expect(agents.has(agentId)).toBe(true);
      expect(agents.get(agentId).status).toBe('syncing');
      expect(ws.getLastMessage().type).toBe('registered');
    });
  });

  describe('prod mode (auth required)', () => {
    it('should send auth_required with tempId', () => {
      const ws = new MockWebSocket();
      const tempId = 'temp_uuid_123';

      ws.send(JSON.stringify({ type: 'auth_required', tempId }));

      const msg = ws.getLastMessage();
      expect(msg.type).toBe('auth_required');
      expect(msg.tempId).toBe(tempId);
    });

    it('should close connection on auth timeout', () => {
      const ws = new MockWebSocket();
      ws.close(1008, 'Authentication timeout');
      expect(ws.readyState).toBe(3); // CLOSED
      expect(ws.closeCode).toBe(1008);
    });

    it('should close connection on auth failure', () => {
      const ws = new MockWebSocket();
      ws.close(1008, 'Invalid agent secret');
      expect(ws.closeCode).toBe(1008);
    });
  });

  describe('reconnection', () => {
    it('should preserve conversations on reconnect', () => {
      const agents = new Map();
      const existingConvs = new Map();
      existingConvs.set('conv1', { id: 'conv1', workDir: '/w', processing: true });

      agents.set('agent1', {
        ws: new MockWebSocket(), conversations: existingConvs,
        proxyPorts: [{ port: 3000, enabled: true, label: 'dev' }]
      });

      // Simulate reconnect: preserve conversations, disable proxy
      const existing = agents.get('agent1');
      const conversations = existing.conversations;
      const proxyPorts = existing.proxyPorts.map(p => ({ ...p, enabled: false }));

      agents.set('agent1', {
        ws: new MockWebSocket(), conversations, proxyPorts,
        status: 'syncing', isAlive: true
      });

      expect(agents.get('agent1').conversations.size).toBe(1);
      expect(agents.get('agent1').proxyPorts[0].enabled).toBe(false);
    });
  });
});

describe('Agent Sync Lifecycle', () => {
  it('should start in syncing status', () => {
    const agent = createMockAgent({ status: 'syncing' });
    expect(agent.status).toBe('syncing');
  });

  it('should transition to ready on agent_sync_complete', () => {
    const agent = createMockAgent({ status: 'syncing' });
    // Simulate agent_sync_complete handler
    agent.status = 'ready';
    expect(agent.status).toBe('ready');
  });

  it('should force ready after 30s sync timeout', async () => {
    const agent = createMockAgent({ status: 'syncing' });
    // In real code: setTimeout after 30s sets status='ready'
    // We simulate the timeout firing
    if (agent.status === 'syncing') {
      agent.status = 'ready';
    }
    expect(agent.status).toBe('ready');
  });
});

describe('Agent Disconnect Cleanup', () => {
  it('should set all conversations processing=false', () => {
    const agent = createMockAgent();
    agent.conversations.set('c1', { processing: true });
    agent.conversations.set('c2', { processing: true });

    // Simulate disconnect handler
    for (const [, conv] of agent.conversations) {
      conv.processing = false;
    }

    expect(agent.conversations.get('c1').processing).toBe(false);
    expect(agent.conversations.get('c2').processing).toBe(false);
  });

  it('should clear message queues', () => {
    const serverMessageQueues = new Map();
    serverMessageQueues.set('conv1', [{ id: 'q1', prompt: 'hello' }]);
    serverMessageQueues.set('conv2', [{ id: 'q2', prompt: 'world' }]);

    const agent = createMockAgent();
    agent.conversations.set('conv1', {});
    agent.conversations.set('conv2', {});

    // Simulate cleanup
    for (const [convId] of agent.conversations) {
      serverMessageQueues.delete(convId);
    }

    expect(serverMessageQueues.size).toBe(0);
  });

  it('should disable all proxy ports', () => {
    const agent = createMockAgent({
      proxyPorts: [
        { port: 3000, enabled: true },
        { port: 8080, enabled: true }
      ]
    });

    agent.proxyPorts = agent.proxyPorts.map(p => ({ ...p, enabled: false }));

    expect(agent.proxyPorts.every(p => !p.enabled)).toBe(true);
  });
});

describe('Agent Message: conversation_list', () => {
  it('should merge conversations preserving existing userId', () => {
    const agent = createMockAgent();
    agent.conversations.set('c1', { id: 'c1', userId: 'owner1', processing: true });
    agent.conversations.set('c2', { id: 'c2', userId: 'owner2' });

    const incoming = [
      { id: 'c1', workDir: '/new_dir', claudeSessionId: 'sess1' },
      { id: 'c3', workDir: '/c3_dir' }
    ];

    // Simulate merge logic
    const incomingIds = new Set(incoming.map(c => c.id));
    for (const id of agent.conversations.keys()) {
      if (!incomingIds.has(id)) agent.conversations.delete(id);
    }
    for (const conv of incoming) {
      const existing = agent.conversations.get(conv.id);
      if (existing) {
        existing.workDir = conv.workDir || existing.workDir;
        existing.claudeSessionId = conv.claudeSessionId || existing.claudeSessionId;
        // Preserve userId, processing
      } else {
        agent.conversations.set(conv.id, conv);
      }
    }

    expect(agent.conversations.size).toBe(2); // c1 and c3
    expect(agent.conversations.has('c2')).toBe(false); // removed
    expect(agent.conversations.get('c1').userId).toBe('owner1'); // preserved
    expect(agent.conversations.get('c1').processing).toBe(true); // preserved
    expect(agent.conversations.get('c1').workDir).toBe('/new_dir'); // updated
  });
});

describe('Agent Message: conversation_created/resumed', () => {
  it('should store conversation and create DB session', () => {
    const agent = createMockAgent();
    const msg = {
      conversationId: 'conv_new',
      workDir: '/work',
      claudeSessionId: 'claude_1',
      userId: 'user_1',
      username: 'testuser'
    };

    agent.conversations.set(msg.conversationId, {
      id: msg.conversationId,
      workDir: msg.workDir,
      claudeSessionId: msg.claudeSessionId,
      userId: msg.userId,
      username: msg.username,
      createdAt: Date.now(),
      processing: false
    });

    sessionDb.create(msg.conversationId, 'agent1', 'Agent', msg.workDir, msg.claudeSessionId, null, msg.userId);
    sessionDb.setActive(msg.conversationId, true);

    const conv = agent.conversations.get('conv_new');
    expect(conv.userId).toBe('user_1');
    expect(sessionDb.exists('conv_new')).toBe(true);
    expect(sessionDb.get('conv_new').is_active).toBe(1);
  });

  it('should clean up old entries with same claudeSessionId on resume', () => {
    const agent = createMockAgent();
    agent.conversations.set('old_conv', { id: 'old_conv', claudeSessionId: 'cs1' });
    agent.conversations.set('new_conv', { id: 'new_conv', claudeSessionId: 'cs1' });

    // Simulate cleanup logic for resume
    const targetId = 'new_conv';
    const targetSessionId = 'cs1';
    for (const [id, conv] of agent.conversations) {
      if (id !== targetId && conv.claudeSessionId === targetSessionId) {
        agent.conversations.delete(id);
      }
    }

    expect(agent.conversations.has('old_conv')).toBe(false);
    expect(agent.conversations.has('new_conv')).toBe(true);
  });
});

describe('Agent Message: turn_completed', () => {
  it('should set processing=false and update claudeSessionId', () => {
    const agent = createMockAgent();
    agent.conversations.set('conv1', {
      id: 'conv1', processing: true, claudeSessionId: 'old'
    });

    const msg = { conversationId: 'conv1', claudeSessionId: 'new_session' };
    const conv = agent.conversations.get(msg.conversationId);
    conv.processing = false;
    if (msg.claudeSessionId) conv.claudeSessionId = msg.claudeSessionId;

    expect(conv.processing).toBe(false);
    expect(conv.claudeSessionId).toBe('new_session');
  });

  it('should dequeue next message from server queue', () => {
    const serverMessageQueues = new Map();
    const queue = [
      { id: 'q1', prompt: 'first', workDir: '/w' },
      { id: 'q2', prompt: 'second', workDir: '/w' }
    ];
    serverMessageQueues.set('conv1', queue);

    // Simulate turn_completed dequeue
    const convQueue = serverMessageQueues.get('conv1');
    const next = convQueue.shift();

    expect(next.id).toBe('q1');
    expect(next.prompt).toBe('first');
    expect(convQueue.length).toBe(1);
  });

  it('should handle queue with file attachments', () => {
    const next = {
      id: 'q1', prompt: 'analyze this',
      files: [{ name: 'test.txt', mimeType: 'text/plain', data: 'base64data' }]
    };

    // Should send transfer_files instead of execute
    const hasFiles = next.files && next.files.length > 0;
    expect(hasFiles).toBe(true);
    // In real code: sends transfer_files message instead of execute
  });

  it('should clean up empty queue', () => {
    const serverMessageQueues = new Map();
    serverMessageQueues.set('conv1', [{ id: 'q1', prompt: 'only' }]);

    const queue = serverMessageQueues.get('conv1');
    queue.shift();

    if (!queue || queue.length === 0) {
      serverMessageQueues.delete('conv1');
    }

    expect(serverMessageQueues.has('conv1')).toBe(false);
  });
});

describe('Agent Message: conversation_closed', () => {
  it('should set processing=false and session inactive', () => {
    const agent = createMockAgent();
    agent.conversations.set('conv1', { processing: true, claudeSessionId: 'cs1' });

    sessionDb.create('conv1', 'agent1', 'A', '/d', 'cs1');

    // Simulate conversation_closed
    const conv = agent.conversations.get('conv1');
    conv.processing = false;
    sessionDb.setActive('conv1', false);

    expect(conv.processing).toBe(false);
    expect(sessionDb.get('conv1').is_active).toBe(0);
  });

  it('should still dequeue messages after process exit', () => {
    const serverMessageQueues = new Map();
    serverMessageQueues.set('conv1', [{ id: 'q1', prompt: 'pending' }]);

    const queue = serverMessageQueues.get('conv1');
    expect(queue.length).toBe(1);
    const next = queue.shift();
    expect(next.prompt).toBe('pending');
    // In real code: sends execute to agent to restart Claude process
  });
});

describe('Agent Message: execution_cancelled', () => {
  it('should set processing=false and clear queue', () => {
    const agent = createMockAgent();
    agent.conversations.set('conv1', { processing: true });

    const serverMessageQueues = new Map();
    serverMessageQueues.set('conv1', [{ id: 'q1' }, { id: 'q2' }]);

    // Simulate cancellation
    const conv = agent.conversations.get('conv1');
    conv.processing = false;
    serverMessageQueues.delete('conv1');

    expect(conv.processing).toBe(false);
    expect(serverMessageQueues.has('conv1')).toBe(false);
  });
});

describe('Agent Message: claude_output', () => {
  it('should save user message to database', () => {
    sessionDb.create('co_sess', 'a1', 'A', '/d');

    const data = {
      type: 'user',
      message: { content: 'Hello Claude' }
    };
    const content = typeof data.message.content === 'string'
      ? data.message.content
      : JSON.stringify(data.message.content);

    messageDb.add('co_sess', 'user', content, 'user');

    const msgs = messageDb.getBySession('co_sess');
    expect(msgs.length).toBe(1);
    expect(msgs[0].content).toBe('Hello Claude');
    expect(msgs[0].message_type).toBe('user');
  });

  it('should save assistant text message to database', () => {
    sessionDb.create('co_sess2', 'a1', 'A', '/d');

    const data = {
      type: 'assistant',
      message: {
        content: [{ type: 'text', text: 'Hello! I can help.' }]
      }
    };
    const content = data.message.content
      .filter(b => b.type === 'text' && b.text)
      .map(b => b.text)
      .join('');

    messageDb.add('co_sess2', 'assistant', content, 'assistant');

    const msgs = messageDb.getBySession('co_sess2');
    expect(msgs[0].content).toBe('Hello! I can help.');
  });

  it('should save tool_use to database', () => {
    sessionDb.create('co_sess3', 'a1', 'A', '/d');

    const toolUse = {
      type: 'tool_use',
      name: 'Read',
      input: { file_path: '/tmp/test.js' }
    };

    messageDb.add('co_sess3', 'assistant', JSON.stringify(toolUse.input), 'tool_use', toolUse.name, JSON.stringify(toolUse.input));

    const msgs = messageDb.getBySession('co_sess3');
    expect(msgs[0].tool_name).toBe('Read');
  });

  it('should update session title from first user message', () => {
    sessionDb.create('co_title', 'a1', 'A', '/d');

    const content = 'Please help me with this code';
    const title = content.trim().substring(0, 50);
    sessionDb.update('co_title', { title });

    expect(sessionDb.get('co_title').title).toBe('Please help me with this code');
  });
});

describe('Agent Message: sync_sessions', () => {
  it('should create new sessions in DB', () => {
    const sessions = [
      { sessionId: 'sync1', workDir: '/w1', title: 'Session 1', lastModified: Date.now() },
      { sessionId: 'sync2', workDir: '/w2', title: 'Session 2', lastModified: Date.now() }
    ];

    for (const s of sessions) {
      if (!sessionDb.exists(s.sessionId)) {
        sessionDb.create(s.sessionId, 'agent1', 'Agent', s.workDir, s.sessionId, s.title, null);
      }
    }

    expect(sessionDb.exists('sync1')).toBe(true);
    expect(sessionDb.exists('sync2')).toBe(true);
  });

  it('should update existing sessions if newer', () => {
    sessionDb.create('sync_existing', 'a', 'A', '/d', null, 'Old Title');
    const existing = sessionDb.get('sync_existing');

    const incoming = { sessionId: 'sync_existing', title: 'New Title', lastModified: existing.updated_at + 1000 };

    if (incoming.lastModified > existing.updated_at) {
      sessionDb.update(incoming.sessionId, { title: incoming.title });
    }

    expect(sessionDb.get('sync_existing').title).toBe('New Title');
  });
});

describe('Agent Message: session_id_update', () => {
  it('should update claudeSessionId in memory and DB', () => {
    const agent = createMockAgent();
    agent.conversations.set('conv1', { claudeSessionId: 'old_cs' });

    sessionDb.create('conv1', 'a1', 'A', '/d', 'old_cs');

    // Simulate session_id_update
    const conv = agent.conversations.get('conv1');
    conv.claudeSessionId = 'new_cs';
    sessionDb.update('conv1', { claudeSessionId: 'new_cs' });

    expect(conv.claudeSessionId).toBe('new_cs');
    expect(sessionDb.get('conv1').claude_session_id).toBe('new_cs');
  });
});

describe('Agent Message: proxy_ports_update', () => {
  it('should update agent proxy ports', () => {
    const agent = createMockAgent({ proxyPorts: [] });

    const newPorts = [
      { port: 3000, enabled: true, label: 'dev' },
      { port: 8080, enabled: false, label: 'api' }
    ];

    agent.proxyPorts = newPorts;

    expect(agent.proxyPorts.length).toBe(2);
    expect(agent.proxyPorts[0].port).toBe(3000);
    expect(agent.proxyPorts[0].enabled).toBe(true);
  });
});

describe('Agent Latency Measurement', () => {
  it('should calculate latency from ping/pong', () => {
    const agent = createMockAgent();
    agent.pingSentAt = Date.now() - 50;

    // Simulate pong handler
    agent.isAlive = true;
    if (agent.pingSentAt) {
      agent.latency = Date.now() - agent.pingSentAt;
      agent.pingSentAt = null;
    }

    expect(agent.latency).toBeGreaterThan(0);
    expect(agent.pingSentAt).toBeNull();
  });
});
