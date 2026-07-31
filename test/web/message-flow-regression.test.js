// @vitest-environment happy-dom
import { mount } from '@vue/test-utils';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import * as Vue from 'vue';
import {
  addMessageToConversation,
  appendToAssistantMessageForConversation,
  finishStreamingForConversation,
  maxDbMessageId,
} from '../../web/stores/helpers/messages.js';
import UnifiedSessionList from '../../web/components/UnifiedSessionList.js';
import SidebarWorkCenter from '../../web/components/SidebarWorkCenter.js';
import WorkCenterPage from '../../web/components/WorkCenterPage.js';
import { yeaftSessionIdentityKey } from '../../web/stores/helpers/yeaft-session-identity.js';
import {
  beginCatalogMutation,
  beginChatHistoryRequest,
  cancelChatHistoryRequest,
  catalogKeyForRoute,
  chatCatalogKey,
  chatRouteRef,
  finishCatalogMutation,
  normalizeChatRuntimeProvider,
  yeaftCatalogKey,
  yeaftRouteRef,
} from '../../web/stores/helpers/session-catalog.js';
const storeFactories = new Map();
function defineStore(id, options) {
  return () => {
    if (storeFactories.has(id)) return storeFactories.get(id);
    const instance = Vue.reactive({ ...(typeof options.state === 'function' ? options.state() : {}) });
    for (const [name, getter] of Object.entries(options.getters || {})) {
      Object.defineProperty(instance, name, {
        enumerable: true,
        get() { return getter.call(instance, instance); },
      });
    }
    for (const [name, action] of Object.entries(options.actions || {})) {
      instance[name] = action.bind(instance);
    }
    storeFactories.set(id, instance);
    return instance;
  };
}
const runtimeSessionsStore = Vue.reactive({
  sessionList: [],
  activeSessionId: null,
  activeAgentId: null,
  sessionById(sessionId, agentId = null) {
    return this.sessionList.find(row => row.id === sessionId && (!agentId || row.agentId === agentId)) || null;
  },
  setActive(sessionId, agentId = null) {
    this.activeSessionId = sessionId;
    this.activeAgentId = agentId;
  },
});
globalThis.Pinia = {
  ...(globalThis.Pinia || {}),
  defineStore,
  useSessionsStore: () => runtimeSessionsStore,
};
const { useChatStore } = await import('../../web/stores/chat.js');
const { useSessionsStore } = await import('../../web/stores/sessions.js');
const { useVpStore } = await import('../../web/stores/vp.js');
const { default: SessionCreateModal } = await import('../../web/components/SessionCreateModal.js');
const { default: ChatPage } = await import('../../web/components/ChatPage.js');
const { default: YeaftSidebar } = await import('../../web/components/YeaftSidebar.js');
const {
  handleConversationCreated,
  handleConversationResumed,
  handleSyncMessagesResult,
} = await import('../../web/stores/helpers/handlers/conversationHandler.js');
const { handleAgentSelected } = await import('../../web/stores/helpers/handlers/agentHandler.js');
const { handleMessage } = await import('../../web/stores/helpers/messageHandler.js');

import {
  buildYeaftMessageTurnSpans,
  hasHiddenYeaftMessageTurns,
  sliceYeaftMessagesByRecentTurns,
} from '../../web/stores/helpers/yeaft-message-window.js';

function makeStore() {
  return {
    yeaftConversationId: 'conv-1',
    _currentYeaftSessionId: 'session-1',
    _currentYeaftVpId: 'vp-1',
    _currentYeaftTurnId: 'turn-1',
    messagesMap: { 'conv-1': [] },
    yeaftSessionHistoryState: {},
  };
}

