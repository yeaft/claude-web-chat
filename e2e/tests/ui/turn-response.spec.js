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
      toolMsgs: [], imageMsgs: [],
      todoMsg: { toolInput: { todos: [{ content: 'Verify spacing', status: 'pending' }] } },
      askMsg: null, messages: [], isStreaming: false, isActive: false,
    });
    const app = Vue.createApp({
      components: { VpTurnBlock },
      setup() { return { turn }; },
      template: '<VpTurnBlock :turn="turn" />',
    });
    const translate = (key, params = {}) => {
      const labels = {
        'common.close': 'Close',
        'message.imagePreview': 'Image preview',
        'message.previousImage': 'Previous image',
        'message.nextImage': 'Next image',
      };
      if (key === 'message.imagePosition') return 'Image ' + params.current + ' of ' + params.total;
      return labels[key] || key;
    };
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
    if (pathname === '/gallery-a.png' || pathname === '/gallery-b.png') {
      const first = pathname.includes('-a.');
      const label = first ? 'A' : 'B';
      const title = first ? 'Architecture overview' : 'Release checklist';
      const accent = first ? '#2563eb' : '#b45309';
      const surface = first ? '#dbeafe' : '#fef3c7';
      response.writeHead(200, { 'content-type': 'image/svg+xml; charset=utf-8' });
      response.end(`<svg xmlns="http://www.w3.org/2000/svg" width="960" height="640" viewBox="0 0 960 640">
        <rect width="960" height="640" fill="#f8fafc"/>
        <rect x="48" y="48" width="864" height="544" rx="32" fill="${surface}"/>
        <circle cx="144" cy="144" r="52" fill="${accent}"/>
        <text x="144" y="166" text-anchor="middle" font-family="sans-serif" font-size="64" font-weight="700" fill="#ffffff">${label}</text>
        <text x="224" y="132" font-family="sans-serif" font-size="34" font-weight="700" fill="#172033">${title}</text>
        <text x="224" y="174" font-family="sans-serif" font-size="22" fill="#475569">Yeaft visual verification fixture</text>
        <rect x="104" y="252" width="216" height="204" rx="22" fill="#ffffff" stroke="${accent}" stroke-width="5"/>
        <rect x="372" y="252" width="216" height="204" rx="22" fill="#ffffff" stroke="${accent}" stroke-width="5"/>
        <rect x="640" y="252" width="216" height="204" rx="22" fill="#ffffff" stroke="${accent}" stroke-width="5"/>
        <path d="M320 354h52M588 354h52" stroke="${accent}" stroke-width="10" stroke-linecap="round"/>
      </svg>`);
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

  await page.evaluate(() => {
    window.__turn.imageMsgs = [
      { id: 'gallery-a', src: '/gallery-a.png', filename: 'Gallery A' },
      { id: 'gallery-b', src: '/gallery-b.png', filename: 'Gallery B' },
    ];
  });
  const thumbnails = page.locator('.turn-image-item');
  await expect(thumbnails).toHaveCount(2);
  await expect.poll(() => thumbnails.locator('img').evaluateAll(images => (
    images.every(image => image.complete && image.naturalWidth === 960 && image.naturalHeight === 640)
  ))).toBe(true);
  await thumbnails.first().click();
  const preview = page.locator('.image-preview-overlay');
  await expect(preview).toBeVisible();
  await expect(preview.locator('.image-preview-img')).toHaveAttribute('src', '/gallery-a.png');
  await expect(preview.locator('.image-preview-position')).toHaveText('Image 1 of 2');
  await preview.locator('.image-preview-next').click();
  await expect(preview.locator('.image-preview-img')).toHaveAttribute('src', '/gallery-b.png');
  await expect(preview.locator('.image-preview-position')).toHaveText('Image 2 of 2');
  await page.keyboard.press('ArrowLeft');
  await expect(preview.locator('.image-preview-img')).toHaveAttribute('src', '/gallery-a.png');
  await expect(preview.locator('.image-preview-position')).toHaveText('Image 1 of 2');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await page.keyboard.press('Escape');
  await expect(preview).toHaveCount(0);
  await expect(page.locator('.turn-image-item').first()).toBeFocused();
});
