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
      capabilities: ['terminal', 'file_editor', 'workbench_session_routes', 'work_center'],
    };

    sessionsStore.applySnapshot([{
      id: sessionId,
      name: 'Workbench session',
      roster: ['omni'],
      defaultVpId: 'omni',
      workDir: '/tmp/test',
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

  mockAgent.send({
    type: 'session_list_updated',
    sessions: [{
      id: 'workbench-session',
      name: 'Workbench session',
      roster: ['omni'],
      defaultVpId: 'omni',
      workDir: '/tmp/test',
    }],
  });

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

function capability(panel, id) {
  return panel.locator(`[data-workbench-capability="${id}"]`);
}

async function openChatWorkbench(chatPage, mockAgent) {
  await chatPage.evaluate(({ agentId }) => {
    const store = window.Pinia.useChatStore();
    const conversationId = 'chat-workbench-conversation';
    const agent = {
      id: agentId,
      name: 'Workbench agent',
      online: true,
      status: 'ready',
      capabilities: ['terminal', 'file_editor', 'workbench_session_routes', 'work_center'],
    };
    store.agents = [agent];
    store.currentAgent = agentId;
    store.currentAgentInfo = agent;
    store.conversations = [{
      id: conversationId,
      agentId,
      agentName: agent.name,
      workDir: '/tmp/workbench',
      provider: 'copilot',
      capabilities: { clear: true, mcp: true },
      type: 'chat',
    }];
    store.messagesMap[conversationId] = [];
    store.activeConversations = [conversationId];
    store.currentWorkDir = '/tmp/workbench';
    store.currentView = 'chat';
  }, { agentId: mockAgent.agentId });

  const workbenchButton = chatPage.locator('.chat-header [aria-label="Workbench"]');
  await expect(workbenchButton).toBeVisible();
  await workbenchButton.click();
  await expect(chatPage.locator('.workbench-panel')).toHaveClass(/expanded/);
}

test.describe('Workbench', () => {
  test('shows the Chat entry independently of provider capabilities', async ({ chatPage, mockAgent }) => {
    await openChatWorkbench(chatPage, mockAgent);

    const panel = chatPage.locator('.workbench-panel');
    await expect(panel.locator('.workbench-launcher')).toBeVisible();
    await expect(panel.locator('.workbench-capability-card')).toHaveCount(4);
  });

  test('opens a four-capability launcher instead of persistent tabs', async ({ chatPage, mockAgent }) => {
    await openYeaftWorkbench(chatPage, mockAgent);

    const panel = chatPage.locator('.workbench-panel');
    await expect(panel.locator('.workbench-launcher')).toBeVisible();
    await expect(panel.locator('.workbench-capability-card')).toHaveCount(4);
    await expect(capability(panel, 'terminal')).toBeVisible();
    await expect(capability(panel, 'git')).toBeVisible();
    await expect(capability(panel, 'files')).toBeVisible();
    await expect(capability(panel, 'browser')).toBeVisible();
    await expect(panel.locator('.wb-tab')).toHaveCount(0);
    await expect(capability(panel, 'browser').locator('.workbench-capability-status')).toHaveText('Unavailable on this Agent');
    await expect.poll(() => mockAgent.messages().filter(message => [
      'terminal_create', 'git_status', 'list_directory', 'restore_file_tabs',
    ].includes(message.type)).length).toBe(0);
  });

  test('opens Terminal and closes it back to the launcher', async ({ chatPage, mockAgent }) => {
    await openYeaftWorkbench(chatPage, mockAgent);

    const panel = chatPage.locator('.workbench-panel');
    const terminalCard = capability(panel, 'terminal');
    await terminalCard.focus();
    await terminalCard.press('Enter');
    await expect(panel.locator('.terminal-tab')).toBeVisible();
    await expect(panel.locator('.workbench-header-title')).toHaveText('Terminal');
    await expect(panel.locator('.workbench-launcher')).toHaveCount(0);
    await expect(panel.locator('.workbench-view-close')).toBeFocused();

    const terminalRequest = await mockAgent.waitForMessage('terminal_create');
    expect(terminalRequest).toMatchObject({
      agentId: mockAgent.agentId,
      workDir: '/tmp/test',
      workbenchRoute: {
        runtimeProvider: 'yeaft',
        agentId: mockAgent.agentId,
        sessionId: 'workbench-session',
      },
    });
    expect(terminalRequest.workbenchRouteKey).toBe(`yeaft:${encodeURIComponent(mockAgent.agentId)}:workbench-session`);
    expect(terminalRequest.conversationId).toBe(`_workbench:${terminalRequest.workbenchRouteKey}`);

    await panel.locator('.workbench-view-close').press('Enter');
    await expect(panel.locator('.workbench-launcher')).toBeVisible();
    await expect(panel.locator('.workbench-header-title')).toHaveText('Workbench');
    await expect(capability(panel, 'terminal')).toBeFocused();

    const createCount = mockAgent.messages('terminal_create').length;
    await capability(panel, 'terminal').press('Enter');
    await expect(panel.locator('.terminal-tab')).toBeVisible();
    await expect.poll(() => mockAgent.messages('terminal_create').length).toBe(createCount);
  });

  test('resets route state when switching same-Agent Sessions and scopes Git and Files requests', async ({ chatPage, mockAgent }) => {
    await openYeaftWorkbench(chatPage, mockAgent);

    const panel = chatPage.locator('.workbench-panel');
    await capability(panel, 'terminal').click();
    await expect(panel.locator('.terminal-tab')).toBeVisible();
    const terminalA = await mockAgent.waitForMessage('terminal_create');
    expect(terminalA.workbenchRoute?.sessionId).toBe('workbench-session');
    await panel.locator('.workbench-view-close').click();
    await capability(panel, 'git').click();
    await expect(panel.locator('.git-status-tab')).toBeVisible();
    const gitRequest = await mockAgent.waitForMessage('git_status');
    expect(gitRequest).toMatchObject({
      workDir: '/tmp/test',
      workbenchRoute: { runtimeProvider: 'yeaft', sessionId: 'workbench-session' },
    });

    const sessionB = {
      id: 'workbench-session-b',
      name: 'Workbench session B',
      roster: ['omni'],
      defaultVpId: 'omni',
      workDir: '/tmp/session-b',
    };
    mockAgent.send({
      type: 'session_list_updated',
      sessions: [{
        id: 'workbench-session', name: 'Workbench session', roster: ['omni'], defaultVpId: 'omni', workDir: '/tmp/test',
      }, sessionB],
    });
    await chatPage.evaluate(({ agentId, session }) => {
      const store = window.Pinia.useChatStore();
      const sessionsStore = window.Pinia.useSessionsStore();
      sessionsStore.applySnapshot([
        { id: 'workbench-session', name: 'Workbench session', roster: ['omni'], defaultVpId: 'omni', workDir: '/tmp/test' },
        session,
      ], agentId);
      sessionsStore.setActive(session.id, agentId);
      store.yeaftSessionAgentById = { ...store.yeaftSessionAgentById, [session.id]: agentId };
      store.yeaftActiveSessionFilter = session.id;
    }, { agentId: mockAgent.agentId, session: sessionB });

    await expect(panel.locator('.workbench-launcher')).toBeVisible();
    await expect(panel.locator('.git-status-tab')).toHaveCount(0);
    const terminalClose = await mockAgent.waitForMessage('terminal_close');
    expect(terminalClose).toMatchObject({
      terminalId: terminalA.terminalId,
      workbenchRoute: { sessionId: 'workbench-session' },
    });

    await capability(panel, 'terminal').click();
    const terminalB = await mockAgent.waitForMessage('terminal_create');
    expect(terminalB).toMatchObject({
      workDir: '/tmp/session-b',
      workbenchRoute: { sessionId: 'workbench-session-b' },
    });
    await panel.locator('.workbench-view-close').click();
    await capability(panel, 'files').click();
    await expect(panel.locator('.files-tab')).toBeVisible();
    const filesRequest = await mockAgent.waitForMessage('list_directory');
    expect(filesRequest).toMatchObject({
      workDir: '/tmp/session-b',
      workbenchRoute: {
        runtimeProvider: 'yeaft',
        agentId: mockAgent.agentId,
        sessionId: 'workbench-session-b',
      },
    });
    expect(filesRequest.workbenchRouteKey).toBe(`yeaft:${encodeURIComponent(mockAgent.agentId)}:workbench-session-b`);
  });

  test('keeps Browser discoverable without exposing a fake viewer when the Agent capability is absent', async ({ chatPage, mockAgent }) => {
    await openYeaftWorkbench(chatPage, mockAgent);

    const panel = chatPage.locator('.workbench-panel');
    await capability(panel, 'browser').click();
    await expect(panel.locator('.workbench-browser-view')).toBeVisible();
    await expect(panel.locator('.workbench-browser-view')).toContainText('Browser is disabled by the administrator');
    await expect(panel.locator('video')).toHaveCount(0);
    await expect(panel.locator('iframe')).toHaveCount(0);

    await panel.locator('.workbench-view-close').click();
    await expect(panel.locator('.workbench-launcher')).toBeVisible();
  });

  test('enables Browser once with real progress and opens the viewer automatically', async ({ chatPage, mockAgent }) => {
    mockAgent.pauseBrowserRuntimeInstall();
    await openYeaftWorkbench(chatPage, mockAgent);
    await chatPage.evaluate(agentId => {
      const store = window.Pinia.useChatStore();
      const agent = store.agents.find(item => item.id === agentId);
      agent.capabilities = [
        ...new Set([
          ...(agent.capabilities || []).filter(capability => ![
            'browser_runtime', 'browser_webrtc', 'browser_capture_tab',
          ].includes(capability)),
          'browser_runtime_setup',
        ]),
      ];
      store.currentAgentInfo = agent;
    }, mockAgent.agentId);

    const panel = chatPage.locator('.workbench-panel');
    await expect(capability(panel, 'browser').locator('.workbench-capability-status')).toHaveText('Enable required');
    const installsBefore = mockAgent.messages('browser_runtime_install').length;
    await capability(panel, 'browser').click();
    const status = await mockAgent.waitForMessage('browser_runtime_status');
    expect(status).toMatchObject({
      agentId: mockAgent.agentId,
      requestId: expect.any(String),
      serverIdentity: expect.objectContaining({ ownerUserId: expect.any(String) }),
    });
    await expect(panel.locator('.browser-setup-stage')).toBeVisible();
    await expect(panel.locator('.browser-setup-stage')).toContainText('Browser needs a pinned Chrome for Testing');
    await expect(panel.locator('.browser-setup-stage')).toContainText('184.3 MiB');
    await expect(panel.locator('.browser-setup-stage .btn-primary')).toContainText('Enable Browser');
    expect(mockAgent.messages('browser_runtime_install')).toHaveLength(installsBefore);

    for (const theme of ['light', 'dark']) {
      await chatPage.evaluate(value => document.documentElement.setAttribute('data-theme', value), theme);
      await chatPage.setViewportSize({ width: 320, height: 720 });
      await expect(chatPage.locator('html')).toHaveAttribute('data-theme', theme);
      const overflow = await panel.locator('.browser-setup-stage').evaluate(element => ({
        clientWidth: element.clientWidth,
        scrollWidth: element.scrollWidth,
      }));
      expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth + 1);
      await expect(panel.locator('.browser-setup-stage .btn-primary')).toBeVisible();
    }

    await panel.locator('.browser-setup-stage .btn-primary').click();
    const install = await mockAgent.waitForMessage('browser_runtime_install');
    expect(install).toMatchObject({
      agentId: mockAgent.agentId,
      confirmedBuildId: '151.0.7922.71',
      confirmedDownloadBytes: 193_285_407,
      serverIdentity: expect.objectContaining({ ownerUserId: expect.any(String) }),
    });
    const progress = panel.locator('.browser-install-progress');
    await expect(progress).toHaveAttribute('aria-valuenow', '50');
    await expect(progress).toHaveAttribute('aria-valuetext', '92.2 MiB of 184.3 MiB');
    await expect(panel.locator('.browser-install-percent')).toHaveText('50%');

    mockAgent.completeBrowserRuntimeInstall();
    await expect(panel.locator('.browser-video')).toBeVisible();
    await expect(panel.locator('.browser-setup-stage')).toHaveCount(0);
    expect(mockAgent.messages('browser_runtime_install')).toHaveLength(installsBefore + 1);
    expect(mockAgent.messages('browser_runtime_enable')).toHaveLength(0);
    await mockAgent.waitForMessage('browser_session_create');
  });

  test('keeps a failed Browser install visible after automatic status refresh and allows retry', async ({ chatPage, mockAgent }) => {
    const checksumError = 'Managed Chrome archive checksum mismatch for chrome-linux64.zip';
    mockAgent.failBrowserRuntimeInstall(checksumError);
    await openYeaftWorkbench(chatPage, mockAgent);
    await chatPage.evaluate(agentId => {
      const store = window.Pinia.useChatStore();
      const agent = store.agents.find(item => item.id === agentId);
      agent.capabilities = [
        ...new Set([
          ...(agent.capabilities || []).filter(capability => ![
            'browser_runtime', 'browser_webrtc', 'browser_capture_tab',
          ].includes(capability)),
          'browser_runtime_setup',
        ]),
      ];
      store.currentAgentInfo = agent;
    }, mockAgent.agentId);

    const panel = chatPage.locator('.workbench-panel');
    await capability(panel, 'browser').click();
    await mockAgent.waitForMessage('browser_runtime_status');
    const installButton = panel.locator('.browser-setup-stage .btn-primary');
    await expect(installButton).toBeEnabled();
    await installButton.click();
    await mockAgent.waitForMessage('browser_runtime_install');
    const refresh = await mockAgent.waitForMessage('browser_runtime_status');
    expect(refresh).toMatchObject({ agentId: mockAgent.agentId, requestId: expect.any(String) });

    await expect(panel.locator('.browser-setup-error')).toHaveText(checksumError);
    await expect(installButton).toBeEnabled();
    const attempts = mockAgent.messages('browser_runtime_install').length;
    await installButton.click();
    await expect.poll(() => mockAgent.messages('browser_runtime_install').length).toBe(attempts + 1);
  });

  test('creates a Browser Session and mounts the generation-fenced WebRTC viewer', async ({ chatPage, mockAgent }) => {
    mockAgent.browserRuntimeReady = true;
    await openYeaftWorkbench(chatPage, mockAgent);
    await chatPage.evaluate(agentId => {
      class E2EPeerConnection {
        constructor(config) {
          this.config = config;
          this.localDescription = null;
          this.remoteDescription = null;
          this.connectionState = 'new';
          this.onicecandidate = null;
          this.onconnectionstatechange = null;
          this.ontrack = null;
        }
        async setRemoteDescription(description) { this.remoteDescription = description; }
        async createAnswer() { return { type: 'answer', sdp: 'v=0\\r\\no=web-e2e 1 1 IN IP4 127.0.0.1\\r\\ns=Yeaft E2E\\r\\nt=0 0\\r\\n' }; }
        async setLocalDescription(description) { this.localDescription = description; }
        async addIceCandidate() {}
        close() { this.connectionState = 'closed'; }
      }
      window.RTCPeerConnection = E2EPeerConnection;
      const store = window.Pinia.useChatStore();
      const agent = store.agents.find(item => item.id === agentId);
      agent.capabilities = [
        ...new Set([
          ...(agent.capabilities || []),
          'browser_runtime', 'browser_webrtc', 'browser_capture_tab',
        ]),
      ];
      store.currentAgentInfo = agent;
    }, mockAgent.agentId);

    const panel = chatPage.locator('.workbench-panel');
    await expect(capability(panel, 'browser').locator('.workbench-capability-status')).toHaveText('Available');
    await capability(panel, 'browser').click();
    await expect(panel.locator('.browser-panel')).toBeVisible();
    await expect(panel.locator('.browser-start-form')).toBeVisible();
    await panel.locator('.browser-start-form input').fill('https://example.com/');
    await panel.locator('.browser-start-form .btn-primary').click();
    await expect(panel.locator('.browser-video')).toBeVisible();
    await expect(panel.locator('iframe')).toHaveCount(0);

    const list = await mockAgent.waitForMessage('browser_session_list');
    expect(list).toMatchObject({
      agentId: mockAgent.agentId,
      requestId: expect.any(String),
      serverIdentity: expect.objectContaining({ ownerUserId: expect.any(String) }),
    });
    const create = await mockAgent.waitForMessage('browser_session_create');
    expect(create).toMatchObject({
      agentId: mockAgent.agentId,
      requestId: expect.any(String),
      sourceRef: { kind: 'yeaft-session', sessionId: 'workbench-session' },
    });
    expect(create).not.toHaveProperty('_requestClientId');
    const prepare = await mockAgent.waitForMessage('browser_peer_prepare');
    expect(prepare).toMatchObject({
      browserSessionId: expect.any(String),
      peerId: expect.any(String),
      connectionGeneration: 1,
      serverIdentity: expect.objectContaining({ clientId: expect.any(String) }),
    });
    const answer = await mockAgent.waitForMessage('browser_peer_answer');
    expect(answer).toMatchObject({
      browserSessionId: prepare.browserSessionId,
      peerId: prepare.peerId,
      connectionGeneration: prepare.connectionGeneration,
      description: { type: 'answer', sdp: expect.stringContaining('web-e2e') },
    });

    const detachCount = mockAgent.messages('browser_peer_detach').length;
    await panel.locator('.browser-end-button').click();
    const close = await mockAgent.waitForMessage('browser_session_close');
    expect(close.browserSessionId).toBe(prepare.browserSessionId);
    expect(close.expectedRevision).toBe(2);
    expect(mockAgent.messages('browser_peer_detach')).toHaveLength(detachCount);
    await expect(panel.locator('.browser-video')).toHaveCount(0);
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

      await expect(panel.locator('.workbench-launcher')).toBeVisible();
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

  test('uses one launcher column at 320px without horizontal overflow', async ({ chatPage, mockAgent }) => {
    await chatPage.setViewportSize({ width: 320, height: 720 });
    await openYeaftWorkbench(chatPage, mockAgent, { closeSessionStatus: true });

    const panel = chatPage.locator('.workbench-panel');
    const panelBox = await panel.boundingBox();
    expect(panelBox).not.toBeNull();
    expect(panelBox.x).toBeLessThanOrEqual(1);
    expect(panelBox.width).toBeGreaterThanOrEqual(318);
    await expect(panel.locator('.workbench-maximize-btn')).toBeVisible();
    await expect(panel.locator('.workbench-panel-close')).toBeVisible();

    const cards = panel.locator('.workbench-capability-card');
    const firstBox = await cards.nth(0).boundingBox();
    const secondBox = await cards.nth(1).boundingBox();
    expect(firstBox).not.toBeNull();
    expect(secondBox).not.toBeNull();
    expect(secondBox.y).toBeGreaterThanOrEqual(firstBox.y + firstBox.height - 1);

    const overflow = await panel.evaluate(element => ({
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
    }));
    expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth + 1);
  });

  test('enters Files and uses a right-pointing control to hide the file tree', async ({ chatPage, mockAgent }) => {
    await openYeaftWorkbench(chatPage, mockAgent);

    const panel = chatPage.locator('.workbench-panel');
    await capability(panel, 'files').click();
    const showTreeButton = panel.locator('.file-tree-expand-btn');
    await expect(showTreeButton).toBeVisible();
    await showTreeButton.click();

    const hideTreeButton = panel.locator('.file-tree-header:not([style*="display: none"]) .file-tree-collapse-btn').last();
    await expect(hideTreeButton).toBeVisible();
    await expect(hideTreeButton.locator('path')).toHaveAttribute(
      'd',
      'M8.59 16.59 13.17 12 8.59 7.41 10 6l6 6-6 6z',
    );
  });

  test('closes the Workbench panel', async ({ chatPage, mockAgent }) => {
    await openYeaftWorkbench(chatPage, mockAgent);

    const panel = chatPage.locator('.workbench-panel');
    await panel.locator('.workbench-panel-close').click();
    await expect(panel).not.toHaveClass(/expanded/);
  });
});
