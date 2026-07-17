import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createYeaftAssetStore } from '../../server/yeaft-asset-store.js';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const PNG_2 = Buffer.concat([PNG, Buffer.from('different')]);
const dirs = [];

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true });
});

function store() {
  const root = mkdtempSync(join(tmpdir(), 'yeaft-assets-'));
  dirs.push(root);
  return createYeaftAssetStore({ root, secret: 'test-secret' });
}

describe('Yeaft asset store', () => {
  it('persists an image and returns a stable capability URL', () => {
    const assets = store();
    const image = assets.put({
      ownerId: 'user-1', agentId: 'agent-1', sessionId: 'session-1',
      data: PNG, mimeType: 'image/png', filename: 'pixel.png',
    });
    expect(image.src).toMatch(/^\/api\/yeaft\/assets\/[a-f0-9]{32}\/[a-f0-9]{64}\?token=/);
    const url = new URL(image.src, 'http://localhost');
    const [, , , , scopeId, assetId] = url.pathname.split('/');
    const loaded = assets.read(scopeId, assetId, url.searchParams.get('token'));
    expect(loaded.buffer).toEqual(PNG);
    expect(loaded.metadata).toMatchObject({ ownerId: 'user-1', agentId: 'agent-1', sessionId: 'session-1' });
  });

  it('denies invalid tokens, MIME mismatch, SVG, and cross-Session lookup', () => {
    const assets = store();
    const image = assets.put({ ownerId: 'user-1', agentId: 'agent-1', sessionId: 'session-1', data: PNG, mimeType: 'image/png' });
    const url = new URL(image.src, 'http://localhost');
    const [, , , , scopeId, assetId] = url.pathname.split('/');
    expect(assets.read(scopeId, assetId, 'wrong')).toBeNull();
    expect(assets.describe({ ownerId: 'user-1', agentId: 'agent-1', sessionId: 'session-2', assetId })).toBeNull();
    expect(() => assets.put({ ownerId: 'u', agentId: 'a', sessionId: 's', data: PNG, mimeType: 'image/jpeg' })).toThrow(/MIME/);
    expect(() => assets.put({ ownerId: 'u', agentId: 'a', sessionId: 's', data: Buffer.from('<svg/>'), mimeType: 'image/svg+xml' })).toThrow(/Unsupported/);
  });

  it('enforces scope, owner, and global quotas without charging duplicates twice', () => {
    const root = mkdtempSync(join(tmpdir(), 'yeaft-assets-'));
    dirs.push(root);
    const scopeLimited = createYeaftAssetStore({ root, secret: 'test', maxScopeBytes: PNG.length, maxOwnerBytes: 999999, maxGlobalBytes: 999999 });
    scopeLimited.put({ ownerId: 'u', agentId: 'a', sessionId: 's', data: PNG });
    expect(() => scopeLimited.put({ ownerId: 'u', agentId: 'a', sessionId: 's', data: PNG_2 })).toThrow(/Session image asset quota/);
    expect(() => scopeLimited.put({ ownerId: 'u', agentId: 'a', sessionId: 's', data: PNG })).not.toThrow();

    const ownerRoot = mkdtempSync(join(tmpdir(), 'yeaft-assets-'));
    dirs.push(ownerRoot);
    const ownerLimited = createYeaftAssetStore({ root: ownerRoot, secret: 'test', maxScopeBytes: 999999, maxOwnerBytes: PNG.length, maxGlobalBytes: 999999 });
    ownerLimited.put({ ownerId: 'u', agentId: 'a', sessionId: 's1', data: PNG });
    expect(() => ownerLimited.put({ ownerId: 'u', agentId: 'a', sessionId: 's2', data: PNG_2 })).toThrow(/User image asset quota/);

    const globalRoot = mkdtempSync(join(tmpdir(), 'yeaft-assets-'));
    dirs.push(globalRoot);
    const globalLimited = createYeaftAssetStore({ root: globalRoot, secret: 'test', maxScopeBytes: 999999, maxOwnerBytes: 999999, maxGlobalBytes: PNG.length });
    globalLimited.put({ ownerId: 'u1', agentId: 'a', sessionId: 's1', data: PNG });
    expect(() => globalLimited.put({ ownerId: 'u2', agentId: 'a', sessionId: 's2', data: PNG_2 })).toThrow(/Global image asset quota/);

    const countRoot = mkdtempSync(join(tmpdir(), 'yeaft-assets-'));
    dirs.push(countRoot);
    const countLimited = createYeaftAssetStore({ root: countRoot, secret: 'test', maxScopeAssets: 1, maxScopeBytes: 999999, maxOwnerBytes: 999999, maxGlobalBytes: 999999 });
    countLimited.put({ ownerId: 'u', agentId: 'a', sessionId: 's', data: PNG });
    expect(() => countLimited.put({ ownerId: 'u', agentId: 'a', sessionId: 's', data: PNG_2 })).toThrow(/count quota/);
  });

  it('deletes only the requested Session scope', () => {
    const assets = store();
    const first = assets.put({ ownerId: 'u', agentId: 'a', sessionId: 's1', data: PNG });
    const second = assets.put({ ownerId: 'u', agentId: 'a', sessionId: 's2', data: PNG });
    expect(assets.deleteScope({ ownerId: 'u', agentId: 'a', sessionId: 's1' })).toBe(1);
    expect(assets.describe({ ownerId: 'u', agentId: 'a', sessionId: 's1', assetId: first.assetId })).toBeNull();
    expect(assets.describe({ ownerId: 'u', agentId: 'a', sessionId: 's2', assetId: second.assetId })).not.toBeNull();
  });

  it('refreshes retention when history resolves an asset description', () => {
    const root = mkdtempSync(join(tmpdir(), 'yeaft-assets-'));
    dirs.push(root);
    let clock = 1_000;
    const assets = createYeaftAssetStore({ root, secret: 'test', retentionMs: 100, now: () => clock });
    const image = assets.put({ ownerId: 'u', agentId: 'a', sessionId: 's', data: PNG });
    clock = 1_075;
    expect(assets.describe({ ownerId: 'u', agentId: 'a', sessionId: 's', assetId: image.assetId })).not.toBeNull();
    clock = 1_150;
    expect(assets.collectGarbage()).toBe(0);
    expect(assets.describe({ ownerId: 'u', agentId: 'a', sessionId: 's', assetId: image.assetId })).not.toBeNull();
  });

  it('cleans expired assets and leaves recent assets intact', () => {
    const root = mkdtempSync(join(tmpdir(), 'yeaft-assets-'));
    dirs.push(root);
    let clock = 1_000;
    const assets = createYeaftAssetStore({ root, secret: 'test', retentionMs: 100, now: () => clock });
    const old = assets.put({ ownerId: 'u', agentId: 'a', sessionId: 'old', data: PNG });
    clock = 1_050;
    const recent = assets.put({ ownerId: 'u', agentId: 'a', sessionId: 'recent', data: PNG });
    clock = 1_125;
    expect(assets.collectGarbage()).toBe(1);
    expect(assets.describe({ ownerId: 'u', agentId: 'a', sessionId: 'old', assetId: old.assetId })).toBeNull();
    expect(assets.describe({ ownerId: 'u', agentId: 'a', sessionId: 'recent', assetId: recent.assetId })).not.toBeNull();
    expect(existsSync(root)).toBe(true);
  });
});
