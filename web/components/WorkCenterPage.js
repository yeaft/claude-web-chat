import SidebarAgentHeader from './SidebarAgentHeader.js';
import SidebarModeToggle from './SidebarModeToggle.js';
import SidebarWorkCenter from './SidebarWorkCenter.js';
import WorkbenchPanel from './WorkbenchPanel.js';

export default {
  name: 'WorkCenterPage',
  components: { SidebarAgentHeader, SidebarModeToggle, SidebarWorkCenter, WorkbenchPanel },
  data() {
    return {
      selectedId: null,
      createOpen: false,
      saving: false,
      filter: 'open',
      search: '',
      resumeAnswer: '',
      actionGuidance: '',
      expandedActions: {},
      activityOpen: false,
      form: {
        title: '',
        goal: '',
        acceptanceCriteriaText: '',
        workDir: '',
        reuseMemory: true,
        start: true,
      },
    };
  },
  computed: {
    store() { return Pinia.useChatStore(); },
    agentId() { return this.store.workCenterAgentId || this.store.currentAgent; },
    agents() { return this.store.agents || []; },
    onlineAgents() { return this.agents.filter(agent => agent?.online); },
    canUseWorkbench() {
      return !!(this.store.hasCapability?.('terminal') || this.store.hasCapability?.('file_editor'));
    },
    watcher() { return this.store.workCenterWatcherByAgent[this.agentId] || null; },
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
    listHeading() {
      if (this.filter === 'done') return this.tr('workCenter.completedItems', 'Completed');
      if (this.filter === 'all') return this.tr('workCenter.allItems', 'All work items');
      return this.tr('workCenter.activeItems', 'Active work');
    },
    emptyState() {
      if (this.search.trim()) {
        return {
          title: this.tr('workCenter.noMatchesTitle', 'No matching work items'),
          body: this.tr('workCenter.noMatchesBody', 'Try a different search or filter.'),
          canCreate: false,
        };
      }
      if (this.filter === 'done') {
        return {
          title: this.tr('workCenter.noCompletedTitle', 'No completed work items'),
          body: this.tr('workCenter.noCompletedBody', 'Completed work items will appear here.'),
          canCreate: false,
        };
      }
      if (this.filter === 'open' && this.items.length > 0) {
        return {
          title: this.tr('workCenter.noOpenTitle', 'No open work items'),
          body: this.tr('workCenter.noOpenBody', 'Open work items will appear here.'),
          canCreate: true,
        };
      }
      return {
        title: this.tr('workCenter.emptyTitle', 'No work items yet'),
        body: this.tr('workCenter.emptyBody', 'Create a persistent task when work must continue beyond one conversation turn.'),
        canCreate: true,
      };
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
  mounted() {
    const draft = this.store.workCenterCreateDraft;
    if (!draft) return;
    this.form = {
      title: draft.title || '',
      goal: draft.goal || '',
      acceptanceCriteriaText: '',
      workDir: draft.workDir || '',
      reuseMemory: true,
      start: true,
    };
    this.createOpen = true;
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
    onModeFlip(target) {
      if (target === 'yeaft') this.store.enterYeaft(this.agentId);
      else {
        this.store.workCenterReturnView = 'chat';
        this.store.leaveWorkCenter();
      }
    },
    refresh() {
      return this.store.listWorkItems(this.agentId).catch(() => {});
    },
    async selectItem(item) {
      this.selectedId = item.id;
      this.resumeAnswer = '';
      this.actionGuidance = '';
      this.activityOpen = false;
      try {
        const detail = await this.store.getWorkItem(item.id, this.agentId);
        const currentId = detail?.currentActionId;
        this.expandedActions = currentId ? { [currentId]: true } : {};
      } catch {}
    },
    toggleAction(action) {
      this.expandedActions = {
        ...this.expandedActions,
        [action.id]: !this.expandedActions[action.id],
      };
    },
    runsForAction(actionId) {
      return (this.selected?.runs || []).filter(run => run.actionId === actionId);
    },
    closeCreate() {
      if (this.saving) return;
      this.createOpen = false;
      this.store.workCenterCreateDraft = null;
    },
    async submitCreate() {
      if (!this.form.title.trim() || !this.form.goal.trim()) return;
      this.saving = true;
      try {
        const draft = this.store.workCenterCreateDraft;
        const detail = await this.store.createWorkItem({
          title: this.form.title.trim(),
          goal: this.form.goal.trim(),
          acceptanceCriteria: this.form.acceptanceCriteriaText
            .split('\n').map(value => value.trim()).filter(Boolean),
          workDir: this.form.workDir.trim(),
          workflowTemplate: 'software-change',
          origin: draft?.origin || null,
          linkedSessionIds: draft?.linkedSessionIds || [],
          reuseMemory: this.form.reuseMemory,
          start: this.form.start,
        }, this.agentId);
        this.selectedId = detail.id;
        this.expandedActions = detail.currentActionId ? { [detail.currentActionId]: true } : {};
        this.form = { title: '', goal: '', acceptanceCriteriaText: '', workDir: '', reuseMemory: true, start: true };
        this.store.workCenterCreateDraft = null;
        this.createOpen = false;
      } finally {
        this.saving = false;
      }
    },
    async startSelected() {
      if (!this.selected) return;
      await this.store.startWorkItem(this.selected.id, this.agentId);
    },
    async guideSelectedAction() {
      if (!this.selected || !this.actionGuidance.trim()) return;
      const detail = await this.store.guideWorkItemAction(
        this.selected.id,
        this.actionGuidance.trim(),
        this.selected.currentActionId,
        this.selected.revision,
        this.agentId,
      );
      this.actionGuidance = '';
      this.expandedActions = detail.currentActionId ? { [detail.currentActionId]: true } : {};
    },
    async retrySelected() {
      if (!this.selected) return;
      const detail = await this.store.retryWorkItem(this.selected.id, this.resumeAnswer, this.agentId);
      this.resumeAnswer = '';
      this.expandedActions = detail.currentActionId ? { [detail.currentActionId]: true } : {};
    },
    async cancelSelected() {
      if (!this.selected) return;
      await this.store.cancelWorkItem(this.selected.id, this.agentId);
    },
  },
  template: `
    <div class="work-center-page">
      <div class="sidebar-overlay work-center-sidebar-overlay" v-if="!store.sidebarCollapsed" @click="store.toggleSidebar()"></div>
      <aside class="sidebar work-center-sidebar" :class="{ collapsed: store.sidebarCollapsed }">
        <div v-if="store.sidebarCollapsed" class="sidebar-collapsed-bar">
          <button class="collapsed-icon-btn" type="button" @click="store.toggleSidebar()" :title="tr('sidebar.expand', 'Expand sidebar')">
            <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M3 18h18v-2H3v2Zm0-5h18v-2H3v2Zm0-7v2h18V6H3Z"/></svg>
          </button>
          <button class="collapsed-icon-btn active" type="button" :title="tr('workCenter.title', 'Work Center')">
            <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M19 3h-3.18A3 3 0 0 0 13 1h-2a3 3 0 0 0-2.82 2H5a2 2 0 0 0-2 2v15a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2Zm-8-1h2a1 1 0 0 1 1 1h-4a1 1 0 0 1 1-1Zm8 18H5V5h2v2h10V5h2v15Z"/></svg>
          </button>
          <div class="collapsed-spacer"></div>
          <button class="collapsed-icon-btn" type="button" @click="store.leaveWorkCenter()" :title="tr('common.back', 'Back')">
            <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.42-1.41L7.83 13H20v-2Z"/></svg>
          </button>
        </div>
        <div v-else class="sidebar-top">
          <div class="sidebar-header-row">
            <SidebarAgentHeader
              :online-agents="onlineAgents"
              :online-agent-count="onlineAgents.length"
              :show-agent-actions="false"
            />
            <div class="sidebar-header-actions">
              <SidebarModeToggle :view="store.workCenterReturnView === 'yeaft' ? 'yeaft' : 'chat'" @flip="onModeFlip" />
              <button class="sidebar-icon-btn" type="button" @click="store.toggleSidebar()" :title="tr('sidebar.collapse', 'Collapse sidebar')">
                <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M3 18h13v-2H3v2Zm0-5h10v-2H3v2Zm0-7v2h13V6H3Zm18 9.59L17.42 12 21 8.41 19.59 7l-5 5 5 5L21 15.59Z"/></svg>
              </button>
              <button v-if="canUseWorkbench" class="sidebar-icon-btn" type="button" :class="{ active: store.workbenchExpanded }" @click="store.toggleWorkbench()" :title="tr('chat.sidebar.workbench', 'Workbench')">
                <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M20 3H4c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2Zm0 16H4V5h16v14ZM6 7h5v2H6V7Zm0 4h5v2H6v-2Zm0 4h5v2H6v-2Zm7-8h5v10h-5V7Z"/></svg>
              </button>
            </div>
          </div>
        </div>
        <SidebarWorkCenter
          v-if="!store.sidebarCollapsed"
          :agents="agents"
          :active-agent-id="agentId"
          :collapsed="false"
          :active="true"
          :default-expanded="true"
          @open="openAgent"
        />
        <div v-if="!store.sidebarCollapsed" class="sidebar-bottom work-center-sidebar-actions">
          <button class="sidebar-nav-item work-center-back-button" type="button" @click="store.leaveWorkCenter()">
            <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.42-1.41L7.83 13H20v-2Z"/></svg>
            {{ tr('common.back', 'Back') }}
          </button>
        </div>
      </aside>

      <WorkbenchPanel v-if="canUseWorkbench" />

      <main class="work-center-main" :class="{ 'workbench-active': canUseWorkbench && store.workbenchExpanded, 'workbench-maximized': canUseWorkbench && store.workbenchMaximized && store.workbenchExpanded }">
        <div class="work-center-shell">
          <header class="work-center-header">
            <div class="work-center-heading">
              <h1>{{ tr('workCenter.title', 'Work Center') }}</h1>
              <span class="work-center-agent-context">
                <span class="work-center-agent-dot" aria-hidden="true"></span>
                {{ agentName(agentId) }}
              </span>
            </div>
            <div class="work-center-header-actions">
              <button class="work-center-icon-button" type="button" @click="refresh" :disabled="loading"
                      :title="tr('workCenter.refresh', 'Refresh')" :aria-label="tr('workCenter.refresh', 'Refresh')">
                <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M17.65 6.35A8 8 0 1 0 19.73 14h-2.08A6 6 0 1 1 16.22 7.78L13 11h7V4l-2.35 2.35Z"/></svg>
              </button>
              <button class="btn-primary work-center-header-create" type="button" @click="createOpen = true" :disabled="onlineAgents.length === 0"
                      :title="tr('workCenter.newWorkItem', 'New work item')" :aria-label="tr('workCenter.newWorkItem', 'New work item')">
                <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2Z"/></svg>
                <span>{{ tr('workCenter.new', 'New') }}</span>
              </button>
            </div>
          </header>

          <div class="work-center-toolbar">
            <div class="work-center-filter" role="group" :aria-label="tr('workCenter.filter', 'Filter')">
              <button type="button" :class="{ active: filter === 'open' }" @click="filter = 'open'">{{ tr('workCenter.filterOpen', 'Open') }}</button>
              <button type="button" :class="{ active: filter === 'all' }" @click="filter = 'all'">{{ tr('workCenter.filterAll', 'All') }}</button>
              <button type="button" :class="{ active: filter === 'done' }" @click="filter = 'done'">{{ tr('workCenter.filterDone', 'Done') }}</button>
            </div>
            <label class="work-center-search">
              <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M9.5 3a6.5 6.5 0 1 0 4.02 11.61L19.91 21 21 19.91l-6.39-6.39A6.5 6.5 0 0 0 9.5 3Zm0 2a4.5 4.5 0 1 1 0 9 4.5 4.5 0 0 1 0-9Z"/></svg>
              <input v-model="search" type="search" :placeholder="tr('workCenter.search', 'Search work items')">
            </label>
            <span v-if="watcher && watcher.enabled" class="work-center-watcher active">
              <span aria-hidden="true"></span>{{ tr('workCenter.watcherActive', 'Watcher active') }}
            </span>
          </div>

          <p v-if="onlineAgents.length === 0" class="work-center-notice">
            {{ tr('workCenter.noOnlineAgents', 'No online agents') }}
          </p>
          <p v-if="error" class="work-center-error">{{ error }}</p>
          <div class="work-center-body" :class="{ 'is-empty': !loading && visibleItems.length === 0 }">
            <section class="work-center-list" :aria-busy="loading ? 'true' : 'false'">
              <div v-if="visibleItems.length > 0" class="work-center-list-heading">
                <span>{{ listHeading }}</span>
                <small>{{ visibleItems.length }}</small>
              </div>
              <button v-for="item in visibleItems" :key="item.id" type="button"
                      class="work-center-card" :class="{ active: selectedId === item.id }"
                      :aria-label="item.title || tr('workCenter.workItem', 'Work item')"
                      @click="selectItem(item)">
                <span class="work-center-card-topline">
                  <span class="work-center-card-title">{{ item.title }}</span>
                  <span class="work-center-status" :data-status="item.status"><span aria-hidden="true"></span>{{ statusLabel(item.status) }}</span>
                </span>
                <span class="work-center-card-goal">{{ item.goal }}</span>
                <span class="work-center-card-meta">
                  <span v-if="item.currentAction">{{ actionLabel(item.currentAction.type) }} · {{ item.currentAction.requiredRole }}</span>
                  <span>{{ time(item.updatedAt) || tr('workCenter.noTimestamp', 'No timestamp') }}</span>
                </span>
              </button>
              <div v-if="loading" class="work-center-loading">{{ tr('workCenter.loading', 'Loading work items…') }}</div>
              <div v-if="!loading && visibleItems.length === 0" class="work-center-empty-state">
                <h2>{{ emptyState.title }}</h2>
                <p>{{ emptyState.body }}</p>
                <button v-if="emptyState.canCreate" class="btn-ghost work-center-empty-create" type="button" @click="createOpen = true" :disabled="onlineAgents.length === 0">
                  <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path fill="currentColor" d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2Z"/></svg>
                  {{ tr('workCenter.createFirst', 'Create first work item') }}
                </button>
              </div>
            </section>

            <section class="work-center-detail">
              <template v-if="selected">
                <div class="work-center-detail-heading">
                  <div>
                    <span class="work-center-status" :data-status="selected.status"><span aria-hidden="true"></span>{{ statusLabel(selected.status) }}</span>
                    <h2>{{ selected.title }}</h2>
                  </div>
                  <div class="work-center-detail-actions">
                    <button v-if="selected.status === 'cancelled'" class="btn-primary" type="button" @click="retrySelected">{{ tr('workCenter.retry', 'Retry') }}</button>
                    <button v-if="selected.status === 'draft'" class="btn-primary" type="button" @click="startSelected">{{ tr('workCenter.start', 'Start') }}</button>
                    <button v-if="selected.status === 'waiting' || selected.status === 'needs_attention'" class="btn-primary" type="button" @click="retrySelected" :disabled="selected.status === 'waiting' && !resumeAnswer.trim()">{{ tr('workCenter.retry', 'Retry') }}</button>
                    <button v-if="!['done','cancelled'].includes(selected.status)" class="btn-secondary" type="button" @click="cancelSelected">{{ tr('workCenter.cancel', 'Cancel') }}</button>
                  </div>
                </div>
                <dl class="work-center-detail-meta">
                  <div><dt>{{ tr('workCenter.updated', 'Updated') }}</dt><dd>{{ time(selected.updatedAt) || '—' }}</dd></div>
                  <div v-if="selected.workDir"><dt>{{ tr('workCenter.workDir', 'Working directory') }}</dt><dd>{{ selected.workDir }}</dd></div>
                  <div v-if="selected.workflowTemplate"><dt>{{ tr('workCenter.workflow', 'Workflow') }}</dt><dd>{{ selected.workflowTemplate }}</dd></div>
                </dl>

                <div v-if="selected.status === 'waiting'" class="work-center-section work-center-resume">
                  <label>{{ tr('workCenter.resumeAnswer', 'Answer the waiting question') }}
                    <textarea v-model="resumeAnswer" rows="3" :placeholder="tr('workCenter.resumeAnswerHint', 'Provide the information required to continue')"></textarea>
                  </label>
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
                <div v-if="['ready','running'].includes(selected.status)" class="work-center-section work-center-guidance">
                  <label>{{ tr('workCenter.guidance', 'Add guidance to the current Action') }}
                    <textarea v-model="actionGuidance" rows="2" :placeholder="tr('workCenter.guidanceHint', 'Clarify constraints or redirect the current Action')"></textarea>
                  </label>
                  <div>
                    <small>{{ tr('workCenter.guidanceRestartHint', 'This restarts the current Action with the new guidance.') }}</small>
                    <button class="btn-secondary" type="button" @click="guideSelectedAction" :disabled="!actionGuidance.trim()">
                      {{ tr('workCenter.sendGuidance', 'Send guidance') }}
                    </button>
                  </div>
                </div>
                <div class="work-center-section" v-if="selected.actions?.length">
                  <h3>{{ tr('workCenter.workflow', 'Workflow') }}</h3>
                  <div class="work-center-action-list">
                    <article v-for="action in selected.actions" :key="action.id" class="work-center-action-card" :data-status="action.status">
                      <button type="button" class="work-center-action-toggle" @click="toggleAction(action)" :aria-expanded="expandedActions[action.id] ? 'true' : 'false'">
                        <span class="work-center-action-index">{{ action.sequence }}</span>
                        <span class="work-center-action-title">
                          <strong>{{ actionLabel(action.type) }}</strong>
                          <small>{{ action.requiredRole }} · {{ statusLabel(action.status) }}</small>
                        </span>
                        <span class="work-center-status" :data-status="action.status"><span aria-hidden="true"></span>{{ statusLabel(action.status) }}</span>
                        <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" :class="{ expanded: expandedActions[action.id] }"><path fill="currentColor" d="m7.41 8.59 4.59 4.58 4.59-4.58L18 10l-6 6-6-6 1.41-1.41Z"/></svg>
                      </button>
                      <div v-if="expandedActions[action.id]" class="work-center-action-body">
                        <p v-if="!runsForAction(action.id).length" class="work-center-muted">{{ tr('workCenter.noRuns', 'No execution yet') }}</p>
                        <article v-for="run in runsForAction(action.id)" :key="run.id" class="work-center-run">
                          <div class="work-center-run-heading">
                            <small>
                              {{ run.vpSnapshot?.name || run.roleSnapshot?.id || tr('workCenter.unknownRole', 'Unknown role') }}
                              <template v-if="run.modelSnapshot?.id"> · {{ run.modelSnapshot.id }}</template>
                              · {{ time(run.startedAt) }}
                            </small>
                            <span class="work-center-status" :data-status="run.status"><span aria-hidden="true"></span>{{ statusLabel(run.status) }}</span>
                          </div>
                          <p v-if="run.summary">{{ run.summary }}</p>
                          <p v-if="run.waitingReason" class="work-center-run-reason"><strong>{{ tr('workCenter.waitingReason', 'Waiting:') }}</strong> {{ run.waitingReason }}</p>
                          <p v-if="run.error" class="work-center-error">{{ run.error }}</p>
                          <ul v-if="run.evidence?.length" class="work-center-evidence">
                            <li v-for="(evidence, index) in run.evidence" :key="run.id + ':' + index">
                              <span>{{ evidence.label }}</span>
                              <small v-if="evidence.status"> · {{ statusLabel(evidence.status) }}</small>
                              <code v-if="evidence.ref">{{ evidence.ref }}</code>
                            </li>
                          </ul>
                        </article>
                      </div>
                    </article>
                  </div>
                </div>
                <div class="work-center-section" v-if="selected.events?.length">
                  <button class="work-center-activity-toggle" type="button" @click="activityOpen = !activityOpen" :aria-expanded="activityOpen ? 'true' : 'false'">
                    <span>{{ tr('workCenter.activity', 'Activity') }}</span>
                    <small>{{ selected.events.length }}</small>
                  </button>
                  <ul v-if="activityOpen" class="work-center-events">
                    <li v-for="event in selected.events" :key="event.id">
                      <span>{{ event.type }}</span><small>{{ time(event.createdAt) }}</small>
                    </li>
                  </ul>
                </div>
              </template>
              <div v-else class="work-center-detail-empty">
                <strong>{{ tr('workCenter.selectTitle', 'Work item details') }}</strong>
              </div>
            </section>
          </div>
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
            <label class="work-center-checkbox"><input v-model="form.reuseMemory" type="checkbox">{{ tr('workCenter.reuseMemory', 'Reuse context from this working directory') }}</label>
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
