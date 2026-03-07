import bcrypt from 'bcrypt';
import { CONFIG } from '../config.js';
import { generateSessionKey } from '../encryption.js';
import { userDb, invitationDb } from '../database.js';

/**
 * Verify agent connection using per-user agent_secret or global fallback
 */
export function verifyAgent(secret) {
  // 1. Try per-user agent secret
  const user = userDb.getUserByAgentSecret(secret);
  if (user) {
    const sessionKey = generateSessionKey();
    return {
      valid: true,
      sessionKey,
      userId: user.id,
      username: user.username
    };
  }

  // 2. Fallback: global AGENT_SECRET (backward compat)
  if (CONFIG.agentSecret && secret === CONFIG.agentSecret) {
    const sessionKey = generateSessionKey();
    return { valid: true, sessionKey, userId: null, username: null };
  }

  return { valid: false };
}

/**
 * Register a new user via invitation code
 */
export async function register(username, password, email, invitationCode) {
  if (CONFIG.skipAuth) {
    return { success: false, error: 'Registration disabled in development mode' };
  }

  if (!username || username.length < 2 || username.length > 32) {
    return { success: false, error: 'Username must be 2-32 characters' };
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(username)) {
    return { success: false, error: 'Username can only contain letters, numbers, hyphens and underscores' };
  }
  if (!password || password.length < 6) {
    return { success: false, error: 'Password must be at least 6 characters' };
  }
  if (!invitationCode) {
    return { success: false, error: 'Invitation code is required' };
  }

  const invitation = invitationDb.get(invitationCode);
  if (!invitation) {
    return { success: false, error: 'Invalid invitation code' };
  }
  if (invitation.used_by) {
    return { success: false, error: 'Invitation code already used' };
  }
  if (invitation.expires_at < Date.now()) {
    return { success: false, error: 'Invitation code has expired' };
  }

  const existing = userDb.getByUsername(username);
  if (existing && existing.password_hash) {
    return { success: false, error: 'Username already exists' };
  }

  const passwordHash = await bcrypt.hash(password, 10);
  const role = invitation.role === 'admin' ? 'admin' : 'pro';

  let user;
  if (existing && !existing.password_hash) {
    userDb.updatePassword(existing.id, passwordHash);
    if (email) userDb.updateEmail(existing.id, email);
    userDb.updateRole(existing.id, role);
    if (!existing.agent_secret) {
      userDb.resetAgentSecret(existing.id);
    }
    user = existing;
  } else {
    user = userDb.createFull(username, passwordHash, email || null, role);
  }

  invitationDb.use(invitationCode, user.id);

  return { success: true, message: 'Registration successful' };
}
