import { test } from '../../fixtures/test-server.js';
import { expect } from '@playwright/test';

async function openYeaftWorkbench(chatPage, mockAgent, { closeSessionStatus = false } = {}) {
  await chatPage.evaluate(({ agentId }) => {
    const store = window.Pinia.useChatStore();
    const sessionsStore = window.Pinia.useSessionsStore();
    const sessionId = 'workbench-session';
    const conversationId = 'workbench-conversation';
    const agent = {
      id: agentId,
      name: 'Workbench agent',
      online: true,
      status: 'ready',
      capabilities: ['terminal', 'file_editor', 'work_center'],
    };

    sessionsStore.applySnapshot([{
      id: sessionId,
      name: 'Workbench session',
      roster: ['omni'],
      defaultVpId: 'omni',
    }], agentId);
    sessionsStore.setActive(sessionId, agentId);

    store.agents = [agent];
    store.currentAgent = agentId;
    store.currentAgentInfo = agent;
    store._hasHandledAgentList = true;
    store._hasHandledYeaftSessionHydrate = true;
    store.yeaftSessionHydrateError = null;
    store.yeaftHistoryLoadError = null;
    store.yeaftActiveSessionFilter = sessionId;
    store.yeaftSessionAgentById = { ...store.yeaftSessionAgentById, [sessionId]: agentId };
    store.yeaftConversationId = conversationId;
    store.yeaftConversationIdsByAgent = { ...store.yeaftConversationIdsByAgent, [agentId]: conversationId };
    store.messagesMap[conversationId] = [];
    store.activeConversations = [conversationId];
    store.currentView = 'yeaft';
  }, { agentId: mockAgent.agentId });

  await expect(chatPage.locator('.yeaft-main')).toBeVisible();
  if (closeSessionStatus) {
    const closeButton = chatPage.locator('.yeaft-session-status-close');
    await expect(closeButton).toBeVisible();
    await closeButton.click();
    await expect(closeButton).toHaveCount(0);
  }
  const workbenchButton = chatPage.locator('.yeaft-session-actions [aria-label="Workbench"]');
  await expect(workbenchButton).toBeVisible();
  await workbenchButton.click();
  await expect(chatPage.locator('.workbench-panel')).toHaveClass(/expanded/);
}

test.describe('Workbench', () => {
  test('opens the Terminal tab', async ({ chatPage, mockAgent }) => {
    await openYeaftWorkbench(chatPage, mockAgent);

    const panel = chatPage.locator('.workbench-panel');
    await expect(panel.locator('.wb-tab', { hasText: 'Terminal' })).toBeVisible();
  });

  test('switches to the Terminal tab', async ({ chatPage, mockAgent }) => {
    await openYeaftWorkbench(chatPage, mockAgent);

    const terminalTab = chatPage.locator('.workbench-panel .wb-tab', { hasText: 'Terminal' });
    await terminalTab.click();
    await expect(terminalTab).toHaveClass(/active/);
  });

  test('maximizes across the conversation area and restores it', async ({ chatPage, mockAgent }) => {
    await openYeaftWorkbench(chatPage, mockAgent);

    const page = chatPage.locator('.yeaft-page');
    const main = chatPage.locator('.yeaft-main');
    const panel = chatPage.locator('.workbench-panel');
    const maximizeButton = panel.locator('.workbench-maximize-btn');
    await expect(maximizeButton).toHaveAttribute('aria-label', 'Maximize panel');

    const pageBox = await page.boundingBox();
    const sidebarBox = await chatPage.locator('.yeaft-sidebar').boundingBox();
    expect(pageBox).not.toBeNull();
    expect(sidebarBox).not.toBeNull();

    for (const theme of ['light', 'dark']) {
      await chatPage.evaluate(value => {
        document.documentElement.setAttribute('data-theme', value);
        localStorage.setItem('theme', value);
      }, theme);

      await maximizeButton.click();
      await expect(panel).toHaveClass(/maximized/);
      await expect(maximizeButton).toHaveAttribute('aria-label', 'Restore panel');
      await expect(main).toBeHidden();

      const maximizedBox = await panel.boundingBox();
      expect(maximizedBox).not.toBeNull();
      expect(maximizedBox.x).toBeLessThanOrEqual(sidebarBox.x + sidebarBox.width + 1);
      expect(maximizedBox.width).toBeGreaterThanOrEqual(pageBox.width - sidebarBox.width - 2);

      await maximizeButton.click();
      await expect(panel).not.toHaveClass(/maximized/);
      await expect(panel).toHaveClass(/expanded/);
      await expect(maximizeButton).toHaveAttribute('aria-label', 'Maximize panel');
      await expect(main).toBeVisible();
    }
  });

  test('fills a 320px viewport without leaving a conversation strip', async ({ chatPage, mockAgent }) => {
    await chatPage.setViewportSize({ width: 320, height: 720 });
    await openYeaftWorkbench(chatPage, mockAgent, { closeSessionStatus: true });

    const panel = chatPage.locator('.workbench-panel');
    const panelBox = await panel.boundingBox();
    expect(panelBox).not.toBeNull();
    expect(panelBox.x).toBeLessThanOrEqual(1);
    expect(panelBox.width).toBeGreaterThanOrEqual(318);
    await expect(panel.locator('.workbench-maximize-btn')).toBeVisible();
    await expect(panel.locator('.wb-tab-action').last()).toBeVisible();
  });

  test('uses a right-pointing control to hide the file tree', async ({ chatPage, mockAgent }) => {
    await openYeaftWorkbench(chatPage, mockAgent);

    const showTreeButton = chatPage.locator('.file-tree-expand-btn');
    await expect(showTreeButton).toBeVisible();
    await showTreeButton.click();

    const hideTreeButton = chatPage.locator('.file-tree-header:not([style*="display: none"]) .file-tree-collapse-btn').last();
    await expect(hideTreeButton).toBeVisible();
    await expect(hideTreeButton.locator('path')).toHaveAttribute(
      'd',
      'M8.59 16.59 13.17 12 8.59 7.41 10 6l6 6-6 6z',
    );
  });

  test('closes the Workbench', async ({ chatPage, mockAgent }) => {
    await openYeaftWorkbench(chatPage, mockAgent);

    const panel = chatPage.locator('.workbench-panel');
    await panel.locator('.wb-tab-action').last().click();
    await expect(panel).not.toHaveClass(/expanded/);
  });
});
