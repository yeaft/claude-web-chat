/**
 * CrewFeaturePanel — Right sidebar: Feature Kanban board + message view.
 *
 * Two modes:
 *   1. List mode (default): narrow panel showing compact feature cards.
 *      Each card has a fixed two-line layout (title + progress + elapsed,
 *      then latest message summary). Click any card to enter expanded mode.
 *   2. Expanded mode: panel widens to 50% width. Shows todo list at top,
 *      followed by full message thread using CrewTurnRenderer.
 */
import {
  formatDuration, formatTime
} from './crewHelpers.js';
import {
  shouldShowTurnDivider, getMaxRound
} from './crewMessageGrouping.js';
import CrewTurnRenderer from './CrewTurnRenderer.js';

export default {
  name: 'CrewFeaturePanel',
  components: { CrewTurnRenderer },
  props: {
    store: { type: Object, required: true },
    featureKanban: { type: Array, required: true },
    featureKanbanGrouped: { type: Object, required: true },
    kanbanProgressData: { type: Object, required: true },
    featureBlocks: { type: Array, default: () => [] },
    getBlockTurns: { type: Function, default: () => [] },
    expandedTurns: { type: Object, default: () => ({}) },
    expandedFeatureTaskId: { type: String, default: null },
    nowTick: { type: Number, required: true },
    icons: { type: Object, required: true },
    getRoleDisplayName: { type: Function, default: (name) => name }
  },
  emits: ['toggle-turn', 'expand-feature', 'close-feature'],
  data() {
    return {
      showCompletedFeatures: false
    };
  },
  computed: {
    expandedBlock() {
      if (!this.expandedFeatureTaskId) return null;
      return this.featureBlocks.find(
        b => b.type === 'feature' && b.taskId === this.expandedFeatureTaskId
      ) || null;
    },
    expandedTurnsList() {
      if (!this.expandedBlock) return [];
      return this.getBlockTurns(this.expandedBlock);
    },
    expandedFeatureTitle() {
      if (!this.expandedBlock) return '';
      return this.expandedBlock.taskTitle || this.expandedFeatureTaskId;
    },
    expandedFeatureTodos() {
      if (!this.expandedFeatureTaskId) return [];
      const feature = this.featureKanban.find(f => f.taskId === this.expandedFeatureTaskId);
      return feature ? feature.todos : [];
    }
  },
  template: `
    <aside class="crew-panel-right">
      <div class="crew-panel-right-scroll">
        <button class="crew-mobile-close" @click="store.crewMobilePanel = null"><svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg> {{ $t('crew.close') }}</button>

        <!-- ===== EXPANDED MODE: Full message thread for a feature ===== -->
        <template v-if="expandedFeatureTaskId">
          <div class="crew-feature-expanded-header">
            <button class="crew-feature-expanded-back" @click="$emit('close-feature')">
              <svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
            </button>
            <span class="crew-feature-expanded-title">{{ expandedFeatureTitle }}</span>
          </div>
          <div v-if="expandedFeatureTodos.length > 0" class="crew-feature-card-todos">
            <div v-for="todo in expandedFeatureTodos" :key="todo.id"
                 class="crew-feature-card-todo" :class="'is-' + todo.status">
              <span class="todo-status">
                <svg v-if="todo.status === 'completed'" viewBox="0 0 24 24" width="12" height="12">
                  <path fill="currentColor" d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/>
                </svg>
              </span>
              <span class="todo-text">
                {{ todo.status === 'in_progress' ? (todo.activeForm || todo.content) : todo.content }}
              </span>
              <span v-if="todo.roleIcon" class="todo-role">{{ todo.roleIcon }}</span>
            </div>
          </div>
          <div class="crew-feature-expanded-messages">
            <template v-if="expandedTurnsList.length > 0">
              <template v-for="(turn, tidx) in expandedTurnsList" :key="turn.id">
                <div v-if="tidx > 0 && shouldShowTurnDivider(expandedTurnsList, tidx)" class="crew-turn-divider"></div>
                <div v-if="turn.type === 'turn' && getMaxRound(turn) > 0" class="crew-round-divider">
                  <div class="crew-round-line"></div>
                  <span class="crew-round-label">Round {{ getMaxRound(turn) }}</span>
                  <div class="crew-round-line"></div>
                </div>
                <crew-turn-renderer
                  :turn="turn"
                  :show-human-bubble="false"
                  :expanded-turns="expandedTurns"
                  :icons="icons"
                  :get-role-display-name="getRoleDisplayName"
                  @toggle-turn="$emit('toggle-turn', $event)"
                />
              </template>
            </template>
            <div v-else class="crew-feature-card-empty">
              {{ $t('crew.noFeatures') }}
            </div>
          </div>
        </template>

        <!-- ===== LIST MODE: Feature cards (compact, non-expandable) ===== -->
        <template v-else>
          <div class="crew-kanban-total" v-if="kanbanProgressData.total > 0">
            <div class="crew-kanban-total-header">
              <span>{{ $t('crew.totalProgress') }}</span>
              <span>{{ kanbanProgressData.done }} / {{ kanbanProgressData.total }}  {{ Math.round(kanbanProgressData.done / kanbanProgressData.total * 100) }}%</span>
            </div>
            <div class="crew-kanban-total-bar">
              <div class="crew-kanban-total-fill"
                   :style="{ width: (kanbanProgressData.done / kanbanProgressData.total * 100) + '%' }"></div>
            </div>
          </div>

          <div v-if="featureKanbanGrouped.inProgress.length > 0" class="crew-kanban-group">
            <div class="crew-kanban-group-header is-active">
              <span class="crew-kanban-group-dot is-active"></span>
              {{ $t('crew.statusInProgress') }} ({{ featureKanbanGrouped.inProgress.length }})
            </div>
            <div v-for="feature in featureKanbanGrouped.inProgress" :key="feature.taskId"
                 class="crew-feature-card"
                 :class="{ 'has-streaming': feature.hasStreaming }"
                 @click="$emit('expand-feature', feature.taskId)">
              <div class="crew-feature-card-header">
                <span class="crew-feature-card-title">{{ feature.taskTitle }}</span>
                <span class="crew-feature-card-count">
                  {{ feature.doneCount }} / {{ feature.totalCount }}
                </span>
                <span v-if="feature.createdAt" class="crew-feature-card-elapsed">{{ $t('crew.elapsed', { duration: formatDuration(nowTick - feature.createdAt) }) }}</span>
              </div>
              <div class="crew-feature-card-bar">
                <div class="crew-feature-card-bar-fill"
                     :style="{ width: (feature.totalCount > 0 ? (feature.doneCount / feature.totalCount * 100) : 0) + '%' }">
                </div>
              </div>
              <div v-if="getSummary(feature.taskId)" class="crew-feature-card-summary">
                <div class="crew-feature-summary-meta">
                  <span v-if="getSummary(feature.taskId).icon" class="crew-feature-summary-icon">{{ getSummary(feature.taskId).icon }}</span>
                  <span class="crew-feature-summary-role">{{ getSummary(feature.taskId).roleName }}</span>
                  <span class="crew-feature-summary-time">{{ getSummary(feature.taskId).time }}</span>
                </div>
                <div class="crew-feature-summary-text">{{ getSummary(feature.taskId).text }}</div>
              </div>
            </div>
          </div>

          <div v-if="featureKanbanGrouped.completed.length > 0" class="crew-kanban-group">
            <div class="crew-kanban-group-header is-completed" @click="showCompletedFeatures = !showCompletedFeatures">
              <svg class="crew-kanban-group-chevron" :class="{ 'is-expanded': showCompletedFeatures }" viewBox="0 0 24 24" width="12" height="12">
                <path fill="currentColor" d="M10 6l6 6-6 6z"/>
              </svg>
              <span class="crew-kanban-group-dot is-completed"></span>
              {{ $t('crew.statusCompleted') }} ({{ featureKanbanGrouped.completed.length }})
            </div>
            <template v-if="showCompletedFeatures">
              <div v-for="feature in featureKanbanGrouped.completed" :key="feature.taskId"
                   class="crew-feature-card is-completed"
                   @click="$emit('expand-feature', feature.taskId)">
                <div class="crew-feature-card-header">
                  <span class="crew-feature-card-title">{{ feature.taskTitle }}</span>
                  <span class="crew-feature-card-count">
                    {{ feature.doneCount }} / {{ feature.totalCount }}
                  </span>
                  <span v-if="feature.createdAt && feature.lastActivityAt" class="crew-feature-card-elapsed">{{ $t('crew.elapsed', { duration: formatDuration(feature.lastActivityAt - feature.createdAt) }) }}</span>
                </div>
                <div class="crew-feature-card-bar">
                  <div class="crew-feature-card-bar-fill"
                       :style="{ width: (feature.totalCount > 0 ? (feature.doneCount / feature.totalCount * 100) : 0) + '%' }">
                  </div>
                </div>
                <div v-if="getSummary(feature.taskId)" class="crew-feature-card-summary">
                  <div class="crew-feature-summary-meta">
                    <span v-if="getSummary(feature.taskId).icon" class="crew-feature-summary-icon">{{ getSummary(feature.taskId).icon }}</span>
                    <span class="crew-feature-summary-role">{{ getSummary(feature.taskId).roleName }}</span>
                    <span class="crew-feature-summary-time">{{ getSummary(feature.taskId).time }}</span>
                  </div>
                  <div class="crew-feature-summary-text">{{ getSummary(feature.taskId).text }}</div>
                </div>
              </div>
            </template>
          </div>

          <!-- Empty state -->
          <div v-if="featureKanban.length === 0" class="crew-kanban-empty">
            <div class="crew-kanban-empty-text">{{ $t('crew.noFeatures') }}</div>
          </div>
        </template>
      </div>
    </aside>
  `,
  methods: {
    formatDuration,
    formatTime,
    shouldShowTurnDivider,
    getMaxRound,

    /**
     * Cached accessor for getLatestMessageSummary — avoids calling it 4x per card in template.
     * Cache invalidated via featureBlocks reference identity.
     */
    getSummary(taskId) {
      if (!this._summaryCache || this._summaryCacheRef !== this.featureBlocks) {
        this._summaryCache = {};
        this._summaryCacheRef = this.featureBlocks;
      }
      if (taskId in this._summaryCache) return this._summaryCache[taskId];
      const result = this.getLatestMessageSummary(taskId);
      this._summaryCache[taskId] = result;
      return result;
    },

    /**
     * Get latest message summary for a feature card (list mode).
     * Returns { icon, roleName, text, time } or null if no text message exists.
     */
    getLatestMessageSummary(taskId) {
      const block = this.featureBlocks.find(
        b => b.type === 'feature' && b.taskId === taskId
      );
      if (!block) return null;
      const turns = this.getBlockTurns(block);
      if (!turns || turns.length === 0) return null;

      // Walk backward through turns to find the latest text content
      for (let i = turns.length - 1; i >= 0; i--) {
        const turn = turns[i];
        if (turn.type === 'turn' && turn.textMsg) {
          const timestamp = turn.messages?.[0]?.timestamp || turn.textMsg.timestamp;
          return {
            icon: turn.roleIcon || '',
            roleName: this.getRoleDisplayName(turn.role || turn.roleName || ''),
            text: this.truncateText(turn.textMsg.content, 80),
            time: timestamp ? formatTime(timestamp) : ''
          };
        }
        if (turn.type !== 'turn' && turn.message?.type === 'text') {
          return {
            icon: turn.message.roleIcon || '',
            roleName: this.getRoleDisplayName(turn.message.role || turn.message.roleName || ''),
            text: this.truncateText(turn.message.content, 80),
            time: turn.message.timestamp ? formatTime(turn.message.timestamp) : ''
          };
        }
      }
      return null;
    },

    truncateText(text, maxLen) {
      if (!text) return '';
      // Strip markdown, take first line
      const clean = text.replace(/[#*_`~\[\]]/g, '').trim();
      const firstLine = clean.split('\n')[0];
      if (firstLine.length <= maxLen) return firstLine;
      return firstLine.substring(0, maxLen) + '\u2026';
    }
  }
};
