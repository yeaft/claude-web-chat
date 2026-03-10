/**
 * RolePlayChatView — Role Play chat view using Crew UI layout.
 *
 * Reuses Crew's 3-panel layout (Roles / Messages / Kanban) by adapting
 * RolePlay's single-conversation messages through rolePlayAdapter.
 *
 * Architecture:
 *   - adaptRolePlayMessages() converts store.messages → Crew message format
 *   - crewMessageGrouping (buildTurns, appendToSegments, ...) groups messages
 *   - CrewTurnRenderer renders each turn
 *   - CrewRolePanel shows role cards (left)
 *   - CrewFeaturePanel shows Kanban (right) — empty for RolePlay unless ROUTE metadata exists
 *   - rolePlayInput handles sending via store.sendMessage() (not sendCrewMessage)
 *
 * The old simple RolePlayChatView with its parseRoleSegments is replaced entirely.
 * parseRoleSegments / splitByRoleSignal are preserved as named exports for test compatibility.
 */

import { renderMarkdown, clearMarkdownCache } from '../utils/markdown.js';
import {
  ICONS, formatTime, formatTokens, formatDuration,
  shortName, getRoleStyle, getImageUrl
} from './crew/crewHelpers.js';
import {
  buildTurns, appendToSegments, rebuildBlocksFromSegments,
  createFbCache, fullBuildFeatureBlocks, getBlockTurns,
  shouldShowTurnDivider, getMaxRound
} from './crew/crewMessageGrouping.js';
import {
  parseCrewTasks, computeCompletedTaskIds, collectActiveTasks,
  buildTodosByFeature, buildFeatureKanban, groupKanban, kanbanProgress
} from './crew/crewKanban.js';
import { createRolePlayInput } from './crew/rolePlayInput.js';
import { createCrewScroll } from './crew/crewScroll.js';
import { adaptRolePlayMessages } from './crew/rolePlayAdapter.js';
import CrewTurnRenderer from './crew/CrewTurnRenderer.js';
import CrewRolePanel from './crew/CrewRolePanel.js';
import CrewFeaturePanel from './crew/CrewFeaturePanel.js';

