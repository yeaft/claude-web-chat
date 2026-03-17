/**
 * CrewFeaturePanel — Right sidebar: Feature Kanban board + message view.
 *
 * Two modes:
 *   1. List mode (default): narrow panel showing feature cards with progress,
 *      todos, and latest message summary.
 *   2. Expanded mode: panel widens to 50% width, shows full message thread
 *      for a selected feature using CrewTurnRenderer.
 */
import {
  formatDuration
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
  emits: ['scroll-to-feature', 'toggle-turn', 'expand-feature', 'close-feature'],
  data() {
    return {
      expandedFeatureCards: {},
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

        <!-- ===== LIST MODE: Feature cards ===== -->
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
                 :class="{
                   'is-expanded': isFeatureCardExpanded(feature.taskId),
                   'has-streaming': feature.hasStreaming
                 }">
              <div class="crew-feature-card-header"
                   @click="toggleFeatureCard(feature.taskId)"
                   @dblclick="$emit('expand-feature', feature.taskId)">
                <svg class="crew-feature-card-chevron" viewBox="0 0 24 24" width="12" height="12">
                  <path fill="currentColor" d="M10 6l6 6-6 6z"/>
                </svg>
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
              <div v-if="feature.activeRoles.length > 0" class="crew-feature-card-roles">
                <span class="crew-feature-card-roles-icons">
                  <span v-for="ar in feature.activeRoles" :key="ar.role">{{ ar.roleIcon }}</span>
                </span>
                <span class="crew-feature-card-roles-label">{{ $t('crew.working') }}</span>
              </div>
              <template v-if="isFeatureCardExpanded(feature.taskId)">
                <div v-if="feature.todos.length > 0" class="crew-feature-card-todos">
                  <div v-for="todo in feature.todos" :key="todo.id"
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
                <div v-if="getLatestMessageSummary(feature.taskId)" class="crew-feature-card-summary"
                     @click.stop="$emit('expand-feature', feature.taskId)">
                  <span v-if="getLatestMessageSummary(feature.taskId).icon" class="crew-feature-summary-icon">{{ getLatestMessageSummary(feature.taskId).icon }}</span>
                  <span class="crew-feature-summary-text">{{ getLatestMessageSummary(feature.taskId).text }}</span>
                  <svg class="crew-feature-summary-expand" viewBox="0 0 24 24" width="12" height="12">
                    <path fill="currentColor" d="M10 6l6 6-6 6z"/>
                  </svg>
                </div>
                <div v-if="feature.todos.length === 0 && !getLatestMessageSummary(feature.taskId)"
                     class="crew-feature-card-empty">
                  {{ $t('crew.statusInProgress') }}
                </div>
              </template>
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
                   :class="{
                     'is-expanded': isFeatureCardExpanded(feature.taskId)
                   }">
                <div class="crew-feature-card-header"
                     @click="toggleFeatureCard(feature.taskId)"
                     @dblclick="$emit('expand-feature', feature.taskId)">
                  <svg class="crew-feature-card-chevron" viewBox="0 0 24 24" width="12" height="12">
                    <path fill="currentColor" d="M10 6l6 6-6 6z"/>
                  </svg>
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
                <template v-if="isFeatureCardExpanded(feature.taskId)">
                  <div v-if="feature.todos.length > 0" class="crew-feature-card-todos">
                    <div v-for="todo in feature.todos" :key="todo.id"
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
                  <div v-if="getLatestMessageSummary(feature.taskId)" class="crew-feature-card-summary"
                       @click.stop="$emit('expand-feature', feature.taskId)">
                    <span v-if="getLatestMessageSummary(feature.taskId).icon" class="crew-feature-summary-icon">{{ getLatestMessageSummary(feature.taskId).icon }}</span>
                    <span class="crew-feature-summary-text">{{ getLatestMessageSummary(feature.taskId).text }}</span>
                    <svg class="crew-feature-summary-expand" viewBox="0 0 24 24" width="12" height="12">
                      <path fill="currentColor" d="M10 6l6 6-6 6z"/>
                    </svg>
                  </div>
                  <div v-if="feature.todos.length === 0 && !getLatestMessageSummary(feature.taskId)"
                       class="crew-feature-card-empty">
                    {{ $t('crew.statusCompleted') }}
                  </div>
                </template>
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
    shouldShowTurnDivider,
    getMaxRound,

    toggleFeatureCard(taskId) {
      this.expandedFeatureCards[taskId] = !this.isFeatureCardExpanded(taskId);
    },

    isFeatureCardExpanded(taskId) {
      if (taskId in this.expandedFeatureCards) {
        return this.expandedFeatureCards[taskId];
      }
      const feature = this.featureKanban.find(f => f.taskId === taskId);
      if (feature) {
        return feature.todos.some(t => t.status === 'in_progress') || !feature.isCompleted;
      }
      return true;
    },

    /**
     * Get latest message summary for a feature card (list mode).
     * Returns { icon, text } or null if no text message exists.
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
          return {
            icon: turn.roleIcon || '',
            text: this.truncateText(turn.textMsg.content, 80)
          };
        }
        if (turn.type !== 'turn' && turn.message?.type === 'text') {
          return {
            icon: turn.message.roleIcon || '',
            text: this.truncateText(turn.message.content, 80)
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
      return firstLine.substring(0, maxLen) + '…';
    }
  }
};
