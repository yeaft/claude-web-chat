import { createServer } from 'node:http';
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
  <link rel="stylesheet" href="/web/styles/variables.css">
  <link rel="stylesheet" href="/web/styles/chat-messages.css">
  <link rel="stylesheet" href="/web/styles/yeaft-vp.css">
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
        return escaped.startsWith('## ')
          ? '<h2>' + escaped.slice(3) + '</h2>'
          : '<p>' + escaped + '</p>';
      },
    };
    window.hljs = undefined;
    const { default: AssistantTurn } = await import('/web/components/AssistantTurn.js');
    const turn = Vue.reactive({
      id: 'turn-ui', turnId: 'turn-ui', textContent: 'Inspecting files.\\n\\n## 改动',
      textSegments: [
        { key: 'progress', content: 'Inspecting files.', kind: 'progress', explicitKind: true, isStreaming: false },
        { key: 'result', content: '## 改动', kind: 'result', explicitKind: true, isStreaming: false },
      ],
      toolMsgs: [], toolSummaryCount: 0, imageMsgs: [],
      todoMsg: { toolInput: { todos: [{ content: 'Verify spacing', status: 'pending' }] } },
      askMsg: null, messages: [], isStreaming: false, isActive: false,
    });
    const app = Vue.createApp({
      components: { AssistantTurn },
      setup() { return { turn }; },
      template: '<AssistantTurn :turn="turn" />',
    });
    const translate = key => ({
      'message.showProgress': '展开过程',
      'message.hideProgress': '收起过程',
    }[key] || key);
    app.config.globalProperties.$t = translate;
    app.provide('t', translate);
    app.mount('#app');
    window.__turn = turn;
    window.__ready = true;
  </script>
</body>
</html>`;
}

let server;
let baseUrl;

test.beforeAll(async () => {
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

test('separates active progress from the final result across themes and mobile', async ({ page }) => {
  await page.goto(`${baseUrl}/__turn-response`);
  await page.waitForFunction(() => window.__ready === true);

  const progress = page.locator('.turn-progress-group');
  const result = page.locator('.turn-response-result');
  const progressToggle = page.locator('.turn-progress-toggle');
  const todos = page.locator('.turn-todos');
  await expect(progress).not.toHaveAttribute('open', '');
  await expect(progressToggle).toHaveAttribute('aria-expanded', 'false');
  await expect(progressToggle).toHaveAttribute('aria-label', '展开过程');
  await expect(progressToggle).toHaveText('');
  await expect(page.locator('.turn-response-label')).toHaveCount(0);
  await expect(result.locator('h2')).toHaveText('改动');
  await expect(page.locator('.turn-response-progress')).toBeHidden();
  await expect(todos).toBeVisible();

  await progressToggle.focus();
  await expect(progressToggle).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(progressToggle).toHaveAttribute('aria-expanded', 'true');
  await expect(progressToggle).toHaveAttribute('aria-label', '收起过程');
  await expect(page.locator('.turn-response-progress')).toBeVisible();
  await page.keyboard.press('Space');
  await expect(progressToggle).toHaveAttribute('aria-expanded', 'false');
  await progressToggle.click();
  await expect(progressToggle).toHaveAttribute('aria-expanded', 'true');
  const fontSizes = await page.evaluate(() => ({
    progress: parseFloat(getComputedStyle(document.querySelector('.turn-response-progress')).fontSize),
    result: parseFloat(getComputedStyle(document.querySelector('.turn-response-result .markdown-body')).fontSize),
  }));
  expect(fontSizes.progress).toBeLessThan(fontSizes.result);
  const layout = await page.evaluate(() => {
    const contentRect = document.querySelector('.turn-content').getBoundingClientRect();
    const todoRect = document.querySelector('.turn-todos').getBoundingClientRect();
    const todoStyle = getComputedStyle(document.querySelector('.turn-todos'));
    const progressListStyle = getComputedStyle(document.querySelector('.turn-progress-list'));
    return {
      gap: todoRect.top - contentRect.bottom,
      todoBorderTopWidth: todoStyle.borderTopWidth,
      progressPaddingLeft: parseFloat(progressListStyle.paddingLeft),
    };
  });
  expect(layout.gap).toBeGreaterThanOrEqual(16);
  expect(layout.todoBorderTopWidth).toBe('0px');
  expect(layout.progressPaddingLeft).toBeGreaterThanOrEqual(16);

  await page.evaluate(() => {
    window.__turn.isActive = true;
  });
  await expect(progress).toHaveAttribute('open', '');
  await page.evaluate(() => {
    window.__turn.isActive = false;
  });
  await expect(progress).not.toHaveAttribute('open', '');

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
  await expect(result.locator('h2')).toBeVisible();
});
