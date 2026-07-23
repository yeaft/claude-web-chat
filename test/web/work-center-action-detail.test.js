// @vitest-environment happy-dom
import { mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
      mocks: {
        $t: (key, values = {}) => key === 'workCenter.openAttachmentNamed'
          ? `Open attachment ${values.name}`
          : key,
      },
    },
  });
}

describe('Work Center Action detail tabs', () => {
  afterEach(() => {
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  it('resets the composer height when a send or Action switch clears its text', async () => {
    const wrapper = mountDetail({ composerText: 'line one\nline two' });
    const input = wrapper.get('textarea');
    Object.defineProperty(input.element, 'scrollHeight', { configurable: true, value: 240 });

    await input.trigger('input');
    expect(input.element.style.height).toBe('120px');

    await wrapper.setProps({ composerText: '' });
    await wrapper.vm.$nextTick();
    expect(input.element.style.height).toBe('auto');

    await wrapper.setProps({ composerText: 'another long draft' });
    await input.trigger('input');
    expect(input.element.style.height).toBe('120px');

    await wrapper.setProps({
      action: { id: 'action-2', type: 'review', status: 'running', executionStats: {}, messages: [] },
      selected: { id: 'wi-1', status: 'running', currentActionId: 'action-2' },
      composerText: '',
    });
    await wrapper.vm.$nextTick();
    expect(wrapper.get('textarea').element.style.height).toBe('auto');
  });

  it('gives the attachment input a localized accessible name', () => {
    const wrapper = mountDetail({ attachmentsSupported: true });
    const input = wrapper.get('.work-center-attachment-picker input[type="file"]');

    expect(input.attributes('aria-label')).toBe('Add files');
    expect(wrapper.get('.work-center-attachment-picker svg').attributes('aria-hidden')).toBe('true');
  });

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

  it('unwraps the request detail envelope returned by the service', async () => {
    const request = { id: 'request-1', runId: 'run-1', model: 'model-1' };
    const wrapper = mountDetail({
      requests: [request],
      requestDetails: {
        'run-1:request-1': {
          actionId: 'action-1',
          request: { id: 'request-1', runId: 'run-1', loops: [{ id: 'loop-1', loopNumber: 1, response: 'visible response' }] },
        },
      },
    });

    await wrapper.get('#work-center-action-requests-tab').trigger('click');
    await wrapper.get('.work-center-request-summary').trigger('click');

    expect(wrapper.findAll('.work-center-request-loop')).toHaveLength(1);
    expect(wrapper.get('.work-center-request-loop').text()).toContain('Loop 1');
  });

  it('shows an explicit empty state when retained request details contain no loops', async () => {
    const request = { id: 'request-1', runId: 'run-1', model: 'model-1' };
    const wrapper = mountDetail({
      requests: [request],
      requestDetails: {
        'run-1:request-1': { request: { id: 'request-1', runId: 'run-1', loops: [] } },
      },
    });

    await wrapper.get('#work-center-action-requests-tab').trigger('click');
    await wrapper.get('.work-center-request-summary').trigger('click');

    expect(wrapper.get('.work-center-request-detail').text()).toContain('This request has no retained loop details.');
  });

  it('opens persisted message attachments with an accessible, loading-aware button', async () => {
    const attachment = { id: 'file-1', name: 'report.pdf', size: 2048, isImage: false };
    const wrapper = mountDetail({
      messages: [{ id: 'message-1', role: 'user', text: 'See report', attachments: [attachment] }],
    });

    const button = wrapper.get('.work-center-attachment-preview');
    expect(button.attributes('aria-label')).toBe('Open attachment report.pdf');
    expect(button.text()).toContain('2.0 KB');
    await button.trigger('click');
    expect(wrapper.emitted('open-attachment')).toEqual([[attachment]]);

    await wrapper.setProps({ previewingAttachmentId: attachment.id });
    expect(button.attributes()).toHaveProperty('disabled');
    expect(button.text()).toContain('Opening attachment');
  });

  it('renders one transcript-level attachment error instead of repeating it per message', () => {
    const wrapper = mountDetail({
      messages: [
        { id: 'message-1', role: 'user', attachments: [{ id: 'file-1', name: 'one.txt', size: 1 }] },
        { id: 'message-2', role: 'assistant', attachments: [{ id: 'file-2', name: 'two.txt', size: 2 }] },
      ],
      attachmentError: 'Could not open the attachment.',
    });

    expect(wrapper.findAll('[role="alert"]')).toHaveLength(1);
    expect(wrapper.get('[role="alert"]').text()).toBe('Could not open the attachment.');
  });

  it('keeps attachment preview completion scoped to the selected Work Item', async () => {
    let resolvePreview;
    const preview = new Promise(resolve => { resolvePreview = resolve; });
    const context = {
      selected: { id: 'wi-1' },
      agentId: 'agent-1',
      previewingAttachmentId: null,
      attachmentPreviewError: '',
      store: { previewWorkItemAttachment: vi.fn(() => preview) },
      tr: (_key, fallback) => fallback,
      selectedId: 'wi-1',
      selectedActionId: 'action-1',
      narrowPane: 'action',
      resetActionComposer: vi.fn(),
      resetWorkItemComposer: vi.fn(),
      expandedActions: {},
      actionsExpanded: false,
      detailError: '',
      detailLoading: false,
    };
    const opened = { opener: {}, location: { replace: vi.fn() }, close: vi.fn() };
    vi.spyOn(window, 'open').mockReturnValue(opened);

    const pending = WorkCenterPage.methods.previewAttachment.call(context, {
      id: 'file-1', name: 'report.pdf', isImage: false,
    });
    context.selected = { id: 'wi-2' };
    WorkCenterPage.methods.openWorkItem.call(context, 'wi-2');
    resolvePreview({ preview: '/download-token', attachment: { isImage: false } });
    await pending;

    expect(opened.close).toHaveBeenCalledOnce();
    expect(opened.location.replace).not.toHaveBeenCalled();
    expect(context.previewingAttachmentId).toBeNull();
    expect(context.attachmentPreviewError).toBe('');
  });

  it('reports blocked attachment windows without starting a preview request', async () => {
    const context = {
      selected: { id: 'wi-1' },
      agentId: 'agent-1',
      previewingAttachmentId: null,
      attachmentPreviewError: '',
      store: { previewWorkItemAttachment: vi.fn() },
      tr: (_key, fallback) => fallback,
    };
    vi.spyOn(window, 'open').mockReturnValue(null);

    await WorkCenterPage.methods.previewAttachment.call(context, {
      id: 'file-1', name: 'report.pdf', isImage: false,
    });

    expect(context.store.previewWorkItemAttachment).not.toHaveBeenCalled();
    expect(context.attachmentPreviewError).toContain('blocked');
    expect(context.previewingAttachmentId).toBeNull();
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
