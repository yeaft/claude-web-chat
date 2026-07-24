// @vitest-environment happy-dom
import * as Vue from 'vue';
import { mount } from '@vue/test-utils';
import { beforeAll, describe, expect, it } from 'vitest';

let YeaftConversationOutline;

beforeAll(async () => {
  globalThis.Vue = Vue;
  ({ default: YeaftConversationOutline } = await import('../../web/components/YeaftConversationOutline.js'));
});

describe('Yeaft message history sender filter', () => {
  it('renders only supplied roster options and filters without a text query', async () => {
    const wrapper = mount(YeaftConversationOutline, {
      props: {
        outlineState: { results: [{ messageId: 'm1', role: 'user', snippet: 'outline' }], loading: false, hasMore: false, totalCount: 1 },
        searchState: { query: '', senderKey: 'vp:linus', results: [{ messageId: 'm2', role: 'assistant', speakerVpId: 'linus', snippet: 'filtered' }], loading: false, hasMore: false, error: null },
        senderOptions: [{ key: 'user', label: 'You' }, { key: 'vp:linus', label: 'Linus' }],
        activeMessageId: 'm2',
      },
      global: { mocks: { $t: key => key } },
    });

    expect(wrapper.find('.yeaft-conversation-outline-toolbar > .yeaft-conversation-outline-search').exists()).toBe(true);
    expect(wrapper.find('.yeaft-conversation-outline-toolbar > .yeaft-conversation-outline-sender').exists()).toBe(true);
    expect(wrapper.find('select').exists()).toBe(false);
    const senderTrigger = wrapper.get('.yeaft-conversation-outline-sender .modern-select-trigger');
    expect(senderTrigger.attributes()).toMatchObject({
      'aria-label': 'yeaft.outline.sender',
      'aria-haspopup': 'listbox',
      'aria-expanded': 'false',
    });
    expect(senderTrigger.text()).toContain('Linus');
    expect(wrapper.findAll('[role="option"]')).toHaveLength(1);
    expect(wrapper.get('[role="option"]').text()).toContain('filtered');
    expect(wrapper.get('[role="option"]').text()).not.toContain('outline');

    await senderTrigger.trigger('click');
    expect(senderTrigger.attributes('aria-expanded')).toBe('true');
    expect(wrapper.findAll('.modern-select-option').map(option => option.text())).toEqual([
      'yeaft.outline.allSenders', 'You', 'Linus',
    ]);
    expect(wrapper.find('.modern-select-option.is-selected').attributes('aria-selected')).toBe('true');
    await wrapper.findAll('.modern-select-option')[1].trigger('click');
    expect(wrapper.emitted('sender')?.at(-1)).toEqual(['user']);
    expect(wrapper.find('.modern-select-menu').exists()).toBe(false);

    await senderTrigger.trigger('keydown', { key: 'ArrowDown' });
    expect(wrapper.find('.modern-select-menu').exists()).toBe(true);
    await senderTrigger.trigger('keydown', { key: 'Escape' });
    expect(wrapper.find('.modern-select-menu').exists()).toBe(false);

    await senderTrigger.trigger('click');
    document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    await Vue.nextTick();
    expect(wrapper.find('.modern-select-menu').exists()).toBe(false);

    await wrapper.setProps({ senderOptions: [{ key: 'user', label: 'You' }] });
    expect(wrapper.emitted('sender-invalid')).toEqual([[]]);

    wrapper.unmount();
  });
});
