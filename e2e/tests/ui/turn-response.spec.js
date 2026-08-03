import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';

const projectRoot = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const contentTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
};

function harnessHtml() {
  return `<!doctype html>
<html data-theme="light">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link rel="stylesheet" href="/web/dist/style.bundle.css">
  <style>
    body { margin: 0; padding: 24px; background: var(--bg-main); color: var(--text-primary); }
    #app { width: min(760px, 100%); margin: 0 auto; }
  </style>
</head>
<body>
  <div id="app"></div>
  <script src="/node_modules/vue/dist/vue.global.js"></script>
  <script type="module">
    window.Pinia = {
      defineStore: () => () => ({}),
      useChatStore: () => ({ answerUserQuestion() {}, cancelVpTurn() {} }),
    };
    window.marked = {
      setOptions() {},
      parse(text) {
        const escaped = String(text)
          .replaceAll('&', '&amp;')
          .replaceAll('<', '&lt;')
          .replaceAll('>', '&gt;');
        if (escaped.startsWith('## ')) return '<h2>' + escaped.slice(3) + '</h2>';
        const linked = escaped.replace(/\\[([^\\]]+)\\]\\((#[^)]+)\\)/g, '<a href="$2">$1</a>');
        return '<p>' + linked + '</p>';
      },
    };
    window.hljs = undefined;
    const { default: VpTurnBlock } = await import('/web/components/VpTurnBlock.js');
    const { finalizeTurnResponseSegments } = await import('/web/utils/turn-response.js');
    const turn = Vue.reactive({
      id: 'turn-ui', turnId: 'turn-ui', textContent: '[Inspect files](#details)\\n\\n## 改动',
      textSegments: [
        { key: 'progress', content: '[Inspect files](#details)', kind: 'progress', explicitKind: true, isStreaming: false },
        { key: 'result', content: '## 改动', kind: 'result', explicitKind: true, isStreaming: false },
      ],
      toolMsgs: [], toolSummaryCount: 0, imageMsgs: [],
      todoMsg: { toolInput: { todos: [{ content: 'Verify spacing', status: 'pending' }] } },
      askMsg: null, messages: [], isStreaming: false, isActive: false,
    });
    const app = Vue.createApp({
      components: { VpTurnBlock },
      setup() { return { turn }; },
      template: '<VpTurnBlock :turn="turn" />',
    });
    const translate = key => key;
    app.config.globalProperties.$t = translate;
    app.provide('t', translate);
    app.mount('#app');
    window.__turn = turn;
    window.__finalizeTurnResponseSegments = finalizeTurnResponseSegments;
    window.__ready = true;
  </script>
</body>
</html>`;
}

let server;
let baseUrl;

