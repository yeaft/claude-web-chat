import { randomInt } from 'crypto';
import bcrypt from 'bcrypt';
import { CONFIG } from '../config.js';
import { generateSessionKey, encodeKey } from '../encryption.js';

/**
 * Generate a random verification code
 */
export function generateVerificationCode() {
  const length = CONFIG.emailCodeLength;
  let code = '';
  for (let i = 0; i < length; i++) {
    code += randomInt(10).toString();
  }
  return code;
}

/**
 * Mask email for display (e.g., a***@example.com)
 */
export function maskEmail(email) {
  const [local, domain] = email.split('@');
  if (local.length <= 2) {
    return `${local[0]}***@${domain}`;
  }
  return `${local[0]}${'*'.repeat(Math.min(local.length - 1, 3))}@${domain}`;
}

/**
 * Hash a password for storage
 */
export async function hashPassword(password) {
  return bcrypt.hash(password, 10);
}

/**
 * Generate session key for skip-auth mode
 */
export function generateSkipAuthSession() {
  const sessionKey = generateSessionKey();
  return { sessionKey, sessionKeyEncoded: encodeKey(sessionKey) };
}
