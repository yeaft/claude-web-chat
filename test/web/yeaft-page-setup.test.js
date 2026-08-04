// @vitest-environment happy-dom
import * as Vue from 'vue';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

let YeaftPage;
let loadHistorySenderPreference;
let saveHistorySenderPreference;

const sessionsStore = Vue.reactive({
  activeSessionId: 'session-1',
  activeSession: { id: 'session-1', roster: ['omni'], defaultVpId: 'omni' },
  activeNeedsInvite: false,
  hasLoadedSnapshot: true,
  isEmpty: false,
  sessions: { 'session-1': { id: 'session-1', roster: ['omni'], defaultVpId: 'omni' } },
  sessionById: sessionId => sessionsStore.sessions[sessionId] || null,
});

const chatStore = Vue.reactive({
  currentAgent: 'agent-1',
  currentAgentInfo: { online: true },
  agents: [{ id: 'agent-1', online: true }],
  _hasHandledAgentList: true,
  _hasHandledYeaftSessionHydrate: true,
  yeaftSessionHydrateError: null,
  yeaftActiveSessionFilter: 'session-1',
  sidebarCollapsed: false,
  sessionSidebarOpen: false,
  workCenterOpen: false,
  workbenchExpanded: false,
  workbenchMaximized: false,
  yeaftAvailableModels: [],
  yeaftActiveTasksBySession: {},
  inputDrafts: {},
  hasCapability: () => false,
  getYeaftHistoryOutlineState: () => ({ results: [], loading: false, hasMore: false, totalCount: 0 }),
  loadYeaftHistoryOutline: vi.fn(),
  yeaftHistorySearchState: { query: '', senderKey: '' },
  searchYeaftHistory: vi.fn(),
});

beforeAll(async () => {
  globalThis.Vue = Vue;
  globalThis.Pinia = {
    defineStore: () => () => ({}),
    useChatStore: () => chatStore,
    useAuthStore: () => ({}),
    useVpStore: () => ({ vpList: [], vpLabel: vpId => vpId }),
    useSessionsStore: () => sessionsStore,
  };
  window.Pinia = globalThis.Pinia;
  ({ default: YeaftPage, loadHistorySenderPreference, saveHistorySenderPreference } = await import('../../web/components/YeaftPage.js'));
});

beforeEach(() => {
  localStorage.clear();
  sessionsStore.sessions = {
    'session-1': {
      id: 'session-1',
      title: 'Conversation title',
      workDir: '/home/user/projects/yeaft-web-code-agent',
      roster: ['omni'],
      defaultVpId: 'omni',
      config: { model: 'provider/session-model', modelEffort: 'high' },
    },
  };
  sessionsStore.activeSession = sessionsStore.sessions['session-1'];
  chatStore.yeaftModel = 'provider/fallback-model';
  chatStore.yeaftModelEffort = 'medium';
  chatStore.yeaftAvailableModels = [
    { id: 'session-model', provider: 'provider', ref: 'provider/session-model', effortOptions: ['low', 'medium', 'high'] },
    { id: 'next-model', provider: 'provider', ref: 'provider/next-model', effortOptions: ['medium', 'high'] },
  ];
  chatStore.switchYeaftModel = vi.fn();
  chatStore.yeaftHistorySearchState = { query: '', senderKey: '' };
  chatStore.loadYeaftHistoryOutline.mockReset();
  chatStore.searchYeaftHistory.mockReset();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
});

