import { test } from '../../fixtures/test-server.js';
import { expect } from '@playwright/test';

test.describe('侧边栏交互', () => {
  /** Helper: create a conversation via modal */
  async function createConversation(chatPage) {
    await chatPage.locator('.session-tab-add-btn').click();
    await chatPage.waitForSelector('.modal-overlay', { timeout: 5000 });
    await chatPage.waitForFunction(() => {
      const sel = document.querySelector('.resume-select');
      return sel && sel.options.length > 1;
    }, { timeout: 5000 });
    await chatPage.locator('.resume-select').first().selectOption({ index: 1 });
    await chatPage.click('.modern-btn');
    await chatPage.waitForSelector('.session-item.active', { timeout: 5000 });
  }

  test('侧边栏默认展开状态', async ({ chatPage }) => {
    const sidebar = chatPage.locator('.sidebar');
    await expect(sidebar).toBeVisible();
    await expect(sidebar).not.toHaveClass(/collapsed/);
  });

  test('项目较少时最近列表紧随其后，项目较多时项目区半高滚动', async ({ chatPage, mockAgent }) => {
    await chatPage.setViewportSize({ width: 1400, height: 900 });

    const makeSession = (id, title) => ({
      catalogKey: `yeaft:${mockAgent.agentId}:${id}`,
      runtimeProvider: 'yeaft',
      routeRef: { runtimeProvider: 'yeaft', agentId: mockAgent.agentId, sessionId: id },
      title,
      availability: 'online',
      createdAt: '2026-08-03T00:00:00.000Z',
      metadataUpdatedAt: '2026-08-03T00:00:00.000Z',
    });
    const setSidebarData = async ({ projects, sessions }) => {
      await chatPage.evaluate(({ nextProjects, nextSessions }) => {
        window.Pinia.useChatStore().applySessionCatalogSnapshot(nextSessions, nextProjects);
      }, { nextProjects: projects, nextSessions: sessions });
      await expect(chatPage.locator('.sidebar-project')).toHaveCount(projects.length);
    };
    const readLayout = () => chatPage.evaluate(() => {
      const results = document.querySelector('.sidebar-session-results');
      const projects = document.querySelector('.projects-section');
      const recents = document.querySelector('.recents-section');
      const lastProject = projects.querySelector('.sidebar-project:last-child');
      const recentHeading = recents.querySelector('.sidebar-section-heading');
      const projectStyle = getComputedStyle(projects);
      return {
        availableHeight: results.getBoundingClientRect().height,
        projectHeight: projects.getBoundingClientRect().height,
        projectScrollHeight: projects.scrollHeight,
        projectClientHeight: projects.clientHeight,
        projectOverflowY: projectStyle.overflowY,
        projectScrollTop: projects.scrollTop,
        recentScrollHeight: recents.scrollHeight,
        recentClientHeight: recents.clientHeight,
        recentGap: recentHeading.getBoundingClientRect().top - lastProject.getBoundingClientRect().bottom,
      };
    });

    const recentSessions = [
      makeSession('recent-1', 'Recent one'),
      makeSession('recent-2', 'Recent two'),
      makeSession('recent-3', 'Recent three'),
    ];
    const compactProjects = [
      { id: 'project-one', name: 'Project one', members: [] },
      { id: 'project-two', name: 'Project two', members: [] },
    ];

    for (const theme of ['light', 'dark']) {
      await chatPage.evaluate(value => {
        document.documentElement.setAttribute('data-theme', value);
        localStorage.setItem('theme', value);
      }, theme);
      await setSidebarData({ projects: compactProjects, sessions: recentSessions });
      const compact = await readLayout();
      expect(compact.projectHeight).toBeLessThan(compact.availableHeight / 2);
      expect(compact.projectScrollHeight).toBe(compact.projectClientHeight);
      expect(compact.recentGap).toBeGreaterThanOrEqual(0);
      expect(compact.recentGap).toBeLessThanOrEqual(12);

      const manyRecents = Array.from({ length: 20 }, (_, index) => (
        makeSession(`recent-${index}`, `Recent ${index}`)
      ));
      await setSidebarData({ projects: compactProjects, sessions: manyRecents });
      const crowdedRecents = await readLayout();
      expect(crowdedRecents.projectHeight).toBe(compact.projectHeight);
      expect(crowdedRecents.projectScrollHeight).toBe(crowdedRecents.projectClientHeight);
      expect(crowdedRecents.recentScrollHeight).toBeGreaterThan(crowdedRecents.recentClientHeight);

      const manyProjects = Array.from({ length: 20 }, (_, index) => ({
        id: `project-${index}`,
        name: `Project ${index}`,
        members: [],
      }));
      await setSidebarData({ projects: manyProjects, sessions: recentSessions });
      const overflowing = await readLayout();
      expect(Math.abs(overflowing.projectHeight - overflowing.availableHeight / 2)).toBeLessThanOrEqual(1);
      expect(overflowing.projectScrollHeight).toBeGreaterThan(overflowing.projectClientHeight);
      expect(overflowing.projectOverflowY).toBe('auto');

      await chatPage.locator('.projects-section').evaluate(element => { element.scrollTop = 80; });
      await expect.poll(async () => (await readLayout()).projectScrollTop).toBeGreaterThan(0);
    }
  });

  test('点击折叠按钮收起侧边栏', async ({ chatPage }) => {
    const sidebar = chatPage.locator('.sidebar');
    await chatPage.locator('.sidebar-header-row .sidebar-header-actions .sidebar-icon-btn').first().click();
    await expect(sidebar).toHaveClass(/collapsed/, { timeout: 3000 });
    await expect(chatPage.locator('.sidebar-collapsed-bar')).toBeVisible();
  });

  test('折叠后点击展开按钮恢复侧边栏', async ({ chatPage }) => {
    const sidebar = chatPage.locator('.sidebar');
    await chatPage.locator('.sidebar-header-row .sidebar-header-actions .sidebar-icon-btn').first().click();
    await expect(sidebar).toHaveClass(/collapsed/, { timeout: 3000 });
    await chatPage.locator('.sidebar-collapsed-bar .collapsed-icon-btn').first().click();
    await expect(sidebar).not.toHaveClass(/collapsed/, { timeout: 3000 });
  });

  test('创建会话后显示在侧边栏列表中', async ({ chatPage, mockAgent }) => {
    const before = await chatPage.locator('.session-item').count();
    await createConversation(chatPage);
    await expect(chatPage.locator('.session-item')).toHaveCount(before + 1);
    await expect(chatPage.locator('.session-item.active')).toBeVisible();
  });

  test('会话切换：创建两个会话后可切换', async ({ chatPage, mockAgent }) => {
    const before = await chatPage.locator('.session-item').count();
    await createConversation(chatPage);
    await expect(chatPage.locator('.session-item')).toHaveCount(before + 1);

    await createConversation(chatPage);
    await expect(chatPage.locator('.session-item')).toHaveCount(before + 2, { timeout: 5000 });

    // Click the non-active session to switch
    const sessions = chatPage.locator('.session-item');
    const count = await sessions.count();
    for (let i = 0; i < count; i++) {
      const isActive = await sessions.nth(i).evaluate(el => el.classList.contains('active'));
      if (!isActive) {
        await sessions.nth(i).click();
        break;
      }
    }
    await expect(chatPage.locator('.session-item.active')).toHaveCount(1);
  });

  test('删除会话：点击删除按钮移除会话', async ({ chatPage, mockAgent }) => {
    await createConversation(chatPage);
    const after = await chatPage.locator('.session-item').count();
    expect(after).toBeGreaterThanOrEqual(1);

    // Auto-accept the confirm dialog
    chatPage.on('dialog', dialog => dialog.accept());

    await chatPage.locator('.session-item.active').hover();
    await chatPage.locator('.session-item.active .session-dots-btn').click();
    await chatPage.locator('.session-menu-item.danger').click();
    await expect(chatPage.locator('.session-item')).toHaveCount(after - 1, { timeout: 5000 });
  });
});
