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
          fileType: f.fileType
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

  function openFileInTab(fullPath, name) {
    const nPath = normalizePath(fullPath);
    const existingIndex = openFiles.value.findIndex(f => f.path === nPath);
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
      path: nPath, name: displayName, content: null, originalContent: null,
      isDirty: false, cmInstance: null, fileType,
      blobUrl: null, previewUrl: null,
      previewLoading: fileType !== 'text', localPreviewReady: false, previewError: null
    });
    activeFileIndex.value = openFiles.value.length - 1;
    fileLoading.value = true;
    if (fileType === 'text') destroyEditor();
    saveTabsState(store.currentConversation);

    debugStatus.value = `Loading: ${fullPath}`;
    store.sendWsMessage({
      type: 'read_file',
      conversationId: store.currentConversation || '_explorer',
      agentId: store.currentAgent,
      filePath: fullPath,
      workDir: getEffectiveWorkDir(),
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

  const closeFileTab = (index) => {
    const file = openFiles.value[index];
    if (file?.isDirty) {
      if (!confirm(t('files.unsavedConfirm', { name: file.name }))) return;
    }
    cleanupUndoHistory(store.currentConversation, file.path);
    if (file.blobUrl) URL.revokeObjectURL(file.blobUrl);

    const wasActive = (index === activeFileIndex.value);
    openFiles.value.splice(index, 1);

    if (openFiles.value.length === 0) {
      activeFileIndex.value = -1;
      destroyEditor();
    } else if (activeFileIndex.value >= openFiles.value.length) {
      activeFileIndex.value = openFiles.value.length - 1;
    } else if (activeFileIndex.value > index) {
      activeFileIndex.value--;
    } else if (wasActive && activeFileIndex.value >= openFiles.value.length) {
      activeFileIndex.value = openFiles.value.length - 1;
    }

    saveTabsState(store.currentConversation);

    if (openFiles.value.length > 0 && wasActive) {
      Vue.nextTick(() => {
        const newActive = openFiles.value[activeFileIndex.value];
        if (newActive && (!newActive.fileType || newActive.fileType === 'text') && newActive.content != null && editorContainer.value) {
          createEditor(newActive);
        }
      });
    }
  };

  function saveFile() {
    const file = activeFile.value;
    if (!file || !file.isDirty) return;
    fileSaving.value = true;
    store.sendWsMessage({
      type: 'write_file',
      conversationId: store.currentConversation || '_explorer',
      agentId: store.currentAgent,
      filePath: file.path,
      content: file.content,
      workDir: getEffectiveWorkDir(),
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
    switchToTab, closeFileTab, saveFile,
    handleConversationDeleted
  };
}
