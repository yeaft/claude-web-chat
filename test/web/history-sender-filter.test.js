// @vitest-environment happy-dom
import * as Vue from 'vue';
import { mount } from '@vue/test-utils';
import { beforeAll, describe, expect, it } from 'vitest';
import { shouldDismissHistorySearch } from '../../web/utils/message-search-navigation.js';

let YeaftConversationOutline;

beforeAll(async () => {
  globalThis.Vue = Vue;
  ({ default: YeaftConversationOutline } = await import('../../web/components/YeaftConversationOutline.js'));
});

describe('Yeaft message history sender filter', () => {
  it('renders the sender menu outside the clipped outline and exposes keyboard navigation', async () => {
    const wrapper = mount(YeaftConversationOutline, {
      props: {
        outlineState: { results: [{ messageId: 'm1', role: 'user', snippet: 'outline' }], loading: false, hasMore: false, totalCount: 1 },
        searchState: { query: '', senderKey: 'vp:linus', results: [{ messageId: 'm2', role: 'assistant', speakerVpId: 'linus', snippet: 'filtered' }], loading: false, hasMore: false, error: null },
        senderOptions: [{ key: 'user', label: 'You' }, { key: 'vp:linus', label: 'Linus' }],
        activeMessageId: 'm2',
      },
      global: { mocks: { $t: key => key } },
      attachTo: document.body,
    });
    const originalScrollHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollHeight');
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', { configurable: true, get: () => 220 });

    expect(wrapper.find('.yeaft-conversation-outline-toolbar > .yeaft-conversation-outline-search').exists()).toBe(true);
    expect(wrapper.find('.yeaft-conversation-outline-toolbar > .yeaft-conversation-outline-sender').exists()).toBe(true);
    expect(wrapper.find('select').exists()).toBe(false);
    const senderTrigger = wrapper.get('.yeaft-conversation-outline-sender .modern-select-trigger');
    expect(senderTrigger.attributes()).toMatchObject({
      role: 'combobox',
      'aria-label': 'yeaft.outline.sender',
      'aria-haspopup': 'listbox',
      'aria-expanded': 'false',
    });
    expect(senderTrigger.text()).toContain('Linus');
    expect(wrapper.findAll('[role="option"]')).toHaveLength(1);
    expect(wrapper.get('[role="option"]').text()).toContain('filtered');
    expect(wrapper.get('[role="option"]').text()).not.toContain('outline');

    await wrapper.setProps({
      searchState: {
        query: '中', senderKey: '',
        results: [{ messageId: 'm3', role: 'user', snippet: 'single CJK' }],
        loading: false, hasMore: false, error: null,
      },
    });
    expect(wrapper.get('[role="option"]').text()).toContain('single CJK');
    expect(wrapper.text()).not.toContain('yeaft.outline.minChars');
    await wrapper.setProps({
      searchState: {
        query: '😀', senderKey: '',
        results: [{ messageId: 'm4', role: 'user', snippet: 'single emoji' }],
        loading: false, hasMore: false, error: null,
      },
    });
    expect(wrapper.get('[role="option"]').text()).toContain('single emoji');
    await wrapper.setProps({
      searchState: {
        query: '', senderKey: 'vp:linus',
        results: [{ messageId: 'm2', role: 'assistant', speakerVpId: 'linus', snippet: 'filtered' }],
        loading: false, hasMore: false, error: null,
      },
    });

    Object.defineProperty(document.documentElement, 'clientWidth', { configurable: true, value: 400 });
    Object.defineProperty(document.documentElement, 'clientHeight', { configurable: true, value: 180 });
    senderTrigger.element.getBoundingClientRect = () => ({
      top: 120, right: 380, bottom: 160, left: 260, width: 120, height: 40,
    });
    await senderTrigger.trigger('click');
    await Vue.nextTick();
    expect(senderTrigger.attributes('aria-expanded')).toBe('true');
    const menu = document.querySelector('.yeaft-conversation-outline-sender-menu');
    expect(menu).not.toBeNull();
    expect(document.body.contains(menu)).toBe(true);
    expect(wrapper.element.contains(menu)).toBe(false);
    expect(menu.style.top).toBe('8px');
    expect(menu.style.maxHeight).toBe('106px');
    expect([...menu.querySelectorAll('.modern-select-option')].map(option => option.textContent.trim())).toEqual([
      'yeaft.outline.allSenders', 'You', 'Linus',
    ]);
    expect(menu.querySelector('.modern-select-option.is-selected').getAttribute('aria-selected')).toBe('true');
    expect(shouldDismissHistorySearch(menu.querySelector('.modern-select-option'))).toBe(false);
    expect(senderTrigger.attributes('aria-controls')).toBe(menu.id);
    expect(senderTrigger.attributes('aria-activedescendant')).toBe(menu.querySelectorAll('.modern-select-option')[2].id);

    await senderTrigger.trigger('keydown', { key: 'ArrowUp' });
    const userOption = menu.querySelectorAll('.modern-select-option')[1];
    expect(senderTrigger.attributes('aria-activedescendant')).toBe(userOption.id);
    await senderTrigger.trigger('keydown', { key: 'Enter' });
    expect(wrapper.emitted('sender')?.at(-1)).toEqual(['user']);
    expect(document.querySelector('.yeaft-conversation-outline-sender-menu')).toBeNull();

    senderTrigger.element.focus();
    await senderTrigger.trigger('keydown', { key: 'ArrowDown' });
    expect(document.querySelector('.yeaft-conversation-outline-sender-menu')).not.toBeNull();
    await senderTrigger.trigger('keydown', { key: 'Escape' });
    expect(document.querySelector('.yeaft-conversation-outline-sender-menu')).toBeNull();
    expect(document.activeElement).toBe(senderTrigger.element);

    await senderTrigger.trigger('click');
    document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    await Vue.nextTick();
    expect(document.querySelector('.yeaft-conversation-outline-sender-menu')).toBeNull();

    await wrapper.setProps({ senderOptions: [{ key: 'user', label: 'You' }] });
    expect(wrapper.emitted('sender-invalid')).toEqual([[]]);

    wrapper.unmount();
    if (originalScrollHeight) Object.defineProperty(HTMLElement.prototype, 'scrollHeight', originalScrollHeight);
  });
});
