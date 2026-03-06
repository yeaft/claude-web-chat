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
      <div class="header-right" v-if="store.currentConversation && !store.currentConversationIsCrew">
        <span class="context-usage-hint" v-if="contextUsage" :class="contextColorClass" :title="contextLabel">
          {{ contextUsage.percentage }}%
        </span>
      </div>
      <div class="crew-header-nav" v-if="store.currentConversationIsCrew">
        <button class="crew-header-nav-btn"
                :class="{ active: store.crewMobilePanel === 'roles' }"
                @click="store.toggleCrewMobilePanel('roles')">
          <svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z"/></svg>
          <span v-if="hasStreamingRoles" class="active-dot"></span>
        </button>
        <button class="crew-header-nav-btn"
                :class="{ active: store.crewMobilePanel === 'features' }"
                @click="store.toggleCrewMobilePanel('features')">
          <svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 16H5V5h14v14zM7 12h2v5H7zm4-3h2v8h-2zm4-3h2v11h-2z"/></svg>
          <span v-if="store.crewInProgressCount > 0" class="nav-badge">{{ store.crewInProgressCount }}</span>
        </button>
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

    const contextUsage = Vue.computed(() => {
      if (!store.contextUsage) return null;
      if (store.contextUsage.conversationId !== store.currentConversation) return null;
      return store.contextUsage;
    });
    const contextColorClass = Vue.computed(() => {
      const pct = contextUsage.value?.percentage || 0;
      if (pct >= 80) return 'context-danger';
      if (pct >= 50) return 'context-warn';
      return 'context-ok';
    });
    const contextLabel = Vue.computed(() => {
      if (!contextUsage.value) return '';
      const used = (contextUsage.value.inputTokens / 1000).toFixed(0);
      const total = (contextUsage.value.maxTokens / 1000).toFixed(0);
      return `Context: ${used}k / ${total}k`;
    });

    const hasStreamingRoles = Vue.computed(() => {
      const activeRoles = store.currentCrewStatus?.activeRoles;
      return activeRoles && activeRoles.length > 0;
    });

    return { store, headerTitle, folderPath, showCompactStatus, compactStatusClass, compactMessage, contextUsage, contextColorClass, contextLabel, hasStreamingRoles };
  }
};
