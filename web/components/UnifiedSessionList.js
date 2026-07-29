import { shortenPath } from '../utils/path-display.js';

export default {
  name: 'UnifiedSessionList',
  props: {
    sessions: { type: Array, default: () => [] },
    activeCatalogKey: { type: String, default: null },
  },
  emits: ['select', 'create'],
  methods: {
    providerLabel(row) {
      if (row.runtimeProvider === 'yeaft') return 'Yeaft';
      if (row.runtimeProvider === 'copilot') return 'Copilot';
      return 'Claude Code';
    },
    secondaryLabel(row) {
      const parts = [];
      if (row.agentName) parts.push(row.agentName);
      parts.push(this.providerLabel(row));
      return parts.join(' · ');
    },
    shortPath(path) {
      return shortenPath(path || '');
    },
  },
  template: `
    <div class="us-scroll us-scroll-flush">
      <div class="session-tab-bar">
        <div class="session-tab session-tab-solo active">
          <svg class="session-tab-icon" viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H6l-2 2V4h16v12z"/></svg>
          <span>{{ $t('yeaft.session.title') }}</span>
          <span class="session-tab-count" v-if="sessions.length">{{ sessions.length }}</span>
          <button type="button" class="session-tab-add-btn" :title="$t('yeaft.session.new')" @click.stop="$emit('create')">
            <svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>
          </button>
        </div>
      </div>
      <div class="session-panels">
        <div class="session-panel-list">
          <div
            v-for="row in sessions"
            :key="row.catalogKey"
            role="button"
            tabindex="0"
            class="session-item"
            :class="{ active: row.catalogKey === activeCatalogKey, pinned: row.pinned }"
            @click="$emit('select', row)"
            @keydown.enter.prevent="$emit('select', row)"
            @keydown.space.prevent="$emit('select', row)"
          >
            <span v-if="row.pinned" class="session-pin-icon"><svg viewBox="0 0 24 24"><path fill="currentColor" d="M16 12V4h1V2H7v2h1v8l-2 2v2h5.2v6h1.6v-6H18v-2l-2-2z"/></svg></span>
            <span class="session-item-main">
              <span class="session-item-header"><span class="title">{{ row.title }}</span></span>
              <span class="session-info">
                <span class="session-path" v-if="row.workDir">{{ shortPath(row.workDir) }}</span>
                <span class="session-agent">{{ secondaryLabel(row) }}</span>
              </span>
            </span>
          </div>
          <div v-if="sessions.length === 0" class="session-empty-hint">{{ $t('yeaft.session.empty') }}</div>
        </div>
      </div>
    </div>
  `,
};
