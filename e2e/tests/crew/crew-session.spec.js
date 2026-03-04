import { test } from '../../fixtures/test-server.js';
import { expect } from '@playwright/test';

test.describe('Crew 会话', () => {
  test('点击 Crew 按钮打开配置面板', async ({ chatPage }) => {
    const crewBtn = chatPage.locator('.sidebar-nav-item.crew-nav-item');
    await crewBtn.click();

    const panel = chatPage.locator('.crew-config-overlay');
    await expect(panel).toBeVisible({ timeout: 5000 });
    await expect(chatPage.locator('.crew-config-header h2')).toHaveText('Crew Session');
  });

  test('选择 Agent 后显示模板和角色配置', async ({ chatPage }) => {
    await chatPage.click('.sidebar-nav-item.crew-nav-item');
    await chatPage.waitForSelector('.crew-config-overlay', { timeout: 5000 });

    const agentSelect = chatPage.locator('.crew-config-select');
    await chatPage.waitForFunction(() => {
      const select = document.querySelector('.crew-config-select');
      return select && select.options.length > 1;
    }, { timeout: 5000 });
    await agentSelect.selectOption({ index: 1 });

    await expect(chatPage.locator('.crew-template-btns')).toBeVisible();
    await expect(chatPage.locator('.crew-template-btn', { hasText: '软件开发' })).toBeVisible();
    await expect(chatPage.locator('.crew-template-btn', { hasText: '写作团队' })).toBeVisible();
  });

  test('选择软件开发模板加载角色配置', async ({ chatPage }) => {
    await chatPage.click('.sidebar-nav-item.crew-nav-item');
    await chatPage.waitForSelector('.crew-config-overlay', { timeout: 5000 });

    const agentSelect = chatPage.locator('.crew-config-select');
    await chatPage.waitForFunction(() => {
      const select = document.querySelector('.crew-config-select');
      return select && select.options.length > 1;
    }, { timeout: 5000 });
    await agentSelect.selectOption({ index: 1 });

    await chatPage.click('.crew-template-btn:text("软件开发")');

    const roleItems = chatPage.locator('.crew-role-item');
    await expect(roleItems).toHaveCount(6, { timeout: 5000 });

    const roleNames = chatPage.locator('.crew-role-name-input');
    const names = await roleNames.evaluateAll(els => els.map(el => el.value));
    expect(names).toContain('PM-乔布斯');
    expect(names).toContain('开发者-托瓦兹');
  });

  test('关闭配置面板', async ({ chatPage }) => {
    await chatPage.click('.sidebar-nav-item.crew-nav-item');
    await chatPage.waitForSelector('.crew-config-overlay', { timeout: 5000 });
    await chatPage.click('.crew-config-close');
    await expect(chatPage.locator('.crew-config-overlay')).not.toBeVisible();
  });

  test('点击 overlay 外部关闭面板', async ({ chatPage }) => {
    await chatPage.click('.sidebar-nav-item.crew-nav-item');
    await chatPage.waitForSelector('.crew-config-overlay', { timeout: 5000 });
    await chatPage.locator('.crew-config-overlay').click({ position: { x: 10, y: 10 } });
    await expect(chatPage.locator('.crew-config-overlay')).not.toBeVisible();
  });
});
