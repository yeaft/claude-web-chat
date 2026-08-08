import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as Vue from 'vue';
import { createWsHandler } from '../../web/components/files/wsHandler.js';
import { createFileTabs } from '../../web/components/files/fileTabs.js';
import ctx from '../../agent/context.js';
import { CONFIG } from '../../server/config.js';
import { userDb, yeaftSessionDb } from '../../server/database.js';
import { handleWriteFile } from '../../agent/workbench/file-ops.js';

const {
  forwardToClients,
  forwardToAgent,
  sendToWebClient,
  agents,
  previewFiles,
  webClients,
} = vi.hoisted(() => ({
  forwardToClients: vi.fn(async () => {}),
  forwardToAgent: vi.fn(async () => {}),
  sendToWebClient: vi.fn(async () => {}),
  agents: new Map(),
  previewFiles: new Map(),
  webClients: new Map(),
}));

vi.mock('../../server/context.js', () => ({
  agents,
  previewFiles,
  webClients,
}));

vi.mock('../../server/ws-utils.js', () => ({
  sendToWebClient,
  forwardToClients,
  forwardToAgent,
  verifyConversationOwnership: vi.fn(() => true),
  getCachedDir: vi.fn(() => null),
  setCachedDir: vi.fn(),
  invalidateParentDirCache: vi.fn(),
  clearAgentDirCache: vi.fn(),
}));

const { handleAgentFileTerminal } = await import('../../server/handlers/agent-file-terminal.js');
const { handleClientWorkbench } = await import('../../server/handlers/client-workbench.js');
const { workbenchRouteKey } = await import('../../server/workbench-route.js');

