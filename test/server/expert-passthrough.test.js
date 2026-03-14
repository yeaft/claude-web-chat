import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { createTestDb, cleanupTestDb, createDbOperations } from '../helpers/testDb.js';

// =====================================================================
// Expert selections passthrough — task-65
//
// Tests the server-layer data flow:
//   1. messageDb.add() stores metadata column
//   2. Query methods return metadata when present
//   3. _pendingExperts → metadata JSON conversion logic
//   4. Backward compatibility: no metadata = null, no breakage
// =====================================================================

let db, sessionDb, messageDb;
const SESSION_ID = 'expert-test-session';

beforeEach(() => {
  if (db) { try { db.close(); } catch (e) {} }
  const result = createTestDb();
  db = result.db;
  const ops = createDbOperations(db);
  sessionDb = ops.sessionDb;
  messageDb = ops.messageDb;
  sessionDb.create(SESSION_ID, 'agent1', 'Agent 1', '/work');
});

afterAll(() => cleanupTestDb());

// =====================================================================
// 1. metadata column: write + read round-trip
// =====================================================================

describe('messageDb — metadata column', () => {
  it('stores metadata JSON and returns it on query', () => {
    const experts = [
      { id: 'senior-engineer', name: '资深工程师' },
      { id: 'ui-designer', name: 'UI 设计师' }
    ];
    const metadata = JSON.stringify({ experts });

    messageDb.add(SESSION_ID, 'user', 'Help me build feature X', 'user', null, null, metadata);

    const msgs = messageDb.getBySession(SESSION_ID);
    expect(msgs.length).toBe(1);
    expect(msgs[0].metadata).toBe(metadata);

    const parsed = JSON.parse(msgs[0].metadata);
    expect(parsed.experts).toHaveLength(2);
    expect(parsed.experts[0].id).toBe('senior-engineer');
  });

  it('returns null metadata when not provided', () => {
    messageDb.add(SESSION_ID, 'user', 'Normal message');

    const msgs = messageDb.getBySession(SESSION_ID);
    expect(msgs.length).toBe(1);
    expect(msgs[0].metadata).toBeNull();
  });

  it('returns null metadata when explicitly passed null', () => {
    messageDb.add(SESSION_ID, 'user', 'Another message', 'user', null, null, null);

    const msgs = messageDb.getBySession(SESSION_ID);
    expect(msgs[0].metadata).toBeNull();
  });
});

// =====================================================================
// 2. sync_messages paths return metadata
// =====================================================================

describe('messageDb queries — metadata passthrough', () => {
  it('getRecent returns metadata field', () => {
    const metadata = JSON.stringify({ experts: [{ id: 'pm' }] });
    messageDb.add(SESSION_ID, 'user', 'Q1', 'user', null, null, metadata);
    messageDb.add(SESSION_ID, 'assistant', 'A1', 'assistant');

    const recent = messageDb.getRecent(SESSION_ID, 10);
    expect(recent.length).toBe(2);
    expect(recent[0].metadata).toBe(metadata); // user msg has metadata
    expect(recent[1].metadata).toBeNull();      // assistant msg does not
  });

  it('getAfterId returns metadata field', () => {
    const id1 = messageDb.add(SESSION_ID, 'user', 'Old msg');
    const metadata = JSON.stringify({ experts: [{ id: 'ux' }] });
    messageDb.add(SESSION_ID, 'user', 'New msg', 'user', null, null, metadata);

    const after = messageDb.getAfterId(SESSION_ID, id1);
    expect(after.length).toBe(1);
    expect(after[0].metadata).toBe(metadata);
  });

  it('getRecentTurns returns metadata in user messages', () => {
    // Need controlled timestamps for turn detection
    const now = Date.now();
    db.prepare('INSERT INTO messages (session_id, role, content, message_type, created_at, metadata) VALUES (?, ?, ?, ?, ?, ?)').run(
      SESSION_ID, 'user', 'Question', 'user', now, JSON.stringify({ experts: [{ id: 'dev' }] })
    );
    db.prepare('INSERT INTO messages (session_id, role, content, message_type, created_at, metadata) VALUES (?, ?, ?, ?, ?, ?)').run(
      SESSION_ID, 'assistant', 'Answer', 'assistant', now + 1, null
    );

    const result = messageDb.getRecentTurns(SESSION_ID, 5);
    expect(result.messages.length).toBe(2);
    const userMsg = result.messages.find(m => m.role === 'user');
    expect(JSON.parse(userMsg.metadata).experts[0].id).toBe('dev');
  });
});

// =====================================================================
// 3. _pendingExperts → metadata conversion logic
// =====================================================================