export default {
  name: 'RolePlayChatView',
  components: { CrewTurnRenderer, CrewRolePanel, CrewFeaturePanel },
  template: `
    <div class="crew-chat-view roleplay-crew-view">
      <div class="crew-workspace" :class="{ 'hide-roles': !panelVisible.roles, 'hide-features': !panelVisible.features, 'mobile-panel-roles': mobilePanel === 'roles', 'mobile-panel-features': mobilePanel === 'features' }">
        <div class="crew-mobile-overlay" v-if="mobilePanel" @click="mobilePanel = null"></div>

        <!-- Left Panel: Role Cards -->
        <crew-role-panel
          :store="roleProxyStore"
          :session-roles="sessionRoles"
          @scroll-to-role="scrollToRoleLatest"
          @control-action="controlAction"
          @clear-role="() => {}"
          @abort-role="() => {}"
          @show-add-role="() => {}"
        />

        <!-- Center Panel: Chat Flow -->
        <div class="crew-panel-center">
          <div class="crew-messages" ref="messagesRef" @scroll="scroll.onScroll()">
            <!-- Empty state -->
            <div v-if="adaptedMessages.length === 0 && !store.isProcessing" class="crew-empty">
              <div class="crew-empty-icon">🎭</div>
              <div class="crew-empty-text">{{ $t('roleplay.emptyHint') }}</div>
              <div v-if="sessionRoles.length > 0" class="roleplay-empty-roles">
                <div v-for="role in sessionRoles" :key="role.name" class="roleplay-empty-role-card">
                  <div class="roleplay-empty-role-icon">{{ role.icon || '🤖' }}</div>
                  <div class="roleplay-empty-role-info">
                    <div class="roleplay-empty-role-name">{{ role.displayName || role.name }}</div>
                    <div class="roleplay-empty-role-desc" v-if="role.description">{{ role.description }}</div>
                  </div>
                </div>
              </div>
            </div>

            <!-- Load more / history -->
            <div v-if="scroll.hiddenBlockCount.value > 0" class="crew-load-more" @click="scroll.loadMoreBlocks()">
              {{ $t('crew.loadOlder') }} <span class="crew-load-more-count">({{ scroll.hiddenBlockCount.value }})</span>
            </div>

            <!-- Blocks (global and feature) -->
            <template v-for="(block, bidx) in scroll.visibleBlocks.value" :key="block.id">
              <!-- Global block -->
              <template v-if="block.type === 'global'">
                <template v-for="(turn, tidx) in block.turns" :key="turn.id">
                  <div v-if="tidx > 0 && shouldShowTurnDivider(block.turns, tidx)" class="crew-turn-divider"></div>
                  <div v-if="turn.type === 'turn' && getMaxRound(turn) > 0" class="crew-round-divider">
                    <div class="crew-round-line"></div>
                    <span class="crew-round-label">Round {{ getMaxRound(turn) }}</span>
                    <div class="crew-round-line"></div>
                  </div>
                  <crew-turn-renderer
                    :turn="turn"
                    :show-human-bubble="true"
                    :expanded-turns="expandedTurns"
                    :icons="icons"
                    :get-role-display-name="getRoleDisplayName"
                    @toggle-turn="toggleTurn"
                  />
                </template>
              </template>

              <!-- Feature block -->
              <div v-else class="crew-feature-thread" :data-block-id="block.id" :data-task-id="block.taskId" :class="{ 'is-completed': block.isCompleted, 'is-expanded': isFeatureExpanded(block) }">
                <div class="crew-feature-header" @click="toggleFeature(block.taskId)">
                  <svg class="crew-feature-chevron" viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M10 6l6 6-6 6z"/></svg>
                  <span class="crew-feature-title">{{ block.taskTitle }}</span>
                  <span v-if="block.activeRoles && block.activeRoles.length > 0" class="crew-feature-actives">
                    <span v-for="ar in block.activeRoles.slice(0, 3)" :key="ar.role" class="crew-feature-active-icon" :title="ar.roleName">{{ ar.roleIcon }}</span>
                  </span>
                  <span v-if="block.isCompleted" class="crew-feature-status completed">
                    <span class="crew-feature-status-dot"></span> {{ $t('crew.statusCompleted') }}
                  </span>
                  <span v-else-if="block.hasStreaming" class="crew-feature-status active">
                    <span class="crew-feature-status-dot"></span> {{ $t('crew.statusInProgress') }}
                  </span>
                </div>
                <div v-if="isFeatureExpanded(block)" class="crew-feature-body">
                  <button v-if="getBlockTurns(block).length > 1"
                          class="crew-feature-history-toggle"
                          :class="{ 'is-expanded': expandedHistories[block.taskId] }"
                          @click.stop="toggleHistory(block.taskId)">
                    <svg viewBox="0 0 24 24"><path fill="currentColor" d="M10 6l6 6-6 6z"/></svg>
                    {{ $t('crew.viewHistory', { count: getBlockTurns(block).length - 1 }) }}
                  </button>
                  <div v-if="expandedHistories[block.taskId] && getBlockTurns(block).length > 1" class="crew-feature-history">
                    <template v-for="(turn, tidx) in getBlockTurns(block).slice(0, -1)" :key="turn.id">
                      <div v-if="tidx > 0 && shouldShowTurnDivider(getBlockTurns(block), tidx)" class="crew-turn-divider"></div>
                      <crew-turn-renderer
                        :turn="turn"
                        :expanded-turns="expandedTurns"
                        :icons="icons"
                        :get-role-display-name="getRoleDisplayName"
                        @toggle-turn="toggleTurn"
                      />
                    </template>
                  </div>
                  <template v-if="getBlockTurns(block).length > 0">
                    <template v-for="turn in [getBlockTurns(block)[getBlockTurns(block).length - 1]]" :key="turn.id">
                      <crew-turn-renderer
                        :turn="turn"
                        :expanded-turns="expandedTurns"
                        :icons="icons"
                        :get-role-display-name="getRoleDisplayName"
                        @toggle-turn="toggleTurn"
                      />
                    </template>
                  </template>
                </div>
              </div>
            </template>

            <!-- Typing indicator -->
            <div v-if="store.isProcessing && !hasStreamingMessage" class="typing-indicator">
              <span></span><span></span><span></span>
            </div>

            <!-- Scroll to bottom -->
            <div class="crew-scroll-bottom"
                 :class="{ 'is-hidden': scroll.isAtBottom.value }"
                 @click="scroll.scrollToBottomAndReset()">
              {{ $t('crew.scrollToLatest') }}
            </div>
          </div>

          <!-- Input Area -->
          <div class="input-area crew-input-area">
            <div class="attachments-preview" v-if="input.attachments.value.length > 0">
              <div class="attachment-item" v-for="(file, index) in input.attachments.value" :key="index">
                <img v-if="file.preview" :src="file.preview" class="attachment-thumb" />
                <span v-else class="attachment-icon">\u{1F4CE}</span>
                <span class="attachment-name">{{ file.name }}</span>
                <button class="attachment-remove" @click="input.removeAttachment(index)">&times;</button>
              </div>
            </div>
            <div class="input-wrapper">
              <input
                type="file"
                ref="fileInput"
                id="roleplay-file-input"
                @change="input.handleFileSelect($event)"
                multiple
                accept="image/*,text/*,.pdf,.doc,.docx,.xls,.xlsx,.json,.md,.py,.js,.ts,.css,.html"
                class="file-input-hidden"
              />
              <label class="attach-btn" for="roleplay-file-input" :title="$t('crew.uploadFile')">
                <svg viewBox="0 0 24 24" width="20" height="20">
                  <path d="M16.5 6v11.5c0 2.21-1.79 4-4 4s-4-1.79-4-4V5c0-1.38 1.12-2.5 2.5-2.5s2.5 1.12 2.5 2.5v10.5c0 .55-.45 1-1 1s-1-.45-1-1V6H10v9.5c0 1.38 1.12 2.5 2.5 2.5s2.5-1.12 2.5-2.5V5c0-2.21-1.79-4-4-4S7 2.79 7 5v12.5c0 3.04 2.46 5.5 5.5 5.5s5.5-2.46 5.5-5.5V6h-1.5z"/>
                </svg>
              </label>
              <div class="textarea-wrapper">
                <div class="slash-autocomplete" v-if="input.slashMenuVisible.value && input.slashFlatItems.value.length > 0">
                  <template v-for="group in input.slashGroupedCommands.value" :key="group.label">
                    <div class="slash-group-label">{{ group.label }}</div>
                    <div
                      v-for="item in group.items"
                      :key="item.cmd"
                      class="slash-autocomplete-item"
                      :class="{ active: item.flatIndex === input.slashMenuIndex.value }"
                      @mousedown.prevent="input.selectSlashCommand(item.cmd)"
                      @mouseenter="input.slashMenuIndex.value = item.flatIndex"
                    >
                      <span class="slash-cmd-name">{{ item.cmd }}</span>
                      <span class="slash-cmd-desc">{{ item.desc }}</span>
                    </div>
                    <div v-if="!group.isLast" class="slash-group-separator"></div>
                  </template>
                </div>
                <textarea
                  ref="inputRef"
                  v-model="input.inputText.value"
                  @input="input.handleInput()"
                  @keydown="input.handleKeydown($event, () => sendMessage())"
                  @paste="input.handlePaste($event)"
                  @blur="input.onBlur()"
                  :placeholder="$t('roleplay.inputPlaceholder')"
                  rows="1"
                ></textarea>
                <div class="crew-at-menu" v-if="input.atMenuVisible.value && input.filteredAtRoles.value.length > 0">
                  <div v-for="(role, idx) in input.filteredAtRoles.value" :key="role.name"
                    class="crew-at-menu-item" :class="{ active: idx === input.atMenuIndex.value }"
                    @mousedown.prevent="input.selectAtRole(role)">
                    <span v-if="role.icon" class="crew-at-menu-icon">{{ role.icon }}</span>
                    <span class="crew-at-menu-name">{{ role.displayName }}</span>
                    <span class="crew-at-menu-desc">{{ role.description }}</span>
                  </div>
                </div>
              </div>
              <button class="send-btn" @click="sendMessage" :disabled="!input.canSend.value" :title="$t('crew.send')">
                <svg viewBox="0 0 24 24"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>
              </button>
            </div>
          </div>
        </div><!-- /crew-panel-center -->

        <!-- Right Panel: Feature Kanban -->
        <crew-feature-panel
          :store="roleProxyStore"
          :feature-kanban="featureKanban"
          :feature-kanban-grouped="featureKanbanGrouped"
          :kanban-progress-data="kanbanProgressData"
          :now-tick="nowTick"
          :icons="icons"
          @scroll-to-feature="scrollToFeature"
        />
      </div>
    </div>
  `,

  setup() {
    const store = Pinia.useChatStore();
    const authStore = Pinia.useAuthStore();
    return { store, authStore };
  },

  data() {
    return {
      icons: ICONS,
      expandedTurns: {},
      expandedFeatures: {},
      expandedHistories: {},
      nowTick: Date.now(),
      panelVisible: { roles: true, features: true },
      mobilePanel: null,
    };
  },

  created() {
    this.input = createRolePlayInput(this.store, this.authStore, {
      getInputRef: () => this.$refs.inputRef,
      getFileInputRef: () => this.$refs.fileInput,
    });
    this.scroll = createCrewScroll(this.store, {
      getMessagesRef: () => this.$refs.messagesRef,
      getFeatureBlocks: () => this.featureBlocks
    });
  },

  computed: {
    /** RolePlay session for current conversation */
    rolePlaySession() {
      return this.store.rolePlaySessions?.[this.store.currentConversation] || null;
    },

    /** Session roles array */
    sessionRoles() {
      return this.rolePlaySession?.roles || [];
    },

    /** Adapted messages: convert store.messages → Crew format via adapter */
    adaptedMessages() {
      return adaptRolePlayMessages(this.store.messages, this.sessionRoles);
    },

    /** Whether any adapted message is streaming */
    hasStreamingMessage() {
      return this.adaptedMessages.some(m => m._streaming);
    },

    /** Feature blocks built from adapted messages */
    featureBlocks() {
      const allMessages = this.adaptedMessages;
      const completed = this.completedTaskIds;
      const len = allMessages.length;

      if (!this._fbCache) {
        this._fbCache = createFbCache(null);
      }
      const cache = this._fbCache;

      // Reference changed (new messages array) → full rebuild
      if (cache._lastArr !== allMessages) {
        Object.assign(cache, createFbCache(allMessages));
        if (len === 0) return cache.blocks;
        return fullBuildFeatureBlocks(allMessages, completed, cache);
      }

      if (len === 0) {
        Object.assign(cache, createFbCache(allMessages));
        return cache.blocks;
      }

      const startIdx = cache.processedLen;
      if (startIdx > len) {
        Object.assign(cache, createFbCache(allMessages));
        return fullBuildFeatureBlocks(allMessages, completed, cache);
      }

      if (startIdx < len) {
        appendToSegments(allMessages, startIdx, cache);
      }
      rebuildBlocksFromSegments(cache, completed);
      return cache.blocks;
    },

    /** Active tasks from messages */
    activeTasks() {
      return collectActiveTasks([], this.adaptedMessages);
    },

    /** Crew tasks parsed from messages */
    crewTasks() {
      return parseCrewTasks(this.adaptedMessages);
    },

    doneTasks() {
      return this.crewTasks.filter(t => t.done);
    },

    completedTaskIds() {
      return computeCompletedTaskIds(this.doneTasks, this.activeTasks);
    },

    todosByFeature() {
      return buildTodosByFeature(this.adaptedMessages);
    },

    featureKanban() {
      return buildFeatureKanban(
        this.activeTasks, this.todosByFeature, this.featureBlocks,
        this.completedTaskIds, this.$t('crew.globalTask')
      );
    },

    featureKanbanGrouped() {
      return groupKanban(this.featureKanban);
    },

    kanbanProgressData() {
      return kanbanProgress(this.featureKanban);
    },

    /**
     * Proxy store object for CrewRolePanel and CrewFeaturePanel.
     * These components expect store.currentCrewSession, store.currentCrewStatus,
     * store.currentCrewMessages, store.crewMobilePanel.
     * We provide a lightweight proxy that maps RolePlay data into those shapes.
     */
    roleProxyStore() {
      const self = this;
      return {
        get currentCrewSession() { return self.rolePlaySession; },
        get currentCrewStatus() { return { status: self.store.isProcessing ? 'running' : 'idle', activeRoles: self.activeRoleNames }; },
        get currentCrewMessages() { return self.adaptedMessages; },
        get crewMobilePanel() { return self.mobilePanel; },
        set crewMobilePanel(v) { self.mobilePanel = v; },
        get crewPanelVisible() { return self.panelVisible; },
      };
    },

    /** List of currently active (streaming) role names */
    activeRoleNames() {
      const roles = [];
      for (const m of this.adaptedMessages) {
        if (m._streaming && m.role && m.role !== 'human') {
          if (!roles.includes(m.role)) roles.push(m.role);
        }
      }
      return roles;
    },
  },

  watch: {
    'store.currentConversation'(newId, oldId) {
      this.mobilePanel = null;
      if (oldId) this.input.saveDraft(oldId);
      this.input.restoreDraft(newId);
      this._fbCache = null;
      clearMarkdownCache();
      this.scroll.visibleBlockCount.value = 20;
      this.$nextTick(() => {
        setTimeout(() => this.scroll.scrollToMeaningfulContent(), 300);
      });
    },
    'input.inputText.value'(val) {
      const convId = this.store.currentConversation;
      if (convId) {
        if (val) { this.store.inputDrafts[convId] = val; }
        else { delete this.store.inputDrafts[convId]; }
      }
    },
    'store.messages': {
      handler() {
        this.$nextTick(() => this.scroll.smartScrollToBottom());
      },
      deep: true
    }
  },

  methods: {
    formatTime,
    formatTokens,
    formatDuration,
    shortName,
    getRoleStyle,
    getImageUrl,
    shouldShowTurnDivider,
    getMaxRound,
    mdRender: renderMarkdown,

    toggleTurn(turnId) {
      this.expandedTurns[turnId] = !this.expandedTurns[turnId];
    },

    toggleFeature(taskId) {
      this.expandedFeatures[taskId] = !this.expandedFeatures[taskId];
    },

    toggleHistory(taskId) {
      this.expandedHistories[taskId] = !this.expandedHistories[taskId];
    },

    isFeatureExpanded(block) {
      if (block.taskId in this.expandedFeatures) return this.expandedFeatures[block.taskId];
      if (block.hasStreaming) return true;
      if (!block.isCompleted) return true;
      const featureOnly = this.featureBlocks.filter(b => b.type === 'feature');
      const idx = featureOnly.findIndex(b => b.id === block.id);
      return featureOnly.length - 1 - idx < 2;
    },

    getBlockTurns(block) {
      return getBlockTurns(block, this._fbCache);
    },

    getRoleDisplayName(roleName) {
      const session = this.rolePlaySession;
      if (!session) return roleName;
      const role = session.roles.find(r => r.name === roleName);
      return role ? role.displayName : roleName;
    },

    sendMessage(e) {
      this.input.sendMessage(e, () => {
        this.scroll.isAtBottom.value = true;
        this.scroll.scrollToBottom();
      });
    },

    controlAction(action) {
      // RolePlay doesn't have crew control actions — no-op
    },

    scrollToRoleLatest(roleName) {
      this.scroll.scrollToRoleLatest(
        roleName, this.featureBlocks,
        this.expandedFeatures, this.expandedHistories, this.$el
      );
    },

    scrollToFeature(taskId) {
      this.scroll.scrollToFeature(taskId, this.expandedFeatures, this.$el);
    },
  },

  mounted() {
    this._elapsedTimer = setInterval(() => { this.nowTick = Date.now(); }, 1000);
    const convId = this.store.currentConversation;
    this.input.restoreDraft(convId);
    this.$nextTick(() => this.scroll.scrollToBottom());
  },

  beforeUnmount() {
    if (this._elapsedTimer) clearInterval(this._elapsedTimer);
    const convId = this.store.currentConversation;
    this.input.saveDraft(convId);
  }
};

