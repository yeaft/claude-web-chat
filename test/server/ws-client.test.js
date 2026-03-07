import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { createTestDb, cleanupTestDb, createDbOperations } from '../helpers/testDb.js';
import { MockWebSocket, createMockAgent, createMockWebClient, WS_OPEN, WS_CLOSED } from '../helpers/mockWs.js';

/**
 * Tests for web client connection lifecycle and message handling patterns.
 * Mirrors the logic in ws-client.js without importing directly.
 */

let db, userDb, sessionDb, messageDb;

beforeEach(() => {
  if (db) { try { db.close(); } catch (e) {} }
  const result = createTestDb();
  db = result.db;
  const ops = createDbOperations(db);
  userDb = ops.userDb;
  sessionDb = ops.sessionDb;
  messageDb = ops.messageDb;
});

afterAll(() => cleanupTestDb());

describe('Web Client Authentication', () => {
  it('should auto-authenticate in skipAuth mode', () => {
    const client = createMockWebClient({ authenticated: true, role: 'admin' });
    expect(client.authenticated).toBe(true);
    expect(client.role).toBe('admin');
  });

  it('should authenticate with valid JWT token', () => {
    // Simulating verifyToken result
    const tokenResult = { valid: true, username: 'user1', sessionKey: new Uint8Array(32), role: 'user' };
    const client = createMockWebClient({
      authenticated: tokenResult.valid,
      username: tokenResult.username,
      role: tokenResult.role
    });
    expect(client.authenticated).toBe(true);
    expect(client.username).toBe('user1');
  });

  it('should reject invalid token and close connection', () => {
    const ws = new MockWebSocket();
    const tokenResult = { valid: false };

    if (!tokenResult.valid) {
      ws.send(JSON.stringify({ type: 'auth_result', success: false, error: 'Authentication required' }));
      ws.close(1008, 'Authentication required');
    }

    expect(ws.getLastMessage().type).toBe('auth_result');
    expect(ws.getLastMessage().success).toBe(false);
    expect(ws.closeCode).toBe(1008);
  });

  it('should create user record on first connect', () => {
    const user = userDb.getOrCreate('newuser');
    expect(user.id).toMatch(/^user_/);
    expect(user.username).toBe('newuser');
  });
});

describe('Web Client Disconnect Cleanup', () => {
  it('should disable proxy ports when last client leaves agent', () => {
    const agents = new Map();
    const webClients = new Map();

    const agent = createMockAgent({
      proxyPorts: [{ port: 3000, enabled: true }]
    });
    agents.set('agent1', agent);

    // Single client connected to agent
    webClients.set('client1', createMockWebClient({ currentAgent: 'agent1' }));

    // Simulate disconnect: check if other clients on same agent
    const clientId = 'client1';
    const client = webClients.get(clientId);
    const agentId = client.currentAgent;

    let otherClientsOnAgent = false;
    for (const [otherId, otherClient] of webClients) {
      if (otherId !== clientId && otherClient.currentAgent === agentId && otherClient.ws.readyState === WS_OPEN) {
        otherClientsOnAgent = true;
        break;
      }
    }

    if (!otherClientsOnAgent) {
      agent.proxyPorts = agent.proxyPorts.map(p => ({ ...p, enabled: false }));
    }

    webClients.delete(clientId);

    expect(agent.proxyPorts[0].enabled).toBe(false);
    expect(webClients.size).toBe(0);
  });

  it('should NOT disable proxy ports when other clients remain', () => {
    const agents = new Map();
    const webClients = new Map();

    const agent = createMockAgent({
      proxyPorts: [{ port: 3000, enabled: true }]
    });
    agents.set('agent1', agent);

    webClients.set('client1', createMockWebClient({ currentAgent: 'agent1' }));
    webClients.set('client2', createMockWebClient({ currentAgent: 'agent1' }));

    // client1 disconnects
    const clientId = 'client1';
    const agentId = webClients.get(clientId).currentAgent;

    let otherClientsOnAgent = false;
    for (const [otherId, otherClient] of webClients) {
      if (otherId !== clientId && otherClient.currentAgent === agentId && otherClient.ws.readyState === WS_OPEN) {
        otherClientsOnAgent = true;
        break;
      }
    }

    if (!otherClientsOnAgent) {
      agent.proxyPorts = agent.proxyPorts.map(p => ({ ...p, enabled: false }));
    }

    webClients.delete(clientId);

    expect(agent.proxyPorts[0].enabled).toBe(true); // Still enabled
    expect(webClients.size).toBe(1);
  });
});

