export default {
  name: 'ChatHeader',
  template: `
    <header class="chat-header">
      <div class="chat-title-group">
        <div class="chat-title">{{ headerTitle }}</div>
        <div v-if="folderPath" class="chat-title-path">{{ folderPath }}</div>
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

    const headerTitle = Vue.computed(() => {
      if (!store.currentConversation) {
        return 'Claude Web Chat';
      }

      // Crew conversation
      if (store.currentConversationIsCrew) {
        return 'Crew Session';
      }

      const title = store.getConversationTitle(store.currentConversation);
      if (title) {
        return title;
      }

      if (store.currentWorkDir) {
        const parts = store.currentWorkDir.split(/[/\\]/);
        return parts[parts.length - 1] || parts[parts.length - 2] || store.currentWorkDir;
      }

      return t('chatHeader.newConv');
    });

    const showCompactStatus = Vue.computed(() => {
      if (!store.compactStatus) return false;
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
