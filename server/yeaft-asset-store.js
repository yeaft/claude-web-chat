import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG } from './config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = join(__dirname, '../data/yeaft-assets');
const MAX_ASSET_BYTES = 20 * 1024 * 1024;
const MIME_BY_SIGNATURE = Object.freeze({
  png: 'image/png',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
});

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function safeFilename(value, mimeType) {
  const raw = String(value || '').split(/[/\\]/).pop() || 'image';
  const clean = raw.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 160) || 'image';
  if (/\.[A-Za-z0-9]{2,5}$/.test(clean)) return clean;
  const ext = mimeType === 'image/jpeg' ? '.jpg' : `.${mimeType.split('/')[1] || 'img'}`;
  return `${clean}${ext}`;
}

export function detectImageMime(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 10) return null;
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return MIME_BY_SIGNATURE.png;
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return MIME_BY_SIGNATURE.jpeg;
  const head6 = buffer.subarray(0, 6).toString('ascii');
  if (head6 === 'GIF87a' || head6 === 'GIF89a') return MIME_BY_SIGNATURE.gif;
  if (buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') return MIME_BY_SIGNATURE.webp;
  return null;
}

function scopeIdFor(ownerId, agentId, sessionId, secret) {
  return createHmac('sha256', secret)
    .update(`${ownerId}\0${agentId}\0${sessionId}`)
    .digest('hex')
    .slice(0, 32);
}

function tokenFor(scopeId, assetId, secret) {
  return createHmac('sha256', secret).update(`${scopeId}\0${assetId}`).digest('base64url');
}

function safeTokenEqual(actual, expected) {
  const a = Buffer.from(String(actual || ''));
  const b = Buffer.from(String(expected || ''));
  return a.length === b.length && timingSafeEqual(a, b);
}

export function createYeaftAssetStore({ root = process.env.YEAFT_ASSET_DIR || DEFAULT_ROOT, secret = CONFIG.jwtSecret } = {}) {
  mkdirSync(root, { recursive: true });

  const pathsFor = (scopeId, assetId) => {
    if (!/^[a-f0-9]{32}$/.test(scopeId) || !/^[a-f0-9]{64}$/.test(assetId)) return null;
    const dir = join(root, scopeId, assetId.slice(0, 2));
    return { dir, data: join(dir, `${assetId}.bin`), meta: join(dir, `${assetId}.json`) };
  };

  return {
    put({ ownerId, agentId, sessionId, assetId, data, mimeType, filename, width = null, height = null }) {
      if (!ownerId || !agentId || !sessionId) throw new Error('Asset owner, agent, and Session are required');
      const buffer = Buffer.isBuffer(data) ? data : Buffer.from(String(data || ''), 'base64');
      if (!buffer.length || buffer.length > MAX_ASSET_BYTES) throw new Error(`Image asset must be between 1 byte and ${MAX_ASSET_BYTES} bytes`);
      const detectedMime = detectImageMime(buffer);
      if (!detectedMime) throw new Error('Unsupported or invalid image asset');
      if (mimeType && mimeType !== detectedMime) throw new Error('Image MIME does not match file bytes');
      const computedAssetId = sha256(buffer);
      if (assetId && assetId !== computedAssetId) throw new Error('Image asset id does not match file bytes');
      const scopeId = scopeIdFor(ownerId, agentId, sessionId, secret);
      const paths = pathsFor(scopeId, computedAssetId);
      mkdirSync(paths.dir, { recursive: true });
      if (!existsSync(paths.data)) writeFileSync(paths.data, buffer, { flag: 'wx' });
      const metadata = {
        assetId: computedAssetId,
        scopeId,
        ownerId,
        agentId,
        sessionId,
        mimeType: detectedMime,
        filename: safeFilename(filename, detectedMime),
        size: buffer.length,
        width: Number.isFinite(width) && width > 0 ? Math.floor(width) : null,
        height: Number.isFinite(height) && height > 0 ? Math.floor(height) : null,
        createdAt: Date.now(),
      };
      writeFileSync(paths.meta, JSON.stringify(metadata));
      return this.describe({ ownerId, agentId, sessionId, assetId: computedAssetId });
    },

    describe({ ownerId, agentId, sessionId, assetId }) {
      if (!ownerId || !agentId || !sessionId || !assetId) return null;
      const scopeId = scopeIdFor(ownerId, agentId, sessionId, secret);
      const paths = pathsFor(scopeId, assetId);
      if (!paths || !existsSync(paths.data) || !existsSync(paths.meta)) return null;
      let metadata;
      try { metadata = JSON.parse(readFileSync(paths.meta, 'utf8')); } catch { return null; }
      if (metadata.ownerId !== ownerId || metadata.agentId !== agentId || metadata.sessionId !== sessionId || metadata.assetId !== assetId) return null;
      const token = tokenFor(scopeId, assetId, secret);
      return {
        assetId,
        mimeType: metadata.mimeType,
        filename: metadata.filename,
        size: metadata.size,
        width: metadata.width,
        height: metadata.height,
        src: `/api/yeaft/assets/${scopeId}/${assetId}?token=${encodeURIComponent(token)}`,
      };
    },

    read(scopeId, assetId, token) {
      const paths = pathsFor(scopeId, assetId);
      if (!paths || !safeTokenEqual(token, tokenFor(scopeId, assetId, secret))) return null;
      if (!existsSync(paths.data) || !existsSync(paths.meta)) return null;
      let metadata;
      try { metadata = JSON.parse(readFileSync(paths.meta, 'utf8')); } catch { return null; }
      if (metadata.scopeId !== scopeId || metadata.assetId !== assetId) return null;
      return { metadata, buffer: readFileSync(paths.data) };
    },
  };
}

export const yeaftAssetStore = createYeaftAssetStore();
