// @vitest-environment happy-dom
import * as Vue from 'vue';
import { mount } from '@vue/test-utils';
import { beforeAll, describe, expect, it } from 'vitest';

let YeaftConversationOutline;

beforeAll(async () => {
  globalThis.Vue = Vue;
  ({ default: YeaftConversationOutline } = await import('../../web/components/YeaftConversationOutline.js'));
});

describe('Yeaft user-message history search', () => {
  it('renders only the user-message locator without a sender selector', async () => {
    const wrapper = mount(YeaftConversationOutline, {
      props: {
        outlineState: { results: [], loading: false, hasMore: false, totalCount: null },
        searchState: {
          query: '', senderKey: 'user',
          results: [{ messageId: 'm1', role: 'user', snippet: 'find this prompt' }],
          loading: false, hasMore: false, error: null,
        },
        activeMessageId: 'm1',
      },
      global: { mocks: { $t: key => key } },
      attachTo: document.body,
    });

    expect(wrapper.find('.yeaft-conversation-outline-search').exists()).toBe(true);
    expect(wrapper.find('.yeaft-conversation-outline-sender').exists()).toBe(false);
    expect(wrapper.find('select').exists()).toBe(false);
    expect(wrapper.get('[role="option"]').text()).toContain('find this prompt');

    await wrapper.get('input[type="search"]').setValue('next prompt');
    expect(wrapper.emitted('query')?.at(-1)).toEqual(['next prompt']);
    wrapper.unmount();
  });
});
