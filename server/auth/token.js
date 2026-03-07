import jwt from 'jsonwebtoken';
import { CONFIG, getUserByUsername } from '../config.js';
import { generateSessionKey } from '../encryption.js';
import { activeSessions, revokedTokens } from './session-store.js';

/**
 * Verify JWT token and get session data
 */
export function verifyToken(token) {
  try {
    const decoded = jwt.verify(token, CONFIG.jwtSecret);

    if (revokedTokens.has(token)) {
      return { valid: false };
    }

    let session = activeSessions.get(token);

    // Token 有效但 session 不存在（如服务器重启后），重建 session
    if (!session) {
      const sessionKey = generateSessionKey();
      session = { username: decoded.username, sessionKey };
      activeSessions.set(token, session);
    }

    const user = getUserByUsername(decoded.username);

    return {
      valid: true,
      username: decoded.username,
      sessionKey: session.sessionKey,
      role: user?.role === 'admin' ? 'admin' : 'pro'
    };
  } catch (err) {
    return { valid: false };
  }
}

/**
 * Invalidate a session (logout)
 */
export function logout(token) {
  activeSessions.delete(token);
  revokedTokens.add(token);
}
