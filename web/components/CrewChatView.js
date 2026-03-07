/**
 * CrewChatView - Crew 群聊视图
 * 显示多角色的群聊消息，包括状态栏和控制按钮
 * 支持动态添加/移除角色
 *
 * 实现拆分为子模块：
 *   crew/crewHelpers.js         — 工具函数（样式、格式化、图标）
 *   crew/crewMessageGrouping.js — 消息分组逻辑（turns、segments、blocks）
 *   crew/crewKanban.js          — Kanban/TODO 计算逻辑
 *   crew/crewRolePresets.js     — 预设角色数据
 */
import { renderMarkdown, clearMarkdownCache } from '../utils/markdown.js';
import {
  ICONS, PRESET_ROLES,
  formatTime, formatTokens, formatDuration,
  shortName, getRoleStyle, getTaskColor, getImageUrl
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
import { rolePresets } from './crew/crewRolePresets.js';

export default {
  name: 'CrewChatView',
  template: `
    <div class="crew-chat-view">
      <div class="crew-workspace" :class="{ 'hide-roles': !store.crewPanelVisible.roles, 'hide-features': !store.crewPanelVisible.features, 'mobile-panel-roles': store.crewMobilePanel === 'roles', 'mobile-panel-features': store.crewMobilePanel === 'features' }">
        <div class="crew-mobile-overlay" v-if="store.crewMobilePanel" @click="store.crewMobilePanel = null"></div>

        <!-- Left Panel: Role Cards -->
        <aside class="crew-panel-left">
          <div class="crew-panel-left-scroll">
            <button class="crew-mobile-close" @click="store.crewMobilePanel = null"><svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg> {{ $t('crew.close') }}</button>
            <div class="crew-role-list">
              <div v-for="role in sessionRoles" :key="role.name"
                   class="crew-role-card"
                   :class="{ 'is-streaming': isRoleStreaming(role.name) }"
                   :style="getRoleStyle(role.name)"
                   @click="scrollToRoleLatest(role.name)">
                <div class="crew-role-card-header">
                  <span class="crew-role-card-icon">{{ role.icon }}</span>
                  <span class="crew-role-card-name">{{ role.displayName }}</span>
                  <span v-if="role.isDecisionMaker" class="crew-role-card-dm">\u2605</span>
                  <span class="crew-role-card-header-actions" @click.stop>
                    <button v-if="isRoleStreaming(role.name)" class="crew-role-action-btn crew-role-abort-btn" @click.stop="abortRole(role.name)" :title="$t('crew.abortTask')">⏹</button>
                    <button class="crew-role-action-btn" @click.stop="clearRole(role.name)" :title="$t('crew.clearChat')">🗑</button>
                  </span>
                </div>
                <div v-if="getRoleCurrentTask(role.name)" class="crew-role-card-feature">
                  {{ getRoleCurrentTask(role.name) }}
                </div>
                <div v-if="isRoleStreaming(role.name) && getRoleCurrentTool(role.name)"
                     class="crew-role-card-tool">
                  {{ getRoleCurrentTool(role.name) }}
                </div>
              </div>
            </div>

            <!-- 底部操作区 -->
            <div class="crew-panel-left-actions">
              <button class="crew-add-role-btn" @click="showAddRole = true">
                <svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>
                <span>{{ $t('crew.addRole') }}</span>
              </button>
              <button class="crew-action-btn" @click="controlAction('clear')" :title="$t('crew.clearSession')">
                <span v-html="icons.close"></span>
              </button>
              <button class="crew-action-btn danger" @click="controlAction('stop_all')" :title="$t('crew.stopRound')">
                <span v-html="icons.stop"></span>
              </button>
            </div>
          </div>
        </aside>

        <!-- Center Panel: Chat Flow -->
        <div class="crew-panel-center">

      <!-- Messages -->
      <div class="crew-messages" ref="messagesRef" @scroll="onScroll">
        <div v-if="store.currentCrewMessages.length === 0" class="crew-empty">
          <div class="crew-empty-icon" v-html="icons.crew.replace(/16/g, '48')"></div>
          <div class="crew-empty-text" v-if="store.currentCrewSession">{{ $t('crew.emptyWaiting') }}</div>
          <div class="crew-empty-text" v-else>{{ $t('crew.emptyWaitingSession') }}</div>
        </div>

        <div v-if="isLoadingHistory" class="crew-load-more crew-load-more-loading">
          <span class="crew-typing-dot"></span>
          <span class="crew-typing-dot"></span>
          <span class="crew-typing-dot"></span>
          {{ $t('crew.loadingHistory') }}
        </div>
        <div v-else-if="hiddenBlockCount > 0" class="crew-load-more" @click="loadMoreBlocks">
          {{ $t('crew.loadOlder') }} <span class="crew-load-more-count">({{ hiddenBlockCount }})</span>
        </div>
        <div v-else-if="hasOlderMessages" class="crew-load-more" @click="loadHistory">
          {{ $t('crew.loadHistory') }}
        </div>

        <template v-for="(block, bidx) in visibleBlocks" :key="block.id">
          <!-- Global block: messages without taskId, render inline -->
          <template v-if="block.type === 'global'">
            <template v-for="(turn, tidx) in block.turns" :key="turn.id">
              <div v-if="tidx > 0 && shouldShowTurnDivider(block.turns, tidx)" class="crew-turn-divider"></div>
              <div v-if="turn.type === 'turn' && getMaxRound(turn) > 0" class="crew-round-divider">
                <div class="crew-round-line"></div>
                <span class="crew-round-label">Round {{ getMaxRound(turn) }}</span>
                <div class="crew-round-line"></div>
              </div>
              <div v-if="turn.type !== 'turn'" class="crew-message" :class="['crew-msg-' + (turn.message.type), 'crew-role-' + (turn.message.role), { 'crew-msg-human-bubble': turn.message.role === 'human' && turn.message.type === 'text' }]" :data-role="turn.message.role" :style="getRoleStyle(turn.message.role)">
                <div class="crew-msg-body">
                  <div v-if="turn.message.role !== 'human' || turn.message.type !== 'text'" class="crew-msg-header">
                    <span v-if="turn.message.roleIcon" class="crew-msg-header-icon">{{ turn.message.roleIcon }}</span>
                    <span class="crew-msg-name" :class="{ 'is-human': turn.message.role === 'human', 'is-system': turn.message.role === 'system' }">{{ shortName(turn.message.roleName) }}</span>
                    <span class="crew-msg-time">{{ formatTime(turn.message.timestamp) }}</span>
                  </div>
                  <div v-if="turn.message.type === 'system'" class="crew-msg-system">{{ turn.message.content }}</div>
                  <div v-else-if="turn.message.type === 'human_needed'" class="crew-msg-human-needed">
                    <span class="crew-control-icon" v-html="icons.bell"></span> {{ turn.message.content }}
                  </div>
                  <div v-else-if="turn.message.type === 'role_error'" class="crew-msg-role-error">
                    <span class="crew-error-icon">{{ turn.message.recoverable ? '\ud83d\udd04' : '\u274c' }}</span>
                    <span>{{ turn.message.content }}</span>
                  </div>
                  <div v-else-if="turn.message.type === 'text'" class="crew-msg-content markdown-body" v-html="mdRender(turn.message.content)"></div>
                  <div v-if="turn.message.attachments && turn.message.attachments.length > 0" class="user-attachments" style="margin-top: 6px;">
                    <div v-for="(att, aidx) in turn.message.attachments" :key="aidx" class="user-attachment-item" :class="{ 'is-image': att.isImage }">
                      <img v-if="att.isImage && att.preview" :src="att.preview" :alt="att.name" class="user-attachment-image" />
                      <div v-else class="user-attachment-file"><span class="file-name">{{ att.name }}</span></div>
                    </div>
                  </div>
                  <div v-if="turn.message._sendFailed" class="crew-msg-send-failed">{{ $t('crew.sendFailed') }}</div>
                </div>
              </div>
              <div v-else class="crew-message crew-turn-group" :class="'crew-role-' + turn.role" :data-role="turn.role" :style="getRoleStyle(turn.role)">
                <div class="crew-msg-body">
                  <div class="crew-msg-header">
                    <span v-if="turn.roleIcon" class="crew-msg-header-icon">{{ turn.roleIcon }}</span>
                    <span class="crew-msg-name">{{ shortName(turn.roleName) }}</span>
                    <span class="crew-msg-time">{{ formatTime(turn.messages[0].timestamp) }}</span>
                  </div>
                  <template v-if="turn.textMsg">
                    <div class="crew-msg-content markdown-body" v-html="mdRender(turn.textMsg.content)"></div>
                  </template>
                  <div v-if="turn.toolMsgs.length > 0" class="crew-turn-tools">
                    <div v-if="expandedTurns[turn.id]" class="crew-turn-tools-expanded">
                      <template v-for="(toolMsg, ti) in turn.toolMsgs.slice(0, -1)" :key="toolMsg.id">
                        <tool-line :tool-name="toolMsg.toolName" :tool-input="toolMsg.toolInput" :tool-result="toolMsg.toolResult" :has-result="!!toolMsg.hasResult" :compact="true" />
                      </template>
                    </div>
                    <div class="crew-turn-tool-latest">
                      <tool-line :tool-name="turn.toolMsgs[turn.toolMsgs.length - 1].toolName" :tool-input="turn.toolMsgs[turn.toolMsgs.length - 1].toolInput" :tool-result="turn.toolMsgs[turn.toolMsgs.length - 1].toolResult" :has-result="!!turn.toolMsgs[turn.toolMsgs.length - 1].hasResult" :compact="true" />
                      <button v-if="turn.toolMsgs.length > 1" class="crew-turn-expand-btn" @click.stop="toggleTurn(turn.id)" :title="expandedTurns[turn.id] ? $t('crew.collapse') : $t('crew.expandOps', { count: turn.toolMsgs.length - 1 })">
                        <svg v-if="!expandedTurns[turn.id]" viewBox="0 0 24 24" width="12" height="12"><path fill="currentColor" d="M7 10l5 5 5-5z"/></svg>
                        <svg v-else viewBox="0 0 24 24" width="12" height="12"><path fill="currentColor" d="M7 14l5-5 5 5z"/></svg>
                        <span class="crew-turn-expand-count">{{ turn.toolMsgs.length }}</span>
                      </button>
                    </div>
                  </div>
                  <div v-if="turn.imageMsgs.length > 0" class="crew-msg-images">
                    <div v-for="img in turn.imageMsgs" :key="img.id" class="crew-msg-image">
                      <img v-if="img.fileId" :src="getImageUrl(img)" class="crew-screenshot" @error="handleImageError($event)" @click="openImagePreview(getImageUrl(img))" :alt="'Screenshot by ' + (img.roleName || img.role)" />
                      <div v-else class="crew-screenshot-expired">{{ $t('crew.imageExpired') }}</div>
                    </div>
                  </div>
                  <div v-if="turn.routeMsgs.length > 0" class="crew-turn-routes">
                    <div v-for="rm in turn.routeMsgs" :key="rm.id" class="crew-turn-route-item">
                      <div class="crew-route-header">
                        <span class="crew-route-from">{{ shortName(turn.roleName) }}</span>
                        <span class="crew-route-arrow">→</span>
                        <span class="crew-route-target-name">{{ rm.routeToName || getRoleDisplayName(rm.routeTo) }}</span>
                      </div>
                      <div v-if="rm.routeSummary" class="crew-route-summary">{{ rm.routeSummary }}</div>
                    </div>
                  </div>
                </div>
              </div>
            </template>
          </template>

          <!-- Feature block: messages with taskId, render as collapsible thread -->
          <div v-else class="crew-feature-thread" :data-block-id="block.id" :data-task-id="block.taskId" :class="{ 'is-completed': block.isCompleted, 'is-expanded': isFeatureExpanded(block) }">
            <div class="crew-feature-header" @click="toggleFeature(block.taskId)">
              <svg class="crew-feature-chevron" viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M10 6l6 6-6 6z"/></svg>
              <span class="crew-feature-title">{{ block.taskTitle }}</span>
              <span v-if="block.activeRoles && block.activeRoles.length > 0" class="crew-feature-actives">
                <span v-for="ar in block.activeRoles.slice(0, 3)" :key="ar.role" class="crew-feature-active-icon" :title="ar.roleName">{{ ar.roleIcon }}</span>
                <span v-if="block.activeRoles.length > 3" class="crew-feature-active-more">+{{ block.activeRoles.length - 3 }}</span>
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
                  <div v-if="turn.type === 'turn' && getMaxRound(turn) > 0" class="crew-round-divider">
                    <div class="crew-round-line"></div>
                    <span class="crew-round-label">Round {{ getMaxRound(turn) }}</span>
                    <div class="crew-round-line"></div>
                  </div>
                  <div v-if="turn.type !== 'turn'" class="crew-message" :class="['crew-msg-' + (turn.message.type), 'crew-role-' + (turn.message.role)]" :data-role="turn.message.role" :style="getRoleStyle(turn.message.role)">
                    <div class="crew-msg-body">
                      <div class="crew-msg-header">
                        <span v-if="turn.message.roleIcon" class="crew-msg-header-icon">{{ turn.message.roleIcon }}</span>
                        <span class="crew-msg-name">{{ shortName(turn.message.roleName) }}</span>
                        <span class="crew-msg-time">{{ formatTime(turn.message.timestamp) }}</span>
                      </div>
                      <div v-if="turn.message.type === 'system'" class="crew-msg-system">{{ turn.message.content }}</div>
                      <div v-else-if="turn.message.type === 'human_needed'" class="crew-msg-human-needed">
                        <span class="crew-control-icon" v-html="icons.bell"></span> {{ turn.message.content }}
                      </div>
                      <div v-else-if="turn.message.type === 'role_error'" class="crew-msg-role-error">
                        <span class="crew-error-icon">{{ turn.message.recoverable ? '\ud83d\udd04' : '\u274c' }}</span>
                        <span>{{ turn.message.content }}</span>
                      </div>
                      <div v-else-if="turn.message.type === 'text'" class="crew-msg-content markdown-body" v-html="mdRender(turn.message.content)"></div>
                    </div>
                  </div>
                  <div v-else class="crew-message crew-turn-group" :class="'crew-role-' + turn.role" :data-role="turn.role" :style="getRoleStyle(turn.role)">
                    <div class="crew-msg-body">
                      <div class="crew-msg-header">
                        <span v-if="turn.roleIcon" class="crew-msg-header-icon">{{ turn.roleIcon }}</span>
                        <span class="crew-msg-name">{{ shortName(turn.roleName) }}</span>
                        <span class="crew-msg-time">{{ formatTime(turn.messages[0].timestamp) }}</span>
                      </div>
                      <template v-if="turn.textMsg">
                        <div class="crew-msg-content markdown-body" v-html="mdRender(turn.textMsg.content)"></div>
                      </template>
                      <div v-if="turn.toolMsgs.length > 0" class="crew-turn-tools">
                        <div v-if="expandedTurns[turn.id]" class="crew-turn-tools-expanded">
                          <template v-for="(toolMsg, ti) in turn.toolMsgs.slice(0, -1)" :key="toolMsg.id">
                            <tool-line :tool-name="toolMsg.toolName" :tool-input="toolMsg.toolInput" :tool-result="toolMsg.toolResult" :has-result="!!toolMsg.hasResult" :compact="true" />
                          </template>
                        </div>
                        <div class="crew-turn-tool-latest">
                          <tool-line :tool-name="turn.toolMsgs[turn.toolMsgs.length - 1].toolName" :tool-input="turn.toolMsgs[turn.toolMsgs.length - 1].toolInput" :tool-result="turn.toolMsgs[turn.toolMsgs.length - 1].toolResult" :has-result="!!turn.toolMsgs[turn.toolMsgs.length - 1].hasResult" :compact="true" />
                          <button v-if="turn.toolMsgs.length > 1" class="crew-turn-expand-btn" @click.stop="toggleTurn(turn.id)" :title="expandedTurns[turn.id] ? $t('crew.collapse') : $t('crew.expandOps', { count: turn.toolMsgs.length - 1 })">
                            <svg v-if="!expandedTurns[turn.id]" viewBox="0 0 24 24" width="12" height="12"><path fill="currentColor" d="M7 10l5 5 5-5z"/></svg>
                            <svg v-else viewBox="0 0 24 24" width="12" height="12"><path fill="currentColor" d="M7 14l5-5 5 5z"/></svg>
                            <span class="crew-turn-expand-count">{{ turn.toolMsgs.length }}</span>
                          </button>
                        </div>
                      </div>
                      <div v-if="turn.imageMsgs.length > 0" class="crew-msg-images">
                        <div v-for="img in turn.imageMsgs" :key="img.id" class="crew-msg-image">
                          <img v-if="img.fileId" :src="getImageUrl(img)" class="crew-screenshot" @error="handleImageError($event)" @click="openImagePreview(getImageUrl(img))" :alt="'Screenshot by ' + (img.roleName || img.role)" />
                          <div v-else class="crew-screenshot-expired">{{ $t('crew.imageExpired') }}</div>
                        </div>
                      </div>
                      <div v-if="turn.routeMsgs.length > 0" class="crew-turn-routes">
                        <div v-for="rm in turn.routeMsgs" :key="rm.id" class="crew-turn-route-item">
                          <div class="crew-route-header">
                            <span class="crew-route-from">{{ shortName(turn.roleName) }}</span>
                            <span class="crew-route-arrow">→</span>
                            <span class="crew-route-target-name">{{ rm.routeToName || getRoleDisplayName(rm.routeTo) }}</span>
                          </div>
                          <div v-if="rm.routeSummary" class="crew-route-summary">{{ rm.routeSummary }}</div>
                        </div>
                      </div>
                    </div>
                  </div>
                </template>
              </div>

              <!-- Latest turn (always visible) -->
              <template v-if="getBlockTurns(block).length > 0">
                <template v-for="turn in [getBlockTurns(block)[getBlockTurns(block).length - 1]]" :key="turn.id">
                  <div v-if="turn.type !== 'turn'" class="crew-message" :class="['crew-msg-' + (turn.message.type), 'crew-role-' + (turn.message.role)]" :data-role="turn.message.role" :style="getRoleStyle(turn.message.role)">
                    <div class="crew-msg-body">
                      <div class="crew-msg-header">
                        <span v-if="turn.message.roleIcon" class="crew-msg-header-icon">{{ turn.message.roleIcon }}</span>
                        <span class="crew-msg-name">{{ shortName(turn.message.roleName) }}</span>
                        <span class="crew-msg-time">{{ formatTime(turn.message.timestamp) }}</span>
                      </div>
                      <div v-if="turn.message.type === 'system'" class="crew-msg-system">{{ turn.message.content }}</div>
                      <div v-else-if="turn.message.type === 'human_needed'" class="crew-msg-human-needed">
                        <span class="crew-control-icon" v-html="icons.bell"></span> {{ turn.message.content }}
                      </div>
                      <div v-else-if="turn.message.type === 'role_error'" class="crew-msg-role-error">
                        <span class="crew-error-icon">{{ turn.message.recoverable ? '\ud83d\udd04' : '\u274c' }}</span>
                        <span>{{ turn.message.content }}</span>
                      </div>
                      <div v-else-if="turn.message.type === 'text'" class="crew-msg-content markdown-body" v-html="mdRender(turn.message.content)"></div>
                    </div>
                  </div>
                  <div v-else class="crew-message crew-turn-group" :class="'crew-role-' + turn.role" :data-role="turn.role" :style="getRoleStyle(turn.role)">
                    <div class="crew-msg-body">
                      <div class="crew-msg-header">
                        <span v-if="turn.roleIcon" class="crew-msg-header-icon">{{ turn.roleIcon }}</span>
                        <span class="crew-msg-name">{{ shortName(turn.roleName) }}</span>
                        <span class="crew-msg-time">{{ formatTime(turn.messages[0].timestamp) }}</span>
                      </div>
                      <template v-if="turn.textMsg">
                        <div class="crew-msg-content markdown-body" v-html="mdRender(turn.textMsg.content)"></div>
                      </template>
                      <div v-if="turn.toolMsgs.length > 0" class="crew-turn-tools">
                        <div v-if="expandedTurns[turn.id]" class="crew-turn-tools-expanded">
                          <template v-for="(toolMsg, ti) in turn.toolMsgs.slice(0, -1)" :key="toolMsg.id">
                            <tool-line :tool-name="toolMsg.toolName" :tool-input="toolMsg.toolInput" :tool-result="toolMsg.toolResult" :has-result="!!toolMsg.hasResult" :compact="true" />
                          </template>
                        </div>
                        <div class="crew-turn-tool-latest">
                          <tool-line :tool-name="turn.toolMsgs[turn.toolMsgs.length - 1].toolName" :tool-input="turn.toolMsgs[turn.toolMsgs.length - 1].toolInput" :tool-result="turn.toolMsgs[turn.toolMsgs.length - 1].toolResult" :has-result="!!turn.toolMsgs[turn.toolMsgs.length - 1].hasResult" :compact="true" />
                          <button v-if="turn.toolMsgs.length > 1" class="crew-turn-expand-btn" @click.stop="toggleTurn(turn.id)" :title="expandedTurns[turn.id] ? $t('crew.collapse') : $t('crew.expandOps', { count: turn.toolMsgs.length - 1 })">
                            <svg v-if="!expandedTurns[turn.id]" viewBox="0 0 24 24" width="12" height="12"><path fill="currentColor" d="M7 10l5 5 5-5z"/></svg>
                            <svg v-else viewBox="0 0 24 24" width="12" height="12"><path fill="currentColor" d="M7 14l5-5 5 5z"/></svg>
                            <span class="crew-turn-expand-count">{{ turn.toolMsgs.length }}</span>
                          </button>
                        </div>
                      </div>
                      <div v-if="turn.imageMsgs.length > 0" class="crew-msg-images">
                        <div v-for="img in turn.imageMsgs" :key="img.id" class="crew-msg-image">
                          <img v-if="img.fileId" :src="getImageUrl(img)" class="crew-screenshot" @error="handleImageError($event)" @click="openImagePreview(getImageUrl(img))" :alt="'Screenshot by ' + (img.roleName || img.role)" />
                          <div v-else class="crew-screenshot-expired">{{ $t('crew.imageExpired') }}</div>
                        </div>
                      </div>
                      <div v-if="turn.routeMsgs.length > 0" class="crew-turn-routes">
                        <div v-for="rm in turn.routeMsgs" :key="rm.id" class="crew-turn-route-item">
                          <div class="crew-route-header">
                            <span class="crew-route-from">{{ shortName(turn.roleName) }}</span>
                            <span class="crew-route-arrow">→</span>
                            <span class="crew-route-target-name">{{ rm.routeToName || getRoleDisplayName(rm.routeTo) }}</span>
                          </div>
                          <div v-if="rm.routeSummary" class="crew-route-summary">{{ rm.routeSummary }}</div>
                        </div>
                      </div>
                    </div>
                  </div>
                </template>
              </template>
            </div>
          </div>
        </template>

        <!-- Active Messages -->
        <div v-if="activeMessages.length > 0 && (hasStreamingMessage || kanbanInProgressCount > 0)" class="crew-active-messages">
          <div class="crew-active-messages-label">{{ $t('crew.latestMessage') }}</div>
          <div v-for="am in activeMessages" :key="am.id" class="crew-message" :class="['crew-msg-' + am.type, 'crew-role-' + am.role, { 'crew-msg-human-bubble': am.role === 'human' && am.type === 'text' }]" :data-role="am.role" :style="getRoleStyle(am.role)">
            <div class="crew-msg-body">
              <div v-if="am.role !== 'human' || am.type !== 'text'" class="crew-msg-header">
                <span v-if="am.roleIcon" class="crew-msg-header-icon">{{ am.roleIcon }}</span>
                <span class="crew-msg-name" :class="{ 'is-human': am.role === 'human', 'is-system': am.role === 'system' }">{{ shortName(am.roleName) }}</span>
                <span v-if="am.taskTitle" class="crew-msg-task">{{ am.taskTitle }}</span>
                <span class="crew-msg-time">{{ formatTime(am.timestamp) }}</span>
              </div>
              <div class="crew-msg-content markdown-body" v-html="mdRender(am.content)"></div>
            </div>
          </div>
        </div>

        <div class="crew-scroll-bottom"
             :class="{ 'is-hidden': isAtBottom }"
             @click="scrollToBottomAndReset">
          {{ $t('crew.scrollToLatest') }}
        </div>

        <div v-if="isInitializing" class="crew-init-progress">
          <span class="crew-typing-dot"></span>
          <span class="crew-typing-dot"></span>
          <span class="crew-typing-dot"></span>
          <span class="crew-init-text">{{ initProgressText }}</span>
        </div>
      </div>

      <!-- Input -->
      <div class="input-area crew-input-area">
        <div class="crew-input-hints" v-if="store.currentCrewSession && store.currentCrewStatus">
          <span class="crew-hint-meta">R{{ store.currentCrewStatus.round || 0 }}</span>
          <span class="crew-hint-sep">&middot;</span>
          <span class="crew-hint-meta">\${{ (store.currentCrewStatus.costUsd || 0).toFixed(2) }}</span>
          <template v-if="totalTokens > 0">
            <span class="crew-hint-sep">&middot;</span>
            <span class="crew-hint-meta">{{ formatTokens(totalTokens) }}</span>
          </template>
        </div>
        <div v-if="currentPendingAsk" class="crew-ask-hint" @click="dismissPendingAsk">
          <span class="crew-ask-hint-icon">{{ currentPendingAsk.roleIcon }}</span>
          <span class="crew-ask-hint-text">{{ currentPendingAsk.roleName }} {{ $t('crew.askingYou') }}</span>
          <span class="crew-ask-hint-dismiss" :title="$t('crew.dismissAsk')">✕</span>
        </div>
        <div class="attachments-preview" v-if="attachments.length > 0">
          <div class="attachment-item" v-for="(file, index) in attachments" :key="index">
            <img v-if="file.preview" :src="file.preview" class="attachment-thumb" />
            <span v-else class="attachment-icon">\u{1F4CE}</span>
            <span class="attachment-name">{{ file.name }}</span>
            <button class="attachment-remove" @click="removeAttachment(index)">&times;</button>
          </div>
        </div>
        <div class="input-wrapper">
          <input
            type="file"
            ref="fileInput"
            id="crew-file-input"
            @change="handleFileSelect"
            multiple
            accept="image/*,text/*,.pdf,.doc,.docx,.xls,.xlsx,.json,.md,.py,.js,.ts,.css,.html"
            class="file-input-hidden"
          />
          <label class="attach-btn" for="crew-file-input" :title="$t('crew.uploadFile')">
            <svg viewBox="0 0 24 24" width="20" height="20">
              <path d="M16.5 6v11.5c0 2.21-1.79 4-4 4s-4-1.79-4-4V5c0-1.38 1.12-2.5 2.5-2.5s2.5 1.12 2.5 2.5v10.5c0 .55-.45 1-1 1s-1-.45-1-1V6H10v9.5c0 1.38 1.12 2.5 2.5 2.5s2.5-1.12 2.5-2.5V5c0-2.21-1.79-4-4-4S7 2.79 7 5v12.5c0 3.04 2.46 5.5 5.5 5.5s5.5-2.46 5.5-5.5V6h-1.5z"/>
            </svg>
          </label>
          <div class="textarea-wrapper">
            <textarea
              ref="inputRef"
              v-model="inputText"
              @input="handleInput"
              @keydown="handleKeydown"
              @paste="handlePaste"
              :placeholder="$t('crew.inputPlaceholder')"
              rows="1"
            ></textarea>
            <div class="crew-at-menu" v-if="atMenuVisible && filteredAtRoles.length > 0">
              <div v-for="(role, idx) in filteredAtRoles" :key="role.name"
                class="crew-at-menu-item" :class="{ active: idx === atMenuIndex }"
                @mousedown.prevent="selectAtRole(role)">
                <span v-if="role.icon" class="crew-at-menu-icon">{{ role.icon }}</span>
                <span class="crew-at-menu-name">{{ role.displayName }}</span>
                <span class="crew-at-menu-desc">{{ role.description }}</span>
              </div>
            </div>
          </div>
          <button class="send-btn" @click="sendMessage" :disabled="!canSend" :title="$t('crew.send')">
            <svg viewBox="0 0 24 24"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>
          </button>
        </div>
      </div>

        </div><!-- /crew-panel-center -->

        <!-- Right Panel: Feature Kanban -->
        <aside class="crew-panel-right">
          <div class="crew-panel-right-scroll">
            <button class="crew-mobile-close" @click="store.crewMobilePanel = null"><svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg> {{ $t('crew.close') }}</button>

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
                     @dblclick="scrollToFeature(feature.taskId)">
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
                <div v-if="isFeatureCardExpanded(feature.taskId) && feature.todos.length > 0"
                     class="crew-feature-card-todos">
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
                <div v-if="isFeatureCardExpanded(feature.taskId) && feature.todos.length === 0"
                     class="crew-feature-card-empty">
                  {{ $t('crew.statusInProgress') }}
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
                     :class="{
                       'is-expanded': isFeatureCardExpanded(feature.taskId)
                     }">
                  <div class="crew-feature-card-header"
                       @click="toggleFeatureCard(feature.taskId)"
                       @dblclick="scrollToFeature(feature.taskId)">
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
                  <div v-if="isFeatureCardExpanded(feature.taskId) && feature.todos.length > 0"
                       class="crew-feature-card-todos">
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
                  <div v-if="isFeatureCardExpanded(feature.taskId) && feature.todos.length === 0"
                       class="crew-feature-card-empty">
                    {{ $t('crew.statusCompleted') }}
                  </div>
                </div>
              </template>
            </div>

            <!-- Empty state -->
            <div v-if="featureKanban.length === 0" class="crew-kanban-empty">
              <div class="crew-kanban-empty-text">{{ $t('crew.noFeatures') }}</div>
            </div>
          </div>

        </aside>
      </div><!-- /crew-workspace -->

      <!-- Add Role Modal -->
      <div v-if="showAddRole" class="crew-add-role-overlay" @click.self="showAddRole = false">
        <div class="crew-add-role-modal">
          <div class="crew-add-role-title">{{ $t('crew.addRoleTitle') }}</div>

          <div class="crew-add-role-presets">
            <button v-for="preset in availablePresets" :key="preset.name" class="crew-preset-btn" @click="quickAddPreset(preset)">
              <span v-if="preset.icon">{{ preset.icon }} </span>{{ preset.displayName }}
            </button>
          </div>

          <details class="crew-add-custom-details">
            <summary class="crew-add-custom-summary">{{ $t('crew.customRole') }}</summary>
            <div class="crew-add-role-form">
              <div class="crew-add-role-row">
                <input v-model="newRole.name" :placeholder="$t('crew.namePlaceholder')" class="crew-add-input" />
                <input v-model="newRole.displayName" :placeholder="$t('crew.displayNamePlaceholder')" class="crew-add-input" />
                <input v-model="newRole.icon" :placeholder="$t('crew.iconPlaceholder')" class="crew-add-input" style="width: 50px; flex: none;" />
              </div>
              <input v-model="newRole.description" :placeholder="$t('crew.descPlaceholder')" class="crew-add-input" />
              <textarea v-model="newRole.claudeMd" :placeholder="$t('crew.promptPlaceholder')" rows="2" class="crew-add-input"></textarea>
              <div class="crew-add-role-actions">
                <button class="crew-add-role-confirm" @click="confirmAddRole" :disabled="!newRole.name || !newRole.displayName">{{ $t('crew.add') }}</button>
              </div>
            </div>
          </details>
        </div>
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
      inputText: '',
      controlOpen: false,
      showAddRole: false,
      attachments: [],
      uploading: false,
      expandedTurns: {},
      expandedTodoGroups: {},
      expandedFeatures: {},
      expandedHistories: {},
      expandedFeatureCards: {},
      showCompletedFeatures: false,
      nowTick: Date.now(),
      isAtBottom: true,
      visibleBlockCount: 20,
      isLoadingMore: false,
      isLoadingHistory: false,
      atMenuVisible: false,
      atQuery: '',
      atMenuIndex: 0,
      newRole: this.getEmptyRole(),
      rolePresets
    };
  },

  computed: {
    isInitializing() {
      return this.store.currentCrewStatus?.status === 'initializing';
    },
    initProgressText() {
      const p = this.store.currentCrewStatus?.initProgress;
      if (p === 'roles') return this.$t('crew.initRoles');
      if (p === 'worktrees') return this.$t('crew.initWorktrees');
      return this.$t('crew.initPreparing');
    },
    hasStreamingMessage() {
      return this.store.currentCrewMessages.some(m => m._streaming);
    },
    totalTokens() {
      const s = this.store.currentCrewStatus;
      if (!s) return 0;
      return (s.totalInputTokens || 0) + (s.totalOutputTokens || 0);
    },
    canSend() {
      const hasContent = this.inputText.trim() || this.attachments.length > 0;
      const notUploading = !this.uploading && this.attachments.every(a => a.fileId);
      return hasContent && notUploading;
    },
    filteredAtRoles() {
      if (!this.atMenuVisible) return [];
      const roles = this.store.currentCrewSession?.roles || [];
      const q = this.atQuery.toLowerCase();
      if (!q) return roles;
      return roles.filter(r =>
        r.name.toLowerCase().includes(q) ||
        r.displayName.toLowerCase().includes(q)
      );
    },
    availablePresets() {
      const existing = this.store.currentCrewSession?.roles?.map(r => r.name) || [];
      return this.rolePresets.filter(p => !existing.includes(p.name));
    },
    crewTasks() {
      return parseCrewTasks(this.store.currentCrewMessages);
    },
    completedTaskCount() {
      return this.crewTasks.filter(t => t.done).length;
    },
    doneTasks() {
      return this.crewTasks.filter(t => t.done);
    },
    activeTasks() {
      const persistedFeatures = this.store.currentCrewStatus?.features || [];
      return collectActiveTasks(persistedFeatures, this.store.currentCrewMessages);
    },
    completedTaskIds() {
      return computeCompletedTaskIds(this.doneTasks, this.activeTasks);
    },
    activeMessages() {
      const messages = this.store.currentCrewMessages;
      for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        if (m.type !== 'text' || !m.role) continue;
        if (m.role === 'system') continue;
        return [m];
      }
      return [];
    },
    featureBlocks() {
      const allMessages = this.store.currentCrewMessages;
      const completed = this.completedTaskIds;
      const len = allMessages.length;

      if (!this._fbCache) {
        this._fbCache = createFbCache(null);
      }
      const cache = this._fbCache;

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
    visibleBlocks() {
      const all = this.featureBlocks;
      if (all.length <= this.visibleBlockCount) return all;
      return all.slice(all.length - this.visibleBlockCount);
    },
    hiddenBlockCount() {
      return Math.max(0, this.featureBlocks.length - this.visibleBlockCount);
    },
    hasOlderMessages() {
      const sid = this.store.currentConversation;
      const older = this.store.crewOlderMessages[sid];
      return older?.hasMore || false;
    },
    pendingAsks() {
      const asks = [];
      const messages = this.store.currentCrewMessages;
      for (const msg of messages) {
        if (msg.type === 'tool' && msg.toolName === 'AskUserQuestion' && !msg.askAnswered && msg.askRequestId) {
          asks.push({
            taskId: msg.taskId || null,
            roleIcon: msg.roleIcon,
            roleName: msg.roleName,
            askMsg: msg,
          });
        }
      }
      return asks;
    },
    currentPendingAsk() {
      return this.pendingAsks.length > 0 ? this.pendingAsks[0] : null;
    },
    todosByFeature() {
      return buildTodosByFeature(this.store.currentCrewMessages);
    },
    sessionRoles() {
      return this.store.currentCrewSession?.roles || [];
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
    kanbanInProgressCount() {
      return this.featureKanbanGrouped.inProgress.length;
    }
  },

  watch: {
    '$route'() {
      this.store.crewMobilePanel = null;
    },
    kanbanInProgressCount(val) {
      this.store.crewInProgressCount = val;
    },
    'store.currentConversation'(newId, oldId) {
      this.store.crewMobilePanel = null;
      if (oldId && this.inputText) {
        this.store.inputDrafts[oldId] = this.inputText;
      } else if (oldId) {
        delete this.store.inputDrafts[oldId];
      }
      this.inputText = (newId && this.store.inputDrafts[newId]) || '';
      this._draftConvId = newId;
      this._fbCache = null;
      clearMarkdownCache();
      this.visibleBlockCount = 20;
      this.$nextTick(() => {
        setTimeout(() => this.scrollToMeaningfulContent(), 300);
      });
    },
    inputText(val) {
      const convId = this.store.currentConversation;
      if (convId) {
        if (val) {
          this.store.inputDrafts[convId] = val;
        } else {
          delete this.store.inputDrafts[convId];
        }
      }
    },
    'store.currentCrewMessages': {
      handler() {
        this.$nextTick(() => this.smartScrollToBottom());
      },
      deep: true
    }
  },

  methods: {
    // -- Delegated helpers --
    formatTime,
    formatTokens,
    formatDuration,
    shortName,
    getRoleStyle,
    getTaskColor,
    getImageUrl,
    shouldShowTurnDivider,
    getMaxRound,
    mdRender: renderMarkdown,

    getEmptyRole() {
      return { name: '', displayName: '', icon: '\u{1F916}', description: '', model: 'sonnet', claudeMd: '', isDecisionMaker: false };
    },

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
      if (block.taskId in this.expandedFeatures) {
        return this.expandedFeatures[block.taskId];
      }
      if (block.hasPendingAsk) return true;
      if (block.hasStreaming) return true;
      if (!block.isCompleted) return true;
      const featureOnly = this.featureBlocks.filter(b => b.type === 'feature');
      const idx = featureOnly.findIndex(b => b.id === block.id);
      const fromEnd = featureOnly.length - 1 - idx;
      return fromEnd < 2;
    },

    getBlockTurns(block) {
      return getBlockTurns(block, this._fbCache);
    },

    getRoleDisplayName(roleName) {
      const session = this.store.currentCrewSession;
      if (!session) return roleName;
      const role = session.roles.find(r => r.name === roleName);
      return role ? role.displayName : roleName;
    },

    handleImageError(event) {
      const img = event.target;
      const expired = document.createElement('div');
      expired.className = 'crew-screenshot-expired';
      expired.textContent = this.$t('crew.imageExpired');
      img.parentNode.replaceChild(expired, img);
    },

    openImagePreview(src) {
      window.open(src, '_blank');
    },

    isRoleStreaming(roleName) {
      return this.store.currentCrewStatus?.activeRoles?.includes(roleName);
    },

    getRoleCurrentTool(roleName) {
      return this.store.currentCrewStatus?.currentToolByRole?.[roleName] || null;
    },

    getRoleCurrentTask(roleName) {
      const messages = this.store.currentCrewMessages;
      for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i];
        if (msg.role === roleName && msg.taskTitle) {
          if (msg.type === 'route' && msg.routeTo === 'pm') return null;
          return msg.taskTitle;
        }
      }
      return null;
    },

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

    scrollToFeature(taskId) {
      this.expandedFeatures[taskId] = true;
      this.$nextTick(() => {
        const el = this.$el.querySelector(`.crew-feature-thread[data-task-id="${taskId}"]`);
        if (el) {
          el.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
      });
    },

    // -- Input handling --
    handleInput() {
      this.autoResize();
      const textarea = this.$refs.inputRef;
      if (!textarea) return;
      const pos = textarea.selectionStart;
      const text = this.inputText;
      const beforeCursor = text.substring(0, pos);
      const atIdx = beforeCursor.lastIndexOf('@');
      if (atIdx >= 0 && (atIdx === 0 || /\s/.test(beforeCursor[atIdx - 1]))) {
        const query = beforeCursor.substring(atIdx + 1);
        if (!/\s/.test(query)) {
          this.atQuery = query;
          this.atMenuVisible = true;
          this.atMenuIndex = 0;
          return;
        }
      }
      this.atMenuVisible = false;
    },

    selectAtRole(role) {
      const textarea = this.$refs.inputRef;
      if (!textarea) return;
      const pos = textarea.selectionStart;
      const text = this.inputText;
      const beforeCursor = text.substring(0, pos);
      const atIdx = beforeCursor.lastIndexOf('@');
      if (atIdx >= 0) {
        const afterCursor = text.substring(pos);
        this.inputText = text.substring(0, atIdx) + '@' + role.displayName + ' ' + afterCursor;
        this.$nextTick(() => {
          const newPos = atIdx + role.displayName.length + 2;
          textarea.selectionStart = textarea.selectionEnd = newPos;
          textarea.focus();
        });
      }
      this.atMenuVisible = false;
    },

    autoResize() {
      const textarea = this.$refs.inputRef;
      if (textarea) {
        textarea.style.height = 'auto';
        textarea.style.height = Math.min(textarea.scrollHeight, 120) + 'px';
      }
    },

    handleKeydown(e) {
      if (this.atMenuVisible && this.filteredAtRoles.length > 0) {
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          this.atMenuIndex = (this.atMenuIndex + 1) % this.filteredAtRoles.length;
          return;
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          this.atMenuIndex = (this.atMenuIndex - 1 + this.filteredAtRoles.length) % this.filteredAtRoles.length;
          return;
        }
        if (e.key === 'Enter' || e.key === 'Tab') {
          e.preventDefault();
          this.selectAtRole(this.filteredAtRoles[this.atMenuIndex]);
          return;
        }
        if (e.key === 'Escape') {
          e.preventDefault();
          this.atMenuVisible = false;
          return;
        }
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this.sendMessage();
      }
    },

    handlePaste(e) {
      const items = e.clipboardData?.items;
      if (!items) return;
      const files = [];
      for (const item of items) {
        if (item.kind === 'file') {
          const file = item.getAsFile();
          if (file) files.push(file);
        }
      }
      if (files.length > 0) {
        e.preventDefault();
        this.addFiles(files);
      }
    },

    handleFileSelect(e) {
      const files = Array.from(e.target.files || []);
      if (files.length > 0) this.addFiles(files);
      e.target.value = '';
      this.$nextTick(() => this.$refs.inputRef?.focus());
    },

    async addFiles(files) {
      for (const file of files) {
        const attachment = { file, name: file.name, preview: null, uploading: true, fileId: null };
        if (file.type.startsWith('image/')) attachment.preview = URL.createObjectURL(file);
        this.attachments.push(attachment);
      }
      this.uploading = true;
      try {
        const formData = new FormData();
        for (const file of files) formData.append('files', file);
        const headers = {};
        if (this.authStore?.token) headers['Authorization'] = `Bearer ${this.authStore.token}`;
        const response = await fetch('/api/upload', { method: 'POST', headers, body: formData });
        if (!response.ok) throw new Error('Upload failed');
        const result = await response.json();
        let resultIndex = 0;
        for (const attachment of this.attachments) {
          if (attachment.uploading && !attachment.fileId && resultIndex < result.files.length) {
            attachment.fileId = result.files[resultIndex].fileId;
            attachment.uploading = false;
            resultIndex++;
          }
        }
      } catch (error) {
        console.error('Upload error:', error);
        const failed = this.attachments.filter(a => !a.fileId);
        for (const f of failed) { if (f.preview) URL.revokeObjectURL(f.preview); }
        this.attachments = this.attachments.filter(a => a.fileId);
      } finally {
        this.uploading = false;
        this.$nextTick(() => this.$refs.inputRef?.focus());
      }
    },

    removeAttachment(index) {
      const attachment = this.attachments[index];
      if (attachment.preview) URL.revokeObjectURL(attachment.preview);
      this.attachments.splice(index, 1);
      this.$nextTick(() => this.$refs.inputRef?.focus());
    },

    // -- Message sending --
    sendMessage(e) {
      if (e && e.preventDefault) e.preventDefault();
      if (!this.canSend) return;

      const text = this.inputText.trim();
      const attachmentInfos = this.attachments
        .filter(a => a.fileId)
        .map(a => ({
          fileId: a.fileId,
          name: a.name,
          preview: a.preview,
          isImage: a.file?.type?.startsWith('image/') || false,
          mimeType: a.file?.type || ''
        }));

      const ask = this.currentPendingAsk;
      if (ask && ask.askMsg.askRequestId && text) {
        const questions = ask.askMsg.toolInput?.questions || ask.askMsg.askQuestions || [];
        const answers = {};
        if (questions.length > 0) {
          for (const q of questions) {
            answers[q.question] = text;
          }
        } else {
          answers['response'] = text;
        }
        this.store.answerUserQuestion(ask.askMsg.askRequestId, answers);
        ask.askMsg.askAnswered = true;
        ask.askMsg.selectedAnswers = answers;
      }

      this.store.sendCrewMessage(text, null, attachmentInfos.length > 0 ? attachmentInfos : undefined);
      this.inputText = '';
      this.attachments = [];
      delete this.store.inputDrafts[this.store.currentConversation];
      if (this.$refs.inputRef) this.$refs.inputRef.style.height = 'auto';
      this.isAtBottom = true;
      this.$nextTick(() => this.scrollToBottom());
    },

    // -- Control actions --
    controlAction(action, targetRole = null) {
      this.controlOpen = false;
      if (action === 'clear') {
        if (!confirm(this.$t('crew.confirmClear'))) return;
      }
      this.store.sendCrewControl(action, targetRole);
    },

    clearRole(roleName) {
      if (!roleName) return;
      this.controlAction('clear_role', roleName);
    },

    abortRole(roleName) {
      if (!roleName) return;
      this.controlAction('abort_role', roleName);
    },

    quickAddPreset(preset) {
      this.store.addCrewRole({ ...preset });
      if (this.availablePresets.length <= 1) {
        this.showAddRole = false;
      }
    },

    confirmAddRole() {
      if (!this.newRole.name || !this.newRole.displayName) return;
      this.store.addCrewRole({ ...this.newRole });
      this.showAddRole = false;
      this.newRole = this.getEmptyRole();
    },

    dismissPendingAsk() {
      const ask = this.currentPendingAsk;
      if (ask) {
        ask.askMsg.askAnswered = true;
        ask.askMsg.selectedAnswers = { _dismissed: true };
      }
    },

    // -- Scroll management --
    scrollToRoleLatest(roleName) {
      const blocks = this.featureBlocks;
      let targetBlock = null;
      let isInLatestTurn = false;

      for (let i = blocks.length - 1; i >= 0; i--) {
        const block = blocks[i];
        const turns = block.turns;
        if (!turns) continue;
        for (let j = turns.length - 1; j >= 0; j--) {
          const turn = turns[j];
          const turnRole = turn.type === 'turn' ? turn.role : turn.message?.role;
          if (turnRole === roleName) {
            targetBlock = block;
            isInLatestTurn = j === turns.length - 1;
            break;
          }
        }
        if (targetBlock) break;
      }

      if (!targetBlock) return;

      const allBlocks = this.featureBlocks;
      const blockIdx = allBlocks.indexOf(targetBlock);
      const needed = allBlocks.length - blockIdx;
      if (needed > this.visibleBlockCount) {
        this.visibleBlockCount = needed;
      }

      if (targetBlock.type === 'feature' && targetBlock.taskId) {
        this.expandedFeatures[targetBlock.taskId] = true;
        if (!isInLatestTurn) {
          this.expandedHistories[targetBlock.taskId] = true;
        }
      }

      this.$nextTick(() => {
        const els = this.$el.querySelectorAll(`.crew-message[data-role="${roleName}"]`);
        const el = els.length > 0 ? els[els.length - 1] : null;
        if (el) {
          el.scrollIntoView({ behavior: 'smooth', block: 'center' });
          el.classList.add('crew-msg-highlight');
          setTimeout(() => el.classList.remove('crew-msg-highlight'), 2000);
        }
      });
    },

    scrollToMeaningfulContent() {
      this.$nextTick(() => {
        this.scrollToBottom();
      });
    },

    scrollToBottom() {
      const el = this.$refs.messagesRef;
      if (el) el.scrollTop = el.scrollHeight;
    },

    checkIfAtBottom() {
      const el = this.$refs.messagesRef;
      if (!el) return true;
      return el.scrollHeight - el.scrollTop - el.clientHeight <= 50;
    },

    onScroll() {
      this.isAtBottom = this.checkIfAtBottom();
      const scrollEl = this.$refs.messagesRef;
      if (scrollEl && scrollEl.scrollTop < 100) {
        if (this.hiddenBlockCount > 0) {
          this.loadMoreBlocks();
        } else if (this.hasOlderMessages && !this.isLoadingHistory) {
          this.loadHistory();
        }
      }
    },

    loadMoreBlocks() {
      if (this.isLoadingMore || this.hiddenBlockCount <= 0) return;
      this.isLoadingMore = true;

      const scrollEl = this.$refs.messagesRef;
      const oldScrollHeight = scrollEl.scrollHeight;
      const oldScrollTop = scrollEl.scrollTop;

      this.visibleBlockCount = Math.min(
        this.visibleBlockCount + 10,
        this.featureBlocks.length
      );

      this.$nextTick(() => {
        const newScrollHeight = scrollEl.scrollHeight;
        scrollEl.scrollTop = oldScrollTop + (newScrollHeight - oldScrollHeight);
        this.isLoadingMore = false;
      });
    },

    loadHistory() {
      if (this.isLoadingHistory || !this.hasOlderMessages) return;
      const sid = this.store.currentConversation;
      const requested = this.store.loadCrewHistory(sid);
      if (requested) {
        this.isLoadingHistory = true;
        const unwatch = this.$watch(
          () => this.store.crewOlderMessages[sid]?.loading,
          (loading) => {
            if (loading === false) {
              unwatch();
              this.isLoadingHistory = false;
              const scrollEl = this.$refs.messagesRef;
              const oldScrollHeight = scrollEl?.scrollHeight || 0;
              const oldScrollTop = scrollEl?.scrollTop || 0;
              this.visibleBlockCount = this.featureBlocks.length;
              this.$nextTick(() => {
                if (scrollEl) {
                  const newScrollHeight = scrollEl.scrollHeight;
                  scrollEl.scrollTop = oldScrollTop + (newScrollHeight - oldScrollHeight);
                }
              });
            }
          }
        );
      }
    },

    scrollToBottomAndReset() {
      this.visibleBlockCount = 20;
      this.$nextTick(() => this.scrollToBottom());
    },

    smartScrollToBottom() {
      if (this.isAtBottom) this.$nextTick(() => this.scrollToBottom());
    }
  },

  mounted() {
    const closeMenus = () => {
      this.controlOpen = false;
    };
    document.addEventListener('click', closeMenus);
    this._cleanupClick = closeMenus;
    this._elapsedTimer = setInterval(() => { this.nowTick = Date.now(); }, 1000);
    const convId = this.store.currentConversation;
    this._draftConvId = convId;
    if (convId && this.store.inputDrafts[convId]) {
      this.inputText = this.store.inputDrafts[convId];
    }
    this.$nextTick(() => this.scrollToBottom());
  },

  beforeUnmount() {
    if (this._cleanupClick) {
      document.removeEventListener('click', this._cleanupClick);
    }
    if (this._elapsedTimer) {
      clearInterval(this._elapsedTimer);
    }
    const convId = this._draftConvId || this.store.currentConversation;
    if (convId && this.inputText) {
      this.store.inputDrafts[convId] = this.inputText;
    }
  }
};
