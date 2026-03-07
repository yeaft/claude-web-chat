/**
 * wsHandler — WebSocket message handler composable for FilesTab.
 * Centralizes all workbench-message handling in one place.
 */
import { getFileType, isMarkdownFile } from './fileEditor.js';

export function createWsHandler({
  store, normalizePath, getEffectiveWorkDir,
  // File tabs
  openFiles, activeFileIndex, activeFile, fileLoading, fileSaving,
  saveTabsState, createEditor, openFileInTab,
  // Tree
  tree,
  // Folder picker
  fp,
  // Quick open
  qo,
  // File operations
  ops,
  // Preview
  mdPreviewMode, renderOfficeLocal, editorContainer, debugStatus
}) {

  const handleWorkbenchMessage = (event) => {
    const msg = event.detail;
    if (!msg) return;

    switch (msg.type) {
      case 'directory_listing': {
        if (msg.conversationId === '_folder_picker') {
          fp.handleFolderPickerListing(msg);
          return;
        }
        tree.handleDirectoryListing(msg);
        break;
      }
      case 'file_content': {
        fileLoading.value = false;
        if (msg.error) {
          debugStatus.value = `Error: ${msg.error}`;
          ops.clearPendingDownload();
          const errFilePath = normalizePath(msg.filePath);
          const errTab = openFiles.value.find(f => f.path === errFilePath);
          if (errTab) { errTab.previewLoading = false; errTab.previewError = msg.error; }
          return;
        }
        const nFilePath = normalizePath(msg.filePath);

        // Handle pending download
        if (ops.getPendingDownload() && normalizePath(ops.getPendingDownload()) === nFilePath) {
          ops.clearPendingDownload();
          try {
            if (msg.binary) {
              const dlUrl = `${location.protocol}//${location.host}/api/preview/${msg.fileId}?token=${msg.previewToken}`;
              const a = document.createElement('a');
              a.href = dlUrl; a.download = nFilePath.split('/').pop() || 'download';
              document.body.appendChild(a); a.click(); document.body.removeChild(a);
            } else {
              const blob = new Blob([msg.content || ''], { type: 'application/octet-stream' });
              const url = URL.createObjectURL(blob);
              const a = document.createElement('a');
              a.href = url; a.download = nFilePath.split('/').pop() || 'download';
              document.body.appendChild(a); a.click(); document.body.removeChild(a);
              URL.revokeObjectURL(url);
            }
          } catch (e) { console.error('Download failed:', e); }
          return;
        }

        const tabIndex = openFiles.value.findIndex(f => f.path === nFilePath);
        if (tabIndex >= 0) {
          const file = openFiles.value[tabIndex];
          if (msg.binary) {
            file.previewLoading = false;
            const previewBaseUrl = `${location.protocol}//${location.host}/api/preview/${msg.fileId}?token=${msg.previewToken}`;
            const ft = file.fileType || getFileType(file.name);
            file.fileType = ft;
            if (ft === 'pdf' || ft === 'image') {
              fetch(previewBaseUrl).then(r => r.blob()).then(blob => { file.blobUrl = URL.createObjectURL(blob); })
                .catch(e => { file.previewError = e.message; });
            } else if (ft === 'office') {
              const mode = localStorage.getItem('officePreviewMode') || 'local';
              if (mode === 'online') {
                file.previewUrl = 'https://view.officeapps.live.com/op/embed.aspx?src=' + encodeURIComponent(previewBaseUrl);
              } else {
                fetch(previewBaseUrl).then(r => r.arrayBuffer()).then(buf => {
                  file._arrayBuffer = buf; file.localPreviewReady = true;
                  if (tabIndex === activeFileIndex.value) Vue.nextTick(() => renderOfficeLocal(file));
                }).catch(e => { file.previewError = e.message; });
              }
            }
            saveTabsState(store.currentConversation);
            return;
          }
          file.content = msg.content || '';
          file.originalContent = msg.content || '';
          file.isDirty = false;
          saveTabsState(store.currentConversation);
          if (tabIndex === activeFileIndex.value) {
            if (isMarkdownFile(file.name) && mdPreviewMode.value) {
              // mdRenderedHtml computed updates automatically
            } else {
              Vue.nextTick(() => { setTimeout(() => createEditor(file), 100); });
            }
          }
        }
        break;
      }
      case 'file_saved': {
        fileSaving.value = false;
        if (msg.error) { console.error('File save failed:', msg.error); return; }
        const nSavedPath = normalizePath(msg.filePath);
        const savedFile = openFiles.value.find(f => f.path === nSavedPath);
        if (savedFile) {
          savedFile.originalContent = savedFile.content;
          savedFile.isDirty = false;
          saveTabsState(store.currentConversation);
        }
        break;
      }
      case 'file_search_result': {
        qo.handleFileSearchResult(msg);
        break;
      }
      case 'file_op_result': {
        ops.handleFileOpResult(msg, tree.loadTreeDirectory, tree.treeRootPath.value);
        break;
      }
      case 'file_tabs_restored': {
        if (msg.openFiles?.length > 0 && openFiles.value.length === 0) {
          const pendingRestoreIndex = msg.activeIndex || 0;
          const totalFiles = msg.openFiles.length;
          for (const file of msg.openFiles) {
            const nPath = normalizePath(file.path);
            const name = nPath.split('/').pop();
            const fileType = getFileType(name);
            openFiles.value.push({
              path: nPath, name, content: null, originalContent: null,
              isDirty: false, cmInstance: null, fileType,
              blobUrl: null, previewUrl: null,
              previewLoading: fileType !== 'text', localPreviewReady: false, previewError: null
            });
            store.sendWsMessage({
              type: 'read_file',
              conversationId: store.currentConversation || '_explorer',
              agentId: store.currentAgent,
              filePath: file.path
            });
          }
          activeFileIndex.value = (pendingRestoreIndex >= 0 && pendingRestoreIndex < totalFiles)
            ? pendingRestoreIndex : 0;
        }
        break;
      }
    }
  };

  const handleOpenFile = (event) => {
    const { filePath: path } = event.detail;
    const nPath = normalizePath(path);
    openFileInTab(nPath, nPath.split('/').pop());
  };

  return {
    handleWorkbenchMessage,
    handleOpenFile
  };
}
