import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as Vue from 'vue';
import { createWsHandler } from '../../web/components/files/wsHandler.js';
import { createFileTabs } from '../../web/components/files/fileTabs.js';

const forwardToClients = vi.fn(async () => {});
const previewFiles = new Map();

vi.mock('../../server/context.js', () => ({
  previewFiles,
  webClients: new Map(),
}));

vi.mock('../../server/ws-utils.js', () => ({
  sendToWebClient: vi.fn(async () => {}),
  forwardToClients,
  setCachedDir: vi.fn(),
  invalidateParentDirCache: vi.fn(),
  clearAgentDirCache: vi.fn(),
}));

const { handleAgentFileTerminal } = await import('../../server/handlers/agent-file-terminal.js');

describe('Agent file terminal forwarding', () => {
  beforeEach(() => {
    forwardToClients.mockClear();
    previewFiles.clear();
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

    expect(sent.find(msg => msg.type === 'write_file')).toMatchObject({
      agentId: 'agent-a',
      conversationId: 'conversation-a',
      workDir: '/agent-a/project',
      filePath: 'docs/design.md',
      content: 'updated',
    });
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
