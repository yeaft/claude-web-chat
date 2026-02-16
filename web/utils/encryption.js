/**
 * Browser-compatible encryption utilities using TweetNaCl and Pako from CDN
 * Requires: nacl, nacl.util, and pako from CDN scripts
 */

// Compression threshold: only compress if data > 512 bytes
const COMPRESS_THRESHOLD = 512;

/**
 * Encrypt data using TweetNaCl secretbox (XSalsa20-Poly1305)
 * Compresses data with gzip before encryption if > threshold
 * @param {any} data - Data to encrypt (will be JSON stringified)
 * @param {Uint8Array} key - 32-byte encryption key
 * @returns {{n: string, c: string, z?: boolean}} Object with base64 nonce, ciphertext, and optional compressed flag
 */
export function encrypt(data, key) {
  const nonce = nacl.randomBytes(24);
  const jsonStr = JSON.stringify(data);

  let message;
  let compressed = false;

  if (jsonStr.length > COMPRESS_THRESHOLD) {
    // Compress before encryption using pako
    message = pako.gzip(jsonStr);
    compressed = true;
  } else {
    message = nacl.util.decodeUTF8(jsonStr);
  }

  const encrypted = nacl.secretbox(message, nonce, key);
  const result = {
    n: nacl.util.encodeBase64(nonce),
    c: nacl.util.encodeBase64(encrypted)
  };
  if (compressed) result.z = true;
  return result;
}

/**
 * Decrypt data using TweetNaCl secretbox
 * Decompresses data with gunzip after decryption if compressed
 * @param {{n: string, c: string, z?: boolean}} encrypted - Object with base64 nonce, ciphertext, and optional compressed flag
 * @param {Uint8Array} key - 32-byte encryption key
 * @returns {any|null} Decrypted and parsed data, or null if decryption fails
 */
export function decrypt(encrypted, key) {
  try {
    const nonce = nacl.util.decodeBase64(encrypted.n);
    const ciphertext = nacl.util.decodeBase64(encrypted.c);
    const decrypted = nacl.secretbox.open(ciphertext, nonce, key);
    if (!decrypted) {
      console.error('[Decrypt] secretbox.open returned null, ciphertext length:', ciphertext.length, 'compressed:', !!encrypted.z);
      return null;
    }

    if (encrypted.z) {
      // Decompress after decryption using pako
      const decompressed = pako.ungzip(decrypted, { to: 'string' });
      return JSON.parse(decompressed);
    } else {
      return JSON.parse(nacl.util.encodeUTF8(decrypted));
    }
  } catch (err) {
    console.error('[Decrypt] Failed:', err.message, 'compressed:', !!encrypted?.z);
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
 * Decode session key from base64
 * @param {string} encodedKey - Base64 encoded key
 * @returns {Uint8Array} Session key
 */
export function decodeKey(encodedKey) {
  return nacl.util.decodeBase64(encodedKey);
}
