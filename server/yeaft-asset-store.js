import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG } from './config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = join(__dirname, '../data/yeaft-assets');
const MAX_ASSET_BYTES = 20 * 1024 * 1024;
const DEFAULT_MAX_SCOPE_BYTES = 512 * 1024 * 1024;
const DEFAULT_MAX_OWNER_BYTES = 2 * 1024 * 1024 * 1024;
const DEFAULT_MAX_GLOBAL_BYTES = 20 * 1024 * 1024 * 1024;
const DEFAULT_MAX_SCOPE_ASSETS = 1_000;
const DEFAULT_MAX_GLOBAL_ASSETS = 100_000;
const DEFAULT_RETENTION_MS = 180 * 24 * 60 * 60 * 1000;
const DEFAULT_ORPHAN_GRACE_MS = 60 * 60 * 1000;
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

function positiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function writeAtomic(path, data) {
  const tmp = `${path}.tmp-${process.pid}-${randomUUID()}`;
  writeFileSync(tmp, data, { flag: 'wx' });
  renameSync(tmp, path);
}

export function createYeaftAssetStore({
  root = process.env.YEAFT_ASSET_DIR || DEFAULT_ROOT,
  secret = CONFIG.jwtSecret,
  maxScopeBytes = positiveNumber(process.env.YEAFT_ASSET_SCOPE_BYTES, DEFAULT_MAX_SCOPE_BYTES),
  maxOwnerBytes = positiveNumber(process.env.YEAFT_ASSET_OWNER_BYTES, DEFAULT_MAX_OWNER_BYTES),
  maxGlobalBytes = positiveNumber(process.env.YEAFT_ASSET_GLOBAL_BYTES, DEFAULT_MAX_GLOBAL_BYTES),
  maxScopeAssets = positiveNumber(process.env.YEAFT_ASSET_SCOPE_COUNT, DEFAULT_MAX_SCOPE_ASSETS),
  maxGlobalAssets = positiveNumber(process.env.YEAFT_ASSET_GLOBAL_COUNT, DEFAULT_MAX_GLOBAL_ASSETS),
  retentionMs = positiveNumber(process.env.YEAFT_ASSET_RETENTION_MS, DEFAULT_RETENTION_MS),
  orphanGraceMs = positiveNumber(process.env.YEAFT_ASSET_ORPHAN_GRACE_MS, DEFAULT_ORPHAN_GRACE_MS),
  now = () => Date.now(),
} = {}) {
  mkdirSync(root, { recursive: true });
  const scopeUsage = new Map();
  const scopeCounts = new Map();
  const ownerUsage = new Map();
  let totalUsage = 0;
  let assetCount = 0;
  let lastCleanupAt = 0;

  const pathsFor = (scopeId, assetId) => {
    if (!/^[a-f0-9]{32}$/.test(scopeId) || !/^[a-f0-9]{64}$/.test(assetId)) return null;
    const dir = join(root, scopeId, assetId.slice(0, 2));
    return { dir, data: join(dir, `${assetId}.bin`), meta: join(dir, `${assetId}.json`) };
  };

  const metadataRows = () => {
    const rows = [];
    if (!existsSync(root)) return rows;
    for (const scopeId of readdirSync(root)) {
      const scopeDir = join(root, scopeId);
      let prefixes;
      try {
        if (!statSync(scopeDir).isDirectory()) continue;
        prefixes = readdirSync(scopeDir);
      } catch { continue; }
      for (const prefix of prefixes) {
        const prefixDir = join(scopeDir, prefix);
        let names;
        try { names = readdirSync(prefixDir); } catch { continue; }
        for (const name of names) {
          if (!name.endsWith('.json')) continue;
          const metaPath = join(prefixDir, name);
          try {
            const metadata = JSON.parse(readFileSync(metaPath, 'utf8'));
            const paths = pathsFor(metadata.scopeId, metadata.assetId);
            if (!paths || paths.meta !== metaPath || !existsSync(paths.data)) continue;
            rows.push({ metadata, paths });
          } catch { /* malformed rows are handled as orphans */ }
        }
      }
    }
    return rows;
  };

  const rebuildUsage = () => {
    scopeUsage.clear();
    scopeCounts.clear();
    ownerUsage.clear();
    totalUsage = 0;
    assetCount = 0;
    for (const { metadata } of metadataRows()) {
      const size = Number(metadata.size) || 0;
      totalUsage += size;
      assetCount++;
      scopeUsage.set(metadata.scopeId, (scopeUsage.get(metadata.scopeId) || 0) + size);
      scopeCounts.set(metadata.scopeId, (scopeCounts.get(metadata.scopeId) || 0) + 1);
      ownerUsage.set(metadata.ownerId, (ownerUsage.get(metadata.ownerId) || 0) + size);
    }
  };

  const cleanupEmptyParents = path => {
    try { rmSync(path, { recursive: false }); } catch { /* non-empty or already gone */ }
    try { rmSync(dirname(path), { recursive: false }); } catch { /* non-empty */ }
  };

  const collectGarbage = () => {
    const current = now();
    const cutoff = current - retentionMs;
    const known = new Set();
    let removed = 0;
    for (const row of metadataRows()) {
      known.add(row.paths.data);
      known.add(row.paths.meta);
      const referencedAt = Number(row.metadata.lastReferencedAt || row.metadata.createdAt || 0);
      if (referencedAt >= cutoff) continue;
      rmSync(row.paths.data, { force: true });
      rmSync(row.paths.meta, { force: true });
      cleanupEmptyParents(row.paths.dir);
      removed++;
    }
    if (existsSync(root)) {
      const stack = [root];
      while (stack.length) {
        const dir = stack.pop();
        let names;
        try { names = readdirSync(dir); } catch { continue; }
        for (const name of names) {
          const path = join(dir, name);
          let stat;
          try { stat = statSync(path); } catch { continue; }
          if (stat.isDirectory()) {
            stack.push(path);
            continue;
          }
          if (known.has(path) || current - stat.mtimeMs < orphanGraceMs) continue;
          rmSync(path, { force: true });
        }
      }
    }
    lastCleanupAt = current;
    rebuildUsage();
    return removed;
  };

  collectGarbage();

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
      if (now() - lastCleanupAt > 60 * 60 * 1000) collectGarbage();
      const duplicate = existsSync(paths.data) && existsSync(paths.meta);
      if (!duplicate) {
        if ((scopeCounts.get(scopeId) || 0) + 1 > maxScopeAssets) throw new Error('Session image asset count quota exceeded');
        if (assetCount + 1 > maxGlobalAssets) throw new Error('Global image asset count quota exceeded');
        if ((scopeUsage.get(scopeId) || 0) + buffer.length > maxScopeBytes) throw new Error('Session image asset quota exceeded');
        if ((ownerUsage.get(ownerId) || 0) + buffer.length > maxOwnerBytes) throw new Error('User image asset quota exceeded');
        if (totalUsage + buffer.length > maxGlobalBytes) throw new Error('Global image asset quota exceeded');
      }
      mkdirSync(paths.dir, { recursive: true });
      if (!existsSync(paths.data)) writeFileSync(paths.data, buffer, { flag: 'wx' });
      let existing = null;
      if (duplicate) {
        try { existing = JSON.parse(readFileSync(paths.meta, 'utf8')); } catch { /* rewrite below */ }
      }
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
        createdAt: Number(existing?.createdAt) || now(),
        lastReferencedAt: now(),
      };
      try {
        writeAtomic(paths.meta, JSON.stringify(metadata));
      } catch (err) {
        if (!duplicate) rmSync(paths.data, { force: true });
        throw err;
      }
      if (!duplicate) {
        scopeUsage.set(scopeId, (scopeUsage.get(scopeId) || 0) + buffer.length);
        scopeCounts.set(scopeId, (scopeCounts.get(scopeId) || 0) + 1);
        ownerUsage.set(ownerId, (ownerUsage.get(ownerId) || 0) + buffer.length);
        totalUsage += buffer.length;
        assetCount++;
      }
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
      if (now() - Number(metadata.lastReferencedAt || 0) > Math.min(retentionMs / 2, 60 * 60 * 1000)) {
        metadata.lastReferencedAt = now();
        try { writeAtomic(paths.meta, JSON.stringify(metadata)); } catch { /* best-effort retention refresh */ }
      }
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

    deleteScope({ ownerId, agentId, sessionId }) {
      if (!ownerId || !agentId || !sessionId) return 0;
      const scopeId = scopeIdFor(ownerId, agentId, sessionId, secret);
      const removed = metadataRows().filter(row => row.metadata.scopeId === scopeId).length;
      rmSync(join(root, scopeId), { recursive: true, force: true });
      rebuildUsage();
      return removed;
    },

    collectGarbage,

    usage() {
      return { bytes: totalUsage, assets: assetCount };
    },
  };
}

export const yeaftAssetStore = createYeaftAssetStore();
