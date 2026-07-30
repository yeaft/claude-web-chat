export default {
  name: 'SidebarWorkCenter',
  props: {
    agents: { type: Array, default: () => [] },
    activeAgentId: { type: String, default: null },
    collapsed: { type: Boolean, default: false },
    active: { type: Boolean, default: false },
    defaultExpanded: { type: Boolean, default: false },
  },
  emits: ['open'],
  data() {
    return { expanded: this.defaultExpanded };
  },
  computed: {
    onlineAgents() {
      return this.agents.filter(agent => agent?.online
        && Array.isArray(agent.capabilities) && agent.capabilities.includes('work_center'));
    },
  },
  watch: {
    defaultExpanded(value) {
      if (value) this.expanded = true;
    },
  },
  methods: {
    tr(key, fallback) {
      const translated = this.$t ? this.$t(key) : key;
      return translated && translated !== key ? translated : fallback;
    },
    toggle() {
      if (this.collapsed) {
        const target = this.onlineAgents.find(agent => agent.id === this.activeAgentId) || this.onlineAgents[0];
        if (target) this.$emit('open', target.id);
        return;
      }
      this.expanded = !this.expanded;
    },
  },
  template: `
    <section class="sidebar-work-center" :class="{ collapsed, active }">
      <div class="session-tab-bar sidebar-work-center-tab-bar">
        <button class="session-tab session-tab-solo sidebar-work-center-trigger" type="button" @click="toggle"
                :class="{ active }" :disabled="onlineAgents.length === 0"
                :aria-expanded="expanded ? 'true' : 'false'">
          <svg class="session-tab-icon sidebar-work-center-icon" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
            <path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" d="M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01"/>
          </svg>
          <span v-if="!collapsed" class="sidebar-work-center-label">{{ tr('workCenter.title', 'Work Center') }}</span>
          <span v-if="!collapsed && onlineAgents.length" class="session-tab-count">{{ onlineAgents.length }}</span>
          <svg v-if="!collapsed" class="sidebar-work-center-chevron" :class="{ expanded }"
               viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
            <path fill="currentColor" d="m9 18 6-6-6-6-1.4 1.4 4.6 4.6-4.6 4.6L9 18Z"/>
          </svg>
        </button>
      </div>
      <div v-if="expanded && !collapsed" class="session-panels sidebar-work-center-agents">
        <div class="session-panel-list sidebar-work-center-agent-list">
          <button v-for="agent in onlineAgents" :key="agent.id" type="button"
                  class="session-item sidebar-work-center-agent"
                  :class="{ active: activeAgentId === agent.id }"
                  @click="$emit('open', agent.id)">
            <span class="session-item-header">
              <span class="sidebar-work-center-agent-status" aria-hidden="true"></span>
              <span class="title sidebar-work-center-agent-name">{{ agent.name || agent.id }}</span>
            </span>
          </button>
          <p v-if="onlineAgents.length === 0" class="sidebar-work-center-empty">
            {{ tr('workCenter.noAvailableAgents', 'No compatible online Agents') }}
          </p>
        </div>
      </div>
    </section>
  `,
};
