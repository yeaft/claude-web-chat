import WorkCenterSettingsModal from './WorkCenterSettingsModal.js';
import LlmTab from './LlmTab.js';

export default {
  name: 'WorkCenterPage',
  components: { WorkCenterSettingsModal, LlmTab },
  data() {
    return {
      selectedId: null,
      createOpen: false,
      settingsOpen: false,
      saving: false,
      llmConfigOpen: false,
      filter: 'open',
      search: '',
      resumeAnswer: '',
      actionGuidance: '',
      expandedActions: {},
      workDirTouched: false,
      startTouched: false,
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
    watcher() { return this.store.workCenterWatcherByAgent[this.agentId] || null; },
    settings() { return this.store.workCenterSettingsByAgent[this.agentId] || null; },
    runtime() { return this.store.workCenterRuntimeByAgent[this.agentId] || null; },
    createDefaultWorkDir() {
      return this.settings?.defaultWorkDir || this.runtime?.defaultWorkDir || '';
    },
    createDefaultStart() {
      return this.settings?.startImmediately !== false;
    },
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
      handler(id, previousId) {
        this.selectedId = null;
        if (previousId && id !== previousId) this.resetCreateExecutionContext(id);
        if (id) {
          this.store.listWorkItems(id).catch(() => {});
          this.store.loadWorkCenterSettings(id).catch(() => {});
        }
      },
    },
    createDefaultWorkDir() {
      this.applyCreateDefaults();
    },
    createDefaultStart() {
      this.applyCreateDefaults();
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
      start: this.settings?.startImmediately !== false,
    };
    this.createOpen = true;
    this.workDirTouched = !!String(draft.workDir || '').trim();
    this.startTouched = false;
    this.applyCreateDefaults();
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
    refresh() {
      return this.store.listWorkItems(this.agentId).catch(() => {});
    },
    async selectItem(item) {
      this.selectedId = item.id;
      this.resumeAnswer = '';
      this.actionGuidance = '';
      this.expandedActions = {};
      try { await this.store.getWorkItem(item.id, this.agentId); } catch {}
    },
    actionHasResponse(action) {
      return !!String(action?.response || '').trim();
    },
    actionExpanded(action) {
      return !!this.expandedActions[action?.id];
    },
    toggleAction(action) {
      if (!this.actionHasResponse(action)) return;
      this.expandedActions = {
        ...this.expandedActions,
        [action.id]: !this.expandedActions[action.id],
      };
    },
    actionResponseText(action) {
      return String(action?.response || '').trim();
    },
    resetCreateExecutionContext(agentId) {
      const hadUserExecutionInput = this.workDirTouched || this.startTouched;
      const draft = this.store.workCenterCreateDraft;
      if (draft) {
        this.store.workCenterCreateDraft = {
          sourceAgentId: agentId || null,
          title: draft.title || '',
          goal: draft.goal || '',
          workDir: '',
          origin: null,
          linkedSessionIds: [],
        };
      }
      this.form.workDir = '';
      this.form.start = true;
      this.workDirTouched = false;
      this.startTouched = false;
      if (hadUserExecutionInput) this.createOpen = false;
      this.applyCreateDefaults();
    },
    applyCreateDefaults() {
      if (!this.createOpen) return;
      if (!this.workDirTouched && !this.form.workDir.trim()) this.form.workDir = this.createDefaultWorkDir;
      if (!this.startTouched) this.form.start = this.createDefaultStart;
    },
    onCreateWorkDirInput() {
      this.workDirTouched = true;
    },
    onCreateStartInput() {
      this.startTouched = true;
    },
    openCreate() {
      this.createOpen = true;
      this.workDirTouched = false;
      this.startTouched = false;
      this.applyCreateDefaults();
    },
    closeCreate() {
      if (this.saving) return;
      this.createOpen = false;
      this.store.workCenterCreateDraft = null;
    },
    onLlmConfigSaved() {
      const agentId = this.agentId;
      if (!agentId) return;
      return this.store.refreshWorkCenterRuntime(agentId).catch(() => {});
    },
    async submitCreate() {
      if (!this.form.title.trim() || !this.form.goal.trim() || !this.form.workDir.trim()) return;
      this.saving = true;
      try {
        const draft = this.store.workCenterCreateDraft;
        const draftOwnedByAgent = draft?.sourceAgentId === this.agentId;
        const detail = await this.store.createWorkItem({
          title: this.form.title.trim(),
          goal: this.form.goal.trim(),
          acceptanceCriteria: this.form.acceptanceCriteriaText
            .split('\n').map(value => value.trim()).filter(Boolean),
          workDir: this.form.workDir.trim(),
          origin: draftOwnedByAgent ? (draft.origin || null) : null,
          linkedSessionIds: draftOwnedByAgent ? (draft.linkedSessionIds || []) : [],
          reuseMemory: this.form.reuseMemory,
          start: this.form.start,
        }, this.agentId);
        this.selectedId = detail.id;
        this.form = {
          title: '',
          goal: '',
          acceptanceCriteriaText: '',
          workDir: '',
          reuseMemory: true,
          start: this.settings?.startImmediately !== false,
        };
        this.store.workCenterCreateDraft = null;
        this.workDirTouched = false;
        this.startTouched = false;
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
    },
    async retrySelected() {
      if (!this.selected) return;
      await this.store.retryWorkItem(this.selected.id, this.resumeAnswer, this.agentId);
      this.resumeAnswer = '';
    },
    async cancelSelected() {
      if (!this.selected) return;
      await this.store.cancelWorkItem(this.selected.id, this.agentId);
    },
  },
  template: `
    <main class="work-center-main" :class="{ 'workbench-maximized': store.workbenchMaximized && store.workbenchExpanded }">
        <div class="work-center-shell">
          <header class="work-center-header">
            <div class="work-center-heading">
              <button class="work-center-sidebar-toggle" type="button" @click="store.toggleSessionSidebar()"
                      :title="tr('chat.sidebar.expand', 'Open sidebar')" :aria-label="tr('chat.sidebar.expand', 'Open sidebar')">
                <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M3 18h18v-2H3v2Zm0-5h18v-2H3v2Zm0-7v2h18V6H3Z"/></svg>
              </button>
              <h1>{{ tr('workCenter.title', 'Work Center') }}</h1>
              <span class="work-center-agent-context">
                <span class="work-center-agent-dot" aria-hidden="true"></span>
                {{ agentName(agentId) }}
              </span>
            </div>
            <div class="work-center-header-actions">
              <button class="work-center-icon-button" type="button" @click="settingsOpen = true"
                      :title="tr('workCenter.settings.title', 'Work Center settings')" :aria-label="tr('workCenter.settings.title', 'Work Center settings')">
                <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M19.43 12.98c.04-.32.07-.65.07-.98s-.03-.66-.08-.98l2.11-1.65a.5.5 0 0 0 .12-.64l-2-3.46a.5.5 0 0 0-.61-.22l-2.49 1a7.2 7.2 0 0 0-1.69-.98L14.5 2.42A.49.49 0 0 0 14 2h-4a.49.49 0 0 0-.49.42L9.13 5.07c-.61.25-1.17.59-1.69.98l-2.49-1a.49.49 0 0 0-.61.22l-2 3.46a.49.49 0 0 0 .12.64l2.11 1.65c-.04.32-.08.66-.08.98s.03.66.08.98l-2.11 1.65a.5.5 0 0 0-.12.64l2 3.46c.12.22.38.31.61.22l2.49-1c.52.4 1.08.73 1.69.98l.38 2.65c.04.24.24.42.49.42h4c.25 0 .46-.18.49-.42l.38-2.65c.61-.25 1.17-.58 1.69-.98l2.49 1c.23.08.49 0 .61-.22l2-3.46a.5.5 0 0 0-.12-.64l-2.11-1.65ZM12 15.5A3.5 3.5 0 1 1 12 8a3.5 3.5 0 0 1 0 7.5Z"/></svg>
              </button>
              <button class="work-center-icon-button" type="button" @click="refresh" :disabled="loading"
                      :title="tr('workCenter.refresh', 'Refresh')" :aria-label="tr('workCenter.refresh', 'Refresh')">
                <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M17.65 6.35A8 8 0 1 0 19.73 14h-2.08A6 6 0 1 1 16.22 7.78L13 11h7V4l-2.35 2.35Z"/></svg>
              </button>
              <button class="btn-primary work-center-header-create" type="button" @click="openCreate" :disabled="onlineAgents.length === 0"
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
                  <span v-if="item.currentAction">{{ actionLabel(item.currentAction.type) }} · {{ item.currentAction.assignmentMode || tr('workCenter.assignment.auto', 'Auto') }}</span>
                  <span>{{ time(item.updatedAt) || tr('workCenter.noTimestamp', 'No timestamp') }}</span>
                </span>
              </button>
              <div v-if="loading" class="work-center-loading">{{ tr('workCenter.loading', 'Loading work items…') }}</div>
              <div v-if="!loading && visibleItems.length === 0" class="work-center-empty-state">
                <h2>{{ emptyState.title }}</h2>
                <p>{{ emptyState.body }}</p>
                <button v-if="emptyState.canCreate" class="btn-ghost work-center-empty-create" type="button" @click="openCreate" :disabled="onlineAgents.length === 0">
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
                  <div v-if="selected.workItemType"><dt>{{ tr('workCenter.workItemType', 'Type') }}</dt><dd>{{ selected.workItemType }}</dd></div>
                  <div v-else-if="selected.planningMode === 'ai'"><dt>{{ tr('workCenter.workItemType', 'Type') }}</dt><dd>{{ tr('workCenter.planning', 'Planning') }}</dd></div>
                </dl>

                <div v-if="selected.status === 'waiting'" class="work-center-section work-center-resume">
                  <p v-if="selected.waitingReason">{{ selected.waitingReason }}</p>
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
                    <article v-for="action in selected.actions" :key="action.id" class="work-center-action-card" :data-status="action.status" :class="{ expanded: actionExpanded(action) }">
                      <button class="work-center-action-summary" type="button" @click="toggleAction(action)"
                              :disabled="!actionHasResponse(action)" :aria-expanded="actionHasResponse(action) ? actionExpanded(action) : undefined">
                        <span class="work-center-action-index">{{ action.sequence }}</span>
                        <span class="work-center-action-title">
                          <strong>{{ actionLabel(action.type) }}</strong>
                          <small>{{ action.requiredRole || action.assignmentPolicy?.fixedVpId || action.assignmentPolicy?.capability || tr('workCenter.assignment.auto', 'Auto') }}</small>
                        </span>
                        <span class="work-center-action-stats">
                          <span>{{ $t('workCenter.loopCount', { count: action.loopCount || 0 }) }}</span>
                          <span>{{ $t('workCenter.toolCount', { count: action.toolCount || 0 }) }}</span>
                        </span>
                        <span class="work-center-status" :data-status="action.status"><span aria-hidden="true"></span>{{ statusLabel(action.status) }}</span>
                        <span v-if="actionHasResponse(action)" class="work-center-action-chevron" aria-hidden="true"></span>
                      </button>
                      <div v-if="actionExpanded(action)" class="work-center-action-body">
                        <div class="work-center-action-response">{{ actionResponseText(action) }}</div>
                      </div>
                    </article>
                  </div>
                </div>
              </template>
              <div v-else class="work-center-detail-empty">
                <strong>{{ tr('workCenter.selectTitle', 'Work item details') }}</strong>
              </div>
            </section>
          </div>
        </div>
    </main>

      <WorkCenterSettingsModal v-if="settingsOpen" :key="agentId" :agent-id="agentId" @close="settingsOpen = false" @saved="refresh" @open-agent-models="settingsOpen = false; llmConfigOpen = true" />
      <div v-if="llmConfigOpen" class="modal-overlay yeaft-llm-config-overlay" @click.self="llmConfigOpen = false">
        <div class="modal-card yeaft-llm-config-modal" role="dialog" aria-modal="true" :aria-label="$t('settings.llm.configureAgent')">
          <div class="modal-header">
            <h3>{{ $t('settings.llm.configureAgent') }}</h3>
            <button class="modal-close" type="button" @click="llmConfigOpen = false" :aria-label="$t('common.close')">×</button>
          </div>
          <div class="yeaft-llm-config-body">
            <LlmTab context="yeaft" @saved="onLlmConfigSaved" />
          </div>
        </div>
      </div>

      <div v-if="createOpen" class="modal-overlay work-center-modal-overlay" @click.self="closeCreate">
        <form class="modal-card work-center-modal" role="dialog" aria-modal="true" aria-labelledby="work-center-create-title" @submit.prevent="submitCreate">
          <header class="work-center-modal-header">
            <div>
              <h2 id="work-center-create-title">{{ tr('workCenter.newWorkItem', 'New work item') }}</h2>
              <p>{{ tr('workCenter.createHint', 'Define a stable goal before the Agent starts execution.') }}</p>
            </div>
            <button class="modal-close" type="button" @click="closeCreate" :disabled="saving" :aria-label="tr('common.close', 'Close')">×</button>
          </header>
          <div class="work-center-modal-body">
            <section class="work-center-form-section">
              <label>{{ tr('workCenter.titleField', 'Title') }}<input v-model="form.title" type="text" required autofocus :placeholder="tr('workCenter.titleHint', 'A short, specific outcome')"></label>
              <label>{{ tr('workCenter.goal', 'Goal') }}<textarea v-model="form.goal" rows="3" required :placeholder="tr('workCenter.goalHint', 'Describe the result the Agent must deliver')"></textarea></label>
              <label>{{ tr('workCenter.acceptanceCriteria', 'Acceptance criteria') }}<textarea v-model="form.acceptanceCriteriaText" rows="3" :placeholder="tr('workCenter.criteriaHint', 'One criterion per line')"></textarea></label>
            </section>
            <section class="work-center-form-section work-center-execution-section">
              <div class="work-center-form-section-heading">
                <h3>{{ tr('workCenter.execution', 'Execution') }}</h3>
                <p>{{ tr('workCenter.executionHint', 'Choose where and how this work item starts.') }}</p>
              </div>
              <label>{{ tr('workCenter.workDir', 'Working directory') }}<input v-model="form.workDir" type="text" required :placeholder="tr('workCenter.workDirHint', 'Project directory')" @input="onCreateWorkDirInput"></label>
              <div class="work-center-create-options">
                <label class="work-center-checkbox"><input v-model="form.reuseMemory" type="checkbox"><span><strong>{{ tr('workCenter.reuseMemory', 'Reuse context from this working directory') }}</strong><small>{{ tr('workCenter.reuseMemoryHint', 'Include relevant project history when planning and executing.') }}</small></span></label>
                <label class="work-center-checkbox"><input v-model="form.start" type="checkbox" @change="onCreateStartInput"><span><strong>{{ tr('workCenter.startImmediately', 'Start immediately') }}</strong><small>{{ tr('workCenter.startImmediatelyHint', 'Turn this off to create a draft you can review first.') }}</small></span></label>
              </div>
            </section>
            <section class="work-center-plan-preview">
              <div class="work-center-plan-preview-heading">
                <div><strong>{{ tr('workCenter.aiPlan', 'AI-planned execution') }}</strong><small>{{ tr('workCenter.aiPlanHelp', 'Triage will choose the task type, Actions, executors, and the smallest reliable flow. Work Center settings control the model and effort.') }}</small></div>
                <button type="button" class="btn-secondary" @click="settingsOpen = true">{{ tr('workCenter.settings.title', 'Settings') }}</button>
              </div>
            </section>
          </div>
          <footer class="work-center-modal-footer">
            <button class="btn-secondary" type="button" @click="closeCreate">{{ tr('common.cancel', 'Cancel') }}</button>
            <button class="btn-primary" type="submit" :disabled="saving || !form.title.trim() || !form.goal.trim() || !form.workDir.trim()">
              {{ saving ? tr('workCenter.creating', 'Creating…') : tr('workCenter.create', 'Create') }}
            </button>
          </footer>
        </form>
      </div>
  `,
};
