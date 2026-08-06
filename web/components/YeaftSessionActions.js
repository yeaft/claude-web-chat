export default {
  name: 'YeaftSessionActions',
  emits: ['toggle-search', 'reload-messages', 'toggle-session-status', 'reload-page'],
  props: {
    searchOpen: { type: Boolean, default: false },
    loadingMoreHistory: { type: Boolean, default: false },
    sessionStatusVisible: { type: Boolean, default: true },
    showPageReload: { type: Boolean, default: false },
  },
  template: `
    <div class="yeaft-session-actions">
      <button
        ref="searchButtonRef"
        type="button"
        class="yeaft-search-btn"
        :class="{ active: searchOpen }"
        @click="$emit('toggle-search')"
        :title="$t('yeaft.historySearch.button')"
        :aria-label="$t('yeaft.historySearch.button')"
        :aria-expanded="searchOpen ? 'true' : 'false'"
        aria-controls="yeaft-conversation-outline"
      >
        <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>
      </button>
      <!-- Message refresh — replays current Yeaft session history without a full page reload. -->
      <button
        class="yeaft-reload-btn"
        :class="{ 'is-loading': loadingMoreHistory }"
        @click="$emit('reload-messages')"
        :disabled="loadingMoreHistory"
        :aria-busy="loadingMoreHistory ? 'true' : 'false'"
        :title="$t('yeaft.reloadMessages')"
        :aria-label="$t('yeaft.reloadMessages')"
      >
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
        </svg>
      </button>
      <button
        class="yeaft-topbar-vp-toggle"
        :class="{ active: sessionStatusVisible }"
        @click="$emit('toggle-session-status')"
        :title="sessionStatusVisible ? $t('yeaft.sessionStatus.hide') : $t('yeaft.sessionStatus.show')"
        :aria-label="sessionStatusVisible ? $t('yeaft.sessionStatus.hide') : $t('yeaft.sessionStatus.show')"
        :aria-expanded="sessionStatusVisible ? 'true' : 'false'"
      >
        <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <rect x="3" y="4" width="18" height="16" rx="3"/>
          <path d="M8 9h8"/>
          <path d="M8 14h5"/>
        </svg>
      </button>
      <!-- Page refresh is a mobile-only escape hatch; desktop keeps the header focused on session actions. -->
      <button
        v-if="showPageReload"
        class="yeaft-reload-btn yeaft-page-reload-btn"
        @click="$emit('reload-page')"
        :title="$t('yeaft.reloadPage')"
        :aria-label="$t('yeaft.reloadPage')"
      >
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <polyline points="23 20 23 14 17 14"/><polyline points="1 4 1 10 7 10"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>
        </svg>
      </button>
    </div>
  `,
};
