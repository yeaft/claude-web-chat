// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';

const authStore = {
  getActiveToken: vi.fn(() => null),
  handleAuthFailure: vi.fn(),
};
globalThis.Pinia = {
  defineStore: (_id, options) => () => ({
    ...(options.state ? options.state() : {}),
    ...(options.actions || {}),
  }),
  useAuthStore: () => authStore,
  useChatStore: () => ({}),
};
globalThis.window.Pinia = globalThis.Pinia;

const { default: WorkCenterPage } = await import('../../web/components/WorkCenterPage.js');
const { default: WorkCenterActionDetail } = await import('../../web/components/WorkCenterActionDetail.js');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function makeContext() {
  const context = {
    agentId: 'agent-1',
    selectedId: 'wi-1',
    selectedActionId: 'action-1',
    actionComposerGeneration: 1,
    actionGuidance: 'old draft',
    actionInputError: '',
    actionInputSending: false,
    guidanceAttachmentsUploading: false,
    guidanceAttachments: [{ fileId: 'old-file', name: 'old.txt', mimeType: 'text/plain', size: 3 }],
    selected: {
      id: 'wi-1', revision: 2, status: 'running', currentActionId: 'action-1',
      attachments: [], actions: [{ id: 'action-1' }, { id: 'action-2' }],
    },
    selectedAction: { id: 'action-1', status: 'running', generation: 3 },
    store: { sendWorkItemActionInput: vi.fn() },
    workItemAttachmentsSupported: true,
    tr: (_key, fallback) => fallback,
    resetActionComposer: WorkCenterPage.methods.resetActionComposer,
  };
  Object.defineProperty(context, 'actionComposerScope', {
    get() {
      return `${this.agentId}:${this.selected.id}:${this.selectedAction.id}:${this.actionComposerGeneration}`;
    },
  });
  return context;
}

