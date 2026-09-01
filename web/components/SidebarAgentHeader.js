/**
 * SidebarAgentHeader — shared Agent list and settings entry used by both
 * Session sidebars so their Agent controls cannot drift apart.
 */
export default {
  name: 'SidebarAgentHeader',
  props: {
    onlineAgents: { type: Array, required: true },
    onlineAgentCount: { type: Number, required: true },
    restartingAgents: { type: Object, default: () => ({}) },
    upgradingAgents: { type: Object, default: () => ({}) },
    showAgentActions: { type: Boolean, default: false },
  },
  emits: ['open-agent-settings', 'upgrade-agent'],
  data() {
    return { open: false };
  },
  created() {
    this._onDocClick = (event) => {
      if (!this.open) return;
      const target = event.target;
      if (target?.closest?.('.agent-header-controls')) return;
      this.open = false;
    };
    if (typeof document !== 'undefined') document.addEventListener('click', this._onDocClick, true);
  },
  beforeUnmount() {
    if (this._onDocClick && typeof document !== 'undefined') {
      document.removeEventListener('click', this._onDocClick, true);
    }
  },
  methods: {
    tr(key, fallback, params) {
      try {
        const value = this.$t ? this.$t(key, params) : key;
        return (value && value !== key) ? value : (fallback || key);
      } catch (_) { return fallback || key; }
    },
  },
  template: `
    <div class="agent-header-controls">
      <button
        type="button"
        class="sidebar-brand agent-dropdown-trigger"
        @click.stop="open = !open"
        :title="tr('chat.agent.manage', 'Manage agents')"
        :aria-expanded="open ? 'true' : 'false'"
        aria-haspopup="menu"
      >
        <span class="status-dot" :class="{ online: onlineAgentCount > 0 }"></span>
        <span class="brand-label">{{ tr('chat.agent.count', onlineAgentCount + ' agents', { count: onlineAgentCount }) }}</span>
        <svg class="dropdown-chevron" :class="{ open }" viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M7.41 8.59L12 13.17l4.59-4.58L18 10l-6 6-6-6z"/></svg>
      </button>
      <button
        type="button"
        class="agent-settings-icon-btn"
        @click.stop="$emit('open-agent-settings')"
        :title="tr('agentSettings.open', 'Agent settings')"
        :aria-label="tr('agentSettings.open', 'Agent settings')"
      >
        <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.07.62-.07.94s.02.64.07.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z"/></svg>
      </button>
      <div class="agent-dropdown" v-if="open" role="menu" @click.stop>
        <div v-for="agent in onlineAgents" :key="agent.id" class="agent-dropdown-item">
          <span class="status-dot" :class="{ online: agent.online, restarting: restartingAgents[agent.id], upgrading: upgradingAgents[agent.id] }"></span>
          <span class="agent-dropdown-name">{{ agent.name }}</span>
          <span class="agent-dropdown-version" v-if="agent.version">v{{ agent.version }}</span>
          <span class="agent-dropdown-status" v-if="restartingAgents[agent.id]">{{ tr('chat.agent.restarting', 'Restarting…') }}</span>
          <span class="agent-dropdown-status" v-else-if="upgradingAgents[agent.id]">{{ tr('chat.agent.upgrading', 'Upgrading…') }}</span>
          <button
            v-if="showAgentActions"
            type="button"
            class="agent-dropdown-upgrade-btn"
            @click.stop="$emit('upgrade-agent', agent.id)"
            :disabled="!agent.online || restartingAgents[agent.id] || upgradingAgents[agent.id]"
            :title="tr('chat.agent.upgrade', 'Upgrade')"
            :aria-label="tr('chat.agent.upgrade', 'Upgrade')"
          >
            <span v-if="upgradingAgents[agent.id]" class="spinner-mini"></span>
            <svg v-else viewBox="0 0 24 24" width="13" height="13" aria-hidden="true"><path fill="currentColor" d="M4 12l1.41 1.41L11 7.83V20h2V7.83l5.58 5.59L20 12l-8-8-8 8z"/></svg>
          </button>
        </div>
        <div v-if="onlineAgents.length === 0" class="agent-dropdown-empty">{{ tr('chat.agent.none', 'No agents online') }}</div>
      </div>
    </div>
  `,
};