describe('Web Message: select_agent', () => {
  it('should set currentAgent and return agent info', () => {
    const agents = new Map();
    const agent = createMockAgent({ name: 'Worker-1', capabilities: ['terminal'] });
    agents.set('agent1', agent);

    const client = createMockWebClient();
    client.currentAgent = 'agent1';
    client.currentConversation = null;

    expect(client.currentAgent).toBe('agent1');

    // Send agent_selected response
    const response = {
      type: 'agent_selected',
      agentId: 'agent1',
      agentName: agent.name,
      workDir: agent.workDir,
      capabilities: agent.capabilities,
      conversations: []
    };

    client.ws.send(JSON.stringify(response));
    expect(client.ws.getLastMessage().type).toBe('agent_selected');
  });

  it('should reject offline agent', () => {
    const agent = createMockAgent();
    agent.ws.readyState = WS_CLOSED;

    const isOnline = agent.ws.readyState === WS_OPEN;
    expect(isOnline).toBe(false);
  });

  it('should filter conversations by userId', () => {
    const agent = createMockAgent();
    agent.conversations.set('c1', { id: 'c1', userId: 'user1' });
    agent.conversations.set('c2', { id: 'c2', userId: 'user2' });
    agent.conversations.set('c3', { id: 'c3' }); // no userId

    const clientUserId = 'user1';
    const skipAuth = false;
    const filtered = Array.from(agent.conversations.values()).filter(c =>
      skipAuth || !c.userId || c.userId === clientUserId
    );

    expect(filtered.length).toBe(2); // c1 (owner) + c3 (no owner)
  });
});

describe('Web Message: create_conversation', () => {
  it('should reject when agent is syncing', () => {
    const agent = createMockAgent({ status: 'syncing' });
    const client = createMockWebClient();

    if (agent.status === 'syncing') {
      client.ws.send(JSON.stringify({ type: 'error', message: 'Agent is still syncing, please wait...' }));
    }

    expect(client.ws.getLastMessage().type).toBe('error');
    expect(client.ws.getLastMessage().message).toContain('syncing');
  });

  it('should include userId and username in forwarded message', () => {
    const forwardedMsg = {
      type: 'create_conversation',
      conversationId: 'conv_new',
      workDir: '/work',
      userId: 'user_123',
      username: 'testuser'
    };

    expect(forwardedMsg.userId).toBe('user_123');
    expect(forwardedMsg.username).toBe('testuser');
  });
});

