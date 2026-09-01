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
      <div class="agent-dropdown" v-if="open" role="menu" @click.stop>
        <div class="agent-dropdown-list">
          <div v-for="agent in onlineAgents" :key="agent.id" class="agent-dropdown-item">
            <span class="status-dot" :class="{ online: agent.online, restarting: restartingAgents[agent.id], upgrading: upgradingAgents[agent.id] }"></span>
            <span class="agent-dropdown-name">{{ agent.name }}</span>
            <span class="agent-dropdown-meta">
              <span class="agent-dropdown-status" v-if="restartingAgents[agent.id]">{{ tr('chat.agent.restarting', 'Restarting…') }}</span>
              <span class="agent-dropdown-status" v-else-if="upgradingAgents[agent.id]">{{ tr('chat.agent.upgrading', 'Upgrading…') }}</span>
              <span class="agent-dropdown-version" v-else-if="agent.version">v{{ agent.version }}</span>
            </span>
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
        <button
          type="button"
          class="agent-dropdown-settings-option"
          @click.stop="open = false; $emit('open-agent-settings')"
        >
          {{ tr('agentSettings.open', 'Agent settings') }}
        </button>
      </div>
    </div>
  `,
};
