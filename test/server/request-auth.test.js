import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { completeLogin } from '../../server/auth/login.js';
import { activeSessions, revokedTokens } from '../../server/auth/session-store.js';
import { userDb } from '../../server/database.js';
import { registerAuthRoutes } from '../../server/routes/auth-routes.js';
import {
  SESSION_COOKIE_NAME,
  authenticateRequest,
  clearSessionCookie,
  setSessionCookie,
} from '../../server/auth/request-auth.js';

const createdUserIds = [];

function issue(username) {
  let user = userDb.getByUsername(username);
  if (!user) {
    user = userDb.getOrCreate(username);
    createdUserIds.push(user.id);
  }
  return completeLogin(username, `session-key-${username}`).token;
}

describe('request authentication', () => {
  beforeEach(() => {
    activeSessions.clear();
    revokedTokens.clear();
  });

  afterEach(() => {
    activeSessions.clear();
    revokedTokens.clear();
    while (createdUserIds.length > 0) userDb.deleteUser(createdUserIds.pop());
  });

  it('falls back to the browser cookie when an explicit bearer token is stale', () => {
    const cookieToken = issue('cookie-user');
    const result = authenticateRequest({
      authorizationHeader: 'Bearer stale-token',
      cookieHeader: `${SESSION_COOKIE_NAME}=${encodeURIComponent(cookieToken)}`,
    });

    expect(result).toMatchObject({ valid: true, username: 'cookie-user', token: cookieToken, source: 'cookie' });
  });

  it('uses the same cookie authentication for requests without a JS token', () => {
    const cookieToken = issue('mobile-user');
    const result = authenticateRequest({ cookieHeader: `theme=dark; ${SESSION_COOKIE_NAME}=${cookieToken}` });

    expect(result).toMatchObject({ valid: true, username: 'mobile-user', source: 'cookie' });
  });

  it('sets a secure HttpOnly same-origin session cookie behind HTTPS proxying', () => {
    const token = issue('secure-user');
    const res = { cookie: (...args) => { res.args = args; } };

    setSessionCookie({ headers: { 'x-forwarded-proto': 'https' } }, res, token);

    expect(res.args[0]).toBe(SESSION_COOKIE_NAME);
    expect(res.args[1]).toBe(token);
    expect(res.args[2]).toMatchObject({ httpOnly: true, sameSite: 'lax', secure: true, path: '/' });
    expect(res.args[2].maxAge).toBeGreaterThan(0);
  });

  it('clears the cookie with matching security attributes', () => {
    const res = { clearCookie: (...args) => { res.args = args; } };

    clearSessionCookie({ secure: true, headers: {} }, res);

    expect(res.args).toEqual([
      SESSION_COOKIE_NAME,
      { httpOnly: true, sameSite: 'lax', secure: true, path: '/' },
    ]);
  });

  it('revokes and clears a cookie-only session through the logout route', () => {
    const token = issue('logout-user');
    const routes = new Map();
    const app = {
      get() {},
      delete() {},
      post(path, ...handlers) { routes.set(path, handlers.at(-1)); },
    };
    registerAuthRoutes(app, { requireAuth() {}, checkRateLimit: () => true });
    const req = {
      secure: true,
      headers: { cookie: `${SESSION_COOKIE_NAME}=${token}` },
    };
    const res = {
      clearCookie: (...args) => { res.cleared = args; },
      json: body => { res.body = body; return res; },
    };

    routes.get('/api/auth/logout')(req, res);

    expect(revokedTokens.has(token)).toBe(true);
    expect(activeSessions.has(token)).toBe(false);
    expect(res.cleared).toEqual([
      SESSION_COOKIE_NAME,
      { httpOnly: true, sameSite: 'lax', secure: true, path: '/' },
    ]);
    expect(res.body).toEqual({ success: true });
  });
});
