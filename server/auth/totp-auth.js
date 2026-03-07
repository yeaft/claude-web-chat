import jwt from 'jsonwebtoken';
import { CONFIG, getUserByUsername, isEmailConfigured, updateUserTotp } from '../config.js';
import { sendVerificationCode } from '../email.js';
import { verifyTotpCode } from '../totp.js';
import { pendingVerifications, pendingTotpVerifications, pendingTotpSetup } from './session-store.js';
import { completeLogin } from './login.js';
import { generateVerificationCode, maskEmail } from './utils.js';

/**
 * Verify TOTP code (for returning users with TOTP enabled)
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

  return completeLogin(pending.username, pending.sessionKey, pending.role);
}

/**
 * Complete TOTP setup (for first-time TOTP configuration)
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

  const isValid = verifyTotpCode(totpCode, pending.secret);
  if (!isValid) {
    return { success: false, error: 'Invalid TOTP code. Please try again.' };
  }

  const saved = await updateUserTotp(pending.username, {
    totpSecret: pending.secret,
    totpEnabled: true
  });

  if (!saved) {
    return { success: false, error: 'Failed to save TOTP settings' };
  }

  pendingTotpSetup.delete(setupToken);

  const user = getUserByUsername(pending.username);

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

  return completeLogin(pending.username, pending.sessionKey, pending.role);
}
