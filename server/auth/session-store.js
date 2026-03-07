import jwt from 'jsonwebtoken';
import { CONFIG } from '../config.js';

// Store pending verifications (tempToken -> { username, code, expiresAt, sessionKey })
export const pendingVerifications = new Map();

// Store pending TOTP verifications (tempToken -> { username, sessionKey, expiresAt })
export const pendingTotpVerifications = new Map();

// Store pending TOTP setup (setupToken -> { username, secret, sessionKey, expiresAt })
export const pendingTotpSetup = new Map();

// Store active sessions (token -> { username, sessionKey })
export const activeSessions = new Map();

// Store revoked tokens
export const revokedTokens = new Set();

/**
 * Clean up expired pending verifications
 */
function cleanupPendingVerifications() {
  const now = Date.now();
  for (const [token, data] of pendingVerifications.entries()) {
    if (data.expiresAt < now) {
      pendingVerifications.delete(token);
    }
  }
  for (const [token, data] of pendingTotpVerifications.entries()) {
    if (data.expiresAt < now) {
      pendingTotpVerifications.delete(token);
    }
  }
  for (const [token, data] of pendingTotpSetup.entries()) {
    if (data.expiresAt < now) {
      pendingTotpSetup.delete(token);
    }
  }
  // 清理过期的 activeSessions 和 revokedTokens（JWT 已过期的）
  for (const [token] of activeSessions.entries()) {
    try {
      jwt.verify(token, CONFIG.jwtSecret);
    } catch {
      activeSessions.delete(token);
    }
  }
  for (const token of revokedTokens) {
    try {
      jwt.verify(token, CONFIG.jwtSecret);
    } catch {
      revokedTokens.delete(token);
    }
  }
}

// Run cleanup every minute
setInterval(cleanupPendingVerifications, 60000);
