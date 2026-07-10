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
      return this.agents.filter(agent => agent?.online);
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
      <button class="sidebar-work-center-trigger" type="button" @click="toggle"
              :class="{ active }" :aria-expanded="expanded ? 'true' : 'false'">
        <svg class="sidebar-work-center-icon" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
          <path fill="currentColor" d="M19 3h-3.18A3 3 0 0 0 13 1h-2a3 3 0 0 0-2.82 2H5a2 2 0 0 0-2 2v15a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2Zm-8-1h2a1 1 0 0 1 1 1h-4a1 1 0 0 1 1-1Zm8 18H5V5h2v2h10V5h2v15Zm-9.7-3.3-2.5-2.5 1.4-1.4 1.1 1.08 3.5-3.5 1.4 1.42-4.9 4.9Z"/>
        </svg>
        <span v-if="!collapsed" class="sidebar-work-center-label">{{ tr('workCenter.title', 'Work Center') }}</span>
        <svg v-if="!collapsed" class="sidebar-work-center-chevron" :class="{ expanded }"
             viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
          <path fill="currentColor" d="m9 18 6-6-6-6-1.4 1.4 4.6 4.6-4.6 4.6L9 18Z"/>
        </svg>
      </button>
      <div v-if="expanded && !collapsed" class="sidebar-work-center-agents">
        <button v-for="agent in onlineAgents" :key="agent.id" type="button"
                class="sidebar-work-center-agent"
                :class="{ active: activeAgentId === agent.id }"
                @click="$emit('open', agent.id)">
          <span class="sidebar-work-center-agent-status" aria-hidden="true"></span>
          <span class="sidebar-work-center-agent-name">{{ agent.name || agent.id }}</span>
          <svg v-if="activeAgentId === agent.id" viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
            <path fill="currentColor" d="m9 18 6-6-6-6-1.4 1.4 4.6 4.6-4.6 4.6L9 18Z"/>
          </svg>
        </button>
        <p v-if="onlineAgents.length === 0" class="sidebar-work-center-empty">
          {{ tr('workCenter.noOnlineAgents', 'No online agents') }}
        </p>
      </div>
    </section>
  `,
};