// ── Legacy exports for backward compatibility / tests ───────────────
// These were in the old RolePlayChatView; keep them so existing tests don't break.

function isPartialRoleSignal(line) {
  const trimmed = line.trim();
  if (!trimmed.startsWith('---')) return false;
  return /^---\s*R(O(L(E(:(\s\w*(-(-(-)?)?)?)?)?)?)?)?$/.test(trimmed);
}

function splitByRoleSignal(text, isStreaming = false) {
  const results = [];
  let currentContent = '';
  let detectedRole = null;
  let inCodeBlock = false;
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trimStart().startsWith('```')) { inCodeBlock = !inCodeBlock; currentContent += line + '\n'; continue; }
    if (inCodeBlock) { currentContent += line + '\n'; continue; }
    const roleMatch = line.match(/^---\s*ROLE:\s*(\w[\w-]*)\s*---$/);
    if (roleMatch) {
      if (currentContent) { results.push({ role: detectedRole, content: currentContent }); currentContent = ''; }
      detectedRole = roleMatch[1].toLowerCase();
      continue;
    }
    if (isStreaming && i === lines.length - 1 && isPartialRoleSignal(line)) continue;
    currentContent += line + '\n';
  }
  if (currentContent) results.push({ role: detectedRole, content: currentContent });
  if (results.length === 0) results.push({ role: null, content: text });
  return results;
}

