import tweetnacl from 'tweetnacl';
import tweetnaclUtil from 'tweetnacl-util';
import zlib from 'zlib';
import { promisify } from 'util';

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);

const { encodeBase64, decodeBase64, encodeUTF8, decodeUTF8 } = tweetnaclUtil;

// Compression threshold: only compress if data > 512 bytes
const COMPRESS_THRESHOLD = 512;

/**
 * Generate a new 32-byte session key
 * @returns {Uint8Array} 32-byte random key
 */
export function generateSessionKey() {
  return tweetnacl.randomBytes(32);
}

/**
 * Encrypt data using TweetNaCl secretbox (XSalsa20-Poly1305)
 * Compresses data with gzip before encryption if > threshold
 * @param {any} data - Data to encrypt (will be JSON stringified)
 * @param {Uint8Array} key - 32-byte encryption key
 * @returns {Promise<{n: string, c: string, z?: boolean}>} Object with base64 nonce, ciphertext, and optional compressed flag
 */
export async function encrypt(data, key) {
  const nonce = tweetnacl.randomBytes(24);
  const jsonStr = JSON.stringify(data);

  let message;
  let compressed = false;

  if (jsonStr.length > COMPRESS_THRESHOLD) {
    // Compress before encryption
    const compressedBuf = await gzip(Buffer.from(jsonStr, 'utf8'));
    message = new Uint8Array(compressedBuf);
    compressed = true;
  } else {
    message = decodeUTF8(jsonStr);
  }

  const encrypted = tweetnacl.secretbox(message, nonce, key);
  const result = {
    n: encodeBase64(nonce),
    c: encodeBase64(encrypted)
  };
  if (compressed) result.z = true;
  return result;
}

/**
 * Decrypt data using TweetNaCl secretbox
 * Decompresses data with gunzip after decryption if compressed
 * @param {{n: string, c: string, z?: boolean}} encrypted - Object with base64 nonce, ciphertext, and optional compressed flag
 * @param {Uint8Array} key - 32-byte encryption key
 * @returns {Promise<any|null>} Decrypted and parsed data, or null if decryption fails
 */
export async function decrypt(encrypted, key) {
  try {
    const nonce = decodeBase64(encrypted.n);
    const ciphertext = decodeBase64(encrypted.c);
    const decrypted = tweetnacl.secretbox.open(ciphertext, nonce, key);
    if (!decrypted) return null;

    if (encrypted.z) {
      // Decompress after decryption
      const decompressed = await gunzip(Buffer.from(decrypted));
      return JSON.parse(decompressed.toString('utf8'));
    } else {
      return JSON.parse(encodeUTF8(decrypted));
    }
  } catch (err) {
    return null;
  }
}

/**
 * Check if a message is encrypted (has n and c properties)
 * @param {any} msg - Message to check
 * @returns {boolean} True if message appears to be encrypted
 */
export function isEncrypted(msg) {
  return msg && typeof msg === 'object' && typeof msg.n === 'string' && typeof msg.c === 'string';
}

/**
 * Encode session key to base64 for transmission
 * @param {Uint8Array} key - Session key
 * @returns {string} Base64 encoded key
 */
export function encodeKey(key) {
  return encodeBase64(key);
}

/**
 * Decode session key from base64
 * @param {string} encodedKey - Base64 encoded key
 * @returns {Uint8Array} Session key
 */
export function decodeKey(encodedKey) {
  return decodeBase64(encodedKey);
}
