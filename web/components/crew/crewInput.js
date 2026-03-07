/**
 * crewInput — Composable factory for input handling, @-mention, file upload, message sending.
 */
export function createCrewInput(store, authStore, { getInputRef, getFileInputRef, getCurrentPendingAsk }) {
  const inputText = Vue.ref('');
  const attachments = Vue.ref([]);
  const uploading = Vue.ref(false);
  const atMenuVisible = Vue.ref(false);
  const atQuery = Vue.ref('');
  const atMenuIndex = Vue.ref(0);

  const canSend = Vue.computed(() => {
    const hasContent = inputText.value.trim() || attachments.value.length > 0;
    const notUploading = !uploading.value && attachments.value.every(a => a.fileId);
    return hasContent && notUploading;
  });

  const filteredAtRoles = Vue.computed(() => {
    if (!atMenuVisible.value) return [];
    const roles = store.currentCrewSession?.roles || [];
    const q = atQuery.value.toLowerCase();
    if (!q) return roles;
    return roles.filter(r =>
      r.name.toLowerCase().includes(q) ||
      r.displayName.toLowerCase().includes(q)
    );
  });

  function autoResize() {
    const textarea = getInputRef();
    if (textarea) {
      textarea.style.height = 'auto';
      textarea.style.height = Math.min(textarea.scrollHeight, 120) + 'px';
    }
  }

  function handleInput() {
    autoResize();
    const textarea = getInputRef();
    if (!textarea) return;
    const pos = textarea.selectionStart;
    const text = inputText.value;
    const beforeCursor = text.substring(0, pos);
    const atIdx = beforeCursor.lastIndexOf('@');
    if (atIdx >= 0 && (atIdx === 0 || /\s/.test(beforeCursor[atIdx - 1]))) {
      const query = beforeCursor.substring(atIdx + 1);
      if (!/\s/.test(query)) {
        atQuery.value = query;
        atMenuVisible.value = true;
        atMenuIndex.value = 0;
        return;
      }
    }
    atMenuVisible.value = false;
  }

  function selectAtRole(role) {
    const textarea = getInputRef();
    if (!textarea) return;
    const pos = textarea.selectionStart;
    const text = inputText.value;
    const beforeCursor = text.substring(0, pos);
    const atIdx = beforeCursor.lastIndexOf('@');
    if (atIdx >= 0) {
      const afterCursor = text.substring(pos);
      inputText.value = text.substring(0, atIdx) + '@' + role.displayName + ' ' + afterCursor;
      Vue.nextTick(() => {
        const newPos = atIdx + role.displayName.length + 2;
        textarea.selectionStart = textarea.selectionEnd = newPos;
        textarea.focus();
      });
    }
    atMenuVisible.value = false;
  }

  function handleKeydown(e, sendMessage) {
    if (atMenuVisible.value && filteredAtRoles.value.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        atMenuIndex.value = (atMenuIndex.value + 1) % filteredAtRoles.value.length;
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        atMenuIndex.value = (atMenuIndex.value - 1 + filteredAtRoles.value.length) % filteredAtRoles.value.length;
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        selectAtRole(filteredAtRoles.value[atMenuIndex.value]);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        atMenuVisible.value = false;
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  }

  function handlePaste(e) {
    const items = e.clipboardData?.items;
    if (!items) return;
    const files = [];
    for (const item of items) {
      if (item.kind === 'file') {
        const file = item.getAsFile();
        if (file) files.push(file);
      }
    }
    if (files.length > 0) {
      e.preventDefault();
      addFiles(files);
    }
  }

  function handleFileSelect(e) {
    const files = Array.from(e.target.files || []);
    if (files.length > 0) addFiles(files);
    e.target.value = '';
    Vue.nextTick(() => getInputRef()?.focus());
  }

  async function addFiles(files) {
    for (const file of files) {
      const attachment = { file, name: file.name, preview: null, uploading: true, fileId: null };
      if (file.type.startsWith('image/')) attachment.preview = URL.createObjectURL(file);
      attachments.value.push(attachment);
    }
    uploading.value = true;
    try {
      const formData = new FormData();
      for (const file of files) formData.append('files', file);
      const headers = {};
      if (authStore?.token) headers['Authorization'] = `Bearer ${authStore.token}`;
      const response = await fetch('/api/upload', { method: 'POST', headers, body: formData });
      if (!response.ok) throw new Error('Upload failed');
      const result = await response.json();
      let resultIndex = 0;
      for (const attachment of attachments.value) {
        if (attachment.uploading && !attachment.fileId && resultIndex < result.files.length) {
          attachment.fileId = result.files[resultIndex].fileId;
          attachment.uploading = false;
          resultIndex++;
        }
      }
    } catch (error) {
      console.error('Upload error:', error);
      const failed = attachments.value.filter(a => !a.fileId);
      for (const f of failed) { if (f.preview) URL.revokeObjectURL(f.preview); }
      attachments.value = attachments.value.filter(a => a.fileId);
    } finally {
      uploading.value = false;
      Vue.nextTick(() => getInputRef()?.focus());
    }
  }

  function removeAttachment(index) {
    const attachment = attachments.value[index];
    if (attachment.preview) URL.revokeObjectURL(attachment.preview);
    attachments.value.splice(index, 1);
    Vue.nextTick(() => getInputRef()?.focus());
  }

  function sendMessage(e, scrollToBottom) {
    if (e && e.preventDefault) e.preventDefault();
    if (!canSend.value) return;

    const text = inputText.value.trim();
    const attachmentInfos = attachments.value
      .filter(a => a.fileId)
      .map(a => ({
        fileId: a.fileId,
        name: a.name,
        preview: a.preview,
        isImage: a.file?.type?.startsWith('image/') || false,
        mimeType: a.file?.type || ''
      }));

    const ask = getCurrentPendingAsk();
    if (ask && ask.askMsg.askRequestId && text) {
      const questions = ask.askMsg.toolInput?.questions || ask.askMsg.askQuestions || [];
      const answers = {};
      if (questions.length > 0) {
        for (const q of questions) {
          answers[q.question] = text;
        }
      } else {
        answers['response'] = text;
      }
      store.answerUserQuestion(ask.askMsg.askRequestId, answers);
      ask.askMsg.askAnswered = true;
      ask.askMsg.selectedAnswers = answers;
    }

    store.sendCrewMessage(text, null, attachmentInfos.length > 0 ? attachmentInfos : undefined);
    inputText.value = '';
    attachments.value = [];
    delete store.inputDrafts[store.currentConversation];
    const textarea = getInputRef();
    if (textarea) textarea.style.height = 'auto';
    if (scrollToBottom) {
      Vue.nextTick(() => scrollToBottom());
    }
  }

  function saveDraft(convId) {
    if (convId && inputText.value) {
      store.inputDrafts[convId] = inputText.value;
    }
  }

  function restoreDraft(convId) {
    inputText.value = (convId && store.inputDrafts[convId]) || '';
  }

  return {
    inputText,
    attachments,
    uploading,
    atMenuVisible,
    atQuery,
    atMenuIndex,
    canSend,
    filteredAtRoles,
    handleInput,
    selectAtRole,
    handleKeydown,
    handlePaste,
    handleFileSelect,
    addFiles,
    removeAttachment,
    sendMessage,
    saveDraft,
    restoreDraft
  };
}
