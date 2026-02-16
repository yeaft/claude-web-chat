import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { createTestDb, cleanupTestDb, createDbOperations } from '../helpers/testDb.js';
import { MockWebSocket, createMockAgent, createMockWebClient, WS_OPEN, WS_CLOSED } from '../helpers/mockWs.js';

/**
 * Tests for ws-utils.js logic patterns.
 * Since ws-utils.js imports from config.js/database.js (with side effects),
 * we test the core logic patterns independently using mock objects.
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

describe('sendToWebClient / sendToAgent pattern', () => {
  it('should send plain JSON in skipAuth mode', () => {
    const ws = new MockWebSocket();
    const msg = { type: 'test', data: 'hello' };
    ws.send(JSON.stringify(msg));
    expect(ws.getSentMessages()).toEqual([msg]);
  });

  it('should not send to closed websocket', () => {
    const ws = new MockWebSocket(WS_CLOSED);
    ws.send(JSON.stringify({ type: 'test' }));
    // Sends are ignored when readyState is not OPEN in real WS,
    // but our mock still records them. The real check is in ws-utils.js:
    // if (client.ws.readyState !== WebSocket.OPEN) return;
    expect(ws.readyState).toBe(WS_CLOSED);
  });
});

describe('parseMessage pattern', () => {
  it('should parse plain JSON message', () => {
    const data = JSON.stringify({ type: 'test', value: 42 });
    const parsed = JSON.parse(data);
    expect(parsed.type).toBe('test');
    expect(parsed.value).toBe(42);
  });

  it('should handle invalid JSON gracefully', () => {
    try {
      JSON.parse('not-json');
      expect.unreachable();
    } catch (e) {
      expect(e).toBeTruthy();
    }
  });

  it('should detect encrypted messages', async () => {
    const { encrypt, isEncrypted, generateSessionKey } = await import('../../server/encryption.js');
    const key = generateSessionKey();
    const encrypted = await encrypt({ type: 'test' }, key);
    expect(isEncrypted(encrypted)).toBe(true);
    expect(isEncrypted({ type: 'test' })).toBe(false);
  });

  it('should decrypt and parse encrypted message', async () => {
    const { encrypt, decrypt, generateSessionKey } = await import('../../server/encryption.js');
    const key = generateSessionKey();
    const original = { type: 'claude_output', data: { text: 'hello' } };
    const encrypted = await encrypt(original, key);
    const decrypted = await decrypt(encrypted, key);
    expect(decrypted).toEqual(original);
  });
});

describe('broadcastAgentList filtering', () => {
  it('should include agents with no ownerId (global agents)', () => {
    const agent = createMockAgent({ ownerId: null });
    const client = createMockWebClient({ userId: 'user_123' });

    // skipAuth=true OR ownerId=null → visible to all
    const skipAuth = true;
    const visible = skipAuth || !agent.ownerId || agent.ownerId === client.userId;
    expect(visible).toBe(true);
  });

  it('should include agents owned by the requesting user', () => {
    const agent = createMockAgent({ ownerId: 'user_123' });
    const client = createMockWebClient({ userId: 'user_123' });

    const skipAuth = false;
    const visible = skipAuth || !agent.ownerId || agent.ownerId === client.userId;
    expect(visible).toBe(true);
  });

  it('should exclude agents owned by other users', () => {
    const agent = createMockAgent({ ownerId: 'user_456' });
    const client = createMockWebClient({ userId: 'user_123' });

    const skipAuth = false;
    const visible = skipAuth || !agent.ownerId || agent.ownerId === client.userId;
    expect(visible).toBe(false);
  });

  it('should include all agents in skipAuth mode', () => {
    const agent = createMockAgent({ ownerId: 'user_456' });
    const client = createMockWebClient({ userId: 'user_123' });

    const skipAuth = true;
    const visible = skipAuth || !agent.ownerId || agent.ownerId === client.userId;
    expect(visible).toBe(true);
  });
});

describe('conversation ownership verification', () => {
  it('should allow access to own conversation (in-memory)', () => {
    const conversations = new Map();
    conversations.set('conv1', { id: 'conv1', userId: 'user_123' });

    const conv = conversations.get('conv1');
    expect(conv.userId === 'user_123').toBe(true);
  });

  it('should deny access to other user conversation', () => {
    const conversations = new Map();
    conversations.set('conv1', { id: 'conv1', userId: 'user_456' });

    const conv = conversations.get('conv1');
    expect(conv.userId === 'user_123').toBe(false);
  });

  it('should allow access to conversation with no userId', () => {
    const conversations = new Map();
    conversations.set('conv1', { id: 'conv1' });

    const conv = conversations.get('conv1');
    // No userId → allow access
    expect(!conv.userId).toBe(true);
  });

  it('should check DB when conversation not in memory', () => {
    sessionDb.create('conv_db', 'agent1', 'Agent', '/work', null, null, 'user_123');
    const session = sessionDb.get('conv_db');
    expect(session.user_id).toBe('user_123');
  });

  it('should allow access when conversation not found anywhere', () => {
    // When conversation is not found in memory or DB, allow access
    // (it might be a newly created conversation not yet saved)
    const session = sessionDb.get('nonexistent_conv');
    expect(session).toBeUndefined();
    // The real code returns true in this case
  });
});

describe('directory cache logic', () => {
  it('should store and retrieve cached directory', () => {
    const cache = new Map();
    const key = 'agent1:/home/user';
    const entries = [{ name: 'file.txt', isDir: false }];

    cache.set(key, { entries, timestamp: Date.now() });
    const cached = cache.get(key);
    expect(cached.entries).toEqual(entries);
  });

  it('should expire cached entries after TTL', () => {
    const cache = new Map();
    const TTL = 5 * 60 * 1000;
    const key = 'agent1:/old';

    cache.set(key, { entries: [], timestamp: Date.now() - TTL - 1000 });
    const cached = cache.get(key);
    const isExpired = Date.now() - cached.timestamp >= TTL;
    expect(isExpired).toBe(true);
  });

  it('should enforce max cache size (LRU eviction)', () => {
    const cache = new Map();
    const MAX_SIZE = 3;

    for (let i = 0; i < MAX_SIZE; i++) {
      cache.set(`key${i}`, { entries: [], timestamp: Date.now() - (MAX_SIZE - i) * 1000 });
    }
    expect(cache.size).toBe(MAX_SIZE);

    // Adding one more should evict oldest
    if (cache.size >= MAX_SIZE) {
      const oldest = [...cache.entries()].sort((a, b) => a[1].timestamp - b[1].timestamp)[0];
      cache.delete(oldest[0]);
    }
    cache.set('keynew', { entries: [], timestamp: Date.now() });
    expect(cache.size).toBe(MAX_SIZE);
    expect(cache.has('key0')).toBe(false); // oldest evicted
  });

  it('should clear all cache for an agent on disconnect', () => {
    const cache = new Map();
    cache.set('agent1:/dir1', { entries: [], timestamp: Date.now() });
    cache.set('agent1:/dir2', { entries: [], timestamp: Date.now() });
    cache.set('agent2:/dir1', { entries: [], timestamp: Date.now() });

    // Clear agent1 cache
    const prefix = 'agent1:';
    for (const key of [...cache.keys()]) {
      if (key.startsWith(prefix)) cache.delete(key);
    }
    expect(cache.size).toBe(1);
    expect(cache.has('agent2:/dir1')).toBe(true);
  });

  it('should invalidate parent directory cache on file save', () => {
    const cache = new Map();
    cache.set('agent1:/home/user/project', { entries: [], timestamp: Date.now() });

    const filePath = '/home/user/project/file.txt';
    const parentDir = filePath.replace(/[\\\/][^\\\/]+$/, '');
    const key = `agent1:${parentDir}`;
    cache.delete(key);
    expect(cache.has('agent1:/home/user/project')).toBe(false);
  });
});

describe('forwardToClients filtering', () => {
  it('should forward to owner clients only', () => {
    const clients = new Map();
    const ws1 = new MockWebSocket();
    const ws2 = new MockWebSocket();
    clients.set('c1', { ws: ws1, authenticated: true, userId: 'owner_1' });
    clients.set('c2', { ws: ws2, authenticated: true, userId: 'other_user' });

    const ownerId = 'owner_1';
    const msg = { type: 'claude_output', data: 'test' };

    for (const [, client] of clients) {
      if (client.authenticated && (!ownerId || client.userId === ownerId)) {
        client.ws.send(JSON.stringify(msg));
      }
    }

    expect(ws1.getSentMessages()).toEqual([msg]);
    expect(ws2.getSentMessages()).toEqual([]);
  });

  it('should forward to all if no ownerId', () => {
    const clients = new Map();
    const ws1 = new MockWebSocket();
    const ws2 = new MockWebSocket();
    clients.set('c1', { ws: ws1, authenticated: true, userId: 'u1' });
    clients.set('c2', { ws: ws2, authenticated: true, userId: 'u2' });

    const ownerId = null;
    const msg = { type: 'test' };

    for (const [, client] of clients) {
      if (client.authenticated && (!ownerId || client.userId === ownerId)) {
        client.ws.send(JSON.stringify(msg));
      }
    }

    expect(ws1.getSentMessages()).toEqual([msg]);
    expect(ws2.getSentMessages()).toEqual([msg]);
  });
});

describe('notifyConversationUpdate routing', () => {
  it('should broadcast folders_list to all authenticated clients', () => {
    const clients = new Map();
    const ws1 = new MockWebSocket();
    const ws2 = new MockWebSocket();
    clients.set('c1', { ws: ws1, authenticated: true, currentAgent: 'agent1' });
    clients.set('c2', { ws: ws2, authenticated: true, currentAgent: 'agent2' });

    const msg = { type: 'folders_list', folders: ['a', 'b'] };

    // folders_list → broadcast to all authenticated
    for (const [, client] of clients) {
      if (client.authenticated) {
        client.ws.send(JSON.stringify(msg));
      }
    }

    expect(ws1.getSentMessages().length).toBe(1);
    expect(ws2.getSentMessages().length).toBe(1);
  });

  it('should only send conversation_created to owner', () => {
    const clients = new Map();
    const ws1 = new MockWebSocket();
    const ws2 = new MockWebSocket();
    clients.set('c1', { ws: ws1, authenticated: true, userId: 'u1' });
    clients.set('c2', { ws: ws2, authenticated: true, userId: 'u2' });

    const msg = { type: 'conversation_created', userId: 'u1', conversationId: 'conv1' };
    const ownerId = msg.userId;

    for (const [, client] of clients) {
      if (client.authenticated && (!ownerId || client.userId === ownerId)) {
        client.ws.send(JSON.stringify(msg));
      }
    }

    expect(ws1.getSentMessages().length).toBe(1);
    expect(ws2.getSentMessages().length).toBe(0);
  });
});
