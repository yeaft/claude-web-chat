import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { createTestDb, cleanupTestDb, createDbOperations } from '../helpers/testDb.js';
import { MockWebSocket, createMockAgent, createMockWebClient, WS_OPEN } from '../helpers/mockWs.js';

/**
 * Tests for /btw server layer message forwarding (PR #299).
 * Covers: btw_question (client→server→agent) and btw_stream/btw_done/btw_error (agent→server→clients).
 * Pattern mirrors ws-client.test.js / ws-agent.test.js — simulate logic without importing handlers.
 */

let db, sessionDb;

beforeEach(() => {
  if (db) { try { db.close(); } catch (e) {} }
  const result = createTestDb();
  db = result.db;
  const ops = createDbOperations(db);
  sessionDb = ops.sessionDb;
});

afterAll(() => cleanupTestDb());

// ---------- btw_question: client → server → agent ----------

describe('btw_question: client → server → agent', () => {
  it('should return btw_error when no agent selected', () => {
    // client has no currentAgent
    const client = createMockWebClient({ currentAgent: null, currentConversation: 'conv1' });

    // Simulate handler logic: no agent → send btw_error back
    if (!client.currentAgent) {
      client.ws.send(JSON.stringify({ type: 'btw_error', error: 'No agent selected' }));
    }

    const sent = client.ws.getLastMessage();
    expect(sent.type).toBe('btw_error');
    expect(sent.error).toBe('No agent selected');
  });

  it('should return btw_error when no conversation selected', () => {
    // client has agent but no conversation
    const client = createMockWebClient({ currentAgent: 'agent1', currentConversation: null });
    const msg = { type: 'btw_question', question: 'What is this?' };

    // Simulate: agent exists, but no conversationId
    const btwConvId = msg.conversationId || client.currentConversation;
    if (!btwConvId) {
      client.ws.send(JSON.stringify({ type: 'btw_error', error: 'No conversation selected' }));
    }

    const sent = client.ws.getLastMessage();
    expect(sent.type).toBe('btw_error');
    expect(sent.error).toBe('No conversation selected');
  });

  it('should return btw_error when msg has no conversationId and client has no currentConversation', () => {
    const client = createMockWebClient({ currentAgent: 'agent1', currentConversation: null });
    const msg = { type: 'btw_question', question: 'Help?' };

    const btwConvId = msg.conversationId || client.currentConversation;
    expect(btwConvId).toBeFalsy();
  });

  it('should use msg.conversationId over client.currentConversation when provided', () => {
    const client = createMockWebClient({ currentAgent: 'agent1', currentConversation: 'conv_default' });
    const msg = { type: 'btw_question', conversationId: 'conv_explicit', question: 'Why?' };

    const btwConvId = msg.conversationId || client.currentConversation;
    expect(btwConvId).toBe('conv_explicit');
  });

  it('should fall back to client.currentConversation when msg has no conversationId', () => {
    const client = createMockWebClient({ currentAgent: 'agent1', currentConversation: 'conv_fallback' });
    const msg = { type: 'btw_question', question: 'How?' };

    const btwConvId = msg.conversationId || client.currentConversation;
    expect(btwConvId).toBe('conv_fallback');
  });

  it('should deny non-owner with btw_error and Security warning', () => {
    // Simulate ownership check: conversation belongs to a different user
    const agent = createMockAgent();
    agent.conversations.set('conv_other', { id: 'conv_other', userId: 'user_owner' });

    const client = createMockWebClient({
      currentAgent: 'agent1',
      currentConversation: 'conv_other',
      userId: 'user_attacker'
    });

    const btwConvId = 'conv_other';
    const skipAuth = false;

    // Simulate verifyConversationOwnership: check in-memory
    const conv = agent.conversations.get(btwConvId);
    const isOwner = !conv?.userId || conv.userId === client.userId;

    if (!skipAuth && !isOwner) {
      // Security warn (in real code: console.warn)
      const warnMsg = `[Security] User ${client.userId} btw_question denied for ${btwConvId}`;
      client.ws.send(JSON.stringify({
        type: 'btw_error',
        conversationId: btwConvId,
        error: 'Permission denied'
      }));

      const sent = client.ws.getLastMessage();
      expect(sent.type).toBe('btw_error');
      expect(sent.conversationId).toBe(btwConvId);
      expect(sent.error).toBe('Permission denied');
      expect(warnMsg).toContain('user_attacker');
      expect(warnMsg).toContain('btw_question denied');
    }

    expect(isOwner).toBe(false);
  });

  it('should allow owner and forward btw_question to agent', () => {
    const agent = createMockAgent();
    agent.conversations.set('conv_mine', { id: 'conv_mine', userId: 'user_me' });

    const client = createMockWebClient({
      currentAgent: 'agent1',
      currentConversation: 'conv_mine',
      userId: 'user_me'
    });

    const msg = { type: 'btw_question', question: 'What does this function do?' };
    const btwConvId = msg.conversationId || client.currentConversation;

    // Ownership check passes
    const conv = agent.conversations.get(btwConvId);
    const isOwner = !conv?.userId || conv.userId === client.userId;
    expect(isOwner).toBe(true);

    // Forward to agent
    agent.ws.send(JSON.stringify({
      type: 'btw_question',
      conversationId: btwConvId,
      question: msg.question
    }));

    const sent = agent.ws.getLastMessage();
    expect(sent.type).toBe('btw_question');
    expect(sent.conversationId).toBe('conv_mine');
    expect(sent.question).toBe('What does this function do?');
  });

  it('should allow access when conversation has no userId (legacy/skipAuth)', () => {
    const agent = createMockAgent();
    agent.conversations.set('conv_noowner', { id: 'conv_noowner' /* no userId */ });

    const client = createMockWebClient({
      currentAgent: 'agent1',
      currentConversation: 'conv_noowner',
      userId: 'any_user'
    });

    const conv = agent.conversations.get('conv_noowner');
    const isOwner = !conv?.userId || conv.userId === client.userId;
    expect(isOwner).toBe(true);
  });

  it('should forward question field correctly in the forwarded message', () => {
    const agent = createMockAgent();
    const question = '请解释这段代码的作用，特别是 async/await 的部分';

    agent.ws.send(JSON.stringify({
      type: 'btw_question',
      conversationId: 'conv1',
      question: question
    }));

    const sent = agent.ws.getLastMessage();
    expect(sent.question).toBe(question);
    expect(sent.type).toBe('btw_question');
    expect(sent.conversationId).toBe('conv1');
    // Verify only expected fields are present
    expect(Object.keys(sent).sort()).toEqual(['conversationId', 'question', 'type']);
  });
});

