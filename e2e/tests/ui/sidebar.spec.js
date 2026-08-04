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

  test('新建聊天使用留白编辑图标，项目创建按钮仅在标题交互时显示', async ({ chatPage, mockAgent }) => {
    await chatPage.evaluate(({ agentId }) => {
      window.Pinia.useChatStore().applySessionCatalogSnapshot([{
        catalogKey: `yeaft:${agentId}:font-reference`,
        runtimeProvider: 'yeaft',
        routeRef: { runtimeProvider: 'yeaft', agentId, sessionId: 'font-reference' },
        title: 'Font reference',
        availability: 'online',
        createdAt: '2026-08-03T00:00:00.000Z',
        metadataUpdatedAt: '2026-08-03T00:00:00.000Z',
      }], []);
    }, { agentId: mockAgent.agentId });
    await expect(chatPage.locator('.sidebar-session-title-text')).toHaveCount(1);

    const newChat = chatPage.locator('.sidebar-primary-action');
    const projectHeading = chatPage.locator('.projects-section > .sidebar-section-heading');
    const newProject = projectHeading.locator('.sidebar-project-add-button');
    const recentsHeading = chatPage.locator('.recents-section > .sidebar-section-heading');
    const recentsCreate = recentsHeading.locator('.sidebar-recents-create');

    await expect(newChat).toHaveText('New chat');
    await expect(newChat).toHaveAccessibleName('New chat');
    await expect(newChat).toHaveAttribute('title', 'New chat');
    await expect(newChat.locator('.sidebar-primary-action-icon')).toBeVisible();
    await expect(newProject).toHaveAccessibleName('New project');

    await chatPage.evaluate(() => window.Pinia.useChatStore().changeLocale('zh-CN'));
    await expect(newChat).toHaveText('新建聊天');
    await expect(newChat).toHaveAccessibleName('新建聊天');
    await expect(newProject).toHaveAccessibleName('新建项目');

    for (const theme of ['light', 'dark']) {
      await chatPage.evaluate(value => {
        document.documentElement.setAttribute('data-theme', value);
        localStorage.setItem('theme', value);
      }, theme);
      const appearance = await chatPage.evaluate(() => {
        const chatButton = document.querySelector('.sidebar-primary-action');
        const firstSessionTitle = document.querySelector('.sidebar-session-title-text');
        const chatStyle = getComputedStyle(chatButton);
        return {
          height: chatButton.getBoundingClientRect().height,
          chatBackground: chatStyle.backgroundColor,
          chatBorderTopWidth: chatStyle.borderTopWidth,
          chatFontSize: Number.parseFloat(chatStyle.fontSize),
          sessionTitleFontSize: Number.parseFloat(getComputedStyle(firstSessionTitle).fontSize),
          chatFramePath: chatButton.querySelector('.sidebar-primary-action-frame').getAttribute('d'),
          chatPenPath: chatButton.querySelector('.sidebar-primary-action-pen').getAttribute('d'),
          recentsFramePath: document.querySelector('.sidebar-recents-create-frame').getAttribute('d'),
          recentsPenPath: document.querySelector('.sidebar-recents-create-pen').getAttribute('d'),
          projectMarkPath: document.querySelector('.sidebar-project-add-mark').getAttribute('d'),
        };
      });
      expect(appearance.height).toBeGreaterThanOrEqual(34);
      expect(appearance.chatBackground).toBe('rgba(0, 0, 0, 0)');
      expect(appearance.chatBorderTopWidth).toBe('0px');
      expect(appearance.chatFontSize).toBe(appearance.sessionTitleFontSize);
      expect(appearance.chatFramePath).toBe('M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7');
      expect(appearance.chatPenPath).toBe('M18.375 2.625a1 1 0 0 1 3 3l-9.013 9.014a2 2 0 0 1-.853.505l-2.873.84a.5.5 0 0 1-.62-.62l.84-2.873a2 2 0 0 1 .506-.852Z');
      expect(appearance.recentsFramePath).toBe(appearance.chatFramePath);
      expect(appearance.recentsPenPath).toBe(appearance.chatPenPath);
      expect(appearance.projectMarkPath).toBe('M12 5v14M5 12h14');
    }

    await chatPage.mouse.move(0, 0);
    await expect(newProject).toHaveCSS('opacity', '0');
    await expect(newProject).toHaveCSS('pointer-events', 'none');
    const hiddenHitTarget = await newProject.evaluate(button => {
      const bounds = button.getBoundingClientRect();
      const x = bounds.left + bounds.width / 2;
      const y = bounds.top + bounds.height / 2;
      const target = document.elementFromPoint(x, y);
      return {
        x,
        y,
        hitsButton: target === button || button.contains(target),
      };
    });
    expect(hiddenHitTarget.hitsButton).toBe(false);
    await chatPage.mouse.click(hiddenHitTarget.x, hiddenHitTarget.y);
    await expect(chatPage.locator('.sidebar-project-create')).toHaveCount(0);

    await newProject.focus();
    await expect(newProject).toHaveCSS('opacity', '1');
    await expect(newProject).toHaveCSS('pointer-events', 'auto');
    await newChat.focus();
    await chatPage.mouse.move(0, 0);
    await expect(newProject).toHaveCSS('opacity', '0');
    await expect(newProject).toHaveCSS('pointer-events', 'none');

    await projectHeading.locator('> span:first-child').hover();
    await expect(newProject).toHaveCSS('opacity', '1');
    await expect(newProject).toHaveCSS('pointer-events', 'auto');
    await newProject.click();
    await expect(chatPage.locator('.sidebar-project-create input')).toBeFocused();
    await expect(newProject).toBeDisabled();
    await newChat.hover();
    await expect(newProject).toHaveCSS('opacity', '0');
    await expect(newProject).toHaveCSS('pointer-events', 'none');
    await chatPage.keyboard.press('Escape');
    await expect(chatPage.locator('.sidebar-project-create')).toHaveCount(0);

    await chatPage.mouse.move(0, 0);
    await expect(recentsCreate).toHaveCSS('opacity', '0');
    await expect(recentsCreate).toHaveCSS('pointer-events', 'none');
    const hiddenRecentsHitTarget = await recentsCreate.evaluate(button => {
      const bounds = button.getBoundingClientRect();
      const x = bounds.left + bounds.width / 2;
      const y = bounds.top + bounds.height / 2;
      const target = document.elementFromPoint(x, y);
      return {
        x,
        y,
        hitsButton: target === button || button.contains(target),
      };
    });
    expect(hiddenRecentsHitTarget.hitsButton).toBe(false);
    await chatPage.mouse.click(hiddenRecentsHitTarget.x, hiddenRecentsHitTarget.y);
    await expect(chatPage.locator('.yeaft-session-create-modal')).toHaveCount(0);

    await recentsHeading.locator('> span:first-child').hover();
    await expect(recentsCreate).toHaveCSS('opacity', '1');
    await expect(recentsCreate).toHaveCSS('pointer-events', 'auto');
    await recentsCreate.click();
    await expect(chatPage.locator('.yeaft-session-create-modal')).toBeVisible();
    await chatPage.locator('.yeaft-session-create-modal .resume-close-btn').click();
    await expect(chatPage.locator('.yeaft-session-create-modal')).toHaveCount(0);

    await newChat.click();
    await expect(chatPage.locator('.yeaft-session-create-modal')).toBeVisible();
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

    const dragSessions = [
      { ...makeSession('project-first', 'Project first'), sortRank: 0 },
      { ...makeSession('project-second', 'Project second'), sortRank: 1 },
      { ...makeSession('recent-drag', 'Recent drag'), sortRank: 2 },
    ];
    const dragProjects = [{
      id: 'project-drag',
      name: 'Project drag',
      members: [
        { agentId: mockAgent.agentId, sessionId: 'project-first' },
        { agentId: mockAgent.agentId, sessionId: 'project-second' },
      ],
    }];
    await setSidebarData({ projects: dragProjects, sessions: dragSessions });
    await expect(chatPage.locator('.sidebar-session-row[draggable="true"]').first()).toHaveCSS('cursor', 'default');
    const dragResult = await chatPage.evaluate(async ({ agentId }) => {
      const store = window.Pinia.useChatStore();
      const originalMove = store.mutateProject;
      const originalReorder = store.reorderCatalogSessions;
      const calls = { moves: [], orders: [] };
      store.mutateProject = async (op, payload, targetAgentId) => {
        calls.moves.push({ op, payload, targetAgentId });
        if (op === 'move_session') {
          const orderedCatalog = payload.catalogOrder.map((item, sortRank) => ({
            ...store.sessionCatalog.find(row => row.catalogKey === item.catalogKey),
            sortRank,
          }));
          const projects = store.sessionProjects.map(project => ({
            ...project,
            members: project.members.filter(member => (
              member.agentId !== targetAgentId || member.sessionId !== payload.sessionId
            )),
          }));
          if (payload.projectId) {
            const project = projects.find(item => item.id === payload.projectId);
            project.members.push({ agentId: targetAgentId, sessionId: payload.sessionId });
          }
          store.applySessionCatalogSnapshot(orderedCatalog, projects);
        }
        return { ok: true };
      };
      store.reorderCatalogSessions = (rows) => {
        calls.orders.push(rows.map(row => row.catalogKey));
        store.applySessionCatalogSnapshot(
          rows.map((row, sortRank) => ({ ...row, sortRank })),
          store.sessionProjects,
        );
        return true;
      };

      const transfer = new DataTransfer();
      const dispatchDrag = (element, type, clientY) => element.dispatchEvent(new DragEvent(type, {
        bubbles: true,
        cancelable: true,
        dataTransfer: transfer,
        clientY,
      }));
      const rows = () => [...document.querySelectorAll('.sidebar-project-sessions .session-item')];
      const recent = () => document.querySelector('.recents-section .session-item');
      const titles = selector => [...document.querySelectorAll(selector)]
        .map(row => row.querySelector('.sidebar-session-title-text')?.textContent?.trim());

      let projectRows = rows();
      dispatchDrag(projectRows[1], 'dragstart', 0);
      const firstBounds = projectRows[0].getBoundingClientRect();
      dispatchDrag(projectRows[0], 'dragover', firstBounds.top + 1);
      await window.Vue.nextTick();
      const indicator = projectRows[0].classList.contains('drag-before');
      dispatchDrag(projectRows[0], 'drop', firstBounds.top + 1);
      await window.Vue.nextTick();
      const projectOrder = titles('.sidebar-project-sessions .session-item');

      const recentRow = recent();
      projectRows = rows();
      dispatchDrag(recentRow, 'dragstart', 0);
      const secondBounds = projectRows[1].getBoundingClientRect();
      dispatchDrag(projectRows[1], 'dragover', secondBounds.top + 1);
      dispatchDrag(projectRows[1], 'drop', secondBounds.top + 1);
      await new Promise(resolve => setTimeout(resolve, 0));
      await window.Vue.nextTick();
      const crossSectionOrder = titles('.sidebar-project-sessions .session-item');
      const recentOrder = titles('.recents-section .session-item');

      store.mutateProject = originalMove;
      store.reorderCatalogSessions = originalReorder;
      return { calls, indicator, projectOrder, crossSectionOrder, recentOrder, agentId };
    }, { agentId: mockAgent.agentId });
    expect(dragResult.indicator).toBe(true);
    expect(dragResult.projectOrder).toEqual(['Project second', 'Project first']);
    expect(dragResult.crossSectionOrder).toEqual(['Project second', 'Recent drag', 'Project first']);
    expect(dragResult.recentOrder).toEqual([]);
    expect(dragResult.calls.moves).toEqual([{
      op: 'move_session',
      payload: {
        sessionId: 'recent-drag',
        projectId: 'project-drag',
        catalogOrder: [
          expect.objectContaining({ catalogKey: `yeaft:${mockAgent.agentId}:project-second` }),
          expect.objectContaining({ catalogKey: `yeaft:${mockAgent.agentId}:recent-drag` }),
          expect.objectContaining({ catalogKey: `yeaft:${mockAgent.agentId}:project-first` }),
        ],
      },
      targetAgentId: mockAgent.agentId,
    }]);
    expect(dragResult.calls.orders).toHaveLength(1);
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
