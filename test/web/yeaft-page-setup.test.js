// @vitest-environment happy-dom
import * as Vue from 'vue';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

let YeaftPage;

const sessionsStore = {
  activeSessionId: 'session-1',
  activeSession: { id: 'session-1', roster: ['omni'], defaultVpId: 'omni' },
  activeNeedsInvite: false,
  hasLoadedSnapshot: true,
  isEmpty: false,
  sessions: {},
  sessionById: () => null,
};

const chatStore = {
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
  yeaftHistorySearchState: { query: '', senderKey: '' },
  searchYeaftHistory: vi.fn(),
};

beforeAll(async () => {
  globalThis.Vue = Vue;
  globalThis.Pinia = {
    defineStore: () => () => ({}),
    useChatStore: () => chatStore,
    useAuthStore: () => ({}),
    useVpStore: () => ({ vpList: [] }),
    useSessionsStore: () => sessionsStore,
  };
  window.Pinia = globalThis.Pinia;
  ({ default: YeaftPage } = await import('../../web/components/YeaftPage.js'));
});

beforeEach(() => {
  localStorage.clear();
  chatStore.yeaftHistorySearchState = { query: '', senderKey: '' };
  chatStore.searchYeaftHistory.mockReset();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
});

describe('YeaftPage setup', () => {
  it('resolves the Session store before the draft watcher evaluates', () => {
    expect(() => YeaftPage.setup()).not.toThrow();
  });

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
});
