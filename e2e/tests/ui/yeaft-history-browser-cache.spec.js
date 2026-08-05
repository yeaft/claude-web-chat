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
  <script type="module">
    window.__historyCache = await import('/web/stores/helpers/yeaft-history-browser-cache.js');
    window.__historyCacheReady = true;
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

test('persists reactive projection rows and removes stale owners after reload', async ({ page }) => {
  await page.goto(`${baseUrl}/__history-cache`);
  await page.waitForFunction(() => window.__historyCacheReady === true);

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
});
