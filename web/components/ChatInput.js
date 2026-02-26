// 默认的 slash commands 列表（在 Claude SDK 返回动态列表前使用）
const DEFAULT_SLASH_COMMANDS = [
  '/compact', '/context', '/cost', '/init', '/doctor',
  '/memory', '/model', '/review', '/mcp', '/skills'
];

export default {
  name: 'ChatInput',
  template: `
    <footer class="input-area" ref="inputAreaRef">
      <div class="queue-panel" v-if="store.currentQueue.length > 0">
        <div class="queue-panel-header">
          <span class="queue-panel-title">{{ $t('chatInput.queuedMessages', { count: store.currentQueue.length }) }}</span>
        </div>
        <div class="queue-panel-list">
          <div class="queue-panel-item" v-for="(item, idx) in store.currentQueue" :key="item.id">
            <div class="queue-item-num">{{ idx + 1 }}</div>
            <span class="queue-item-text">{{ item.prompt }}</span>
            <button class="queue-item-cancel" @click="store.cancelQueuedMessage(item.id)" :title="$t('message.cancelQueue')">
              <svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
            </button>
          </div>
        </div>
      </div>
      <div class="attachments-preview" v-if="attachments.length > 0">
        <div class="attachment-item" v-for="(file, index) in attachments" :key="index">
          <img v-if="file.preview" :src="file.preview" class="attachment-thumb" />
          <span v-else class="attachment-icon">\u{1F4CE}</span>
          <span class="attachment-name">{{ file.name }}</span>
          <button class="attachment-remove" @click="removeAttachment(index)">&times;</button>
        </div>
      </div>
      <div class="input-wrapper">
        <input
          type="file"
          ref="fileInput"
          @change="handleFileSelect"
          multiple
          accept="image/*,text/*,.pdf,.doc,.docx,.xls,.xlsx,.json,.md,.py,.js,.ts,.css,.html"
          style="display: none;"
        />
        <button class="attach-btn" @click="triggerFileSelect" :title="$t('chatInput.upload')">
          <svg viewBox="0 0 24 24" width="20" height="20">
            <path d="M16.5 6v11.5c0 2.21-1.79 4-4 4s-4-1.79-4-4V5c0-1.38 1.12-2.5 2.5-2.5s2.5 1.12 2.5 2.5v10.5c0 .55-.45 1-1 1s-1-.45-1-1V6H10v9.5c0 1.38 1.12 2.5 2.5 2.5s2.5-1.12 2.5-2.5V5c0-2.21-1.79-4-4-4S7 2.79 7 5v12.5c0 3.04 2.46 5.5 5.5 5.5s5.5-2.46 5.5-5.5V6h-1.5z"/>
          </svg>
        </button>
        <div class="textarea-wrapper">
          <div class="slash-autocomplete" v-if="showAutocomplete && filteredCommands.length > 0" ref="autocompleteRef">
            <div
              class="slash-autocomplete-item"
              v-for="(cmd, index) in filteredCommands"
              :key="cmd"
              :class="{ active: index === selectedIndex }"
              @mousedown.prevent="selectCommand(cmd)"
              @mouseenter="selectedIndex = index"
            >{{ cmd }}</div>
          </div>
          <textarea
            ref="inputRef"
            v-model="inputText"
            @input="handleInput"
            @keydown="handleKeydown"
            @paste="handlePaste"
            @blur="onBlur"
            :placeholder="store.isProcessing ? $t('chatInput.placeholderQueue') : $t('chatInput.placeholder')"
            rows="1"
          ></textarea>
        </div>
        <button
          v-if="store.isProcessing"
          class="send-btn stop-btn"
          @click="cancelExecution"
          :title="queueCount > 0 ? $t('chatInput.stopWithQueue', { count: queueCount }) : $t('chatInput.stop')"
        >
          <svg viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>
          <span v-if="queueCount > 0" class="queue-count">{{ queueCount }}</span>
        </button>
        <button
          class="send-btn"
          :class="{ 'queue-send': store.isProcessing && canSend }"
          @click="send"
          :disabled="!canSend"
          :title="store.isProcessing ? $t('chatInput.queueSend') : $t('chatInput.send')"
        >
          <svg v-if="store.isProcessing && canSend" viewBox="0 0 24 24">
            <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/>
            <circle cx="19" cy="5" r="4.5" fill="currentColor" stroke="var(--bg-main)" stroke-width="1.5"/>
            <path d="M17 5h4M19 3v4" stroke="var(--bg-main)" stroke-width="1.5" stroke-linecap="round"/>
          </svg>
          <svg v-else viewBox="0 0 24 24"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>
        </button>
      </div>
    </footer>
  `,
  setup() {
    const store = Pinia.useChatStore();
    const authStore = Pinia.useAuthStore();
    const inputText = Vue.ref('');
    const inputRef = Vue.ref(null);
    const fileInput = Vue.ref(null);
    const attachments = Vue.ref([]); // { file, name, preview?, uploading, fileId? }
    const uploading = Vue.ref(false);
    const inputAreaRef = Vue.ref(null);
    const autocompleteRef = Vue.ref(null);

    // Slash command 自动补全状态
    const showAutocomplete = Vue.ref(false);
    const selectedIndex = Vue.ref(0);

    // 获取可用的 slash commands（确保都有 / 前缀）
    const availableCommands = Vue.computed(() => {
      const dynamic = store.slashCommands || [];
      const commands = dynamic.length > 0 ? dynamic : DEFAULT_SLASH_COMMANDS;
      return commands.map(cmd => cmd.startsWith('/') ? cmd : '/' + cmd);
    });

    // 根据输入过滤命令
    const filteredCommands = Vue.computed(() => {
      const text = inputText.value.trim();
      if (!text.startsWith('/')) return [];
      const prefix = text.toLowerCase();
      return availableCommands.value.filter(cmd =>
        cmd.toLowerCase().startsWith(prefix) && cmd.toLowerCase() !== prefix
      );
    });

    const canSend = Vue.computed(() => {
      const hasContent = inputText.value.trim() || attachments.value.length > 0;
      const notUploading = !uploading.value && attachments.value.every(a => a.fileId);
      return hasContent && store.currentAgent && store.currentConversation && notUploading;
    });

    const queueCount = Vue.computed(() => store.currentQueue.length);

    const autoResize = () => {
      const textarea = inputRef.value;
      if (textarea) {
        textarea.style.height = 'auto';
        textarea.style.height = Math.min(textarea.scrollHeight, 120) + 'px';
      }
    };

    const handleInput = () => {
      autoResize();
      // 检查是否应显示自动补全
      const text = inputText.value.trim();
      if (text.startsWith('/') && !text.includes(' ')) {
        showAutocomplete.value = true;
        selectedIndex.value = 0;
      } else {
        showAutocomplete.value = false;
      }
    };

    const selectCommand = (cmd) => {
      inputText.value = cmd + ' ';
      showAutocomplete.value = false;
      Vue.nextTick(() => {
        inputRef.value?.focus();
      });
    };

    const onBlur = () => {
      // 延迟关闭以允许 mousedown 事件触发
      setTimeout(() => {
        showAutocomplete.value = false;
      }, 150);
    };

    const triggerFileSelect = (e) => {
      e?.preventDefault();
      e?.stopPropagation();
      fileInput.value?.click();
    };

    const handleFileSelect = async (e) => {
      const files = Array.from(e.target.files || []);
      if (files.length > 0) {
        await addFiles(files);
      }
      e.target.value = '';
      Vue.nextTick(() => {
        inputRef.value?.focus();
      });
    };

    const handlePaste = async (e) => {
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
        await addFiles(files);
      }
    };

    const addFiles = async (files) => {
      for (const file of files) {
        const attachment = {
          file,
          name: file.name,
          preview: null,
          uploading: true,
          fileId: null
        };

        if (file.type.startsWith('image/')) {
          attachment.preview = URL.createObjectURL(file);
        }

        attachments.value.push(attachment);
      }

      uploading.value = true;
      try {
        const formData = new FormData();
        for (const file of files) {
          formData.append('files', file);
        }

        const headers = {};
        if (authStore.token) {
          headers['Authorization'] = `Bearer ${authStore.token}`;
        }
        const response = await fetch('/api/upload', {
          method: 'POST',
          headers,
          body: formData
        });

        if (!response.ok) {
          throw new Error('Upload failed');
        }

        const result = await response.json();

        let resultIndex = 0;
        for (const attachment of attachments.value) {
          if (attachment.uploading && !attachment.fileId) {
            if (resultIndex < result.files.length) {
              attachment.fileId = result.files[resultIndex].fileId;
              attachment.uploading = false;
              resultIndex++;
            }
          }
        }
      } catch (error) {
        console.error('Upload error:', error);
        const failed = attachments.value.filter(a => !a.fileId);
        for (const f of failed) {
          if (f.preview) URL.revokeObjectURL(f.preview);
        }
        attachments.value = attachments.value.filter(a => a.fileId);
      } finally {
        uploading.value = false;
        Vue.nextTick(() => {
          inputRef.value?.focus();
        });
      }
    };

    const removeAttachment = (index) => {
      const attachment = attachments.value[index];
      if (attachment.preview) {
        URL.revokeObjectURL(attachment.preview);
      }
      attachments.value.splice(index, 1);
      Vue.nextTick(() => {
        inputRef.value?.focus();
      });
    };

    const send = () => {
      if (!canSend.value) return;

      showAutocomplete.value = false;

      const attachmentInfos = attachments.value
        .filter(a => a.fileId)
        .map(a => ({
          fileId: a.fileId,
          name: a.name,
          preview: a.preview,
          isImage: a.file?.type?.startsWith('image/') || false,
          mimeType: a.file?.type || ''
        }));

      store.sendMessage(inputText.value, attachmentInfos);

      attachments.value = [];
      inputText.value = '';

      if (inputRef.value) {
        inputRef.value.style.height = 'auto';
      }
    };

    const handleKeydown = (e) => {
      // 自动补全激活时的键盘导航
      if (showAutocomplete.value && filteredCommands.value.length > 0) {
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          selectedIndex.value = (selectedIndex.value + 1) % filteredCommands.value.length;
          return;
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          selectedIndex.value = (selectedIndex.value - 1 + filteredCommands.value.length) % filteredCommands.value.length;
          return;
        }
        if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
          e.preventDefault();
          selectCommand(filteredCommands.value[selectedIndex.value]);
          return;
        }
        if (e.key === 'Escape') {
          e.preventDefault();
          showAutocomplete.value = false;
          return;
        }
      }

      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        send();
      }
    };

    const cancelExecution = () => {
      store.cancelExecution();
    };

    return {
      store,
      inputText,
      inputRef,
      inputAreaRef,
      fileInput,
      attachments,
      uploading,
      canSend,
      queueCount,
      showAutocomplete,
      selectedIndex,
      filteredCommands,
      autocompleteRef,
      autoResize,
      handleInput,
      selectCommand,
      onBlur,
      triggerFileSelect,
      handleFileSelect,
      handlePaste,
      removeAttachment,
      send,
      handleKeydown,
      cancelExecution
    };
  }
};
