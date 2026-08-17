import { expect } from '@playwright/test';
import { test } from '../../fixtures/test-server.js';

test.describe('Dashboard 设置', () => {
  test('renders compact General and filterable Users/Agents details', async ({ page, serverUrl }) => {
    await page.goto(serverUrl);
    await page.waitForSelector('.chat-page', { timeout: 10000 });

    await page.locator('.sidebar-bottom .sidebar-nav-item').click();
    await expect(page.locator('.settings-dialog')).toBeVisible();
    await page.locator('.settings-nav-item', { hasText: 'Dashboard' }).click();

    await expect(page.locator('.db-general-section')).toBeVisible();
    await expect(page.locator('.db-general-row')).toBeVisible();
    await expect(page.locator('.db-stat-card')).toHaveCount(0);
    await expect(page.locator('.db-detail-section')).toBeVisible();
    await expect(page.locator('.db-detail-tab')).toHaveCount(2);
    await expect(page.locator('.db-filter-header')).toBeVisible();
    await expect(page.locator('.db-filter-select select')).toHaveValue('all');

    await page.locator('.db-detail-tab', { hasText: 'Agents' }).click();
    await expect(page.locator('.db-detail-panel')).toBeVisible();
    await expect(page.locator('.db-filter-header')).toBeVisible();
    await expect(page.locator('.db-filter-select select')).toHaveValue('all');

    await page.setViewportSize({ width: 320, height: 720 });
    const layout = await page.evaluate(() => ({
      documentOverflow: document.documentElement.scrollWidth > innerWidth,
      dialogOverflow: document.querySelector('.settings-dialog').scrollWidth
        > document.querySelector('.settings-dialog').clientWidth,
    }));
    expect(layout).toEqual({ documentOverflow: false, dialogOverflow: false });
  });
});
