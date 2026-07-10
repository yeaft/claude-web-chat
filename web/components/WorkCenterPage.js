import SidebarAgentHeader from './SidebarAgentHeader.js';
import SidebarWorkCenter from './SidebarWorkCenter.js';

export default {
  name: 'WorkCenterPage',
  components: { SidebarAgentHeader, SidebarWorkCenter },
  data() {
    return {
      selectedId: null,
      createOpen: false,
      saving: false,
      filter: 'open',
      search: '',
      form: {
        title: '',
        goal: '',
        acceptanceCriteriaText: '',
        workDir: '',
        start: true,
      },
    };
  },
  computed: {
    store() { return Pinia.useChatStore(); },
    agentId() { return this.store.workCenterAgentId || this.store.currentAgent; },
    agents() { return this.store.agents || []; },
    onlineAgents() { return this.agents.filter(agent => agent?.online); },
    agent() { return this.agents.find(agent => agent.id === this.agentId) || null; },
    items() { return this.store.workCenterItemsByAgent[this.agentId] || []; },
    loading() { return !!this.store.workCenterLoadingByAgent[this.agentId]; },
    error() { return this.store.workCenterErrorByAgent[this.agentId] || null; },
    detail() { return this.store.workCenterDetailByAgent[this.agentId] || null; },
    selected() {
      if (this.detail?.id === this.selectedId) return this.detail;
      return this.items.find(item => item.id === this.selectedId) || null;
    },
    visibleItems() {
      const q = this.search.trim().toLowerCase();
      return this.items.filter(item => {
        if (this.filter === 'open' && ['done', 'cancelled'].includes(item.status)) return false;
        if (this.filter === 'done' && item.status !== 'done') return false;
        if (!q) return true;
        return String(item.title || '').toLowerCase().includes(q)
          || String(item.goal || '').toLowerCase().includes(q);
      });
    },
  },
  watch: {
    agentId: {
      immediate: true,
      handler(id) {
        this.selectedId = null;
        if (id) this.store.listWorkItems(id).catch(() => {});
      },
    },
  },
  methods: {
    tr(key, fallback) {
      const translated = this.$t ? this.$t(key) : key;
      return translated && translated !== key ? translated : fallback;
    },
    agentName(agentId) {
      const agent = this.agents.find(item => item.id === agentId);
      return agent?.name || agentId || this.tr('workCenter.agent', 'Agent');
    },
    statusLabel(status) {
      return this.tr(`workCenter.status.${status}`, String(status || '').replace('_', ' '));
    },
    actionLabel(type) {
      return this.tr(`workCenter.action.${type}`, type || '—');
    },
    time(value) {
      if (!value) return '';
      try { return new Date(Number(value)).toLocaleString(); } catch { return ''; }
    },
    openAgent(agentId) {
      this.store.enterWorkCenter(agentId);
    },
    refresh() {
      return this.store.listWorkItems(this.agentId).catch(() => {});
    },
    async selectItem(item) {
      this.selectedId = item.id;
      try { await this.store.getWorkItem(item.id, this.agentId); } catch {}
    },
    closeCreate() {
      if (!this.saving) this.createOpen = false;
    },
    async submitCreate() {
      if (!this.form.title.trim() || !this.form.goal.trim()) return;
      this.saving = true;
      try {
        const detail = await this.store.createWorkItem({
          title: this.form.title.trim(),
          goal: this.form.goal.trim(),
          acceptanceCriteria: this.form.acceptanceCriteriaText
            .split('\n').map(value => value.trim()).filter(Boolean),
          workDir: this.form.workDir.trim(),
          workflowTemplate: 'software-change',
          start: this.form.start,
        }, this.agentId);
        this.selectedId = detail.id;
        this.form = { title: '', goal: '', acceptanceCriteriaText: '', workDir: '', start: true };
        this.createOpen = false;
      } finally {
        this.saving = false;
      }
    },
    async startSelected() {
      if (!this.selected) return;
      await this.store.startWorkItem(this.selected.id, this.agentId);
    },
    async retrySelected() {
      if (!this.selected) return;
      await this.store.retryWorkItem(this.selected.id, this.agentId);
    },
    async cancelSelected() {
      if (!this.selected) return;
      await this.store.cancelWorkItem(this.selected.id, this.agentId);
    },
  },
  template: `
    <div class="work-center-page">
      <aside class="sidebar work-center-sidebar" :class="{ collapsed: store.sidebarCollapsed }">
        <div v-if="!store.sidebarCollapsed" class="sidebar-top">
          <div class="sidebar-header-row">
            <SidebarAgentHeader
              :online-agents="onlineAgents"
              :online-agent-count="onlineAgents.length"
              :show-agent-actions="false"
            />
          </div>
        </div>
        <SidebarWorkCenter
          :agents="agents"
          :active-agent-id="agentId"
          :collapsed="store.sidebarCollapsed"
          @open="openAgent"
        />
        <div v-if="!store.sidebarCollapsed" class="work-center-sidebar-actions">
          <button class="btn-primary" type="button" @click="createOpen = true">
            {{ tr('workCenter.newWorkItem', 'New work item') }}
          </button>
          <button class="btn-ghost" type="button" @click="store.leaveWorkCenter()">
            {{ tr('workCenter.backToChat', 'Back to chat') }}
          </button>
        </div>
        <button class="sidebar-collapse-btn" type="button" @click="store.toggleSidebar()"
                :aria-label="store.sidebarCollapsed ? tr('sidebar.expand', 'Expand sidebar') : tr('sidebar.collapse', 'Collapse sidebar')">
          {{ store.sidebarCollapsed ? '›' : '‹' }}
        </button>
      </aside>

      <main class="work-center-main">
        <header class="work-center-header">
          <div>
            <p class="work-center-eyebrow">{{ agentName(agentId) }}</p>
            <h1>{{ tr('workCenter.title', 'Work Center') }}</h1>
            <p>{{ tr('workCenter.subtitle', 'Persistent work owned by this Agent') }}</p>
          </div>
          <button class="btn-secondary" type="button" @click="refresh" :disabled="loading">
            {{ tr('workCenter.refresh', 'Refresh') }}
          </button>
        </header>

        <div class="work-center-toolbar">
          <input v-model="search" type="search" :placeholder="tr('workCenter.search', 'Search work items')">
          <select v-model="filter" :aria-label="tr('workCenter.filter', 'Filter')">
            <option value="open">{{ tr('workCenter.filterOpen', 'Open') }}</option>
            <option value="all">{{ tr('workCenter.filterAll', 'All') }}</option>
            <option value="done">{{ tr('workCenter.filterDone', 'Done') }}</option>
          </select>
        </div>

        <p v-if="error" class="work-center-error">{{ error }}</p>
        <div class="work-center-body">
          <section class="work-center-list" :aria-busy="loading ? 'true' : 'false'">
            <button v-for="item in visibleItems" :key="item.id" type="button"
                    class="work-center-card" :class="{ active: selectedId === item.id }"
                    @click="selectItem(item)">
              <span class="work-center-card-title">{{ item.title }}</span>
              <span class="work-center-card-meta">
                <span class="work-center-status" :data-status="item.status">{{ statusLabel(item.status) }}</span>
                <span>{{ time(item.updatedAt) }}</span>
              </span>
              <span class="work-center-card-goal">{{ item.goal }}</span>
            </button>
            <div v-if="!loading && visibleItems.length === 0" class="work-center-empty-state">
              <h2>{{ tr('workCenter.emptyTitle', 'No work items yet') }}</h2>
              <p>{{ tr('workCenter.emptyBody', 'Create a persistent task when work must continue beyond one conversation turn.') }}</p>
              <button class="btn-primary" type="button" @click="createOpen = true">
                {{ tr('workCenter.newWorkItem', 'New work item') }}
              </button>
            </div>
          </section>

          <section class="work-center-detail">
            <template v-if="selected">
              <div class="work-center-detail-heading">
                <div>
                  <span class="work-center-status" :data-status="selected.status">{{ statusLabel(selected.status) }}</span>
                  <h2>{{ selected.title }}</h2>
                </div>
                <div class="work-center-detail-actions">
                  <button v-if="selected.status === 'draft'" class="btn-primary" type="button" @click="startSelected">
                    {{ tr('workCenter.start', 'Start') }}
                  </button>
                  <button v-if="selected.status === 'waiting' || selected.status === 'needs_attention'" class="btn-primary" type="button" @click="retrySelected">
                    {{ tr('workCenter.retry', 'Retry') }}
                  </button>
                  <button v-if="!['done','cancelled'].includes(selected.status)" class="btn-secondary" type="button" @click="cancelSelected">
                    {{ tr('workCenter.cancel', 'Cancel') }}
                  </button>
                </div>
              </div>

              <div class="work-center-section">
                <h3>{{ tr('workCenter.goal', 'Goal') }}</h3>
                <p>{{ selected.goal }}</p>
              </div>
              <div class="work-center-section">
                <h3>{{ tr('workCenter.acceptanceCriteria', 'Acceptance criteria') }}</h3>
                <ul v-if="selected.acceptanceCriteria?.length">
                  <li v-for="criterion in selected.acceptanceCriteria" :key="criterion">{{ criterion }}</li>
                </ul>
                <p v-else class="work-center-muted">{{ tr('workCenter.noCriteria', 'No criteria provided') }}</p>
              </div>
              <div class="work-center-section" v-if="selected.actions?.length">
                <h3>{{ tr('workCenter.workflow', 'Workflow') }}</h3>
                <ol class="work-center-timeline">
                  <li v-for="action in selected.actions" :key="action.id" :data-status="action.status">
                    <span>{{ actionLabel(action.type) }}</span>
                    <small>{{ agentName(action.requiredRole) }} · {{ statusLabel(action.status) }}</small>
                  </li>
                </ol>
              </div>
              <div class="work-center-section" v-if="selected.events?.length">
                <h3>{{ tr('workCenter.activity', 'Activity') }}</h3>
                <ul class="work-center-events">
                  <li v-for="event in selected.events" :key="event.id">
                    <span>{{ event.type }}</span><small>{{ time(event.createdAt) }}</small>
                  </li>
                </ul>
              </div>
            </template>
            <div v-else class="work-center-detail-empty">
              {{ tr('workCenter.selectPrompt', 'Select a work item to inspect its workflow and evidence.') }}
            </div>
          </section>
        </div>
      </main>

      <div v-if="createOpen" class="modal-overlay work-center-modal-overlay" @click.self="closeCreate">
        <form class="modal-card work-center-modal" @submit.prevent="submitCreate">
          <header>
            <h2>{{ tr('workCenter.newWorkItem', 'New work item') }}</h2>
            <p>{{ tr('workCenter.createHint', 'Define a stable goal before the Agent starts execution.') }}</p>
          </header>
          <div class="work-center-modal-body">
            <label>{{ tr('workCenter.titleField', 'Title') }}<input v-model="form.title" type="text" required></label>
            <label>{{ tr('workCenter.goal', 'Goal') }}<textarea v-model="form.goal" rows="4" required></textarea></label>
            <label>{{ tr('workCenter.acceptanceCriteria', 'Acceptance criteria') }}<textarea v-model="form.acceptanceCriteriaText" rows="4" :placeholder="tr('workCenter.criteriaHint', 'One criterion per line')"></textarea></label>
            <label>{{ tr('workCenter.workDir', 'Working directory') }}<input v-model="form.workDir" type="text" :placeholder="tr('workCenter.workDirHint', 'Optional project directory')"></label>
            <label class="work-center-checkbox"><input v-model="form.start" type="checkbox">{{ tr('workCenter.startImmediately', 'Start immediately') }}</label>
          </div>
          <footer>
            <button class="btn-secondary" type="button" @click="closeCreate">{{ tr('common.cancel', 'Cancel') }}</button>
            <button class="btn-primary" type="submit" :disabled="saving || !form.title.trim() || !form.goal.trim()">
              {{ saving ? tr('workCenter.creating', 'Creating…') : tr('workCenter.create', 'Create') }}
            </button>
          </footer>
        </form>
      </div>
    </div>
  `,
};
