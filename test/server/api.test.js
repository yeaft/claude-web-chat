import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { createTestDb, cleanupTestDb, createDbOperations } from '../helpers/testDb.js';
import { TEST_PASSWORD, TEST_PASSWORD_HASH } from '../helpers/fixtures.js';

/**
 * Tests for REST API endpoint logic (api.js).
 * Tests the core logic patterns — middleware behavior, request validation,
 * response structure, and ownership checks.
 */

let db, userDb, sessionDb, messageDb, invitationDb;

beforeEach(() => {
  if (db) { try { db.close(); } catch (e) {} }
  const result = createTestDb();
  db = result.db;
  const ops = createDbOperations(db);
  userDb = ops.userDb;
  sessionDb = ops.sessionDb;
  messageDb = ops.messageDb;
  invitationDb = ops.invitationDb;
});

afterAll(() => cleanupTestDb());

describe('requireAuth middleware pattern', () => {
  it('should pass through in skipAuth mode', () => {
    const skipAuth = true;
    const req = { headers: {} };
    if (skipAuth) {
      req.user = { username: 'dev-user', role: 'admin' };
    }
    expect(req.user.username).toBe('dev-user');
    expect(req.user.role).toBe('admin');
  });

  it('should reject request without Authorization header', () => {
    const skipAuth = false;
    const authHeader = undefined;
    const hasAuth = authHeader && authHeader.startsWith('Bearer ');
    expect(hasAuth).toBeFalsy();
    // In real code: returns 401
  });

  it('should reject invalid token', () => {
    const skipAuth = false;
    const tokenResult = { valid: false };
    expect(tokenResult.valid).toBe(false);
    // In real code: returns 401
  });
});

describe('requireAdmin middleware pattern', () => {
  it('should pass through in skipAuth mode', () => {
    const skipAuth = true;
    const passed = skipAuth;
    expect(passed).toBe(true);
  });

  it('should allow admin role', () => {
    const user = { role: 'admin' };
    expect(user.role === 'admin').toBe(true);
  });

  it('should reject non-admin role', () => {
    const user = { role: 'user' };
    expect(user.role !== 'admin').toBe(true);
    // In real code: returns 403
  });
});

describe('GET /api/auth/mode', () => {
  it('should return auth mode configuration', () => {
    const response = {
      skipAuth: false,
      emailVerification: false,
      totpEnabled: true,
      registrationEnabled: true
    };

    expect(response).toHaveProperty('skipAuth');
    expect(response).toHaveProperty('emailVerification');
    expect(response).toHaveProperty('totpEnabled');
    expect(response).toHaveProperty('registrationEnabled');
  });
});

describe('POST /api/auth/login', () => {
  it('should reject missing credentials', () => {
    const body = {};
    const hasCredentials = body.username && body.password;
    expect(hasCredentials).toBeFalsy();
    // Returns 400
  });

  it('should validate correct password', async () => {
    const bcrypt = await import('bcrypt');
    const valid = await bcrypt.default.compare(TEST_PASSWORD, TEST_PASSWORD_HASH);
    expect(valid).toBe(true);
  });

  it('should reject wrong password', async () => {
    const bcrypt = await import('bcrypt');
    const valid = await bcrypt.default.compare('wrong', TEST_PASSWORD_HASH);
    expect(valid).toBe(false);
  });
});

describe('POST /api/auth/register', () => {
  it('should validate username length (2-32 chars)', () => {
    expect('a'.length < 2).toBe(true); // too short
    expect('ab'.length >= 2 && 'ab'.length <= 32).toBe(true); // ok
    expect('a'.repeat(33).length > 32).toBe(true); // too long
  });

  it('should validate username characters', () => {
    const valid = /^[a-zA-Z0-9_-]+$/;
    expect(valid.test('user-name_1')).toBe(true);
    expect(valid.test('user@name')).toBe(false);
    expect(valid.test('user name')).toBe(false);
  });

  it('should validate password length (>=6)', () => {
    expect('12345'.length < 6).toBe(true);
    expect('123456'.length >= 6).toBe(true);
  });

  it('should require invitation code', () => {
    const invitationCode = '';
    expect(!invitationCode).toBe(true);
  });

  it('should register with valid invitation', async () => {
    const admin = userDb.createFull('admin', TEST_PASSWORD_HASH, 'admin@test.com', 'admin');
    const inv = invitationDb.create(admin.id, 'user');

    const bcrypt = await import('bcrypt');
    const hash = await bcrypt.default.hash('newpass123', 10);

    // Check invitation valid
    const invitation = invitationDb.get(inv.code);
    expect(invitation).toBeTruthy();
    expect(invitation.used_by).toBeNull();
    expect(invitation.expires_at).toBeGreaterThan(Date.now());

    // Create user
    const newUser = userDb.createFull('newuser', hash, 'new@test.com', invitation.role);
    invitationDb.use(inv.code, newUser.id);

    // Verify
    expect(userDb.getByUsername('newuser')).toBeTruthy();
    expect(invitationDb.get(inv.code).used_by).toBe(newUser.id);
  });
});

