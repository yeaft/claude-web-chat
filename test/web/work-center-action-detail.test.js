// @vitest-environment happy-dom
import { mount } from '@vue/test-utils';
import { afterEach, describe, expect, it } from 'vitest';
import WorkCenterActionDetail from '../../web/components/WorkCenterActionDetail.js';

function mountDetail() {
  return mount(WorkCenterActionDetail, {
    attachTo: document.body,
    props: {
      action: {
        id: 'action-1', type: 'implement', status: 'running',
        executionStats: {}, messages: [],
      },
      selected: { id: 'wi-1', status: 'running', currentActionId: 'action-1' },
      messages: [],
    },
    global: {
      mocks: { $t: key => key },
    },
  });
}

describe('Work Center Action detail tabs', () => {
  afterEach(() => document.body.replaceChildren());

  it('supports roving focus with arrow, Home, and End keys', async () => {
    const wrapper = mountDetail();
    const messages = wrapper.get('#work-center-action-messages-tab');
    const requests = wrapper.get('#work-center-action-requests-tab');

    await messages.trigger('keydown', { key: 'ArrowRight' });
    expect(wrapper.vm.activeTab).toBe('requests');
    expect(document.activeElement).toBe(requests.element);
    expect(requests.attributes('tabindex')).toBe('0');
    expect(messages.attributes('tabindex')).toBe('-1');

    await requests.trigger('keydown', { key: 'Home' });
    expect(wrapper.vm.activeTab).toBe('messages');
    expect(document.activeElement).toBe(messages.element);

    await messages.trigger('keydown', { key: 'End' });
    expect(wrapper.vm.activeTab).toBe('requests');
    expect(document.activeElement).toBe(requests.element);
  });
});
