import { randomInt } from 'crypto';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { CONFIG, getUserByUsername, isEmailConfigured, isTotpEnabled, updateUserTotp } from './config.js';
import { sendVerificationCode } from './email.js';
import { generateSessionKey, encodeKey } from './encryption.js';
import { generateTotpSecret, generateTotpQRCode, verifyTotpCode } from './totp.js';
import { userDb, invitationDb } from './database.js';

// Store pending verifications (tempToken -> { username, code, expiresAt, sessionKey })
const pendingVerifications = new Map();

// Store pending TOTP verifications (tempToken -> { username, sessionKey, expiresAt })
const pendingTotpVerifications = new Map();

// Store pending TOTP setup (setupToken -> { username, secret, sessionKey, expiresAt })
const pendingTotpSetup = new Map();

// Store active sessions (token -> { username, sessionKey })
const activeSessions = new Map();

// Store revoked tokens (token -> revokedAt timestamp)
const revokedTokens = new Set();

/**
 * Generate a random verification code
 * @returns {string} Numeric verification code
 */
function generateVerificationCode() {
  const length = CONFIG.emailCodeLength;
  let code = '';
  for (let i = 0; i < length; i++) {
    code += randomInt(10).toString();
  }
  return code;
}

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

/**
 * Helper: complete login and return token + sessionKey + role
 */
function completeLogin(username, sessionKey, role) {
  const token = jwt.sign({ username }, CONFIG.jwtSecret, { expiresIn: CONFIG.jwtExpiresIn });
  activeSessions.set(token, { username, sessionKey });
  return {
    success: true,
    token,
    sessionKey: encodeKey(sessionKey),
    role: role || 'user',
    needTotpCode: false,
    needTotpSetup: false,
    needEmailCode: false
  };
}

/**
 * Authenticate user with username and password (Step 1)
 * @param {string} username
 * @param {string} password
 * @returns {Promise<{success: boolean, tempToken?: string, needEmailCode?: boolean, needTotpCode?: boolean, needTotpSetup?: boolean, role?: string, error?: string}>}
 */
export async function loginStep1(username, password) {
  const user = getUserByUsername(username);

  if (!user) {
    // Use constant-time comparison to prevent timing attacks
    await bcrypt.compare(password, '$2b$10$invalidhashfortiminginvalidhash');
    return { success: false, error: 'Invalid username or password' };
  }

  const passwordValid = await bcrypt.compare(password, user.passwordHash);
  if (!passwordValid) {
    return { success: false, error: 'Invalid username or password' };
  }

  // Generate session key for this login attempt
  const sessionKey = generateSessionKey();
  const role = user.role || 'user';

  // Check if TOTP is enabled for this user
  if (user.totpEnabled && user.totpSecret) {
    const tempToken = jwt.sign({ username, type: 'totp' }, CONFIG.jwtSecret, { expiresIn: CONFIG.tempTokenExpiresIn });

    pendingTotpVerifications.set(tempToken, {
      username,
      sessionKey,
      role,
      expiresAt: Date.now() + CONFIG.emailCodeExpiresIn
    });

    return {
      success: true,
      tempToken,
      needTotpCode: true,
      needTotpSetup: false,
      needEmailCode: false
    };
  }

  // Check if TOTP setup is required (TOTP enabled globally but user hasn't set it up)
  if (isTotpEnabled() && !user.totpSecret) {
    const tempSecret = generateTotpSecret();
    const setupToken = jwt.sign({ username, type: 'totp-setup' }, CONFIG.jwtSecret, { expiresIn: '15m' });

    pendingTotpSetup.set(setupToken, {
      username,
      secret: tempSecret,
      sessionKey,
      role,
      expiresAt: Date.now() + 15 * 60 * 1000
    });

    const qrCode = await generateTotpQRCode(username, tempSecret);

    return {
      success: true,
      setupToken,
      needTotpSetup: true,
      totpSecret: tempSecret,
      qrCode,
      needTotpCode: false,
      needEmailCode: false
    };
  }

  // No TOTP - proceed to email verification or complete login
  if (!isEmailConfigured()) {
    return completeLogin(username, sessionKey, role);
  }

  // Need email verification
  const code = generateVerificationCode();
  const tempToken = jwt.sign({ username, type: 'temp' }, CONFIG.jwtSecret, { expiresIn: CONFIG.tempTokenExpiresIn });

  // Store pending verification
  pendingVerifications.set(tempToken, {
    username,
    code,
    email: user.email,
    sessionKey,
    role,
    expiresAt: Date.now() + CONFIG.emailCodeExpiresIn
  });

  // Send verification code email
  try {
    await sendVerificationCode(user.email, code, username);
  } catch (err) {
    console.error('Failed to send verification email:', err.message);
    pendingVerifications.delete(tempToken);
    return { success: false, error: 'Failed to send verification email' };
  }

  return {
    success: true,
    tempToken,
    needTotpCode: false,
    needTotpSetup: false,
    needEmailCode: true,
    emailHint: maskEmail(user.email)
  };
}