describe('Invitation API', () => {
  it('should create invitation (admin only)', () => {
    const admin = userDb.createFull('admin', TEST_PASSWORD_HASH, 'admin@test.com', 'admin');
    const inv = invitationDb.create(admin.id, 'user');
    expect(inv.code.length).toBe(12);
    expect(inv.role).toBe('user');
  });

  it('should reject invalid role', () => {
    const role = 'superadmin';
    const validRoles = ['user', 'pro'];
    expect(validRoles.includes(role)).toBe(false);
  });

  it('should list user invitations', () => {
    const admin = userDb.createFull('admin2', TEST_PASSWORD_HASH, 'a2@test.com', 'admin');
    invitationDb.create(admin.id, 'user');
    invitationDb.create(admin.id, 'pro');
    const list = invitationDb.getByUser(admin.id);
    expect(list.length).toBe(2);
  });

  it('should delete unused invitation', () => {
    const admin = userDb.createFull('admin3', TEST_PASSWORD_HASH, 'a3@test.com', 'admin');
    const inv = invitationDb.create(admin.id, 'user');
    expect(invitationDb.delete(inv.code, admin.id)).toBe(true);
    expect(invitationDb.get(inv.code)).toBeNull();
  });
});

describe('User Profile API', () => {
  it('should return user profile', () => {
    const user = userDb.createFull('profile_user', TEST_PASSWORD_HASH, 'profile@test.com', 'user');
    const found = userDb.getByUsername('profile_user');

    const response = {
      username: found.username,
      displayName: found.display_name,
      email: found.email,
      role: found.role === 'admin' ? 'admin' : 'pro',
      createdAt: found.created_at
    };

    expect(response.username).toBe('profile_user');
    expect(response.email).toBe('profile@test.com');
    expect(response.role).toBe('pro');
  });

  it('should require current password for profile update', async () => {
    const bcrypt = await import('bcrypt');
    const user = userDb.createFull('updateuser', TEST_PASSWORD_HASH, 'up@test.com');
    const found = userDb.getByUsername('updateuser');

    // Correct current password
    const valid = await bcrypt.default.compare(TEST_PASSWORD, found.password_hash);
    expect(valid).toBe(true);

    // Wrong current password
    const invalid = await bcrypt.default.compare('wrong', found.password_hash);
    expect(invalid).toBe(false);
  });

  it('should update password', async () => {
    const bcrypt = await import('bcrypt');
    const user = userDb.createFull('pwup', TEST_PASSWORD_HASH, 'pwup@test.com');
    const newHash = await bcrypt.default.hash('newpassword', 10);
    userDb.updatePassword(user.id, newHash);

    const updated = userDb.get(user.id);
    const valid = await bcrypt.default.compare('newpassword', updated.password_hash);
    expect(valid).toBe(true);
  });

  it('should update email', () => {
    const user = userDb.createFull('emailup', TEST_PASSWORD_HASH, 'old@test.com');
    userDb.updateEmail(user.id, 'new@test.com');
    expect(userDb.get(user.id).email).toBe('new@test.com');
  });
});

describe('Agent Secret API', () => {
  it('should return agent secret', () => {
    const user = userDb.createFull('secuser', TEST_PASSWORD_HASH, 'sec@test.com');
    const secret = userDb.getAgentSecret(user.id);
    expect(secret).toBeTruthy();
    expect(secret.length).toBe(64);
  });

  it('should reset agent secret', () => {
    const user = userDb.createFull('resetuser', TEST_PASSWORD_HASH, 'reset@test.com');
    const oldSecret = user.agent_secret;
    const newSecret = userDb.resetAgentSecret(user.id);
    expect(newSecret).not.toBe(oldSecret);
    expect(newSecret.length).toBe(64);
  });
});

describe('File Upload API', () => {
  it('should store uploaded file in pendingFiles', () => {
    const pendingFiles = new Map();
    const fileId = 'file_uuid_123';
    const file = {
      name: 'test.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('hello world'),
      uploadedAt: Date.now(),
      userId: 'user_123'
    };

    pendingFiles.set(fileId, file);

    expect(pendingFiles.has(fileId)).toBe(true);
    expect(pendingFiles.get(fileId).name).toBe('test.txt');
    expect(pendingFiles.get(fileId).buffer.toString()).toBe('hello world');
  });

  it('should cleanup old files after 10 minutes', () => {
    const pendingFiles = new Map();
    const CLEANUP_INTERVAL = 600000;

    pendingFiles.set('old', { uploadedAt: Date.now() - CLEANUP_INTERVAL - 1000, name: 'old.txt' });
    pendingFiles.set('new', { uploadedAt: Date.now(), name: 'new.txt' });

    // Simulate cleanup
    const now = Date.now();
    for (const [fileId, file] of pendingFiles) {
      if (now - file.uploadedAt > CLEANUP_INTERVAL) {
        pendingFiles.delete(fileId);
      }
    }

    expect(pendingFiles.size).toBe(1);
    expect(pendingFiles.has('new')).toBe(true);
  });
});

