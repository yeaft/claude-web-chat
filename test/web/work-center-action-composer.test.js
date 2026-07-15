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
    selectedAction: { id: 'action-1' },
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
