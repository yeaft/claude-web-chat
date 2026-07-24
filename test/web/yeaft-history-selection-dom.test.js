// @vitest-environment happy-dom
import * as Vue from 'vue';
import { mount } from '@vue/test-utils';
import { beforeAll, describe, expect, it } from 'vitest';

let YeaftConversationOutline;

beforeAll(async () => {
  globalThis.Vue = Vue;
  ({ default: YeaftConversationOutline } = await import('../../web/components/YeaftConversationOutline.js'));
});

function mountOutline(results, activeMessageId) {
  return mount(YeaftConversationOutline, {
    props: {
      outlineState: { results, loading: false, hasMore: false, totalCount: results.length },
      searchState: { query: '', results: [], loading: false, hasMore: false, error: null },
      activeMessageId,
    },
    global: { mocks: { $t: key => key } },
  });
}

describe('Yeaft message history keyboard selection', () => {
  const m10 = { messageId: 'm10', seq: 10, timestamp: '2026-07-24T10:00:00Z', role: 'user', snippet: 'ten' };
  const m9 = { messageId: 'm9', seq: 9, timestamp: '2026-07-24T09:00:00Z', role: 'assistant', snippet: 'nine' };
  const m11 = { messageId: 'm11', seq: 11, timestamp: '2026-07-24T11:00:00Z', role: 'user', snippet: 'eleven' };

  it('keeps the same message active when a newer row is prepended', async () => {
    const wrapper = mountOutline([m10, m9], 'm9');
    expect(wrapper.findAll('[role="option"]')[1].classes()).toContain('active');

    await wrapper.setProps({
      outlineState: { results: [m10, m9, m11], loading: false, hasMore: false, totalCount: 3 },
    });

    const options = wrapper.findAll('[role="option"]');
    expect(options[2].classes()).toContain('active');
    expect(options[2].attributes('aria-selected')).toBe('true');
    await wrapper.get('input[type="search"]').trigger('keydown', { key: 'Enter' });
    expect(wrapper.emitted('select')?.at(-1)?.[0]).toEqual(m9);
    wrapper.unmount();
  });

  it('falls back to the first message identity only after the selected row disappears', async () => {
    const wrapper = mountOutline([m10, m9], 'm9');

    await wrapper.setProps({
      outlineState: { results: [m10], loading: false, hasMore: false, totalCount: 1 },
    });

    expect(wrapper.emitted('move')?.at(-1)).toEqual(['m10']);
    expect(wrapper.get('[role="option"]').classes()).toContain('active');
    wrapper.unmount();
  });
});
