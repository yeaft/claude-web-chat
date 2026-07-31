function sortRows(rows) {
  return [...rows].sort((left, right) => {
    if (!!left.pinned !== !!right.pinned) return left.pinned ? -1 : 1;
    const leftRank = Number.isFinite(left.sortRank) ? left.sortRank : Number.MAX_SAFE_INTEGER;
    const rightRank = Number.isFinite(right.sortRank) ? right.sortRank : Number.MAX_SAFE_INTEGER;
    if (leftRank !== rightRank) return leftRank - rightRank;
    return new Date(right.updatedAt || right.createdAt || 0).getTime()
      - new Date(left.updatedAt || left.createdAt || 0).getTime();
  });
}

function projectIdentityKey(project) {
  return `${project?.agentId || ''}\u001f${project?.id || ''}`;
}

export default {
  name: 'UnifiedSessionList',
  emits: ['select', 'create', 'action', 'project-action', 'close-work-center'],
  props: {
    sessions: { type: Array, default: () => [] },
    projects: { type: Array, default: () => [] },
    activeRoute: { type: Object, default: null },
    isSessionUnread: { type: Function, default: null },
    processingConversations: { type: Object, default: () => ({}) },
    isYeaftSessionProcessing: { type: Function, default: null },
    agents: { type: Array, default: () => [] },
    workCenterOpen: { type: Boolean, default: false },
  },
  data() {
    return {
      collapsedProjects: {},
      openMenuKey: null,
      openProjectMenuKey: null,
      draggedRow: null,
      dragTargetProjectId: null,
      projectCreateOpen: false,
      projectCreateName: '',
      projectCreateSubmitting: false,
    };
  },
  mounted() {
    document.addEventListener('pointerdown', this.closeMenusFromDocument, true);
    document.addEventListener('keydown', this.closeMenusFromKeyboard);
  },
  beforeUnmount() {
    document.removeEventListener('pointerdown', this.closeMenusFromDocument, true);
    document.removeEventListener('keydown', this.closeMenusFromKeyboard);
  },
  computed: {
    projectStore() {
      try { return window.Pinia?.useChatStore?.() || null; } catch { return null; }
    },
    projectRows() {
      const projects = this.projects.length > 0 ? this.projects : (this.projectStore?.sessionProjects || []);
      return [...projects].sort((a, b) => {
        if (a.agentId !== b.agentId) return String(a.agentId).localeCompare(String(b.agentId));
        return (a.sortOrder ?? Number.MAX_SAFE_INTEGER) - (b.sortOrder ?? Number.MAX_SAFE_INTEGER);
      });
    },
    projectBySessionKey() {
      const out = new Map();
      for (const project of this.projectRows) {
        for (const sessionId of project.sessionIds || []) {
          out.set(`${project.agentId}\u001f${sessionId}`, project);
        }
      }
      return out;
    },
    rowsByProject() {
      const out = new Map(this.projectRows.map(project => [projectIdentityKey(project), []]));
      for (const row of this.sessions) {
        if (row.runtimeProvider !== 'yeaft' || !this.isRowOnline(row)) continue;
        const project = this.projectBySessionKey.get(`${row.routeRef?.agentId}\u001f${row.routeRef?.sessionId}`);
        const key = projectIdentityKey(project);
        if (project && out.has(key)) out.get(key).push(row);
      }
      for (const [id, rows] of out) out.set(id, sortRows(rows));
      return out;
    },
    recentRows() {
      return sortRows(this.sessions.filter(row => {
        if (!this.isRowOnline(row)) return false;
        if (row.runtimeProvider === 'yeaft') {
          const key = `${row.routeRef?.agentId}\u001f${row.routeRef?.sessionId}`;
          if (this.projectBySessionKey.has(key)) return false;
        }
        return true;
      }));
    },
    projectCreateAgentId() {
      return this.agents.find(agent => agent.id === this.activeRoute?.agentId && agent.online)?.id
        || this.agents.find(agent => agent.online)?.id
        || null;
    },
  },
  methods: {
    closeMenusFromDocument(event) {
      if (event?.target?.closest?.('.session-menu, .session-dots-btn')) return;
      this.openMenuKey = null;
      this.openProjectMenuKey = null;
    },
    closeMenusFromKeyboard(event) {
      if (event?.key !== 'Escape') return;
      this.openMenuKey = null;
      this.openProjectMenuKey = null;
      this.cancelProjectCreate();
    },
    isActive(row) {
      const route = row?.routeRef;
      const active = this.activeRoute;
      return !!route && !!active
        && route.runtimeProvider === active.runtimeProvider
        && route.agentId === active.agentId
        && route.sessionId === active.sessionId;
    },
    isProcessing(row) {
      if (row?.runtimeProvider === 'yeaft') {
        return typeof this.isYeaftSessionProcessing === 'function'
          ? !!this.isYeaftSessionProcessing(row.routeRef.sessionId, row.routeRef.agentId)
          : false;
      }
      return !!this.processingConversations?.[row?.routeRef?.sessionId];
    },
    isUnread(row) {
      return typeof this.isSessionUnread === 'function' ? !!this.isSessionUnread(row) : false;
    },
    projectKey(project) {
      return projectIdentityKey(project);
    },
    isAgentOnline(agentId) {
      return !!agentId && this.agents.some(agent => agent.id === agentId && agent.online);
    },
    isRowOnline(row) {
      if (row?.availability !== 'online') return false;
      const agent = this.agents.find(item => item.id === row?.routeRef?.agentId);
      return !agent || !!agent.online;
    },
    canEditProject(project) {
      return this.isAgentOnline(project?.agentId);
    },
    canEditRow(row) {
      if (!row?.routeRef?.agentId || row.availability !== 'online') return false;
      return this.isAgentOnline(row.routeRef.agentId);
    },
    isProjectCollapsed(project) {
      return this.collapsedProjects[projectIdentityKey(project)] === true;
    },
    toggleProject(project) {
      const key = projectIdentityKey(project);
      this.collapsedProjects = {
        ...this.collapsedProjects,
        [key]: !this.collapsedProjects[key],
      };
      this.openProjectMenuKey = null;
    },
    providerLabel(row) {
      if (row.runtimeProvider === 'yeaft') return 'Yeaft';
      if (row.runtimeProvider === 'copilot') return 'Copilot';
      return 'Claude';
    },
    agentLabel(row) {
      const agent = this.agents.find(item => item.id === row?.routeRef?.agentId);
      return row?.agentName || agent?.name || row?.routeRef?.agentId || '';
    },
    createSession() {
      if (this.workCenterOpen) this.$emit('close-work-center');
      this.$emit('create');
    },
    selectRow(row) {
      this.openMenuKey = null;
      if (this.workCenterOpen) this.$emit('close-work-center');
      this.$emit('select', row);
    },
    runAction(action, row) {
      this.openMenuKey = null;
      if (!this.canEditRow(row)) return;
      if (action === 'rename') {
        const title = window.prompt(this.$t('yeaft.session.renamePrompt', { name: row.title }), row.title);
        if (!title?.trim() || title.trim() === row.title) return;
        this.$emit('action', { action, row, title: title.trim() });
        return;
      }
      const normalizedAction = action === 'delete' ? 'remove' : action;
      this.$emit('action', { action: normalizedAction, row });
    },
    dispatchProjectAction(payload) {
      const ownerAgentId = payload?.agentId || payload?.project?.agentId || payload?.row?.routeRef?.agentId || null;
      if (!this.isAgentOnline(ownerAgentId)) return false;
      this.$emit('project-action', payload);
      const store = this.projectStore;
      if (!store?.mutateProject) return true;
      const { action, project, row, name, agentId: explicitAgentId } = payload;
      const agentId = explicitAgentId || project?.agentId || row?.routeRef?.agentId || store.currentAgent;
      if (action === 'create') return store.mutateProject('create', { name }, agentId);
      if (action === 'rename') return store.mutateProject('rename', { projectId: project.id, name }, agentId);
      if (action === 'delete') return store.mutateProject('delete', { projectId: project.id }, agentId);
      if (action === 'move-session' && row?.routeRef?.sessionId) {
        return store.mutateProject('move_session', {
          sessionId: row.routeRef.sessionId,
          projectId: project?.id || null,
        }, agentId);
      }
      return false;
    },
    createProject() {
      if (!this.projectCreateAgentId || this.projectCreateSubmitting) return;
      this.projectCreateOpen = true;
      this.projectCreateName = '';
      this.$nextTick(() => this.$refs.projectCreateInput?.focus?.());
    },
    cancelProjectCreate() {
      if (this.projectCreateSubmitting) return;
      this.projectCreateOpen = false;
      this.projectCreateName = '';
    },
    async submitProjectCreate() {
      const name = this.projectCreateName.trim();
      const agentId = this.projectCreateAgentId;
      if (!name || !agentId || this.projectCreateSubmitting) return;
      this.projectCreateSubmitting = true;
      try {
        const result = await this.dispatchProjectAction({ action: 'create', name, agentId });
        if (result?.ok !== false) {
          this.projectCreateOpen = false;
          this.projectCreateName = '';
        }
      } finally {
        this.projectCreateSubmitting = false;
      }
    },
    renameProject(project) {
      if (!this.canEditProject(project)) return;
      const name = window.prompt(this.$t('sidebar.projects.renamePrompt'), project.name);
      this.openProjectMenuKey = null;
      if (name?.trim() && name.trim() !== project.name) {
        this.dispatchProjectAction({ action: 'rename', project, name: name.trim() });
      }
    },
    deleteProject(project) {
      if (!this.canEditProject(project)) return;
      this.openProjectMenuKey = null;
      if (window.confirm(this.$t('sidebar.projects.deleteConfirm', { name: project.name }))) {
        this.dispatchProjectAction({ action: 'delete', project });
      }
    },
    moveRow(row, project = null) {
      this.openMenuKey = null;
      if (!this.canEditRow(row) || (project && !this.canEditProject(project))) return;
      this.dispatchProjectAction({ action: 'move-session', row, project });
    },
    startDrag(row, event) {
      if (row.runtimeProvider !== 'yeaft' || !this.canEditRow(row)) return;
      this.draggedRow = row;
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', row.catalogKey);
    },
    dragOverProject(project, event) {
      if (!this.draggedRow || project.agentId !== this.draggedRow.routeRef?.agentId) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      this.dragTargetProjectId = projectIdentityKey(project);
    },
    dropOnProject(project, event) {
      event.preventDefault();
      if (this.draggedRow && project.agentId === this.draggedRow.routeRef?.agentId) {
        this.moveRow(this.draggedRow, project);
      }
      this.finishDrag();
    },
    dragOverRecents(event) {
      if (!this.draggedRow) return;
      event.preventDefault();
      this.dragTargetProjectId = '__recents__';
    },
    dropOnRecents(event) {
      event.preventDefault();
      if (this.draggedRow) this.moveRow(this.draggedRow, null);
      this.finishDrag();
    },
    finishDrag() {
      this.draggedRow = null;
      this.dragTargetProjectId = null;
    },
  },
  template: `
    <nav class="sidebar-navigation" :aria-label="$t('sidebar.surface.sessions')">
      <div class="sidebar-primary-actions">
        <button type="button" class="sidebar-primary-action" @click="createSession">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M4 4h16v13H7l-3 3V4zm2 2v9.17L6.17 15H18V6H6zm5 2h2v2h2v2h-2v2h-2v-2H9v-2h2V8z"/></svg>
          <span>{{ $t('sidebar.sessions.newChat') }}</span>
        </button>
      </div>

      <div class="sidebar-session-results">
        <section class="sidebar-section projects-section">
          <div class="sidebar-section-heading">
            <span>{{ $t('sidebar.projects.title') }}</span>
            <button type="button" class="sidebar-tool-button" @click="createProject" :disabled="!projectCreateAgentId || projectCreateOpen" :title="$t('sidebar.projects.new')" :aria-label="$t('sidebar.projects.new')">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M11 5h2v6h6v2h-6v6h-2v-6H5v-2h6V5z"/></svg>
            </button>
          </div>

          <form v-if="projectCreateOpen" class="sidebar-project-create" @submit.prevent="submitProjectCreate" @keydown.escape.stop.prevent="cancelProjectCreate">
            <svg class="sidebar-project-create-icon" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M3 6h7l2 2h9v10H3V6zm2 2v8h14v-6h-8l-2-2H5z"/></svg>
            <input
              ref="projectCreateInput"
              v-model="projectCreateName"
              type="text"
              :placeholder="$t('sidebar.projects.namePrompt')"
              :aria-label="$t('sidebar.projects.namePrompt')"
              :disabled="projectCreateSubmitting"
            />
            <button type="submit" class="sidebar-project-create-confirm" :disabled="!projectCreateName.trim() || projectCreateSubmitting" :title="$t('common.confirm')" :aria-label="$t('common.confirm')">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="m5 12 4 4L19 6"/></svg>
            </button>
            <button type="button" class="sidebar-project-create-cancel" :disabled="projectCreateSubmitting" @click="cancelProjectCreate" :title="$t('common.cancel')" :aria-label="$t('common.cancel')">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" d="m7 7 10 10M17 7 7 17"/></svg>
            </button>
          </form>

          <div v-if="projectRows.length === 0 && !projectCreateOpen" class="sidebar-section-empty">{{ $t('sidebar.projects.empty') }}</div>
          <div v-for="project in projectRows" :key="projectKey(project)" class="sidebar-project">
            <div
              class="sidebar-project-header"
              :class="{ 'drag-over': dragTargetProjectId === projectKey(project) }"
              @dragover="dragOverProject(project, $event)"
              @dragleave="dragTargetProjectId = null"
              @drop="dropOnProject(project, $event)"
            >
              <button type="button" class="sidebar-project-toggle" @click="toggleProject(project)">
                <svg class="sidebar-project-chevron" :class="{ collapsed: isProjectCollapsed(project) }" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="m7 10 5 5 5-5H7z"/></svg>
                <svg class="sidebar-project-icon" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M3 6h7l2 2h9v10H3V6zm2 2v8h14v-6h-8l-2-2H5z"/></svg>
                <span>{{ project.name }}</span>
                <span class="sidebar-project-count">{{ (rowsByProject.get(projectKey(project)) || []).length }}</span>
              </button>
              <button v-if="canEditProject(project)" type="button" class="session-dots-btn" :class="{ 'menu-open': openProjectMenuKey === projectKey(project) }" @click.stop="openProjectMenuKey = openProjectMenuKey === projectKey(project) ? null : projectKey(project)" :aria-label="$t('sidebar.projects.menu')">
                <svg viewBox="0 0 24 24"><path fill="currentColor" d="M6 10a2 2 0 1 0 0 4 2 2 0 0 0 0-4zm6 0a2 2 0 1 0 0 4 2 2 0 0 0 0-4zm6 0a2 2 0 1 0 0 4 2 2 0 0 0 0-4z"/></svg>
              </button>
              <div v-if="openProjectMenuKey === projectKey(project)" class="session-menu">
                <button class="session-menu-item" @click.stop="renameProject(project)">{{ $t('sidebar.projects.rename') }}</button>
                <button class="session-menu-item danger" @click.stop="deleteProject(project)">{{ $t('sidebar.projects.delete') }}</button>
              </div>
            </div>
            <div v-if="!isProjectCollapsed(project)" class="sidebar-project-sessions">
              <div
                v-for="row in rowsByProject.get(projectKey(project)) || []"
                :key="row.catalogKey"
                class="session-item sidebar-session-row"
                :class="{ active: isActive(row), processing: isProcessing(row) }"
                :draggable="row.runtimeProvider === 'yeaft' && canEditRow(row)"
                role="button"
                tabindex="0"
                @dragstart="startDrag(row, $event)"
                @dragend="finishDrag"
                @click="selectRow(row)"
                @keydown.enter.prevent="selectRow(row)"
                @keydown.space.prevent="selectRow(row)"
              >
                <span class="sidebar-session-copy">
                  <span class="title" :title="row.title">
                    <span class="sidebar-session-title-text">{{ row.title }}</span>
                    <span v-if="isUnread(row)" class="sidebar-session-unread" :aria-label="$t('sidebar.sessions.unread')"></span>
                  </span>
                </span>
                <span v-if="canEditRow(row)" class="session-actions">
                  <button type="button" class="session-dots-btn" :class="{ 'menu-open': openMenuKey === row.catalogKey }" @click.stop="openMenuKey = openMenuKey === row.catalogKey ? null : row.catalogKey" :aria-label="$t('sidebar.sessions.menu')"><svg viewBox="0 0 24 24"><path fill="currentColor" d="M6 10a2 2 0 1 0 0 4 2 2 0 0 0 0-4zm6 0a2 2 0 1 0 0 4 2 2 0 0 0 0-4zm6 0a2 2 0 1 0 0 4 2 2 0 0 0 0-4z"/></svg></button>
                  <div v-if="openMenuKey === row.catalogKey" class="session-menu">
                    <button class="session-menu-item" @click.stop="runAction('pin', row)">{{ row.pinned ? $t('chat.sidebar.unpin') : $t('chat.sidebar.pin') }}</button>
                    <button class="session-menu-item" @click.stop="runAction('rename', row)">{{ $t('chat.sidebar.renameConv') }}</button>
                    <button class="session-menu-item" @click.stop="runAction('settings', row)">{{ $t('yeaft.session.openSettings') }}</button>
                    <button class="session-menu-item" @click.stop="moveRow(row, null)">{{ $t('sidebar.projects.remove') }}</button>
                    <button class="session-menu-item danger" @click.stop="runAction('delete', row)">{{ $t('common.delete') }}</button>
                    <div class="sidebar-session-menu-divider"></div>
                    <div class="sidebar-session-menu-info">
                      <span><span>{{ $t('sidebar.sessions.agent') }}</span><strong :title="agentLabel(row)">{{ agentLabel(row) }}</strong></span>
                      <span><span>{{ $t('sidebar.sessions.provider') }}</span><strong>{{ providerLabel(row) }}</strong></span>
                    </div>
                  </div>
                </span>
              </div>
              <div v-if="(rowsByProject.get(projectKey(project)) || []).length === 0" class="sidebar-section-empty">{{ $t('sidebar.projects.noSessions') }}</div>
            </div>
          </div>
        </section>

        <section class="sidebar-section recents-section" :class="{ 'drag-over': dragTargetProjectId === '__recents__' }" @dragover="dragOverRecents" @dragleave="dragTargetProjectId = null" @drop="dropOnRecents">
          <div class="sidebar-section-heading"><span>{{ $t('sidebar.recents.title') }}</span></div>
          <div
            v-for="row in recentRows"
            :key="row.catalogKey"
            class="session-item sidebar-session-row"
            :class="{ active: isActive(row), processing: isProcessing(row) }"
            :draggable="row.runtimeProvider === 'yeaft' && canEditRow(row)"
            role="button"
            tabindex="0"
            @dragstart="startDrag(row, $event)"
            @dragend="finishDrag"
            @click="selectRow(row)"
            @keydown.enter.prevent="selectRow(row)"
            @keydown.space.prevent="selectRow(row)"
          >
            <span class="sidebar-session-copy">
              <span class="title" :title="row.title">
                <span class="sidebar-session-title-text">{{ row.title }}</span>
                <span v-if="isUnread(row)" class="sidebar-session-unread" :aria-label="$t('sidebar.sessions.unread')"></span>
              </span>
            </span>
            <span v-if="canEditRow(row)" class="session-actions">
              <button type="button" class="session-dots-btn" :class="{ 'menu-open': openMenuKey === row.catalogKey }" @click.stop="openMenuKey = openMenuKey === row.catalogKey ? null : row.catalogKey" :aria-label="$t('sidebar.sessions.menu')"><svg viewBox="0 0 24 24"><path fill="currentColor" d="M6 10a2 2 0 1 0 0 4 2 2 0 0 0 0-4zm6 0a2 2 0 1 0 0 4 2 2 0 0 0 0-4zm6 0a2 2 0 1 0 0 4 2 2 0 0 0 0-4z"/></svg></button>
              <div v-if="openMenuKey === row.catalogKey" class="session-menu">
                <button class="session-menu-item" @click.stop="runAction('pin', row)">{{ row.pinned ? $t('chat.sidebar.unpin') : $t('chat.sidebar.pin') }}</button>
                <button class="session-menu-item" @click.stop="runAction('rename', row)">{{ $t('chat.sidebar.renameConv') }}</button>
                <template v-if="row.runtimeProvider === 'yeaft'">
                  <button class="session-menu-item" @click.stop="runAction('settings', row)">{{ $t('yeaft.session.openSettings') }}</button>
                  <button v-for="project in projectRows.filter(item => item.agentId === row.routeRef.agentId)" :key="project.id" class="session-menu-item" @click.stop="moveRow(row, project)">{{ $t('sidebar.projects.moveTo', { name: project.name }) }}</button>
                </template>
                <button class="session-menu-item danger" @click.stop="runAction('delete', row)">{{ $t('common.delete') }}</button>
                <div class="sidebar-session-menu-divider"></div>
                <div class="sidebar-session-menu-info">
                  <span><span>{{ $t('sidebar.sessions.agent') }}</span><strong :title="agentLabel(row)">{{ agentLabel(row) }}</strong></span>
                  <span><span>{{ $t('sidebar.sessions.provider') }}</span><strong>{{ providerLabel(row) }}</strong></span>
                </div>
              </div>
            </span>
          </div>
          <div v-if="recentRows.length === 0" class="sidebar-section-empty">{{ $t('sidebar.recents.empty') }}</div>
        </section>
      </div>
    </nav>
  `,
};