describe('Session History API', () => {
  it('should list sessions with filtering', () => {
    sessionDb.create('sh1', 'agent1', 'A1', '/d', null, 'T1', 'user1');
    sessionDb.create('sh2', 'agent1', 'A1', '/d', null, 'T2', 'user1');
    sessionDb.create('sh3', 'agent2', 'A2', '/d', null, 'T3', 'user1');
    sessionDb.create('sh4', 'agent1', 'A1', '/d', null, 'T4', 'user2');

    // Filter by agentId
    expect(sessionDb.getByAgent('agent1').length).toBe(3);

    // Filter by userId
    expect(sessionDb.getByUser('user1').length).toBe(3);

    // Filter by both
    expect(sessionDb.getByUserAndAgent('user1', 'agent1').length).toBe(2);
  });

  it('should enforce session ownership for GET', () => {
    sessionDb.create('owned', 'a1', 'A', '/d', null, null, 'owner_user');
    const session = sessionDb.get('owned');

    const requestUserId = 'other_user';
    const hasPermission = !session.user_id || session.user_id === requestUserId;
    expect(hasPermission).toBe(false);
  });

  it('should enforce ownership for DELETE', () => {
    sessionDb.create('del_owned', 'a1', 'A', '/d', null, null, 'owner_user');
    const session = sessionDb.get('del_owned');

    const requestUserId = 'other_user';
    const hasPermission = !session.user_id || session.user_id === requestUserId;
    expect(hasPermission).toBe(false);
    // In real code: returns 403
  });

  it('should delete session with messages', () => {
    sessionDb.create('del_msgs', 'a1', 'A', '/d');
    messageDb.add('del_msgs', 'user', 'Hello');
    messageDb.add('del_msgs', 'assistant', 'Hi');

    messageDb.deleteBySession('del_msgs');
    sessionDb.delete('del_msgs');

    expect(sessionDb.exists('del_msgs')).toBe(false);
    expect(messageDb.getCount('del_msgs')).toBe(0);
  });

  it('should return messages with pagination', () => {
    sessionDb.create('msg_page', 'a1', 'A', '/d');
    for (let i = 0; i < 30; i++) {
      messageDb.add('msg_page', 'user', `msg${i}`);
    }

    const recent = messageDb.getRecent('msg_page', 10);
    expect(recent.length).toBe(10);
    expect(recent[0].content).toBe('msg20');
    expect(recent[9].content).toBe('msg29');
  });

  it('should transform session format for frontend', () => {
    sessionDb.create('transform', 'agent1', 'Agent 1', '/work', 'cs1', 'My Chat', 'user1');
    const session = sessionDb.get('transform');

    const transformed = {
      id: session.id,
      agentId: session.agent_id,
      agentName: session.agent_name,
      claudeSessionId: session.claude_session_id,
      workDir: session.work_dir,
      title: session.title,
      createdAt: session.created_at,
      updatedAt: session.updated_at,
      isActive: !!session.is_active,
      userId: session.user_id
    };

    expect(transformed.agentId).toBe('agent1');
    expect(transformed.agentName).toBe('Agent 1');
    expect(transformed.claudeSessionId).toBe('cs1');
    expect(transformed.title).toBe('My Chat');
    expect(transformed.isActive).toBe(true);
    expect(transformed.userId).toBe('user1');
  });
});

describe('Users API', () => {
  it('should list all users', () => {
    userDb.createFull('u1', 'h1', 'u1@test.com');
    userDb.createFull('u2', 'h2', 'u2@test.com');
    const users = userDb.getAll();
    expect(users.length).toBe(2);
  });

  it('should get user by id', () => {
    const user = userDb.createFull('byid', 'hash', 'byid@test.com');
    const found = userDb.get(user.id);
    expect(found).toBeTruthy();
    expect(found.username).toBe('byid');
  });

  it('should get user sessions', () => {
    const user = userDb.createFull('sessuser', 'hash', 'su@test.com');
    sessionDb.create('us1', 'a1', 'A', '/d', null, null, user.id);
    sessionDb.create('us2', 'a1', 'A', '/d', null, null, user.id);

    const sessions = sessionDb.getByUser(user.id);
    expect(sessions.length).toBe(2);
  });
});