/**
 * Verify TOTP code (for returning users with TOTP enabled)
 * @param {string} tempToken
 * @param {string} totpCode
 * @returns {Promise<{success: boolean, token?: string, sessionKey?: string, role?: string, tempToken?: string, needEmailCode?: boolean, emailHint?: string, error?: string}>}
 */
export async function verifyTotpStep(tempToken, totpCode) {
  const pending = pendingTotpVerifications.get(tempToken);

  if (!pending) {
    return { success: false, error: 'Invalid or expired TOTP verification token' };
  }

  if (Date.now() > pending.expiresAt) {
    pendingTotpVerifications.delete(tempToken);
    return { success: false, error: 'TOTP verification has expired' };
  }

  const user = getUserByUsername(pending.username);
  if (!user || !user.totpSecret) {
    pendingTotpVerifications.delete(tempToken);
    return { success: false, error: 'User TOTP configuration not found' };
  }

  const isValid = verifyTotpCode(totpCode, user.totpSecret);
  if (!isValid) {
    return { success: false, error: 'Invalid TOTP code' };
  }

  // TOTP verified, clean up
  pendingTotpVerifications.delete(tempToken);

  // Check if email verification is needed
  if (isEmailConfigured()) {
    const code = generateVerificationCode();
    const newTempToken = jwt.sign({ username: pending.username, type: 'temp' }, CONFIG.jwtSecret, { expiresIn: CONFIG.tempTokenExpiresIn });

    pendingVerifications.set(newTempToken, {
      username: pending.username,
      code,
      email: user.email,
      sessionKey: pending.sessionKey,
      role: pending.role,
      expiresAt: Date.now() + CONFIG.emailCodeExpiresIn
    });

    try {
      await sendVerificationCode(user.email, code, pending.username);
    } catch (err) {
      console.error('Failed to send verification email:', err.message);
      pendingVerifications.delete(newTempToken);
      return { success: false, error: 'Failed to send verification email' };
    }

    return {
      success: true,
      tempToken: newTempToken,
      needEmailCode: true,
      emailHint: maskEmail(user.email)
    };
  }

  // No email verification needed, complete login
  return completeLogin(pending.username, pending.sessionKey, pending.role);
}

/**
 * Complete TOTP setup (for first-time TOTP configuration)
 * @param {string} setupToken
 * @param {string} totpCode
 * @returns {Promise<{success: boolean, token?: string, sessionKey?: string, role?: string, tempToken?: string, needEmailCode?: boolean, emailHint?: string, error?: string}>}
 */
export async function completeTotpSetup(setupToken, totpCode) {
  const pending = pendingTotpSetup.get(setupToken);

  if (!pending) {
    return { success: false, error: 'Invalid or expired TOTP setup token' };
  }

  if (Date.now() > pending.expiresAt) {
    pendingTotpSetup.delete(setupToken);
    return { success: false, error: 'TOTP setup has expired' };
  }

  // Verify the code with the pending secret
  const isValid = verifyTotpCode(totpCode, pending.secret);
  if (!isValid) {
    return { success: false, error: 'Invalid TOTP code. Please try again.' };
  }

  // Save TOTP secret to user
  const saved = await updateUserTotp(pending.username, {
    totpSecret: pending.secret,
    totpEnabled: true
  });

  if (!saved) {
    return { success: false, error: 'Failed to save TOTP settings' };
  }

  // TOTP setup complete, clean up
  pendingTotpSetup.delete(setupToken);

  const user = getUserByUsername(pending.username);

  // Check if email verification is needed
  if (isEmailConfigured() && user) {
    const code = generateVerificationCode();
    const tempToken = jwt.sign({ username: pending.username, type: 'temp' }, CONFIG.jwtSecret, { expiresIn: CONFIG.tempTokenExpiresIn });

    pendingVerifications.set(tempToken, {
      username: pending.username,
      code,
      email: user.email,
      sessionKey: pending.sessionKey,
      role: pending.role,
      expiresAt: Date.now() + CONFIG.emailCodeExpiresIn
    });

    try {
      await sendVerificationCode(user.email, code, pending.username);
    } catch (err) {
      console.error('Failed to send verification email:', err.message);
      pendingVerifications.delete(tempToken);
      return { success: false, error: 'Failed to send verification email' };
    }

    return {
      success: true,
      tempToken,
      needEmailCode: true,
      emailHint: maskEmail(user.email)
    };
  }

  // No email verification needed, complete login
  return completeLogin(pending.username, pending.sessionKey, pending.role);
}

