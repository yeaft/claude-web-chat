import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { createTestDb, cleanupTestDb, createDbOperations } from '../helpers/testDb.js';

let db, userDb, sessionDb, messageDb, invitationDb;

beforeEach(() => {
  // Close previous db if any
  if (db) { try { db.close(); } catch (e) {} }
  const result = createTestDb();
  db = result.db;
  const ops = createDbOperations(db);
  userDb = ops.userDb;
  sessionDb = ops.sessionDb;
  messageDb = ops.messageDb;
  invitationDb = ops.invitationDb;
});

afterAll(() => { cleanupTestDb(); });

describe('userDb', () => {
  describe('getOrCreate', () => {
    it('should create a new user if not exists', () => {
      const user = userDb.getOrCreate('alice');
      expect(user.username).toBe('alice');
      expect(user.id).toMatch(/^user_/);
      expect(user.display_name).toBe('alice');
    });

    it('should return existing user', () => {
      const user1 = userDb.getOrCreate('bob');
      const user2 = userDb.getOrCreate('bob');
      expect(user1.id).toBe(user2.id);
    });

    it('should use custom display name', () => {
      const user = userDb.getOrCreate('charlie', 'Charlie D.');
      expect(user.display_name).toBe('Charlie D.');
    });
  });

  describe('createFull', () => {
    it('should create user with all fields', () => {
      const user = userDb.createFull('admin', 'hash123', 'admin@test.com', 'admin');
      expect(user.username).toBe('admin');
      expect(user.password_hash).toBe('hash123');
      expect(user.email).toBe('admin@test.com');
      expect(user.role).toBe('admin');
      expect(user.agent_secret).toBeTruthy();
      expect(user.agent_secret.length).toBe(64); // 32 bytes hex
    });
  });

  describe('migrateUser', () => {
    it('should create user if not exists', () => {
      const user = userDb.migrateUser('newuser', 'hash', 'new@test.com', 'admin');
      expect(user.username).toBe('newuser');
      expect(user.role).toBe('admin');
    });

    it('should upgrade existing user without password', () => {
      userDb.getOrCreate('existing');
      const migrated = userDb.migrateUser('existing', 'hash', 'ex@test.com', 'admin');
      expect(migrated.password_hash).toBe('hash');
      expect(migrated.email).toBe('ex@test.com');
    });

    it('should skip if already migrated', () => {
      userDb.createFull('migrated', 'oldhash', 'old@test.com', 'admin');
      const result = userDb.migrateUser('migrated', 'newhash', 'new@test.com', 'admin');
      expect(result.password_hash).toBe('oldhash'); // unchanged
    });
  });

  describe('CRUD operations', () => {
    it('should get user by id', () => {
      const created = userDb.createFull('byid', 'hash', 'byid@test.com');
      const found = userDb.get(created.id);
      expect(found.username).toBe('byid');
    });

    it('should get user by username', () => {
      userDb.createFull('byname', 'hash', 'bn@test.com');
      const found = userDb.getByUsername('byname');
      expect(found).toBeTruthy();
      expect(found.username).toBe('byname');
    });

    it('should return null for non-existent user', () => {
      expect(userDb.getByUsername('ghost')).toBeUndefined();
    });

    it('should get all users', () => {
      userDb.createFull('u1', 'h1', 'u1@test.com');
      userDb.createFull('u2', 'h2', 'u2@test.com');
      const all = userDb.getAll();
      expect(all.length).toBe(2);
    });

    it('should update login time', () => {
      const user = userDb.createFull('logintest', 'hash', 'lt@test.com');
      userDb.updateLogin(user.id);
      const updated = userDb.get(user.id);
      expect(updated.last_login_at).toBeGreaterThan(0);
    });

    it('should update password', () => {
      const user = userDb.createFull('pwtest', 'oldhash', 'pw@test.com');
      userDb.updatePassword(user.id, 'newhash');
      const updated = userDb.get(user.id);
      expect(updated.password_hash).toBe('newhash');
    });

    it('should update email', () => {
      const user = userDb.createFull('emailtest', 'hash', 'old@test.com');
      userDb.updateEmail(user.id, 'new@test.com');
      const updated = userDb.get(user.id);
      expect(updated.email).toBe('new@test.com');
    });

    it('should update role', () => {
      const user = userDb.createFull('roletest', 'hash', 'r@test.com', 'user');
      userDb.updateRole(user.id, 'admin');
      const updated = userDb.get(user.id);
      expect(updated.role).toBe('admin');
    });
  });

  describe('agent secret', () => {
    it('should get agent secret', () => {
      const user = userDb.createFull('sectest', 'hash', 's@test.com');
      const secret = userDb.getAgentSecret(user.id);
      expect(secret).toBe(user.agent_secret);
    });

    it('should reset agent secret', () => {
      const user = userDb.createFull('resettest', 'hash', 'r@test.com');
      const oldSecret = user.agent_secret;
      const newSecret = userDb.resetAgentSecret(user.id);
      expect(newSecret).not.toBe(oldSecret);
      expect(newSecret.length).toBe(64);
    });

    it('should find user by agent secret', () => {
      const user = userDb.createFull('findtest', 'hash', 'f@test.com');
      const found = userDb.getUserByAgentSecret(user.agent_secret);
      expect(found).toBeTruthy();
      expect(found.username).toBe('findtest');
    });

    it('should return null for invalid agent secret', () => {
      expect(userDb.getUserByAgentSecret('nonexistent')).toBeNull();
      expect(userDb.getUserByAgentSecret(null)).toBeNull();
    });
  });

  describe('TOTP', () => {
    it('should update and get TOTP settings', () => {
      userDb.createFull('totpuser', 'hash', 'totp@test.com');
      userDb.updateTotp('totpuser', 'SECRET123', true);
      const totp = userDb.getTotp('totpuser');
      expect(totp.totpSecret).toBe('SECRET123');
      expect(totp.totpEnabled).toBe(true);
    });

    it('should auto-create user for TOTP if not exists', () => {
      userDb.updateTotp('newtotp', 'SECRET', false);
      const totp = userDb.getTotp('newtotp');
      expect(totp).toBeTruthy();
      expect(totp.totpSecret).toBe('SECRET');
    });

    it('should return null for user without TOTP', () => {
      expect(userDb.getTotp('nobody')).toBeNull();
    });
  });
});

