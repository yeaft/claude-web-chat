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

    expect(wrapper.findAll('select option').map(option => option.text())).toEqual([
      'yeaft.outline.allSenders', 'You', 'Linus',
    ]);
    expect(wrapper.findAll('[role="option"]')).toHaveLength(1);
    expect(wrapper.get('[role="option"]').text()).toContain('filtered');
    expect(wrapper.get('[role="option"]').text()).not.toContain('outline');

    await wrapper.get('select').setValue('user');
    expect(wrapper.emitted('sender')?.at(-1)).toEqual(['user']);
    wrapper.unmount();
  });
});