/**
 * Verify email code (Step 2)
 * @param {string} tempToken
 * @param {string} code
 * @returns {{success: boolean, token?: string, sessionKey?: string, role?: string, error?: string}}
 */
export function loginStep2(tempToken, code) {
  const pending = pendingVerifications.get(tempToken);

  if (!pending) {
    return { success: false, error: 'Invalid or expired verification token' };
  }

  if (Date.now() > pending.expiresAt) {
    pendingVerifications.delete(tempToken);
    return { success: false, error: 'Verification code has expired' };
  }

  if (pending.code !== code) {
    return { success: false, error: 'Invalid verification code' };
  }

  // Clean up pending verification
  pendingVerifications.delete(tempToken);

  return completeLogin(pending.username, pending.sessionKey, pending.role);
}

/**
 * Verify JWT token and get session data
 * @param {string} token
 * @returns {{valid: boolean, username?: string, sessionKey?: Uint8Array, role?: string}}
 */
export function verifyToken(token) {
  try {
    const decoded = jwt.verify(token, CONFIG.jwtSecret);

    // 检查是否已被注销
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

    // Get current role from database
    const user = getUserByUsername(decoded.username);

    return {
      valid: true,
      username: decoded.username,
      sessionKey: session.sessionKey,
      role: user?.role || 'user'
    };
  } catch (err) {
    return { valid: false };
  }
}

/**
 * Invalidate a session (logout)
 * @param {string} token
 */
export function logout(token) {
  activeSessions.delete(token);
  revokedTokens.add(token);
}

/**
 * Verify agent connection using per-user agent_secret or global fallback
 * @param {string} secret
 * @returns {{valid: boolean, sessionKey?: Uint8Array, userId?: string, username?: string}}
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
  //    ownerId=null means visible to all users
  if (CONFIG.agentSecret && secret === CONFIG.agentSecret) {
    const sessionKey = generateSessionKey();
    return { valid: true, sessionKey, userId: null, username: null };
  }

  return { valid: false };
}

/**
 * Register a new user via invitation code
 * @param {string} username
 * @param {string} password
 * @param {string} email
 * @param {string} invitationCode
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
export async function register(username, password, email, invitationCode) {
  if (CONFIG.skipAuth) {
    return { success: false, error: 'Registration disabled in development mode' };
  }

  // Validate input
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

  // Verify invitation code
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

  // Check username uniqueness
  const existing = userDb.getByUsername(username);
  if (existing && existing.password_hash) {
    return { success: false, error: 'Username already exists' };
  }

  // Create user
  const passwordHash = await bcrypt.hash(password, 10);
  const role = invitation.role || 'user';

  let user;
  if (existing && !existing.password_hash) {
    // User record exists (from getOrCreate) but has no password — upgrade it
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

  // Mark invitation as used
  invitationDb.use(invitationCode, user.id);

  return { success: true, message: 'Registration successful' };
}

/**
 * Hash a password for storage
 * @param {string} password
 * @returns {Promise<string>} bcrypt hash
 */
export async function hashPassword(password) {
  return bcrypt.hash(password, 10);
}

/**
 * Mask email for display (e.g., a***@example.com)
 * @param {string} email
 * @returns {string}
 */
function maskEmail(email) {
  const [local, domain] = email.split('@');
  if (local.length <= 2) {
    return `${local[0]}***@${domain}`;
  }
  return `${local[0]}${'*'.repeat(Math.min(local.length - 1, 3))}@${domain}`;
}

/**
 * Generate session key for skip-auth mode
 * @returns {{sessionKey: Uint8Array, sessionKeyEncoded: string}}
 */
export function generateSkipAuthSession() {
  const sessionKey = generateSessionKey();
  return { sessionKey, sessionKeyEncoded: encodeKey(sessionKey) };
}