describe('sessionDb', () => {
  describe('create', () => {
    it('should create a session', () => {
      const session = sessionDb.create('s1', 'agent1', 'Agent 1', '/work', 'claude_1', 'Title', 'user1');
      expect(session.id).toBe('s1');
      expect(session.agentId).toBe('agent1');
    });

    it('should store all fields correctly', () => {
      sessionDb.create('s2', 'a2', 'A2', '/dir', 'cs2', 'My Title', 'u2');
      const s = sessionDb.get('s2');
      expect(s.agent_id).toBe('a2');
      expect(s.agent_name).toBe('A2');
      expect(s.work_dir).toBe('/dir');
      expect(s.claude_session_id).toBe('cs2');
      expect(s.title).toBe('My Title');
      expect(s.user_id).toBe('u2');
      expect(s.is_active).toBe(1);
    });
  });

  describe('update', () => {
    it('should update claudeSessionId', () => {
      sessionDb.create('s3', 'a3', 'A3', '/d');
      sessionDb.update('s3', { claudeSessionId: 'new_claude_id' });
      const s = sessionDb.get('s3');
      expect(s.claude_session_id).toBe('new_claude_id');
    });

    it('should update title', () => {
      sessionDb.create('s4', 'a4', 'A4', '/d');
      sessionDb.update('s4', { title: 'New Title' });
      const s = sessionDb.get('s4');
      expect(s.title).toBe('New Title');
    });

    it('should not overwrite existing fields with null', () => {
      sessionDb.create('s5', 'a5', 'A5', '/d', 'old_claude', 'Old Title');
      sessionDb.update('s5', {}); // empty update
      const s = sessionDb.get('s5');
      expect(s.claude_session_id).toBe('old_claude');
      expect(s.title).toBe('Old Title');
    });
  });

  describe('setActive', () => {
    it('should set session active/inactive', () => {
      sessionDb.create('s6', 'a6', 'A6', '/d');
      sessionDb.setActive('s6', false);
      let s = sessionDb.get('s6');
      expect(s.is_active).toBe(0);
      sessionDb.setActive('s6', true);
      s = sessionDb.get('s6');
      expect(s.is_active).toBe(1);
    });
  });

  describe('queries', () => {
    it('should check existence', () => {
      expect(sessionDb.exists('nonexistent')).toBe(false);
      sessionDb.create('exists1', 'a', 'A', '/d');
      expect(sessionDb.exists('exists1')).toBe(true);
    });

    it('should get by agent', () => {
      sessionDb.create('sa1', 'agentA', 'AA', '/d');
      sessionDb.create('sa2', 'agentA', 'AA', '/d');
      sessionDb.create('sa3', 'agentB', 'AB', '/d');
      const results = sessionDb.getByAgent('agentA');
      expect(results.length).toBe(2);
    });

    it('should get by user', () => {
      sessionDb.create('su1', 'a', 'A', '/d', null, null, 'userA');
      sessionDb.create('su2', 'a', 'A', '/d', null, null, 'userA');
      sessionDb.create('su3', 'a', 'A', '/d', null, null, 'userB');
      const results = sessionDb.getByUser('userA');
      expect(results.length).toBe(2);
    });

    it('should get by user and agent', () => {
      sessionDb.create('sua1', 'agX', 'AX', '/d', null, null, 'uX');
      sessionDb.create('sua2', 'agX', 'AX', '/d', null, null, 'uX');
      sessionDb.create('sua3', 'agY', 'AY', '/d', null, null, 'uX');
      const results = sessionDb.getByUserAndAgent('uX', 'agX');
      expect(results.length).toBe(2);
    });

    it('should get all sessions with limit', () => {
      for (let i = 0; i < 5; i++) {
        sessionDb.create(`all${i}`, 'a', 'A', '/d');
      }
      const all = sessionDb.getAll(3);
      expect(all.length).toBe(3);
    });

    it('should get active sessions', () => {
      sessionDb.create('act1', 'a', 'A', '/d');
      sessionDb.create('act2', 'a', 'A', '/d');
      sessionDb.setActive('act2', false);
      const active = sessionDb.getActive();
      expect(active.some(s => s.id === 'act1')).toBe(true);
      expect(active.some(s => s.id === 'act2')).toBe(false);
    });
  });

  describe('delete', () => {
    it('should delete session', () => {
      sessionDb.create('del1', 'a', 'A', '/d');
      expect(sessionDb.exists('del1')).toBe(true);
      sessionDb.delete('del1');
      expect(sessionDb.exists('del1')).toBe(false);
    });
  });
});