function parseRoleSegments(messages) {
  const segments = [];
  let currentRole = null;
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.type === 'user') { segments.push({ type: 'user', content: msg.content, id: msg.id, attachments: msg.attachments }); continue; }
    if (msg.type === 'system' || msg.type === 'error') { segments.push({ type: msg.type, content: msg.content, id: msg.id }); continue; }
    if (msg.type === 'user-question') { segments.push({ type: 'user-question', role: currentRole, msg, id: msg.id }); continue; }
    if (msg.type === 'tool-use') {
      if (msg.toolName === 'TodoWrite' && msg.toolInput?.todos) { segments.push({ type: 'todo', role: currentRole, todos: msg.toolInput.todos, id: msg.id }); continue; }
      segments.push({ type: 'tool', role: currentRole, toolName: msg.toolName, toolInput: msg.toolInput, toolResult: msg.toolResult, hasResult: msg.hasResult, startTime: msg.startTime, id: msg.id }); continue;
    }
    if (msg.type === 'assistant') {
      const text = msg.content || '';
      if (!text.trim()) continue;
      const isStreaming = !!msg.isStreaming;
      const parts = splitByRoleSignal(text, isStreaming);
      for (let j = 0; j < parts.length; j++) {
        const part = parts[j];
        if (part.role) currentRole = part.role;
        if (part.content.trim()) segments.push({ type: 'role-text', role: currentRole || 'assistant', content: part.content, isStreaming: isStreaming && j === parts.length - 1 });
      }
      continue;
    }
  }
  return segments;
}

export { parseRoleSegments, splitByRoleSignal, isPartialRoleSignal };