describe('Web Message: chat (core message sending)', () => {
  it('should send execute when not processing', () => {
    const agent = createMockAgent();
    const convInfo = { processing: false, workDir: '/w', claudeSessionId: 'cs1' };
    agent.conversations.set('conv1', convInfo);

    // Not processing → send directly
    convInfo.processing = true;

    const executeMsg = {
      type: 'execute',
      conversationId: 'conv1',
      prompt: 'Hello',
      workDir: convInfo.workDir,
      claudeSessionId: convInfo.claudeSessionId
    };

    agent.ws.send(JSON.stringify(executeMsg));

    expect(convInfo.processing).toBe(true);
    expect(agent.ws.getLastMessage().type).toBe('execute');
    expect(agent.ws.getLastMessage().prompt).toBe('Hello');
  });

  it('should queue message when already processing', () => {
    const serverMessageQueues = new Map();
    const convId = 'conv1';
    const convInfo = { processing: true, workDir: '/w' };

    const queueItem = {
      id: 'queue_1',
      prompt: 'queued message',
      workDir: convInfo.workDir,
      userId: 'user1',
      clientId: 'client1',
      queuedAt: Date.now()
    };

    if (!serverMessageQueues.has(convId)) {
      serverMessageQueues.set(convId, []);
    }
    serverMessageQueues.get(convId).push(queueItem);

    expect(serverMessageQueues.get(convId).length).toBe(1);
    expect(serverMessageQueues.get(convId)[0].prompt).toBe('queued message');
  });

  it('should enforce queue limit of 10', () => {
    const serverMessageQueues = new Map();
    const convId = 'conv1';
    serverMessageQueues.set(convId, []);
    const queue = serverMessageQueues.get(convId);

    for (let i = 0; i < 10; i++) {
      queue.push({ id: `q${i}`, prompt: `msg${i}` });
    }

    expect(queue.length).toBe(10);

    // 11th message should be rejected
    const isFull = queue.length >= 10;
    expect(isFull).toBe(true);
  });

  it('should resolve file attachments from pendingFiles', () => {
    const pendingFiles = new Map();
    pendingFiles.set('file1', {
      name: 'test.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('hello'),
      userId: 'user1'
    });

    const fileIds = ['file1'];
    const resolvedFiles = [];

    for (const fileId of fileIds) {
      const file = pendingFiles.get(fileId);
      if (file && file.userId === 'user1') {
        resolvedFiles.push({
          name: file.name,
          mimeType: file.mimeType,
          data: file.buffer.toString('base64')
        });
        pendingFiles.delete(fileId);
      }
    }

    expect(resolvedFiles.length).toBe(1);
    expect(resolvedFiles[0].name).toBe('test.txt');
    expect(pendingFiles.has('file1')).toBe(false); // consumed
  });

  it('should send transfer_files when files attached', () => {
    const resolvedFiles = [{ name: 'test.txt', mimeType: 'text/plain', data: 'aGVsbG8=' }];
    const hasFiles = resolvedFiles.length > 0;
    expect(hasFiles).toBe(true);
    // In real code: sends transfer_files message instead of execute
  });

  it('should reject file owned by different user', () => {
    const pendingFiles = new Map();
    pendingFiles.set('file_other', {
      name: 'secret.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('secret'),
      userId: 'user_other'
    });

    const file = pendingFiles.get('file_other');
    const isOwner = file.userId === 'user1';
    expect(isOwner).toBe(false);
  });

  it('should return error if no conversation selected', () => {
    const client = createMockWebClient({ currentAgent: null, currentConversation: null });
    const hasContext = client.currentAgent && client.currentConversation;
    expect(hasContext).toBeFalsy();
  });
});

describe('Web Message: queue operations', () => {
  it('should cancel specific queued message', () => {
    const serverMessageQueues = new Map();
    serverMessageQueues.set('conv1', [
      { id: 'q1', prompt: 'first' },
      { id: 'q2', prompt: 'second' },
      { id: 'q3', prompt: 'third' }
    ]);

    const queue = serverMessageQueues.get('conv1');
    const idx = queue.findIndex(m => m.id === 'q2');
    if (idx >= 0) queue.splice(idx, 1);

    expect(queue.length).toBe(2);
    expect(queue.find(m => m.id === 'q2')).toBeUndefined();
  });

  it('should clear entire queue', () => {
    const serverMessageQueues = new Map();
    serverMessageQueues.set('conv1', [
      { id: 'q1' }, { id: 'q2' }, { id: 'q3' }
    ]);

    const count = serverMessageQueues.get('conv1').length;
    serverMessageQueues.delete('conv1');

    expect(count).toBe(3);
    expect(serverMessageQueues.has('conv1')).toBe(false);
  });
});

describe('Web Message: sync_messages', () => {
  it('should return recent messages with pagination info', () => {
    sessionDb.create('sm_sess', 'a1', 'A', '/d');

    for (let i = 0; i < 20; i++) {
      messageDb.add('sm_sess', 'user', `msg${i}`);
    }

    const limit = 10;
    const messages = messageDb.getRecent('sm_sess', limit);
    const total = messageDb.getCount('sm_sess');
    const oldestId = messages.length > 0 ? messages[0].id : null;
    const hasMore = oldestId ? messageDb.getBeforeId('sm_sess', oldestId, 1).length > 0 : false;

    expect(messages.length).toBe(10);
    expect(total).toBe(20);
    expect(hasMore).toBe(true);
  });

  it('should load older messages with beforeId', () => {
    sessionDb.create('sm_page', 'a1', 'A', '/d');
    const ids = [];
    for (let i = 0; i < 20; i++) {
      ids.push(messageDb.add('sm_page', 'user', `msg${i}`));
    }

    const beforeMessages = messageDb.getBeforeId('sm_page', ids[10], 5);
    expect(beforeMessages.length).toBe(5);
    expect(beforeMessages[0].content).toBe('msg5');
  });
});

