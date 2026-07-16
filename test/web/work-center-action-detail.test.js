// @vitest-environment happy-dom
import { mount } from '@vue/test-utils';
import { afterEach, describe, expect, it } from 'vitest';
import WorkCenterActionDetail from '../../web/components/WorkCenterActionDetail.js';
import WorkCenterPage from '../../web/components/WorkCenterPage.js';

function mountDetail(props = {}) {
  return mount(WorkCenterActionDetail, {
    attachTo: document.body,
    props: {
      action: {
        id: 'action-1', type: 'implement', status: 'running',
        executionStats: {}, messages: [],
      },
      selected: { id: 'wi-1', status: 'running', currentActionId: 'action-1' },
      messages: [],
      ...props,
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

  it('preserves the selected tab, request, and loop across same-Action progress updates', async () => {
    const request = { id: 'shared', runId: 'run-1', model: 'model-1' };
    const wrapper = mountDetail({
      requests: [request],
      requestDetails: {
        'run-1:shared': { loops: [{ id: 'loop-1', loopNumber: 1, response: 'first' }] },
      },
    });

    await wrapper.get('#work-center-action-requests-tab').trigger('click');
    await wrapper.get('.work-center-request-summary').trigger('click');
    await wrapper.get('.work-center-request-loop > button').trigger('click');
    expect(wrapper.vm.activeTab).toBe('requests');
    expect(wrapper.vm.expandedRequestKey).toBe('run-1:shared');
    expect(wrapper.vm.expandedLoops['run-1:shared:loop-1']).toBe(true);

    await wrapper.setProps({
      action: {
        id: 'action-1', type: 'implement', status: 'running', progressRevision: 2,
        executionStats: { loopCount: 2 }, messages: [],
      },
    });

    expect(wrapper.vm.activeTab).toBe('requests');
    expect(wrapper.vm.expandedRequestKey).toBe('run-1:shared');
    expect(wrapper.vm.expandedLoops['run-1:shared:loop-1']).toBe(true);
    expect(wrapper.get('.work-center-request-loop-body').text()).toContain('first');

    await wrapper.setProps({
      action: { id: 'action-2', type: 'review', status: 'ready', executionStats: {}, messages: [] },
    });
    expect(wrapper.vm.activeTab).toBe('messages');
    expect(wrapper.vm.expandedRequestKey).toBeNull();
    expect(wrapper.vm.expandedLoops).toEqual({});
  });

  it('isolates cards, details, and loop expansion for duplicate request IDs across runs', async () => {
    const requests = [
      { id: 'shared', runId: 'run-1', model: 'model-1' },
      { id: 'shared', runId: 'run-2', model: 'model-2' },
    ];
    const wrapper = mountDetail({
      requests,
      requestDetails: {
        'run-1:shared': { loops: [{ id: 'loop-1', loopNumber: 1, response: 'run one' }] },
        'run-2:shared': { loops: [{ id: 'loop-1', loopNumber: 1, response: 'run two' }] },
      },
      requestDetailsError: { 'run-1:shared': 'run one error' },
      requestDetailsLoading: { 'run-2:shared': true },
    });

    await wrapper.get('#work-center-action-requests-tab').trigger('click');
    const summaries = wrapper.findAll('.work-center-request-summary');
    await summaries[0].trigger('click');
    expect(wrapper.findAll('.work-center-request-card.expanded')).toHaveLength(1);
    expect(wrapper.get('.work-center-request-card.expanded').text()).toContain('run one error');
    expect(wrapper.get('.work-center-request-card.expanded').text()).not.toContain('workCenter.loadingRequestDetail');

    await summaries[1].trigger('click');
    expect(wrapper.findAll('.work-center-request-card.expanded')).toHaveLength(1);
    expect(wrapper.get('.work-center-request-card.expanded').text()).toContain('Loading request detail');
    expect(wrapper.get('.work-center-request-card.expanded').text()).not.toContain('run one error');

    await wrapper.setProps({ requestDetailsLoading: {} });
    await wrapper.get('.work-center-request-loop > button').trigger('click');
    expect(wrapper.vm.expandedLoops['run-2:shared:loop-1']).toBe(true);
    expect(wrapper.vm.expandedLoops['run-1:shared:loop-1']).toBeUndefined();
    expect(wrapper.get('.work-center-request-loop-body').text()).toContain('run two');
  });

  it('projects page request caches with the same run-scoped identity as the detail pane', () => {
    const context = {
      actionRequestKey: 'agent-1:wi-1:action-1',
      actionRequests: [
        { id: 'shared', runId: 'run-1' },
        { id: 'shared', runId: 'run-2' },
      ],
      store: {
        workCenterActionRequestDetails: {
          'agent-1:wi-1:action-1:run-1:shared': { response: 'run one' },
          'agent-1:wi-1:action-1:run-2:shared': { response: 'run two' },
        },
        workCenterActionRequestDetailsLoading: {
          'agent-1:wi-1:action-1:run-1:shared': true,
        },
        workCenterActionRequestDetailsError: {
          'agent-1:wi-1:action-1:run-2:shared': 'run two error',
        },
      },
    };

    expect(WorkCenterPage.computed.actionRequestDetails.call(context)).toEqual({
      'run-1:shared': { response: 'run one' },
      'run-2:shared': { response: 'run two' },
    });
    expect(WorkCenterPage.computed.actionRequestDetailsLoading.call(context)).toEqual({
      'run-1:shared': true,
      'run-2:shared': false,
    });
    expect(WorkCenterPage.computed.actionRequestDetailsError.call(context)).toEqual({
      'run-1:shared': '',
      'run-2:shared': 'run two error',
    });
  });
});
