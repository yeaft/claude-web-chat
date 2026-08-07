import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as Vue from 'vue';
import { createWsHandler } from '../../web/components/files/wsHandler.js';

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

  it('preserves the requested path when projecting a binary file response', async () => {
    await handleAgentFileTerminal('agent-1', {}, {
      type: 'file_content',
      conversationId: 'session-1',
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
      filePath: '/workspace/docs/diagram.png',
      requestedFilePath: 'docs/diagram.png',
      binary: true,
      mimeType: 'image/png',
    });
    expect(forwarded).not.toHaveProperty('content');
    expect(previewFiles.has(forwarded.fileId)).toBe(true);

    globalThis.Vue = Vue;
    globalThis.location = { protocol: 'https:', host: 'yeaft.test' };
    const relativeTab = {
      path: 'docs/diagram.png',
      name: 'diagram.png',
      fileType: 'image',
      previewLoading: true,
      previewError: null,
      blobUrl: null,
    };
    const openFiles = Vue.ref([relativeTab]);
    const handle = createWsHandler({
      store: { currentConversation: 'session-1', currentAgent: 'agent-1' },
      normalizePath: value => value,
      getEffectiveWorkDir: () => '/workspace',
      openFiles,
      activeFileIndex: Vue.ref(0),
      activeFile: Vue.computed(() => openFiles.value[0]),
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

    handle(new CustomEvent('workbench-message', { detail: forwarded }));
    await vi.waitFor(() => expect(relativeTab.blobUrl).toBe('blob:preview'));
    expect(relativeTab.previewLoading).toBe(false);
    fetchSpy.mockRestore();
    createObjectUrl.mockRestore();
  });
});
