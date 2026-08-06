/**
 * E2E Test: Conversation Management
 *
 * Tests conversation CRUD operations using SKIP_AUTH=true server.
 *   - Create a new conversation via the modal
 *   - Conversation appears in sidebar list
 *   - Remove a conversation from the sidebar without deleting its messages
 *   - Switch between conversations restores messages
 */
import { test } from '../../fixtures/test-server.js';
import { expect } from '@playwright/test';

/**
 * Helper: open the new-conversation modal and create a conversation.
 */
async function openConversationModal(chatPage) {
  // The catalog sidebar is the normal post-handshake surface. Keep the
  // legacy tab fallback so this test remains valid against older servers.
  const catalogCreate = chatPage.locator('.sidebar-primary-action');
  if (await catalogCreate.isVisible().catch(() => false)) {
    await catalogCreate.click();
    const modal = chatPage.locator('.yeaft-session-create-modal');
    await expect(modal).toBeVisible({ timeout: 5000 });
    await modal.locator('.resume-control-row').nth(1).locator('.modern-select-trigger').click();
    await chatPage.locator('.yeaft-session-create-select-menu .modern-select-option', {
      hasText: 'Claude Code',
    }).click();
    return modal;
  }

  await chatPage.locator('.session-tab-add-btn').click();
  const modal = chatPage.locator('.modal.resume-modal');
  await expect(modal).toBeVisible({ timeout: 5000 });
  return modal;
}

async function createConversation(chatPage) {
  const beforeCount = await chatPage.locator('.session-item').count();
  const modal = await openConversationModal(chatPage);
  await modal.locator('.resume-modal-footer .modern-btn').click();
  await expect(modal).not.toBeVisible({ timeout: 5000 });
  await expect(chatPage.locator('.session-item')).toHaveCount(beforeCount + 1, { timeout: 5000 });
}

test.describe('Conversation Management', () => {
  test('should create a new conversation via modal', async ({ chatPage, mockAgent }) => {
    const initialCount = await chatPage.locator('.session-item').count();

    await createConversation(chatPage, mockAgent);

    await expect(chatPage.locator('.session-item')).toHaveCount(initialCount + 1);
    await expect(chatPage.locator('.session-item.active')).toHaveCount(1);
  });

  test('should select agent in conversation modal', async ({ chatPage, mockAgent }) => {
    const modal = await openConversationModal(chatPage);
    const agentSelect = modal.locator('.modern-select-trigger').first();
    if (await agentSelect.isVisible().catch(() => false)) {
      await expect(agentSelect).toBeVisible();
      await agentSelect.click();
      await expect(chatPage.locator('.yeaft-session-create-select-menu .modern-select-option')).toHaveCount(1);
    } else {
      const legacyAgentSelect = modal.locator('.resume-select').first();
      await expect(legacyAgentSelect).toBeVisible();
      expect(await legacyAgentSelect.locator('option').count()).toBeGreaterThanOrEqual(2);
    }

    await modal.locator('.resume-close-btn').click();
    await expect(modal).not.toBeVisible();
  });

  test('should show conversation in sidebar list after creation', async ({ chatPage, mockAgent }) => {
    const initialCount = await chatPage.locator('.session-item').count();

    await createConversation(chatPage, mockAgent);
    await expect(chatPage.locator('.session-item')).toHaveCount(initialCount + 1);

    await createConversation(chatPage, mockAgent);
    await expect(chatPage.locator('.session-item')).toHaveCount(initialCount + 2);

    await expect(chatPage.locator('.session-item.active')).toHaveCount(1);
  });

  test('should hide a conversation from the sidebar without deleting it', async ({ chatPage, mockAgent }) => {
    const initialCount = await chatPage.locator('.session-item').count();

    await createConversation(chatPage, mockAgent);
    await expect(chatPage.locator('.session-item')).toHaveCount(initialCount + 1);
    const created = mockAgent._receivedMessages.filter(m => m.type === 'create_conversation').at(-1);
    expect(created?.conversationId).toBeTruthy();

    const activeItem = chatPage.locator('.session-item.active');
    const removeButton = activeItem.locator('.session-quick-action:has(.session-remove-icon)');
    await activeItem.hover();
    await expect(removeButton).toBeVisible({ timeout: 3000 });
    await removeButton.click();

    await expect(chatPage.locator('.session-item')).toHaveCount(initialCount, { timeout: 10000 });
    expect(mockAgent._receivedMessages.filter(m => m.type === 'delete_conversation'
      && m.conversationId === created.conversationId)).toHaveLength(0);

    await chatPage.locator('.sidebar-primary-action').click();
    await expect(chatPage.locator('.yeaft-session-create-modal')).toBeVisible();
    const hiddenSession = chatPage.locator('.yeaft-session-create-modal .resume-list-item', {
      hasText: created.conversationId.slice(0, 8),
    });
    await expect(hiddenSession).toBeVisible();
    await hiddenSession.click();
    await expect(chatPage.locator('.yeaft-session-create-modal')).not.toBeVisible({ timeout: 5000 });
    await expect.poll(() => chatPage.evaluate(id => {
      const store = window.Pinia.useChatStore();
      return {
        visible: store.sessionCatalog.some(row => row.routeRef?.sessionId === id),
        hidden: store.hiddenSessionCatalog.some(row => row.routeRef?.sessionId === id),
      };
    }, created.conversationId), { timeout: 10000 }).toEqual({ visible: true, hidden: false });
    expect(mockAgent._receivedMessages.filter(m => m.type === 'delete_conversation'
      && m.conversationId === created.conversationId)).toHaveLength(0);
  });

  test('should switch between conversations and restore messages', async ({ chatPage, mockAgent }) => {
    await createConversation(chatPage, mockAgent);

    // Get conversationId from mockAgent's received messages
    const createMsg = mockAgent._receivedMessages.filter(m => m.type === 'create_conversation').pop();
    const firstConversationId = createMsg?.conversationId;

    await chatPage.fill('.input-area textarea', 'Message in first conversation');
    await chatPage.locator('.send-btn').last().click();

    await expect(chatPage.locator('.message.user').last())
      .toContainText('Message in first conversation', { timeout: 5000 });

    mockAgent.simulateClaudeOutput(firstConversationId, 'Reply to first conversation');
    mockAgent.simulateTurnComplete(firstConversationId);
    await expect(chatPage.locator('.assistant-turn').last())
      .toContainText('Reply to first conversation', { timeout: 5000 });

    // Create second conversation
    await createConversation(chatPage, mockAgent);

    await expect(chatPage.locator('.session-item.active')).toHaveCount(1);
    await expect(chatPage.locator('.message.user')).toHaveCount(0, { timeout: 3000 });

    // Switch back to first conversation by clicking the session item with our title
    const firstConvItem = chatPage.locator('.session-item', { hasText: 'Message in first conversation' });
    const itemExists = await firstConvItem.count();
    if (itemExists > 0) {
      await firstConvItem.first().click();

      await expect(chatPage.locator('.message.user').first())
        .toContainText('Message in first conversation', { timeout: 5000 });
    }
  });
});