describe('Work Center Action composer scope', () => {
  it('loads the latest public message page when an Action is selected', async () => {
    const loadWorkItemActionMessages = vi.fn().mockResolvedValue({ messages: [] });
    const context = {
      selectedActionId: 'action-1',
      selected: { id: 'wi-1' },
      agentId: 'agent-1',
      narrowPane: 'actions',
      store: { workCenterActionMessages: {}, loadWorkItemActionMessages },
      resetActionComposer: vi.fn(),
      loadLatestActionMessages: WorkCenterPage.methods.loadLatestActionMessages,
    };

    WorkCenterPage.methods.selectAction.call(context, { id: 'action-2' });
    await Promise.resolve();

    expect(context.selectedActionId).toBe('action-2');
    expect(context.narrowPane).toBe('action');
    expect(loadWorkItemActionMessages).toHaveBeenCalledWith('wi-1', 'action-2', null, 'agent-1');
  });

  it('does not refetch a cached Action message page', () => {
    const loadWorkItemActionMessages = vi.fn();
    const context = {
      selected: { id: 'wi-1' },
      agentId: 'agent-1',
      store: {
        workCenterActionMessages: { 'agent-1:wi-1:action-1': { messages: [] } },
        loadWorkItemActionMessages,
      },
    };

    const result = WorkCenterPage.methods.loadLatestActionMessages.call(context, { id: 'action-1' });

    expect(result).toBeNull();
    expect(loadWorkItemActionMessages).not.toHaveBeenCalled();
  });

  it('uses the embedded current Action messages without issuing another request', () => {
    const loadWorkItemActionMessages = vi.fn();
    const context = {
      selected: { id: 'wi-1' },
      agentId: 'agent-1',
      store: { workCenterActionMessages: {}, loadWorkItemActionMessages },
    };

    const result = WorkCenterPage.methods.loadLatestActionMessages.call(context, {
      id: 'action-1', messages: [{ id: 'run:current', text: 'live' }],
    });

    expect(result).toBeNull();
    expect(loadWorkItemActionMessages).not.toHaveBeenCalled();
  });

  it('shows a scoped composer for every unfinished Action and retry only for failed Actions', () => {
    const canCompose = WorkCenterActionDetail.computed.canCompose;
    const canRetry = WorkCenterActionDetail.computed.canRetry;
    for (const status of ['ready', 'running', 'waiting', 'failed']) {
      expect(canCompose.call({
        selected: { status: 'running', currentActionId: 'action-2' },
        action: { id: 'action-1', status },
      })).toBe(true);
    }
    expect(canCompose.call({ selected: { status: 'running' }, action: { status: 'completed' } })).toBe(false);
    expect(canRetry.call({ action: { status: 'failed' }, uploading: false, sending: false })).toBe(true);
    expect(canRetry.call({ action: { status: 'running' }, uploading: false, sending: false })).toBe(false);
  });

  it('matches the Session composer behavior for Enter, Shift+Enter, and disabled sends', () => {
    const emits = [];
    const context = { canSend: true, $emit: event => emits.push(event) };
    const enter = { key: 'Enter', shiftKey: false, isComposing: false, preventDefault: vi.fn() };

    WorkCenterActionDetail.methods.onComposerKeydown.call(context, enter);

    expect(enter.preventDefault).toHaveBeenCalledOnce();
    expect(emits).toEqual(['send']);

    const shiftEnter = { key: 'Enter', shiftKey: true, isComposing: false, preventDefault: vi.fn() };
    WorkCenterActionDetail.methods.onComposerKeydown.call(context, shiftEnter);
    expect(shiftEnter.preventDefault).not.toHaveBeenCalled();

    context.canSend = false;
    WorkCenterActionDetail.methods.onComposerKeydown.call(context, enter);
    expect(emits).toEqual(['send']);
  });

  it('auto-sizes composer input without exceeding the Session input height', () => {
    const emits = [];
    const target = { value: 'new context', scrollHeight: 240, style: { height: '40px' } };

    WorkCenterActionDetail.methods.onComposerInput.call({
      $emit: (...args) => emits.push(args),
      resizeComposerInput: WorkCenterActionDetail.methods.resizeComposerInput,
    }, { target });

    expect(emits).toEqual([['update:composerText', 'new context']]);
    expect(target.style.height).toBe('120px');
  });

  it('sends WorkItem-level messages through the separate revision-fenced operation', async () => {
    const sendWorkItemMessage = vi.fn().mockResolvedValue({ id: 'wi-1', revision: 3 });
    const context = {
      selected: { id: 'wi-1', revision: 2 },
      workItemMessage: 'Apply this everywhere',
      workItemMessageSending: false,
      workItemMessageError: '',
      agentId: 'agent-1',
      store: { sendWorkItemMessage },
    };

    await WorkCenterPage.methods.sendSelectedWorkItemMessage.call(context);

    expect(sendWorkItemMessage).toHaveBeenCalledWith('wi-1', 'Apply this everywhere', 2, 'agent-1');
    expect(context.workItemMessage).toBe('');
    expect(context.workItemMessageError).toBe('');
  });

  it('retries the visible failed Action with its stable identity and revision', async () => {
    const retryWorkItemAction = vi.fn().mockResolvedValue({ id: 'wi-1', revision: 3 });
    const context = {
      selected: { id: 'wi-1', revision: 2 },
      selectedAction: { id: 'action-1', status: 'failed', generation: 4 },
      actionInputSending: false,
      actionInputError: '',
      actionComposerScope: 'scope-1',
      agentId: 'agent-1',
      store: { retryWorkItemAction },
    };

    await WorkCenterPage.methods.retrySelectedAction.call(context);

    expect(retryWorkItemAction).toHaveBeenCalledWith('wi-1', 'action-1', 2, 4, 'agent-1');
    expect(context.actionInputError).toBe('');
    expect(context.actionInputSending).toBe(false);
  });

  it('submits the visible Action identity, revision, Agent, and attachments atomically', async () => {
    const context = makeContext();
    context.store.sendWorkItemActionInput.mockResolvedValue({ currentActionId: 'action-1' });

    await WorkCenterPage.methods.guideSelectedAction.call(context);

    expect(context.store.sendWorkItemActionInput).toHaveBeenCalledWith(
      'wi-1', 'old draft', 'action-1', 2, 3,
      [{ fileId: 'old-file', name: 'old.txt', mimeType: 'text/plain', size: 3 }],
      'agent-1',
    );
    expect(context.actionGuidance).toBe('');
    expect(context.guidanceAttachments).toEqual([]);
  });

  it('submits the selected blocked graph Action instead of a different current Action', async () => {
    const context = makeContext();
    context.selected.workflowSnapshot = { executionMode: 'graph' };
    context.selected.status = 'needs_attention';
    context.selected.currentActionId = 'action-2';
    context.selectedAction = { id: 'action-1', status: 'failed', generation: 3 };
    context.store.sendWorkItemActionInput.mockResolvedValue({ currentActionId: 'action-1' });

    await WorkCenterPage.methods.guideSelectedAction.call(context);

    expect(context.store.sendWorkItemActionInput).toHaveBeenCalledWith(
      'wi-1', 'old draft', 'action-1', 2, 3,
      [{ fileId: 'old-file', name: 'old.txt', mimeType: 'text/plain', size: 3 }],
      'agent-1',
    );
  });

  it('preserves blocked graph composer input when the send fails', async () => {
    const context = makeContext();
    context.selected.workflowSnapshot = { executionMode: 'graph' };
    context.selected.status = 'waiting';
    context.selected.currentActionId = 'action-2';
    context.selectedAction = { id: 'action-1', status: 'waiting' };
    context.store.sendWorkItemActionInput.mockRejectedValue(new Error('stale revision'));

    await WorkCenterPage.methods.guideSelectedAction.call(context);

    expect(context.actionGuidance).toBe('old draft');
    expect(context.guidanceAttachments).toHaveLength(1);
    expect(context.actionInputError).toBe('stale revision');
  });

  it('does not let an old send completion clear or redirect the new Action composer', async () => {
    const context = makeContext();
    const pending = deferred();
    context.store.sendWorkItemActionInput.mockReturnValue(pending.promise);

    const sending = WorkCenterPage.methods.guideSelectedAction.call(context);
    context.selectedActionId = 'action-2';
    context.selectedAction = { id: 'action-2' };
    context.selected.currentActionId = 'action-2';
    context.actionComposerGeneration += 1;
    context.actionGuidance = 'new draft';
    context.guidanceAttachments = [{ fileId: 'new-file', name: 'new.txt' }];
    context.actionInputSending = false;

    pending.resolve({ currentActionId: 'action-1' });
    await sending;

    expect(context.actionGuidance).toBe('new draft');
    expect(context.guidanceAttachments).toEqual([{ fileId: 'new-file', name: 'new.txt' }]);
    expect(context.selectedActionId).toBe('action-2');
    expect(context.actionInputSending).toBe(false);
  });

  it('does not append an old upload or error to a newly selected Action', async () => {
    const context = makeContext();
    const pending = deferred();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(() => pending.promise);
    const event = { target: { files: [new File(['old'], 'old.txt', { type: 'text/plain' })], value: 'selected' } };

    try {
      const uploading = WorkCenterPage.methods.onGuidanceAttachmentInput.call(context, event);
      context.selectedActionId = 'action-2';
      context.selectedAction = { id: 'action-2' };
      context.selected.currentActionId = 'action-2';
      context.actionComposerGeneration += 1;
      context.guidanceAttachments = [{ fileId: 'new-file', name: 'new.txt' }];
      context.actionInputError = 'new scope error';
      context.guidanceAttachmentsUploading = false;

      pending.resolve({ ok: true, status: 200, json: async () => ({ files: [{ fileId: 'old-upload', name: 'old.txt' }] }) });
      await uploading;

      expect(context.guidanceAttachments).toEqual([{ fileId: 'new-file', name: 'new.txt' }]);
      expect(context.actionInputError).toBe('new scope error');
      expect(context.guidanceAttachmentsUploading).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
