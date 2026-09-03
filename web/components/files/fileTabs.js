import { confirmDialog } from '../../utils/dialog.js';
/**
 * fileTabs — Tab management composable for FilesTab.
 * Manages open files, active tab, switching, closing, saving, tab state persistence.
 */
import { getFileType, isMarkdownFile } from './fileEditor.js';

export function createFileTabs(store, {
  normalizePath, getEffectiveWorkDir,
  editorContainer, createEditor, destroyEditor,
  clearFindMarkers, saveCurrentUndoHistory, saveAllUndoHistory,
  cleanupUndoHistory, deleteConversationHistory,
  debugStatus, mdPreviewMode, renderOfficeLocal,
  performFind, findBarVisible, findQuery, t
}) {
  const fileTabsMap = Vue.reactive({});
  const openFiles = Vue.ref([]);
  const activeFileIndex = Vue.ref(-1);
  const fileLoading = Vue.ref(false);
  const fileSaving = Vue.ref(false);

  const activeFile = Vue.computed(() => {
    if (activeFileIndex.value >= 0 && activeFileIndex.value < openFiles.value.length) {
      return openFiles.value[activeFileIndex.value];
    }
    return null;
  });

  let _syncTabsTimer = null;
  const syncFileTabsToServer = () => {
    if (_syncTabsTimer) clearTimeout(_syncTabsTimer);
    _syncTabsTimer = setTimeout(() => {
      store.sendWsMessage({
        type: 'update_file_tabs',
        openFiles: openFiles.value.map(f => ({ path: f.path })),
        activeIndex: activeFileIndex.value
      });
    }, 500);
  };

  const saveTabsState = (convId) => {
    if (!convId) return;
    saveAllUndoHistory(convId);
    if (openFiles.value.length > 0) {
      fileTabsMap[convId] = {
        files: openFiles.value.map(f => ({
          path: f.path, name: f.name, content: f.content,
          originalContent: f.originalContent, isDirty: f.isDirty,
          fileType: f.fileType, agentId: f.agentId,
          conversationId: f.conversationId, workDir: f.workDir
        })),
        activeIndex: activeFileIndex.value
      };
    } else {
      delete fileTabsMap[convId];
    }
    syncFileTabsToServer();
  };

  const restoreTabsState = (convId) => {
    destroyEditor();
    if (!convId || !fileTabsMap[convId]) {
      openFiles.value = [];
      activeFileIndex.value = -1;
      return;
    }
    const saved = fileTabsMap[convId];
    openFiles.value = saved.files.map(f => ({
      ...f,
      isDirty: f.isDirty || false,
      originalContent: f.originalContent || f.content,
      cmInstance: null,
      fileType: f.fileType || getFileType(f.name || ''),
      blobUrl: null, previewUrl: null, previewLoading: false,
      localPreviewReady: false, previewError: null
    }));
    activeFileIndex.value = saved.activeIndex;
    Vue.nextTick(() => {
      const file = activeFile.value;
      if (file && (!file.fileType || file.fileType === 'text') && editorContainer.value) {
        createEditor(file);
      }
    });
  };

  function openFileInTab(fullPath, name, route = {}) {
    const nPath = normalizePath(fullPath);
    const agentId = route.agentId || store.currentAgent || null;
    const conversationId = route.conversationId || store.currentConversation || '_explorer';
    const workDir = route.workDir || getEffectiveWorkDir();
    const existingIndex = openFiles.value.findIndex(f => f.path === nPath
      && (!f.agentId || f.agentId === agentId)
      && (!f.conversationId || f.conversationId === conversationId));
    if (existingIndex >= 0) {
      if (activeFileIndex.value !== existingIndex) {
        clearFindMarkers();
        saveCurrentUndoHistory();
        activeFileIndex.value = existingIndex;
        Vue.nextTick(() => {
          const file = openFiles.value[existingIndex];
          if (file && file.content != null && (!file.fileType || file.fileType === 'text')) createEditor(file);
        });
      }
      saveTabsState(store.currentConversation);
      return;
    }

    saveCurrentUndoHistory();
    const displayName = name || nPath.split(/[/\\]/).pop();
    const fileType = getFileType(displayName);
    openFiles.value.push({
      path: nPath, name: displayName, agentId, conversationId, workDir,
      content: null, originalContent: null,
      isDirty: false, cmInstance: null, fileType,
      blobUrl: null, previewUrl: null,
      previewLoading: fileType !== 'text', localPreviewReady: false, previewError: null
    });
    activeFileIndex.value = openFiles.value.length - 1;
    fileLoading.value = true;
    if (fileType === 'text') destroyEditor();
    saveTabsState(store.currentConversation);

    debugStatus.value = `Loading: ${fullPath}`;
    const requestId = route.requestId || `file-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const openedFile = openFiles.value[activeFileIndex.value];
    if (openedFile) openedFile.requestId = requestId;
    store.sendWsMessage({
      type: 'read_file',
      conversationId,
      agentId,
      requestId,
      filePath: fullPath,
      workDir,
      _clientId: store.clientId
    });
  }

  const switchToTab = (index) => {
    if (index === activeFileIndex.value) return;
    clearFindMarkers();
    saveCurrentUndoHistory();
    activeFileIndex.value = index;
    saveTabsState(store.currentConversation);

    Vue.nextTick(() => {
      const file = openFiles.value[index];
      if (!file) return;
      if (!file.fileType || file.fileType === 'text') {
        if (isMarkdownFile(file.name)) {
          mdPreviewMode.value = true;
        } else if (file.content != null && editorContainer.value) {
          createEditor(file);
          if (findBarVisible.value && findQuery.value) {
            Vue.nextTick(() => performFind());
          }
        }
      } else if (file.fileType === 'office' && file.localPreviewReady) {
        Vue.nextTick(() => renderOfficeLocal(file));
      }
    });
  };

  const closeFileTabs = async (indices, { canCommit = () => true } = {}) => {
    const requested = [...new Set(indices)]
      .filter(index => Number.isInteger(index) && index >= 0 && index < openFiles.value.length)
      .sort((a, b) => a - b);
    if (requested.length === 0) return false;

    const filesToClose = requested.map(index => openFiles.value[index]);
    const dirtyFiles = filesToClose.filter(file => file?.isDirty);
    if (dirtyFiles.length > 0) {
      const message = dirtyFiles.length === 1
        ? t('files.unsavedConfirm', { name: dirtyFiles[0].name })
        : t('files.unsavedBatchConfirm', { count: dirtyFiles.length });
      if (!await confirmDialog(message, { destructive: true })) return false;
    }
    if (!canCommit()) return false;

    const closing = new Set(requested);
    const previousActiveIndex = activeFileIndex.value;
    const previousActiveFile = activeFile.value;
    let nextActiveFile = previousActiveFile;
    if (closing.has(previousActiveIndex)) {
      nextActiveFile = null;
      for (let index = previousActiveIndex + 1; index < openFiles.value.length; index++) {
        if (!closing.has(index)) {
          nextActiveFile = openFiles.value[index];
          break;
        }
      }
      if (!nextActiveFile) {
        for (let index = previousActiveIndex - 1; index >= 0; index--) {
          if (!closing.has(index)) {
            nextActiveFile = openFiles.value[index];
            break;
          }
        }
      }
    }

    for (const file of filesToClose) {
      cleanupUndoHistory(file.conversationId || store.currentConversation, file.path);
      if (file.blobUrl) URL.revokeObjectURL(file.blobUrl);
    }
    for (let position = requested.length - 1; position >= 0; position--) {
      openFiles.value.splice(requested[position], 1);
    }

    if (openFiles.value.length === 0) {
      activeFileIndex.value = -1;
      destroyEditor();
    } else {
      activeFileIndex.value = Math.max(0, openFiles.value.indexOf(nextActiveFile));
    }

    saveTabsState(store.currentConversation);

    if (previousActiveFile !== activeFile.value && activeFile.value) {
      Vue.nextTick(() => {
        const newActive = activeFile.value;
        if (newActive && (!newActive.fileType || newActive.fileType === 'text') && newActive.content != null && editorContainer.value) {
          createEditor(newActive);
        }
      });
    }
    return true;
  };

  const closeFileTab = index => closeFileTabs([index]);
  const closeTabsToLeft = index => closeFileTabs(openFiles.value.map((_, tabIndex) => tabIndex).filter(tabIndex => tabIndex < index));
  const closeTabsToRight = index => closeFileTabs(openFiles.value.map((_, tabIndex) => tabIndex).filter(tabIndex => tabIndex > index));
  const closeOtherTabs = index => closeFileTabs(openFiles.value.map((_, tabIndex) => tabIndex).filter(tabIndex => tabIndex !== index));
  const closeAllTabs = options => closeFileTabs(openFiles.value.map((_, index) => index), options);

  function saveFile() {
    const file = activeFile.value;
    if (!file || !file.isDirty || file.pendingSaveRequestId) return;
    fileSaving.value = true;
    const requestId = `file-save-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    file.pendingSaveRequestId = requestId;
    file.pendingSaveContent = file.content;
    store.sendWsMessage({
      type: 'write_file',
      conversationId: file.conversationId || store.currentConversation || '_explorer',
      agentId: file.agentId || store.currentAgent,
      requestId,
      filePath: file.path,
      content: file.content,
      workDir: file.workDir || getEffectiveWorkDir(),
      _clientId: store.clientId
    });
  }

  const handleConversationDeleted = (event) => {
    const { conversationId } = event.detail;
    if (conversationId) {
      delete fileTabsMap[conversationId];
      deleteConversationHistory(conversationId);
    }
  };

  return {
    fileTabsMap, openFiles, activeFileIndex, activeFile,
    fileLoading, fileSaving,
    saveTabsState, restoreTabsState, openFileInTab,
    switchToTab, closeFileTab, closeFileTabs,
    closeTabsToLeft, closeTabsToRight, closeOtherTabs, closeAllTabs,
    saveFile,
    handleConversationDeleted
  };
}
