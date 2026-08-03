function timestampValue(value) {
  const parsed = typeof value === 'number' ? value : Date.parse(value || '');
  return Number.isFinite(parsed) ? parsed : 0;
}

function sortRows(rows) {
  return [...rows].sort((left, right) => {
    if (!!left.pinned !== !!right.pinned) return left.pinned ? -1 : 1;
    const metadataDelta = timestampValue(right.metadataUpdatedAt || right.createdAt)
      - timestampValue(left.metadataUpdatedAt || left.createdAt);
    if (metadataDelta !== 0) return metadataDelta;
    return String(left.catalogKey || '').localeCompare(String(right.catalogKey || ''));
  });
}

function projectIdentityKey(project) {
  return project?.id || '';
}

export function calculateFloatingMenuPosition(triggerRect, menuSize, viewport = {}) {
  const gap = 4;
  const padding = 8;
  const viewportWidth = Math.max(0, Number(viewport.width) || 0);
  const viewportHeight = Math.max(0, Number(viewport.height) || 0);
  const width = Math.min(
    Math.max(160, Number(menuSize?.width) || 0),
    Math.max(0, viewportWidth - padding * 2),
  );
  const desiredHeight = Math.max(0, Number(menuSize?.height) || 0);
  const below = Math.max(0, viewportHeight - triggerRect.bottom - gap - padding);
  const above = Math.max(0, triggerRect.top - gap - padding);
  const placeAbove = below < desiredHeight && above > below;
  const maxHeight = Math.min(desiredHeight, placeAbove ? above : below);
  const left = Math.min(
    Math.max(padding, triggerRect.right - width),
    Math.max(padding, viewportWidth - padding - width),
  );
  const naturalTop = placeAbove
    ? triggerRect.top - gap - maxHeight
    : triggerRect.bottom + gap;
  const top = Math.min(
    Math.max(padding, naturalTop),
    Math.max(padding, viewportHeight - padding - maxHeight),
  );
  return { top, left, width, maxHeight, placement: placeAbove ? 'above' : 'below' };
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
      projectInstructionOpen: false,
      projectInstructionProject: null,
      projectInstructionDraft: '',
      projectInstructionSubmitting: false,
      floatingMenu: null,
      floatingMenuStyle: {},
      floatingMenuTrigger: null,
    };
  },
  mounted() {
    document.addEventListener('pointerdown', this.closeMenusFromDocument, true);
    document.addEventListener('keydown', this.closeMenusFromKeyboard);
    window.addEventListener('resize', this.positionFloatingMenu);
    window.addEventListener('scroll', this.positionFloatingMenu, true);
  },
  beforeUnmount() {
    document.removeEventListener('pointerdown', this.closeMenusFromDocument, true);
    document.removeEventListener('keydown', this.closeMenusFromKeyboard);
    window.removeEventListener('resize', this.positionFloatingMenu);
    window.removeEventListener('scroll', this.positionFloatingMenu, true);
  },
  computed: {
    projectStore() {
      try { return window.Pinia?.useChatStore?.() || null; } catch { return null; }
    },
    projectRows() {
      const projects = this.projects.length > 0 ? this.projects : (this.projectStore?.sessionProjects || []);
      return [...projects].sort((a, b) => (
        (a.sortOrder ?? Number.MAX_SAFE_INTEGER) - (b.sortOrder ?? Number.MAX_SAFE_INTEGER)
      ));
    },
    projectBySessionKey() {
      const out = new Map();
      for (const project of this.projectRows) {
        const members = Array.isArray(project.members)
          ? project.members
          : (project.agentId
              ? (project.sessionIds || []).map(sessionId => ({ agentId: project.agentId, sessionId }))
              : []);
        for (const member of members) {
          if (member?.agentId && member?.sessionId) {
            out.set(`${member.agentId}\u001f${member.sessionId}`, project);
          }
        }
      }
      return out;
    },
    projectSessionRows() {
      const out = new Map(this.projectRows.map(project => [projectIdentityKey(project), []]));
      for (const row of this.sessions) {
        if (row.runtimeProvider !== 'yeaft') continue;
        const project = this.projectBySessionKey.get(`${row.routeRef?.agentId}\u001f${row.routeRef?.sessionId}`);
        const key = projectIdentityKey(project);
        if (project && out.has(key)) out.get(key).push(row);
      }
      return out;
    },
    rowsByProject() {
      const out = new Map();
      for (const [id, rows] of this.projectSessionRows) {
        out.set(id, sortRows(rows.filter(row => this.isRowOnline(row))));
      }
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
  },
  methods: {
    closeMenus() {
      this.openMenuKey = null;
      this.openProjectMenuKey = null;
      this.floatingMenu = null;
      this.floatingMenuStyle = {};
      this.floatingMenuTrigger = null;
    },
    closeMenusFromDocument(event) {
      if (event?.target?.closest?.('.session-menu, .session-dots-btn')) return;
      this.closeMenus();
    },
    closeMenusFromKeyboard(event) {
      if (event?.key !== 'Escape') return;
      this.closeMenus();
      this.cancelProjectCreate();
      if (this.projectInstructionOpen) this.closeProjectInstruction();
    },
    toggleProjectMenu(project, event) {
      const key = projectIdentityKey(project);
      if (this.openProjectMenuKey === key) {
        this.closeMenus();
        return;
      }
      this.openMenuKey = null;
      this.openProjectMenuKey = key;
      this.floatingMenu = { kind: 'project', project };
      this.floatingMenuTrigger = event?.currentTarget || null;
      this.$nextTick(this.positionFloatingMenu);
    },
    toggleSessionMenu(row, inProject, event) {
      if (this.openMenuKey === row.catalogKey) {
        this.closeMenus();
        return;
      }
      this.openProjectMenuKey = null;
      this.openMenuKey = row.catalogKey;
      this.floatingMenu = {
        kind: 'session',
        row,
        inProject: inProject === true,
        currentProject: this.projectBySessionKey.get(`${row.routeRef?.agentId}\u001f${row.routeRef?.sessionId}`) || null,
        page: 'actions',
      };
      this.floatingMenuTrigger = event?.currentTarget || null;
      this.$nextTick(this.positionFloatingMenu);
    },
    positionFloatingMenu() {
      const trigger = this.floatingMenuTrigger;
      const menu = this.$refs.floatingMenu;
      if (!this.floatingMenu || !trigger?.isConnected || !menu) {
        if (this.floatingMenu && trigger && !trigger.isConnected) this.closeMenus();
        return;
      }
      const position = calculateFloatingMenuPosition(trigger.getBoundingClientRect(), {
        width: menu.scrollWidth || menu.offsetWidth || 160,
        height: menu.scrollHeight || menu.offsetHeight || 0,
      }, {
        width: document.documentElement.clientWidth || window.innerWidth,
        height: document.documentElement.clientHeight || window.innerHeight,
      });
      this.floatingMenuStyle = {
        top: `${position.top}px`,
        left: `${position.left}px`,
        width: `${position.width}px`,
        maxHeight: `${position.maxHeight}px`,
      };
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
    isProjectUnread(project) {
      const rows = this.projectSessionRows.get(projectIdentityKey(project)) || [];
      return rows.some(row => this.isUnread(row));
    },
    projectKey(project) {
      return projectIdentityKey(project);
    },
    isAgentOnline(agentId) {
      return !!agentId && this.agents.some(agent => agent.id === agentId && agent.online);
    },
    isRowOnline(row) {
      if (row?.availability !== 'online') return false;
      return this.isAgentOnline(row?.routeRef?.agentId);
    },
    canEditProject(project) {
      if (!project?.id) return false;
      return !project.legacyAgentId || this.isAgentOnline(project.legacyAgentId);
    },
    canEditRow(row) {
      if (!row?.routeRef?.agentId || row.availability !== 'online') return false;
      return this.isAgentOnline(row.routeRef.agentId);
    },
    canMoveRowToProject(row, project = null) {
      if (!this.canEditRow(row)) return false;
      if (!project) return true;
      if (!this.canEditProject(project)) return false;
      return !project.legacyAgentId || project.legacyAgentId === row.routeRef.agentId;
    },
    projectMoveTargets(row, currentProject = null) {
      const currentProjectId = projectIdentityKey(currentProject);
      return this.projectRows.filter(project => (
        projectIdentityKey(project) !== currentProjectId
        && this.canMoveRowToProject(row, project)
      ));
    },
    openProjectMoveList() {
      if (!this.floatingMenu || this.floatingMenu.kind !== 'session') return;
      this.floatingMenu = { ...this.floatingMenu, page: 'projects' };
      this.$nextTick(this.positionFloatingMenu);
    },
    closeProjectMoveList() {
      if (!this.floatingMenu || this.floatingMenu.kind !== 'session') return;
      this.floatingMenu = { ...this.floatingMenu, page: 'actions' };
      this.$nextTick(this.positionFloatingMenu);
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
      this.closeMenus();
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
      this.closeMenus();
      if (this.workCenterOpen) this.$emit('close-work-center');
      this.$emit('select', row);
    },
    selectRowFromKeyboard(row, event) {
      if (event?.target !== event?.currentTarget) return;
      event.preventDefault();
      this.selectRow(row);
    },
    runAction(action, row) {
      this.closeMenus();
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
      if (payload?.action === 'move-session'
          && !this.canMoveRowToProject(payload?.row, payload?.project || null)) return false;
      this.$emit('project-action', payload);
      const store = this.projectStore;
      if (!store?.mutateProject) return true;
      const { action, project, row, name, agentId: explicitAgentId } = payload;
      const agentId = explicitAgentId || row?.routeRef?.agentId || null;
      if (action === 'create') return store.mutateProject('create', { name }, agentId);
      const projectId = project?.legacyProjectId || project?.id;
      if (action === 'rename') return store.mutateProject('rename', { projectId, name }, project?.legacyAgentId || agentId);
      if (action === 'update-instruction') {
        return store.mutateProject('update_instruction', {
          projectId,
          instruction: payload.instruction || '',
        }, project?.legacyAgentId || agentId);
      }
      if (action === 'delete') return store.mutateProject('delete', { projectId }, project?.legacyAgentId || agentId);
      if (action === 'move-session' && row?.routeRef?.sessionId) {
        return store.mutateProject('move_session', {
          sessionId: row.routeRef.sessionId,
          projectId: project?.legacyProjectId || project?.id || null,
        }, agentId);
      }
      return false;
    },
    createProject() {
      if (this.projectCreateSubmitting) return;
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
      if (!name || this.projectCreateSubmitting) return;
      this.projectCreateSubmitting = true;
      try {
        const result = await this.dispatchProjectAction({ action: 'create', name });
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
      this.closeMenus();
      if (name?.trim() && name.trim() !== project.name) {
        this.dispatchProjectAction({ action: 'rename', project, name: name.trim() });
      }
    },
    deleteProject(project) {
      if (!this.canEditProject(project)) return;
      this.closeMenus();
      if (window.confirm(this.$t('sidebar.projects.deleteConfirm', { name: project.name }))) {
        this.dispatchProjectAction({ action: 'delete', project });
      }
    },
    editProjectInstruction(project) {
      if (!this.canEditProject(project)) return;
      this.closeMenus();
      this.projectInstructionProject = project;
      this.projectInstructionDraft = typeof project.instruction === 'string' ? project.instruction : '';
      this.projectInstructionOpen = true;
      this.$nextTick(() => this.$refs.projectInstructionInput?.focus?.());
    },
    closeProjectInstruction() {
      if (this.projectInstructionSubmitting) return;
      this.projectInstructionOpen = false;
      this.projectInstructionProject = null;
      this.projectInstructionDraft = '';
    },
    async saveProjectInstruction() {
      const project = this.projectInstructionProject;
      if (!project || this.projectInstructionSubmitting) return;
      this.projectInstructionSubmitting = true;
      try {
        const result = await this.dispatchProjectAction({
          action: 'update-instruction',
          project,
          instruction: this.projectInstructionDraft,
        });
        if (result?.ok !== false) {
          this.projectInstructionOpen = false;
          this.projectInstructionProject = null;
          this.projectInstructionDraft = '';
        }
      } finally {
        this.projectInstructionSubmitting = false;
      }
    },
    moveRow(row, project = null) {
      this.closeMenus();
      if (!this.canMoveRowToProject(row, project)) return false;
      return this.dispatchProjectAction({ action: 'move-session', row, project });
    },
    startDrag(row, event) {
      if (row.runtimeProvider !== 'yeaft' || !this.canEditRow(row)) return;
      this.draggedRow = row;
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', row.catalogKey);
    },
    dragOverProject(project, event) {
      if (!this.canMoveRowToProject(this.draggedRow, project)) {
        this.dragTargetProjectId = null;
        return;
      }
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      this.dragTargetProjectId = projectIdentityKey(project);
    },
    dropOnProject(project, event) {
      event.preventDefault();
      if (this.canMoveRowToProject(this.draggedRow, project)) this.moveRow(this.draggedRow, project);
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
        <button type="button" class="sidebar-primary-action" @click="createSession" :title="$t('sidebar.sessions.newChat')" :aria-label="$t('sidebar.sessions.newChat')">
          <svg class="sidebar-primary-action-icon" viewBox="0 0 24 24" aria-hidden="true">
            <path class="sidebar-primary-action-frame" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
            <path class="sidebar-primary-action-pen" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" d="M18.375 2.625a1 1 0 0 1 3 3l-9.013 9.014a2 2 0 0 1-.853.505l-2.873.84a.5.5 0 0 1-.62-.62l.84-2.873a2 2 0 0 1 .506-.852Z"/>
          </svg>
          <span>{{ $t('sidebar.sessions.newChat') }}</span>
        </button>
      </div>

      <div class="sidebar-session-results">
        <section class="sidebar-section projects-section">
          <div class="sidebar-section-heading">
            <span>{{ $t('sidebar.projects.title') }}</span>
            <button type="button" class="sidebar-tool-button sidebar-project-add-button" @click="createProject" :disabled="projectCreateOpen" :title="$t('sidebar.projects.new')" :aria-label="$t('sidebar.projects.new')">
              <svg class="sidebar-project-add-icon" viewBox="0 0 24 24" aria-hidden="true">
                <path class="sidebar-project-add-mark" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" d="M12 5v14M5 12h14"/>
              </svg>
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
                <span v-if="isProjectUnread(project)" class="sidebar-session-unread sidebar-project-unread" :aria-label="$t('sidebar.sessions.unread')"></span>
                <span class="sidebar-project-count">{{ (rowsByProject.get(projectKey(project)) || []).length }}</span>
              </button>
              <button v-if="canEditProject(project)" type="button" class="session-dots-btn" :class="{ 'menu-open': openProjectMenuKey === projectKey(project) }" @click.stop="toggleProjectMenu(project, $event)" :aria-label="$t('sidebar.projects.menu')">
                <svg viewBox="0 0 24 24"><path fill="currentColor" d="M6 10a2 2 0 1 0 0 4 2 2 0 0 0 0-4zm6 0a2 2 0 1 0 0 4 2 2 0 0 0 0-4zm6 0a2 2 0 1 0 0 4 2 2 0 0 0 0-4z"/></svg>
              </button>
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
                @keydown.enter="selectRowFromKeyboard(row, $event)"
                @keydown.space="selectRowFromKeyboard(row, $event)"
              >
                <span v-if="row.pinned" class="session-pin-icon" :aria-label="$t('sidebar.sessions.pinned')"><svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M16 12V4h1V2H7v2h1v8l-2 2v2h5.2v6h1.6v-6H18v-2l-2-2z"/></svg></span>
                <span class="sidebar-session-copy">
                  <span class="title" :title="row.title">
                    <span v-if="isProcessing(row)" class="processing-dot" :aria-label="$t('sidebar.sessions.processing')"></span>
                    <span class="sidebar-session-title-text">{{ row.title }}</span>
                    <span v-if="isUnread(row)" class="sidebar-session-unread" :aria-label="$t('sidebar.sessions.unread')"></span>
                  </span>
                </span>
                <span v-if="canEditRow(row)" class="session-actions" :class="{ 'menu-open': openMenuKey === row.catalogKey }">
                  <button type="button" class="session-quick-action" @click.stop="runAction('pin', row)" :title="row.pinned ? $t('chat.sidebar.unpin') : $t('chat.sidebar.pin')" :aria-label="row.pinned ? $t('chat.sidebar.unpin') : $t('chat.sidebar.pin')">
                    <svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M16 12V4h1V2H7v2h1v8l-2 2v2h5.2v6h1.6v-6H18v-2l-2-2z"/></svg>
                  </button>
                  <button type="button" class="session-quick-action" @click.stop="runAction('delete', row)" :title="row.runtimeProvider === 'yeaft' ? $t('yeaft.session.removeFromList') : $t('common.delete')" :aria-label="row.runtimeProvider === 'yeaft' ? $t('yeaft.session.removeFromList') : $t('common.delete')">
                    <svg viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" d="M4 7h16v13H4zM3 4h18v3H3zm6 7h6"/></svg>
                  </button>
                  <button type="button" class="session-dots-btn" :class="{ 'menu-open': openMenuKey === row.catalogKey }" @click.stop="toggleSessionMenu(row, true, $event)" :aria-label="$t('sidebar.sessions.menu')"><svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M6 10a2 2 0 1 0 0 4 2 2 0 0 0 0-4zm6 0a2 2 0 1 0 0 4 2 2 0 0 0 0-4zm6 0a2 2 0 1 0 0 4 2 2 0 0 0 0-4z"/></svg></button>
                </span>
              </div>
              <div v-if="(rowsByProject.get(projectKey(project)) || []).length === 0" class="sidebar-section-empty">{{ $t('sidebar.projects.noSessions') }}</div>
            </div>
          </div>
        </section>

        <section class="sidebar-section recents-section" :class="{ 'drag-over': dragTargetProjectId === '__recents__' }" @dragover="dragOverRecents" @dragleave="dragTargetProjectId = null" @drop="dropOnRecents">
          <div class="sidebar-section-heading">
            <span>{{ $t('sidebar.recents.title') }}</span>
            <button type="button" class="sidebar-tool-button sidebar-recents-create" @click="createSession" :title="$t('sidebar.sessions.newChat')" :aria-label="$t('sidebar.sessions.newChat')">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M4 4h16v13H7l-3 3V4zm2 2v9.17L6.17 15H18V6H6zm5 2h2v2h2v2h-2v2h-2v-2H9v-2h2V8z"/></svg>
            </button>
          </div>
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
            @keydown.enter="selectRowFromKeyboard(row, $event)"
            @keydown.space="selectRowFromKeyboard(row, $event)"
          >
            <span v-if="row.pinned" class="session-pin-icon" :aria-label="$t('sidebar.sessions.pinned')"><svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M16 12V4h1V2H7v2h1v8l-2 2v2h5.2v6h1.6v-6H18v-2l-2-2z"/></svg></span>
            <span class="sidebar-session-copy">
              <span class="title" :title="row.title">
                <span v-if="isProcessing(row)" class="processing-dot" :aria-label="$t('sidebar.sessions.processing')"></span>
                <span class="sidebar-session-title-text">{{ row.title }}</span>
                <span v-if="isUnread(row)" class="sidebar-session-unread" :aria-label="$t('sidebar.sessions.unread')"></span>
              </span>
            </span>
            <span v-if="canEditRow(row)" class="session-actions" :class="{ 'menu-open': openMenuKey === row.catalogKey }">
              <button type="button" class="session-quick-action" @click.stop="runAction('pin', row)" :title="row.pinned ? $t('chat.sidebar.unpin') : $t('chat.sidebar.pin')" :aria-label="row.pinned ? $t('chat.sidebar.unpin') : $t('chat.sidebar.pin')">
                <svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M16 12V4h1V2H7v2h1v8l-2 2v2h5.2v6h1.6v-6H18v-2l-2-2z"/></svg>
              </button>
              <button type="button" class="session-quick-action" @click.stop="runAction('delete', row)" :title="row.runtimeProvider === 'yeaft' ? $t('yeaft.session.removeFromList') : $t('common.delete')" :aria-label="row.runtimeProvider === 'yeaft' ? $t('yeaft.session.removeFromList') : $t('common.delete')">
                <svg viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" d="M4 7h16v13H4zM3 4h18v3H3zm6 7h6"/></svg>
              </button>
              <button type="button" class="session-dots-btn" :class="{ 'menu-open': openMenuKey === row.catalogKey }" @click.stop="toggleSessionMenu(row, false, $event)" :aria-label="$t('sidebar.sessions.menu')"><svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M6 10a2 2 0 1 0 0 4 2 2 0 0 0 0-4zm6 0a2 2 0 1 0 0 4 2 2 0 0 0 0-4zm6 0a2 2 0 1 0 0 4 2 2 0 0 0 0-4z"/></svg></button>
            </span>
          </div>
          <div v-if="recentRows.length === 0" class="sidebar-section-empty">{{ $t('sidebar.recents.empty') }}</div>
        </section>
      </div>

      <Teleport to="body">
        <div v-if="floatingMenu" ref="floatingMenu" class="session-menu session-menu-floating" :style="floatingMenuStyle">
          <template v-if="floatingMenu.kind === 'project'">
            <button class="session-menu-item" @click.stop="editProjectInstruction(floatingMenu.project)">{{ $t('sidebar.projects.instructions') }}</button>
            <button class="session-menu-item" @click.stop="renameProject(floatingMenu.project)">{{ $t('sidebar.projects.rename') }}</button>
            <button class="session-menu-item danger" @click.stop="deleteProject(floatingMenu.project)">{{ $t('sidebar.projects.delete') }}</button>
          </template>
          <template v-else-if="floatingMenu.page === 'projects'">
            <button class="session-menu-item session-menu-back" @click.stop="closeProjectMoveList">{{ $t('sidebar.projects.moveBack') }}</button>
            <button v-for="project in projectMoveTargets(floatingMenu.row, floatingMenu.currentProject)" :key="project.id" class="session-menu-item" @click.stop="moveRow(floatingMenu.row, project)">{{ project.name }}</button>
            <div v-if="projectMoveTargets(floatingMenu.row, floatingMenu.currentProject).length === 0" class="session-menu-empty">{{ $t('sidebar.projects.moveEmpty') }}</div>
          </template>
          <template v-else>
            <button class="session-menu-item" @click.stop="runAction('rename', floatingMenu.row)">{{ $t('chat.sidebar.renameConv') }}</button>
            <template v-if="floatingMenu.row.runtimeProvider === 'yeaft'">
              <button class="session-menu-item" @click.stop="runAction('settings', floatingMenu.row)">{{ $t('yeaft.session.openSettings') }}</button>
              <button v-if="floatingMenu.inProject" class="session-menu-item" @click.stop="moveRow(floatingMenu.row, null)">{{ $t('sidebar.projects.remove') }}</button>
              <button class="session-menu-item session-menu-parent" @click.stop="openProjectMoveList">
                <span>{{ $t('sidebar.projects.moveMenu') }}</span>
                <span aria-hidden="true">&rsaquo;</span>
              </button>
            </template>
            <div class="sidebar-session-menu-info">
              <strong :title="agentLabel(floatingMenu.row)">{{ agentLabel(floatingMenu.row) }}</strong>
              <strong>{{ providerLabel(floatingMenu.row) }}</strong>
            </div>
          </template>
        </div>
      </Teleport>

      <Teleport to="body">
        <div v-if="projectInstructionOpen" class="modal-overlay" @click.self="closeProjectInstruction">
          <form class="modal modal-card project-instruction-modal" role="dialog" aria-modal="true" :aria-label="$t('sidebar.projects.instructionsTitle', { name: projectInstructionProject?.name || '' })" @submit.prevent="saveProjectInstruction">
            <div class="project-instruction-header">
              <div>
                <h3>{{ $t('sidebar.projects.instructionsTitle', { name: projectInstructionProject?.name || '' }) }}</h3>
                <p>{{ $t('sidebar.projects.instructionsHint') }}</p>
              </div>
              <button type="button" class="modal-close" :disabled="projectInstructionSubmitting" @click="closeProjectInstruction" :aria-label="$t('common.close')">&times;</button>
            </div>
            <div class="project-instruction-body">
              <textarea ref="projectInstructionInput" v-model="projectInstructionDraft" maxlength="20000" :disabled="projectInstructionSubmitting" :placeholder="$t('sidebar.projects.instructionsPlaceholder')"></textarea>
              <span class="project-instruction-count">{{ projectInstructionDraft.length }} / 20000</span>
            </div>
            <div class="project-instruction-actions">
              <button type="button" class="btn btn-secondary" :disabled="projectInstructionSubmitting" @click="closeProjectInstruction">{{ $t('common.cancel') }}</button>
              <button type="submit" class="btn btn-primary" :disabled="projectInstructionSubmitting">{{ $t('common.save') }}</button>
            </div>
          </form>
        </div>
      </Teleport>
    </nav>
  `,
};
