// @vitest-environment happy-dom
import * as Vue from 'vue';
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
  sessionsStore.sessions = { 'session-1': { id: 'session-1', roster: ['omni'], defaultVpId: 'omni' } };
  sessionsStore.activeSession = sessionsStore.sessions['session-1'];
  chatStore.yeaftHistorySearchState = { query: '', senderKey: '' };
  chatStore.loadYeaftHistoryOutline.mockReset();
  chatStore.searchYeaftHistory.mockReset();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
});

describe('YeaftPage setup', () => {


  it('uses the current input query when sender changes before debounce expires', () => {
    vi.useFakeTimers();
    chatStore.yeaftHistorySearchState = { query: 'old query', senderKey: '' };
    const page = YeaftPage.setup();

    page.onHistorySearchQuery('new query');
    page.onHistorySenderChange('vp:omni');
    vi.advanceTimersByTime(220);

    expect(chatStore.searchYeaftHistory).toHaveBeenCalledTimes(1);
    expect(chatStore.searchYeaftHistory).toHaveBeenCalledWith('new query', { senderKey: 'vp:omni' });
  });

  it('uses an immediately cleared query when sender changes', () => {
    vi.useFakeTimers();
    chatStore.yeaftHistorySearchState = { query: 'old query', senderKey: '' };
    const page = YeaftPage.setup();

    page.onHistorySearchQuery('');
    page.onHistorySenderChange('user');
    vi.advanceTimersByTime(220);

    expect(chatStore.searchYeaftHistory).toHaveBeenCalledTimes(1);
    expect(chatStore.searchYeaftHistory).toHaveBeenCalledWith('', { senderKey: 'user' });
  });

  it('restores the selected sender when history search is reopened', async () => {
    const page = YeaftPage.setup();

    page.onHistorySenderChange('vp:omni');
    page.toggleHistorySearch();
    page.toggleHistorySearch();
    await Vue.nextTick();

    expect(chatStore.yeaftHistorySearchState.senderKey).toBe('vp:omni');
    expect(chatStore.searchYeaftHistory).toHaveBeenLastCalledWith('', { senderKey: 'vp:omni' });
  });

  it('remembers sender selection per agent and Session', () => {
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
    })).toBe('');
  });

  it('drops a remembered VP that is no longer in the Session roster', () => {
    saveHistorySenderPreference({ agentId: 'agent-1', sessionId: 'session-1', senderKey: 'vp:removed' });

    expect(loadHistorySenderPreference({
      agentId: 'agent-1', sessionId: 'session-1', validKeys: ['user', 'vp:omni'],
    })).toBe('');
    expect(JSON.parse(localStorage.getItem('yeaft-history-sender-preferences'))).toEqual({});
  });

  it('survives a localStorage property getter that throws', () => {
    const originalDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() { throw new DOMException('blocked', 'SecurityError'); },
    });
    try {
      expect(loadHistorySenderPreference({ agentId: 'agent-1', sessionId: 'session-1' })).toBe('');
      expect(saveHistorySenderPreference({ agentId: 'agent-1', sessionId: 'session-1', senderKey: 'user' })).toBe(false);
    } finally {
      Object.defineProperty(globalThis, 'localStorage', originalDescriptor);
    }
  });

  it('clears the active sender without touching another Session preference', () => {
    const page = YeaftPage.setup();
    page.onHistorySenderChange('vp:omni');
    saveHistorySenderPreference({ agentId: 'agent-1', sessionId: 'session-2', senderKey: 'user' });
    chatStore.searchYeaftHistory.mockClear();

    page.onHistorySenderInvalid();

    expect(chatStore.searchYeaftHistory).toHaveBeenCalledWith('', { senderKey: '' });
    expect(loadHistorySenderPreference({
      agentId: 'agent-1', sessionId: 'session-1', validKeys: ['user'],
    })).toBe('');
    expect(loadHistorySenderPreference({
      agentId: 'agent-1', sessionId: 'session-2', validKeys: ['user'],
    })).toBe('user');
  });
});