describe('_pendingExperts to metadata conversion', () => {
  // Replicate the logic from agent-output.js
  function convertPendingToMetadata(pendingExperts) {
    if (!pendingExperts) return null;
    return JSON.stringify({ experts: pendingExperts });
  }

  it('converts expert selections array to JSON metadata', () => {
    const experts = [
      { id: 'senior-engineer', name: '资深工程师', teamId: 'dev' },
      { id: 'product-manager', name: '产品经理', teamId: 'product' }
    ];

    const metadata = convertPendingToMetadata(experts);
    const parsed = JSON.parse(metadata);

    expect(parsed.experts).toHaveLength(2);
    expect(parsed.experts[0].id).toBe('senior-engineer');
    expect(parsed.experts[1].teamId).toBe('product');
  });

  it('returns null when no pending experts', () => {
    expect(convertPendingToMetadata(null)).toBeNull();
    expect(convertPendingToMetadata(undefined)).toBeNull();
  });
});

// =====================================================================
// 4. Backward compatibility: existing messages without metadata
// =====================================================================

describe('backward compatibility', () => {
  it('existing messages without metadata return null', () => {
    // Simulate pre-migration message (no metadata)
    messageDb.add(SESSION_ID, 'user', 'Legacy message', 'user');
    messageDb.add(SESSION_ID, 'assistant', 'Legacy response', 'assistant');

    const msgs = messageDb.getBySession(SESSION_ID);
    expect(msgs.length).toBe(2);
    expect(msgs[0].metadata).toBeNull();
    expect(msgs[1].metadata).toBeNull();
  });

  it('mixed messages — some with metadata, some without', () => {
    messageDb.add(SESSION_ID, 'user', 'Normal question');
    messageDb.add(SESSION_ID, 'assistant', 'Normal answer');
    messageDb.add(SESSION_ID, 'user', 'Expert question', 'user', null, null,
      JSON.stringify({ experts: [{ id: 'analyst' }] }));
    messageDb.add(SESSION_ID, 'assistant', 'Expert answer');

    const msgs = messageDb.getBySession(SESSION_ID);
    expect(msgs.length).toBe(4);
    expect(msgs[0].metadata).toBeNull();
    expect(msgs[1].metadata).toBeNull();
    expect(msgs[2].metadata).not.toBeNull();
    expect(JSON.parse(msgs[2].metadata).experts[0].id).toBe('analyst');
    expect(msgs[3].metadata).toBeNull();
  });
});

// =====================================================================
// 5. convInfo._pendingExperts lifecycle (state machine)
// =====================================================================

describe('_pendingExperts lifecycle', () => {
  it('stores on chat, consumed on user message save, absent for next message', () => {
    // Simulate the flow: chat handler stores _pendingExperts,
    // agent-output handler consumes it when saving user message

    // Step 1: chat handler stores experts on convInfo
    const convInfo = { processing: true };
    const expertSelections = [{ id: 'dev', name: 'Developer' }];
    if (expertSelections?.length > 0) {
      convInfo._pendingExperts = expertSelections;
    }
    expect(convInfo._pendingExperts).toEqual(expertSelections);

    // Step 2: agent-output saves user message, consumes _pendingExperts
    let metadata = null;
    if (convInfo._pendingExperts) {
      metadata = JSON.stringify({ experts: convInfo._pendingExperts });
      delete convInfo._pendingExperts;
    }
    messageDb.add(SESSION_ID, 'user', 'Build feature', 'user', null, null, metadata);

    // Step 3: _pendingExperts is gone — next message won't have metadata
    expect(convInfo._pendingExperts).toBeUndefined();

    let metadata2 = null;
    if (convInfo._pendingExperts) {
      metadata2 = JSON.stringify({ experts: convInfo._pendingExperts });
      delete convInfo._pendingExperts;
    }
    messageDb.add(SESSION_ID, 'user', 'Follow-up', 'user', null, null, metadata2);

    // Verify: first msg has metadata, second doesn't
    const msgs = messageDb.getBySession(SESSION_ID);
    expect(msgs[0].metadata).not.toBeNull();
    expect(msgs[1].metadata).toBeNull();
  });

  it('skips _pendingExperts when expertSelections is empty array', () => {
    const convInfo = { processing: true };
    const expertSelections = [];
    // The guard: msg.expertSelections?.length > 0
    if (expertSelections?.length > 0) {
      convInfo._pendingExperts = expertSelections;
    }
    expect(convInfo._pendingExperts).toBeUndefined();
  });

  it('skips _pendingExperts when expertSelections is undefined', () => {
    const convInfo = { processing: true };
    const expertSelections = undefined;
    if (expertSelections?.length > 0) {
      convInfo._pendingExperts = expertSelections;
    }
    expect(convInfo._pendingExperts).toBeUndefined();
  });
});