test.beforeAll(async () => {
  execFileSync(process.execPath, [resolve(projectRoot, 'web/build.js')], {
    cwd: projectRoot,
    stdio: 'pipe',
  });
  server = createServer((request, response) => {
    const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
    if (pathname === '/__turn-response') {
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

test('keeps progress visible and distinct from the final result across themes and mobile', async ({ page }) => {
  await page.goto(`${baseUrl}/__turn-response`);
  await page.waitForFunction(() => window.__ready === true);

  const progress = page.locator('.turn-progress-group');
  const progressList = page.locator('.turn-progress-list');
  const progressLink = progressList.locator('a');
  const result = page.locator('.turn-response-result');
  const todos = page.locator('.vp-turn-block-body-expanded .turn-todos');
  await expect(progress).toBeVisible();
  await expect(progressList).toBeVisible();
  await expect(page.locator('.turn-progress-toggle')).toHaveCount(0);
  await expect(page.locator('.turn-response-label')).toHaveCount(0);
  await expect(result.locator('h2')).toHaveText('改动');
  await expect(page.locator('.turn-response-progress')).toBeVisible();
  await expect(todos).toBeVisible();

  await page.evaluate(() => {
    const contradictoryMessage = {
      type: 'assistant', content: '## Partial failure', responseKind: 'result',
      incomplete: true, stopReason: 'error', isStreaming: false,
    };
    window.__turn.textSegments = [{
      key: 'contradictory', content: contradictoryMessage.content,
      kind: 'result', explicitKind: true, isStreaming: false,
    }];
    window.__turn.messages = [contradictoryMessage];
    window.__turn.textContent = contradictoryMessage.content;
    window.__finalizeTurnResponseSegments(window.__turn);
  });
  await expect(result).toHaveCount(0);
  await expect(page.locator('.turn-response-progress h2')).toHaveText('Partial failure');

  await page.evaluate(() => {
    window.__turn.textSegments = [
      { key: 'progress', content: '[Inspect files](#details)', kind: 'progress', explicitKind: true, isStreaming: false },
      { key: 'result', content: '## 改动', kind: 'result', explicitKind: true, isStreaming: false },
    ];
    window.__turn.messages = [];
    window.__turn.textContent = '[Inspect files](#details)\n\n## 改动';
  });
  await expect(result.locator('h2')).toHaveText('改动');

  await page.locator('.turn-content .copy-btn').focus();
  await page.keyboard.press('Tab');
  await expect(progressLink).toBeFocused();
  const fontSizes = await page.evaluate(() => ({
    progress: parseFloat(getComputedStyle(document.querySelector('.turn-response-progress')).fontSize),
    result: parseFloat(getComputedStyle(document.querySelector('.turn-response-result .markdown-body')).fontSize),
  }));
  expect(fontSizes.progress).toBeLessThan(fontSizes.result);
  const readLayout = () => page.evaluate(() => {
    const contentRect = document.querySelector('.turn-content').getBoundingClientRect();
    const todo = document.querySelector('.vp-turn-block-body-expanded .turn-todos');
    const todoRect = todo.getBoundingClientRect();
    const todoStyle = getComputedStyle(todo);
    const progressListStyle = getComputedStyle(document.querySelector('.turn-progress-list'));
    return {
      gap: todoRect.top - contentRect.bottom,
      todoBorderTopWidth: todoStyle.borderTopWidth,
      todoPaddingLeft: parseFloat(todoStyle.paddingLeft),
      todoPaddingRight: parseFloat(todoStyle.paddingRight),
      progressPaddingLeft: parseFloat(progressListStyle.paddingLeft),
    };
  });
  const layout = await readLayout();
  expect(layout.gap).toBeGreaterThanOrEqual(16);
  expect(layout.todoBorderTopWidth).toBe('0px');
  expect(layout.todoPaddingLeft).toBe(16);
  expect(layout.todoPaddingRight).toBe(16);
  expect(layout.progressPaddingLeft).toBe(0);

  await page.evaluate(() => {
    window.__turn.isActive = true;
  });
  await expect(progress).toBeVisible();
  await expect(progressList).toBeVisible();
  await page.evaluate(() => {
    window.__turn.isActive = false;
  });
  await expect(progress).toBeVisible();
  await expect(progressList).toBeVisible();

  for (const theme of ['light', 'dark']) {
    await page.evaluate(value => document.documentElement.setAttribute('data-theme', value), theme);
    const colors = await page.evaluate(() => ({
      background: getComputedStyle(document.body).backgroundColor,
      progress: getComputedStyle(document.querySelector('.turn-response-progress')).color,
      result: getComputedStyle(document.querySelector('.turn-response-result')).color,
    }));
    expect(colors.progress).not.toBe(colors.result);
    expect(colors.result).not.toBe(colors.background);
  }

  await page.setViewportSize({ width: 430, height: 800 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  expect(await readLayout()).toMatchObject({
    todoBorderTopWidth: '0px',
    todoPaddingLeft: 16,
    todoPaddingRight: 16,
  });
  await expect(result.locator('h2')).toBeVisible();
});
