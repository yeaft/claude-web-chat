import { shortenPath } from '../utils/path-display.js';

const SESSION_PROVIDERS = ['yeaft', 'copilot', 'claude-code'];

export default {
  name: 'UnifiedSessionList',
  props: {
    sessions: { type: Array, default: () => [] },
    activeCatalogKey: { type: String, default: null },
    processingConversations: { type: Object, default: () => ({}) },
    isYeaftSessionProcessing: { type: Function, default: null },
    agents: { type: Array, default: () => [] },
    workCenterOpen: { type: Boolean, default: false },
    workCenterAgentId: { type: String, default: null },
    preferredProvider: { type: String, default: 'yeaft' },
  },
  emits: ['select', 'create', 'action', 'open-work-center', 'close-work-center'],
  data() {
    return {
      selectedProvider: SESSION_PROVIDERS.includes(this.preferredProvider) ? this.preferredProvider : 'yeaft',
      activeMenuKey: null,
      editingKey: null,
      editingTitle: '',
      draggedKey: null,
      dragOverKey: null,
      menuPosition: { top: 0, left: 0 },
    };
  },
  computed: {
    availableSessions() {
      return this.sessions.filter(row => this.isAvailable(row));
    },
    visibleSessions() {
      return this.availableSessions.filter(row => row.runtimeProvider === this.selectedProvider);
    },
    providerTabs() {
      return SESSION_PROVIDERS.map(provider => ({
        provider,
        label: this.providerLabel({ runtimeProvider: provider }),
        count: this.availableSessions.filter(row => row.runtimeProvider === provider).length,
      }));
    },
    onlineWorkCenterAgents() {
      return this.agents.filter(agent => agent?.online
        && Array.isArray(agent.capabilities) && agent.capabilities.includes('work_center'));
    },
  },
  watch: {
    activeCatalogKey: {
      immediate: true,
      handler(catalogKey) {
        const active = this.sessions.find(row => row.catalogKey === catalogKey);
        if (active && SESSION_PROVIDERS.includes(active.runtimeProvider)) {
          this.selectedProvider = active.runtimeProvider;
        }
      },
    },
  },
  mounted() {
    document.addEventListener('pointerdown', this.onDocumentPointerDown, true);
    document.addEventListener('keydown', this.onDocumentKeydown);
    window.addEventListener('scroll', this.closeMenu, true);
    window.addEventListener('resize', this.closeMenu);
  },
  beforeUnmount() {
    document.removeEventListener('pointerdown', this.onDocumentPointerDown, true);
    document.removeEventListener('keydown', this.onDocumentKeydown);
    window.removeEventListener('scroll', this.closeMenu, true);
    window.removeEventListener('resize', this.closeMenu);
  },
  methods: {
    providerLabel(row) {
      if (row.runtimeProvider === 'yeaft') return 'Yeaft';
      if (row.runtimeProvider === 'copilot') return 'Copilot';
      return this.$t ? this.$t('sidebar.provider.claude') : 'Claude';
    },
    agentLabel(row) {
      const agentId = row?.routeRef?.agentId || row?.agentId || '';
      const registeredAgent = this.agents.find(agent => agent?.id === agentId);
      if (registeredAgent?.name) return registeredAgent.name;
      return row?.agentName && row.agentName !== agentId ? row.agentName : '';
    },
    secondaryLabel(row) {
      const parts = [this.agentLabel(row)].filter(Boolean);
      if (row.availability === 'offline') parts.push(this.$t('settings.dashboard.offline'));
      return parts.join(' · ');
    },
    isProcessing(row) {
      const sessionId = row?.routeRef?.sessionId;
      if (!sessionId) return false;
      if (row.runtimeProvider === 'yeaft') {
        return typeof this.isYeaftSessionProcessing === 'function'
          ? this.isYeaftSessionProcessing(sessionId, row?.routeRef?.agentId || null)
          : false;
      }
      return !!this.processingConversations?.[sessionId];
    },
    shortPath(path) {
      return shortenPath(path || '');
    },
    isAvailable(row) {
      return row?.availability !== 'offline';
    },
    selectProvider(provider) {
      if (!SESSION_PROVIDERS.includes(provider)) return;
      this.closeMenu();
      this.selectedProvider = provider;
      if (this.workCenterOpen) this.$emit('close-work-center');
    },
    showSessions() {
      if (this.workCenterOpen) this.$emit('close-work-center');
    },
    createSession() {
      this.$emit('create', this.selectedProvider);
    },
    select(row) {
      if (!this.isAvailable(row)) return;
      this.closeMenu();
      this.$emit('select', row);
    },
    closeMenu() {
      this.activeMenuKey = null;
    },
    onDocumentPointerDown(event) {
      if (!this.activeMenuKey) return;
      const target = event?.target;
      if (target?.closest?.('.session-menu-floating, .session-dots-btn')) return;
      this.closeMenu();
    },
    onDocumentKeydown(event) {
      if (event?.key === 'Escape') this.closeMenu();
    },
    toggleMenu(row, event) {
      if (this.activeMenuKey === row.catalogKey) {
        this.closeMenu();
        return;
      }
      const trigger = event?.currentTarget?.getBoundingClientRect?.();
      if (trigger) {
        const menuWidth = 160;
        const menuHeight = 168;
        const viewportWidth = window.innerWidth || document.documentElement.clientWidth;
        const viewportHeight = window.innerHeight || document.documentElement.clientHeight;
        const gap = 4;
        const edge = 8;
        const below = trigger.bottom + gap;
        this.menuPosition = {
          top: below + menuHeight <= viewportHeight - edge
            ? below
            : Math.max(edge, trigger.top - menuHeight - gap),
          left: Math.max(edge, Math.min(trigger.right - menuWidth, viewportWidth - menuWidth - edge)),
        };
      }
      this.activeMenuKey = row.catalogKey;
    },
    emitAction(action, row, extra = {}) {
      this.closeMenu();
      this.$emit('action', { action, row, ...extra });
    },
    startRename(row) {
      this.closeMenu();
      this.editingKey = row.catalogKey;
      this.editingTitle = row.title || '';
      this.$nextTick(() => {
        const input = this.$refs.renameInput;
        const element = Array.isArray(input) ? input[0] : input;
        element?.focus?.();
        element?.select?.();
      });
    },
    commitRename(row) {
      if (this.editingKey !== row.catalogKey) return;
      const title = this.editingTitle.trim();
      this.editingKey = null;
      this.editingTitle = '';
      if (title && title !== row.title) this.emitAction('rename', row, { title });
    },
    cancelRename() {
      this.editingKey = null;
      this.editingTitle = '';
    },
    onDragStart(row, event) {
      this.draggedKey = row.catalogKey;
      event?.dataTransfer?.setData?.('text/plain', row.catalogKey);
      if (event?.dataTransfer) event.dataTransfer.effectAllowed = 'move';
    },
    onDrop(row, event) {
      const fromKey = this.draggedKey || event?.dataTransfer?.getData?.('text/plain');
      const toKey = row.catalogKey;
      this.draggedKey = null;
      this.dragOverKey = null;
      if (!fromKey || fromKey === toKey) return;
      const ordered = [...this.visibleSessions];
      const fromIndex = ordered.findIndex(item => item.catalogKey === fromKey);
      const toIndex = ordered.findIndex(item => item.catalogKey === toKey);
      if (fromIndex < 0 || toIndex < 0) return;
      const [moved] = ordered.splice(fromIndex, 1);
      ordered.splice(toIndex, 0, moved);
      const visibleByKey = new Map(ordered.map(item => [item.catalogKey, item]));
      let visibleIndex = 0;
      const completeOrder = this.sessions.map((item) => {
        if (!visibleByKey.has(item.catalogKey)) return item;
        return ordered[visibleIndex++];
      });
      this.emitAction('reorder', row, { sessions: completeOrder });
    },
  },
  template: `
    <div class="us-scroll us-scroll-flush sidebar-navigation">
      <div class="sidebar-surface-switch" role="tablist" :aria-label="$t('sidebar.surface.label')">
        <button type="button" role="tab" class="sidebar-surface-option"
                :class="{ active: !workCenterOpen }" :aria-selected="!workCenterOpen ? 'true' : 'false'"
                @click="showSessions">
          <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H6l-2 2V4h16v12z"/></svg>
          <span>{{ $t('sidebar.surface.sessions') }}</span>
        </button>
        <button type="button" role="tab" class="sidebar-surface-option"
                :class="{ active: workCenterOpen }" :aria-selected="workCenterOpen ? 'true' : 'false'"
                :disabled="onlineWorkCenterAgents.length === 0"
                @click="$emit('open-work-center', workCenterAgentId || onlineWorkCenterAgents[0]?.id || null)">
          <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" d="M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01"/></svg>
          <span>{{ $t('workCenter.title') }}</span>
        </button>
      </div>

      <template v-if="!workCenterOpen">
        <div class="sidebar-provider-tabs" role="tablist" :aria-label="$t('sidebar.provider.label')">
          <button v-for="tab in providerTabs" :key="tab.provider" type="button" role="tab"
                  class="sidebar-provider-tab" :class="{ active: selectedProvider === tab.provider }"
                  :aria-selected="selectedProvider === tab.provider ? 'true' : 'false'"
                  @click="selectProvider(tab.provider)">
            <span>{{ tab.label }}</span>
            <span v-if="tab.count" class="sidebar-provider-count">{{ tab.count }}</span>
          </button>
        </div>

        <div class="sidebar-session-actions">
          <button type="button" class="sidebar-create-session" :disabled="agents.every(agent => !agent?.online)" @click="createSession">
            <svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true"><path fill="currentColor" d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>
            <span>{{ $t('sidebar.sessions.new') }}</span>
          </button>
        </div>

        <div class="session-panels sidebar-session-results">
          <div class="session-panel-list">
            <div
              v-for="row in visibleSessions"
              :key="row.catalogKey"
              :role="isAvailable(row) ? 'button' : undefined"
              :tabindex="isAvailable(row) ? 0 : -1"
              :aria-disabled="isAvailable(row) ? undefined : 'true'"
              class="session-item yeaft-session-draggable"
              :class="{ active: row.catalogKey === activeCatalogKey, pinned: row.pinned, processing: isProcessing(row), 'agent-offline': !isAvailable(row), dragging: draggedKey === row.catalogKey, 'drag-over': dragOverKey === row.catalogKey }"
              draggable="true"
              @click="select(row)"
              @keydown.enter.prevent="select(row)"
              @keydown.space.prevent="select(row)"
              @dragstart="onDragStart(row, $event)"
              @dragover.prevent="dragOverKey = row.catalogKey"
              @dragleave="dragOverKey = null"
              @drop.prevent="onDrop(row, $event)"
              @dragend="draggedKey = null; dragOverKey = null"
            >
              <span class="session-item-main">
                <span class="session-item-header">
                  <span v-if="row.pinned" class="session-pin-icon"><svg viewBox="0 0 24 24"><path fill="currentColor" d="M16 12V4h1V2H7v2h1v8l-2 2v2h5.2v6h1.6v-6H18v-2l-2-2z"/></svg></span>
                  <span v-if="isProcessing(row)" class="processing-dot"></span>
                  <input
                    v-if="editingKey === row.catalogKey"
                    ref="renameInput"
                    class="chat-rename-input"
                    v-model="editingTitle"
                    @keydown.enter.stop.prevent="commitRename(row)"
                    @keydown.escape.stop.prevent="cancelRename"
                    @blur="commitRename(row)"
                    @click.stop
                  />
                  <span v-else class="title">{{ row.title }}</span>
                  <button type="button" class="session-dots-btn" :class="{ 'menu-open': activeMenuKey === row.catalogKey }" @click.stop="toggleMenu(row, $event)">
                    <svg viewBox="0 0 24 24"><circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/></svg>
                  </button>
                  <Teleport to="body">
                    <span
                      v-if="activeMenuKey === row.catalogKey"
                      class="session-menu session-menu-floating"
                      :style="{ top: menuPosition.top + 'px', left: menuPosition.left + 'px' }"
                      role="menu"
                      @click.stop
                    >
                      <button type="button" role="menuitem" class="session-menu-item" @click="emitAction('pin', row)">{{ row.pinned ? $t('chat.sidebar.unpin') : $t('chat.sidebar.pin') }}</button>
                      <button type="button" role="menuitem" class="session-menu-item" @click="startRename(row)">{{ $t('chat.sidebar.renameConv') }}</button>
                      <button v-if="row.runtimeProvider === 'yeaft'" type="button" role="menuitem" class="session-menu-item" @click="emitAction('settings', row)">{{ $t('yeaft.session.openSettings') }}</button>
                      <button type="button" role="menuitem" class="session-menu-item danger" @click="emitAction('remove', row)">{{ $t('common.close') }}</button>
                    </span>
                  </Teleport>
                </span>
                <span class="session-info">
                  <span class="session-path" v-if="row.workDir">{{ shortPath(row.workDir) }}</span>
                  <span class="session-agent" v-if="secondaryLabel(row)">{{ secondaryLabel(row) }}</span>
                </span>
              </span>
            </div>
            <div v-if="visibleSessions.length === 0" class="session-empty-hint">{{ $t('sidebar.sessions.emptyProvider') }}</div>
          </div>
        </div>
      </template>

      <div v-else class="session-panels sidebar-work-center-results">
        <div class="session-panel-list">
          <button v-for="agent in onlineWorkCenterAgents" :key="agent.id" type="button"
                  class="session-item sidebar-work-center-agent"
                  :class="{ active: workCenterAgentId === agent.id }"
                  @click="$emit('open-work-center', agent.id)">
            <span class="session-item-header">
              <span class="sidebar-work-center-agent-status" aria-hidden="true"></span>
              <span class="title sidebar-work-center-agent-name">{{ agent.name || agent.id }}</span>
            </span>
          </button>
          <p v-if="onlineWorkCenterAgents.length === 0" class="sidebar-work-center-empty">
            {{ $t('workCenter.noAvailableAgents') }}
          </p>
        </div>
      </div>
    </div>
  `,
};
