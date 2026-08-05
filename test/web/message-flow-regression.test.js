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
import PluginCenterPage from '../../web/components/PluginCenterPage.js';
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
const { default: SessionCreateModal } = await import('../../web/components/SessionCreateModal.js');
const { default: ChatPage } = await import('../../web/components/ChatPage.js');
const { default: YeaftSidebar } = await import('../../web/components/YeaftSidebar.js');
const {
  handleConversationCreated,
  handleConversationResumed,
  handleSyncMessagesResult,
} = await import('../../web/stores/helpers/handlers/conversationHandler.js');

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
    const sidebarCss = readFileSync(resolve(import.meta.dirname, '../../web/styles/sidebar.css'), 'utf8');
    const variables = readFileSync(resolve(import.meta.dirname, '../../web/styles/variables.css'), 'utf8');
    const lightThemeVariables = variables.match(/:root\s*\{([\s\S]*?)\n\}/)?.[1] || '';
    const darkThemeVariables = variables.match(/\[data-theme="dark"\]\s*\{([\s\S]*?)\n\}/)?.[1] || '';

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
      },
      {
        catalogKey: 'chat:visible-2',
        runtimeProvider: 'copilot',
        routeRef: { runtimeProvider: 'copilot', agentId: 'agent-a', sessionId: 'visible-2' },
        title: 'Visible 2',
        pinned: false,
        availability: 'online',
      },
    ];
    const sidebar = mount(UnifiedSessionList, {
      attachTo: document.body,
      props: {
        sessions: [],
        activeRoute: { runtimeProvider: 'copilot', agentId: 'agent-a', sessionId: 'visible' },
        processingConversations: { visible: true },
        isYeaftSessionProcessing: (sessionId, agentId) => sessionId === 'pinned' && agentId === 'user_1770305719:server-instance',
        agents: [{ id: 'user_1770305719:server-instance', name: 'server', online: true, capabilities: ['work_center'] }],
      },
      global: { mocks: { $t: key => key } },
    });
    expect(sidebar.findAll('.sidebar-session-toolbar')).toHaveLength(1);
    expect(sidebar.findAll('.sidebar-tool-button')).toHaveLength(1);
    expect(sidebar.findAll('.sidebar-provider-group')).toHaveLength(0);
    expect(sidebar.findAll('.session-item')).toHaveLength(0);
    await sidebar.setProps({ sessions: catalogRows });
    expect(sidebar.findAll('.session-item')).toHaveLength(3);
    expect(sidebar.text()).toContain('Visible');
    expect(sidebar.text()).toContain('Pinned');
    expect(sidebar.findAll('.session-item.processing')).toHaveLength(2);
    expect(sidebar.findAll('.processing-dot')).toHaveLength(2);
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
    expect(firstRow.get('.session-item-header').text()).toContain('Pinned');
    expect(firstRow.get('.session-item-header').text()).not.toContain('server');
    expect(firstRow.get('.session-info .session-agent').text()).toBe('server');
    expect(sidebar.findAll('.session-info .session-provider').map(item => item.text())).toEqual([
      'Yeaft',
      'provider.copilot',
      'provider.copilot',
    ]);
    expect(UnifiedSessionList.methods.providerLabel.call({ $t: key => key }, {
      runtimeProvider: 'claude-code',
    })).toBe('provider.claudeCode');
    expect(sidebar.text()).not.toContain('user_1770305719');
    expect(UnifiedSessionList.methods.agentLabel.call({ agents: [] }, {
      runtimeProvider: 'yeaft',
      agentName: 'agent-fallback',
      routeRef: { agentId: 'agent-fallback' },
    })).toBe('');
    await sidebar.setProps({
      processingConversations: {},
      isYeaftSessionProcessing: () => false,
    });
    expect(sidebar.findAll('.processing-dot')).toHaveLength(0);
    await sidebar.setProps({
      processingConversations: { visible: true },
      isYeaftSessionProcessing: (sessionId, agentId) => sessionId === 'pinned' && agentId === 'user_1770305719:server-instance',
    });
    expect(sidebar.findAll('.processing-dot')).toHaveLength(2);

    expect(sidebar.findAll('.session-item')).toHaveLength(3);
    expect(sidebar.text()).toContain('Visible');
    expect(sidebar.text()).toContain('Visible 2');
    expect(sidebar.text()).toContain('Pinned');
    expect(sidebar.findAll('.processing-dot')).toHaveLength(2);
    await sidebar.find('.sidebar-create-trigger').trigger('click');
    expect(sidebar.emitted('create').at(-1)).toEqual([]);
    await sidebar.setProps({ workCenterOpen: true });
    expect(sidebar.findAll('.sidebar-provider-group')).toHaveLength(0);
    expect(sidebar.findAll('.session-item.active')).toHaveLength(0);
    await sidebar.findAll('.session-item')[0].trigger('click');
    expect(sidebar.emitted('close-work-center')).toHaveLength(1);
    await sidebar.setProps({ workCenterOpen: false, agents: [] });
    expect(sidebar.find('.sidebar-create-trigger').attributes('disabled')).toBeDefined();
    await sidebar.setProps({
      agents: [{ id: 'user_1770305719:server-instance', name: 'server', online: true, capabilities: ['work_center'] }],
    });

    const dataTransfer = {
      value: '',
      setData(_type, value) { this.value = value; },
      getData() { return this.value; },
    };
    const visibleRows = sidebar.findAll('.session-item');
    await visibleRows[1].trigger('dragstart', { dataTransfer });
    await visibleRows[2].trigger('drop', { dataTransfer });
    expect(sidebar.emitted('action').at(-1)[0].sessions.map(row => row.catalogKey)).toEqual([
      'yeaft:user_1770305719:server-instance:pinned',
      'chat:offline',
      'chat:visible-2',
      'chat:visible',
    ]);

    const documentAdd = vi.spyOn(document, 'addEventListener');
    const documentRemove = vi.spyOn(document, 'removeEventListener');
    const windowAdd = vi.spyOn(window, 'addEventListener');
    const windowRemove = vi.spyOn(window, 'removeEventListener');
    sidebar.unmount();
    const lifecycleSidebar = mount(UnifiedSessionList, {
      attachTo: document.body,
      props: {
        sessions: catalogRows,
        activeRoute: {
          runtimeProvider: 'yeaft',
          agentId: 'user_1770305719:server-instance',
          sessionId: 'pinned',
        },
        processingConversations: { visible: true },
        isYeaftSessionProcessing: (sessionId, agentId) => sessionId === 'pinned' && agentId === 'user_1770305719:server-instance',
        agents: [{ id: 'user_1770305719:server-instance', name: 'server', online: true, capabilities: ['work_center'] }],
      },
      global: { mocks: { $t: key => key } },
    });
    expect(documentAdd).toHaveBeenCalledWith('pointerdown', expect.any(Function), true);
    expect(documentAdd).toHaveBeenCalledWith('keydown', expect.any(Function));
    expect(windowAdd).toHaveBeenCalledWith('scroll', expect.any(Function), true);
    expect(windowAdd).toHaveBeenCalledWith('resize', expect.any(Function));
    documentRemove.mockClear();
    windowRemove.mockClear();

    let trigger = lifecycleSidebar.get('.session-dots-btn');
    trigger.element.getBoundingClientRect = () => ({
      top: 720, bottom: 744, left: 300, right: 324, width: 24, height: 24,
    });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 768 });
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 });
    await trigger.trigger('click');
    await Vue.nextTick();
    const menu = document.body.querySelector('.session-menu-floating');
    expect(menu).not.toBeNull();
    expect(menu.parentElement).toBe(document.body);
    expect(parseInt(menu.style.top, 10)).toBeLessThan(720);
    const menuButtons = [...menu.querySelectorAll('.session-menu-item')];
    expect(menuButtons.map(button => button.textContent.trim())).toEqual([
      'chat.sidebar.unpin',
      'chat.sidebar.renameConv',
      'yeaft.session.openSettings',
      'common.close',
    ]);
    const remove = menuButtons.find(button => button.textContent.includes('common.close'));
    expect(remove).toBeTruthy();
    expect(remove.disabled).toBe(false);
    remove.click();
    await Vue.nextTick();
    expect(lifecycleSidebar.emitted('action').at(-1)[0]).toMatchObject({
      action: 'remove',
      row: { catalogKey: catalogRows[0].catalogKey },
    });

    const chatTrigger = lifecycleSidebar.findAll('.session-dots-btn')[1];
    await chatTrigger.trigger('click');
    await Vue.nextTick();
    const chatMenu = document.body.querySelector('.session-menu-floating');
    expect([...chatMenu.querySelectorAll('.session-menu-item')].map(button => button.textContent.trim())).toEqual([
      'chat.sidebar.pin',
      'chat.sidebar.renameConv',
      'common.close',
    ]);
    expect(chatMenu.textContent).not.toContain('splitScreen.splitToPanel');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await Vue.nextTick();
    trigger = lifecycleSidebar.findAll('.session-dots-btn')[0];

    const openMenu = async () => {
      await trigger.trigger('click');
      await Vue.nextTick();
      expect(document.body.querySelector('.session-menu-floating')).not.toBeNull();
    };
    await openMenu();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await Vue.nextTick();
    expect(document.body.querySelector('.session-menu-floating')).toBeNull();
    await openMenu();
    window.dispatchEvent(new Event('scroll'));
    await Vue.nextTick();
    expect(document.body.querySelector('.session-menu-floating')).toBeNull();
    await openMenu();
    window.dispatchEvent(new Event('resize'));
    await Vue.nextTick();
    expect(document.body.querySelector('.session-menu-floating')).toBeNull();
    await openMenu();
    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    await Vue.nextTick();
    expect(document.body.querySelector('.session-menu-floating')).toBeNull();
    await openMenu();
    await lifecycleSidebar.findAll('.session-item')[0].trigger('click');
    await Vue.nextTick();
    expect(document.body.querySelector('.session-menu-floating')).toBeNull();

    lifecycleSidebar.unmount();
    expect(documentRemove).toHaveBeenCalledWith('pointerdown', expect.any(Function), true);
    expect(documentRemove).toHaveBeenCalledWith('keydown', expect.any(Function));
    expect(windowRemove).toHaveBeenCalledWith('scroll', expect.any(Function), true);
    expect(windowRemove).toHaveBeenCalledWith('resize', expect.any(Function));
    documentAdd.mockRestore();
    documentRemove.mockRestore();
    windowAdd.mockRestore();
    windowRemove.mockRestore();

    expect(UnifiedSessionList.template).toContain(':key="row.catalogKey"');
    expect(UnifiedSessionList.emits).toContain('create');
    expect(UnifiedSessionList.emits).not.toContain('open-work-center');
    expect(UnifiedSessionList.template).toContain('createSession');
    expect(UnifiedSessionList.template).toContain('sidebar-session-toolbar');
    expect(UnifiedSessionList.template).toContain("emitAction('pin', row)");
    expect(UnifiedSessionList.template).toContain(":tabindex=\"isAvailable(row) ? 0 : -1\"");
    expect(UnifiedSessionList.methods.isAvailable({ availability: 'offline' })).toBe(false);
    expect(UnifiedSessionList.template).toContain("emitAction('remove', row)");
    expect(UnifiedSessionList.template).toContain('v-if="isSessionUnread(row)" class="unread-dot"');
    expect(UnifiedSessionList.template).toContain('v-else-if="isProcessing(row)" class="processing-dot"');
    expect(UnifiedSessionList.template).not.toContain("emitAction('split', row)");
    expect(UnifiedSessionList.template).toContain("$t('common.close')");
    expect(sidebarCss).not.toMatch(/\.sidebar-surface-switch\s*\{/s);
    expect(sidebarCss).not.toMatch(/\.sidebar-provider-tab\s*\{/s);
    expect(sidebarCss).not.toMatch(/\.sidebar-provider-group\s*\{/s);
    expect(sidebarCss).toMatch(/\.sidebar-session-toolbar\s*\{[^}]*min-height:\s*38px/s);
    expect(sidebarCss).toMatch(/\.sidebar-session-title\s*\{[^}]*font-size:\s*15px/s);
    expect(sidebarCss).toMatch(/\.session-item\s*\{[^}]*padding:\s*8px 12px;[^}]*margin-bottom:\s*1px/s);
    expect(sidebarCss).toMatch(/\.session-item \.title\s*\{[^}]*font-size:\s*14px/s);
    const sharedBadgeRule = sidebarCss.match(/\.session-agent,\s*\.session-provider,\s*\.session-availability\s*\{([\s\S]*?)\}/)?.[1] || '';
    expect(sharedBadgeRule).toMatch(/color:\s*var\(--text-secondary\)/);
    expect(sharedBadgeRule).toMatch(/background:\s*var\(--bg-input-wrapper\)/);
    expect(sidebarCss).not.toMatch(/\.session-(?:agent|provider)(?=\s*\{)[^}]*background:/s);
    for (const tokenName of ['--text-secondary', '--bg-input-wrapper']) {
      const tokenPattern = new RegExp(`${tokenName}:\\s*[^;]+;`);
      expect(lightThemeVariables).toMatch(tokenPattern);
      expect(darkThemeVariables).toMatch(tokenPattern);
    }
    expect(sidebarCss).toMatch(/\.sidebar-tool-button:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--accent-blue\)/s);
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
    await chatPage.get('.sidebar-create-trigger').trigger('click');
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
    await yeaftSidebar.get('.sidebar-create-trigger').trigger('click');
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

    let resolvePluginConfig;
    const pendingPluginConfig = new Promise(resolve => { resolvePluginConfig = resolve; });
    const pluginStore = Vue.reactive({
      agents: [{ id: 'agent-a', name: 'Agent A', online: true }],
      currentAgent: 'agent-a',
      pluginCenterAgentId: 'agent-a',
      pluginConfigByAgent: {},
      pluginCatalogByKey: {
        'agent-a:': {
          loading: false,
          catalog: {
            tools: [{ id: 'FileRead', label: 'FileRead' }],
            skills: [{ id: 'skill-a', label: 'skill-a' }, { id: 'skill-b', label: 'skill-b' }],
            mcpServers: [],
          },
        },
      },
      pluginCatalogKey: (agentId, workDir = '') => `${agentId}:${workDir}`,
      loadPluginConfig: vi.fn(() => pendingPluginConfig),
      loadPluginCatalog: vi.fn(() => Promise.resolve()),
      savePluginConfig: vi.fn(plugins => Promise.resolve({ plugins })),
    });
    globalThis.Pinia.useChatStore = () => pluginStore;
    const pluginCenter = mount(PluginCenterPage, {
      global: { mocks: { $t: key => key } },
    });
    await Vue.nextTick();
    expect(pluginCenter.findAll('input[type="checkbox"]').every(input => input.element.disabled)).toBe(true);
    expect(pluginCenter.get('.btn-primary').attributes('disabled')).toBeDefined();
    pluginCenter.vm.toggle('skills', 'skill-a', false);
    await pluginCenter.vm.save();
    expect(pluginStore.savePluginConfig).not.toHaveBeenCalled();

    resolvePluginConfig({ plugins: { tools: ['FileRead'] } });
    await pendingPluginConfig;
    await Promise.resolve();
    await Vue.nextTick();
    expect(pluginCenter.vm.configReady).toBe(true);
    expect(pluginCenter.vm.selection).toEqual({ tools: ['FileRead'] });
    pluginCenter.vm.toggle('skills', 'skill-a', false);
    expect(pluginCenter.vm.selection).toEqual({
      tools: ['FileRead'],
      skills: ['skill-b'],
    });
    await pluginCenter.vm.save();
    expect(pluginStore.savePluginConfig).toHaveBeenCalledWith({
      tools: ['FileRead'],
      skills: ['skill-b'],
    }, 'agent-a');
    expect(pluginCenter.vm.enabledCount).toBe(2);
    pluginCenter.unmount();

    globalThis.Pinia.useChatStore = () => workCenterStore;
    await workCenterPage.get('.work-center-agent-picker .modern-select-trigger').trigger('click');
    await Vue.nextTick();
    const agentMenu = document.body.querySelector('.work-center-agent-menu');
    expect(agentMenu).not.toBeNull();
    expect([...agentMenu.querySelectorAll('.modern-select-option-label')].map(row => row.textContent.trim())).toEqual(['server', 'C1']);
    agentMenu.querySelectorAll('.modern-select-option')[1].click();
    await Vue.nextTick();
    expect(workCenterStore.enterWorkCenter).toHaveBeenCalledWith('agent-b');
    workCenterPage.unmount();
    delete globalThis.Vue;
    delete globalThis.Pinia.useChatStore;
    expect(workCenter).toContain('workItemMessageAttachments.length === 0');
    expect(workCenter).toContain('work-center-detail-close');
    expect(workCenter).not.toContain('class="work-center-action-content-summary"');
    expect(workCenterCss).toContain('grid-template-columns: minmax(0, 1fr) minmax(400px, 440px);');
    expect(workCenterCss).toMatch(/\.work-center-detail-close\s*\{[\s\S]*?position: absolute;[\s\S]*?right: 16px;/);
    expect(workCenterCss).toMatch(/\.work-center-action-description\s*\{[\s\S]*?white-space: nowrap;/);
    expect(workCenter).not.toContain('coordinatorRequestedSelectedActionInput');
    expect(workCenter).not.toContain("next?.routedTo === 'coordinator'");
    expect(workCenter).not.toContain("[...(this.selected.messages || [])].reverse().some");
    expect(workCenter).not.toContain("message.recovery?.actionId === this.selectedAction.id");
    expect(workCenter).toContain(":class=\"{ 'showing-detail': narrowPane !== 'items' }\"");
    expect(workCenterCss).toMatch(/\.work-center-shell\.showing-detail\s*\{[\s\S]*?padding-top: 10px;/);
    expect(workCenterCss).toMatch(/\.work-center-detail-heading\s*\{[\s\S]*?padding: 10px 56px 12px 24px;/);
    expect(workCenterCss).toMatch(/\.work-center-action-detail-header,[\s\S]*?\.work-center-action-composer\s*\{[\s\S]*?width: 100%;/);
    expect(workCenterCss).not.toContain('width: min(100%, 1120px);');
    expect(variables).toContain('--work-center-conversation-column-width: 1200px;');
    expect(variables).toContain('--work-center-conversation-gutter: clamp(20px, 3vw, 40px);');
    expect(workCenterCss).toMatch(/@container work-center \(max-width: 1120px\)\s*\{[\s\S]*?\.work-center-detail-layout\s*\{[\s\S]*?grid-template-columns: minmax\(0, 1fr\);/);
    expect(workCenterCss).toMatch(/@media \(max-width: 768px\)\s*\{[\s\S]*?\.work-center-action-detail-pane\s*\{[\s\S]*?--work-center-conversation-gutter: var\(--work-center-conversation-gutter-compact\);/);

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
      useVpStore: () => ({ vpList: [{ vpId: 'omni' }], lastSnapshotAt: 1, lastVpSnapshotAgentId: 'agent-a', vpLabel: id => id }),
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
    expect(modal.findAll('.yeaft-session-create-fields > .resume-control-row')).toHaveLength(4);
    expect(modal.get('.yeaft-create-submit').classes()).toContain('btn-primary');
    expect(modal.find('.resume-control-row-vp').exists()).toBe(false);
    await selects[1].setValue('yeaft');
    expect(modal.find('.resume-control-row-vp').exists()).toBe(true);
    await selects[1].setValue('claude-code');
    modal.vm.form.workDir = '/repo';
    await modal.vm.onSubmit();
    expect(chat.createConversation).toHaveBeenCalledWith('/repo', 'agent-a', null, { provider: 'claude-code' });
    modal.unmount();
    globalThis.Pinia = originalPinia;
    window.Pinia = originalWindowPinia;

    wrapper.unmount();
  });

  it('stamps background agent messages without promoting that conversation', () => {
    const store = makeStore();
    store.yeaftConversationIdsByAgent = {
      'agent-1': 'conv-1',
      'agent-2': 'conv-2',
    };
    store.messagesMap['conv-2'] = [];
    store._currentYeaftSessionId = 'session-2';
    store._currentYeaftVpId = 'vp-2';
    store._currentYeaftTurnId = 'turn-2';

    addMessageToConversation(store, 'conv-2', {
      id: 'msg-2',
      type: 'assistant',
      content: 'background',
    });

    expect(store.yeaftConversationId).toBe('conv-1');
    expect(store.messagesMap['conv-2'][0]).toMatchObject({
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
