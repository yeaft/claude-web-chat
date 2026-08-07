import { expect } from '@playwright/test';
import { test } from '../../fixtures/test-server.js';

async function openSandboxSettings(chatPage) {
  const sandboxRequests = [];
  chatPage.on('request', request => {
    const pathname = new URL(request.url()).pathname;
    if (pathname.startsWith('/api/sandbox')) sandboxRequests.push(pathname);
  });

  await chatPage.evaluate(() => window.Pinia.useChatStore().changeLocale('zh-CN'));
  await chatPage.locator('.sidebar-bottom .sidebar-nav-item').click();
  await expect(chatPage.locator('.settings-dialog')).toBeVisible();
  sandboxRequests.length = 0;
  await chatPage.locator('.settings-nav-item', { hasText: 'Sandbox' }).click();
  await expect(chatPage.locator('.settings-pane .sp-info')).toContainText('此 Server 尚未启用 Sandbox');
  await expect(chatPage.locator('.settings-pane .sp-error')).toHaveCount(0);
  await expect.poll(() => sandboxRequests).toEqual(['/api/sandbox/capability']);
  return sandboxRequests;
}

async function sandboxLayout(chatPage) {
  return chatPage.evaluate(() => {
    const dialog = document.querySelector('.settings-dialog');
    const scroll = document.querySelector('.settings-scroll');
    return {
      viewportWidth: innerWidth,
      documentOverflow: document.documentElement.scrollWidth > innerWidth,
      dialogOverflow: dialog.scrollWidth > dialog.clientWidth,
      contentOverflow: scroll.scrollWidth > scroll.clientWidth,
    };
  });
}

test.describe('Sandbox 设置', () => {
  test('禁用态不探测 Docker snapshot，并在桌面和窄屏保持可用', async ({ page, serverUrl }) => {
    await page.goto(serverUrl);
    await page.waitForSelector('.chat-page', { timeout: 10000 });
    const chatPage = page;
    await chatPage.setViewportSize({ width: 1400, height: 800 });
    await chatPage.evaluate(() => {
      const store = window.Pinia.useChatStore();
      if (store.theme !== 'dark') store.toggleTheme();
    });
    const sandboxRequests = await openSandboxSettings(chatPage);

    await expect(chatPage.locator('html')).toHaveAttribute('data-theme', 'dark');
    expect(await sandboxLayout(chatPage)).toEqual({
      viewportWidth: 1400,
      documentOverflow: false,
      dialogOverflow: false,
      contentOverflow: false,
    });

    await chatPage.setViewportSize({ width: 320, height: 720 });
    await chatPage.evaluate(() => {
      const store = window.Pinia.useChatStore();
      if (store.theme !== 'light') store.toggleTheme();
    });
    await expect(chatPage.locator('html')).toHaveAttribute('data-theme', 'light');
    await expect(chatPage.locator('.settings-pane .sp-info')).toContainText('此 Server 尚未启用 Sandbox');
    await expect(chatPage.locator('.settings-pane .sp-error')).toHaveCount(0);
    expect(await sandboxLayout(chatPage)).toEqual({
      viewportWidth: 320,
      documentOverflow: false,
      dialogOverflow: false,
      contentOverflow: false,
    });
    expect(sandboxRequests).toEqual(['/api/sandbox/capability']);
  });
});