describe('message flow regressions', () => {
  it('keeps same-id streaming updates in one assistant message', () => {
    const store = makeStore();

    appendToAssistantMessageForConversation(store, 'conv-1', 'hello ', {
      id: 'msg-1',
      sessionId: 'session-1',
      vpId: 'vp-1',
      turnId: 'turn-1',
    });
    appendToAssistantMessageForConversation(store, 'conv-1', 'world', {
      id: 'msg-1',
      sessionId: 'session-1',
      vpId: 'vp-1',
      turnId: 'turn-1',
    });

    expect(store.messagesMap['conv-1']).toHaveLength(1);
    expect(store.messagesMap['conv-1'][0]).toMatchObject({
      type: 'assistant',
      content: 'hello world',
      isStreaming: true,
      speakerVpId: 'vp-1',
      turnId: 'turn-1',
    });

    appendToAssistantMessageForConversation(store, 'conv-1', 'hello world!', {
      id: 'msg-1',
      turnId: 'turn-1',
    });

    expect(store.messagesMap['conv-1']).toHaveLength(1);
    expect(store.messagesMap['conv-1'][0]).toMatchObject({
      type: 'assistant',
      content: 'hello world!',
      isStreaming: true,
      speakerVpId: 'vp-1',
      turnId: 'turn-1',
    });

    finishStreamingForConversation(store, 'conv-1', { completeLifecycle: false });
    expect(store.messagesMap['conv-1'][0]).toMatchObject({
      content: 'hello world!',
      isStreaming: false,
      status: 'pending',
      turnId: 'turn-1',
    });
    expect(store.messagesMap['conv-1'][0]).not.toHaveProperty('turnEndAt');
  });

  it('keeps the largest persisted DB id when a streaming row is at the tail', () => {
    expect(maxDbMessageId([
      { id: 'optimistic-user', dbMessageId: 17 },
      { id: 'streaming-assistant-uuid', isStreaming: true },
    ])).toBe(17);
  });

  it('keeps Work Center inputs available and detail layouts responsive', async () => {
    const component = readFileSync(resolve(import.meta.dirname, '../../web/components/ChatInput.js'), 'utf8');
    const websocket = readFileSync(resolve(import.meta.dirname, '../../web/stores/helpers/websocket.js'), 'utf8');
    const chatStoreSource = readFileSync(resolve(import.meta.dirname, '../../web/stores/chat.js'), 'utf8');
    const chatPageSource = readFileSync(resolve(import.meta.dirname, '../../web/components/ChatPage.js'), 'utf8');
    const yeaftSidebarSource = readFileSync(resolve(import.meta.dirname, '../../web/components/YeaftSidebar.js'), 'utf8');
    const vpAvatarSource = readFileSync(resolve(import.meta.dirname, '../../web/components/VpAvatar.js'), 'utf8');
    const vpCss = readFileSync(resolve(import.meta.dirname, '../../web/styles/yeaft-vp.css'), 'utf8');
    const sidebarCss = readFileSync(resolve(import.meta.dirname, '../../web/styles/sidebar.css'), 'utf8');
    const yeaftSidebarCss = readFileSync(resolve(import.meta.dirname, '../../web/styles/yeaft-sidebar.css'), 'utf8');
    const variables = readFileSync(resolve(import.meta.dirname, '../../web/styles/variables.css'), 'utf8');
    const lightThemeVariables = variables.match(/:root\s*\{([\s\S]*?)\n\}/)?.[1] || '';
    const darkThemeVariables = variables.match(/\[data-theme="dark"\]\s*\{([\s\S]*?)\n\}/)?.[1] || '';
    expect(sidebarCss).toMatch(/\.unread-dot\s*\{[^}]*background:\s*var\(--success\)/);
    expect(yeaftSidebarCss).toMatch(/\.sidebar-primary-actions\s*\{[^}]*padding:\s*6px 8px 4px/);
    expect(yeaftSidebarCss).toMatch(/\.sidebar-session-row\s*\{[^}]*background:\s*transparent/);
    expect(yeaftSidebarCss).toMatch(/\.sidebar-session-title-text\s*\{[^}]*flex:\s*1[^}]*text-overflow:\s*ellipsis/);
    expect(yeaftSidebarCss).toMatch(/\.sidebar-session-unread\s*\{[^}]*background:\s*var\(--success\)/);
    expect(yeaftSidebarCss).toMatch(/\.sidebar-session-row\[draggable="true"\][^}]*\{[^}]*cursor:\s*default/);
    expect(yeaftSidebarCss).toMatch(/\.sidebar-project-create\s*\{[^}]*background:\s*var\(--bg-input-wrapper\)/);
    expect(yeaftSidebarCss).toMatch(/\.sidebar-session-menu-divider\s*\{[^}]*background:\s*var\(--border-light\)/);
    expect(vpAvatarSource).not.toContain('/assets/avatars/');
    expect(vpAvatarSource).not.toContain('<img');
    expect(vpCss).not.toContain('.vp-avatar-img');

    const first = chatRouteRef({ id: 'conversation-1', agentId: 'agent-a', provider: 'copilot' });
    const moved = chatRouteRef({ id: 'conversation-1', agentId: 'agent-b', provider: 'copilot' });
    expect(catalogKeyForRoute(first)).toBe('chat:conversation-1');
    expect(catalogKeyForRoute(moved)).toBe('chat:conversation-1');
    expect(yeaftCatalogKey('agent-a', 'same-id')).not.toBe(yeaftCatalogKey('agent-b', 'same-id'));
    expect(catalogKeyForRoute(yeaftRouteRef({ id: 'same-id', agentId: 'agent-b' }))).toBe('yeaft:agent-b:same-id');
    expect(normalizeChatRuntimeProvider(null)).toBe('claude-code');
    expect(normalizeChatRuntimeProvider('copilot')).toBe('copilot');
    expect(() => normalizeChatRuntimeProvider('unknown')).toThrow(/Unknown Chat runtime provider/);
    expect(() => chatCatalogKey('')).toThrow(/conversationId/);

    const catalogRows = [
      {
        catalogKey: 'yeaft:user_1770305719:server-instance:pinned',
        runtimeProvider: 'yeaft',
        routeRef: { runtimeProvider: 'yeaft', agentId: 'user_1770305719:server-instance', sessionId: 'pinned' },
        title: 'Pinned',
        workDir: '/repo',
        pinned: true,
        availability: 'online',
        createdAt: '2026-07-29T10:00:00.000Z',
        metadataUpdatedAt: '2026-07-29T10:00:00.000Z',
      },
      {
        catalogKey: 'chat:offline',
        runtimeProvider: 'copilot',
        routeRef: { runtimeProvider: 'copilot', agentId: 'agent-b', sessionId: 'offline' },
        title: 'Offline',
        pinned: false,
        availability: 'offline',
      },
      {
        catalogKey: 'chat:visible',
        runtimeProvider: 'copilot',
        routeRef: { runtimeProvider: 'copilot', agentId: 'agent-a', sessionId: 'visible' },
        title: 'Visible',
        pinned: false,
        availability: 'online',
        createdAt: '2026-07-29T09:00:00.000Z',
        metadataUpdatedAt: '2026-07-29T09:00:00.000Z',
        updatedAt: '2026-07-31T23:00:00.000Z',
      },
      {
        catalogKey: 'chat:visible-2',
        runtimeProvider: 'copilot',
        routeRef: { runtimeProvider: 'copilot', agentId: 'agent-a', sessionId: 'visible-2' },
        title: 'Visible 2',
        pinned: false,
        availability: 'online',
        createdAt: '2026-07-29T08:00:00.000Z',
        metadataUpdatedAt: '2026-07-29T11:00:00.000Z',
      },
    ];
    const sidebar = mount(UnifiedSessionList, {
      attachTo: document.body,
      props: {
        sessions: [],
        activeRoute: { runtimeProvider: 'copilot', agentId: 'agent-a', sessionId: 'visible' },
        processingConversations: { visible: true },
        isYeaftSessionProcessing: (sessionId, agentId) => sessionId === 'pinned' && agentId === 'user_1770305719:server-instance',
        isSessionUnread: row => row.catalogKey === 'chat:visible' || row.catalogKey.endsWith(':pinned'),
        workCenterOpen: true,
        agents: [
          { id: 'agent-a', name: 'Agent A', online: true },
          { id: 'user_1770305719:server-instance', name: 'server', online: true, capabilities: ['work_center'] },
          { id: 'agent-b', name: 'Agent B', online: false },
        ],
        projects: [
          { id: 'project-same', agentId: 'user_1770305719:server-instance', name: 'Online project', sessionIds: ['pinned'] },
          { id: 'project-same', agentId: 'agent-b', name: 'Offline project', sessionIds: [] },
        ],
      },
      global: { mocks: { $t: key => key } },
    });
    expect(sidebar.findAll('.sidebar-primary-actions')).toHaveLength(1);
    expect(sidebar.find('input[type="search"]').exists()).toBe(false);
    expect(sidebar.findAll('.sidebar-tool-button')).toHaveLength(1);
    expect(sidebar.findAll('.sidebar-section')).toHaveLength(2);
    expect(sidebar.findAll('.session-item')).toHaveLength(0);
    await sidebar.setProps({ sessions: catalogRows });
    expect(sidebar.findAll('.session-item')).toHaveLength(3);
    expect(sidebar.findAll('.session-item').some(item => item.text().includes('Offline'))).toBe(false);
    expect(sidebar.findAll('.sidebar-project')).toHaveLength(2);
    expect(sidebar.findAll('.sidebar-project-unread')).toHaveLength(1);
    expect(Object.fromEntries(sidebar.findAll('.sidebar-project').map(item => [
      item.get('.sidebar-project-toggle').text().replace(/\d+$/, ''),
      item.get('.sidebar-project-count').text(),
    ]))).toEqual({ 'Online project': '1', 'Offline project': '0' });
    expect(sidebar.findAll('.sidebar-project-header .session-dots-btn')).toHaveLength(1);
    expect(sidebar.get('.session-dots-btn').attributes('aria-label')).toBe('sidebar.projects.menu');

    await sidebar.get('.sidebar-tool-button').trigger('click');
    const projectCreateInput = sidebar.get('.sidebar-project-create input');
    expect(document.activeElement).toBe(projectCreateInput.element);
    await projectCreateInput.setValue('   ');
    expect(sidebar.get('.sidebar-project-create-confirm').attributes('disabled')).toBeDefined();
    await sidebar.get('.sidebar-project-create').trigger('keydown', { key: 'Escape' });
    expect(sidebar.find('.sidebar-project-create').exists()).toBe(false);

    await sidebar.get('.sidebar-tool-button').trigger('click');
    await sidebar.get('.sidebar-project-create input').setValue('  Workspace  ');
    let finishCreate;
    const createResult = new Promise(resolve => { finishCreate = resolve; });
    const dispatchProjectAction = vi.fn(() => createResult);
    sidebar.vm.dispatchProjectAction = dispatchProjectAction;
    const firstCreate = sidebar.vm.submitProjectCreate();
    const duplicateCreate = sidebar.vm.submitProjectCreate();
    expect(dispatchProjectAction).toHaveBeenCalledTimes(1);
    expect(dispatchProjectAction).toHaveBeenCalledWith({
      action: 'create',
      name: 'Workspace',
      agentId: 'agent-a',
    });
    finishCreate({ ok: true });
    await Promise.all([firstCreate, duplicateCreate]);
    await Vue.nextTick();
    expect(sidebar.find('.sidebar-project-create').exists()).toBe(false);

    const projectToggles = sidebar.findAll('.sidebar-project-toggle');
    await projectToggles[0].trigger('click');
    expect(sidebar.findAll('.sidebar-project-sessions')).toHaveLength(1);
    expect(sidebar.findAll('.sidebar-project-unread')).toHaveLength(1);
    expect(Object.fromEntries(sidebar.findAll('.sidebar-project').map(item => [
      item.get('.sidebar-project-toggle').text().replace(/\d+$/, ''),
      item.get('.sidebar-project-count').text(),
    ]))).toEqual({ 'Online project': '1', 'Offline project': '0' });
    await projectToggles[0].trigger('click');
    expect(sidebar.get('.session-dots-btn svg path').attributes('d')).toContain('M6 10');
    expect(sidebar.text()).toContain('Visible');
    expect(sidebar.text()).toContain('Pinned');
    expect(sidebar.findAll('.session-item').map(item => item.get('.sidebar-session-title-text').text())).toEqual(['Pinned', 'Visible 2', 'Visible']);
    expect(sidebar.findAll('.session-item.processing')).toHaveLength(2);
    expect(sidebar.findAll('.processing-dot')).toHaveLength(2);
    expect(sidebar.findAll('.session-pin-icon')).toHaveLength(1);
    expect(sidebar.findAll('.sidebar-session-meta')).toHaveLength(0);
    expect(sidebar.findAll('.sidebar-session-unread')).toHaveLength(3);
    expect(sidebar.find('.sidebar-project-unread').exists()).toBe(true);
    expect(sidebar.find('.session-item.active').text()).toContain('Visible');
    await sidebar.setProps({
      activeRoute: {
        runtimeProvider: 'yeaft',
        agentId: 'user_1770305719:server-instance',
        sessionId: 'pinned',
      },
    });
    expect(sidebar.findAll('.session-item')).toHaveLength(3);
    const firstRow = sidebar.findAll('.session-item')[0];
    expect(firstRow.get('.sidebar-session-copy').text()).toContain('Pinned');
    expect(firstRow.get('.sidebar-session-copy').text()).not.toContain('server');
    expect(firstRow.attributes('role')).toBe('button');
    expect(firstRow.attributes('tabindex')).toBe('0');
    expect(UnifiedSessionList.methods.providerLabel({ runtimeProvider: 'claude-code' })).toBe('Claude');
    expect(sidebar.text()).not.toContain('user_1770305719');
    expect(sidebar.findAll('.sidebar-project-header .session-dots-btn')).toHaveLength(1);
    expect(sidebar.findAll('.session-item .session-dots-btn')).toHaveLength(3);
    const selectCountBeforeSettingsKeyboard = sidebar.emitted('select')?.length || 0;
    const pinnedSettingsButton = firstRow.get('.session-dots-btn');
    await pinnedSettingsButton.trigger('keydown', { key: 'Enter' });
    expect(sidebar.emitted('select')?.length || 0).toBe(selectCountBeforeSettingsKeyboard);
    expect(sidebar.find('.session-menu').exists()).toBe(false);
    await pinnedSettingsButton.trigger('click');
    expect(sidebar.find('.session-menu').exists()).toBe(true);
    await pinnedSettingsButton.trigger('keydown', { key: ' ' });
    expect(sidebar.emitted('select')?.length || 0).toBe(selectCountBeforeSettingsKeyboard);
    expect(sidebar.find('.session-menu').exists()).toBe(true);
    expect(sidebar.get('.sidebar-session-menu-info').text()).toContain('server');
    expect(sidebar.get('.sidebar-session-menu-info').text()).toContain('Yeaft');
    expect(sidebar.find('.sidebar-session-menu-divider').exists()).toBe(true);
    const settingsAction = sidebar.findAll('.session-menu-item')
      .find(item => item.text() === 'yeaft.session.openSettings');
    expect(settingsAction).toBeTruthy();
    await settingsAction.trigger('click');
    expect(sidebar.emitted('action').at(-1)[0]).toMatchObject({
      action: 'settings',
      row: { catalogKey: 'yeaft:user_1770305719:server-instance:pinned' },
    });
    await sidebar.get('.sidebar-project-toggle').trigger('click');
    const pinnedRecentRow = sidebar.findAll('.session-item')
      .find(item => item.text().includes('Pinned'));
    expect(pinnedRecentRow).toBeTruthy();
    await pinnedRecentRow.get('.session-dots-btn').trigger('click');
    const recentSettingsAction = sidebar.findAll('.session-menu-item')
      .find(item => item.text() === 'yeaft.session.openSettings');
    expect(recentSettingsAction).toBeTruthy();
    await recentSettingsAction.trigger('click');
    expect(sidebar.emitted('action').at(-1)[0]).toMatchObject({
      action: 'settings',
      row: { catalogKey: 'yeaft:user_1770305719:server-instance:pinned' },
    });
    await sidebar.get('.sidebar-primary-action').trigger('click');
    expect(sidebar.emitted('close-work-center').at(-1)).toEqual([]);
    expect(sidebar.emitted('create').at(-1)).toEqual([]);
    const offlineRow = sidebar.findAll('.session-item').find(item => item.text().includes('Offline'));
    expect(offlineRow).toBeUndefined();
    await sidebar.setProps({
      sessions: [catalogRows[0]],
      agents: [{ id: 'agent-a', name: 'Agent A', online: true }],
    });
    expect(sidebar.findAll('.session-item')).toHaveLength(0);
    await sidebar.setProps({
      sessions: [catalogRows[0]],
      agents: [{ id: 'user_1770305719:server-instance', name: 'server', online: false }],
    });
    expect(sidebar.findAll('.session-item')).toHaveLength(0);
    expect(sidebar.findAll('.sidebar-project-unread')).toHaveLength(1);
    await sidebar.setProps({
      sessions: [{ ...catalogRows[0], availability: 'offline' }],
      agents: [{ id: 'user_1770305719:server-instance', name: 'server', online: true }],
    });
    expect(sidebar.findAll('.session-item')).toHaveLength(0);
    expect(sidebar.findAll('.sidebar-project-unread')).toHaveLength(1);
    await sidebar.setProps({
      sessions: catalogRows,
      agents: [
        { id: 'agent-a', name: 'Agent A', online: true },
        { id: 'user_1770305719:server-instance', name: 'server', online: true, capabilities: ['work_center'] },
        { id: 'agent-b', name: 'Agent B', online: false },
      ],
    });
    const originalPrompt = window.prompt;
    const originalConfirm = window.confirm;
    window.prompt = vi.fn();
    window.confirm = vi.fn();
    UnifiedSessionList.methods.renameProject.call(sidebar.vm, { id: 'project-same', agentId: 'agent-b', name: 'Offline project' });
    UnifiedSessionList.methods.deleteProject.call(sidebar.vm, { id: 'project-same', agentId: 'agent-b', name: 'Offline project' });
    UnifiedSessionList.methods.runAction.call(sidebar.vm, 'rename', catalogRows[1]);
    expect(window.prompt).not.toHaveBeenCalled();
    expect(window.confirm).not.toHaveBeenCalled();
    if (originalPrompt) window.prompt = originalPrompt;
    else delete window.prompt;
    if (originalConfirm) window.confirm = originalConfirm;
    else delete window.confirm;
    await sidebar.setProps({ processingConversations: {}, isYeaftSessionProcessing: () => false });
    expect(sidebar.findAll('.processing-dot')).toHaveLength(0);
    expect(UnifiedSessionList.template).toContain(':key="row.catalogKey"');
    expect(UnifiedSessionList.emits).toContain('project-action');
    expect(UnifiedSessionList.template).toContain('sidebar-project-header');
    expect(UnifiedSessionList.template).toContain("runAction('pin', row)");
    expect(UnifiedSessionList.template).toContain("runAction('settings', row)");
    expect(UnifiedSessionList.template).toContain("moveRow(row, project)");
    expect(UnifiedSessionList.template).toContain('sidebar-primary-actions');
    expect(UnifiedSessionList.template).not.toContain('sidebar-session-meta');
    expect(UnifiedSessionList.template).toContain('processing-dot');
    const documentAdd = vi.spyOn(document, 'addEventListener');
    const documentRemove = vi.spyOn(document, 'removeEventListener');
    sidebar.unmount();
    const lifecycleSidebar = mount(UnifiedSessionList, {
      props: { sessions: catalogRows, agents: [{ id: 'agent-a', online: true }] },
      global: { mocks: { $t: key => key } },
    });
    expect(documentAdd).toHaveBeenCalledWith('pointerdown', expect.any(Function), true);
    expect(documentAdd).toHaveBeenCalledWith('keydown', expect.any(Function));
    await lifecycleSidebar.find('.session-dots-btn').trigger('click');
    expect(lifecycleSidebar.find('.session-menu').exists()).toBe(true);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await Vue.nextTick();
    expect(lifecycleSidebar.find('.session-menu').exists()).toBe(false);
    lifecycleSidebar.unmount();
    expect(documentRemove).toHaveBeenCalledWith('pointerdown', expect.any(Function), true);
    expect(documentRemove).toHaveBeenCalledWith('keydown', expect.any(Function));
    documentAdd.mockRestore();
    documentRemove.mockRestore();
    const fallbackWorkCenter = mount(SidebarWorkCenter, {
      props: { agents: [] },
      global: { mocks: { $t: key => key } },
    });
    expect(fallbackWorkCenter.get('.sidebar-work-center-trigger').attributes('disabled')).toBeDefined();
    await fallbackWorkCenter.get('.sidebar-work-center-trigger').trigger('click');
    expect(fallbackWorkCenter.emitted('open')).toBeUndefined();
    fallbackWorkCenter.unmount();

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(() => Promise.resolve({ json: () => Promise.resolve({ version: '' }) }));
    const parentStore = Vue.reactive({
      sessionSidebarOpen: false,
      sidebarCollapsed: false,
      isSplitMode: false,
      workbenchExpanded: false,
      runningSubagentCount: 0,
      connectionState: 'connected',
      sessionCatalogLoaded: true,
      sessionCatalog: catalogRows,
      activeSessionRoute: { runtimeProvider: 'copilot', agentId: 'agent-a', sessionId: 'visible' },
      processingConversations: {},
      isYeaftSessionProcessing: () => false,
      isYeaftSessionUnread: () => false,
      agents: [{ id: 'agent-a', name: 'Agent A', online: true, capabilities: ['work_center'] }],
      workCenterOpen: false,
      workCenterAgentId: 'stale-agent',
      currentView: 'chat',
      activeConversationId: 'visible',
      conversations: [],
      folders: [],
      listFoldersForAgent: vi.fn(() => Promise.resolve([])),
      theme: 'light',
      openUnifiedSessionCreate: false,
      openUnifiedChatCreate: false,
      enterWorkCenter: vi.fn(),
      leaveWorkCenter: vi.fn(),
      openCatalogSession: vi.fn(),
      enterYeaft: vi.fn(),
      leaveYeaft: vi.fn(),
    });
    storeFactories.set('chat', parentStore);
    globalThis.Pinia.useChatStore = () => parentStore;
    const shellStub = { template: '<aside><slot name="collapsed"/><slot/></aside>' };
    const chatPage = mount(ChatPage, {
      global: {
        mocks: { $t: key => key },
        stubs: {
          SessionSidebarShell: shellStub,
          ChatHeader: true,
          MessageList: true,
          ChatInput: true,
          WorkbenchPanel: true,
          WorkCenterPage: true,
          SettingsPanel: true,
          ExpertPanel: true,
          SubAgentPanel: true,
          BtwOverlay: true,
          SplitPane: true,
          ModernSelect: true,
          SidebarModeToggle: true,
          SidebarAgentHeader: true,
          SidebarWorkCenter: true,
        },
      },
    });
    await chatPage.get('.sidebar-primary-action').trigger('click');
    expect(chatPage.vm.unifiedSessionCreateOpen).toBe(true);
    expect(chatPage.vm.unifiedSessionCreateProvider).toBe('yeaft');
    await chatPage.get('.sidebar-work-center-header-btn').trigger('click');
    expect(parentStore.enterWorkCenter).toHaveBeenCalledWith('agent-a');
    chatPage.unmount();

    parentStore.currentView = 'yeaft';
    parentStore.activeSessionRoute = {
      runtimeProvider: 'yeaft',
      agentId: 'user_1770305719:server-instance',
      sessionId: 'pinned',
    };
    parentStore.openUnifiedChatCreate = false;
    const yeaftSidebar = mount(YeaftSidebar, {
      global: {
        mocks: { $t: key => key },
        stubs: {
          SessionSidebarShell: shellStub,
          SessionCreateModal: true,
          SidebarModeToggle: true,
          SidebarAgentHeader: true,
          SidebarWorkCenter: true,
        },
      },
    });
    await yeaftSidebar.get('.sidebar-primary-action').trigger('click');
    expect(yeaftSidebar.vm.sessionCreateOpen).toBe(true);
    yeaftSidebar.unmount();
    globalThis.fetch = originalFetch;
    delete globalThis.Pinia.useChatStore;
    storeFactories.clear();

    expect(chatPageSource).toContain('@create="onUnifiedCreate"');
    expect(chatPageSource).not.toContain('</template>\n      </main>');
    expect(chatPageSource).toContain('sidebar-work-center-header-btn');
    expect(yeaftSidebarSource).toContain(':is-session-unread="isCatalogSessionUnread"');
    expect(chatPageSource).toContain('@action="onUnifiedSessionAction"');
    expect(yeaftSidebarSource).toContain('@create="onUnifiedCreate"');
    expect(yeaftSidebarSource).toContain('sidebar-work-center-header-btn');
    expect(chatPageSource).toContain(':active-route="store.activeSessionRoute"');
    expect(yeaftSidebarSource).toContain(':active-route="chatStore.activeSessionRoute"');
    expect(chatPageSource).toContain(':processing-conversations="store.processingConversations"');
    expect(chatPageSource).toContain(':agents="store.agents"');
    expect(yeaftSidebarSource).toContain(':is-yeaft-session-processing="chatStore.isYeaftSessionProcessing"');
    expect(yeaftSidebarSource).toContain(':agents="chatStore.agents"');
    expect(chatPageSource).not.toContain("action === 'split'");
    expect(chatPageSource).not.toContain('splitScreen.splitToPanel');
    expect(chatPageSource).not.toContain('split-to-panel-item');
    expect(yeaftSidebarSource).not.toContain("action === 'split'");
    expect(websocket).toContain('store.sessionCatalogLoaded = false;');
    expect(websocket).toContain('store.sessionCatalog = [];');
    expect(chatStoreSource).toContain("this.setActiveSessionFilter(sessionId, { agentId, force: true });");
    expect(chatStoreSource).toContain('requestChatHistory(conversationId');
    expect(chatStoreSource).toContain("type: 'set_session_ui_metadata'");
    expect(chatStoreSource).toContain("type: 'reorder_session_catalog'");
    expect((chatStoreSource.match(/type: 'sync_messages'/g) || [])).toHaveLength(1);
    expect(readFileSync(resolve(import.meta.dirname, '../../web/components/ChatHeader.js'), 'utf8')).not.toContain("type: 'sync_messages'");
    expect(readFileSync(resolve(import.meta.dirname, '../../web/stores/helpers/handlers/agentHandler.js'), 'utf8')).not.toContain("type: 'sync_messages'");

    const catalogStore = {
      sessionCatalog: [{ catalogKey: 'chat:offline', pinned: false }],
      sessionCatalogMutationRequests: {},
    };
    const previousCatalog = beginCatalogMutation(catalogStore, 'pin-1');
    catalogStore.sessionCatalog[0].pinned = true;
    expect(finishCatalogMutation(catalogStore, { requestId: 'pin-1', ok: false })).toBe(true);
    expect(catalogStore.sessionCatalog).toEqual(previousCatalog);
    expect(catalogStore.sessionCatalogMutationRequests).toEqual({});

    const historyStore = {
      messagesMap: { a: [], b: [] },
      activeConversations: ['b'],
      currentConversation: 'b',
      loadingMoreMessages: true,
      refreshingSessionMap: { a: true, b: true },
      chatSessionState: {},
      hasMoreMessages: false,
      chatHistoryRequests: {
        'chat:a': { requestId: 'request-a', catalogKey: 'chat:a', loading: true },
        'chat:b': { requestId: 'request-b', catalogKey: 'chat:b', loading: true },
      },
      formatDbMessageForHistoryHydration: vi.fn(row => ({ id: `row-${row.id}`, dbMessageId: row.id, type: row.role, content: row.content })),
      isCurrentChatHistoryResponse(msg) {
        return msg.catalogKey === `chat:${msg.conversationId}`
          && this.chatHistoryRequests[msg.catalogKey]?.requestId === msg.requestId;
      },
      finishChatHistoryRequest(msg) {
        if (!this.isCurrentChatHistoryResponse(msg)) return false;
        this.chatHistoryRequests[msg.catalogKey].loading = false;
        return true;
      },
      setRefreshingSession(id, value) { this.refreshingSessionMap[id] = value; },
    };
    expect(handleSyncMessagesResult(historyStore, {
      conversationId: 'a', catalogKey: 'chat:a', requestId: 'stale', mode: 'recent', messages: [], hasMore: false,
    })).toBe(false);
    expect(historyStore.refreshingSessionMap.a).toBe(true);
    expect(handleSyncMessagesResult(historyStore, {
      conversationId: 'a', catalogKey: 'chat:a', requestId: 'request-a', mode: 'recent', messages: [], hasMore: false,
    })).toBe(true);
    expect(historyStore.loadingMoreMessages).toBe(true);
    expect(historyStore.refreshingSessionMap.a).toBe(false);

    historyStore.chatHistoryRequestIdSupported = null;
    historyStore.chatHistoryRequests['chat:b'] = {
      requestId: 'legacy-b', catalogKey: 'chat:b', mode: 'recent', loading: true,
    };
    expect(handleSyncMessagesResult(historyStore, {
      conversationId: 'b', messages: [], hasMore: false,
    })).toBe(true);
    expect(historyStore.chatHistoryRequests['chat:b'].loading).toBe(false);
    expect(handleSyncMessagesResult(historyStore, {
      conversationId: 'b', messages: [{ id: 99, role: 'assistant', content: 'late' }], hasMore: false,
    })).toBe(false);
    expect(historyStore.messagesMap.b).toEqual([]);

    const historyActions = {
      chatHistoryConnectionGeneration: 2,
      chatHistoryRequests: {},
    };
    const failedRequestId = beginChatHistoryRequest(historyActions, 'offline', 'recent');
    expect(cancelChatHistoryRequest(historyActions, 'chat:offline', failedRequestId, 'send_failed')).toBe(true);
    expect(historyActions.chatHistoryRequests['chat:offline']).toMatchObject({
      loading: false,
      cancelled: true,
      error: 'send_failed',
      connectionGeneration: 2,
    });

    const workCenter = readFileSync(resolve(import.meta.dirname, '../../web/components/WorkCenterPage.js'), 'utf8');
    const workCenterCss = readFileSync(resolve(import.meta.dirname, '../../web/styles/work-center.css'), 'utf8');

    expect(component).toContain('v-if="isStopVisible"');
    expect(component).not.toContain('v-else\n          type="button"\n          class="send-btn"');
    expect(component).toContain('if (isCompacting.value) return false;');
    expect(component).not.toContain('if (isCompacting.value || isStopVisible.value) return false;');
    expect(component).toContain('if (!canSend.value) return;');
    expect(component).not.toContain('if (isStopVisible.value || !canSend.value) return;');
    expect(workCenter).toContain('@change="onWorkItemMessageAttachmentInput"');
    expect(workCenter).toContain("import ModernSelect from './ModernSelect.js'");
    expect(workCenter).toContain(':options="workCenterAgentOptions"');
    expect(workCenter).toContain('@update:model-value="selectWorkCenterAgent"');
    expect(workCenter).not.toContain('<label class="work-center-agent-picker">');
    expect(workCenter).not.toContain('<select :value="agentId"');
    expect(workCenter).toContain("this.store.enterWorkCenter(nextAgentId)");
    expect(workCenterCss).toMatch(/\.work-center-agent-picker \.modern-select-trigger\s*\{[^}]*background:\s*var\(--bg-input\)/s);
    const workCenterStore = {
      workCenterAgentId: 'agent-a',
      currentAgent: 'agent-a',
      agents: [
        { id: 'agent-a', name: 'server', online: true, capabilities: ['work_center'] },
        { id: 'agent-b', name: 'C1', online: true, capabilities: ['work_center'] },
        { id: 'agent-c', name: 'C2', online: true, capabilities: ['work_center'] },
        { id: 'agent-d', name: 'C3', online: true, capabilities: ['work_center'] },
        { id: 'agent-e', name: 'C4', online: true, capabilities: ['work_center'] },
        { id: 'agent-f', name: 'C5', online: true, capabilities: ['work_center'] },
      ],
      workCenterWatcherByAgent: {},
      workCenterListPageByAgent: {},
      workCenterListMoreLoadingByAgent: {},
      workCenterSettingsByAgent: {},
      workCenterRuntimeByAgent: {},
      workCenterItemsByAgent: { 'agent-a': [] },
      workCenterLoadingByAgent: {},
      workCenterLoadedByAgent: {},
      workCenterErrorByAgent: {},
      workCenterDetailByAgent: {},
      workCenterActionMessages: {},
      workCenterActionMessagesLoading: {},
      workCenterActionMessagesError: {},
      workCenterActionRequests: {},
      workCenterActionRequestDetails: {},
      workCenterActionRequestDetailsLoading: {},
      workCenterActionRequestDetailsError: {},
      workCenterActionRequestsLoading: {},
      workCenterActionRequestsError: {},
      workbenchMaximized: false,
      workbenchExpanded: false,
      workCenterCreateDraft: null,
      listWorkItems: vi.fn(() => Promise.resolve([])),
      loadWorkCenterSettings: vi.fn(() => Promise.resolve(null)),
      enterWorkCenter: vi.fn(),
      toggleSessionSidebar: vi.fn(),
    };
    globalThis.Pinia.useChatStore = () => workCenterStore;
    globalThis.Vue = Vue;
    const workCenterPage = mount(WorkCenterPage, {
      global: {
        mocks: { $t: key => key },
        stubs: {
          WorkCenterActionDetail: true,
          WorkCenterSettingsModal: true,
          LlmTab: true,
        },
      },
    });
    expect(workCenterPage.get('.work-center-agent-picker .modern-select-label').text()).toBe('server');
    await workCenterPage.get('.work-center-agent-picker .modern-select-trigger').trigger('click');
    await Vue.nextTick();
    const agentMenu = document.body.querySelector('.work-center-agent-menu');
    expect(agentMenu).not.toBeNull();
    expect([...agentMenu.querySelectorAll('.modern-select-option-label')].map(row => row.textContent.trim())).toEqual([
      'server', 'C1', 'C2', 'C3', 'C4', 'C5',
    ]);
    expect(workCenterCss).toMatch(/\.work-center-agent-menu \.modern-select-list\s*\{[^}]*max-height:\s*min\(164px, var\(--modern-select-list-max-height, 164px\)\);/s);
    const workCenterAgentListRule = workCenterCss.match(/\.work-center-agent-menu \.modern-select-list\s*\{([^}]*)\}/s)?.[1] || '';
    expect(workCenterAgentListRule).not.toMatch(/(^|[;\s])height\s*:/);
    expect(workCenterCss).toMatch(/\.work-center-agent-menu \.modern-select-option\s*\{[^}]*min-height:\s*32px;[^}]*box-sizing:\s*border-box;/s);
    agentMenu.querySelectorAll('.modern-select-option')[1].click();
    await Vue.nextTick();
    expect(workCenterStore.enterWorkCenter).toHaveBeenCalledWith('agent-b');
    workCenterPage.unmount();
    delete globalThis.Vue;
    delete globalThis.Pinia.useChatStore;
    expect(workCenter).toContain('workItemMessageAttachments.length > 0');
    expect(workCenter).toContain('work-center-detail-close');
    expect(workCenter).not.toContain('class="work-center-action-content-summary"');
    expect(workCenterCss).toContain('grid-template-columns: minmax(0, 1fr) minmax(400px, 1fr);');
    expect(workCenterCss).toMatch(/\.work-center-detail-close\s*\{[\s\S]*?position: absolute;[\s\S]*?right: 16px;/);
    expect(workCenterCss).toMatch(/\.work-center-action-description\s*\{[\s\S]*?white-space: nowrap;/);
    expect(workCenter).not.toContain('coordinatorRequestedSelectedActionInput');
    expect(workCenter).not.toContain("next?.routedTo === 'coordinator'");
    expect(workCenter).not.toContain("[...(this.selected.messages || [])].reverse().some");
    expect(workCenter).not.toContain("message.recovery?.actionId === this.selectedAction.id");
    expect(workCenter).toContain(":class=\"{ 'showing-detail': narrowPane !== 'items' }\"");
    expect(workCenterCss).toMatch(/\.work-center-shell\.showing-detail\s*\{[\s\S]*?padding-top: 10px;/);
    expect(workCenterCss).toMatch(/\.work-center-detail-heading\s*\{[\s\S]*?padding: 10px 56px 12px 24px;/);
    expect(workCenterCss).toMatch(/\.work-center-action-detail-header,[\s\S]*?\.work-center-action-detail-scroll\s*\{[\s\S]*?width: 100%;/);
    expect(workCenterCss).not.toContain('width: min(100%, 1120px);');
    expect(variables).toContain('--work-center-conversation-column-width: 1200px;');
    expect(variables).toContain('--work-center-conversation-gutter: clamp(20px, 3vw, 40px);');
    expect(workCenterCss).toMatch(/@media \(max-width: 768px\)\s*\{[\s\S]*?\.work-center-detail-layout\s*\{[\s\S]*?display: block;/);
    expect(workCenterCss).toMatch(/@media \(max-width: 768px\)\s*\{[\s\S]*?\.work-center-mobile-pane-tabs\s*\{[\s\S]*?display: grid;/);

    const turnBlock = readFileSync(resolve(import.meta.dirname, '../../web/components/VpTurnBlock.js'), 'utf8');
    const chatStore = readFileSync(resolve(import.meta.dirname, '../../web/stores/chat.js'), 'utf8');
    const bridge = readFileSync(resolve(import.meta.dirname, '../../agent/yeaft/web-bridge.js'), 'utf8');
    const en = readFileSync(resolve(import.meta.dirname, '../../web/i18n/en.js'), 'utf8');
    const zh = readFileSync(resolve(import.meta.dirname, '../../web/i18n/zh-CN.js'), 'utf8');
    expect(bridge).toContain("RUNNING_THREAD_STATES = new Set(['queued', 'typing', 'thinking', 'retrying', 'streaming', 'tool'])");
    expect(bridge).toContain("recoveryMode: event.recoveryMode || 'restart'");
    expect(chatStore).toContain("case 'llm_retry': {");
    expect(chatStore).toContain('retryAttempt: event.attempt || 0');
    expect(chatStore).toContain('const frameTurnKey = msg.turnId ? yeaftTurnStateKey(this, msg.agentId || null, msg.turnId)');
    expect(chatStore).toContain('retryRecoveryMode: _retryRecoveryMode');
    expect(chatStore).toContain("'thinking', 'retrying', 'streaming'");
    expect(turnBlock).toContain('turn.isStreaming && retryText');
    expect(turnBlock).toContain("'yeaft.vp.turnBlock.retryingContinue'");
    expect(en).toContain("'yeaft.vp.turnBlock.retryingRequest': 'Response stalled;");
    expect(zh).toContain("'yeaft.vp.turnBlock.retryingRequest': '响应停滞");

    storeFactories.clear();
    runtimeSessionsStore.sessionList = [
      { id: 'shared', agentId: 'agent-a' },
      { id: 'shared', agentId: 'agent-b' },
    ];
    const store = useChatStore();
    const productionSendWsMessage = store.sendWsMessage;
    store.sendWsMessage = vi.fn();
    store.agents = [
      { id: 'agent-a', name: 'Agent A', online: true },
      { id: 'agent-b', name: 'Agent B', online: true },
    ];
    store.currentAgent = 'agent-old';
    const requestA = store.selectAgent('agent-a');
    const requestB = store.selectAgent('agent-b');
    store.activateYeaftAgent('agent-b', store.agents[1]);
    expect(requestA).not.toBe(requestB);
    expect(handleAgentSelected(store, {
      type: 'agent_selected', requestId: requestA, agentId: 'agent-a', agentName: 'Agent A', conversations: [],
    })).toBe(false);
    expect(store.currentAgent).toBe('agent-b');
    expect(handleAgentSelected(store, {
      type: 'agent_selected', requestId: requestB, agentId: 'agent-b', agentName: 'Agent B', conversations: [],
    })).toBe(true);
    expect(store.currentAgent).toBe('agent-b');
    expect(store.pendingAgentSelection).toBeNull();

    const legacyRequest = store.selectAgent('agent-a');
    expect(legacyRequest).toBeTruthy();
    expect(handleAgentSelected(store, {
      type: 'agent_selected', agentId: 'agent-b', agentName: 'Agent B', conversations: [],
    })).toBe(false);
    expect(handleAgentSelected(store, {
      type: 'agent_selected', agentId: 'agent-a', agentName: 'Agent A', conversations: [],
    })).toBe(true);
    expect(store.currentAgent).toBe('agent-a');

    store.currentAgent = 'agent-a';
    store.sendWsMessage = vi.fn(() => false);
    expect(store.selectAgent('agent-b')).toBeNull();
    expect(store.pendingAgentSelection).toBeNull();
    expect(store.agentSwitching).toBe(false);
    store.pendingAgentSelection = { agentId: 'agent-b', requestId: 'failed-agent' };
    store.agentSwitching = true;
    expect(handleAgentSelected(store, {
      type: 'agent_selected', agentId: 'agent-b', requestId: 'failed-agent', ok: false,
    })).toBe(false);
    expect(store.pendingAgentSelection).toBeNull();
    expect(store.agentSwitching).toBe(false);

    vi.useFakeTimers();
    store.conversations = [{ id: 'chat-one' }];
    store.yeaftSessionInventoryCompleteSupported = true;
    store.sendWsMessage = vi.fn(() => true);
    const inventoryRequest = store.requestYeaftSessionInventory();
    expect(inventoryRequest).toMatch(/^session_inventory_/);
    expect(store.sendWsMessage).toHaveBeenLastCalledWith({
      type: 'get_agents', requestId: inventoryRequest, conversationIds: ['chat-one'],
    });
    expect(store.yeaftSessionHydrateError).toBeNull();
    vi.advanceTimersByTime(15_000);
    expect(store.yeaftSessionHydrateRequestId).toBeNull();
    expect(store.yeaftSessionHydrateSlices).toEqual([]);
    expect(store.yeaftSessionHydrateError).toBe('session_inventory_timeout');
    expect(store._yeaftSessionInventorySocketQuarantined).toBe(false);
    const staleTimeoutState = {
      yeaftSessionInventoryCompleteSupported: true,
      yeaftSessionHydrateRequestId: null,
      yeaftSessionHydrateSlices: [],
      _hasHandledYeaftSessionHydrate: false,
      yeaftSessionHydrateError: 'session_inventory_timeout',
    };
    handleMessage(staleTimeoutState, {
      type: 'yeaft_session_hydrate_complete', requestId: inventoryRequest, ok: true,
    });
    expect(staleTimeoutState.yeaftSessionHydrateError).toBe('session_inventory_timeout');
    vi.useRealTimers();

    const hydrateSessions = {
      live: [],
      applySnapshot: vi.fn(function applySnapshot(rows, agentId) {
        this.live.push({ agentId, rows });
      }),
      resetInventory: vi.fn(function resetInventory() { this.live = []; }),
      beginInventoryCommit: vi.fn(function beginInventoryCommit(sessionId, agentId) {
        this.live = [];
        this.preferred = { sessionId, agentId };
      }),
    };
    const hydrateStore = {
      _lastPongAt: 0,
      currentAgent: 'agent-b',
      yeaftActiveSessionFilter: 'same',
      resolveYeaftSessionAgentId: vi.fn(() => 'agent-b'),
      yeaftSessionInventoryCompleteSupported: true,
      yeaftSessionHydrateRequestId: 'inventory-2',
      yeaftSessionHydrateSlices: [],
      _hasHandledYeaftSessionHydrate: false,
      yeaftSessionHydrateError: null,
    };
    const previousSessionsStore = globalThis.Pinia.useSessionsStore;
    globalThis.Pinia.useSessionsStore = () => hydrateSessions;
    vi.useFakeTimers();
    try {
      handleMessage(hydrateStore, {
        type: 'yeaft_session_hydrate', requestId: 'inventory-1', agentId: 'agent-a', sessions: [{ id: 'stale' }],
      });
      handleMessage(hydrateStore, {
        type: 'yeaft_session_hydrate', requestId: 'inventory-2', agentId: 'agent-a', sessions: [{ id: 'one' }],
      });
      handleMessage(hydrateStore, {
        type: 'yeaft_session_hydrate', requestId: 'inventory-2', agentId: 'agent-b', sessions: [{ id: 'two' }],
      });
      expect(hydrateSessions.applySnapshot).not.toHaveBeenCalled();
      handleMessage(hydrateStore, {
        type: 'yeaft_session_hydrate_complete', requestId: 'inventory-1', ok: true,
      });
      expect(hydrateStore._hasHandledYeaftSessionHydrate).toBe(false);
      handleMessage(hydrateStore, {
        type: 'yeaft_session_hydrate_complete', requestId: 'inventory-2', ok: true,
      });
      expect(hydrateSessions.beginInventoryCommit).toHaveBeenCalledWith('same', 'agent-b');
      expect(hydrateSessions.live).toEqual([
        { agentId: 'agent-b', rows: [{ id: 'two' }] },
        { agentId: 'agent-a', rows: [{ id: 'one' }] },
      ]);
      expect(hydrateStore._hasHandledYeaftSessionHydrate).toBe(true);

      const legacySessions = useSessionsStore();
      legacySessions.resetInventory();
      legacySessions.applySnapshot([{ id: 'session-b', name: 'Session B' }], 'agent-b');
      legacySessions.setActive('session-b', 'agent-b');
      globalThis.Pinia.useSessionsStore = () => legacySessions;
      const previousChatStore = globalThis.Pinia.useChatStore;
      globalThis.Pinia.useChatStore = () => store;
      store.currentView = 'yeaft';
      store.currentAgent = 'agent-b';
      store.yeaftActiveSessionFilter = 'session-b';
      store.yeaftSessionAgentById = { 'session-b': 'agent-b' };
      store.yeaftSessionInventoryCompleteSupported = false;
      store.yeaftSessionHydrateRequestId = null;
      store.yeaftSessionHydrateSlices = [];
      store._hasHandledYeaftSessionHydrate = false;
      store.sendWsMessage.mockClear();
      const legacyRequest = store.requestYeaftSessionInventory();
      expect(store.requestYeaftSessionInventory()).toBe(legacyRequest);
      expect(store.sendWsMessage).toHaveBeenCalledTimes(1);
      const setFilterSpy = vi.spyOn(store, 'setActiveSessionFilter');
      try {
        // Old Servers broadcast agent_list before any Session slice. That frame
        // is not a completion boundary, even when the first slice is slow.
        handleMessage(store, { type: 'agent_list', agents: [] });
        vi.advanceTimersByTime(550);
        expect(store.yeaftSessionHydrateRequestId).toBe(legacyRequest);
        expect(store._hasHandledYeaftSessionHydrate).toBe(false);
        expect(legacySessions.activeSession).toMatchObject({ id: 'session-b', agentId: 'agent-b' });
        expect(store.yeaftActiveSessionFilter).toBe('session-b');
        expect(store.currentAgent).toBe('agent-b');
        expect(setFilterSpy).not.toHaveBeenCalled();

        handleMessage(store, {
          type: 'yeaft_session_hydrate', agentId: 'agent-a', sessions: [{ id: 'session-a', name: 'Session A' }],
        });
        expect(legacySessions.activeSessionId).toBe('session-b');
        vi.advanceTimersByTime(300);
        handleMessage(store, {
          type: 'yeaft_session_hydrate', agentId: 'agent-b', sessions: [{ id: 'session-b', name: 'Session B' }],
        });
        vi.advanceTimersByTime(499);
        expect(legacySessions.activeSessionId).toBe('session-b');
        expect(store.yeaftActiveSessionFilter).toBe('session-b');
        expect(store.currentAgent).toBe('agent-b');
        expect(setFilterSpy).not.toHaveBeenCalled();

        vi.advanceTimersByTime(1);
        expect(store.yeaftSessionHydrateRequestId).toBeNull();
        expect(store._hasHandledYeaftSessionHydrate).toBe(true);
        expect(store._yeaftSessionInventorySocketQuarantined).toBe(true);
        expect(legacySessions.sessionOrder.map((key) => {
          const row = legacySessions.sessions[key];
          return `${row.agentId}:${row.id}`;
        })).toEqual([
          'agent-b:session-b',
          'agent-a:session-a',
        ]);
        expect(legacySessions.activeSession).toMatchObject({ id: 'session-b', agentId: 'agent-b' });
        expect(store.yeaftActiveSessionFilter).toBe('session-b');
        expect(store.currentAgent).toBe('agent-b');
        expect(setFilterSpy).not.toHaveBeenCalled();

        // Model the next authenticated legacy socket for the zero-slice unit
        // path. The production reconnect boundary after quiet completion is
        // exercised with real socket callbacks below.
        store._yeaftSessionInventorySocketQuarantined = false;

        // A zero-slice legacy response is indistinguishable from a delayed first
        // slice. Preserve the live cache until the bounded request timeout rather
        // than manufacturing an empty authoritative inventory after 500ms.
        store.sendWsMessage.mockClear();
        const emptyLegacyRequest = store.requestYeaftSessionInventory();
        expect(store.requestYeaftSessionInventory()).toBe(emptyLegacyRequest);
        expect(store.sendWsMessage).toHaveBeenCalledTimes(1);
        handleMessage(store, { type: 'agent_list', agents: [] });
        // The completed request's still-pending 15s timeout must not retire this
        // newer owner. Only the timeout created for emptyLegacyRequest may do so.
        vi.advanceTimersByTime(13_650);
        expect(store.yeaftSessionHydrateRequestId).toBe(emptyLegacyRequest);
        vi.advanceTimersByTime(1_350);
        expect(store.yeaftSessionHydrateRequestId).toBeNull();
        expect(store.yeaftSessionHydrateError).toBe('session_inventory_timeout');
        expect(store._yeaftSessionInventorySocketQuarantined).toBe(true);
        expect(legacySessions.activeSession).toMatchObject({ id: 'session-b', agentId: 'agent-b' });
        expect(store.yeaftActiveSessionFilter).toBe('session-b');
        expect(store.currentAgent).toBe('agent-b');

        handleMessage(store, {
          type: 'yeaft_session_hydrate', agentId: 'agent-a', sessions: [{ id: 'late', name: 'Late' }],
        });
        vi.advanceTimersByTime(500);
        expect(legacySessions.sessionById('late', 'agent-a')).toBeNull();
        expect(legacySessions.activeSession).toMatchObject({ id: 'session-b', agentId: 'agent-b' });

        // Drive the complete production attack sequence through real sockets:
        // request A quiet-commits, a normal refresh replaces its socket before
        // opening request B, then A's saved callback attempts a late slice.
        const previousWebSocket = globalThis.WebSocket;
        const previousStartHeartbeat = store.startHeartbeat;
        const previousStopHeartbeat = store.stopHeartbeat;
        const sockets = [];
        class InventorySocket {
          static CONNECTING = 0;
          static OPEN = 1;
          static CLOSED = 3;
          constructor(url) {
            this.url = url;
            this.readyState = InventorySocket.CONNECTING;
            this.sent = [];
            Vue.markRaw(this);
            sockets.push(this);
          }
          send(payload) { this.sent.push(JSON.parse(payload)); }
          close() { this.readyState = InventorySocket.CLOSED; }
        }
        try {
          globalThis.WebSocket = InventorySocket;
          store.sendWsMessage = productionSendWsMessage;
          store.startHeartbeat = vi.fn();
          store.stopHeartbeat = vi.fn();
          store.ws = null;
          store.sessionKey = null;
          store.reconnectAttempts = 0;
          store.reconnectTimer = null;

          store.connect();
          const socketA = sockets[0];
          socketA.readyState = InventorySocket.OPEN;
          socketA.onopen();
          socketA.onmessage({ data: JSON.stringify({
            type: 'auth_result', success: true, yeaftSessionInventoryComplete: false,
          }) });
          const requestA = store.yeaftSessionHydrateRequestId;
          expect(requestA).toMatch(/^session_inventory_/);
          const staleSocketMessage = socketA.onmessage;
          socketA.onmessage({ data: JSON.stringify({
            type: 'yeaft_session_hydrate',
            agentId: 'agent-b',
            sessions: [{ id: 'session-b', name: 'Session B from A' }],
          }) });
          vi.advanceTimersByTime(500);

          expect(store.yeaftSessionHydrateRequestId).toBeNull();
          expect(store._yeaftSessionInventorySocketQuarantined).toBe(true);
          expect(store.ws).toBe(socketA);
          expect(socketA.readyState).toBe(InventorySocket.OPEN);
          expect(socketA.onmessage).toBe(staleSocketMessage);
          expect(sockets).toHaveLength(1);

          expect(store.requestYeaftSessionInventory()).toBeNull();
          expect(sockets).toHaveLength(2);
          expect(socketA.readyState).toBe(InventorySocket.CLOSED);
          expect(socketA.onmessage).toBeNull();

          const socketB = sockets[1];
          socketB.readyState = InventorySocket.OPEN;
          socketB.onopen();
          socketB.onmessage({ data: JSON.stringify({
            type: 'auth_result', success: true, yeaftSessionInventoryComplete: false,
          }) });
          const requestB = store.yeaftSessionHydrateRequestId;
          expect(requestB).toMatch(/^session_inventory_/);
          expect(requestB).not.toBe(requestA);
          socketB.onmessage({ data: JSON.stringify({
            type: 'yeaft_session_hydrate',
            agentId: 'agent-b',
            sessions: [{ id: 'session-b', name: 'Session B from B' }],
          }) });

          staleSocketMessage({ data: JSON.stringify({
            type: 'yeaft_session_hydrate',
            agentId: 'agent-a',
            sessions: [{ id: 'stale-a', name: 'Stale A' }],
          }) });
          vi.advanceTimersByTime(500);

          expect(legacySessions.sessionById('stale-a', 'agent-a')).toBeNull();
          expect(legacySessions.sessionById('session-b', 'agent-b')).toMatchObject({ name: 'Session B from B' });
          expect(legacySessions.activeSession).toMatchObject({ id: 'session-b', agentId: 'agent-b' });
          expect(store.yeaftActiveSessionFilter).toBe('session-b');
          expect(store.currentAgent).toBe('agent-b');
          expect(store.yeaftSessionHydrateRequestId).toBeNull();
          expect(store._yeaftSessionInventorySocketQuarantined).toBe(true);
        } finally {
          store.ws = null;
          store.yeaftSessionHydrateRequestId = null;
          store.yeaftSessionHydrateSlices = [];
          store._yeaftSessionInventorySocketQuarantined = false;
          store.sendWsMessage = vi.fn(() => true);
          store.startHeartbeat = previousStartHeartbeat;
          store.stopHeartbeat = previousStopHeartbeat;
          globalThis.WebSocket = previousWebSocket;
        }
      } finally {
        setFilterSpy.mockRestore();
        if (previousChatStore) globalThis.Pinia.useChatStore = previousChatStore;
        else delete globalThis.Pinia.useChatStore;
      }
    } finally {
      vi.useRealTimers();
      globalThis.Pinia.useSessionsStore = previousSessionsStore;
    }

    store.sessionCatalog = [
      {
        catalogKey: 'yeaft:agent-a:shared',
        runtimeProvider: 'yeaft',
        routeRef: { runtimeProvider: 'yeaft', agentId: 'agent-a', sessionId: 'shared' },
        title: 'Agent A',
        availability: 'online',
      },
      {
        catalogKey: 'yeaft:agent-b:shared',
        runtimeProvider: 'yeaft',
        routeRef: { runtimeProvider: 'yeaft', agentId: 'agent-b', sessionId: 'shared' },
        title: 'Agent B',
        availability: 'online',
      },
    ];
    store.yeaftActiveSessionFilter = 'shared';
    store.currentAgent = 'agent-a';
    store.currentView = 'yeaft';
    expect(store.activeSessionRoute).toEqual({
      runtimeProvider: 'yeaft',
      agentId: 'agent-a',
      sessionId: 'shared',
    });
    store.currentView = 'chat';
    store.conversations = [{ id: 'created-chat', agentId: 'agent-b', provider: 'copilot', type: 'chat' }];
    store.activeConversations = ['created-chat'];
    expect(store.activeSessionRoute).toEqual({
      runtimeProvider: 'copilot',
      agentId: 'agent-b',
      sessionId: 'created-chat',
    });
    store.conversations = [];
    store.activeConversations = [];
    store.panels = [];
    store.sendWsMessage = vi.fn(() => true);
    store.addMessage = vi.fn();
    store.saveOpenSessions = vi.fn();
    store.formatDbMessageForHistoryHydration = vi.fn(row => row);
    handleConversationCreated(store, {
      conversationId: 'created-copilot',
      agentId: 'agent-a',
      workDir: '/repo',
      provider: 'copilot',
    });
    expect(store.activeSessionRoute?.runtimeProvider).toBe('copilot');
    handleConversationResumed(store, {
      conversationId: 'resumed-claude',
      claudeSessionId: 'runtime-1',
      agentId: 'agent-a',
      workDir: '/repo',
      provider: 'claude-code',
      dbMessages: [],
    });
    expect(store.activeSessionRoute).toEqual({
      runtimeProvider: 'claude-code',
      agentId: 'agent-a',
      sessionId: 'resumed-claude',
    });

    store.currentView = 'yeaft';
    store.activeVpTurns = {};
    store.stoppingVpTurnIds = {};
    store.vpStatuses = {};
    store.yeaftProcessingSessions = {};
    store.yeaftConversationId = 'conv-a';
    store.messagesMap = { 'conv-a': [] };

    store.agents = [
      { id: 'stale-agent', online: false, capabilities: ['work_center'] },
      { id: 'agent-b', online: true, capabilities: ['work_center'] },
    ];
    store.workCenterAgentId = 'stale-agent';
    store.workCenterOpen = true;
    store.selectAgent = vi.fn();
    store.listWorkItems = vi.fn(() => Promise.resolve([]));
    expect(store.enterWorkCenter('stale-agent')).toBe(true);
    expect(store.workCenterAgentId).toBe('agent-b');
    store.agents = [];
    expect(store.enterWorkCenter('stale-agent')).toBe(false);
    expect(store.workCenterOpen).toBe(false);
    expect(store.workCenterAgentId).toBe(null);

    const wrapper = mount(UnifiedSessionList, {
      attachTo: document.body,
      props: {
        sessions: store.sessionCatalog,
        agents: [
          { id: 'agent-a', online: true },
          { id: 'agent-b', online: true },
        ],
        isYeaftSessionProcessing: store.isYeaftSessionProcessing,
      },
      global: { mocks: { $t: key => key } },
    });

    store.handleYeaftOutput({
      agentId: 'agent-a',
      conversationId: 'conv-a',
      event: { type: 'vp_turn_start', sessionId: 'shared', vpId: 'omni', turnId: 'turn-a' },
    });
    await Vue.nextTick();
    expect(store.yeaftProcessingSessions).toEqual({
      [yeaftSessionIdentityKey('agent-a', 'shared')]: true,
    });
    expect(wrapper.findAll('.processing-dot')).toHaveLength(1);
    expect(wrapper.findAll('.session-item')[0].classes()).toContain('processing');
    expect(wrapper.findAll('.session-item')[1].classes()).not.toContain('processing');

    store.handleYeaftOutput({
      agentId: 'agent-b',
      conversationId: 'conv-b',
      event: { type: 'vp_turn_start', sessionId: 'shared', vpId: 'omni', turnId: 'turn-a' },
    });
    expect(Object.values(store.activeVpTurns).filter(row => row.turnId === 'turn-a')).toHaveLength(2);
    store.handleYeaftOutput({
      agentId: 'agent-a',
      conversationId: 'conv-a',
      event: { type: 'vp_turn_end', sessionId: 'shared', vpId: 'omni', turnId: 'turn-a', reason: 'end_turn' },
    });
    await Vue.nextTick();
    expect(store.isYeaftSessionProcessing('shared', 'agent-a')).toBe(false);
    expect(store.isYeaftSessionProcessing('shared', 'agent-b')).toBe(true);
    expect(wrapper.findAll('.processing-dot')).toHaveLength(1);
    expect(wrapper.findAll('.session-item')[0].classes()).not.toContain('processing');
    expect(wrapper.findAll('.session-item')[1].classes()).toContain('processing');

    store.activeVpTurns = {};
    store.yeaftProcessingSessions = {};
    store.vpStatuses = {};
    store.handleYeaftOutput({
      agentId: 'agent-a',
      event: {
        type: 'vp_status_snapshot',
        statuses: [{ sessionId: 'shared', vpId: 'omni', state: 'streaming', turnId: 'snapshot-a' }],
      },
    });
    store.handleYeaftOutput({
      agentId: 'agent-b',
      event: {
        type: 'vp_status_snapshot',
        statuses: [{ sessionId: 'shared', vpId: 'omni', state: 'streaming', turnId: 'snapshot-b' }],
      },
    });
    expect(store.isYeaftSessionProcessing('shared', 'agent-a')).toBe(true);
    expect(store.isYeaftSessionProcessing('shared', 'agent-b')).toBe(true);

    store.handleYeaftOutput({
      agentId: 'agent-a',
      event: {
        type: 'vp_status_snapshot',
        sessionId: 'shared',
        statuses: [{ sessionId: 'shared', vpId: 'omni', state: 'idle' }],
      },
    });
    await Vue.nextTick();
    expect(store.isYeaftSessionProcessing('shared', 'agent-a')).toBe(false);
    expect(store.isYeaftSessionProcessing('shared', 'agent-b')).toBe(true);
    expect(wrapper.findAll('.processing-dot')).toHaveLength(1);
    expect(wrapper.findAll('.session-item')[1].classes()).toContain('processing');

    store.handleYeaftOutput({
      agentId: 'agent-b',
      event: { type: 'yeaft_aborted', sessionId: 'shared' },
    });
    await Vue.nextTick();
    expect(store.isYeaftSessionProcessing('shared', 'agent-b')).toBe(false);
    expect(wrapper.findAll('.processing-dot')).toHaveLength(0);

    store.yeaftProcessingSessions = { shared: true };
    expect(store.isYeaftSessionProcessing('shared', 'agent-a')).toBe(false);
    expect(store.isYeaftSessionProcessing('shared', 'agent-b')).toBe(false);
    store.handleYeaftOutput({
      agentId: 'agent-a',
      event: { type: 'vp_status_snapshot', sessionId: 'shared', statuses: [] },
    });
    expect(store.yeaftProcessingSessions).toEqual({ shared: true });

    store.sessionCatalog = [store.sessionCatalog[0]];
    runtimeSessionsStore.sessionList = [{ id: 'shared', agentId: 'agent-a' }];
    expect(store.isYeaftSessionProcessing('shared', 'agent-a')).toBe(true);
    store.handleYeaftOutput({
      agentId: 'agent-a',
      event: { type: 'vp_status_snapshot', sessionId: 'shared', statuses: [] },
    });
    expect(store.yeaftProcessingSessions).toEqual({});
    expect(store.isYeaftSessionProcessing('shared', 'agent-a')).toBe(false);

    store.yeaftProcessingSessions = { shared: true };
    store.handleYeaftOutput({
      agentId: 'agent-a',
      event: { type: 'vp_status_snapshot', statuses: [] },
    });
    expect(store.yeaftProcessingSessions).toEqual({});

    store.sessionCatalog = [
      {
        catalogKey: 'yeaft:agent-a:shared',
        runtimeProvider: 'yeaft',
        routeRef: { runtimeProvider: 'yeaft', agentId: 'agent-a', sessionId: 'shared' },
        title: 'Agent A',
        availability: 'online',
      },
      {
        catalogKey: 'yeaft:agent-b:shared',
        runtimeProvider: 'yeaft',
        routeRef: { runtimeProvider: 'yeaft', agentId: 'agent-b', sessionId: 'shared' },
        title: 'Agent B',
        availability: 'online',
      },
    ];
    runtimeSessionsStore.sessionList = [
      { id: 'shared', agentId: 'agent-a' },
      { id: 'shared', agentId: 'agent-b' },
    ];
    store.yeaftProcessingSessions = { shared: true };
    store.handleYeaftOutput({
      agentId: 'agent-a',
      event: { type: 'vp_status_snapshot', statuses: [] },
    });
    expect(store.yeaftProcessingSessions).toEqual({ shared: true });

    store.yeaftProcessingSessions = {};
    store.vpStatuses = {};
    store.yeaftActiveSessionFilter = null;
    store.currentAgent = 'agent-a';
    runtimeSessionsStore.activeSessionId = null;
    runtimeSessionsStore.activeAgentId = null;
    store.handleYeaftOutput({
      agentId: 'agent-b',
      event: {
        type: 'vp_status_snapshot',
        statuses: [{ sessionId: 'shared', vpId: 'omni', state: 'streaming', turnId: 'restore-b' }],
      },
    });
    expect(store.yeaftActiveSessionFilter).toBe('shared');
    expect(store.currentAgent).toBe('agent-b');
    expect(runtimeSessionsStore.activeSessionId).toBe('shared');
    expect(runtimeSessionsStore.activeAgentId).toBe('agent-b');

    store.yeaftActiveSessionFilter = null;
    store.currentAgent = 'agent-a';
    runtimeSessionsStore.activeSessionId = null;
    runtimeSessionsStore.activeAgentId = null;
    store.handleYeaftOutput({
      event: {
        type: 'vp_status_snapshot',
        statuses: [{ sessionId: 'shared', vpId: 'omni', state: 'streaming', turnId: 'ambiguous' }],
      },
    });
    expect(store.yeaftActiveSessionFilter).toBeNull();
    expect(store.currentAgent).toBe('agent-a');
    expect(runtimeSessionsStore.activeSessionId).toBeNull();
    expect(runtimeSessionsStore.activeAgentId).toBeNull();

    // Session creation stays on the existing modal, with Agent before Provider
    // and VP selection exposed only for the Yeaft provider.
    const originalPinia = globalThis.Pinia;
    const originalWindowPinia = window.Pinia;
    const chat = Vue.reactive({
      agents: [{ id: 'agent-a', name: 'Agent A', online: true, workDir: '/repo' }],
      currentAgent: 'agent-a',
      folders: [],
      historySessions: [],
      sendWsMessage: vi.fn(),
      listFoldersForAgent: vi.fn(() => Promise.resolve()),
      listHistorySessionsForAgent: vi.fn(),
      selectAgent: vi.fn(),
      createConversation: vi.fn(),
    });
    const modalPinia = {
      ...originalPinia,
      useChatStore: () => chat,
      useVpStore: () => ({
        vpList: [{ vpId: 'omni' }],
        vpOrder: ['omni'],
        lastSnapshotAt: 1,
        lastVpSnapshotAgentId: 'agent-a',
        snapshotStatus: 'ready',
        snapshotAgentId: 'agent-a',
        vpLabel: id => id,
      }),
      useSessionsStore: () => runtimeSessionsStore,
    };
    globalThis.Pinia = modalPinia;
    window.Pinia = modalPinia;
    const modal = mount(SessionCreateModal, {
      attachTo: document.body,
      props: { initialProvider: 'copilot' },
      global: { mocks: { $t: key => key }, stubs: { Teleport: true, VpAvatar: true } },
    });
    await Vue.nextTick();
    const selects = modal.findAll('select.resume-input');
    expect(selects[0].element.value).toBe('agent-a');
    expect(selects[1].element.value).toBe('copilot');
    expect(modal.get('.yeaft-session-create-heading h2').text()).toBe('yeaft.session.create.title');
    expect(modal.get('.yeaft-session-create-heading p').text()).toBe('yeaft.session.create.subtitle');
    const createFields = modal.get('.yeaft-session-create-fields');
    expect(createFields.findAll(':scope > .resume-control-row')).toHaveLength(4);
    expect(createFields.findAll(':scope > .resume-control-row > .resume-control-label').map(label => label.text())).toEqual([
      'yeaft.session.create.agentLabel',
      'modal.newConv.provider',
      'yeaft.session.create.nameLabel',
      'yeaft.session.create.workDirLabel',
    ]);
    expect(modal.get('.yeaft-create-submit').classes()).toContain('btn-primary');
    expect(modal.find('.resume-control-row-vp').exists()).toBe(false);
    await selects[1].setValue('yeaft');
    const vpRow = modal.get('.resume-control-row-vp');
    expect(vpRow.element.parentElement).toBe(modal.get('.yeaft-session-create-fields').element);
    expect(modal.findAll('.yeaft-session-create-fields > .resume-control-row')).toHaveLength(5);
    expect(modal.findAll('.yeaft-session-create-fields > .resume-control-row > .resume-control-label').map(label => label.text())).toEqual([
      'yeaft.session.create.agentLabel',
      'modal.newConv.provider',
      'yeaft.session.create.nameLabel',
      'yeaft.session.create.workDirLabel',
      'yeaft.session.create.vpPicker',
    ]);
    const sessionCreateCss = readFileSync(resolve(import.meta.dirname, '../../web/styles/yeaft-session-create.css'), 'utf8');
    expect(sessionCreateCss).toMatch(/\.yeaft-session-create-fields\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\);/s);
    expect(sessionCreateCss).toMatch(/\.yeaft-session-create-fields \.resume-control-row\s*\{[^}]*flex-direction:\s*column;/s);
    await selects[1].setValue('claude-code');
    modal.vm.form.workDir = '/repo';
    await modal.vm.onSubmit();
    expect(chat.createConversation).toHaveBeenCalledWith('/repo', 'agent-a', null, { provider: 'claude-code' });
    modal.unmount();

    const coldVpStore = Vue.reactive({
      vpList: [],
      vpOrder: [],
      emptyLibrary: false,
      lastSnapshotAt: 0,
      lastVpSnapshotAgentId: null,
      snapshotStatus: 'idle',
      snapshotAgentId: null,
      snapshotRequestId: null,
      snapshotError: '',
      beginSnapshot(agentId, requestId) {
        this.snapshotStatus = 'loading';
        this.snapshotAgentId = agentId;
        this.snapshotRequestId = requestId;
      },
      failSnapshot(agentId, requestId, error) {
        if (requestId !== this.snapshotRequestId) return false;
        this.snapshotStatus = 'error';
        this.snapshotAgentId = agentId;
        this.snapshotError = error;
        return true;
      },
    });
    chat.sendWsMessage.mockReturnValue(true);
    const coldModalPinia = { ...modalPinia, useVpStore: () => coldVpStore };
    globalThis.Pinia = coldModalPinia;
    window.Pinia = coldModalPinia;
    const coldModal = mount(SessionCreateModal, {
      attachTo: document.body,
      global: { mocks: { $t: key => key }, stubs: { Teleport: true, VpAvatar: true } },
    });
    await Vue.nextTick();
    expect(chat.sendWsMessage).toHaveBeenLastCalledWith(expect.objectContaining({
      type: 'yeaft_vp_subscribe',
      agentId: 'agent-a',
      requestId: expect.stringMatching(/^vp_snapshot_/),
    }));
    expect(coldVpStore.snapshotStatus).toBe('loading');
    coldVpStore.failSnapshot('agent-a', coldVpStore.snapshotRequestId, 'offline');
    await Vue.nextTick();
    expect(coldModal.find('.yeaft-roster-error').exists()).toBe(true);
    expect(coldModal.find('.yeaft-roster-error').text()).toContain('yeaft.session.create.rosterError');
    await coldModal.get('.yeaft-roster-retry').trigger('click');
    expect(chat.sendWsMessage).toHaveBeenLastCalledWith(expect.objectContaining({
      type: 'yeaft_vp_subscribe',
      agentId: 'agent-a',
      requestId: expect.stringMatching(/^vp_snapshot_/),
    }));
    coldModal.unmount();

    // The create roster is scoped to the selected Agent. A pending B request
    // must hide A rows and disable creation; switching back to A establishes a
    // fresh request scope, so a delayed B response cannot overwrite A again.
    storeFactories.delete('vp');
    const scopedVpStore = useVpStore();
    scopedVpStore.beginSnapshot('agent-a', 'req-a-1');
    expect(scopedVpStore.applySnapshot({
      vps: [{ vpId: 'a-only', displayName: 'A only' }],
      emptyLibrary: false,
    }, 'agent-a', 'req-a-1')).toBe(true);
    chat.agents = [
      { id: 'agent-a', name: 'Agent A', online: true, workDir: '/repo-a' },
      { id: 'agent-b', name: 'Agent B', online: true, workDir: '/repo-b' },
    ];
    chat.currentAgent = 'agent-a';
    chat.sendWsMessage.mockClear();
    const scopedModalPinia = { ...modalPinia, useVpStore: () => scopedVpStore };
    globalThis.Pinia = scopedModalPinia;
    window.Pinia = scopedModalPinia;
    const scopedModal = mount(SessionCreateModal, {
      attachTo: document.body,
      global: { mocks: { $t: key => key }, stubs: { Teleport: true, VpAvatar: true } },
    });
    await Vue.nextTick();
    expect(scopedModal.vm.vpList.map(vp => vp.vpId)).toEqual(['a-only']);
    expect(scopedModal.vm.form.vpIds).toEqual(['a-only']);

    const agentSelect = scopedModal.findAll('select.resume-input')[0];
    await agentSelect.setValue('agent-b');
    await Vue.nextTick();
    const vpRequestB = scopedVpStore.snapshotRequestId;
    expect(scopedVpStore.snapshotAgentId).toBe('agent-b');
    expect(scopedVpStore.snapshotStatus).toBe('loading');
    expect(scopedVpStore.vpList).toEqual([]);
    expect(scopedModal.vm.vpList).toEqual([]);
    expect(scopedModal.vm.form.vpIds).toEqual([]);
    expect(scopedModal.get('.yeaft-create-submit').attributes('disabled')).toBeDefined();
    expect(scopedModal.find('.yeaft-roster-empty').text()).toContain('yeaft.session.create.rosterLoading');

    await agentSelect.setValue('agent-a');
    await Vue.nextTick();
    const vpRequestA2 = scopedVpStore.snapshotRequestId;
    expect(vpRequestA2).not.toBe(vpRequestB);
    expect(scopedVpStore.snapshotAgentId).toBe('agent-a');
    expect(scopedVpStore.applySnapshot({
      vps: [{ vpId: 'a-only', displayName: 'A only' }],
      emptyLibrary: false,
    }, 'agent-a', vpRequestA2)).toBe(true);
    await Vue.nextTick();
    expect(scopedModal.vm.vpList.map(vp => vp.vpId)).toEqual(['a-only']);
    expect(scopedModal.vm.form.vpIds).toEqual(['a-only']);
    expect(scopedModal.get('.yeaft-create-submit').attributes('disabled')).toBeUndefined();
    expect(scopedVpStore.applySnapshot({
      vps: [{ vpId: 'b-only', displayName: 'B only' }],
      emptyLibrary: false,
    }, 'agent-b', vpRequestB)).toBe(false);
    expect(scopedModal.vm.vpList.map(vp => vp.vpId)).toEqual(['a-only']);

    // Old Agents do not echo requestId. The server still stamps agentId, so a
    // response for the active Agent remains compatible without weakening the
    // cross-Agent fence above.
    scopedVpStore.beginSnapshot('agent-b', 'req-b-legacy');
    expect(scopedVpStore.applySnapshot({
      vps: [{ vpId: 'b-only', displayName: 'B only' }],
      emptyLibrary: false,
    }, 'agent-b')).toBe(true);
    expect(scopedVpStore.vpList.map(vp => vp.vpId)).toEqual(['b-only']);
    scopedModal.unmount();

    globalThis.Pinia = originalPinia;
    window.Pinia = originalWindowPinia;

    wrapper.unmount();
  });

  it('keeps background Yeaft output routed while promoting the visible local conversation', () => {
    storeFactories.clear();
    runtimeSessionsStore.sessionList = [
      { id: 'visible-session', agentId: 'agent-a' },
      { id: 'background-session', agentId: 'agent-a' },
    ];
    runtimeSessionsStore.activeSessionId = 'visible-session';
    runtimeSessionsStore.activeAgentId = 'agent-a';

    const store = useChatStore();
    store.sendWsMessage = vi.fn(() => true);
    const localConversationId = 'yeaft-local-agent-a-cold';
    const bridgeConversationId = 'yeaft-agent-a-cold';
    const optimisticId = 'u_local_pending';
    store.currentView = 'yeaft';
    store.currentAgent = 'agent-a';
    store.yeaftActiveSessionFilter = 'visible-session';
    store.yeaftSessionAgentById = {
      'visible-session': 'agent-a',
      'background-session': 'agent-a',
    };
    store.yeaftConversationId = localConversationId;
    store.yeaftConversationIdsByAgent = { 'agent-a': localConversationId };
    store.activeConversations = [localConversationId];
    store.messagesMap = {
      [localConversationId]: [{
        id: optimisticId,
        messageId: optimisticId,
        clientMessageId: optimisticId,
        type: 'user',
        content: 'pending send',
        sessionId: 'visible-session',
        turnId: optimisticId,
        timestamp: 1,
      }],
    };
    store.processingConversations = { [localConversationId]: true };
    store.executionStatusMap = {
      [localConversationId]: {
        currentTool: { name: 'Bash' },
        toolHistory: [],
        lastActivity: 1,
      },
    };

    // A background Session can reveal the real bridge id first. This updates
    // the Agent transport cache but must leave the visible local source intact.
    store.handleYeaftOutput({
      agentId: 'agent-a',
      conversationId: bridgeConversationId,
      sessionId: 'background-session',
      data: {
        type: 'assistant',
        message: { id: 'background-row', content: 'background answer' },
      },
    });
    expect(store.yeaftConversationIdsByAgent['agent-a']).toBe(bridgeConversationId);
    expect(store.yeaftConversationId).toBe(localConversationId);

    const request = store.beginYeaftHistoryLoad({
      agentId: 'agent-a',
      sessionId: 'visible-session',
      mode: 'recent',
      preserveLoaded: false,
    });
    // Encrypted relay work is asynchronous per frame, so the small completion
    // can legally arrive before the compressed history chunk. Completion may
    // publish metadata, but it must retain the request fence until data lands.
    store.handleYeaftOutput({
      type: 'yeaft_output',
      agentId: 'agent-a',
      conversationId: bridgeConversationId,
      sessionId: 'visible-session',
      requestId: request.requestId,
      event: {
        type: 'history_loaded',
        agentId: 'agent-a',
        sessionId: 'visible-session',
        requestId: request.requestId,
        mode: 'recent',
        count: 1,
        oldestSeq: 1,
        latestSeq: 1,
        hasMore: false,
      },
    });
    expect(store.yeaftSessionHistoryState['agent-a\u001fvisible-session']).toEqual(expect.objectContaining({
      loading: true,
      requestId: request.requestId,
      completionSeen: true,
    }));
    store.handleMessage({
      type: 'yeaft_history_chunk',
      agentId: 'agent-a',
      conversationId: bridgeConversationId,
      sessionId: 'visible-session',
      requestId: request.requestId,
      mode: 'recent',
      messages: [{
        id: 'persisted-row',
        role: 'assistant',
        content: 'persisted answer',
        sessionId: 'visible-session',
        ts: 2,
      }],
      oldestSeq: 1,
      latestSeq: 1,
      hasMore: false,
    });

    expect(store.yeaftSessionHistoryState['agent-a\u001fvisible-session']).toEqual(expect.objectContaining({
      loaded: true,
      loading: false,
      requestId: null,
      count: 1,
    }));
    expect(store.yeaftSessionHistoryState['agent-a\u001fvisible-session']).not.toHaveProperty('completionSeen');
    expect(store.yeaftConversationId).toBe(bridgeConversationId);
    expect(store.activeConversations).toEqual([bridgeConversationId]);
    expect(store.messagesMap[bridgeConversationId]).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: optimisticId, content: 'pending send' }),
      expect.objectContaining({ id: 'persisted-row', content: 'persisted answer' }),
    ]));
    expect(store.messagesMap[localConversationId]).toBeUndefined();
    expect(store.processingConversations).toEqual({ [bridgeConversationId]: true });
    expect(store.executionStatusMap[bridgeConversationId].currentTool).toEqual({ name: 'Bash' });
    expect(store.executionStatusMap[localConversationId]).toBeUndefined();

    // The normal chunk-first order is equally safe: the chunk is the data commit,
    // while a stale completion from an older request cannot mutate a new generation.
    const chunkFirstRequest = store.beginYeaftHistoryLoad({
      agentId: 'agent-a',
      sessionId: 'visible-session',
      mode: 'delta',
      preserveLoaded: true,
      latestSeq: 1,
    });
    store.handleMessage({
      type: 'yeaft_history_chunk',
      agentId: 'agent-a',
      conversationId: bridgeConversationId,
      sessionId: 'visible-session',
      requestId: chunkFirstRequest.requestId,
      mode: 'delta',
      messages: [{
        id: 'persisted-row-2',
        role: 'assistant',
        content: 'delta answer',
        sessionId: 'visible-session',
        ts: 3,
      }],
      latestSeq: 2,
      hasMore: false,
    });
    expect(store.yeaftSessionHistoryState['agent-a\u001fvisible-session']).toEqual(expect.objectContaining({
      loading: false,
      requestId: null,
      latestSeq: 2,
    }));
    store.handleYeaftOutput({
      type: 'yeaft_output',
      agentId: 'agent-a',
      conversationId: bridgeConversationId,
      sessionId: 'visible-session',
      requestId: request.requestId,
      event: {
        type: 'history_loaded',
        agentId: 'agent-a',
        sessionId: 'visible-session',
        requestId: request.requestId,
        mode: 'recent',
        count: 1,
        latestSeq: 1,
      },
    });
    expect(store.yeaftSessionHistoryState['agent-a\u001fvisible-session']).toEqual(expect.objectContaining({
      loading: false,
      requestId: null,
      latestSeq: 2,
    }));
    // A completion that follows a committed chunk is intentionally ignored;
    // chunk metadata already advanced the cursor and count exactly once.
    store.handleYeaftOutput({
      type: 'yeaft_output',
      agentId: 'agent-a',
      conversationId: bridgeConversationId,
      sessionId: 'visible-session',
      requestId: chunkFirstRequest.requestId,
      event: {
        type: 'history_loaded',
        agentId: 'agent-a',
        sessionId: 'visible-session',
        requestId: chunkFirstRequest.requestId,
        mode: 'delta',
        count: 1,
        latestSeq: 2,
      },
    });
    expect(store.yeaftSessionHistoryState['agent-a\u001fvisible-session']).toEqual(expect.objectContaining({
      loading: false,
      requestId: null,
      latestSeq: 2,
    }));
    expect(store.messagesMap[bridgeConversationId]).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'persisted-row-2', content: 'delta answer' }),
    ]));

    // Empty history still has a real chunk frame. Completion-first must not
    // strand a first-ever empty Session in loading state or manufacture rows.
    const emptyRequest = store.beginYeaftHistoryLoad({
      agentId: 'agent-a',
      sessionId: 'empty-session',
      mode: 'recent',
      preserveLoaded: false,
    });
    store.handleYeaftOutput({
      type: 'yeaft_output',
      agentId: 'agent-a',
      conversationId: bridgeConversationId,
      sessionId: 'empty-session',
      requestId: emptyRequest.requestId,
      event: {
        type: 'history_loaded',
        sessionId: 'empty-session',
        requestId: emptyRequest.requestId,
        mode: 'recent',
        count: 0,
        oldestSeq: null,
        latestSeq: null,
        hasMore: false,
      },
    });
    expect(store.yeaftSessionHistoryState['agent-a\u001fempty-session']).toEqual(expect.objectContaining({
      loading: true,
      requestId: emptyRequest.requestId,
      completionSeen: true,
    }));
    store.handleMessage({
      type: 'yeaft_history_chunk',
      agentId: 'agent-a',
      conversationId: bridgeConversationId,
      sessionId: 'empty-session',
      requestId: emptyRequest.requestId,
      mode: 'recent',
      messages: [],
      oldestSeq: null,
      latestSeq: null,
      hasMore: false,
    });
    expect(store.yeaftSessionHistoryState['agent-a\u001fempty-session']).toEqual(expect.objectContaining({
      loaded: true,
      loading: false,
      requestId: null,
      count: 0,
      hasMore: false,
    }));
    expect(store.messagesMap[bridgeConversationId].filter(row => row.sessionId === 'empty-session')).toEqual([]);

    // Metadata arriving after the chunk is an idempotent refresh, not a second
    // migration that recreates the local key or loses processing state.
    store.handleYeaftOutput({
      agentId: 'agent-a',
      sessionId: 'visible-session',
      event: {
        type: 'session_ready',
        conversationId: bridgeConversationId,
        sessionId: 'visible-session',
        tasks: [],
      },
    });
    expect(store.yeaftConversationId).toBe(bridgeConversationId);
    expect(store.messagesMap[localConversationId]).toBeUndefined();
    expect(store.processingConversations).toEqual({ [bridgeConversationId]: true });
    expect(store.executionStatusMap[bridgeConversationId].currentTool).toEqual({ name: 'Bash' });

    // After an Agent restart, the browser can still own visible state under the
    // previous real bridge id while the new process emits history before
    // session_ready. The chunk must not overwrite the only migration source.
    const restartedConversationId = 'yeaft-agent-a-restarted';
    const restartPendingId = 'u_restart_pending';
    store.messagesMap[bridgeConversationId].push({
      id: restartPendingId,
      messageId: restartPendingId,
      clientMessageId: restartPendingId,
      type: 'user',
      content: 'pending across restart',
      sessionId: 'visible-session',
      turnId: restartPendingId,
      timestamp: 3,
    });
    store.processingConversations = { [bridgeConversationId]: true };
    store.executionStatusMap = {
      [bridgeConversationId]: {
        currentTool: { name: 'Grep' },
        toolHistory: [],
        lastActivity: 3,
      },
    };
    const restartWatchdog = setTimeout(() => {}, 60_000);
    store._processingWatchdogs = { [bridgeConversationId]: restartWatchdog };
    store._yeaftWatchdogConvs = new Set([bridgeConversationId]);
    const restartRequest = store.beginYeaftHistoryLoad({
      agentId: 'agent-a',
      sessionId: 'visible-session',
      mode: 'delta',
      preserveLoaded: true,
    });
    store.handleMessage({
      type: 'yeaft_history_chunk',
      agentId: 'agent-a',
      conversationId: restartedConversationId,
      sessionId: 'visible-session',
      requestId: restartRequest.requestId,
      mode: 'delta',
      messages: [{
        id: 'restart-persisted-row',
        role: 'assistant',
        content: 'persisted after restart',
        sessionId: 'visible-session',
        ts: 4,
      }],
      latestSeq: 2,
      hasMore: false,
    });
    expect(store.yeaftConversationId).toBe(bridgeConversationId);
    expect(store.yeaftConversationIdsByAgent['agent-a']).toBe(bridgeConversationId);
    expect(store.messagesMap[restartedConversationId]).toEqual([
      expect.objectContaining({ id: 'restart-persisted-row' }),
    ]);

    store.handleYeaftOutput({
      agentId: 'agent-a',
      sessionId: 'visible-session',
      event: {
        type: 'session_ready',
        conversationId: restartedConversationId,
        sessionId: 'visible-session',
        tasks: [],
      },
    });
    expect(store.yeaftConversationId).toBe(restartedConversationId);
    expect(store.yeaftConversationIdsByAgent['agent-a']).toBe(restartedConversationId);
    expect(store.messagesMap[restartedConversationId]).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: restartPendingId, content: 'pending across restart' }),
      expect.objectContaining({ id: 'restart-persisted-row', content: 'persisted after restart' }),
    ]));
    expect(store.processingConversations).toEqual({ [restartedConversationId]: true });
    expect(store.executionStatusMap[restartedConversationId].currentTool).toEqual({ name: 'Grep' });
    expect(store.executionStatusMap[bridgeConversationId]).toBeUndefined();
    expect(store._processingWatchdogs[bridgeConversationId]).toBeUndefined();
    expect(store._yeaftWatchdogConvs.has(bridgeConversationId)).toBe(false);
    expect(store._processingWatchdogs[restartedConversationId]).toBeTruthy();
    expect(store._yeaftWatchdogConvs.has(restartedConversationId)).toBe(true);

    // A delayed bootstrap can transiently report an empty recent window while
    // this Session already has visible cached history. Treat the reply as a
    // completed refresh, but never let it erase the pane the user is reading.
    const rowsBeforeEmptyRefresh = store.messagesMap[restartedConversationId]
      .filter(row => row.sessionId === 'visible-session')
      .map(row => ({ id: row.id, content: row.content }));
    const stateBeforeEmptyRefresh = store.yeaftSessionHistoryState['agent-a\u001fvisible-session'];
    const emptyRefreshRequest = store.beginYeaftHistoryLoad({
      agentId: 'agent-a',
      sessionId: 'visible-session',
      mode: 'recent',
      preserveLoaded: false,
    });
    expect(store.yeaftSessionHistoryState['agent-a\u001fvisible-session']).toEqual(expect.objectContaining({
      loaded: true,
      loading: true,
      hasMore: stateBeforeEmptyRefresh.hasMore,
      oldestSeq: stateBeforeEmptyRefresh.oldestSeq,
      latestSeq: stateBeforeEmptyRefresh.latestSeq,
      count: stateBeforeEmptyRefresh.count,
      syncingAfterSeq: null,
    }));
    store.handleMessage({
      type: 'yeaft_history_chunk',
      agentId: 'agent-a',
      conversationId: restartedConversationId,
      sessionId: 'visible-session',
      requestId: emptyRefreshRequest.requestId,
      mode: 'recent',
      messages: [],
      oldestSeq: null,
      latestSeq: null,
      hasMore: false,
    });
    expect(store.messagesMap[restartedConversationId]
      .filter(row => row.sessionId === 'visible-session')
      .map(row => ({ id: row.id, content: row.content }))).toEqual(rowsBeforeEmptyRefresh);
    expect(store.yeaftSessionHistoryState['agent-a\u001fvisible-session']).toEqual(expect.objectContaining({
      loaded: true,
      loading: false,
      requestId: null,
      hasMore: stateBeforeEmptyRefresh.hasMore,
      oldestSeq: stateBeforeEmptyRefresh.oldestSeq,
      latestSeq: stateBeforeEmptyRefresh.latestSeq,
      count: stateBeforeEmptyRefresh.count,
    }));

    const emptySessionRequest = store.beginYeaftHistoryLoad({
      agentId: 'agent-a',
      sessionId: 'never-had-messages',
      mode: 'recent',
      preserveLoaded: false,
    });
    store.handleMessage({
      type: 'yeaft_history_chunk',
      agentId: 'agent-a',
      conversationId: restartedConversationId,
      sessionId: 'never-had-messages',
      requestId: emptySessionRequest.requestId,
      mode: 'recent',
      messages: [],
      oldestSeq: null,
      latestSeq: null,
      hasMore: false,
    });
    expect(store.messagesMap[restartedConversationId]
      .filter(row => row.sessionId === 'never-had-messages')).toEqual([]);
    expect(store.yeaftSessionHistoryState['agent-a\u001fnever-had-messages']).toEqual(expect.objectContaining({
      loaded: true,
      loading: false,
      count: 0,
      hasMore: false,
      requestId: null,
    }));

    clearTimeout(store._processingWatchdogs[restartedConversationId]);
    storeFactories.clear();

    const routedStore = makeStore();
    routedStore.yeaftConversationIdsByAgent = {
      'agent-1': 'conv-1',
      'agent-2': 'conv-2',
    };
    routedStore.messagesMap['conv-2'] = [];
    routedStore._currentYeaftSessionId = 'session-2';
    routedStore._currentYeaftVpId = 'vp-2';
    routedStore._currentYeaftTurnId = 'turn-2';

    addMessageToConversation(routedStore, 'conv-2', {
      id: 'msg-2',
      type: 'assistant',
      content: 'background',
    });

    expect(routedStore.yeaftConversationId).toBe('conv-1');
    expect(routedStore.messagesMap['conv-2'][0]).toMatchObject({
      sessionId: 'session-2',
      vpId: 'vp-2',
      turnId: 'turn-2',
      speakerVpId: 'vp-2',
    });
  });

  it('counts hyphenated tool-use/tool-result events as part of Yeaft assistant turns', () => {
    const messages = [
      { type: 'user', content: 'u1' },
      { type: 'tool-use', toolName: 'Bash', turnId: 'a', speakerVpId: 'vp-1' },
      { type: 'tool-result', toolUseId: 't1', turnId: 'a', speakerVpId: 'vp-1' },
      { type: 'assistant', content: 'a1', turnId: 'a', speakerVpId: 'vp-1' },
      { type: 'user', content: 'u2' },
      { type: 'assistant', content: 'a2', turnId: 'b', speakerVpId: 'vp-1' },
    ];

    expect(buildYeaftMessageTurnSpans(messages).map(s => s.kind)).toEqual([
      'user',
      'user',
    ]);
    expect(hasHiddenYeaftMessageTurns(messages, 1)).toBe(true);
    expect(sliceYeaftMessagesByRecentTurns(messages, 1)).toEqual(messages.slice(4));
  });
});
