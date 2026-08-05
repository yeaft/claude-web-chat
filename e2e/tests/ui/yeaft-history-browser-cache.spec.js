import { createServer } from 'node:http';
import { readFileSync, statSync } from 'node:fs';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';

const projectRoot = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const contentTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
};

function harnessHtml() {
  return `<!doctype html>
<html>
<body>
  <script src="/node_modules/vue/dist/vue.global.js"></script>
  <script>window.VueDemi = window.Vue;</script>
  <script src="/web/vendor/pinia.iife.prod.js"></script>
  <script>
    Pinia.setActivePinia(Pinia.createPinia());
    Pinia.useSessionsStore = () => ({ applyCrudResult() {} });
  </script>
  <script type="module">
    try {
      window.__historyCache = await import('/web/stores/helpers/yeaft-history-browser-cache.js');
      const { useChatStore } = await import('/web/stores/chat.js');
      window.__chatStore = useChatStore();
      window.__historyCacheReady = true;
    } catch (error) {
      window.__historyCacheError = error.stack || error.message;
    }
  </script>
</body>
</html>`;
}

async function readPhysicalRecords(page) {
  return page.evaluate(async () => {
    const request = indexedDB.open('yeaft-history-cache', 2);
    const db = await new Promise((resolveOpen, reject) => {
      request.onsuccess = () => resolveOpen(request.result);
      request.onerror = () => reject(request.error);
    });
    const transaction = db.transaction('sessions', 'readonly');
    const getAll = transaction.objectStore('sessions').getAll();
    const records = await new Promise((resolveRecords, reject) => {
      getAll.onsuccess = () => resolveRecords(getAll.result);
      getAll.onerror = () => reject(getAll.error);
    });
    db.close();
    return records;
  });
}

let server;
let baseUrl;

