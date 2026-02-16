import { describe, it, expect } from 'vitest';
import { generateSessionKey, encrypt, decrypt, isEncrypted, encodeKey, decodeKey } from '../../server/encryption.js';

describe('Encryption System', () => {
  describe('generateSessionKey', () => {
    it('should generate a 32-byte Uint8Array', () => {
      const key = generateSessionKey();
      expect(key).toBeInstanceOf(Uint8Array);
      expect(key.length).toBe(32);
    });

    it('should generate unique keys', () => {
      const key1 = generateSessionKey();
      const key2 = generateSessionKey();
      expect(Buffer.from(key1).toString('hex')).not.toBe(Buffer.from(key2).toString('hex'));
    });
  });

  describe('encrypt/decrypt round-trip', () => {
    it('should encrypt and decrypt simple object', async () => {
      const key = generateSessionKey();
      const data = { type: 'test', message: 'hello world' };
      const encrypted = await encrypt(data, key);
      const decrypted = await decrypt(encrypted, key);
      expect(decrypted).toEqual(data);
    });

    it('should encrypt and decrypt string content', async () => {
      const key = generateSessionKey();
      const data = 'plain string';
      const encrypted = await encrypt(data, key);
      const decrypted = await decrypt(encrypted, key);
      expect(decrypted).toBe(data);
    });

    it('should encrypt and decrypt array', async () => {
      const key = generateSessionKey();
      const data = [1, 2, { nested: true }];
      const encrypted = await encrypt(data, key);
      const decrypted = await decrypt(encrypted, key);
      expect(decrypted).toEqual(data);
    });

    it('should encrypt and decrypt unicode/Chinese content', async () => {
      const key = generateSessionKey();
      const data = { content: '你好世界 🌍 テスト' };
      const encrypted = await encrypt(data, key);
      const decrypted = await decrypt(encrypted, key);
      expect(decrypted).toEqual(data);
    });

    it('should handle null and boolean values', async () => {
      const key = generateSessionKey();
      for (const data of [null, true, false, 0, '']) {
        const encrypted = await encrypt(data, key);
        const decrypted = await decrypt(encrypted, key);
        expect(decrypted).toEqual(data);
      }
    });
  });

  describe('compression', () => {
    it('should NOT compress data smaller than 512 bytes', async () => {
      const key = generateSessionKey();
      const data = { short: 'hello' };
      const encrypted = await encrypt(data, key);
      expect(encrypted.z).toBeUndefined();
    });

    it('should compress data larger than 512 bytes', async () => {
      const key = generateSessionKey();
      const data = { content: 'x'.repeat(1000) };
      const encrypted = await encrypt(data, key);
      expect(encrypted.z).toBe(true);
      // Verify round-trip still works
      const decrypted = await decrypt(encrypted, key);
      expect(decrypted).toEqual(data);
    });

    it('should handle large payloads with compression', async () => {
      const key = generateSessionKey();
      const data = { content: 'a'.repeat(100000), nested: { arr: Array.from({ length: 100 }, (_, i) => i) } };
      const encrypted = await encrypt(data, key);
      expect(encrypted.z).toBe(true);
      const decrypted = await decrypt(encrypted, key);
      expect(decrypted).toEqual(data);
    });
  });

  describe('isEncrypted', () => {
    it('should return true for encrypted messages', async () => {
      const key = generateSessionKey();
      const encrypted = await encrypt({ test: true }, key);
      expect(isEncrypted(encrypted)).toBe(true);
    });

    it('should return false for plain messages', () => {
      expect(isEncrypted({ type: 'test' })).toBeFalsy();
      expect(isEncrypted(null)).toBeFalsy();
      expect(isEncrypted('string')).toBeFalsy();
      expect(isEncrypted({ n: 123 })).toBeFalsy();
    });
  });

  describe('encodeKey/decodeKey', () => {
    it('should encode and decode key correctly', () => {
      const key = generateSessionKey();
      const encoded = encodeKey(key);
      expect(typeof encoded).toBe('string');
      const decoded = decodeKey(encoded);
      expect(decoded).toEqual(key);
    });
  });

  describe('error handling', () => {
    it('should return null when decrypting with wrong key', async () => {
      const key1 = generateSessionKey();
      const key2 = generateSessionKey();
      const encrypted = await encrypt({ secret: 'data' }, key1);
      const decrypted = await decrypt(encrypted, key2);
      expect(decrypted).toBeNull();
    });

    it('should return null for tampered ciphertext', async () => {
      const key = generateSessionKey();
      const encrypted = await encrypt({ test: true }, key);
      encrypted.c = encrypted.c.slice(0, -4) + 'AAAA';
      const decrypted = await decrypt(encrypted, key);
      expect(decrypted).toBeNull();
    });

    it('should return null for tampered nonce', async () => {
      const key = generateSessionKey();
      const encrypted = await encrypt({ test: true }, key);
      encrypted.n = encrypted.n.slice(0, -4) + 'AAAA';
      const decrypted = await decrypt(encrypted, key);
      expect(decrypted).toBeNull();
    });
  });
});
