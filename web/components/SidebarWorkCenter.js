export default {
  name: 'SidebarWorkCenter',
  props: {
    agents: { type: Array, default: () => [] },
    activeAgentId: { type: String, default: null },
    collapsed: { type: Boolean, default: false },
  },
  emits: ['open'],
  data() {
    return { expanded: false };
  },
  computed: {
    onlineAgents() {
      return this.agents.filter(agent => agent?.online);
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
    <section class="sidebar-work-center" :class="{ collapsed }">
      <button class="sidebar-work-center-trigger" type="button" @click="toggle"
              :aria-expanded="expanded ? 'true' : 'false'">
        <span class="sidebar-work-center-icon" aria-hidden="true">󰄲</span>
        <span v-if="!collapsed" class="sidebar-work-center-label">{{ tr('workCenter.title', 'Work Center') }}</span>
        <span v-if="!collapsed" class="sidebar-work-center-count">{{ onlineAgents.length }}</span>
        <span v-if="!collapsed" class="sidebar-work-center-chevron" :class="{ expanded }" aria-hidden="true">›</span>
      </button>
      <div v-if="expanded && !collapsed" class="sidebar-work-center-agents">
        <button v-for="agent in onlineAgents" :key="agent.id" type="button"
                class="sidebar-work-center-agent"
                :class="{ active: activeAgentId === agent.id }"
                @click="$emit('open', agent.id)">
          <span class="sidebar-work-center-agent-status" aria-hidden="true"></span>
          <span class="sidebar-work-center-agent-name">{{ agent.name || agent.id }}</span>
        </button>
        <p v-if="onlineAgents.length === 0" class="sidebar-work-center-empty">
          {{ tr('workCenter.noOnlineAgents', 'No online agents') }}
        </p>
      </div>
    </section>
  `,
};