describe('Agent file terminal forwarding', () => {
  beforeEach(() => {
    forwardToClients.mockClear();
    forwardToAgent.mockClear();
    sendToWebClient.mockClear();
    agents.clear();
    previewFiles.clear();
    webClients.clear();
  });

  it('authorizes a Yeaft Workbench route and replaces browser cwd with canonical Session metadata', async () => {
    const suffix = `${process.pid}-${Date.now()}`;
    const user = userDb.getOrCreate(`workbench-user-${suffix}`);
    const userId = user.id;
    const agentId = `workbench-agent-${suffix}`;
    const sessionId = `workbench-session-${suffix}`;
    const route = { runtimeProvider: 'yeaft', agentId, sessionId };
    const canonicalWorkDir = `/canonical/${sessionId}`;
    const previousSkipAuth = CONFIG.skipAuth;
    CONFIG.skipAuth = false;
    yeaftSessionDb.upsertFromSnapshot(userId, agentId, {
      id: sessionId,
      name: 'Workbench route test',
      workDir: canonicalWorkDir,
    });
    try {
      agents.set(agentId, { capabilities: ['workbench_session_routes'] });
      const handled = await handleClientWorkbench(
        'client-route',
        { userId, role: 'pro', currentAgent: agentId, currentConversation: 'shared-yeaft-conversation' },
        {
          type: 'terminal_create',
          agentId,
          conversationId: 'browser-forged-conversation',
          workDir: '/browser/forged',
          workbenchRoute: route,
          workbenchRouteKey: workbenchRouteKey(route),
          terminalId: 'term-route',
          cols: 80,
          rows: 24,
        },
        async requestedAgentId => requestedAgentId === agentId,
      );

      expect(handled).toBe(true);
      expect(forwardToAgent).toHaveBeenCalledWith(agentId, expect.objectContaining({
        type: 'terminal_create',
        agentId,
        workDir: canonicalWorkDir,
        workbenchRouteKey: workbenchRouteKey(route),
        conversationId: `_workbench:${workbenchRouteKey(route)}`,
        _requestUserId: userId,
        _requestClientId: 'client-route',
      }));
      expect(forwardToAgent.mock.calls[0][1].workDir).not.toBe('/browser/forged');

      forwardToAgent.mockClear();
      await handleClientWorkbench(
        'client-route',
        { userId, role: 'pro', currentAgent: agentId },
        {
          type: 'git_status',
          agentId,
          workDir: '/workspace/selected-repository',
          workbenchRoute: route,
          workbenchRouteKey: workbenchRouteKey(route),
        },
        async requestedAgentId => requestedAgentId === agentId,
      );
      expect(forwardToAgent).toHaveBeenCalledWith(agentId, expect.objectContaining({
        type: 'git_status',
        workDir: '/workspace/selected-repository',
        workbenchRouteKey: workbenchRouteKey(route),
      }));
    } finally {
      yeaftSessionDb.deleteForAgent(userId, agentId, sessionId);
      userDb.deleteUser(userId);
      CONFIG.skipAuth = previousSkipAuth;
    }
  });

  it('rejects route-scoped requests when the Agent lacks protocol support', async () => {
    const previousSkipAuth = CONFIG.skipAuth;
    CONFIG.skipAuth = true;
    const agentId = 'legacy-workbench-agent';
    const route = { runtimeProvider: 'yeaft', agentId, sessionId: 'session-1' };
    agents.set(agentId, {
      capabilities: ['terminal', 'file_editor'],
      yeaftSessions: new Map([['session-1', { id: 'session-1', workDir: '/legacy' }]]),
    });
    try {
      expect(await handleClientWorkbench(
        'legacy-client',
        { userId: 'local-user', role: 'admin', currentAgent: agentId },
        { type: 'terminal_create', agentId, workbenchRoute: route },
        async () => true,
      )).toBeUndefined();
      expect(forwardToAgent).not.toHaveBeenCalled();
      expect(sendToWebClient).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
        type: 'error',
        message: 'Invalid Workbench Session route',
      }));
    } finally {
      CONFIG.skipAuth = previousSkipAuth;
      agents.clear();
    }
  });

  it('allows only terminal cleanup after Session metadata is removed', async () => {
    const previousSkipAuth = CONFIG.skipAuth;
    CONFIG.skipAuth = true;
    const agentId = 'deleted-session-agent';
    const route = { runtimeProvider: 'yeaft', agentId, sessionId: 'deleted-session' };
    agents.set(agentId, { capabilities: ['workbench_session_routes'], yeaftSessions: new Map() });
    try {
      expect(await handleClientWorkbench(
        'cleanup-client',
        { userId: 'local-user', role: 'admin', currentAgent: agentId },
        { type: 'terminal_close', agentId, terminalId: 'term-1', workbenchRoute: route },
        async () => true,
      )).toBe(true);
      expect(forwardToAgent).toHaveBeenCalledWith(agentId, expect.objectContaining({
        type: 'terminal_close',
        terminalId: 'term-1',
        workbenchRouteKey: workbenchRouteKey(route),
      }));

      forwardToAgent.mockClear();
      expect(await handleClientWorkbench(
        'cleanup-client',
        { userId: 'local-user', role: 'admin', currentAgent: agentId },
        { type: 'terminal_input', agentId, terminalId: 'term-1', data: 'pwd\n', workbenchRoute: route },
        async () => true,
      )).toBeUndefined();
      expect(forwardToAgent).not.toHaveBeenCalled();
    } finally {
      CONFIG.skipAuth = previousSkipAuth;
      agents.clear();
    }
  });

  it('uses the live Agent Session snapshot only in local no-auth mode', async () => {
    const previousSkipAuth = CONFIG.skipAuth;
    CONFIG.skipAuth = true;
    const agentId = 'local-workbench-agent';
    const sessionId = 'local-workbench-session';
    const route = { runtimeProvider: 'yeaft', agentId, sessionId };
    agents.set(agentId, {
      capabilities: ['workbench_session_routes'],
      yeaftSessions: new Map([[sessionId, { id: sessionId, workDir: '/local/session' }]]),
    });
    try {
      expect(await handleClientWorkbench(
        'local-client',
        { userId: 'local-user', role: 'admin', currentAgent: agentId },
        {
          type: 'git_status',
          agentId,
          workDir: '/forged',
          workbenchRoute: route,
          workbenchRouteKey: workbenchRouteKey(route),
        },
        async () => true,
      )).toBe(true);
      expect(forwardToAgent).toHaveBeenCalledWith(agentId, expect.objectContaining({
        type: 'git_status',
        workDir: '/forged',
        workbenchRoute: route,
        workbenchRouteKey: workbenchRouteKey(route),
      }));
    } finally {
      CONFIG.skipAuth = previousSkipAuth;
      agents.clear();
    }
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

    handler(new CustomEvent('workbench-open-file-in-active-view', { detail: {
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
    tabs.openFiles.value.push(wrongOwnerTab);
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
    const otherBrowserTab = {
      path: 'docs/design.md',
      agentId: 'agent-a',
      conversationId: 'conversation-a',
      content: 'unsaved in another browser',
      originalContent: 'other browser original',
      isDirty: true,
    };
    const otherBrowserFiles = Vue.ref([otherBrowserTab]);
    const otherBrowserSaveTabsState = vi.fn();
    const otherBrowserHandle = createWsHandler({
      store,
      normalizePath: value => value,
      getEffectiveWorkDir: () => '/agent-a/project',
      openFiles: otherBrowserFiles,
      activeFileIndex: Vue.ref(0),
      activeFile: Vue.computed(() => otherBrowserFiles.value[0]),
      fileLoading: Vue.ref(false),
      fileSaving: Vue.ref(false),
      saveTabsState: otherBrowserSaveTabsState,
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
    otherBrowserHandle(new CustomEvent('workbench-message', { detail: {
      type: 'file_saved',
      agentId: 'agent-a',
      conversationId: 'conversation-a',
      requestedFilePath: 'docs/design.md',
      success: true,
    } }));
    expect(otherBrowserTab).toMatchObject({
      originalContent: 'other browser original',
      isDirty: true,
    });
    expect(otherBrowserSaveTabsState).not.toHaveBeenCalled();

    ack({ agentId: 'agent-b', conversationId: 'conversation-a', requestId: writeRequest.requestId });
    ack({ agentId: 'agent-a', conversationId: 'conversation-a', requestId: 'stale-save' });
    expect(ownerTab.isDirty).toBe(true);
    expect(wrongOwnerTab.isDirty).toBe(true);

    // Ctrl/Cmd+S calls saveFile directly. A second save must not overwrite
    // the pending snapshot while an old Agent may return an ACK without id.
    ownerTab.content = 'edited while save was in flight';
    tabs.saveFile();
    expect(sent.filter(msg => msg.type === 'write_file')).toHaveLength(1);
    expect(ownerTab.pendingSaveRequestId).toBe(writeRequest.requestId);
    expect(ownerTab.pendingSaveContent).toBe('updated');

    ack({ agentId: 'agent-a', conversationId: 'conversation-a' });
    expect(ownerTab.originalContent).toBe('updated');
    expect(ownerTab.isDirty).toBe(true);
    expect(wrongOwnerTab.isDirty).toBe(true);
    expect(saveTabsState).toHaveBeenLastCalledWith('conversation-a');

    const savedStateCallCount = saveTabsState.mock.calls.length;
    ack({ agentId: 'agent-a', conversationId: 'conversation-a' });
    expect(ownerTab.originalContent).toBe('updated');
    expect(ownerTab.isDirty).toBe(true);
    expect(saveTabsState).toHaveBeenCalledTimes(savedStateCallCount);

    tabs.saveFile();
    const retryRequest = sent.filter(msg => msg.type === 'write_file').at(-1);
    expect(retryRequest.content).toBe('edited while save was in flight');
    ack({
      agentId: 'agent-a',
      conversationId: 'conversation-a',
      requestId: retryRequest.requestId,
      success: false,
      error: 'disk full',
    });
    expect(ownerTab.isDirty).toBe(true);
    expect(ownerTab.pendingSaveRequestId).toBeUndefined();

    tabs.saveFile();
    expect(sent.filter(msg => msg.type === 'write_file')).toHaveLength(3);
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

  it('rejects Agent-forged route keys that do not match the connected Agent', async () => {
    const client = { authenticated: true, userId: 'user-1' };
    webClients.set('client-1', client);

    await handleAgentFileTerminal('agent-1', {}, {
      type: 'directory_listing',
      conversationId: '_workbench:yeaft:agent-2:session-1',
      workbenchRouteKey: 'yeaft:agent-1:session-1',
      _requestUserId: 'user-1',
      _requestClientId: 'client-1',
      dirPath: '/workspace',
      entries: [],
    });

    expect(sendToWebClient).toHaveBeenCalledWith(client, expect.not.objectContaining({
      workbenchRouteKey: expect.anything(),
    }));
  });

  it('projects the canonical route key from synthetic Agent responses', async () => {
    const client = { authenticated: true, userId: 'user-1' };
    webClients.set('client-1', client);
    const routeKey = 'yeaft:agent-1:session-1';

    await handleAgentFileTerminal('agent-1', {}, {
      type: 'directory_listing',
      conversationId: `_workbench:${routeKey}`,
      requestId: 'dir-1',
      _requestUserId: 'user-1',
      _requestClientId: 'client-1',
      dirPath: '/workspace',
      entries: [],
    });

    expect(sendToWebClient).toHaveBeenCalledWith(client, expect.objectContaining({
      type: 'directory_listing',
      conversationId: `_workbench:${routeKey}`,
      workbenchRouteKey: routeKey,
      requestId: 'dir-1',
    }));
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
