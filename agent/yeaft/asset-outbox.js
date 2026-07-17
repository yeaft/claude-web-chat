import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { writeAtomic } from './storage/atomic.js';

const DEFAULT_MAX_ITEMS = 128;
const DEFAULT_MAX_BYTES = 256 * 1024 * 1024;

function safeDeliveryId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{16,128}$/.test(value) ? value : null;
}

export function createAssetOutbox({
  root,
  send,
  maxItems = DEFAULT_MAX_ITEMS,
  maxBytes = DEFAULT_MAX_BYTES,
  retryDelayMs = 30_000,
} = {}) {
  if (!root) throw new Error('Asset outbox root is required');
  if (typeof send !== 'function') throw new Error('Asset outbox send function is required');
  mkdirSync(root, { recursive: true });
  let draining = null;
  let retryTimer = null;

  const itemPath = deliveryId => join(root, `${deliveryId}.json`);
  const list = () => readdirSync(root)
    .filter(name => /^[A-Za-z0-9_-]{16,128}\.json$/.test(name))
    .map(name => {
      const path = join(root, name);
      try {
        const stat = statSync(path);
        return { path, size: stat.size, createdAt: stat.birthtimeMs || stat.mtimeMs };
      } catch { return null; }
    })
    .filter(Boolean)
    .sort((a, b) => a.createdAt - b.createdAt || a.path.localeCompare(b.path));

  const read = path => {
    try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
  };

  function enforceCapacity(extraBytes) {
    const items = list();
    const bytes = items.reduce((sum, item) => sum + item.size, 0);
    if (items.length >= maxItems || bytes + extraBytes > maxBytes) {
      throw new Error('Asset outbox is full; generated image was not queued');
    }
  }

  function enqueue(message) {
    const deliveryId = safeDeliveryId(message?.deliveryId) || randomUUID();
    const payload = { ...message, type: 'yeaft_asset_put', deliveryId, queuedAt: Date.now() };
    const data = JSON.stringify(payload);
    enforceCapacity(Buffer.byteLength(data));
    writeAtomic(itemPath(deliveryId), data);
    return deliveryId;
  }

  function acknowledge(deliveryId) {
    const id = safeDeliveryId(deliveryId);
    if (!id) return false;
    const path = itemPath(id);
    if (!existsSync(path)) return false;
    rmSync(path, { force: true });
    return true;
  }

  const scheduleRetry = () => {
    if (retryTimer || list().length === 0) return;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      drain().catch(err => console.warn('[AssetOutbox] retry failed:', err?.message || err));
    }, retryDelayMs);
    retryTimer.unref?.();
  };

  async function drain() {
    if (draining) return draining;
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
    draining = (async () => {
      for (const item of list()) {
        const payload = read(item.path);
        if (!payload || !safeDeliveryId(payload.deliveryId)) {
          rmSync(item.path, { force: true });
          continue;
        }
        let outcome;
        try { outcome = await send(payload); } catch { outcome = 'dropped'; }
        if (outcome !== 'sent') break;
      }
    })().finally(() => {
      draining = null;
      scheduleRetry();
    });
    return draining;
  }

  function removeSession(sessionId) {
    let removed = 0;
    for (const item of list()) {
      const payload = read(item.path);
      if (payload?.sessionId !== sessionId) continue;
      rmSync(item.path, { force: true });
      removed++;
    }
    return removed;
  }

  return {
    enqueue,
    acknowledge,
    drain,
    removeSession,
    list,
    close() {
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = null;
    },
  };
}
