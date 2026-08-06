import { randomUUID } from 'crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { completeLogin } from '../../server/auth/login.js';
import { storePendingResult } from '../../server/auth/oauth-flow.js';
import { registerAuthRoutes } from '../../server/routes/auth-routes.js';
import { logout, verifyToken } from '../../server/auth/token.js';
import { generateSessionKey } from '../../server/encryption.js';
import { activeSessions, revokedTokens } from '../../server/auth/session-store.js';
import { getUserByUsername } from '../../server/config.js';
import { userDb } from '../../server/database.js';

const createdUserIds = [];

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
