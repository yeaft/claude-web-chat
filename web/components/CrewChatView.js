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
        <div class="crew-role-menu-header">{{ roleMenuTarget?.icon }} {{ roleMenuTarget?.displayName }}</div>
        <button class="crew-role-menu-item" @click="removeRole(roleMenuTarget?.name)">
          <span class="crew-control-icon" v-html="icons.trash"></span> 移除
        </button>
      </div>

      <!-- Messages -->
      <div class="crew-messages" ref="messagesRef">
        <!-- Task Panel -->
        <div v-if="crewTasks.length > 0" class="crew-task-panel" :class="{ collapsed: taskPanelCollapsed }">
          <div class="crew-task-header" @click="taskPanelCollapsed = !taskPanelCollapsed">
            <span class="crew-task-title">任务清单 ({{ completedTaskCount }}/{{ crewTasks.length }})</span>
            <span class="crew-task-progress">
              <span class="crew-task-bar"><span class="crew-task-bar-fill" :style="{ width: taskProgress + '%' }"></span></span>
            </span>
            <svg v-if="taskPanelCollapsed" viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M7 10l5 5 5-5z"/></svg>
            <svg v-else viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M7 14l5-5 5 5z"/></svg>
          </div>
          <div v-if="!taskPanelCollapsed" class="crew-task-list">
            <div v-for="(task, idx) in crewTasks" :key="idx" class="crew-task-item" :class="{ done: task.done }">
              <span class="crew-task-check">{{ task.done ? '\u2705' : '\u2B1C' }}</span>
              <span class="crew-task-text">{{ task.text }}</span>
              <span v-if="task.assignee" class="crew-task-assignee" :style="getRoleStyle(task.assignee)">@{{ task.assignee }}</span>
            </div>
          </div>
        </div>

        <div v-if="store.currentCrewMessages.length === 0" class="crew-empty">
          <div class="crew-empty-icon" v-html="icons.crew.replace(/16/g, '48')"></div>
          <div class="crew-empty-text" v-if="store.currentCrewSession">等待角色开始工作...</div>
          <div class="crew-empty-text" v-else>等待 Crew Session 启动...</div>
        </div>

        <template v-for="(turn, tidx) in groupedMessages" :key="turn.id">
          <!-- Turn divider: when role changes between adjacent turns -->
          <div v-if="tidx > 0 && shouldShowDivider(tidx)" class="crew-turn-divider"></div>

          <!-- Round Divider -->
          <div v-if="turn.type === 'route' && turn.message.round > 0" class="crew-round-divider">
            <div class="crew-round-line"></div>
            <span class="crew-round-label">Round {{ turn.message.round }}</span>
            <div class="crew-round-line"></div>
          </div>

          <!-- Standalone messages (route, system, human_needed, human text) -->
          <div v-if="turn.type !== 'turn'" class="crew-message" :class="['crew-msg-' + (turn.message.type), 'crew-role-' + (turn.message.role), { 'crew-msg-human-bubble': turn.message.role === 'human' && turn.message.type === 'text' }]" :style="getRoleStyle(turn.message.role)">
            <div v-if="turn.message.role !== 'human' || turn.message.type !== 'text'" class="crew-msg-avatar">
              <span class="crew-msg-icon">{{ turn.message.roleIcon }}</span>
            </div>
            <div class="crew-msg-body">
              <div class="crew-msg-header">
                <span class="crew-msg-name" :class="{ 'is-human': turn.message.role === 'human', 'is-system': turn.message.role === 'system' }">{{ turn.message.roleName }}</span>
                <span class="crew-msg-time">{{ formatTime(turn.message.timestamp) }}</span>
              </div>
              <div v-if="turn.message.type === 'route'" class="crew-msg-route">{{ turn.message.content }}</div>
              <div v-else-if="turn.message.type === 'system'" class="crew-msg-system">{{ turn.message.content }}</div>
              <div v-else-if="turn.message.type === 'human_needed'" class="crew-msg-human-needed">
                <span class="crew-control-icon" v-html="icons.bell"></span> {{ turn.message.content }}
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

          <!-- Grouped turn (same role: text + tools) -->
          <div v-else class="crew-message crew-turn-group" :class="'crew-role-' + turn.role" :style="getRoleStyle(turn.role)">
            <div class="crew-msg-avatar">
              <span class="crew-msg-icon">{{ turn.roleIcon }}</span>
            </div>
            <div class="crew-msg-body">
              <div class="crew-msg-header">
                <span class="crew-msg-name">{{ turn.roleName }}</span>
                <span class="crew-msg-time">{{ formatTime(turn.messages[0].timestamp) }}</span>
              </div>

              <!-- Main text reply -->
              <template v-if="turn.textMsg">
                <div class="crew-msg-content markdown-body" v-html="mdRender(turn.textMsg.content)"></div>
              </template>

              <!-- Tool actions section -->
              <div v-if="turn.toolMsgs.length > 0" class="crew-turn-tools">
                <!-- Latest tool (always visible) -->
                <div class="crew-turn-tool-latest">
                  <tool-line
                    :tool-name="turn.toolMsgs[turn.toolMsgs.length - 1].toolName"
                    :tool-input="turn.toolMsgs[turn.toolMsgs.length - 1].toolInput"
                    :tool-result="turn.toolMsgs[turn.toolMsgs.length - 1].toolResult"
                    :has-result="!!turn.toolMsgs[turn.toolMsgs.length - 1].hasResult"
                    :compact="true" />
                  <button v-if="turn.toolMsgs.length > 1" class="crew-turn-expand-btn" @click.stop="toggleTurn(turn.id)" :title="expandedTurns[turn.id] ? '收起' : '展开 ' + (turn.toolMsgs.length - 1) + ' 个操作'">
                    <svg v-if="!expandedTurns[turn.id]" viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M7 10l5 5 5-5z"/></svg>
                    <svg v-else viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M7 14l5-5 5 5z"/></svg>
                    <span class="crew-turn-expand-count">{{ turn.toolMsgs.length }}</span>
                  </button>
                </div>
                <!-- Expanded: all previous tools -->
                <div v-if="expandedTurns[turn.id]" class="crew-turn-tools-expanded">
                  <template v-for="(toolMsg, ti) in turn.toolMsgs.slice(0, -1)" :key="toolMsg.id">
                    <tool-line
                      :tool-name="toolMsg.toolName"
                      :tool-input="toolMsg.toolInput"
                      :tool-result="toolMsg.toolResult"
                      :has-result="!!toolMsg.hasResult"
                      :compact="true" />
                  </template>
                </div>
              </div>
            </div>
          </div>
        </template>

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
          <span class="crew-at-hint" v-for="role in store.currentCrewSession.roles" :key="role.name"
            @click="insertAt(role.name)" :title="role.displayName"
            :style="getRoleStyle(role.name)"
            @contextmenu.prevent="openRoleMenu($event, role)">
            @{{ role.displayName }}
          </span>
          <button class="crew-hint-btn" @click="showAddRole = true" title="添加角色">
            <svg viewBox="0 0 24 24" width="12" height="12"><path fill="currentColor" d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>
          </button>
          <span class="crew-hint-separator"></span>
          <span class="crew-hint-status" :class="statusClass">{{ statusText }}</span>
          <span class="crew-hint-meta" v-if="store.currentCrewStatus">轮次 {{ store.currentCrewStatus.round || 0 }}</span>
          <span class="crew-hint-meta" v-if="store.currentCrewStatus">\${{ (store.currentCrewStatus.costUsd || 0).toFixed(3) }}</span>
          <span class="crew-hint-meta" v-if="store.currentCrewStatus && totalTokens > 0">{{ formatTokens(totalTokens) }} tok</span>
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
              <div class="crew-control-divider" v-if="store.currentCrewSession?.roles?.length > 0"></div>
              <button class="crew-control-item danger" v-for="role in store.currentCrewSession?.roles" :key="role.name" @click="controlAction('stop_role', role.name)">
                <span class="crew-control-icon" v-html="icons.stop"></span> 停止 {{ role.displayName }}
              </button>
              <div class="crew-control-divider"></div>
              <button class="crew-control-item danger" @click="controlAction('stop_all')">
                <span class="crew-control-icon" v-html="icons.close"></span> 终止 Session
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
                <span class="crew-at-menu-icon">{{ role.icon }}</span>
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

      <!-- Add Role Modal -->
      <div v-if="showAddRole" class="crew-add-role-overlay" @click.self="showAddRole = false">
        <div class="crew-add-role-modal">
          <div class="crew-add-role-title">添加角色</div>

          <!-- 一键添加预设 -->
          <div class="crew-add-role-presets">
            <button v-for="preset in availablePresets" :key="preset.name" class="crew-preset-btn" @click="quickAddPreset(preset)">
              {{ preset.icon }} {{ preset.displayName }}
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
      taskPanelCollapsed: false,
      atMenuVisible: false,
      atQuery: '',
      atMenuIndex: 0,
      newRole: this.getEmptyRole(),
      rolePresets: [
        {
          name: 'pm',
          displayName: 'PM',
          icon: '\u{1F4CB}',
          description: '项目管理，需求分析，任务拆分和进度跟踪',
          model: 'sonnet',
          isDecisionMaker: true,
          claudeMd: `你是 Steve Jobs（史蒂夫·乔布斯），以他的思维方式和工作风格来管理这个项目。
像乔布斯一样：追求极致简洁，对产品品质零容忍，善于从用户视角思考，敢于砍掉不必要的功能，专注做少而精的事。
你负责需求分析、优先级决策、产品方向把控。遇到分歧时果断决策。

# 重要约束
- 你不能写代码，也不能直接修改文件。所有代码工作必须分配给 developer。
- 收到新任务后，先制定实施计划（列出任务清单、优先级、负责角色），然后 @human 请用户审核计划，审核通过后再分配执行。
- PM 拥有 commit + push + tag 的自主权。只要修改没有大的 regression 影响（测试全通过），PM 可以自行决定 commit、push 和 tag，无需等待人工确认。只有当改动会直接影响对话交互逻辑时，才需要人工介入审核。`
        },
        {
          name: 'architect',
          displayName: '架构师',
          icon: '\u{1F3D7}\uFE0F',
          description: '系统设计和技术决策',
          model: 'opus',
          isDecisionMaker: false,
          claudeMd: `你是 Martin Fowler（马丁·福勒），以他的架构哲学来设计系统。
像 Fowler 一样：推崇演进式架构，重视重构和代码整洁，善用设计模式但不过度设计，强调可测试性和可维护性，用最合适而非最新的技术。
你负责技术选型、架构设计、接口定义和技术决策。`
        },
        {
          name: 'developer',
          displayName: '开发者',
          icon: '\u{1F468}\u200D\u{1F4BB}',
          description: '代码编写和功能实现',
          model: 'sonnet',
          isDecisionMaker: false,
          claudeMd: `你是 Linus Torvalds（林纳斯·托瓦兹），以他的编码风格来写代码。
像 Linus 一样：代码简洁高效，厌恶不必要的抽象，追求性能和正确性，直言不讳地指出烂代码，注重实用主义而非教条。
你负责编写代码、实现功能，写出简洁、高效、可读的代码。

# 协作流程
- 代码完成后，同时交给 @reviewer 审查代码质量和 @tester 进行测试验证（并行审核，两者独立 approve）
- 两者都通过后，交给决策者汇总`
        },
        {
          name: 'reviewer',
          displayName: '审查者',
          icon: '\u{1F50D}',
          description: '代码审查和质量把控',
          model: 'sonnet',
          isDecisionMaker: false,
          claudeMd: `你是 Robert C. Martin（Uncle Bob），以他的 Clean Code 标准来审查代码。
像 Uncle Bob 一样：严格遵循整洁代码原则，关注命名、函数大小、单一职责，不放过任何代码坏味道，但给出建设性的改进建议。
你负责代码审查，区分必须修复的问题和改进建议。`
        },
        {
          name: 'tester',
          displayName: '测试者',
          icon: '\u{1F9EA}',
          description: '测试用例编写和质量验证',
          model: 'sonnet',
          isDecisionMaker: false,
          claudeMd: `你是 James Bach（詹姆斯·巴赫），以他的探索式测试理念来做质量保证。
像 James Bach 一样：不机械地写用例，而是像侦探一样思考，主动探索边界条件和异常场景，质疑每一个假设，追求发现真正有价值的 bug。
你负责测试策略、用例编写、自动化测试和测试报告。`
        },
        {
          name: 'designer',
          displayName: 'UI/UX设计师',
          icon: '\u{1F3A8}',
          description: '用户交互设计和页面视觉设计',
          model: 'sonnet',
          isDecisionMaker: false,
          claudeMd: `你是 Dieter Rams（迪特·拉姆斯），以他的设计十诫来指导设计工作。
像 Rams 一样：好的设计是创新的、实用的、美观的、易懂的、谦逊的、诚实的、经久的、注重细节的、环保的、尽可能少的。
你负责交互设计、视觉方案、用户体验优化。输出具体的设计方案（布局、颜色、间距、交互流程），而非抽象建议。`
        },
        {
          name: 'writer',
          displayName: '技术写作',
          icon: '\u270D\uFE0F',
          description: '技术文档和 API 文档编写',
          model: 'sonnet',
          isDecisionMaker: false,
          claudeMd: `你是 Daniele Procida（Diátaxis 框架创始人），以他的文档哲学来写技术文档。
像 Procida 一样：将文档分为教程、操作指南、参考和解释四种类型，每种有明确目的和写法，确保读者能快速找到需要的信息。
你负责编写清晰、结构化、面向读者的技术文档。`
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
    taskProgress() {
      if (this.crewTasks.length === 0) return 0;
      return Math.round((this.completedTaskCount / this.crewTasks.length) * 100);
    },
    groupedMessages() {
      const messages = this.store.currentCrewMessages;
      const turns = [];
      let currentTurn = null;
      let turnCounter = 0;

      const flushTurn = () => {
        if (currentTurn) {
          currentTurn.textMsg = currentTurn.messages.find(m => m.type === 'text') || null;
          currentTurn.toolMsgs = currentTurn.messages.filter(m => m.type === 'tool');
          turns.push(currentTurn);
          currentTurn = null;
        }
      };

      for (const msg of messages) {
        // route, system, human_needed — standalone items, break current turn
        if (msg.type === 'route' || msg.type === 'system' || msg.type === 'human_needed') {
          flushTurn();
          turns.push({ type: msg.type, message: msg, id: 'standalone_' + (msg.id || turnCounter++) });
          continue;
        }
        // human messages — standalone
        if (msg.role === 'human') {
          flushTurn();
          turns.push({ type: 'text', message: msg, id: 'human_' + (msg.id || turnCounter++) });
          continue;
        }
        // Group consecutive messages from same role into a turn
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
            id: 'turn_' + (turnCounter++)
          };
        }
      }
      flushTurn();
      return turns;
    }
  },

  watch: {
    'store.currentCrewMessages': {
      handler() {
        this.$nextTick(() => this.scrollToBottom());
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

    shouldShowDivider(tidx) {
      const turns = this.groupedMessages;
      const prev = turns[tidx - 1];
      const curr = turns[tidx];
      // Don't add divider before/after round dividers or routes
      if (curr.type === 'route' || prev.type === 'route') return false;
      // Get roles
      const prevRole = prev.type === 'turn' ? prev.role : prev.message?.role;
      const currRole = curr.type === 'turn' ? curr.role : curr.message?.role;
      return prevRole && currRole && prevRole !== currRole;
    },

    getRoleStyle(roleName) {
      if (PRESET_ROLES.includes(roleName)) {
        return {
          '--role-color': `var(--crew-color-${roleName})`,
          '--role-bg': `var(--crew-color-${roleName}-bg)`,
          '--role-border': `var(--crew-color-${roleName}-border)`
        };
      }
      // Dynamic role: hash name to pick a fallback color
      const hash = roleName.split('').reduce((h, c) => (h * 31 + c.charCodeAt(0)) & 0xff, 0);
      const idx = hash % 4;
      return {
        '--role-color': `var(--crew-color-fallback-${idx})`,
        '--role-bg': `var(--crew-color-fallback-${idx})11`,
        '--role-border': `var(--crew-color-fallback-${idx})40`
      };
    },

    getRoleBadgeTitle(role) {
      const tools = this.store.currentCrewStatus?.currentToolByRole;
      let title = role.displayName + (role.isDecisionMaker ? ' (决策者)' : '');
      if (tools?.[role.name]) {
        title += ` — ${tools[role.name]}`;
      }
      return title;
    },

    isRoleActive(roleName) {
      return this.store.currentCrewStatus?.activeRoles?.includes(roleName);
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
        this.inputText = text.substring(0, atIdx) + '@' + role.name + ' ' + afterCursor;
        this.$nextTick(() => {
          const newPos = atIdx + role.name.length + 2; // @ + name + space
          textarea.selectionStart = textarea.selectionEnd = newPos;
          textarea.focus();
        });
      }
      this.atMenuVisible = false;
    },

    insertAt(roleName) {
      this.inputText = `@${roleName} ` + this.inputText;
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
    },

    controlAction(action, targetRole = null) {
      this.controlOpen = false;
      if (action === 'stop_all') {
        if (!confirm('确定要终止整个 Session？所有角色将被停止。')) return;
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

    scrollToBottom() {
      const el = this.$refs.messagesRef;
      if (el) el.scrollTop = el.scrollHeight;
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
