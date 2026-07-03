import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { completeLogin } from '../../server/auth/login.js';
import { logout, verifyToken } from '../../server/auth/token.js';
import { generateSessionKey } from '../../server/encryption.js';
import { activeSessions, revokedTokens } from '../../server/auth/session-store.js';

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
    vi.useRealTimers();
  });

  it('issues unique JWTs for repeated logins in the same second', () => {
    const first = completeLogin('same-user', generateSessionKey(), 'pro');
    const second = completeLogin('same-user', generateSessionKey(), 'pro');

    expect(first.token).not.toBe(second.token);
    expect(activeSessions.has(first.token)).toBe(true);
    expect(activeSessions.has(second.token)).toBe(true);
  });

  it('does not let logging out an old same-second session revoke a new login', () => {
    const first = completeLogin('same-user', generateSessionKey(), 'pro');
    const second = completeLogin('same-user', generateSessionKey(), 'pro');

    logout(first.token);

    expect(verifyToken(first.token).valid).toBe(false);
    expect(verifyToken(second.token).valid).toBe(true);
  });
});
