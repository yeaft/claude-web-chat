import { shortenPath } from '../utils/path-display.js';

export default {
  name: 'UnifiedSessionList',
  props: {
    sessions: { type: Array, default: () => [] },
    activeCatalogKey: { type: String, default: null },
    isSessionProcessing: { type: Function, default: () => false },
    isSessionUnread: { type: Function, default: () => false },
  },
  emits: ['select', 'create-chat', 'create-yeaft', 'action'],
  data() {
    return {
      activeMenuKey: null,
      editingKey: null,
      editingTitle: '',
      draggedKey: null,
      dragOverKey: null,
    };
  },
  methods: {
    providerLabel(row) {
      if (row.runtimeProvider === 'yeaft') return 'Yeaft';
      if (row.runtimeProvider === 'copilot') return 'Copilot';
      return 'Claude Code';
    },
    secondaryLabel(row) {
      const parts = [];
      if (row.agentName) parts.push(row.agentName);
      parts.push(this.providerLabel(row));
      if (row.availability === 'offline') parts.push(this.$t('settings.dashboard.offline'));
      return parts.join(' · ');
    },
    shortPath(path) {
      return shortenPath(path || '');
    },
    isAvailable(row) {
      return row?.availability !== 'offline';
    },
    select(row) {
      if (!this.isAvailable(row)) return;
      this.$emit('select', row);
    },
    toggleMenu(row) {
      this.activeMenuKey = this.activeMenuKey === row.catalogKey ? null : row.catalogKey;
    },
    emitAction(action, row, extra = {}) {
      this.activeMenuKey = null;
      this.$emit('action', { action, row, ...extra });
    },
    startRename(row) {
      this.activeMenuKey = null;
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
      const ordered = [...this.sessions];
      const fromIndex = ordered.findIndex(item => item.catalogKey === fromKey);
      const toIndex = ordered.findIndex(item => item.catalogKey === toKey);
      if (fromIndex < 0 || toIndex < 0) return;
      const [moved] = ordered.splice(fromIndex, 1);
      ordered.splice(toIndex, 0, moved);
      this.emitAction('reorder', row, { sessions: ordered });
    },
  },
  template: `
    <div class="us-scroll us-scroll-flush">
      <div class="session-tab-bar">
        <div class="session-tab session-tab-solo active">
          <svg class="session-tab-icon" viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H6l-2 2V4h16v12z"/></svg>
          <span>{{ $t('yeaft.session.title') }}</span>
          <span class="session-tab-count" v-if="sessions.length">{{ sessions.length }}</span>
          <button type="button" class="session-tab-add-btn" :title="$t('chat.sidebar.newConv')" @click.stop="$emit('create-chat')">
            <svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M4 4h16v12H6l-2 2V4zm2 2v8h12V6H6z"/></svg>
          </button>
          <button type="button" class="session-tab-add-btn" :title="$t('yeaft.session.new')" @click.stop="$emit('create-yeaft')">
            <svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>
          </button>
        </div>
      </div>
      <div class="session-panels">
        <div class="session-panel-list">
          <div
            v-for="row in sessions"
            :key="row.catalogKey"
            :role="isAvailable(row) ? 'button' : undefined"
            :tabindex="isAvailable(row) ? 0 : -1"
            :aria-disabled="isAvailable(row) ? undefined : 'true'"
            class="session-item yeaft-session-draggable"
            :class="{ active: row.catalogKey === activeCatalogKey, pinned: row.pinned, processing: isSessionProcessing(row), unread: isSessionUnread(row), 'agent-offline': !isAvailable(row), dragging: draggedKey === row.catalogKey, 'drag-over': dragOverKey === row.catalogKey }"
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
            <span v-if="row.pinned" class="session-pin-icon"><svg viewBox="0 0 24 24"><path fill="currentColor" d="M16 12V4h1V2H7v2h1v8l-2 2v2h5.2v6h1.6v-6H18v-2l-2-2z"/></svg></span>
            <span v-if="isSessionUnread(row)" class="unread-dot" aria-hidden="true"></span>
            <span v-else-if="isSessionProcessing(row)" class="processing-dot" aria-hidden="true"></span>
            <span class="session-item-main">
              <span class="session-item-header">
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
                <button type="button" class="session-dots-btn" :class="{ 'menu-open': activeMenuKey === row.catalogKey }" @click.stop="toggleMenu(row)">
                  <svg viewBox="0 0 24 24"><circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/></svg>
                </button>
                <span v-if="activeMenuKey === row.catalogKey" class="session-menu" role="menu" @click.stop>
                  <button type="button" role="menuitem" class="session-menu-item" @click="emitAction('pin', row)">{{ row.pinned ? $t('chat.sidebar.unpin') : $t('chat.sidebar.pin') }}</button>
                  <button type="button" role="menuitem" class="session-menu-item" :disabled="!isAvailable(row)" @click="startRename(row)">{{ $t('chat.sidebar.renameConv') }}</button>
                  <button v-if="row.runtimeProvider !== 'yeaft'" type="button" role="menuitem" class="session-menu-item split-to-panel-item" :disabled="!isAvailable(row)" @click="emitAction('split', row)">{{ $t('splitScreen.splitToPanel') }}</button>
                  <button v-if="row.runtimeProvider === 'yeaft'" type="button" role="menuitem" class="session-menu-item" :disabled="!isAvailable(row)" @click="emitAction('settings', row)">{{ $t('yeaft.session.openSettings') }}</button>
                  <button type="button" role="menuitem" class="session-menu-item danger" :disabled="!isAvailable(row)" @click="emitAction('remove', row)">{{ row.runtimeProvider === 'yeaft' ? $t('yeaft.session.removeFromList') : $t('chat.sidebar.closeConv') }}</button>
                </span>
              </span>
              <span class="session-info">
                <span class="session-path" v-if="row.workDir">{{ shortPath(row.workDir) }}</span>
                <span class="session-agent">{{ secondaryLabel(row) }}</span>
              </span>
            </span>
          </div>
          <div v-if="sessions.length === 0" class="session-empty-hint">{{ $t('yeaft.session.empty') }}</div>
        </div>
      </div>
    </div>
  `,
};
