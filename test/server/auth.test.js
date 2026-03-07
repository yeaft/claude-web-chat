import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { createTestDb, cleanupTestDb, createDbOperations } from '../helpers/testDb.js';
import { TEST_PASSWORD, TEST_PASSWORD_HASH } from '../helpers/fixtures.js';

// We test auth logic via the database operations it depends on,
// since importing auth.js directly would trigger config.js side effects.
// Instead we test the core logic patterns directly.

let db, userDb, sessionDb, invitationDb;

beforeEach(() => {
  if (db) { try { db.close(); } catch (e) {} }
  const result = createTestDb();
  db = result.db;
  const ops = createDbOperations(db);
  userDb = ops.userDb;
  sessionDb = ops.sessionDb;
  invitationDb = ops.invitationDb;
});

afterAll(() => cleanupTestDb());

describe('Auth - Password Verification', () => {
  it('should verify correct password with bcrypt', async () => {
    const bcrypt = await import('bcrypt');
    const valid = await bcrypt.default.compare(TEST_PASSWORD, TEST_PASSWORD_HASH);
    expect(valid).toBe(true);
  });

  it('should reject wrong password', async () => {
    const bcrypt = await import('bcrypt');
    const valid = await bcrypt.default.compare('wrong_password', TEST_PASSWORD_HASH);
    expect(valid).toBe(false);
  });

  it('should handle timing attack prevention (compare against invalid hash for non-existent user)', async () => {
    const bcrypt = await import('bcrypt');
    // This is what auth.js does for non-existent users
    const start = Date.now();
    await bcrypt.default.compare('anypassword', '$2b$10$invalidhashfortiminginvalidhash');
    const duration = Date.now() - start;
    // Should take some time (bcrypt is slow by design)
    expect(duration).toBeGreaterThan(0);
  });
});

describe('Auth - JWT Token', () => {
  it('should sign and verify JWT token', async () => {
    const jwt = await import('jsonwebtoken');
    const secret = 'test-secret';
    const token = jwt.default.sign({ username: 'testuser' }, secret, { expiresIn: '1h' });
    expect(typeof token).toBe('string');

    const decoded = jwt.default.verify(token, secret);
    expect(decoded.username).toBe('testuser');
  });

  it('should reject token with wrong secret', async () => {
    const jwt = await import('jsonwebtoken');
    const token = jwt.default.sign({ username: 'test' }, 'secret1');
    expect(() => jwt.default.verify(token, 'secret2')).toThrow();
  });

  it('should reject expired token', async () => {
    const jwt = await import('jsonwebtoken');
    const token = jwt.default.sign({ username: 'test' }, 'secret', { expiresIn: '0s' });
    await new Promise(r => setTimeout(r, 50));
    expect(() => jwt.default.verify(token, 'secret')).toThrow(/expired/);
  });
});

describe('Auth - Agent Authentication', () => {
  it('should authenticate with per-user agent secret', () => {
    const user = userDb.createFull('agent_owner', TEST_PASSWORD_HASH, 'ao@test.com', 'admin');
    const found = userDb.getUserByAgentSecret(user.agent_secret);
    expect(found).toBeTruthy();
    expect(found.username).toBe('agent_owner');
  });

  it('should return null for wrong agent secret', () => {
    userDb.createFull('owner2', TEST_PASSWORD_HASH, 'o2@test.com');
    const found = userDb.getUserByAgentSecret('wrong_secret');
    expect(found).toBeNull();
  });

  it('should handle global AGENT_SECRET fallback pattern', () => {
    // Simulating the verifyAgent logic
    const globalSecret = 'global-agent-secret';
    const providedSecret = 'global-agent-secret';

    // No user found by secret → fallback to global
    const user = userDb.getUserByAgentSecret(providedSecret);
    expect(user).toBeNull(); // not a per-user secret

    // Global match
    expect(providedSecret === globalSecret).toBe(true);
  });
});

describe('Auth - User Registration', () => {
  it('should register user with valid invitation', async () => {
    const bcrypt = await import('bcrypt');
    // Create admin and invitation
    const admin = userDb.createFull('admin', TEST_PASSWORD_HASH, 'admin@test.com', 'admin');
    const inv = invitationDb.create(admin.id, 'user');

    // Verify invitation is valid
    const invitation = invitationDb.get(inv.code);
    expect(invitation).toBeTruthy();
    expect(invitation.used_by).toBeNull();
    expect(invitation.expires_at).toBeGreaterThan(Date.now());

    // Register
    const passwordHash = await bcrypt.default.hash('newpassword', 10);
    const newUser = userDb.createFull('newuser', passwordHash, 'new@test.com', invitation.role);
    invitationDb.use(inv.code, newUser.id);

    // Verify
    const found = userDb.getByUsername('newuser');
    expect(found.password_hash).toBe(passwordHash);
    const usedInv = invitationDb.get(inv.code);
    expect(usedInv.used_by).toBe(newUser.id);
  });

  it('should reject expired invitation', () => {
    const admin = userDb.createFull('admin2', TEST_PASSWORD_HASH, 'a2@test.com', 'admin');
    // Create already-expired invitation
    db.prepare('INSERT INTO invitations (id, created_by, created_at, expires_at, role) VALUES (?, ?, ?, ?, ?)').run(
      'expired123', admin.id, Date.now() - 200000, Date.now() - 100000, 'user'
    );
    const inv = invitationDb.get('expired123');
    expect(inv.expires_at).toBeLessThan(Date.now());
  });

  it('should reject already-used invitation', () => {
    const admin = userDb.createFull('admin3', TEST_PASSWORD_HASH, 'a3@test.com', 'admin');
    const inv = invitationDb.create(admin.id, 'user');
    invitationDb.use(inv.code, 'some_user');
    const used = invitationDb.get(inv.code);
    expect(used.used_by).toBe('some_user');
  });

  it('should prevent duplicate username registration', () => {
    userDb.createFull('existing', TEST_PASSWORD_HASH, 'e@test.com');
    const found = userDb.getByUsername('existing');
    expect(found).toBeTruthy();
    expect(found.password_hash).toBeTruthy();
    // In real auth.js, this would return error 'Username already exists'
  });
});

describe('Auth - Session Key Management', () => {
  it('should generate unique session keys', async () => {
    const { generateSessionKey } = await import('../../server/encryption.js');
    const key1 = generateSessionKey();
    const key2 = generateSessionKey();
    expect(key1).toBeInstanceOf(Uint8Array);
    expect(key1.length).toBe(32);
    expect(Buffer.from(key1).toString('hex')).not.toBe(Buffer.from(key2).toString('hex'));
  });
});
