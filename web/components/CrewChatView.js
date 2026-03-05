/**
 * CrewChatView - Crew 群聊视图
 * 显示多角色的群聊消息，包括状态栏和控制按钮
 * 支持动态添加/移除角色
 */
import { renderMarkdown } from '../utils/markdown.js';

const ICONS = {
  crew: '<svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z"/></svg>',
  pause: '<svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>',
  play: '<svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M8 5v14l11-7z"/></svg>',
  stop: '<svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M6 6h12v12H6z"/></svg>',
  close: '<svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>',
  settings: '<svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58a.49.49 0 0 0 .12-.61l-1.92-3.32a.49.49 0 0 0-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.484.484 0 0 0-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.07.62-.07.94s.02.64.07.94l-2.03 1.58a.49.49 0 0 0-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z"/></svg>',
  trash: '<svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>',
  bell: '<svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M12 22c1.1 0 2-.9 2-2h-4c0 1.1.89 2 2 2zm6-6v-5c0-3.07-1.64-5.64-4.5-6.32V4c0-.83-.67-1.5-1.5-1.5s-1.5.67-1.5 1.5v.68C7.63 5.36 6 7.92 6 11v5l-2 2v1h16v-1l-2-2z"/></svg>',
};

const PRESET_ROLES = ['pm', 'architect', 'developer', 'reviewer', 'tester', 'designer', 'writer', 'human', 'system'];

