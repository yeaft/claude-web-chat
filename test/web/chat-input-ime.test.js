// @vitest-environment happy-dom
import { mount } from '@vue/test-utils';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Vue from 'vue';

let ChatInput;
let store;

function createStore() {
  return Vue.reactive({
    activeConversationId: 'conversation-a',
    btwMode: false,
    compactStatus: null,
    currentAgent: 'agent-a',
    currentConversation: 'conversation-a',
    currentView: 'yeaft',
    customExpertRoles: [],
    expertSelections: [],
    inputDrafts: {},
    isProcessing: false,
    locale: 'en',
    slashCommandDescriptions: {},
    yeaftActiveSessionFilter: null,
  });
}

function mountInput(sendFn = vi.fn(), props = {}) {
  const wrapper = mount(ChatInput, {
    props: { sendFn, ...props },
    global: {
      mocks: {
        $t: key => key,
      },
    },
    attachTo: document.body,
  });
  return { wrapper, sendFn };
}

function enterEvent(overrides = {}) {
  return {
    key: 'Enter',
    shiftKey: false,
    isComposing: false,
    keyCode: 13,
    preventDefault: vi.fn(),
    ...overrides,
  };
}

beforeAll(async () => {
  globalThis.Vue = Vue;
  globalThis.Pinia = {
    defineStore: () => () => ({}),
    useAuthStore: () => ({ getActiveToken: () => null }),
    useChatStore: () => store,
    useSessionsStore: () => ({ activeSessionId: null, sessions: {} }),
    useVpStore: () => ({
      vpList: [],
      vpDescription: () => '',
      vpTextColor: () => 'var(--text-primary)',
    }),
  };
  globalThis.window.Pinia = globalThis.Pinia;
  ({ default: ChatInput } = await import('../../web/components/ChatInput.js'));
});

beforeEach(() => {
  store = createStore();
});

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('ChatInput IME keyboard handling', () => {
  it('does not send when Enter confirms an active composition', async () => {
    const { wrapper, sendFn } = mountInput();
    await wrapper.get('textarea').setValue('一段中文english');
    const event = enterEvent({ isComposing: true });

    wrapper.vm.handleKeydown(event);

    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(sendFn).not.toHaveBeenCalled();
    expect(wrapper.get('textarea').element.value).toBe('一段中文english');
    wrapper.unmount();
  });

  it('does not send Safari IME process events that report keyCode 229', async () => {
    const { wrapper, sendFn } = mountInput();
    await wrapper.get('textarea').setValue('一段中文english');
    const event = enterEvent({ isComposing: false, keyCode: 229 });

    wrapper.vm.handleKeydown(event);

    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(sendFn).not.toHaveBeenCalled();
    expect(wrapper.get('textarea').element.value).toBe('一段中文english');
    wrapper.unmount();
  });

  it('keeps normal Enter send and Shift+Enter newline behavior', async () => {
    const { wrapper, sendFn } = mountInput();
    await wrapper.get('textarea').setValue('ready');
    const shiftEnter = enterEvent({ shiftKey: true });

    wrapper.vm.handleKeydown(shiftEnter);

    expect(shiftEnter.preventDefault).not.toHaveBeenCalled();
    expect(sendFn).not.toHaveBeenCalled();

    const enter = enterEvent();
    wrapper.vm.handleKeydown(enter);
    await Vue.nextTick();

    expect(enter.preventDefault).toHaveBeenCalledOnce();
    expect(sendFn).toHaveBeenCalledWith('ready', undefined);
    expect(wrapper.get('textarea').element.value).toBe('');
    wrapper.unmount();
  });

  it('does not send with Enter while the stop control is active', async () => {
    const { wrapper, sendFn } = mountInput(vi.fn(), { showStop: true });
    await wrapper.get('textarea').setValue('second message');
    const enter = enterEvent();

    expect(wrapper.find('.stop-btn').exists()).toBe(true);
    expect(wrapper.find('.send-btn:not(.stop-btn)').exists()).toBe(false);

    wrapper.vm.handleKeydown(enter);
    await Vue.nextTick();

    expect(enter.preventDefault).toHaveBeenCalledOnce();
    expect(sendFn).not.toHaveBeenCalled();
    expect(wrapper.get('textarea').element.value).toBe('second message');
    wrapper.unmount();
  });
});
