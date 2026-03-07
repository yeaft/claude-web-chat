import speakeasy from 'speakeasy';
import QRCode from 'qrcode';
import { CONFIG } from './config.js';

/**
 * Generate a new TOTP secret for a user
 * @returns {string} Base32-encoded secret
 */
export function generateTotpSecret() {
  const secret = speakeasy.generateSecret({ length: 20 });
  return secret.base32;
}

/**
 * Generate otpauth URI for QR code
 * @param {string} username - User's username
 * @param {string} secret - Base32-encoded TOTP secret
 * @returns {string} otpauth URI
 */
export function generateTotpUri(username, secret) {
  const issuer = CONFIG.totp?.issuer || 'Claude Web Chat';
  return speakeasy.otpauthURL({
    secret: secret,
    label: username,
    issuer: issuer,
    encoding: 'base32'
  });
}

/**
 * Generate QR code as data URL
 * @param {string} username - User's username
 * @param {string} secret - Base32-encoded TOTP secret
 * @returns {Promise<string>} QR code as data URL
 */
export async function generateTotpQRCode(username, secret) {
  const uri = generateTotpUri(username, secret);
  return QRCode.toDataURL(uri, {
    width: 256,
    margin: 2,
    color: {
      dark: '#000000',
      light: '#ffffff'
    }
  });
}

/**
 * Verify a TOTP code
 * @param {string} token - 6-digit TOTP code from user
 * @param {string} secret - Base32-encoded TOTP secret
 * @returns {boolean} Whether the code is valid
 */
export function verifyTotpCode(token, secret) {
  try {
    return speakeasy.totp.verify({
      secret: secret,
      encoding: 'base32',
      token: token,
      window: CONFIG.totp?.window || 1
    });
  } catch (err) {
    console.error('TOTP verification error:', err.message);
    return false;
  }
}

/**
 * Check if TOTP is globally enabled
 * @returns {boolean}
 */
export function isTotpEnabled() {
  return CONFIG.totp?.enabled !== false;
}