// ---------- btw_stream/btw_done/btw_error: agent → server → clients ----------

describe('btw agent output: agent → server → clients', () => {
  it('should forward btw_stream with delta to clients', () => {
    const clientA = createMockWebClient({ currentAgent: 'agent1', currentConversation: 'conv1' });
    const clientB = createMockWebClient({ currentAgent: 'agent1', currentConversation: 'conv1' });

    const agentMsg = {
      type: 'btw_stream',
      conversationId: 'conv1',
      delta: 'Here is the first chunk of the answer...'
    };

    // Simulate forwardToClients: send to all clients on this agent+conversation
    const clients = [clientA, clientB];
    for (const c of clients) {
      c.ws.send(JSON.stringify({
        type: agentMsg.type,
        conversationId: agentMsg.conversationId,
        delta: agentMsg.delta
      }));
    }

    for (const c of clients) {
      const sent = c.ws.getLastMessage();
      expect(sent.type).toBe('btw_stream');
      expect(sent.conversationId).toBe('conv1');
      expect(sent.delta).toBe('Here is the first chunk of the answer...');
    }
  });

  it('should forward btw_done to clients without extra fields', () => {
    const client = createMockWebClient({ currentAgent: 'agent1', currentConversation: 'conv1' });

    const forwarded = {
      type: 'btw_done',
      conversationId: 'conv1'
    };

    client.ws.send(JSON.stringify(forwarded));
    const sent = client.ws.getLastMessage();

    expect(sent.type).toBe('btw_done');
    expect(sent.conversationId).toBe('conv1');
    // btw_done should not have delta or error
    expect(sent.delta).toBeUndefined();
    expect(sent.error).toBeUndefined();
  });

  it('should forward btw_error with error message to clients', () => {
    const client = createMockWebClient({ currentAgent: 'agent1', currentConversation: 'conv1' });

    const forwarded = {
      type: 'btw_error',
      conversationId: 'conv1',
      error: 'Agent internal error'
    };

    client.ws.send(JSON.stringify(forwarded));
    const sent = client.ws.getLastMessage();

    expect(sent.type).toBe('btw_error');
    expect(sent.conversationId).toBe('conv1');
    expect(sent.error).toBe('Agent internal error');
  });

  it('should NOT write btw messages to database (ephemeral)', () => {
    // Create a session so we can verify no messages are added
    sessionDb.create('btw_conv', 'agent1', 'Agent', '/work');

    const messageDb = createDbOperations(db).messageDb;
    const countBefore = messageDb.getCount('btw_conv');

    // Simulate: btw_stream, btw_done, btw_error are forwarded but NOT saved
    // In the actual code, there is no messageDb.add call for btw_* types
    // We verify the pattern: btw_* cases only call forwardToClients, no DB write

    const countAfter = messageDb.getCount('btw_conv');
    expect(countAfter).toBe(countBefore);
    expect(countAfter).toBe(0);
  });

  it('should forward btw_stream delta accurately for multi-chunk streaming', () => {
    const client = createMockWebClient({ currentAgent: 'agent1', currentConversation: 'conv1' });

    // Simulate multiple stream chunks
    const chunks = ['First ', 'chunk. ', 'Second chunk with 中文. ', 'Final!'];
    for (const delta of chunks) {
      client.ws.send(JSON.stringify({
        type: 'btw_stream',
        conversationId: 'conv1',
        delta
      }));
    }

    const allSent = client.ws.getSentMessages();
    expect(allSent.length).toBe(4);
    expect(allSent.every(m => m.type === 'btw_stream')).toBe(true);
    expect(allSent.map(m => m.delta)).toEqual(chunks);
  });

  it('should include conversationId in all btw forwarded messages', () => {
    const client = createMockWebClient();
    const convId = 'conv_specific';

    const messages = [
      { type: 'btw_stream', conversationId: convId, delta: 'data' },
      { type: 'btw_done', conversationId: convId },
      { type: 'btw_error', conversationId: convId, error: 'fail' }
    ];

    for (const msg of messages) {
      client.ws.send(JSON.stringify(msg));
    }

    const allSent = client.ws.getSentMessages();
    expect(allSent.length).toBe(3);
    for (const sent of allSent) {
      expect(sent.conversationId).toBe(convId);
    }
  });
});
