export default {
  name: 'ChatHeader',
  template: `
    <header class="chat-header">
      <div class="chat-title">{{ headerTitle }}<span v-if="folderPath" class="chat-title-path">{{ folderPath }}</span></div>
      <div class="header-actions">
        <button
          v-if="store.currentConversation"
          class="mcp-toggle"
          :class="{ enabled: store.currentMcpEnabled }"
          @click="store.toggleMcp()"
          :title="store.currentMcpEnabled ? $t('chatHeader.mcpEnabled') : $t('chatHeader.mcpDisabled')"
        >
          <svg viewBox="0 0 24 24" width="14" height="14">
            <path fill="currentColor" d="M14.17 3.5a2.5 2.5 0 00-4.34 0L7.55 7H4a2 2 0 00-2 2v2a2 2 0 002 2h.09l1.21 6.07A2 2 0 007.26 21h9.48a2 2 0 001.96-1.93L19.91 13H20a2 2 0 002-2V9a2 2 0 00-2-2h-3.55l-2.28-3.5zM12 5.5l1.82 2.8.18.2H20v2h-2l-1.23 6.15a.5.5 0 01-.03.1l-.04.25H7.3l-1.21-6.07-.06-.43H4V8.5h5.82l.18-.2L12 5.5z"/>
          </svg>
          <span>MCP</span>
          <span class="mcp-status">{{ store.currentMcpEnabled ? 'ON' : 'OFF' }}</span>
        </button>
      </div>
      <!-- Compact Status Banner -->
      <div v-if="showCompactStatus" class="compact-status-banner" :class="compactStatusClass">
        <span v-if="store.compactStatus?.status === 'compacting'" class="compact-spinner"></span>
        <svg v-else class="compact-icon" viewBox="0 0 24 24" width="16" height="16">
          <path fill="currentColor" d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/>
        </svg>
        <span class="compact-message">{{ compactMessage }}</span>
      </div>
    </header>
  `,
  setup() {
    const store = Pinia.useChatStore();
    const t = Vue.inject('t');

    // 计算标题：优先会话标题，其次工作目录最后一段，最后显示产品名
    const headerTitle = Vue.computed(() => {
      if (!store.currentConversation) {
        return 'Claude Web Chat';
      }

      // 优先使用会话标题（最新用户消息）
      const title = store.getConversationTitle(store.currentConversation);
      if (title) {
        return title.length > 50 ? title.slice(0, 50) + '...' : title;
      }

      // 其次使用工作目录的最后一段
      if (store.currentWorkDir) {
        const parts = store.currentWorkDir.split(/[/\\]/);
        return parts[parts.length - 1] || parts[parts.length - 2] || store.currentWorkDir;
      }

      return t('chatHeader.newConv');
    });

    // Compact status display
    const showCompactStatus = Vue.computed(() => {
      if (!store.compactStatus) return false;
      // 只显示当前会话的 compact 状态
      return store.compactStatus.conversationId === store.currentConversation;
    });

    const compactStatusClass = Vue.computed(() => {
      if (!store.compactStatus) return '';
      return store.compactStatus.status === 'compacting' ? 'compacting' : 'completed';
    });

    const compactMessage = Vue.computed(() => {
      if (!store.compactStatus) return '';
      if (store.compactStatus.status === 'compacting') {
        return store.compactStatus.message || t('chatHeader.compacting');
      }
      return store.compactStatus.message || t('chatHeader.compactDone');
    });

    const folderPath = Vue.computed(() => {
      if (!store.currentConversation || !store.currentWorkDir) return '';
      return store.currentWorkDir;
    });

    return { store, headerTitle, folderPath, showCompactStatus, compactStatusClass, compactMessage };
  }
};
