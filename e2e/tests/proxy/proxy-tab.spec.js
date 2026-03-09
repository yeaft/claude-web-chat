import { test } from '../../fixtures/test-server.js';
import { expect } from '@playwright/test';

test.describe('端口代理', () => {
  async function openProxyPanel(chatPage) {
    // Proxy button is the 2nd sidebar-icon-btn (between collapse and workbench)
    const proxyBtn = chatPage.locator('.sidebar-header-actions .sidebar-icon-btn').nth(1);
    await proxyBtn.click();
    // Proxy opens in a modal overlay with .proxy-modal
    await expect(chatPage.locator('.proxy-modal')).toBeVisible({ timeout: 5000 });
  }

  test('打开 Proxy 面板显示端口代理界面', async ({ chatPage }) => {
    await openProxyPanel(chatPage);
    await expect(chatPage.locator('.proxy-title')).toHaveText('Port Proxy');
    await expect(chatPage.locator('.proxy-add-form')).toBeVisible();
  });

  test('添加端口到代理列表', async ({ chatPage, mockAgent }) => {
    await openProxyPanel(chatPage);

    const agentSelect = chatPage.locator('.proxy-tab .proxy-agent-inline .proxy-select');
    await chatPage.waitForFunction(() => {
      const select = document.querySelector('.proxy-tab .proxy-agent-inline .proxy-select');
      return select && select.options.length > 1;
    }, { timeout: 5000 });
    await agentSelect.selectOption({ index: 1 });

    await chatPage.fill('.proxy-input-port', '3000');
    await chatPage.fill('.proxy-input-label', 'my-app');
    await chatPage.click('.proxy-add-btn');

    const portItem = chatPage.locator('.proxy-port-item');
    await expect(portItem).toBeVisible({ timeout: 5000 });
    await expect(portItem.locator('.proxy-port-num')).toHaveText('3000');
    await expect(portItem.locator('.proxy-port-label')).toHaveText('my-app');
  });

  test('启用/禁用端口切换', async ({ chatPage, mockAgent }) => {
    await openProxyPanel(chatPage);

    const agentSelect = chatPage.locator('.proxy-tab .proxy-agent-inline .proxy-select');
    await chatPage.waitForFunction(() => {
      const select = document.querySelector('.proxy-tab .proxy-agent-inline .proxy-select');
      return select && select.options.length > 1;
    }, { timeout: 5000 });
    await agentSelect.selectOption({ index: 1 });
    await chatPage.fill('.proxy-input-port', '8080');
    await chatPage.click('.proxy-add-btn');

    const portItem = chatPage.locator('.proxy-port-item');
    await expect(portItem).toBeVisible({ timeout: 5000 });
    await expect(portItem).not.toHaveClass(/enabled/);

    await portItem.locator('.proxy-switch').click();
    await expect(portItem).toHaveClass(/enabled/, { timeout: 5000 });
    await expect(portItem.locator('.proxy-port-url')).toBeVisible();

    await portItem.locator('.proxy-switch').click();
    await expect(portItem).not.toHaveClass(/enabled/, { timeout: 5000 });
  });

  test('agent 上报端口后列表自动更新', async ({ chatPage, mockAgent }) => {
    await openProxyPanel(chatPage);

    const agentSelect = chatPage.locator('.proxy-tab .proxy-agent-inline .proxy-select');
    await chatPage.waitForFunction(() => {
      const select = document.querySelector('.proxy-tab .proxy-agent-inline .proxy-select');
      return select && select.options.length > 1;
    }, { timeout: 5000 });
    await agentSelect.selectOption({ index: 1 });

    mockAgent.reportPorts([
      { port: 5000, host: 'localhost', label: 'dev-server' }
    ]);

    const portItem = chatPage.locator('.proxy-port-item');
    await expect(portItem).toBeVisible({ timeout: 5000 });
    await expect(portItem.locator('.proxy-port-num')).toHaveText('5000');
  });
});
