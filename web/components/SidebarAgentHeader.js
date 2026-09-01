/**
 * SidebarAgentHeader — shared Agent Settings trigger used by both ChatPage
 * and YeaftSidebar so the two Session sidebars cannot drift apart.
 *
 * Renders only the left-hand brand block (status dot and "N agents" label).
 * The right-hand actions stay in each parent because they differ per page.
 */
export default {
  name: 'SidebarAgentHeader',
  props: {
    onlineAgentCount: { type: Number, required: true },
  },
  emits: ['open-agent-settings'],
  methods: {
    tr(key, fallback, params) {
      try {
        const v = this.$t ? this.$t(key, params) : key;
        return (v && v !== key) ? v : (fallback || key);
      } catch (_) { return fallback || key; }
    },
  },
  template: `
    <button
      type="button"
      class="sidebar-brand agent-settings-trigger"
      @click="$emit('open-agent-settings')"
      :title="tr('agentSettings.open', 'Agent settings')"
    >
      <span class="status-dot" :class="{ online: onlineAgentCount > 0 }"></span>
      <span class="brand-label">{{ tr('chat.agent.count', onlineAgentCount + ' agents', { count: onlineAgentCount }) }}</span>
    </button>
  `,
};