export default {
  name: 'CrewChatView',
  template: `
    <div class="crew-chat-view">
      <!-- Role Context Menu -->
      <div v-if="roleMenuVisible" class="crew-role-context-menu" :style="roleMenuStyle" @click.stop>
        <div class="crew-role-menu-header"><span v-if="roleMenuTarget?.icon">{{ roleMenuTarget.icon }} </span>{{ roleMenuTarget?.displayName }}</div>
        <button class="crew-role-menu-item" @click="removeRole(roleMenuTarget?.name)">
          <span class="crew-control-icon" v-html="icons.trash"></span> 移除
        </button>
      </div>

      <div class="crew-workspace">
        <!-- Left Panel: Role Cards -->
        <aside class="crew-panel-left">
          <div class="crew-panel-left-scroll">
            <div class="crew-role-list">
              <div v-for="role in sessionRoles" :key="role.name"
                   class="crew-role-card"
                   :class="{ 'is-streaming': isRoleStreaming(role.name) }"
                   :style="getRoleStyle(role.name)"
                   @click="insertAt(role.name)"
                   @contextmenu.prevent="openRoleMenu($event, role)">
                <div class="crew-role-card-header">
                  <span class="crew-role-card-icon">{{ role.icon }}</span>
                  <span class="crew-role-card-name">{{ role.displayName }}</span>
                  <span v-if="role.isDecisionMaker" class="crew-role-card-dm">★</span>
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

            <!-- 添加角色按钮 -->
            <button class="crew-add-role-btn" @click="showAddRole = true">
              <svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>
              <span>添加角色</span>
            </button>
          </div>
        </aside>

        <!-- Center Panel: Chat Flow -->
        <div class="crew-panel-center">

      <!-- Messages -->
      <div class="crew-messages" ref="messagesRef" @scroll="onScroll">
        <div v-if="store.currentCrewMessages.length === 0" class="crew-empty">
          <div class="crew-empty-icon" v-html="icons.crew.replace(/16/g, '48')"></div>
          <div class="crew-empty-text" v-if="store.currentCrewSession">等待角色开始工作...</div>
          <div class="crew-empty-text" v-else>等待 Crew Session 启动...</div>
        </div>

        <div v-if="hiddenBlockCount > 0" class="crew-load-more" @click="loadMoreBlocks">
          ↑ 加载更早的消息 <span class="crew-load-more-count">({{ hiddenBlockCount }})</span>
        </div>

        <!-- Pending Ask Banner -->
        <div v-if="pendingAsks.length > 0" class="crew-pending-asks">
          <div class="crew-pending-asks-card">
            <div class="crew-pending-asks-header">
              <span class="icon">❓</span>
              {{ pendingAsks.length }} 个问题等待回答
            </div>
            <div class="crew-pending-asks-list">
              <div v-for="ask in pendingAsks" :key="ask.askMsg.id"
                   class="crew-pending-ask-item"
                   @click="scrollToAsk(ask)">
                <span class="crew-pending-ask-icon">{{ ask.roleIcon }}</span>
                <span class="crew-pending-ask-text">{{ ask.question }}</span>
                <span class="crew-pending-ask-goto">→ 查看</span>
              </div>
            </div>
          </div>
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
              <div v-if="turn.type !== 'turn'" class="crew-message" :class="['crew-msg-' + (turn.message.type), 'crew-role-' + (turn.message.role), { 'crew-msg-human-bubble': turn.message.role === 'human' && turn.message.type === 'text' }]" :style="getRoleStyle(turn.message.role)">
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
                  <div v-if="turn.message._sendFailed" class="crew-msg-send-failed">发送失败，请检查网络连接后重试</div>
                </div>
              </div>
              <div v-else class="crew-message crew-turn-group" :class="'crew-role-' + turn.role" :style="getRoleStyle(turn.role)">
                <div class="crew-msg-body">
                  <div class="crew-msg-header">
                    <span v-if="turn.roleIcon" class="crew-msg-header-icon">{{ turn.roleIcon }}</span>
                    <span class="crew-msg-name">{{ shortName(turn.roleName) }}</span>
                    <span class="crew-msg-time">{{ formatTime(turn.messages[0].timestamp) }}</span>
                    <span v-if="turn.askMsg" class="crew-ask-badge" :class="{ answered: isCrewAskAnswered(turn.askMsg), waiting: !isCrewAskAnswered(turn.askMsg) && !turn.askMsg.askRequestId, pending: !isCrewAskAnswered(turn.askMsg) && turn.askMsg.askRequestId }">
                      <template v-if="isCrewAskAnswered(turn.askMsg)">✓ 已回答</template>
                      <template v-else-if="turn.askMsg.askRequestId">❓ 需要确认</template>
                      <template v-else>⏳ 等待回答</template>
                    </span>
                  </div>
                  <template v-if="turn.textMsg">
                    <div class="crew-msg-content markdown-body" v-html="mdRender(turn.textMsg.content)"></div>
                  </template>
                  <div v-if="turn.toolMsgs.length > 0" class="crew-turn-tools">
                    <!-- Expanded history (above latest, chronological order) -->
                    <div v-if="expandedTurns[turn.id]" class="crew-turn-tools-expanded">
                      <template v-for="(toolMsg, ti) in turn.toolMsgs.slice(0, -1)" :key="toolMsg.id">
                        <tool-line :tool-name="toolMsg.toolName" :tool-input="toolMsg.toolInput" :tool-result="toolMsg.toolResult" :has-result="!!toolMsg.hasResult" :compact="true" />
                      </template>
                    </div>
                    <!-- Latest tool + expand button -->
                    <div class="crew-turn-tool-latest">
                      <tool-line :tool-name="turn.toolMsgs[turn.toolMsgs.length - 1].toolName" :tool-input="turn.toolMsgs[turn.toolMsgs.length - 1].toolInput" :tool-result="turn.toolMsgs[turn.toolMsgs.length - 1].toolResult" :has-result="!!turn.toolMsgs[turn.toolMsgs.length - 1].hasResult" :compact="true" />
                      <button v-if="turn.toolMsgs.length > 1" class="crew-turn-expand-btn" @click.stop="toggleTurn(turn.id)" :title="expandedTurns[turn.id] ? '收起' : '展开 ' + (turn.toolMsgs.length - 1) + ' 个操作'">
                        <svg v-if="!expandedTurns[turn.id]" viewBox="0 0 24 24" width="12" height="12"><path fill="currentColor" d="M7 10l5 5 5-5z"/></svg>
                        <svg v-else viewBox="0 0 24 24" width="12" height="12"><path fill="currentColor" d="M7 14l5-5 5 5z"/></svg>
                        <span class="crew-turn-expand-count">{{ turn.toolMsgs.length }}</span>
                      </button>
                    </div>
                  </div>
                  <div v-if="turn.imageMsgs.length > 0" class="crew-msg-images">
                    <div v-for="img in turn.imageMsgs" :key="img.id" class="crew-msg-image">
                      <img v-if="img.fileId" :src="getImageUrl(img)" class="crew-screenshot" @error="handleImageError($event)" @click="openImagePreview(getImageUrl(img))" :alt="'Screenshot by ' + (img.roleName || img.role)" />
                      <div v-else class="crew-screenshot-expired">图片已过期</div>
                    </div>
                  </div>
                  <template v-if="turn.askMsg">
                    <div class="crew-ask-card" :data-ask-id="turn.askMsg.id" :class="{ 'is-answered': isCrewAskAnswered(turn.askMsg), 'is-waiting': !isCrewAskAnswered(turn.askMsg) && !turn.askMsg.askRequestId }">
                      <div v-for="(q, qIdx) in getCrewAskQuestions(turn.askMsg)" :key="qIdx" class="crew-ask-question">
                        <div class="crew-ask-q-text">
                          <span class="crew-ask-q-chip" v-if="q.header">{{ q.header }}</span>
                          {{ q.question }}
                        </div>
                        <template v-if="!isCrewAskAnswered(turn.askMsg)">
                          <div class="crew-ask-options">
                            <button v-for="opt in q.options" :key="opt.label" class="crew-ask-opt" :class="{ selected: isCrewOptSelected(turn.askMsg.id, q.question, opt.label) }" :disabled="!turn.askMsg.askRequestId" @click="selectCrewOpt(turn.askMsg.id, q, opt)">
                              <span class="crew-ask-radio" :class="{ checked: isCrewOptSelected(turn.askMsg.id, q.question, opt.label) }"></span>
                              <span><span class="crew-ask-opt-label">{{ opt.label }}</span><span class="crew-ask-opt-desc" v-if="opt.description">{{ opt.description }}</span></span>
                            </button>
                          </div>
                          <div class="crew-ask-custom" v-if="turn.askMsg.askRequestId">
                            <input type="text" placeholder="自定义回答..." :value="crewAskCustom[turn.askMsg.id + ':' + q.question] || ''" @input="setCrewAskCustom(turn.askMsg.id, q.question, $event.target.value)" @keyup.enter="submitCrewAsk(turn.askMsg)" />
                          </div>
                        </template>
                        <div v-else class="crew-ask-answer">{{ getCrewAskAnswer(turn.askMsg, q.question) }}</div>
                      </div>
                      <div v-if="!isCrewAskAnswered(turn.askMsg) && turn.askMsg.askRequestId">
                        <button class="crew-ask-submit" @click="submitCrewAsk(turn.askMsg)" :disabled="!hasCrewAskSelection(turn.askMsg)">提交回答 ▶</button>
                      </div>
                      <div v-if="!isCrewAskAnswered(turn.askMsg) && !turn.askMsg.askRequestId" class="crew-ask-waiting-hint">
                        <span class="crew-typing-dot"></span><span class="crew-typing-dot"></span><span class="crew-typing-dot"></span> 等待连接...
                      </div>
                    </div>
                  </template>
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
                <span class="crew-feature-status-dot"></span> 已完成
              </span>
              <span v-else-if="block.hasStreaming" class="crew-feature-status active">
                <span class="crew-feature-status-dot"></span> 进行中
              </span>
            </div>
            <div v-if="isFeatureExpanded(block)" class="crew-feature-body">
              <!-- History toggle (only when there are older turns) -->
              <button v-if="block.turns.length > 1"
                      class="crew-feature-history-toggle"
                      :class="{ 'is-expanded': expandedHistories[block.taskId] }"
                      @click.stop="toggleHistory(block.taskId)">
                <svg viewBox="0 0 24 24"><path fill="currentColor" d="M10 6l6 6-6 6z"/></svg>
                查看 {{ block.turns.length - 1 }} 条历史消息
              </button>

              <!-- History messages (collapsed by default) -->
              <div v-if="expandedHistories[block.taskId] && block.turns.length > 1" class="crew-feature-history">
                <template v-for="(turn, tidx) in block.turns.slice(0, -1)" :key="turn.id">
                  <div v-if="tidx > 0 && shouldShowTurnDivider(block.turns, tidx)" class="crew-turn-divider"></div>
                  <div v-if="turn.type === 'turn' && getMaxRound(turn) > 0" class="crew-round-divider">
                    <div class="crew-round-line"></div>
                    <span class="crew-round-label">Round {{ getMaxRound(turn) }}</span>
                    <div class="crew-round-line"></div>
                  </div>
                  <div v-if="turn.type !== 'turn'" class="crew-message" :class="['crew-msg-' + (turn.message.type), 'crew-role-' + (turn.message.role)]" :style="getRoleStyle(turn.message.role)">
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
                  <div v-else class="crew-message crew-turn-group" :class="'crew-role-' + turn.role" :style="getRoleStyle(turn.role)">
                    <div class="crew-msg-body">
                      <div class="crew-msg-header">
                        <span v-if="turn.roleIcon" class="crew-msg-header-icon">{{ turn.roleIcon }}</span>
                        <span class="crew-msg-name">{{ shortName(turn.roleName) }}</span>
                        <span class="crew-msg-time">{{ formatTime(turn.messages[0].timestamp) }}</span>
                        <span v-if="turn.askMsg" class="crew-ask-badge" :class="{ answered: isCrewAskAnswered(turn.askMsg), waiting: !isCrewAskAnswered(turn.askMsg) && !turn.askMsg.askRequestId, pending: !isCrewAskAnswered(turn.askMsg) && turn.askMsg.askRequestId }">
                          <template v-if="isCrewAskAnswered(turn.askMsg)">✓ 已回答</template>
                          <template v-else-if="turn.askMsg.askRequestId">❓ 需要确认</template>
                          <template v-else>⏳ 等待回答</template>
                        </span>
                      </div>
                      <template v-if="turn.textMsg">
                        <div class="crew-msg-content markdown-body" v-html="mdRender(turn.textMsg.content)"></div>
                      </template>
                      <div v-if="turn.toolMsgs.length > 0" class="crew-turn-tools">
                        <!-- Expanded history (above latest, chronological order) -->
                        <div v-if="expandedTurns[turn.id]" class="crew-turn-tools-expanded">
                          <template v-for="(toolMsg, ti) in turn.toolMsgs.slice(0, -1)" :key="toolMsg.id">
                            <tool-line :tool-name="toolMsg.toolName" :tool-input="toolMsg.toolInput" :tool-result="toolMsg.toolResult" :has-result="!!toolMsg.hasResult" :compact="true" />
                          </template>
                        </div>
                        <!-- Latest tool + expand button -->
                        <div class="crew-turn-tool-latest">
                          <tool-line :tool-name="turn.toolMsgs[turn.toolMsgs.length - 1].toolName" :tool-input="turn.toolMsgs[turn.toolMsgs.length - 1].toolInput" :tool-result="turn.toolMsgs[turn.toolMsgs.length - 1].toolResult" :has-result="!!turn.toolMsgs[turn.toolMsgs.length - 1].hasResult" :compact="true" />
                          <button v-if="turn.toolMsgs.length > 1" class="crew-turn-expand-btn" @click.stop="toggleTurn(turn.id)" :title="expandedTurns[turn.id] ? '收起' : '展开 ' + (turn.toolMsgs.length - 1) + ' 个操作'">
                            <svg v-if="!expandedTurns[turn.id]" viewBox="0 0 24 24" width="12" height="12"><path fill="currentColor" d="M7 10l5 5 5-5z"/></svg>
                            <svg v-else viewBox="0 0 24 24" width="12" height="12"><path fill="currentColor" d="M7 14l5-5 5 5z"/></svg>
                            <span class="crew-turn-expand-count">{{ turn.toolMsgs.length }}</span>
                          </button>
                        </div>
                      </div>
                      <div v-if="turn.imageMsgs.length > 0" class="crew-msg-images">
                        <div v-for="img in turn.imageMsgs" :key="img.id" class="crew-msg-image">
                          <img v-if="img.fileId" :src="getImageUrl(img)" class="crew-screenshot" @error="handleImageError($event)" @click="openImagePreview(getImageUrl(img))" :alt="'Screenshot by ' + (img.roleName || img.role)" />
                          <div v-else class="crew-screenshot-expired">图片已过期</div>
                        </div>
                      </div>
                      <template v-if="turn.askMsg">
                        <div class="crew-ask-card" :data-ask-id="turn.askMsg.id" :class="{ 'is-answered': isCrewAskAnswered(turn.askMsg), 'is-waiting': !isCrewAskAnswered(turn.askMsg) && !turn.askMsg.askRequestId }">
                          <div v-for="(q, qIdx) in getCrewAskQuestions(turn.askMsg)" :key="qIdx" class="crew-ask-question">
                            <div class="crew-ask-q-text">
                              <span class="crew-ask-q-chip" v-if="q.header">{{ q.header }}</span>
                              {{ q.question }}
                            </div>
                            <template v-if="!isCrewAskAnswered(turn.askMsg)">
                              <div class="crew-ask-options">
                                <button v-for="opt in q.options" :key="opt.label" class="crew-ask-opt" :class="{ selected: isCrewOptSelected(turn.askMsg.id, q.question, opt.label) }" :disabled="!turn.askMsg.askRequestId" @click="selectCrewOpt(turn.askMsg.id, q, opt)">
                                  <span class="crew-ask-radio" :class="{ checked: isCrewOptSelected(turn.askMsg.id, q.question, opt.label) }"></span>
                                  <span><span class="crew-ask-opt-label">{{ opt.label }}</span><span class="crew-ask-opt-desc" v-if="opt.description">{{ opt.description }}</span></span>
                                </button>
                              </div>
                              <div class="crew-ask-custom" v-if="turn.askMsg.askRequestId">
                                <input type="text" placeholder="自定义回答..." :value="crewAskCustom[turn.askMsg.id + ':' + q.question] || ''" @input="setCrewAskCustom(turn.askMsg.id, q.question, $event.target.value)" @keyup.enter="submitCrewAsk(turn.askMsg)" />
                              </div>
                            </template>
                            <div v-else class="crew-ask-answer">{{ getCrewAskAnswer(turn.askMsg, q.question) }}</div>
                          </div>
                          <div v-if="!isCrewAskAnswered(turn.askMsg) && turn.askMsg.askRequestId">
                            <button class="crew-ask-submit" @click="submitCrewAsk(turn.askMsg)" :disabled="!hasCrewAskSelection(turn.askMsg)">提交回答 ▶</button>
                          </div>
                          <div v-if="!isCrewAskAnswered(turn.askMsg) && !turn.askMsg.askRequestId" class="crew-ask-waiting-hint">
                            <span class="crew-typing-dot"></span><span class="crew-typing-dot"></span><span class="crew-typing-dot"></span> 等待连接...
                          </div>
                        </div>
                      </template>
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
              <template v-if="block.turns.length > 0">
                <template v-for="turn in [block.turns[block.turns.length - 1]]" :key="turn.id">
                  <div v-if="turn.type !== 'turn'" class="crew-message" :class="['crew-msg-' + (turn.message.type), 'crew-role-' + (turn.message.role)]" :style="getRoleStyle(turn.message.role)">
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
                  <div v-else class="crew-message crew-turn-group" :class="'crew-role-' + turn.role" :style="getRoleStyle(turn.role)">
                    <div class="crew-msg-body">
                      <div class="crew-msg-header">
                        <span v-if="turn.roleIcon" class="crew-msg-header-icon">{{ turn.roleIcon }}</span>
                        <span class="crew-msg-name">{{ shortName(turn.roleName) }}</span>
                        <span class="crew-msg-time">{{ formatTime(turn.messages[0].timestamp) }}</span>
                        <span v-if="turn.askMsg" class="crew-ask-badge" :class="{ answered: isCrewAskAnswered(turn.askMsg), waiting: !isCrewAskAnswered(turn.askMsg) && !turn.askMsg.askRequestId, pending: !isCrewAskAnswered(turn.askMsg) && turn.askMsg.askRequestId }">
                          <template v-if="isCrewAskAnswered(turn.askMsg)">✓ 已回答</template>
                          <template v-else-if="turn.askMsg.askRequestId">❓ 需要确认</template>
                          <template v-else>⏳ 等待回答</template>
                        </span>
                      </div>
                      <template v-if="turn.textMsg">
                        <div class="crew-msg-content markdown-body" v-html="mdRender(turn.textMsg.content)"></div>
                      </template>
                      <div v-if="turn.toolMsgs.length > 0" class="crew-turn-tools">
                        <!-- Expanded history (above latest, chronological order) -->
                        <div v-if="expandedTurns[turn.id]" class="crew-turn-tools-expanded">
                          <template v-for="(toolMsg, ti) in turn.toolMsgs.slice(0, -1)" :key="toolMsg.id">
                            <tool-line :tool-name="toolMsg.toolName" :tool-input="toolMsg.toolInput" :tool-result="toolMsg.toolResult" :has-result="!!toolMsg.hasResult" :compact="true" />
                          </template>
                        </div>
                        <!-- Latest tool + expand button -->
                        <div class="crew-turn-tool-latest">
                          <tool-line :tool-name="turn.toolMsgs[turn.toolMsgs.length - 1].toolName" :tool-input="turn.toolMsgs[turn.toolMsgs.length - 1].toolInput" :tool-result="turn.toolMsgs[turn.toolMsgs.length - 1].toolResult" :has-result="!!turn.toolMsgs[turn.toolMsgs.length - 1].hasResult" :compact="true" />
                          <button v-if="turn.toolMsgs.length > 1" class="crew-turn-expand-btn" @click.stop="toggleTurn(turn.id)" :title="expandedTurns[turn.id] ? '收起' : '展开 ' + (turn.toolMsgs.length - 1) + ' 个操作'">
                            <svg v-if="!expandedTurns[turn.id]" viewBox="0 0 24 24" width="12" height="12"><path fill="currentColor" d="M7 10l5 5 5-5z"/></svg>
                            <svg v-else viewBox="0 0 24 24" width="12" height="12"><path fill="currentColor" d="M7 14l5-5 5 5z"/></svg>
                            <span class="crew-turn-expand-count">{{ turn.toolMsgs.length }}</span>
                          </button>
                        </div>
                      </div>
                      <div v-if="turn.imageMsgs.length > 0" class="crew-msg-images">
                        <div v-for="img in turn.imageMsgs" :key="img.id" class="crew-msg-image">
                          <img v-if="img.fileId" :src="getImageUrl(img)" class="crew-screenshot" @error="handleImageError($event)" @click="openImagePreview(getImageUrl(img))" :alt="'Screenshot by ' + (img.roleName || img.role)" />
                          <div v-else class="crew-screenshot-expired">图片已过期</div>
                        </div>
                      </div>
                      <template v-if="turn.askMsg">
                        <div class="crew-ask-card" :data-ask-id="turn.askMsg.id" :class="{ 'is-answered': isCrewAskAnswered(turn.askMsg), 'is-waiting': !isCrewAskAnswered(turn.askMsg) && !turn.askMsg.askRequestId }">
                          <div v-for="(q, qIdx) in getCrewAskQuestions(turn.askMsg)" :key="qIdx" class="crew-ask-question">
                            <div class="crew-ask-q-text">
                              <span class="crew-ask-q-chip" v-if="q.header">{{ q.header }}</span>
                              {{ q.question }}
                            </div>
                            <template v-if="!isCrewAskAnswered(turn.askMsg)">
                              <div class="crew-ask-options">
                                <button v-for="opt in q.options" :key="opt.label" class="crew-ask-opt" :class="{ selected: isCrewOptSelected(turn.askMsg.id, q.question, opt.label) }" :disabled="!turn.askMsg.askRequestId" @click="selectCrewOpt(turn.askMsg.id, q, opt)">
                                  <span class="crew-ask-radio" :class="{ checked: isCrewOptSelected(turn.askMsg.id, q.question, opt.label) }"></span>
                                  <span><span class="crew-ask-opt-label">{{ opt.label }}</span><span class="crew-ask-opt-desc" v-if="opt.description">{{ opt.description }}</span></span>
                                </button>
                              </div>
                              <div class="crew-ask-custom" v-if="turn.askMsg.askRequestId">
                                <input type="text" placeholder="自定义回答..." :value="crewAskCustom[turn.askMsg.id + ':' + q.question] || ''" @input="setCrewAskCustom(turn.askMsg.id, q.question, $event.target.value)" @keyup.enter="submitCrewAsk(turn.askMsg)" />
                              </div>
                            </template>
                            <div v-else class="crew-ask-answer">{{ getCrewAskAnswer(turn.askMsg, q.question) }}</div>
                          </div>
                          <div v-if="!isCrewAskAnswered(turn.askMsg) && turn.askMsg.askRequestId">
                            <button class="crew-ask-submit" @click="submitCrewAsk(turn.askMsg)" :disabled="!hasCrewAskSelection(turn.askMsg)">提交回答 ▶</button>
                          </div>
                          <div v-if="!isCrewAskAnswered(turn.askMsg) && !turn.askMsg.askRequestId" class="crew-ask-waiting-hint">
                            <span class="crew-typing-dot"></span><span class="crew-typing-dot"></span><span class="crew-typing-dot"></span> 等待连接...
                          </div>
                        </div>
                      </template>
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

        <!-- 回到最新按钮 -->
        <div class="crew-scroll-bottom"
             :class="{ 'is-hidden': isAtBottom }"
             @click="scrollToBottomAndReset">
          ↓ 最新
        </div>

        <!-- 流式指示器 -->
        <div v-if="hasStreamingMessage" class="crew-streaming-indicator">
          <span class="crew-typing-dot"></span>
          <span class="crew-typing-dot"></span>
          <span class="crew-typing-dot"></span>
        </div>
      </div>

      <!-- Input -->
      <div class="input-area crew-input-area">
        <div class="crew-input-hints" v-if="store.currentCrewSession">
          <span class="crew-hint-status" :class="statusClass">{{ statusText }}</span>
          <div class="crew-hint-controls" style="position: relative;">
            <button class="crew-hint-btn" @click.stop="controlOpen = !controlOpen" title="控制">
              <span v-if="store.currentCrewStatus?.status === 'running'" v-html="icons.pause"></span>
              <span v-else-if="store.currentCrewStatus?.status === 'paused'" v-html="icons.play"></span>
              <span v-else v-html="icons.settings"></span>
            </button>
            <div class="crew-control-dropdown" v-if="controlOpen" @click.stop>
              <button class="crew-control-item" @click="controlAction('pause')" v-if="store.currentCrewStatus?.status === 'running'">
                <span class="crew-control-icon" v-html="icons.pause"></span> 暂停全部
              </button>
              <button class="crew-control-item" @click="controlAction('resume')" v-if="store.currentCrewStatus?.status === 'paused'">
                <span class="crew-control-icon" v-html="icons.play"></span> 恢复
              </button>
              <div class="crew-control-divider"></div>
              <button class="crew-control-item" @click="controlAction('clear')">
                <span class="crew-control-icon" v-html="icons.close"></span> 清空会话
              </button>
            </div>
          </div>
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
            @change="handleFileSelect"
            multiple
            accept="image/*,text/*,.pdf,.doc,.docx,.xls,.xlsx,.json,.md,.py,.js,.ts,.css,.html"
            style="display: none;"
          />
          <button class="attach-btn" @click="triggerFileSelect" title="上传文件">
            <svg viewBox="0 0 24 24" width="20" height="20">
              <path d="M16.5 6v11.5c0 2.21-1.79 4-4 4s-4-1.79-4-4V5c0-1.38 1.12-2.5 2.5-2.5s2.5 1.12 2.5 2.5v10.5c0 .55-.45 1-1 1s-1-.45-1-1V6H10v9.5c0 1.38 1.12 2.5 2.5 2.5s2.5-1.12 2.5-2.5V5c0-2.21-1.79-4-4-4S7 2.79 7 5v12.5c0 3.04 2.46 5.5 5.5 5.5s5.5-2.46 5.5-5.5V6h-1.5z"/>
            </svg>
          </button>
          <div class="textarea-wrapper">
            <textarea
              ref="inputRef"
              v-model="inputText"
              @input="handleInput"
              @keydown="handleKeydown"
              @paste="handlePaste"
              placeholder="输入消息... (@角色名 发送给指定角色，Shift+Enter 换行)"
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
          <button class="send-btn" @click="sendMessage" :disabled="!canSend" title="发送">
            <svg viewBox="0 0 24 24"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>
          </button>
        </div>
      </div>

        </div><!-- /crew-panel-center -->

        <!-- Right Panel: Feature Kanban -->
        <aside class="crew-panel-right">
          <div class="crew-panel-right-scroll">

            <!-- Feature Cards -->
            <div v-for="feature in featureKanban" :key="feature.taskId"
                 class="crew-feature-card"
                 :class="{
                   'is-expanded': isFeatureCardExpanded(feature.taskId),
                   'has-streaming': feature.hasStreaming,
                   'is-completed': feature.isCompleted
                 }">
              <!-- Header -->
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
              </div>

              <!-- Progress Bar -->
              <div class="crew-feature-card-bar">
                <div class="crew-feature-card-bar-fill"
                     :style="{ width: (feature.totalCount > 0 ? (feature.doneCount / feature.totalCount * 100) : 0) + '%' }">
                </div>
              </div>

              <!-- Active Roles -->
              <div v-if="feature.activeRoles.length > 0" class="crew-feature-card-roles">
                <span class="crew-feature-card-roles-icons">
                  <span v-for="ar in feature.activeRoles" :key="ar.role">{{ ar.roleIcon }}</span>
                </span>
                <span class="crew-feature-card-roles-label">工作中</span>
              </div>

              <!-- Todo Items (expanded) -->
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

              <!-- No todos: 显示简要状态 -->
              <div v-if="isFeatureCardExpanded(feature.taskId) && feature.todos.length === 0"
                   class="crew-feature-card-empty">
                {{ feature.isCompleted ? '已完成' : '进行中' }}
              </div>
            </div>

            <!-- Empty state -->
            <div v-if="featureKanban.length === 0" class="crew-kanban-empty">
              <div class="crew-kanban-empty-text">暂无 Feature</div>
            </div>
          </div>

          <!-- 总进度 (底部固定) -->
          <div class="crew-kanban-total" v-if="kanbanProgress.total > 0">
            <div class="crew-kanban-total-header">
              <span>总进度</span>
              <span>{{ kanbanProgress.done }} / {{ kanbanProgress.total }}  {{ Math.round(kanbanProgress.done / kanbanProgress.total * 100) }}%</span>
            </div>
            <div class="crew-kanban-total-bar">
              <div class="crew-kanban-total-fill"
                   :style="{ width: (kanbanProgress.done / kanbanProgress.total * 100) + '%' }"></div>
            </div>
          </div>

          <!-- 元信息 — 右栏底部横排 -->
          <div class="crew-session-meta" v-if="store.currentCrewStatus">
            <span class="crew-meta-item">R{{ store.currentCrewStatus.round || 0 }}</span>
            <span class="crew-meta-sep">&middot;</span>
            <span class="crew-meta-item">\${{ (store.currentCrewStatus.costUsd || 0).toFixed(2) }}</span>
            <span v-if="totalTokens > 0" class="crew-meta-sep">&middot;</span>
            <span v-if="totalTokens > 0" class="crew-meta-item">{{ formatTokens(totalTokens) }}</span>
            <span class="crew-meta-sep">&middot;</span>
            <span class="crew-meta-item" :class="statusClass">{{ statusText }}</span>
          </div>
        </aside>
      </div><!-- /crew-workspace -->

      <!-- Add Role Modal -->
      <div v-if="showAddRole" class="crew-add-role-overlay" @click.self="showAddRole = false">
        <div class="crew-add-role-modal">
          <div class="crew-add-role-title">添加角色</div>

          <!-- 一键添加预设 -->
          <div class="crew-add-role-presets">
            <button v-for="preset in availablePresets" :key="preset.name" class="crew-preset-btn" @click="quickAddPreset(preset)">
              <span v-if="preset.icon">{{ preset.icon }} </span>{{ preset.displayName }}
            </button>
          </div>

          <!-- 自定义角色（折叠） -->
          <details class="crew-add-custom-details">
            <summary class="crew-add-custom-summary">自定义角色</summary>
            <div class="crew-add-role-form">
              <div class="crew-add-role-row">
                <input v-model="newRole.name" placeholder="英文标识 (如 analyst)" class="crew-add-input" />
                <input v-model="newRole.displayName" placeholder="显示名称" class="crew-add-input" />
                <input v-model="newRole.icon" placeholder="图标" class="crew-add-input" style="width: 50px; flex: none;" />
              </div>
              <input v-model="newRole.description" placeholder="角色描述 (可选)" class="crew-add-input" />
              <textarea v-model="newRole.claudeMd" placeholder="自定义 Prompt (可选)" rows="2" class="crew-add-input"></textarea>
              <div class="crew-add-role-actions">
                <button class="crew-add-role-confirm" @click="confirmAddRole" :disabled="!newRole.name || !newRole.displayName">添加</button>
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
      roleMenuVisible: false,
      roleMenuTarget: null,
      roleMenuStyle: {},
      attachments: [],   // { file, name, preview?, uploading, fileId? }
      uploading: false,
      expandedTurns: {},
      expandedTodoGroups: {},
      expandedFeatures: {},
      expandedHistories: {},
      expandedFeatureCards: {},
      isAtBottom: true,
      visibleBlockCount: 20,
      isLoadingMore: false,
      crewAskSelections: {},
      crewAskCustom: {},
      atMenuVisible: false,
      atQuery: '',
      atMenuIndex: 0,
      newRole: this.getEmptyRole(),
      rolePresets: [
        {
          name: 'pm',
          displayName: 'PM-乔布斯',
          icon: '',
          description: '项目管理，需求分析，任务拆分和进度跟踪',
          model: 'sonnet',
          isDecisionMaker: true,
          claudeMd: `你是 Steve Jobs（史蒂夫·乔布斯），以他的思维方式和工作风格来管理这个项目。
追求极致简洁，对产品品质零容忍，善于从用户视角思考，敢于砍掉不必要的功能。

# 绝对禁令：工具使用限制
你**绝对不能**使用以下工具修改任何文件：
- Edit 工具 — 禁止
- Write 工具 — 禁止
- NotebookEdit 工具 — 禁止

你**可以**使用的工具：
- Read — 读取文件内容
- Grep — 搜索代码
- Glob — 查找文件
- Bash — 仅限 git 命令（git status/add/commit/push/tag/log/diff）和只读命令

如果你需要修改任何文件（无论多小的改动），必须 ROUTE 给 developer 执行。

# 工作方式
- 技术方案交给开发者自行设计和决策，不做微观管理
- 只关注需求是否满足、进度是否正常、质量是否达标
- 遇到跨角色协调问题时介入，其他时候让团队自主运转

# 工作约束
- 收到新任务后，先制定实施计划，然后 @human 请用户审核计划，审核通过后再分配执行。
- 收到包含多个独立任务的消息时，必须用多个 ROUTE 块一次性并行分配给不同的 dev，不要逐个处理。
- 分配任务时必须在 ROUTE 块中指定 task（唯一ID如 task-1）和 taskTitle（简短描述），用于消息按 feature 分组显示。
- PM 拥有 commit + push + tag 的自主权。测试全通过即可自行 commit/push/tag。`
        },
        {
          name: 'developer',
          displayName: '开发者-托瓦兹',
          icon: '',
          description: '代码编写、架构设计和功能实现',
          model: 'sonnet',
          isDecisionMaker: false,
          claudeMd: `你是一个全栈高级工程师，兼具架构设计能力和编码实现能力。
技术方案自己设计，代码自己写。追求简洁高效，厌恶不必要的抽象，注重实用主义。
遇到复杂任务时先分析现有代码，设计方案，再动手实现。不需要等别人给你设计文档。

# 协作流程
- 代码完成后，你必须同时发两个 ROUTE 块，分别交给审查者和测试者（缺一不可）：

---ROUTE---
to: reviewer
summary: 请审查代码变更...
---END_ROUTE---

---ROUTE---
to: tester
summary: 请测试以下变更...
---END_ROUTE---

- 多实例模式下，你会被分配到一个开发组，系统会自动告诉你搭档的 reviewer 和 tester 是谁
- 收到审查者的代码质量问题：修改后再次同时 ROUTE 给 reviewer + tester
- 收到测试者的 Bug 报告：修复后再次同时 ROUTE 给 reviewer + tester
- 两者都通过后，交给决策者汇总`
        },
        {
          name: 'reviewer',
          displayName: '审查者-马丁',
          icon: '',
          description: '代码审查和质量把控',
          model: 'sonnet',
          isDecisionMaker: false,
          claudeMd: `你是 Robert C. Martin（Uncle Bob），以他的 Clean Code 标准来审查代码。
像 Uncle Bob 一样：严格遵循整洁代码原则，关注命名、函数大小、单一职责，不放过任何代码坏味道，但给出建设性的改进建议。
你负责代码审查，区分必须修复的问题和改进建议。

# 协作流程
- 审核通过后，你必须 ROUTE 给决策者报告审核结果
- 发现问题则打回给开发者修改`
        },
        {
          name: 'tester',
          displayName: '测试-贝克',
          icon: '',
          description: '测试用例编写和质量验证',
          model: 'sonnet',
          isDecisionMaker: false,
          claudeMd: `你是 James Bach（詹姆斯·巴赫），以他的探索式测试理念来做质量保证。
像 James Bach 一样：不机械地写用例，而是像侦探一样思考，主动探索边界条件和异常场景，质疑每一个假设，追求发现真正有价值的 bug。
你负责测试策略、用例编写、自动化测试和测试报告。

# 协作流程
- 测试通过后，你必须 ROUTE 给决策者报告测试结果
- 发现 Bug 则交给开发者修复`
        },
        {
          name: 'designer',
          displayName: '设计师-拉姆斯',
          icon: '',
          description: '用户交互设计和页面视觉设计',
          model: 'sonnet',
          isDecisionMaker: false,
          claudeMd: `你是 Dieter Rams（迪特·拉姆斯），以他的设计十诫来指导设计工作。
像 Rams 一样：好的设计是创新的、实用的、美观的、易懂的、谦逊的、诚实的、经久的、注重细节的、环保的、尽可能少的。
你负责交互设计、视觉方案、用户体验优化。输出具体的设计方案（布局、颜色、间距、交互流程），而非抽象建议。`
        },
        {
          name: 'writer',
          displayName: '写作-Procida',
          icon: '',
          description: '技术文档和 API 文档编写',
          model: 'sonnet',
          isDecisionMaker: false,
          claudeMd: `你是 Daniele Procida（Diátaxis 框架创始人），以他的文档哲学来写技术文档。
像 Procida 一样：将文档分为教程、操作指南、参考和解释四种类型，每种有明确目的和写法，确保读者能快速找到需要的信息。
你负责编写清晰、结构化、面向读者的技术文档。`
        },
        {
          name: 'manager-musk',
          displayName: '管理者-马斯克',
          icon: '',
          description: '第一性原理思维，激进创新推动',
          model: 'sonnet',
          isDecisionMaker: false,
          claudeMd: `你是 Elon Musk（埃隆·马斯克），以第一性原理拆解问题，拒绝"行业惯例"的束缚。
像马斯克一样：设定看似不可能的目标，然后倒推实现路径；压缩时间线，并行推进多条战线；用物理学思维而非类比思维做决策。
你负责从根本上质疑假设，推动激进但可行的创新方案。`
        },
        {
          name: 'manager-grove',
          displayName: '管理者-格鲁夫',
          icon: '',
          description: '目标导向管理，危机应对决策',
          model: 'sonnet',
          isDecisionMaker: false,
          claudeMd: `你是 Andy Grove（安迪·格鲁夫），以偏执狂生存哲学管理项目。
像格鲁夫一样：只有偏执狂才能生存，识别战略转折点，用 OKR 驱动执行，在危机中果断决策。
你负责识别关键风险、设定可衡量目标、确保团队在正确的事情上保持高度聚焦。`
        },
        {
          name: 'developer-carmack',
          displayName: '开发者-卡马克',
          icon: '',
          description: '极致性能优化和底层编程',
          model: 'sonnet',
          isDecisionMaker: false,
          claudeMd: `你是 John Carmack（约翰·卡马克），以极致性能优化和底层系统编程见长。
像卡马克一样：每一个 CPU 周期都值得优化，深入理解硬件和底层原理，用最直接的方式解决问题，代码要快到不可思议。
你负责编写高性能代码，优化瓶颈，追求极致的执行效率。`
        },
        {
          name: 'developer-gosling',
          displayName: '开发者-高斯林',
          icon: '',
          description: '工程化设计和跨平台架构',
          model: 'sonnet',
          isDecisionMaker: false,
          claudeMd: `你是 James Gosling（詹姆斯·高斯林，Java之父），以工程化思维设计可靠系统。
像高斯林一样：Write Once Run Anywhere，重视类型安全和内存管理，设计简洁但严谨的 API，为大规模工程服务。
你负责设计可靠、可移植、易维护的系统架构和代码实现。`
        },
        {
          name: 'architect-knuth',
          displayName: '架构师-高德纳',
          icon: '',
          description: '算法分析和计算机科学理论',
          model: 'sonnet',
          isDecisionMaker: false,
          claudeMd: `你是 Donald Knuth（高德纳），以严谨的计算机科学理论和算法分析指导工程决策。
像高德纳一样：过早优化是万恶之源，但成熟的算法选择是智慧之始；用数学证明正确性，用 Literate Programming 让代码自文档化。
你负责算法设计、复杂度分析和计算理论层面的技术决策。`
        },
        {
          name: 'designer-norman',
          displayName: '设计师-诺曼',
          icon: '',
          description: '用户中心设计和认知心理学',
          model: 'sonnet',
          isDecisionMaker: false,
          claudeMd: `你是 Don Norman（唐·诺曼），以认知心理学和用户中心设计理念指导产品设计。
像诺曼一样：好的设计让人一看就懂，差的设计需要说明书；关注 affordance（功能可见性）、feedback（反馈）和 mapping（映射）三大原则。
你负责从认知科学角度审视交互设计，确保产品符合用户心智模型。`
        },
        {
          name: 'tester-beck',
          displayName: '测试-肯特贝克',
          icon: '',
          description: '测试驱动开发和极限编程',
          model: 'sonnet',
          isDecisionMaker: false,
          claudeMd: `你是 Kent Beck（肯特·贝克，TDD之父），以测试驱动开发和极限编程方法论指导质量保证。
像贝克一样：红-绿-重构，先写失败的测试再写让它通过的代码；小步前进，频繁反馈，简单设计，勇敢重构。
你负责设计测试策略，编写测试用例，用 TDD 循环驱动高质量代码。`
        },
        {
          name: 'researcher-feynman',
          displayName: '研究员-费曼',
          icon: '',
          description: '第一性原理分析和深入浅出解释',
          model: 'sonnet',
          isDecisionMaker: false,
          claudeMd: `你是 Richard Feynman（理查德·费曼），以好奇心驱动的第一性原理思考来研究问题。
像费曼一样：如果你不能用简单的语言解释它，说明你还没有真正理解它；拒绝权威崇拜，拆解到最基本的原理重新构建理解。
你负责深度研究、分析复杂问题本质，并用通俗易懂的方式呈现结论。`
        },
        {
          name: 'strategist-munger',
          displayName: '策略师-芒格',
          icon: '',
          description: '多元思维模型和跨学科分析',
          model: 'sonnet',
          isDecisionMaker: false,
          claudeMd: `你是 Charlie Munger（查理·芒格），以多元思维模型和逆向思考来做战略分析。
像芒格一样：手里只有锤子的人看什么都是钉子，所以要掌握多个学科的核心模型；先想怎么会失败，再想怎么能成功。
你负责跨学科视角分析问题，识别认知偏差，提供反直觉但深刻的战略建议。`
        },
        {
          name: 'strategist-buffett',
          displayName: '策略师-巴菲特',
          icon: '',
          description: '价值投资和长期主义',
          model: 'sonnet',
          isDecisionMaker: false,
          claudeMd: `你是 Warren Buffett（沃伦·巴菲特），以护城河理论和安全边际原则来评估决策。
像巴菲特一样：别人贪婪时恐惧，别人恐惧时贪婪；寻找有持久竞争优势的标的，用合理价格买入优质资产，耐心持有。
你负责长期价值评估、风险收益分析和投资策略制定。`
        },
        {
          name: 'analyst-simons',
          displayName: '分析师-西蒙斯',
          icon: '',
          description: '量化模型和数据驱动决策',
          model: 'sonnet',
          isDecisionMaker: false,
          claudeMd: `你是 Jim Simons（吉姆·西蒙斯），以数学模型和统计套利方法来分析市场。
像西蒙斯一样：用数据说话而非凭直觉，寻找隐藏在噪声中的信号，构建可回测的量化模型，纪律性地执行策略。
你负责数据分析、量化建模、统计检验和数据驱动的决策支持。`
        },
        {
          name: 'writer-orwell',
          displayName: '写作-奥威尔',
          icon: '',
          description: '简洁有力的写作风格',
          model: 'sonnet',
          isDecisionMaker: false,
          claudeMd: `你是 George Orwell（乔治·奥威尔），以简洁、清晰、有力的写作六规则来创作文本。
像奥威尔一样：能用短词不用长词，能删的词一定删，能用主动语态不用被动语态，绝不用行话糊弄读者。
你负责撰写简洁有力、直击要害的文案、报告和分析文本。`
        },
        {
          name: 'strategist-sunzi',
          displayName: '策略师-孙子',
          icon: '',
          description: '兵法策略和博弈思维',
          model: 'sonnet',
          isDecisionMaker: false,
          claudeMd: `你是孙武（孙子），以孙子兵法的战略思维来分析竞争态势和制定策略。
像孙子一样：知己知彼百战不殆，上兵伐谋其次伐交，不战而屈人之兵善之善者也。兵无常势水无常形，因敌变化而取胜。
你负责竞争分析、博弈推演、战略规划和风险评估。`
        }
      ]
    };
  },

  computed: {
    statusText() {
      const status = this.store.currentCrewStatus?.status;
      if (status === 'running') return '运行中';
      if (status === 'paused') return '已暂停';
      if (status === 'waiting_human') return '等待人工';
      if (status === 'completed') return '已完成';
      if (status === 'stopped') return '已停止';
      if (status === 'max_rounds_reached') return '达到上限';
      return '初始化';
    },
    statusClass() {
      const status = this.store.currentCrewStatus?.status;
      return {
        'status-running': status === 'running',
        'status-paused': status === 'paused',
        'status-waiting': status === 'waiting_human',
        'status-completed': status === 'completed',
        'status-stopped': status === 'stopped'
      };
    },
    hasStreamingMessage() {
      return this.store.currentCrewMessages.some(m => m._streaming);
    },
    activeToolHint() {
      const tools = this.store.currentCrewStatus?.currentToolByRole;
      if (!tools) return '';
      const entries = Object.entries(tools);
      if (entries.length === 0) return '';
      const [role, tool] = entries[0];
      return `${tool}...`;
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
      const messages = this.store.currentCrewMessages;
      let tasks = [];
      // Scan messages in order; later TASKS blocks override earlier ones
      for (const msg of messages) {
        if (msg.type !== 'text' || !msg.content) continue;
        const match = msg.content.match(/---TASKS---([\s\S]*?)---END_TASKS---/);
        if (!match) continue;
        const block = match[1].trim();
        const parsed = [];
        for (const line of block.split('\n')) {
          const m = line.match(/^-\s*\[([ xX])\]\s*(.+)/);
          if (!m) continue;
          const done = m[1] !== ' ';
          let text = m[2].trim();
          let assignee = null;
          const atMatch = text.match(/@(\w+)\s*$/);
          if (atMatch) {
            assignee = atMatch[1];
            text = text.replace(/@\w+\s*$/, '').trim();
          }
          parsed.push({ done, text, assignee });
        }
        if (parsed.length > 0) tasks = parsed;
      }
      return tasks;
    },
    completedTaskCount() {
      return this.crewTasks.filter(t => t.done).length;
    },
    pendingTasks() {
      return this.crewTasks.filter(t => !t.done);
    },
    doneTasks() {
      return this.crewTasks.filter(t => t.done);
    },
    completedTaskIds() {
      // Match done crewTasks (text) to activeTasks (title) to get taskIds
      const ids = new Set();
      const done = this.doneTasks;
      if (done.length === 0) return ids;
      for (const task of done) {
        const t = task.text.toLowerCase();
        for (const at of this.activeTasks) {
          const title = at.title.toLowerCase();
          if (t.includes(title) || title.includes(t)) {
            ids.add(at.id);
          }
        }
      }
      return ids;
    },
    taskProgress() {
      if (this.crewTasks.length === 0) return 0;
      return Math.round((this.completedTaskCount / this.crewTasks.length) * 100);
    },
    activeTasks() {
      // 从消息中收集所有出现过的 taskId/taskTitle
      const taskMap = new Map();
      for (const msg of this.store.currentCrewMessages) {
        if (msg.taskId && msg.taskTitle) {
          taskMap.set(msg.taskId, msg.taskTitle);
        }
      }
      return Array.from(taskMap, ([id, title]) => ({ id, title }));
    },
    activeRolesTasks() {
      // 找出当前活跃角色（正在 streaming 的）及其 task
      const active = [];
      const messages = this.store.currentCrewMessages;
      const seen = new Set();
      for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        if (m._streaming && m.role && !seen.has(m.role)) {
          seen.add(m.role);
          active.push({
            role: m.role,
            roleName: m.roleName,
            roleIcon: m.roleIcon,
            taskTitle: m.taskTitle
          });
        }
      }
      return active;
    },
    featureBlocks() {
      const allMessages = this.store.currentCrewMessages;
      const completed = this.completedTaskIds;

      // Step 1: Split messages into segments by taskId continuity
      // Messages with the same taskId that appear consecutively are grouped.
      // Messages without taskId (or structural messages like route/system) go to 'global'.
      const segments = [];
      let currentSegment = null;

      const flushSegment = () => {
        if (currentSegment && currentSegment.messages.length > 0) {
          segments.push(currentSegment);
        }
        currentSegment = null;
      };

      for (const msg of allMessages) {
        const taskId = msg.taskId || null;
        // Human messages, system messages, and messages without taskId go to global
        const isGlobal = !taskId || msg.role === 'human';

        if (isGlobal) {
          // If current segment is a feature, flush it
          if (currentSegment && currentSegment.taskId) {
            flushSegment();
          }
          // Append to current global segment or create one
          if (!currentSegment || currentSegment.taskId) {
            flushSegment();
            currentSegment = { taskId: null, messages: [] };
          }
          currentSegment.messages.push(msg);
        } else {
          // Feature message
          if (currentSegment && currentSegment.taskId === taskId) {
            currentSegment.messages.push(msg);
          } else {
            flushSegment();
            currentSegment = { taskId, messages: [msg] };
          }
        }
      }
      flushSegment();

      // Step 2: Convert segments to blocks with turns
      const blocks = [];
      let blockCounter = 0;
      for (const seg of segments) {
        const turns = this._buildTurns(seg.messages);
        if (seg.taskId) {
          // Feature block
          const taskTitle = seg.messages.find(m => m.taskTitle)?.taskTitle || seg.taskId;
          const isCompleted = completed.has(seg.taskId);
          const hasStreaming = seg.messages.some(m => m._streaming);
          // Active roles: roles currently streaming in this feature
          const activeRoles = [];
          const seenRoles = new Set();
          for (let i = seg.messages.length - 1; i >= 0; i--) {
            const m = seg.messages[i];
            if (m._streaming && m.role && !seenRoles.has(m.role)) {
              seenRoles.add(m.role);
              activeRoles.push({ role: m.role, roleName: m.roleName, roleIcon: m.roleIcon });
            }
          }
          const hasPendingAsk = turns.some(t =>
            t.askMsg && !this.isCrewAskAnswered(t.askMsg)
          );
          blocks.push({
            type: 'feature',
            taskId: seg.taskId,
            taskTitle,
            turns,
            isCompleted,
            hasStreaming,
            activeRoles,
            hasPendingAsk,
            id: 'feature_' + seg.taskId + '_' + (blockCounter++)
          });
        } else {
          // Global block
          blocks.push({
            type: 'global',
            turns,
            id: 'global_' + (blockCounter++)
          });
        }
      }
      return blocks;
    },

    visibleBlocks() {
      const all = this.featureBlocks;
      if (all.length <= this.visibleBlockCount) return all;
      return all.slice(all.length - this.visibleBlockCount);
    },

    hiddenBlockCount() {
      return Math.max(0, this.featureBlocks.length - this.visibleBlockCount);
    },

    pendingAsks() {
      const asks = [];
      for (const block of this.featureBlocks) {
        if (block.type !== 'feature') continue;
        for (const turn of block.turns) {
          if (turn.askMsg && !this.isCrewAskAnswered(turn.askMsg)) {
            asks.push({
              blockId: block.id,
              taskId: block.taskId,
              taskTitle: block.taskTitle,
              roleIcon: turn.roleIcon || turn.askMsg.roleIcon,
              roleName: turn.roleName || turn.askMsg.roleName,
              question: this.getCrewAskQuestions(turn.askMsg)?.[0]?.question || 'Question',
              askMsg: turn.askMsg,
            });
          }
        }
      }
      return asks;
    },

    todosByFeature() {
      const messages = this.store.currentCrewMessages;
      if (!messages) return [];

      // Phase 1: 收集所有 TodoWrite 消息，按 (taskId, role) 分组
      const historyMap = new Map();
      const latestMap = new Map();

      for (const m of messages) {
        if (m.type !== 'tool' || m.toolName !== 'TodoWrite' || !m.toolInput?.todos) continue;
        const key = `${m.taskId || 'global'}::${m.role}`;

        if (!historyMap.has(key)) historyMap.set(key, []);
        historyMap.get(key).push({ timestamp: m.timestamp, todos: m.toolInput.todos });

        latestMap.set(key, {
          taskId: m.taskId || null,
          taskTitle: m.taskTitle || null,
          role: m.role, roleIcon: m.roleIcon, roleName: m.roleName,
          todos: m.toolInput.todos,
          timestamp: m.timestamp,
        });
      }

      // Phase 2: 为每个 in_progress todo 推算 startedAt
      for (const [key, entry] of latestMap) {
        const history = historyMap.get(key) || [];
        entry.todos = entry.todos.map(todo => {
          if (todo.status !== 'in_progress') return todo;
          let startedAt = entry.timestamp;
          for (const snapshot of history) {
            const match = snapshot.todos.find(t => t.content === todo.content);
            if (match && match.status === 'in_progress') {
              startedAt = snapshot.timestamp;
              break;
            }
          }
          return { ...todo, startedAt };
        });
      }

      // Phase 3: 转为数组，按 taskId 分组
      const groups = new Map();
      for (const entry of latestMap.values()) {
        const tid = entry.taskId || '_global';
        if (!groups.has(tid)) {
          groups.set(tid, { taskId: entry.taskId, taskTitle: entry.taskTitle, entries: [] });
        }
        groups.get(tid).entries.push(entry);
      }

      // 过滤掉所有 todo 都已完成的分组
      const result = [];
      for (const group of groups.values()) {
        const allDone = group.entries.every(e => e.todos.every(t => t.status === 'completed'));
        if (!allDone) result.push(group);
      }
      return result;
    },

    todoTotalProgress() {
      let total = 0, done = 0;
      for (const group of this.todosByFeature) {
        for (const entry of group.entries) {
          total += entry.todos.length;
          done += entry.todos.filter(t => t.status === 'completed').length;
        }
      }
      return { total, done };
    },

    sessionRoles() {
      return this.store.currentCrewSession?.roles || [];
    },

    featureKanban() {
      // 1. 收集所有 feature
      const features = new Map();

      // 从 activeTasks 获取所有 feature
      for (const task of this.activeTasks) {
        features.set(task.id, {
          taskId: task.id,
          taskTitle: task.title,
          todos: [],
          doneCount: 0,
          totalCount: 0,
          activeRoles: [],
          isCompleted: this.completedTaskIds.has(task.id),
          hasStreaming: false,
        });
      }

      // 2. 合并 todosByFeature 的 todo 数据
      for (const group of this.todosByFeature) {
        const tid = group.taskId || '_global';
        let feature = features.get(tid);
        if (!feature) {
          feature = {
            taskId: tid,
            taskTitle: group.taskTitle || '全局任务',
            todos: [],
            doneCount: 0,
            totalCount: 0,
            activeRoles: [],
            isCompleted: false,
            hasStreaming: false,
          };
          features.set(tid, feature);
        }
        for (const entry of group.entries) {
          for (const todo of entry.todos) {
            feature.todos.push({
              ...todo,
              roleIcon: entry.roleIcon,
              roleName: entry.roleName,
              id: `${tid}_${entry.role}_${feature.todos.length}`
            });
            feature.totalCount++;
            if (todo.status === 'completed') feature.doneCount++;
          }
        }
      }

      // 3. 合并 featureBlocks 的活跃角色数据
      for (const block of this.featureBlocks) {
        if (block.type !== 'feature') continue;
        const feature = features.get(block.taskId);
        if (feature) {
          if (block.activeRoles) feature.activeRoles = block.activeRoles;
          if (block.hasStreaming) feature.hasStreaming = true;
        }
      }

      // 4. 转为数组，排序：有活跃的在前，已完成的在后
      return Array.from(features.values()).sort((a, b) => {
        if (a.hasStreaming !== b.hasStreaming) return a.hasStreaming ? -1 : 1;
        if (a.isCompleted !== b.isCompleted) return a.isCompleted ? 1 : -1;
        return 0;
      });
    },

    kanbanProgress() {
      let total = 0, done = 0;
      for (const f of this.featureKanban) {
        total += f.totalCount;
        done += f.doneCount;
      }
      return { total, done };
    }
  },

  watch: {
    'store.currentConversation'() {
      this.visibleBlockCount = 20;
      this.$nextTick(() => {
        setTimeout(() => this.scrollToMeaningfulContent(), 300);
      });
    },
    'store.currentCrewMessages': {
      handler() {
        this.$nextTick(() => this.smartScrollToBottom());
      },
      deep: true
    }
  },

  methods: {
    getEmptyRole() {
      return { name: '', displayName: '', icon: '\u{1F916}', description: '', model: 'sonnet', claudeMd: '', isDecisionMaker: false };
    },

    formatTime(ts) {
      if (!ts) return '';
      const d = new Date(ts);
      return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    },

    formatTokens(n) {
      if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
      if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
      return String(n);
    },

    mdRender: renderMarkdown,

    toggleTurn(turnId) {
      this.expandedTurns[turnId] = !this.expandedTurns[turnId];
    },

    getMaxRound(turn) {
      if (!turn.routeMsgs || turn.routeMsgs.length === 0) return 0;
      let max = 0;
      for (const rm of turn.routeMsgs) {
        if (rm.round > max) max = rm.round;
      }
      return max;
    },

    toggleFeature(taskId) {
      this.expandedFeatures[taskId] = !this.expandedFeatures[taskId];
    },

    toggleTodoGroup(taskId) {
      const key = taskId || '_global';
      this.expandedTodoGroups[key] = !(key in this.expandedTodoGroups ? this.expandedTodoGroups[key] : true);
    },

    isTodoGroupExpanded(taskId) {
      const key = taskId || '_global';
      if (!(key in this.expandedTodoGroups)) {
        return true;
      }
      return this.expandedTodoGroups[key];
    },

    groupDoneCount(group) {
      let count = 0;
      for (const entry of group.entries) {
        count += entry.todos.filter(t => t.status === 'completed').length;
      }
      return count;
    },

    groupTotalCount(group) {
      let count = 0;
      for (const entry of group.entries) {
        count += entry.todos.length;
      }
      return count;
    },

    toggleHistory(taskId) {
      this.expandedHistories[taskId] = !this.expandedHistories[taskId];
    },

    isFeatureExpanded(block) {
      // If manually toggled, use that state
      if (block.taskId in this.expandedFeatures) {
        return this.expandedFeatures[block.taskId];
      }
      // Has pending ask → force expand
      if (block.hasPendingAsk) return true;
      // Streaming → expand
      if (block.hasStreaming) return true;
      // Not completed → expand
      if (!block.isCompleted) return true;
      // Completed: expand last 2 feature blocks, collapse earlier ones
      const featureOnly = this.featureBlocks.filter(b => b.type === 'feature');
      const idx = featureOnly.findIndex(b => b.id === block.id);
      const fromEnd = featureOnly.length - 1 - idx;
      return fromEnd < 2;
    },

    shouldShowTurnDivider(turns, tidx) {
      const prev = turns[tidx - 1];
      const curr = turns[tidx];
      const prevRole = prev.type === 'turn' ? prev.role : prev.message?.role;
      const currRole = curr.type === 'turn' ? curr.role : curr.message?.role;
      return prevRole && currRole && prevRole !== currRole;
    },

    _buildTurns(messages) {
      const turns = [];
      let currentTurn = null;
      let turnCounter = 0;

      const flushTurn = () => {
        if (currentTurn) {
          const textMsgs = currentTurn.messages.filter(m => m.type === 'text');
          if (textMsgs.length > 1) {
            currentTurn.textMsg = { ...textMsgs[0], content: textMsgs.map(m => m.content).join('') };
          } else {
            currentTurn.textMsg = textMsgs[0] || null;
          }
          currentTurn.toolMsgs = currentTurn.messages.filter(m => m.type === 'tool');
          currentTurn.routeMsgs = currentTurn.messages.filter(m => m.type === 'route');
          currentTurn.imageMsgs = currentTurn.messages.filter(m => m.type === 'image');
          // Extract AskUserQuestion from toolMsgs into askMsg
          const askIdx = currentTurn.toolMsgs.findIndex(m => m.toolName === 'AskUserQuestion');
          if (askIdx !== -1) {
            currentTurn.askMsg = currentTurn.toolMsgs[askIdx];
            currentTurn.toolMsgs = currentTurn.toolMsgs.filter((_, i) => i !== askIdx);
          } else {
            currentTurn.askMsg = null;
          }
          turns.push(currentTurn);
          currentTurn = null;
        }
      };

      for (const msg of messages) {
        if (msg.type === 'system' || msg.type === 'human_needed' || msg.type === 'role_error') {
          flushTurn();
          turns.push({ type: msg.type, message: msg, id: 'standalone_' + (msg.id || turnCounter++) });
          continue;
        }
        if (msg.type === 'route') {
          // Merge route into current turn if same role
          if (currentTurn && currentTurn.role === msg.role) {
            currentTurn.messages.push(msg);
          } else {
            flushTurn();
            currentTurn = {
              type: 'turn',
              role: msg.role,
              roleName: msg.roleName,
              roleIcon: msg.roleIcon,
              messages: [msg],
              textMsg: null,
              toolMsgs: [],
              routeMsgs: [],
              imageMsgs: [],
              id: 'turn_' + (turnCounter++)
            };
          }
          continue;
        }
        if (msg.role === 'human') {
          flushTurn();
          turns.push({ type: 'text', message: msg, id: 'human_' + (msg.id || turnCounter++) });
          continue;
        }
        if (currentTurn && currentTurn.role === msg.role) {
          currentTurn.messages.push(msg);
        } else {
          flushTurn();
          currentTurn = {
            type: 'turn',
            role: msg.role,
            roleName: msg.roleName,
            roleIcon: msg.roleIcon,
            messages: [msg],
            textMsg: null,
            toolMsgs: [],
            routeMsgs: [],
            imageMsgs: [],
            id: 'turn_' + (turnCounter++)
          };
        }
      }
      flushTurn();
      return turns;
    },

    getRoleIcon(roleName) {
      const session = this.store.currentCrewSession;
      if (!session) return '';
      const role = session.roles.find(r => r.name === roleName);
      return role ? role.icon : '';
    },

    getRoleDisplayName(roleName) {
      const session = this.store.currentCrewSession;
      if (!session) return roleName;
      const role = session.roles.find(r => r.name === roleName);
      return role ? role.displayName : roleName;
    },

    shortName(displayName) {
      if (!displayName) return '';
      const idx = displayName.indexOf('-');
      return idx > 0 ? displayName.substring(idx + 1) : displayName;
    },

    getImageUrl(msg) {
      if (!msg.fileId) return '';
      const token = msg.previewToken || '';
      return `/api/preview/${msg.fileId}?token=${token}`;
    },

    handleImageError(event) {
      const img = event.target;
      const expired = document.createElement('div');
      expired.className = 'crew-screenshot-expired';
      expired.textContent = '图片已过期';
      img.parentNode.replaceChild(expired, img);
    },

    openImagePreview(src) {
      window.open(src, '_blank');
    },

    getRoleStyle(roleName) {
      if (PRESET_ROLES.includes(roleName)) {
        return {
          '--role-color': `var(--crew-color-${roleName})`,
          '--role-bg': `var(--crew-color-${roleName}-bg)`,
          '--role-border': `var(--crew-color-${roleName}-border)`,
          '--role-bg-glow': `var(--crew-color-${roleName}-bg-glow)`
        };
      }
      // Dynamic role: hash name to pick a fallback color
      const hash = roleName.split('').reduce((h, c) => (h * 31 + c.charCodeAt(0)) & 0xff, 0);
      const idx = hash % 4;
      return {
        '--role-color': `var(--crew-color-fallback-${idx})`,
        '--role-bg': `var(--crew-color-fallback-${idx}-bg)`,
        '--role-border': `var(--crew-color-fallback-${idx}-border)`,
        '--role-bg-glow': `var(--crew-color-fallback-${idx}-bg-glow)`
      };
    },

    getTaskColor(taskId) {
      if (!taskId) return {};
      const TASK_COLORS = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#06b6d4', '#84cc16'];
      const hash = taskId.split('').reduce((h, c) => (h * 31 + c.charCodeAt(0)) & 0xff, 0);
      const color = TASK_COLORS[hash % TASK_COLORS.length];
      return { '--task-color': color };
    },

    getRoleTaskTitle(roleName) {
      // 找该角色最后一条带 taskTitle 的消息
      const messages = this.store.currentCrewMessages;
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === roleName && messages[i].taskTitle) {
          return messages[i].taskTitle;
        }
      }
      return null;
    },

    getRoleBadgeTitle(role) {
      const tools = this.store.currentCrewStatus?.currentToolByRole;
      let title = role.displayName + (role.isDecisionMaker ? ' (决策者)' : '');
      if (tools?.[role.name]) {
        title += ` — ${tools[role.name]}`;
      }
      return title;
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
        if (messages[i].role === roleName && messages[i].taskTitle) {
          return messages[i].taskTitle;
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
      // Default: expand if has in_progress todos or not completed
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

    handleInput() {
      this.autoResize();
      // Detect @ trigger for autocomplete
      const textarea = this.$refs.inputRef;
      if (!textarea) return;
      const pos = textarea.selectionStart;
      const text = this.inputText;
      // Find the last @ before cursor
      const beforeCursor = text.substring(0, pos);
      const atIdx = beforeCursor.lastIndexOf('@');
      if (atIdx >= 0 && (atIdx === 0 || /\s/.test(beforeCursor[atIdx - 1]))) {
        const query = beforeCursor.substring(atIdx + 1);
        // Only show if query has no spaces (still typing the name)
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
          const newPos = atIdx + role.displayName.length + 2; // @ + displayName + space
          textarea.selectionStart = textarea.selectionEnd = newPos;
          textarea.focus();
        });
      }
      this.atMenuVisible = false;
    },

    insertAt(roleName) {
      const displayName = this.getRoleDisplayName(roleName);
      const mention = `@${displayName} `;
      if (this.inputText) {
        this.inputText = this.inputText.trimEnd() + ' ' + mention;
      } else {
        this.inputText = mention;
      }
      this.$refs.inputRef?.focus();
    },

    autoResize() {
      const textarea = this.$refs.inputRef;
      if (textarea) {
        textarea.style.height = 'auto';
        textarea.style.height = Math.min(textarea.scrollHeight, 120) + 'px';
      }
    },

    handleKeydown(e) {
      // @ menu navigation
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

    triggerFileSelect(e) {
      e?.preventDefault();
      e?.stopPropagation();
      this.$refs.fileInput?.click();
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

      this.store.sendCrewMessage(text, null, attachmentInfos.length > 0 ? attachmentInfos : undefined);
      this.inputText = '';
      this.attachments = [];
      delete this.store.inputDrafts[this.store.currentConversation];
      if (this.$refs.inputRef) this.$refs.inputRef.style.height = 'auto';
      this.isAtBottom = true;
      this.$nextTick(() => this.scrollToBottom());
    },

    controlAction(action, targetRole = null) {
      this.controlOpen = false;
      if (action === 'clear') {
        if (!confirm('确定要清空所有对话？角色配置将保留，但所有对话历史将被重置。')) return;
      }
      this.store.sendCrewControl(action, targetRole);
    },

    openRoleMenu(event, role) {
      this.roleMenuTarget = role;
      this.roleMenuStyle = { left: event.clientX + 'px', top: event.clientY + 'px' };
      this.roleMenuVisible = true;
    },

    removeRole(roleName) {
      this.roleMenuVisible = false;
      if (!roleName) return;
      if (!confirm(`确定要移除 ${roleName}？角色的 Memory 将保留。`)) return;
      this.store.removeCrewRole(roleName);
    },

    quickAddPreset(preset) {
      this.store.addCrewRole({ ...preset });
      // If no more presets available, close the modal
      if (this.availablePresets.length <= 1) {
        this.showAddRole = false;
      }
    },

    applyPreset(preset) {
      const existing = this.store.currentCrewSession?.roles?.find(r => r.name === preset.name);
      if (existing) {
        this.newRole = { ...preset, name: preset.name + '2', displayName: preset.displayName + '2' };
      } else {
        this.newRole = { ...preset };
      }
    },

    confirmAddRole() {
      if (!this.newRole.name || !this.newRole.displayName) return;
      this.store.addCrewRole({ ...this.newRole });
      this.showAddRole = false;
      this.newRole = this.getEmptyRole();
    },

    // -- AskUserQuestion card methods --
    isCrewAskAnswered(askMsg) {
      return !!askMsg.askAnswered;
    },
    getCrewAskQuestions(askMsg) {
      const input = askMsg.toolInput || {};
      return input.questions || askMsg.askQuestions || [];
    },
    isCrewOptSelected(msgId, question, label) {
      return this.crewAskSelections[msgId + ':' + question] === label;
    },
    selectCrewOpt(msgId, q, opt) {
      this.crewAskSelections[msgId + ':' + q.question] = opt.label;
      this.crewAskCustom[msgId + ':' + q.question] = '';
    },
    setCrewAskCustom(msgId, question, value) {
      this.crewAskCustom[msgId + ':' + question] = value;
      if (value) this.crewAskSelections[msgId + ':' + question] = '';
    },
    hasCrewAskSelection(askMsg) {
      const questions = this.getCrewAskQuestions(askMsg);
      return questions.some(q => {
        const key = askMsg.id + ':' + q.question;
        return this.crewAskSelections[key] || this.crewAskCustom[key];
      });
    },
    getCrewAskAnswer(askMsg, question) {
      const answers = askMsg.selectedAnswers;
      if (!answers) return '-';
      return answers[question] || '-';
    },
    submitCrewAsk(askMsg) {
      if (askMsg.askAnswered || !this.hasCrewAskSelection(askMsg)) return;
      const questions = this.getCrewAskQuestions(askMsg);
      const answers = {};
      for (const q of questions) {
        const key = askMsg.id + ':' + q.question;
        const custom = this.crewAskCustom[key];
        if (custom) {
          answers[q.question] = custom;
        } else {
          const sel = this.crewAskSelections[key];
          if (sel) answers[q.question] = sel;
        }
      }
      const requestId = askMsg.askRequestId;
      if (!requestId) return;
      this.store.answerUserQuestion(requestId, answers);
      askMsg.askAnswered = true;
      askMsg.selectedAnswers = answers;
    },

    scrollToAsk(ask) {
      this.expandedFeatures[ask.taskId] = true;
      this.expandedHistories[ask.taskId] = true;
      this.$nextTick(() => {
        const el = this.$el.querySelector(
          `.crew-ask-card[data-ask-id="${ask.askMsg.id}"]`
        );
        if (el) {
          el.scrollIntoView({ behavior: 'smooth', block: 'center' });
          el.classList.add('crew-ask-highlight');
          setTimeout(() => el.classList.remove('crew-ask-highlight'), 2000);
        }
      });
    },

    scrollToBlock(block) {
      const el = this.$el.querySelector(`[data-block-id="${block.id}"]`);
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    },

    scrollToMeaningfulContent() {
      this.$nextTick(() => {
        if (this.pendingAsks.length > 0) {
          this.scrollToAsk(this.pendingAsks[0]);
          return;
        }
        const lastActive = [...this.featureBlocks]
          .reverse()
          .find(b => b.type === 'feature' && !b.isCompleted);
        if (lastActive) {
          this.scrollToBlock(lastActive);
          return;
        }
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
      // 接近顶部时自动加载更多
      const scrollEl = this.$refs.messagesRef;
      if (scrollEl && scrollEl.scrollTop < 100 && this.hiddenBlockCount > 0) {
        this.loadMoreBlocks();
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
      this.roleMenuVisible = false;
    };
    document.addEventListener('click', closeMenus);
    this._cleanupClick = closeMenus;
    // 恢复草稿
    const convId = this.store.currentConversation;
    if (convId && this.store.inputDrafts[convId]) {
      this.inputText = this.store.inputDrafts[convId];
    }
    this.$nextTick(() => this.scrollToBottom());
  },

  beforeUnmount() {
    if (this._cleanupClick) {
      document.removeEventListener('click', this._cleanupClick);
    }
    // 保存草稿
    const convId = this.store.currentConversation;
    if (convId && this.inputText) {
      this.store.inputDrafts[convId] = this.inputText;
    }
  }
};
