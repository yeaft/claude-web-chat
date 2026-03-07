export default {
  name: 'ChatHeader',
  emits: ['toggle-sidebar'],
  template: `
    <header class="chat-header">
      <!-- Mobile sidebar toggle (Chat mode) — hidden on desktop -->
      <button class="header-sidebar-toggle" v-if="!store.currentConversationIsCrew"
              @click="$emit('toggle-sidebar')">
        <svg viewBox="0 0 24 24" width="16" height="16">
          <path fill="currentColor" d="M3 18h18v-2H3v2zm0-5h18v-2H3v2zm0-7v2h18V6H3z"/>
        </svg>
      </button>
      <div class="chat-title-group">
        <div class="chat-title">{{ headerTitle }}</div>
        <div v-if="folderPath" class="chat-title-path">{{ folderPath }}</div>
      </div>
      <!-- Compact / Clear Status Banner -->
      <div v-if="showStatusBanner" class="compact-status-banner" :class="statusBannerClass">
        <span v-if="statusBannerSpinner" class="compact-spinner"></span>
        <svg v-else class="compact-icon" viewBox="0 0 24 24" width="16" height="16">
          <path fill="currentColor" d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/>
        </svg>
        <span class="compact-message">{{ statusBannerMessage }}</span>
      </div>
      <div class="header-right" v-if="store.currentConversation && !store.currentConversationIsCrew">
        <span class="context-usage-hint" v-if="contextUsage" :class="contextColorClass" :title="contextLabel">
          {{ contextUsage.percentage }}%
        </span>
        <button class="header-action-btn" :class="{ 'btn-loading': store.refreshingSession }" @click="refreshSession" :disabled="!canRefresh || store.refreshingSession" :title="$t('chatHeader.refresh')" v-if="canRefresh">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
          </svg>
        </button>
        <button class="header-action-btn" :class="{ 'btn-loading': isCompacting }" @click="compactContext" :disabled="isCompacting" :title="$t('chatHeader.compact')">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="8 4 12 8 16 4"/><line x1="4" y1="12" x2="20" y2="12"/><polyline points="8 20 12 16 16 20"/>
          </svg>
        </button>
        <button class="header-action-btn" :class="{ 'btn-loading': isClearing }" @click="clearMessages" :disabled="isClearing" :title="$t('chatHeader.clear')">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
          </svg>
        </button>
      </div>
      <div class="crew-header-left" v-if="store.currentConversationIsCrew">
        <button class="crew-header-nav-btn crew-sidebar-toggle"
                @click="$emit('toggle-sidebar')">
          <svg viewBox="0 0 24 24" width="16" height="16">
            <path fill="currentColor" d="M3 18h18v-2H3v2zm0-5h18v-2H3v2zm0-7v2h18V6H3z"/>
          </svg>
        </button>
        <button class="crew-header-nav-btn"
                :class="{ active: isCrewPanelActive('roles') }"
                @click="onCrewPanelToggle('roles')">
          <svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z"/></svg>
          <span v-if="hasStreamingRoles" class="active-dot"></span>
        </button>
        <button class="crew-header-nav-btn"
                :class="{ active: isCrewPanelActive('features') }"
                @click="onCrewPanelToggle('features')">
          <svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 16H5V5h14v14zM7 12h2v5H7zm4-3h2v8h-2zm4-3h2v11h-2z"/></svg>
          <span v-if="store.crewInProgressCount > 0" class="nav-badge">{{ store.crewInProgressCount }}</span>
        </button>
      </div>
      <div class="crew-header-right" v-if="store.currentConversationIsCrew">
        <button class="crew-header-nav-btn"
                :class="{ 'btn-loading': store.refreshingSession }"
                @click="refreshSession"
                :disabled="!canRefresh || store.refreshingSession"
                :title="$t('chatHeader.refresh')"
                v-if="canRefresh">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
          </svg>
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

    // Unified status banner: shows compact or clear status
    const showStatusBanner = Vue.computed(() => {
      if (store.clearStatus?.conversationId === store.currentConversation) return true;
      if (!store.compactStatus) return false;
      return store.compactStatus.conversationId === store.currentConversation;
    });

    const statusBannerClass = Vue.computed(() => {
      // Clear status takes priority when active
      if (store.clearStatus?.conversationId === store.currentConversation) {
        return store.clearStatus.status === 'clearing' ? 'compacting' : 'completed';
      }
      if (!store.compactStatus) return '';
      return store.compactStatus.status === 'compacting' ? 'compacting' : 'completed';
    });

    const statusBannerSpinner = Vue.computed(() => {
      if (store.clearStatus?.conversationId === store.currentConversation) {
        return store.clearStatus.status === 'clearing';
      }
      return store.compactStatus?.status === 'compacting';
    });

    const statusBannerMessage = Vue.computed(() => {
      if (store.clearStatus?.conversationId === store.currentConversation) {
        if (store.clearStatus.status === 'clearing') {
          return t('chatHeader.clearing');
        }
        return t('chatHeader.clearDone');
      }
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

    const isCompacting = Vue.computed(() => {
      return store.compactStatus?.status === 'compacting'
        && store.compactStatus?.conversationId === store.currentConversation;
    });

    const isClearing = Vue.computed(() => {
      return store.clearStatus?.status === 'clearing'
        && store.clearStatus?.conversationId === store.currentConversation;
    });

    const canRefresh = Vue.computed(() => {
      if (!store.currentConversation) return false;
      return !store.processingConversations[store.currentConversation]
        && !store.refreshingSession;
    });

    const refreshSession = () => {
      if (!canRefresh.value) return;
      store.refreshingSession = true;
      store.messages = [];
      store.sendWsMessage({
        type: 'sync_messages',
        conversationId: store.currentConversation,
        turns: 5
      });
    };

    const compactContext = () => {
      if (isCompacting.value) return;
      store.sendMessage('/compact');
    };

    const clearMessages = () => {
      if (isClearing.value) return;
      if (!confirm(t('chatHeader.confirmClear'))) return;
      store.clearStatus = {
        conversationId: store.currentConversation,
        status: 'clearing'
      };
      store.sendMessage('/clear');
    };

    const onCrewPanelToggle = (panel) => {
      if (window.innerWidth < 768) {
        store.toggleCrewMobilePanel(panel);
      } else {
        store.toggleCrewPanel(panel);
      }
    };

    const isCrewPanelActive = (panel) => {
      if (window.innerWidth < 768) {
        return store.crewMobilePanel === panel;
      }
      return store.crewPanelVisible[panel];
    };

    return { store, headerTitle, folderPath, showStatusBanner, statusBannerClass, statusBannerSpinner, statusBannerMessage, contextUsage, contextColorClass, contextLabel, hasStreamingRoles, isCompacting, isClearing, canRefresh, refreshSession, compactContext, clearMessages, onCrewPanelToggle, isCrewPanelActive };
  }
};
