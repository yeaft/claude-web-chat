import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { CONFIG, getUserByUsername, isEmailConfigured, isTotpEnabled } from '../config.js';
import { sendVerificationCode } from '../email.js';
import { generateSessionKey, encodeKey } from '../encryption.js';
import { generateTotpSecret, generateTotpQRCode } from '../totp.js';
import { pendingVerifications, pendingTotpVerifications, pendingTotpSetup, activeSessions } from './session-store.js';
import { generateVerificationCode, maskEmail } from './utils.js';

/**
 * Helper: complete login and return token + sessionKey + role
 */
export function completeLogin(username, sessionKey, role) {
  const token = jwt.sign({ username }, CONFIG.jwtSecret, { expiresIn: CONFIG.jwtExpiresIn });
  activeSessions.set(token, { username, sessionKey });
  return {
    success: true,
    token,
    sessionKey: encodeKey(sessionKey),
    role: role === 'admin' ? 'admin' : 'pro',
    needTotpCode: false,
    needTotpSetup: false,
    needEmailCode: false
  };
}

/**
 * Authenticate user with username and password (Step 1)
 */
export async function loginStep1(username, password) {
  const user = getUserByUsername(username);

  if (!user) {
    await bcrypt.compare(password, '$2b$10$invalidhashfortiminginvalidhash');
    return { success: false, error: 'Invalid username or password' };
  }

  const passwordValid = await bcrypt.compare(password, user.passwordHash);
  if (!passwordValid) {
    return { success: false, error: 'Invalid username or password' };
  }

  const sessionKey = generateSessionKey();
  const role = user.role === 'admin' ? 'admin' : 'pro';

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

  // Check if TOTP setup is required
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

  pendingVerifications.set(tempToken, {
    username,
    code,
    email: user.email,
    sessionKey,
    role,
    expiresAt: Date.now() + CONFIG.emailCodeExpiresIn
  });

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
 * Verify email code (Step 2)
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

  pendingVerifications.delete(tempToken);

  return completeLogin(pending.username, pending.sessionKey, pending.role);
}
