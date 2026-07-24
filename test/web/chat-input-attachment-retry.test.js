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
    slashCommandDescriptions: {},
    yeaftActiveSessionFilter: null,
  });
}

function mountInput() {
  return mount(ChatInput, {
    props: { sendFn: vi.fn() },
    global: { mocks: { $t: key => key } },
    attachTo: document.body,
  });
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

describe('ChatInput attachment retry', () => {
  it('retains a failed upload and replaces the error with file metadata after retry', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce({ ok: false })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ files: [{ fileId: ' file-1 ' }] }),
      });
    const wrapper = mountInput();
    const file = new File(['hello'], 'notes.txt', { type: 'text/plain' });

    await wrapper.vm.handleFileSelect({ target: { files: [file], value: 'notes.txt' } });
    await Vue.nextTick();

    expect(wrapper.get('.attachment-item').classes()).toContain('has-error');
    expect(wrapper.get('.attachment-status').text()).toBe('chatInput.uploadFailed');
    expect(wrapper.get('.attachment-retry').text()).toBe('chatInput.retryUpload');
    expect(wrapper.get('.send-btn').attributes('disabled')).toBeDefined();

    await wrapper.get('.attachment-retry').trigger('click');
    await Vue.nextTick();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(wrapper.get('.attachment-item').classes()).not.toContain('has-error');
    expect(wrapper.get('.attachment-status').text()).toBe('5 B');
    expect(wrapper.find('.attachment-retry').exists()).toBe(false);
    expect(wrapper.get('.send-btn').attributes('disabled')).toBeUndefined();
    wrapper.unmount();
  });

  it.each([
    ['an object', {}],
    ['an empty string', '   '],
  ])('keeps the attachment retryable when the server returns %s fileId', async (_label, fileId) => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ files: [{ fileId }] }),
    });
    const wrapper = mountInput();
    const file = new File(['hello'], 'notes.txt', { type: 'text/plain' });

    await wrapper.vm.handleFileSelect({ target: { files: [file], value: 'notes.txt' } });
    await Vue.nextTick();

    expect(wrapper.get('.attachment-item').classes()).toContain('has-error');
    expect(wrapper.get('.attachment-status').text()).toBe('chatInput.uploadFailed');
    expect(wrapper.get('.attachment-retry').exists()).toBe(true);
    expect(wrapper.get('.send-btn').attributes('disabled')).toBeDefined();
    wrapper.unmount();
  });
});
