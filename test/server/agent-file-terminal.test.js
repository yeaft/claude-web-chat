import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as Vue from 'vue';
import { createWsHandler } from '../../web/components/files/wsHandler.js';
import { createFileTabs } from '../../web/components/files/fileTabs.js';
import ctx from '../../agent/context.js';
import { handleWriteFile } from '../../agent/workbench/file-ops.js';

const forwardToClients = vi.fn(async () => {});
const sendToWebClient = vi.fn(async () => {});
const previewFiles = new Map();
const webClients = new Map();

vi.mock('../../server/context.js', () => ({
  previewFiles,
  webClients,
}));

vi.mock('../../server/ws-utils.js', () => ({
  sendToWebClient,
  forwardToClients,
  setCachedDir: vi.fn(),
  invalidateParentDirCache: vi.fn(),
  clearAgentDirCache: vi.fn(),
}));

const { handleAgentFileTerminal } = await import('../../server/handlers/agent-file-terminal.js');

describe('Agent file terminal forwarding', () => {
  beforeEach(() => {
    forwardToClients.mockClear();
    sendToWebClient.mockClear();
    previewFiles.clear();
    webClients.clear();
  });

  it('routes an open event with its frozen Agent and conversation identity', () => {
    globalThis.Vue = Vue;
    const openFileInTab = vi.fn();
    const handler = createWsHandler({
      store: { currentConversation: 'new-conversation', currentAgent: 'agent-b' },
      normalizePath: value => value,
      getEffectiveWorkDir: () => '/workspace',
      openFiles: Vue.ref([]),
      activeFileIndex: Vue.ref(-1),
      activeFile: Vue.ref(null),
      fileLoading: Vue.ref(false),
      fileSaving: Vue.ref(false),
      saveTabsState: vi.fn(),
      createEditor: vi.fn(),
      openFileInTab,
      tree: { handleDirectoryListing: vi.fn() },
      setTreeVisible: vi.fn(),
      fp: { handleFolderPickerListing: vi.fn() },
      qo: {},
      ops: { getPendingDownload: () => null, clearPendingDownload: vi.fn() },
      mdPreviewMode: Vue.ref(false),
      renderOfficeLocal: vi.fn(),
      editorContainer: Vue.ref(null),
      debugStatus: Vue.ref(''),
    }).handleOpenFile;

    handler(new CustomEvent('open-file-in-explorer', { detail: {
      filePath: 'docs/design.md',
      agentId: 'agent-a',
      conversationId: 'yeaft-agent-a',
      workDir: '/agent-a/project',
    } }));

    expect(openFileInTab).toHaveBeenCalledWith('docs/design.md', 'design.md', {
      agentId: 'agent-a',
      conversationId: 'yeaft-agent-a',
      workDir: '/agent-a/project',
    });
  });

  it('keeps writes bound to the tab owner after the active route drifts', () => {
    globalThis.Vue = Vue;
    const sent = [];
    const store = {
      currentAgent: 'agent-a',
      currentConversation: 'conversation-a',
      clientId: 'client-1',
      sendWsMessage: msg => sent.push(msg),
    };
    const tabs = createFileTabs(store, {
      normalizePath: value => value,
      getEffectiveWorkDir: () => '/agent-a/project',
      editorContainer: Vue.ref(null),
      createEditor: vi.fn(),
      destroyEditor: vi.fn(),
      clearFindMarkers: vi.fn(),
      saveCurrentUndoHistory: vi.fn(),
      saveAllUndoHistory: vi.fn(),
      cleanupUndoHistory: vi.fn(),
      deleteConversationHistory: vi.fn(),
      debugStatus: Vue.ref(''),
      mdPreviewMode: Vue.ref(false),
      renderOfficeLocal: vi.fn(),
      performFind: vi.fn(),
      findBarVisible: Vue.ref(false),
      findQuery: Vue.ref(''),
      t: value => value,
    });

    tabs.openFileInTab('docs/design.md', 'design.md', {
      agentId: 'agent-a',
      conversationId: 'conversation-a',
      workDir: '/agent-a/project',
    });
    tabs.activeFile.value.content = 'updated';
    tabs.activeFile.value.isDirty = true;
    store.currentAgent = 'agent-b';
    store.currentConversation = 'conversation-b';
    tabs.saveFile();

    const writeRequest = sent.find(msg => msg.type === 'write_file');
    expect(writeRequest).toMatchObject({
      agentId: 'agent-a',
      conversationId: 'conversation-a',
      workDir: '/agent-a/project',
      filePath: 'docs/design.md',
      content: 'updated',
    });
    expect(writeRequest.requestId).toMatch(/^file-save-/);

    const ownerTab = tabs.activeFile.value;
    const wrongOwnerTab = {
      path: 'docs/design.md',
      name: 'design.md',
      agentId: 'agent-b',
      conversationId: 'conversation-b',
      content: 'other unsaved content',
      originalContent: 'other original',
      isDirty: true,
      pendingSaveRequestId: 'save-b',
    };
    tabs.openFiles.value.unshift(wrongOwnerTab);
    const saveTabsState = vi.fn();
    const handle = createWsHandler({
      store,
      normalizePath: value => value,
      getEffectiveWorkDir: () => '/agent-b/project',
      openFiles: tabs.openFiles,
      activeFileIndex: tabs.activeFileIndex,
      activeFile: tabs.activeFile,
      fileLoading: tabs.fileLoading,
      fileSaving: tabs.fileSaving,
      saveTabsState,
      createEditor: vi.fn(),
      openFileInTab: tabs.openFileInTab,
      tree: { handleDirectoryListing: vi.fn() },
      setTreeVisible: vi.fn(),
      fp: { handleFolderPickerListing: vi.fn() },
      qo: {},
      ops: { getPendingDownload: () => null, clearPendingDownload: vi.fn() },
      mdPreviewMode: Vue.ref(false),
      renderOfficeLocal: vi.fn(),
      editorContainer: Vue.ref(null),
      debugStatus: Vue.ref(''),
    }).handleWorkbenchMessage;

    const ack = detail => handle(new CustomEvent('workbench-message', {
      detail: { type: 'file_saved', requestedFilePath: 'docs/design.md', success: true, ...detail },
    }));
    ack({ agentId: 'agent-b', conversationId: 'conversation-a', requestId: writeRequest.requestId });
    ack({ agentId: 'agent-a', conversationId: 'conversation-a', requestId: 'stale-save' });
    expect(ownerTab.isDirty).toBe(true);
    expect(wrongOwnerTab.isDirty).toBe(true);

    ownerTab.content = 'edited while save was in flight';
    ack({ agentId: 'agent-a', conversationId: 'conversation-a', requestId: writeRequest.requestId });
    expect(ownerTab.originalContent).toBe('updated');
    expect(ownerTab.isDirty).toBe(true);
    expect(wrongOwnerTab.isDirty).toBe(true);
    expect(saveTabsState).toHaveBeenLastCalledWith('conversation-a');

    // Rolling upgrade: old Agents omit requestId, but the Server still adds
    // agentId and the legacy payload carries conversationId.
    ownerTab.content = 'updated again';
    ownerTab.isDirty = true;
    ownerTab.pendingSaveRequestId = 'new-client-request';
    ownerTab.pendingSaveContent = 'updated again';
    ack({ agentId: 'agent-a', conversationId: 'conversation-a' });
    expect(ownerTab.isDirty).toBe(false);
    expect(wrongOwnerTab.isDirty).toBe(true);
  });

  it('preserves save correlation metadata through the Agent write handler', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'yeaft-file-save-'));
    const sent = [];
    const previousConfig = ctx.CONFIG;
    const previousSend = ctx.sendToServer;
    ctx.CONFIG = { workDir };
    ctx.sendToServer = msg => sent.push(msg);
    try {
      await handleWriteFile({
        conversationId: '_explorer',
        requestId: 'save-1',
        _requestUserId: 'user-1',
        _requestClientId: 'client-1',
        workDir,
        filePath: 'design.md',
        content: 'saved content',
      });
      expect(readFileSync(join(workDir, 'design.md'), 'utf8')).toBe('saved content');
      expect(sent).toEqual([expect.objectContaining({
        type: 'file_saved',
        conversationId: '_explorer',
        requestId: 'save-1',
        _requestUserId: 'user-1',
        _requestClientId: 'client-1',
        requestedFilePath: 'design.md',
        success: true,
      })]);
    } finally {
      ctx.CONFIG = previousConfig;
      ctx.sendToServer = previousSend;
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  it('targets a save acknowledgement to its requesting browser with Agent identity', async () => {
    const client = { authenticated: true, userId: 'user-1' };
    webClients.set('client-1', client);

    await handleAgentFileTerminal('agent-1', {}, {
      type: 'file_saved',
      conversationId: 'session-1',
      requestId: 'save-1',
      _requestUserId: 'user-1',
      _requestClientId: 'client-1',
      filePath: '/workspace/docs/design.md',
      requestedFilePath: 'docs/design.md',
      success: true,
    });

    expect(sendToWebClient).toHaveBeenCalledWith(client, expect.objectContaining({
      type: 'file_saved',
      agentId: 'agent-1',
      conversationId: 'session-1',
      requestId: 'save-1',
      requestedFilePath: 'docs/design.md',
    }));
    expect(sendToWebClient.mock.calls[0][1]).not.toHaveProperty('_requestClientId');
    expect(sendToWebClient.mock.calls[0][1]).not.toHaveProperty('_requestUserId');
    expect(forwardToClients).not.toHaveBeenCalled();
  });

  it('preserves the requested path when projecting a binary file response', async () => {
    await handleAgentFileTerminal('agent-1', {}, {
      type: 'file_content',
      conversationId: 'session-1',
      requestId: 'file-request-1',
      filePath: '/workspace/docs/diagram.png',
      requestedFilePath: 'docs/diagram.png',
      content: Buffer.from('image').toString('base64'),
      binary: true,
      mimeType: 'image/png',
    });

    expect(forwardToClients).toHaveBeenCalledOnce();
    const [, , forwarded] = forwardToClients.mock.calls[0];
    expect(forwarded).toMatchObject({
      type: 'file_content',
      agentId: 'agent-1',
      requestId: 'file-request-1',
      filePath: '/workspace/docs/diagram.png',
      requestedFilePath: 'docs/diagram.png',
      binary: true,
      mimeType: 'image/png',
    });
    expect(forwarded).not.toHaveProperty('content');
    expect(previewFiles.has(forwarded.fileId)).toBe(true);

    globalThis.Vue = Vue;
    globalThis.location = { protocol: 'https:', host: 'yeaft.test' };
    const wrongOwnerTab = {
      path: 'docs/diagram.png',
      name: 'diagram.png',
      fileType: 'image',
      agentId: 'agent-2',
      conversationId: 'session-2',
      requestId: 'other-request',
      previewLoading: true,
      previewError: null,
      blobUrl: null,
    };
    const relativeTab = {
      path: 'docs/diagram.png',
      name: 'diagram.png',
      fileType: 'image',
      agentId: 'agent-1',
      conversationId: 'session-1',
      requestId: 'file-request-1',
      previewLoading: true,
      previewError: null,
      blobUrl: null,
    };
    const openFiles = Vue.ref([wrongOwnerTab, relativeTab]);
    const handle = createWsHandler({
      store: { currentConversation: 'session-1', currentAgent: 'agent-1' },
      normalizePath: value => value,
      getEffectiveWorkDir: () => '/workspace',
      openFiles,
      activeFileIndex: Vue.ref(1),
      activeFile: Vue.computed(() => openFiles.value[1]),
      fileLoading: Vue.ref(true),
      fileSaving: Vue.ref(false),
      saveTabsState: vi.fn(),
      createEditor: vi.fn(),
      openFileInTab: vi.fn(),
      tree: { handleDirectoryListing: vi.fn() },
      setTreeVisible: vi.fn(),
      fp: { handleFolderPickerListing: vi.fn() },
      qo: {},
      ops: { getPendingDownload: () => null, clearPendingDownload: vi.fn() },
      mdPreviewMode: Vue.ref(false),
      renderOfficeLocal: vi.fn(),
      editorContainer: Vue.ref(null),
      debugStatus: Vue.ref(''),
    }).handleWorkbenchMessage;
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({ blob: async () => new Blob(['image']) });
    const createObjectUrl = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:preview');

    handle(new CustomEvent('workbench-message', { detail: { ...forwarded, agentId: 'agent-2' } }));
    handle(new CustomEvent('workbench-message', { detail: { ...forwarded, conversationId: 'session-2' } }));
    handle(new CustomEvent('workbench-message', { detail: { ...forwarded, requestId: 'stale-request' } }));
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(relativeTab.previewLoading).toBe(true);

    handle(new CustomEvent('workbench-message', { detail: forwarded }));
    await vi.waitFor(() => expect(relativeTab.blobUrl).toBe('blob:preview'));
    expect(relativeTab.previewLoading).toBe(false);
    expect(wrongOwnerTab.blobUrl).toBeNull();
    expect(wrongOwnerTab.previewLoading).toBe(true);
    fetchSpy.mockRestore();
    createObjectUrl.mockRestore();
  });
});
