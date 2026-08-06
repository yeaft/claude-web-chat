import { randomUUID } from 'crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { completeLogin } from '../../server/auth/login.js';
import { storePendingResult } from '../../server/auth/oauth-flow.js';
import { registerAuthRoutes } from '../../server/routes/auth-routes.js';
import { logout, verifyToken } from '../../server/auth/token.js';
import { generateSessionKey } from '../../server/encryption.js';
import { activeSessions, revokedTokens } from '../../server/auth/session-store.js';
import { CONFIG, getUserByUsername } from '../../server/config.js';
import db, { userDb } from '../../server/database.js';

const createdUserIds = [];
const configuredUsernames = [];
const tombstoneUsernames = [];

function configureUser(username) {
  CONFIG.users.push({
    username,
    passwordHash: 'configured-password-hash',
    email: `${username}@example.test`
  });
  configuredUsernames.push(username);
}

function createSsoOnlyUser(username, role = 'admin') {
  const existing = userDb.getByUsername(username);
  if (existing) return existing;
  const user = userDb.createFromAad(
    username,
    `${username}@example.test`,
    `test-${randomUUID()}`,
    role,
    username
  );
  createdUserIds.push(user.id);
  return user;
}

describe('session token issuance', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-03T08:30:00Z'));
    activeSessions.clear();
    revokedTokens.clear();
  });

  afterEach(() => {
    activeSessions.clear();
    revokedTokens.clear();
    while (createdUserIds.length > 0) {
      const id = createdUserIds.pop();
      try { userDb.deleteUser(id); } catch {
        // ignore cleanup failures from already-deleted rows
      }
    }
    while (configuredUsernames.length > 0) {
      const username = configuredUsernames.pop();
      const index = CONFIG.users.findIndex(candidate => candidate.username === username);
      if (index !== -1) CONFIG.users.splice(index, 1);
    }
    while (tombstoneUsernames.length > 0) {
      const username = tombstoneUsernames.pop();
      try {
        db.prepare('DELETE FROM user_deletion_tombstones WHERE username = ?').run(username);
      } catch {
        // The regression test runs once against the pre-tombstone schema.
      }
    }
    vi.useRealTimers();
  });

  it('issues unique JWTs for repeated logins in the same second', () => {
    createSsoOnlyUser('same-user', 'pro');
    const first = completeLogin('same-user', generateSessionKey(), 'pro');
    const second = completeLogin('same-user', generateSessionKey(), 'pro');

    expect(first.token).not.toBe(second.token);
    expect(activeSessions.has(first.token)).toBe(true);
    expect(activeSessions.has(second.token)).toBe(true);
  });

  it('does not let logging out an old same-second session revoke a new login', () => {
    createSsoOnlyUser('same-user', 'pro');
    const first = completeLogin('same-user', generateSessionKey(), 'pro');
    const second = completeLogin('same-user', generateSessionKey(), 'pro');

    logout(first.token);

    expect(verifyToken(first.token).valid).toBe(false);
    expect(verifyToken(second.token).valid).toBe(true);
  });

  it('loads SSO-only users without requiring a password hash', () => {
    createSsoOnlyUser('sso-only-admin', 'admin');

    const user = getUserByUsername('sso-only-admin');

    expect(user).toMatchObject({
      username: 'sso-only-admin',
      passwordHash: null,
      role: 'admin',
    });
  });

  it('does not fall back to configured credentials for a pending database user', () => {
    const user = createSsoOnlyUser('pending-config-user');
    CONFIG.users.push({
      username: user.username,
      passwordHash: 'configured-password-hash',
      email: 'pending-config-user@example.test'
    });
    userDb.beginDeletion(user.id);

    expect(getUserByUsername(user.username)).toBeNull();

    CONFIG.users.splice(CONFIG.users.findIndex(candidate => candidate.username === user.username), 1);
  });

  it('never restores configured credentials when migration sees a deleted database user', () => {
    const user = createSsoOnlyUser('deleted-config-user');
    db.prepare('DELETE FROM user_deletion_tombstones WHERE username = ?').run(user.username);
    tombstoneUsernames.push(user.username);
    userDb.beginDeletion(user.id);
    const deleted = userDb.get(user.id);
    createdUserIds.splice(createdUserIds.indexOf(user.id), 1);

    expect(userDb.migrateUser(
      user.username, 'restored-password-hash', 'restored@example.test', 'admin'
    )).toMatchObject({
      deletion_state: 'pending',
      password_hash: null,
      agent_secret: null
    });
    expect(userDb.get(user.id)).toMatchObject({
      deletion_id: deleted.deletion_id,
      password_hash: null,
      agent_secret: null
    });

    userDb.deleteUser(user.id, { requirePending: true });
  });

  it('deletes retired managed-Sandbox rows before finalizing account deletion', () => {
    const user = createSsoOnlyUser('legacy-sandbox-user');
    const hostId = `host-${user.id}`;
    const sandboxId = `sandbox-${user.id}`;
    db.prepare(`
      INSERT INTO sandbox_hosts (
        id, epoch, qualified, controller_healthy, helper_healthy, runtime_healthy,
        quota_healthy, network_healthy, image_digest, cpu_millis_total,
        memory_mib_total, memory_mib_available, disk_gib_total, updated_at
      ) VALUES (?, 1, 0, 0, 0, 0, 0, 0, 'sha256:legacy', 1000, 1024, 1024, 10, ?)
    `).run(hostId, Date.now());
    db.prepare(`
      INSERT INTO sandboxes (
        id, user_id, host_id, host_epoch, agent_name, size_id, cpu_millis,
        memory_mib, disk_gib, desired_state, observed_state, generation,
        instance_id, image_digest, reservation_held, created_at, updated_at
      ) VALUES (?, ?, ?, 1, 'legacy', 'small', 1000, 1024, 10,
        'removed', 'removed', 1, 'legacy-instance', 'sha256:legacy', 0, ?, ?)
    `).run(sandboxId, user.id, hostId, Date.now(), Date.now());

    userDb.beginDeletion(user.id);
    expect(userDb.deleteUser(user.id, { requirePending: true })).toBe(true);
    createdUserIds.splice(createdUserIds.indexOf(user.id), 1);
    expect(db.prepare('SELECT id FROM sandboxes WHERE id = ?').get(sandboxId)).toBeUndefined();
  });

  it('keeps a finalized configured-user deletion authoritative for fallback and startup migration', () => {
    const username = 'finalized-config-user';
    configureUser(username);
    tombstoneUsernames.push(username);
    const user = userDb.migrateUser(
      username, 'configured-password-hash', `${username}@example.test`, 'admin'
    );
    createdUserIds.push(user.id);
    userDb.beginDeletion(user.id);
    expect(userDb.deleteUser(user.id, { requirePending: true })).toBe(true);
    createdUserIds.splice(createdUserIds.indexOf(user.id), 1);

    expect(userDb.getByUsername(username)).toBeUndefined();
    expect(getUserByUsername(username)).toBeNull();
    expect(userDb.migrateUser(
      username, 'configured-password-hash', `${username}@example.test`, 'admin'
    )).toBeNull();
    expect(userDb.getByUsername(username)).toBeUndefined();
  });

  it('preserves SSO-only user roles when verifying a freshly issued JWT', async () => {
    createSsoOnlyUser('sso-only-admin-token', 'admin');
    const login = completeLogin('sso-only-admin-token', generateSessionKey(), 'admin');

    expect(login.userId).toBe(getUserByUsername('sso-only-admin-token').id);
    expect(verifyToken(login.token)).toMatchObject({
      valid: true,
      username: 'sso-only-admin-token',
      role: 'admin',
    });

    const routes = new Map();
    const app = {
      get: (path, ...handlers) => routes.set(`GET ${path}`, handlers),
      post: (path, ...handlers) => routes.set(`POST ${path}`, handlers),
      delete: (path, ...handlers) => routes.set(`DELETE ${path}`, handlers),
    };
    registerAuthRoutes(app, {
      requireAuth: (_req, _res, next) => next(),
      checkRateLimit: () => true,
    });
    const state = `qr-user-id-${randomUUID()}`;
    storePendingResult(state, { kind: 'login', ...login });
    const response = {
      body: null,
      cookie: vi.fn(),
      json(body) { this.body = body; return this; },
    };
    const handlers = routes.get('GET /api/auth/sso/poll/:state');
    await handlers[0]({ params: { state }, headers: {} }, response);
    expect(response.cookie).toHaveBeenCalled();
    expect(response.body).toMatchObject({
      status: 'login',
      token: login.token,
      userId: login.userId,
      role: 'admin',
    });
  });
});