describe('YeaftPage setup', () => {
  it('defaults Session history search to the user without replacing an explicit sender choice', async () => {
    const page = YeaftPage.setup();

    expect(page.topbarSessionTitle.value).toBe('Conversation title');
    expect(page.topbarFolderPath.value).toBe('/home/user/projects/yeaft-web-code-agent');
    expect(page.topbarModel.value).toBe('provider/session-model');
    expect(page.topbarEffort.value).toBe('high');

    page.selectModel('provider/next-model', 'medium');
    expect(chatStore.switchYeaftModel).toHaveBeenCalledWith('provider/next-model', 'session-1', 'medium');

    const source = YeaftPage.template;
    const topbarStart = source.indexOf('<div class="yeaft-topbar">');
    const topbarEnd = source.indexOf('</div>', source.indexOf('<YeaftSessionActions', topbarStart));
    const topbar = source.slice(topbarStart, topbarEnd);
    expect(topbar).toContain('class="yeaft-topbar-folder"');
    expect(topbar).toContain('class="yeaft-topbar-context"');
    expect(topbar).not.toContain('class="yeaft-composer-model"');
    expect(source).toContain('class="yeaft-session-input"');
    expect(source).toContain('<template #actions-start>');
    expect(source).toContain('class="yeaft-composer-model-control"');
    expect(source).toContain('class="yeaft-composer-model"');
    expect(source).toContain('class="yeaft-composer-model-effort"');
    expect(source).toContain("$t('yeaft.modelMenu.effort.' + topbarEffort)");
    expect(source).toContain('class="yeaft-model-effort-chip"');
    expect(source).toContain('class="yeaft-model-option-provider"');
    expect(source).toContain('class="yeaft-model-option-ctx"');
    expect(source).toContain('class="yeaft-model-config-option"');
    expect(source).toContain(':title="topbarFolderPath"');
    const yeaftCss = readFileSync(resolve(import.meta.dirname, '../../web/styles/yeaft.css'), 'utf8');
    expect(yeaftCss).toMatch(/\.yeaft-topbar\s*\{[^}]*display:\s*grid;[^}]*grid-template-columns:\s*minmax\(0, 1fr\) minmax\(0, 1fr\) minmax\(0, 1fr\);/s);
    expect(yeaftCss).toMatch(/\.yeaft-topbar-context\s*\{[^}]*grid-column:\s*1 \/ -1;[^}]*grid-row:\s*1;/s);
    expect(yeaftCss).toMatch(/\.yeaft-topbar-title-group\s*\{[^}]*grid-column:\s*2;/s);
    expect(yeaftCss).toMatch(/\.yeaft-topbar-right\s*\{[^}]*grid-column:\s*3;[^}]*justify-self:\s*end;/s);
    const mobileTopbar = yeaftCss.slice(yeaftCss.indexOf('@media (max-width: 768px)'));
    expect(mobileTopbar).toMatch(/\.yeaft-topbar-context\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\);/s);
    expect(mobileTopbar).toMatch(/\.yeaft-topbar-title-group\s*\{[^}]*grid-column:\s*1;[^}]*grid-row:\s*1;/s);
    expect(mobileTopbar).toMatch(/\.yeaft-topbar-folder\s*\{[^}]*grid-column:\s*1;[^}]*grid-row:\s*2;/s);

    page.toggleHistorySearch();
    await Vue.nextTick();
    expect(chatStore.yeaftHistorySearchState.senderKey).toBe('user');
    expect(chatStore.searchYeaftHistory).toHaveBeenCalledWith('', { senderKey: 'user' });

    page.onHistorySenderChange('vp:omni');
    page.toggleHistorySearch();
    page.toggleHistorySearch();
    await Vue.nextTick();
    expect(chatStore.yeaftHistorySearchState.senderKey).toBe('vp:omni');
    expect(chatStore.searchYeaftHistory).toHaveBeenLastCalledWith('', { senderKey: 'vp:omni' });
  });

  it('keeps the current query through sender changes and lifecycle resets', async () => {
    vi.useFakeTimers();
    chatStore.yeaftHistorySearchState = { query: 'old query', senderKey: '' };
    const page = YeaftPage.setup();

    page.onHistorySearchQuery('new query');
    page.onHistorySenderChange('vp:omni');
    vi.advanceTimersByTime(220);

    expect(chatStore.searchYeaftHistory).toHaveBeenCalledTimes(1);
    expect(chatStore.searchYeaftHistory).toHaveBeenCalledWith('new query', { senderKey: 'vp:omni' });

    page.toggleHistorySearch();
    page.toggleHistorySearch();
    await Vue.nextTick();
    expect(chatStore.yeaftHistorySearchState.senderKey).toBe('vp:omni');
    expect(chatStore.searchYeaftHistory).toHaveBeenLastCalledWith('', { senderKey: 'vp:omni' });

    saveHistorySenderPreference({ agentId: 'agent-1', sessionId: 'session-2', senderKey: 'user' });
    chatStore.searchYeaftHistory.mockClear();
    page.onHistorySenderInvalid();

    expect(chatStore.searchYeaftHistory).toHaveBeenCalledWith('', { senderKey: 'user' });
    expect(loadHistorySenderPreference({
      agentId: 'agent-1', sessionId: 'session-1', validKeys: ['user'],
    })).toBe('user');
    expect(loadHistorySenderPreference({
      agentId: 'agent-1', sessionId: 'session-2', validKeys: ['user'],
    })).toBe('user');
  });

  it('keeps sender preferences isolated, valid, and storage-safe', () => {
    vi.useFakeTimers();
    chatStore.yeaftHistorySearchState = { query: 'old query', senderKey: '' };
    const page = YeaftPage.setup();

    page.onHistorySearchQuery('');
    page.onHistorySenderChange('user');
    vi.advanceTimersByTime(220);

    expect(chatStore.searchYeaftHistory).toHaveBeenCalledTimes(1);
    expect(chatStore.searchYeaftHistory).toHaveBeenCalledWith('', { senderKey: 'user' });
    expect(saveHistorySenderPreference({ agentId: 'agent-1', sessionId: 'session-1', senderKey: 'vp:omni' })).toBe(true);
    expect(saveHistorySenderPreference({ agentId: 'agent-1', sessionId: 'session-2', senderKey: 'user' })).toBe(true);

    expect(loadHistorySenderPreference({
      agentId: 'agent-1', sessionId: 'session-1', validKeys: ['user', 'vp:omni'],
    })).toBe('vp:omni');
    expect(loadHistorySenderPreference({
      agentId: 'agent-1', sessionId: 'session-2', validKeys: ['user', 'vp:omni'],
    })).toBe('user');
    expect(loadHistorySenderPreference({
      agentId: 'agent-2', sessionId: 'session-1', validKeys: ['user', 'vp:omni'],
    })).toBe('user');

    expect(saveHistorySenderPreference({ agentId: 'agent-2', sessionId: 'session-1', senderKey: '' })).toBe(true);
    expect(loadHistorySenderPreference({
      agentId: 'agent-2', sessionId: 'session-1', validKeys: ['user', 'vp:omni'],
    })).toBe('');

    saveHistorySenderPreference({ agentId: 'agent-1', sessionId: 'session-1', senderKey: 'vp:removed' });
    expect(loadHistorySenderPreference({
      agentId: 'agent-1', sessionId: 'session-1', validKeys: ['user', 'vp:omni'],
    })).toBe('user');
    expect(loadHistorySenderPreference({
      agentId: 'agent-1', sessionId: 'session-2', validKeys: ['user'],
    })).toBe('user');

    const originalDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() { throw new DOMException('blocked', 'SecurityError'); },
    });
    try {
      expect(loadHistorySenderPreference({ agentId: 'agent-1', sessionId: 'session-1' })).toBe('user');
      expect(saveHistorySenderPreference({ agentId: 'agent-1', sessionId: 'session-1', senderKey: 'user' })).toBe(false);
    } finally {
      Object.defineProperty(globalThis, 'localStorage', originalDescriptor);
    }
  });
});
