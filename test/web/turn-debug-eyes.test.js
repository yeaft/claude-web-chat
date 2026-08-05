// @vitest-environment happy-dom
/**
 * turn-debug-eyes.test.js — turn-level debug entry.
 *
 * Covers:
 *   1. VpTurnBlock puts a debug-specific action first in the existing
 *      hover footer on finished AI turns and emits `open-debug`; streaming
 *      turns have no debug action.
 *   2. `handleMessage` `yeaft_debug_history` detail responses flip the
 *      turn-level debug panel to ready/error and stale requestIds cannot
 *      overwrite a newer panel selection.
 */
import { mount } from '@vue/test-utils';
import { describe, expect, it, beforeEach, vi } from 'vitest';
import * as Vue from 'vue';

const vpStore = Vue.reactive({
  vpList: [],
  vpLabel: (vpId) => vpId,
  vpTextColor: () => '',
});
const chatStore = Vue.reactive({
  currentAgent: 'agent-1',
  cancelVpTurn: vi.fn(),
  isVpTypingInCurrentConv: () => false,
  activeVpTurns: {},
});

globalThis.Vue = Vue;
globalThis.Pinia = {
  defineStore: (id) => {
    if (id === 'vp') return () => vpStore;
    if (id === 'chat') return () => chatStore;
    return () => ({});
  },
  useChatStore: () => chatStore,
  useVpStore: () => vpStore,
};
window.Pinia = globalThis.Pinia;

const { default: VpTurnBlock } = await import('../../web/components/VpTurnBlock.js');
const { handleMessage } = await import('../../web/stores/helpers/messageHandler.js');

function makeTurn(overrides = {}) {
  return {
    type: 'assistant-turn',
    speakerVpId: 'omni',
    turnId: 'turn-abc',
    textContent: 'hello',
    isStreaming: false,
    ...overrides,
  };
}

beforeEach(() => {
  chatStore.currentAgent = 'agent-1';
  chatStore.activeVpTurns = {};
  chatStore.cancelVpTurn.mockClear();
});

describe('VpTurnBlock debug action', () => {
  it('renders the debug-specific action first in the existing hover footer', () => {
    const wrapper = mount(VpTurnBlock, {
      props: { turn: makeTurn() },
      global: { mocks: { $t: key => key }, provide: { t: key => key } },
    });
    const footer = wrapper.find('.turn-footer');
    const actions = footer.findAll('button');
    const btn = footer.find('.debug-turn-action-btn');

    expect(footer.exists()).toBe(true);
    expect(btn.exists()).toBe(true);
    expect(actions[0].classes()).toContain('debug-turn-action-btn');
    expect(btn.attributes('aria-label')).toContain('debug trace');
    expect(btn.find('.debug-turn-action-icon').exists()).toBe(true);
    expect(wrapper.find('.vp-turn-debug-btn').exists()).toBe(false);
    expect(wrapper.find('.vp-turn-block-actions').exists()).toBe(false);
  });

  it('does not render the debug action while the turn is streaming', () => {
    const wrapper = mount(VpTurnBlock, {
      props: { turn: makeTurn({ isStreaming: true }) },
      global: { mocks: { $t: key => key }, provide: { t: key => key } },
    });
    expect(wrapper.find('.debug-turn-action-btn').exists()).toBe(false);
  });

  it('does not opt a legacy AssistantTurn into the debug action', async () => {
    const { default: AssistantTurn } = await import('../../web/components/AssistantTurn.js');
    const wrapper = mount(AssistantTurn, {
      props: { turn: makeTurn({ speakerVpId: null }) },
      global: {
        mocks: { $t: key => key },
        provide: { t: key => key },
        stubs: { VpSpeakerHeader: true },
      },
    });
    expect(wrapper.find('.debug-turn-action-btn').exists()).toBe(false);
  });

  it('emits open-debug with the turn identity on click', async () => {
    const wrapper = mount(VpTurnBlock, {
      props: { turn: makeTurn() },
      global: { mocks: { $t: key => key }, provide: { t: key => key } },
    });
    await wrapper.find('.debug-turn-action-btn').trigger('click');
    expect(wrapper.emitted('open-debug')).toHaveLength(1);
  });
});

describe('handleMessage turn-level panel status', () => {
  function makeStore(overrides = {}) {
    return Vue.reactive({
      _yeaftDebugHistoryLatestDetailRequestId: null,
      _yeaftDebugHistoryLatestListRequestId: null,
      _fetchYeaftDebugHistoryTimer: null,
      _yeaftDebugHistoryInFlightKey: null,
      yeaftDebugHistoryLoading: false,
      yeaftDebugHistoryError: null,
      yeaftDebugHistoryFetchedAt: 0,
      yeaftDebugHistoryHasMore: false,
      yeaftDebugHistoryLimit: 1,
      yeaftDebugTurnsById: {},
      yeaftDebugLoops: [],
      yeaftDebugTurnOrder: [],
      yeaftDebugPanel: {
        open: true,
        status: 'loading',
        requestId: 'dbgpanel_req_1',
        agentId: 'agent-1',
        sessionId: 'session-1',
        turnId: 'turn-abc',
        error: null,
      },
      _appendDreamEvent: () => {},
      handleYeaftOutput: () => {},
      ...overrides,
    });
  }

  it('flips the panel to ready when the matching detail turn lands', () => {
    const store = makeStore();
    store._yeaftDebugHistoryLatestDetailRequestId = 'dbgpanel_req_1';
    handleMessage(store, {
      type: 'yeaft_debug_history',
      requestId: 'dbgpanel_req_1',
      detailTurnId: 'turn-abc',
      turns: [{ turnId: 'turn-abc', detailsLoaded: true, loopCount: 1 }],
      loops: [{ turnId: 'turn-abc', loopNumber: 1 }],
      dreamEvents: [],
    });
    expect(store.yeaftDebugPanel.status).toBe('ready');
    expect(store.yeaftDebugPanel.error).toBeNull();
    expect(store.yeaftDebugTurnsById['turn-abc'].loopCount).toBe(1);
  });

  it('flips the panel to error when the agent returns an error', () => {
    const store = makeStore();
    store._yeaftDebugHistoryLatestDetailRequestId = 'dbgpanel_req_1';
    handleMessage(store, {
      type: 'yeaft_debug_history',
      requestId: 'dbgpanel_req_1',
      detailTurnId: 'turn-abc',
      turns: [],
      loops: [],
      dreamEvents: [],
      error: 'trace disabled',
    });
    expect(store.yeaftDebugPanel.status).toBe('error');
    expect(store.yeaftDebugPanel.error).toBe('trace disabled');
  });

  it('ignores a stale detail response for an older panel request', () => {
    const store = makeStore();
    store._yeaftDebugHistoryLatestDetailRequestId = 'dbgpanel_req_NEW';
    handleMessage(store, {
      type: 'yeaft_debug_history',
      requestId: 'dbgpanel_req_OLD',
      detailTurnId: 'turn-abc',
      turns: [],
      loops: [],
      dreamEvents: [],
    });
    // Guard drops the stale response before any state mutation.
    expect(store.yeaftDebugPanel.status).toBe('loading');
    expect(store.yeaftDebugHistoryFetchedAt).toBe(0);
  });
});