describe('messageDb', () => {
  let SESSION_ID;

  beforeEach(() => {
    SESSION_ID = `msg_session_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    sessionDb.create(SESSION_ID, 'a', 'A', '/d');
  });

  describe('add', () => {
    it('should add a message and return id', () => {
      const id = messageDb.add(SESSION_ID, 'user', 'Hello');
      expect(id).toBeGreaterThan(0);
    });

    it('should add message with full metadata', () => {
      messageDb.add(SESSION_ID, 'assistant', 'result', 'tool_use', 'Read', '{"path":"/tmp"}');
      const msgs = messageDb.getBySession(SESSION_ID);
      expect(msgs.length).toBe(1);
      expect(msgs[0].tool_name).toBe('Read');
      expect(msgs[0].tool_input).toBe('{"path":"/tmp"}');
    });

    it('should update session updated_at on add', async () => {
      const s1 = sessionDb.get(SESSION_ID);
      await new Promise(r => setTimeout(r, 10));
      messageDb.add(SESSION_ID, 'user', 'Hello');
      const s2 = sessionDb.get(SESSION_ID);
      expect(s2.updated_at).toBeGreaterThanOrEqual(s1.updated_at);
    });
  });

  describe('getBySession', () => {
    it('should return messages in chronological order', () => {
      messageDb.add(SESSION_ID, 'user', 'First');
      messageDb.add(SESSION_ID, 'assistant', 'Second');
      messageDb.add(SESSION_ID, 'user', 'Third');
      const msgs = messageDb.getBySession(SESSION_ID);
      expect(msgs.length).toBe(3);
      expect(msgs[0].content).toBe('First');
      expect(msgs[2].content).toBe('Third');
    });
  });

  describe('getRecent', () => {
    it('should return last N messages in chronological order', () => {
      for (let i = 1; i <= 10; i++) {
        messageDb.add(SESSION_ID, 'user', `msg${i}`);
      }
      const recent = messageDb.getRecent(SESSION_ID, 3);
      expect(recent.length).toBe(3);
      expect(recent[0].content).toBe('msg8');
      expect(recent[2].content).toBe('msg10');
    });
  });

  describe('pagination', () => {
    it('should get messages before id', () => {
      const ids = [];
      for (let i = 1; i <= 10; i++) {
        ids.push(messageDb.add(SESSION_ID, 'user', `msg${i}`));
      }
      const before = messageDb.getBeforeId(SESSION_ID, ids[5], 3);
      expect(before.length).toBe(3);
      // Should be messages 3, 4, 5 (ids[2], ids[3], ids[4])
      expect(before[0].content).toBe('msg3');
      expect(before[2].content).toBe('msg5');
    });

    it('should get messages after id', () => {
      const ids = [];
      for (let i = 1; i <= 10; i++) {
        ids.push(messageDb.add(SESSION_ID, 'user', `msg${i}`));
      }
      const after = messageDb.getAfterId(SESSION_ID, ids[7]);
      expect(after.length).toBe(2);
      expect(after[0].content).toBe('msg9');
      expect(after[1].content).toBe('msg10');
    });
  });

  describe('getCount', () => {
    it('should return correct count', () => {
      expect(messageDb.getCount(SESSION_ID)).toBe(0);
      messageDb.add(SESSION_ID, 'user', 'Hello');
      messageDb.add(SESSION_ID, 'assistant', 'Hi');
      expect(messageDb.getCount(SESSION_ID)).toBe(2);
    });
  });

  describe('deleteBySession', () => {
    it('should delete all messages for session', () => {
      messageDb.add(SESSION_ID, 'user', 'Hello');
      messageDb.add(SESSION_ID, 'assistant', 'Hi');
      messageDb.deleteBySession(SESSION_ID);
      expect(messageDb.getCount(SESSION_ID)).toBe(0);
    });
  });
});

describe('invitationDb', () => {
  let userId;

  beforeEach(() => {
    const user = userDb.createFull('inviter', 'hash', 'inv@test.com', 'admin');
    userId = user.id;
  });

  describe('create', () => {
    it('should create an invitation', () => {
      const inv = invitationDb.create(userId, 'user');
      expect(inv.code).toBeTruthy();
      expect(inv.code.length).toBe(12); // 6 random bytes = 12 hex chars
      expect(inv.role).toBe('user');
      expect(inv.expiresAt).toBeGreaterThan(Date.now());
    });
  });

  describe('get', () => {
    it('should find existing invitation', () => {
      const inv = invitationDb.create(userId);
      const found = invitationDb.get(inv.code);
      expect(found).toBeTruthy();
      expect(found.id).toBe(inv.code);
      expect(found.created_by).toBe(userId);
    });

    it('should return null for non-existent code', () => {
      expect(invitationDb.get('nonexistent')).toBeNull();
    });
  });

  describe('use', () => {
    it('should mark invitation as used', () => {
      const inv = invitationDb.create(userId);
      invitationDb.use(inv.code, 'new_user_id');
      const found = invitationDb.get(inv.code);
      expect(found.used_by).toBe('new_user_id');
      expect(found.used_at).toBeGreaterThan(0);
    });
  });

  describe('getByUser', () => {
    it('should list user invitations', () => {
      invitationDb.create(userId);
      invitationDb.create(userId);
      const list = invitationDb.getByUser(userId);
      expect(list.length).toBe(2);
    });
  });

  describe('delete', () => {
    it('should delete unused invitation', () => {
      const inv = invitationDb.create(userId);
      const deleted = invitationDb.delete(inv.code, userId);
      expect(deleted).toBe(true);
      expect(invitationDb.get(inv.code)).toBeNull();
    });

    it('should not delete used invitation', () => {
      const inv = invitationDb.create(userId);
      invitationDb.use(inv.code, 'someone');
      const deleted = invitationDb.delete(inv.code, userId);
      expect(deleted).toBe(false);
    });

    it('should not delete other user invitation', () => {
      const inv = invitationDb.create(userId);
      const deleted = invitationDb.delete(inv.code, 'other_user');
      expect(deleted).toBe(false);
    });
  });

  describe('cleanup', () => {
    it('should remove expired unused invitations', () => {
      // Create an already-expired invitation by direct SQL
      db.prepare('INSERT INTO invitations (id, created_by, created_at, expires_at, role) VALUES (?, ?, ?, ?, ?)').run(
        'expired_code', userId, Date.now() - 200000, Date.now() - 100000, 'user'
      );
      expect(invitationDb.get('expired_code')).toBeTruthy();
      invitationDb.cleanup();
      expect(invitationDb.get('expired_code')).toBeNull();
    });
  });
});