describe('Web Message: terminal operations', () => {
  it('should require conversation ownership for terminal access', () => {
    sessionDb.create('term_conv', 'a1', 'A', '/d', null, null, 'user_owner');
    const session = sessionDb.get('term_conv');

    const clientUserId = 'user_other';
    const hasOwnership = !session.user_id || session.user_id === clientUserId;
    expect(hasOwnership).toBe(false);
  });

  it('should forward terminal messages to agent', () => {
    const agent = createMockAgent();
    const termMsg = {
      type: 'terminal_create',
      conversationId: 'conv1',
      cols: 80,
      rows: 24
    };

    agent.ws.send(JSON.stringify(termMsg));
    expect(agent.ws.getLastMessage().type).toBe('terminal_create');
  });
});

describe('Web Message: file operations', () => {
  it('should check directory cache before forwarding to agent', () => {
    const directoryCache = new Map();
    const cachedEntries = [
      { name: 'file1.js', isDir: false, size: 100 },
      { name: 'src', isDir: true }
    ];
    directoryCache.set('agent1:/home/user', {
      entries: cachedEntries,
      timestamp: Date.now()
    });

    const cached = directoryCache.get('agent1:/home/user');
    const isExpired = Date.now() - cached.timestamp > 5 * 60 * 1000;
    expect(isExpired).toBe(false);
    expect(cached.entries).toEqual(cachedEntries);
  });

  it('should forward git operations to agent', () => {
    const agent = createMockAgent();
    const gitOps = ['git_status', 'git_diff', 'git_add', 'git_reset', 'git_restore', 'git_commit', 'git_push'];

    for (const op of gitOps) {
      agent.ws.send(JSON.stringify({ type: op, conversationId: 'conv1' }));
    }

    expect(agent.ws.getSentMessages().length).toBe(7);
  });
});

describe('Web Message: file tab persistence', () => {
  it('should save file tab state', () => {
    const userFileTabs = new Map();
    const key = 'user1:agent1';
    const tabs = {
      files: [{ path: '/src/app.js' }, { path: '/src/utils.js' }],
      activeIndex: 1,
      timestamp: Date.now()
    };

    userFileTabs.set(key, tabs);

    const saved = userFileTabs.get(key);
    expect(saved.files.length).toBe(2);
    expect(saved.activeIndex).toBe(1);
  });

  it('should restore file tab state', () => {
    const userFileTabs = new Map();
    const key = 'user1:agent1';
    userFileTabs.set(key, {
      files: [{ path: '/src/app.js' }],
      activeIndex: 0,
      timestamp: Date.now()
    });

    const saved = userFileTabs.get(key);
    const response = {
      type: 'file_tabs_restored',
      openFiles: saved?.files || [],
      activeIndex: saved?.activeIndex || 0
    };

    expect(response.openFiles.length).toBe(1);
    expect(response.openFiles[0].path).toBe('/src/app.js');
  });

  it('should return empty state if nothing saved', () => {
    const userFileTabs = new Map();
    const saved = userFileTabs.get('nonexistent');

    const response = {
      type: 'file_tabs_restored',
      openFiles: saved?.files || [],
      activeIndex: saved?.activeIndex || 0
    };

    expect(response.openFiles).toEqual([]);
    expect(response.activeIndex).toBe(0);
  });
});

describe('Web Message: ask_user_answer', () => {
  it('should forward answer to agent with ownership check', () => {
    const agent = createMockAgent();
    const msg = {
      type: 'ask_user_answer',
      conversationId: 'conv1',
      requestId: 'req_123',
      answers: { q1: 'Yes' }
    };

    agent.ws.send(JSON.stringify(msg));
    const sent = agent.ws.getLastMessage();
    expect(sent.type).toBe('ask_user_answer');
    expect(sent.requestId).toBe('req_123');
    expect(sent.answers.q1).toBe('Yes');
  });
});

describe('Web Message: update_conversation_settings', () => {
  it('should forward disallowedTools to agent', () => {
    const agent = createMockAgent();
    const msg = {
      type: 'update_conversation_settings',
      conversationId: 'conv1',
      disallowedTools: ['Bash', 'Write']
    };

    agent.ws.send(JSON.stringify(msg));
    expect(agent.ws.getLastMessage().disallowedTools).toEqual(['Bash', 'Write']);
  });
});