test.beforeAll(async () => {
  server = createServer((request, response) => {
    const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
    if (pathname === '/__history-cache') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(harnessHtml());
      return;
    }
    const filePath = resolve(projectRoot, `.${decodeURIComponent(pathname)}`);
    if (!filePath.startsWith(`${projectRoot}${sep}`)) {
      response.writeHead(403).end();
      return;
    }
    try {
      if (!statSync(filePath).isFile()) throw new Error('not a file');
      response.writeHead(200, { 'content-type': contentTypes[extname(filePath)] || 'application/octet-stream' });
      response.end(readFileSync(filePath));
    } catch {
      response.writeHead(404).end();
    }
  });
  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.afterAll(async () => {
  if (!server) return;
  await new Promise(resolveClose => server.close(resolveClose));
});

test('persists projections and completes cache lifecycle transactions', async ({ page }) => {
  await page.goto(`${baseUrl}/__history-cache`);
  await expect.poll(() => page.evaluate(() => (
    window.__historyCacheError || (window.__historyCacheReady ? 'ready' : null)
  ))).toBe('ready');

  const firstWrite = await page.evaluate(async () => {
    const cache = window.__historyCache;
    await cache.clearYeaftHistoryBrowserOwner();
    const fence = cache.bindYeaftHistoryBrowserOwner('owner-a');
    const rows = Vue.reactive([
      {
        id: 'm0002', messageId: 'm0002', historyEntryId: 'entry-2', stableKey: 'entry-2:assistant',
        seq: 2, type: 'assistant', content: 'answer', sessionId: 'session-a', isHistory: true,
      },
      {
        id: 'm0002-todos', messageId: 'm0002', historyEntryId: 'entry-2', stableKey: 'entry-2:todos',
        seq: 2, type: 'tool-use', toolName: 'TodoWrite', sessionId: 'session-a', isHistory: true,
      },
      {
        id: 'm0002-tool-summary', messageId: 'm0002', historyEntryId: 'entry-2', stableKey: 'entry-2:tool-summary',
        seq: 2, type: 'tool-summary', content: 'read files', sessionId: 'session-a', isHistory: true,
      },
    ]);
    const proxy = Vue.isProxy(rows[0]);
    const written = await cache.writeYeaftHistoryBrowserCache({
      fence,
      agentId: 'agent-a',
      sessionId: 'session-a',
      rows,
      historyState: { oldestSeq: 2, latestSeq: 2, hasMore: true },
      // All three rows project one persisted message. Even when the row budget
      // is smaller, capacity trimming must keep that unit atomically.
      limits: { ...cache.YEAFT_HISTORY_BROWSER_CACHE_LIMITS, maxRowsPerSession: 2 },
    });
    const record = await cache.readYeaftHistoryBrowserCache({
      fence, agentId: 'agent-a', sessionId: 'session-a',
    });
    return {
      proxy,
      written,
      rowCount: record?.rowCount,
      stableKeys: record?.rows?.map(row => row.stableKey),
    };
  });

  expect(firstWrite).toEqual({
    proxy: true,
    written: true,
    rowCount: 3,
    stableKeys: ['entry-2:assistant', 'entry-2:todos', 'entry-2:tool-summary'],
  });
  expect(await readPhysicalRecords(page)).toHaveLength(1);

  // Reload creates a new JS realm: module-level previousOwnerId is gone while
  // IndexedDB remains. Binding owner-b must still delete owner-a's plaintext.
  await page.reload();
  await page.waitForFunction(() => window.__historyCacheReady === true);
  await page.evaluate(async () => {
    const cache = window.__historyCache;
    const fence = cache.bindYeaftHistoryBrowserOwner('owner-b');
    await cache.readYeaftHistoryBrowserCache({
      fence, agentId: 'agent-b', sessionId: 'session-b',
    });
  });
  expect(await readPhysicalRecords(page)).toEqual([]);

  const removedOnLogout = await page.evaluate(async () => {
    const cache = window.__historyCache;
    const fence = cache.currentYeaftHistoryBrowserFence();
    await cache.writeYeaftHistoryBrowserCache({
      fence,
      agentId: 'agent-b',
      sessionId: 'session-b',
      rows: [{ id: 'm0003', messageId: 'm0003', seq: 3, type: 'user', content: 'private', sessionId: 'session-b', isHistory: true }],
    });
    await cache.clearYeaftHistoryBrowserOwner();
    return cache.currentYeaftHistoryBrowserFence();
  });
  expect(removedOnLogout).toBeNull();
  expect(await readPhysicalRecords(page)).toEqual([]);

  const expiredRead = await page.evaluate(async () => {
    const cache = window.__historyCache;
    const fence = cache.bindYeaftHistoryBrowserOwner('owner-c');
    await cache.writeYeaftHistoryBrowserCache({
      fence,
      agentId: 'agent-c',
      sessionId: 'session-c',
      rows: [{ id: 'm0004', messageId: 'm0004', seq: 4, type: 'user', content: 'expired', sessionId: 'session-c', isHistory: true }],
    });
    const request = indexedDB.open('yeaft-history-cache', 2);
    const db = await new Promise((resolveOpen, reject) => {
      request.onsuccess = () => resolveOpen(request.result);
      request.onerror = () => reject(request.error);
    });
    const transaction = db.transaction('sessions', 'readwrite');
    const store = transaction.objectStore('sessions');
    const key = ['owner-c', 'agent-c', 'session-c'].join('\u001f');
    const recordRequest = store.get(key);
    const record = await new Promise((resolveRecord, reject) => {
      recordRequest.onsuccess = () => resolveRecord(recordRequest.result);
      recordRequest.onerror = () => reject(recordRequest.error);
    });
    record.lastAccessed = Date.now() - (31 * 24 * 60 * 60 * 1000);
    store.put(record);
    await new Promise((resolveTransaction, reject) => {
      transaction.oncomplete = resolveTransaction;
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
    db.close();
    return cache.readYeaftHistoryBrowserCache({
      fence, agentId: 'agent-c', sessionId: 'session-c',
    });
  });
  expect(expiredRead).toBeNull();
  expect(await readPhysicalRecords(page)).toEqual([]);

  const sessionDeleteOrder = await page.evaluate(async () => {
    const cache = window.__historyCache;
    const chat = window.__chatStore;
    const fence = cache.currentYeaftHistoryBrowserFence();
    await cache.writeYeaftHistoryBrowserCache({
      fence,
      agentId: 'agent-c',
      sessionId: 'session-delete',
      rows: [{ id: 'm0005', messageId: 'm0005', seq: 5, type: 'user', content: 'delete me', sessionId: 'session-delete', isHistory: true }],
    });
    const order = [];
    let resolveCrud;
    const crud = new Promise(resolve => { resolveCrud = resolve; }).then(result => {
      order.push('crud-resolved');
      return result;
    });
    chat._sessionCrudPending = new Map([['delete-request', { resolve: resolveCrud }]]);
    chat.handleYeaftOutput({
      agentId: 'agent-c',
      event: {
        type: 'session_crud_result', requestId: 'delete-request', ok: true,
        op: 'delete', sessionId: 'session-delete',
      },
    });
    order.push('delete-started');
    const beforeResolve = order.slice();
    const result = await crud;
    return { beforeResolve, order, result };
  });
  expect(sessionDeleteOrder).toEqual({
    beforeResolve: ['delete-started'],
    order: ['delete-started', 'crud-resolved'],
    result: expect.objectContaining({ ok: true, op: 'delete', sessionId: 'session-delete' }),
  });
  expect(await readPhysicalRecords(page)).toEqual([]);

  const cleanupFailure = await page.evaluate(async () => {
    const cache = window.__historyCache;
    const fence = cache.currentYeaftHistoryBrowserFence();
    await cache.writeYeaftHistoryBrowserCache({
      fence,
      agentId: 'agent-c',
      sessionId: 'session-failure',
      rows: [{ id: 'm0006', messageId: 'm0006', seq: 6, type: 'user', content: 'private', sessionId: 'session-failure', isHistory: true }],
    });
    const originalTransaction = IDBDatabase.prototype.transaction;
    IDBDatabase.prototype.transaction = function (...args) {
      const transaction = originalTransaction.apply(this, args);
      if (args[1] === 'readwrite') queueMicrotask(() => transaction.abort());
      return transaction;
    };
    try {
      await cache.clearYeaftHistoryBrowserOwner();
      return { rejected: false, message: null };
    } catch (error) {
      return { rejected: true, message: error.message };
    } finally {
      IDBDatabase.prototype.transaction = originalTransaction;
    }
  });
  expect(cleanupFailure).toMatchObject({ rejected: true });
  expect(await readPhysicalRecords(page)).toHaveLength(1);

  const failedSessionDelete = await page.evaluate(async () => {
    const cache = window.__historyCache;
    const chat = window.__chatStore;
    await cache.clearYeaftHistoryBrowserOwner();
    const fence = cache.bindYeaftHistoryBrowserOwner('owner-c');
    await cache.writeYeaftHistoryBrowserCache({
      fence,
      agentId: 'agent-c',
      sessionId: 'session-delete-failure',
      rows: [{ id: 'm0007', messageId: 'm0007', seq: 7, type: 'user', content: 'private', sessionId: 'session-delete-failure', isHistory: true }],
    });
    const originalTransaction = IDBDatabase.prototype.transaction;
    IDBDatabase.prototype.transaction = function (...args) {
      const transaction = originalTransaction.apply(this, args);
      if (args[1] === 'readwrite') queueMicrotask(() => transaction.abort());
      return transaction;
    };
    try {
      let resolveCrud;
      const crud = new Promise(resolve => { resolveCrud = resolve; });
      chat._sessionCrudPending = new Map([['delete-failure-request', { resolve: resolveCrud }]]);
      chat.handleYeaftOutput({
        agentId: 'agent-c',
        event: {
          type: 'session_crud_result', requestId: 'delete-failure-request', ok: true,
          op: 'delete', sessionId: 'session-delete-failure',
        },
      });
      return await crud;
    } finally {
      IDBDatabase.prototype.transaction = originalTransaction;
    }
  });
  expect(failedSessionDelete).toMatchObject({
    ok: false,
    error: { code: 'browser_cache_cleanup_failed' },
  });
  expect(await readPhysicalRecords(page)).toHaveLength(1);

  const recoveredCleanup = await page.evaluate(async () => {
    const cache = window.__historyCache;
    await cache.clearYeaftHistoryBrowserOwner();
    const fence = cache.bindYeaftHistoryBrowserOwner('owner-c');
    return cache.readYeaftHistoryBrowserCache({
      fence, agentId: 'agent-c', sessionId: 'session-failure',
    });
  });
  expect(recoveredCleanup).toBeNull();
  expect(await readPhysicalRecords(page)).toEqual([]);
});
