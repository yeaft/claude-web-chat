/**
 * CrewChatView - Crew 群聊视图
 * 显示多角色的群聊消息，包括状态栏和控制按钮
 * 支持动态添加/移除角色
 */

// SVG icon helpers (24x24 viewBox, fill="currentColor", matching app style)
const ICONS = {
  crew: '<svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z"/></svg>',
  pause: '<svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>',
  play: '<svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M8 5v14l11-7z"/></svg>',
  stop: '<svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M6 6h12v12H6z"/></svg>',
  close: '<svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>',
  settings: '<svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58a.49.49 0 0 0 .12-.61l-1.92-3.32a.49.49 0 0 0-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.484.484 0 0 0-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.07.62-.07.94s.02.64.07.94l-2.03 1.58a.49.49 0 0 0-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z"/></svg>',
  trash: '<svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>',
  bolt: '<svg viewBox="0 0 24 24" width="12" height="12"><path fill="currentColor" d="M11 21h-1l1-7H7.5c-.88 0-.33-.75-.31-.78C8.48 10.94 10.42 7.54 13.01 3h1l-1 7h3.51c.4 0 .62.19.4.66C12.97 17.55 11 21 11 21z"/></svg>',
  bell: '<svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M12 22c1.1 0 2-.9 2-2h-4c0 1.1.89 2 2 2zm6-6v-5c0-3.07-1.64-5.64-4.5-6.32V4c0-.83-.67-1.5-1.5-1.5s-1.5.67-1.5 1.5v.68C7.63 5.36 6 7.92 6 11v5l-2 2v1h16v-1l-2-2z"/></svg>',
  add: '<svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>',
};

export default {
  name: 'CrewChatView',
  template: `
    <div class="crew-chat-view">
      <!-- Status Bar -->
      <div class="crew-status-bar" v-if="store.crewSession">
        <div class="crew-status-info">
          <span class="crew-status-icon" v-html="icons.crew"></span>
          <span class="crew-status-goal">{{ store.crewSession.goal }}</span>
        </div>
        <div class="crew-status-meta">
          <span class="crew-status-roles">
            <span v-for="role in store.crewSession.roles" :key="role.name"
              class="crew-role-badge"
              :class="{ active: isRoleActive(role.name), 'decision-maker': role.isDecisionMaker }"
              :title="role.displayName + (role.isDecisionMaker ? ' (决策者)' : '')"
              @contextmenu.prevent="openRoleMenu($event, role)">
              {{ role.icon }}
            </span>
            <!-- 添加角色按钮 -->
            <button class="crew-add-role-btn" @click="showAddRole = true" title="添加角色">
              <svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>
            </button>
          </span>
          <span class="crew-status-state" :class="statusClass">{{ statusText }}</span>
          <span class="crew-status-rounds" v-if="store.crewStatus">{{ store.crewStatus.round }}/{{ store.crewStatus.maxRounds }}</span>
          <span class="crew-status-cost" v-if="store.crewStatus">\${{ (store.crewStatus.costUsd || 0).toFixed(3) }}</span>
        </div>
        <div class="crew-controls">
          <div class="crew-control-dropdown" v-if="controlOpen" @click.stop>
            <button class="crew-control-item" @click="controlAction('pause')" v-if="store.crewStatus?.status === 'running'">
              <span class="crew-control-icon" v-html="icons.pause"></span> 暂停全部
            </button>
            <button class="crew-control-item" @click="controlAction('resume')" v-if="store.crewStatus?.status === 'paused'">
              <span class="crew-control-icon" v-html="icons.play"></span> 恢复
            </button>
            <div class="crew-control-divider" v-if="store.crewSession?.roles?.length > 0"></div>
            <button class="crew-control-item danger" v-for="role in store.crewSession?.roles" :key="role.name" @click="controlAction('stop_role', role.name)">
              <span class="crew-control-icon" v-html="icons.stop"></span> 停止 {{ role.displayName }}
            </button>
            <div class="crew-control-divider"></div>
            <button class="crew-control-item danger" @click="controlAction('stop_all')">
              <span class="crew-control-icon" v-html="icons.close"></span> 终止 Session
            </button>
          </div>
          <button class="crew-control-btn" @click.stop="controlOpen = !controlOpen" title="控制">
            <span v-if="store.crewStatus?.status === 'running'" v-html="icons.stop"></span>
            <span v-else-if="store.crewStatus?.status === 'paused'" v-html="icons.play"></span>
            <span v-else v-html="icons.settings"></span>
          </button>
        </div>
      </div>

      <!-- Role Context Menu -->
      <div v-if="roleMenuVisible" class="crew-role-context-menu" :style="roleMenuStyle" @click.stop>
        <div class="crew-role-menu-header">{{ roleMenuTarget?.icon }} {{ roleMenuTarget?.displayName }}</div>
        <button class="crew-role-menu-item" @click="removeRole(roleMenuTarget?.name)">
          <span class="crew-control-icon" v-html="icons.trash"></span> 移除
        </button>
      </div>

      <!-- Messages -->
      <div class="crew-messages" ref="messagesRef">
        <div v-if="store.crewMessages.length === 0" class="crew-empty">
          <div class="crew-empty-icon" v-html="icons.crew.replace(/16/g, '48')"></div>
          <div class="crew-empty-text" v-if="store.crewSession">等待角色开始工作...</div>
          <div class="crew-empty-text" v-else>等待 Crew Session 启动...</div>
        </div>

        <div v-for="msg in store.crewMessages" :key="msg.id" class="crew-message" :class="'crew-msg-' + msg.type + ' crew-role-' + msg.role">
          <!-- 角色标识 -->
          <div class="crew-msg-avatar">
            <span class="crew-msg-icon">{{ msg.roleIcon }}</span>
          </div>

          <div class="crew-msg-body">
            <div class="crew-msg-header">
              <span class="crew-msg-name" :class="{ 'is-human': msg.role === 'human', 'is-system': msg.role === 'system' }">{{ msg.roleName }}</span>
              <span class="crew-msg-time">{{ formatTime(msg.timestamp) }}</span>
            </div>

            <!-- 文本消息 -->
            <div v-if="msg.type === 'text'" class="crew-msg-content" v-html="renderMarkdown(msg.content)"></div>

            <!-- 工具调用 -->
            <div v-else-if="msg.type === 'tool'" class="crew-msg-tool">
              <span class="crew-tool-icon" v-html="icons.bolt"></span>
              <span class="crew-tool-name">{{ msg.toolName }}</span>
              <span class="crew-tool-detail">{{ msg.content }}</span>
            </div>

            <!-- 路由消息 -->
            <div v-else-if="msg.type === 'route'" class="crew-msg-route">
              {{ msg.content }}
            </div>

            <!-- 系统消息 -->
            <div v-else-if="msg.type === 'system'" class="crew-msg-system">
              {{ msg.content }}
            </div>

            <!-- 需要人工介入 -->
            <div v-else-if="msg.type === 'human_needed'" class="crew-msg-human-needed">
              <span class="crew-control-icon" v-html="icons.bell"></span> {{ msg.content }}
            </div>
          </div>
        </div>

        <!-- 流式指示器 -->
        <div v-if="hasStreamingMessage" class="crew-streaming-indicator">
          <span class="crew-typing-dot"></span>
          <span class="crew-typing-dot"></span>
          <span class="crew-typing-dot"></span>
        </div>
      </div>

      <!-- Input -->
      <div class="crew-input-area">
        <div class="crew-input-hints" v-if="store.crewSession">
          <span class="crew-at-hint" v-for="role in store.crewSession.roles" :key="role.name" @click="insertAt(role.name)" :title="role.displayName">
            @{{ role.displayName }}
          </span>
        </div>
        <div class="crew-input-row">
          <textarea class="crew-input" v-model="inputText" @keydown.enter.exact="sendMessage" placeholder="输入消息... (@角色名 发送给指定角色)" rows="1" ref="inputRef"></textarea>
          <button class="crew-send-btn" @click="sendMessage" :disabled="!inputText.trim()" title="发送">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M3.5 13V3L13 8L3.5 13Z"/></svg>
          </button>
        </div>
      </div>

      <!-- Add Role Modal -->
      <div v-if="showAddRole" class="crew-add-role-overlay" @click.self="showAddRole = false">
        <div class="crew-add-role-modal">
          <div class="crew-add-role-title">添加角色</div>
          <div class="crew-add-role-form">
            <div class="crew-add-role-field">
              <label>角色标识 (英文)</label>
              <input v-model="newRole.name" placeholder="如 developer, reviewer" />
            </div>
            <div class="crew-add-role-field">
              <label>显示名称</label>
              <input v-model="newRole.displayName" placeholder="如 开发者" />
            </div>
            <div class="crew-add-role-field">
              <label>图标</label>
              <input v-model="newRole.icon" placeholder="如 PM" style="width: 60px" />
            </div>
            <div class="crew-add-role-field">
              <label>角色描述</label>
              <input v-model="newRole.description" placeholder="负责什么工作" />
            </div>
            <div class="crew-add-role-field">
              <label>模型</label>
              <select v-model="newRole.model">
                <option value="sonnet">Sonnet</option>
                <option value="opus">Opus</option>
                <option value="haiku">Haiku</option>
              </select>
            </div>
            <div class="crew-add-role-field">
              <label>自定义 Prompt (可选)</label>
              <textarea v-model="newRole.claudeMd" placeholder="角色的额外系统提示..." rows="3"></textarea>
            </div>
            <div class="crew-add-role-field">
              <label><input type="checkbox" v-model="newRole.isDecisionMaker" /> 设为决策者</label>
            </div>

            <!-- 快速角色模板 -->
            <div class="crew-add-role-presets">
              <span class="crew-preset-label">快速添加：</span>
              <button v-for="preset in rolePresets" :key="preset.name" class="crew-preset-btn" @click="applyPreset(preset)">
                {{ preset.icon }} {{ preset.displayName }}
              </button>
            </div>
          </div>
          <div class="crew-add-role-actions">
            <button class="crew-add-role-cancel" @click="showAddRole = false">取消</button>
            <button class="crew-add-role-confirm" @click="confirmAddRole" :disabled="!newRole.name || !newRole.displayName">添加</button>
          </div>
        </div>
      </div>
    </div>
  `,

  setup() {
    const store = Pinia.useChatStore();
    return { store };
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
      newRole: this.getEmptyRole(),
      rolePresets: [
        {
          name: 'pm',
          displayName: 'PM',
          icon: '📋',
          description: '项目管理，需求分析，任务拆分和进度跟踪',
          model: 'sonnet',
          isDecisionMaker: true,
          claudeMd: `你是 Steve Jobs（史蒂夫·乔布斯），以他的思维方式和工作风格来管理这个项目。
像乔布斯一样：追求极致简洁，对产品品质零容忍，善于从用户视角思考，敢于砍掉不必要的功能，专注做少而精的事。
你负责需求分析、优先级决策、产品方向把控。遇到分歧时果断决策。`
        },
        {
          name: 'architect',
          displayName: '架构师',
          icon: '🏗️',
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
          icon: '👨‍💻',
          description: '代码编写和功能实现',
          model: 'sonnet',
          isDecisionMaker: false,
          claudeMd: `你是 Linus Torvalds（林纳斯·托瓦兹），以他的编码风格来写代码。
像 Linus 一样：代码简洁高效，厌恶不必要的抽象，追求性能和正确性，直言不讳地指出烂代码，注重实用主义而非教条。
你负责编写代码、实现功能，写出简洁、高效、可读的代码。`
        },
        {
          name: 'reviewer',
          displayName: '审查者',
          icon: '🔍',
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
          icon: '🧪',
          description: '测试用例编写和质量验证',
          model: 'sonnet',
          isDecisionMaker: false,
          claudeMd: `你是 James Bach（詹姆斯·巴赫），以他的探索式测试理念来做质量保证。
像 James Bach 一样：不机械地写用例，而是像侦探一样思考，主动探索边界条件和异常场景，质疑每一个假设，追求发现真正有价值的 bug。
你负责测试策略、用例编写、自动化测试和测试报告。`
        },
        {
          name: 'writer',
          displayName: '技术写作',
          icon: '✍️',
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
      const status = this.store.crewStatus?.status;
      if (status === 'running') return '运行中';
      if (status === 'paused') return '已暂停';
      if (status === 'waiting_human') return '等待人工';
      if (status === 'completed') return '已完成';
      if (status === 'stopped') return '已停止';
      if (status === 'max_rounds_reached') return '达到上限';
      return '初始化';
    },
    statusClass() {
      const status = this.store.crewStatus?.status;
      return {
        'status-running': status === 'running',
        'status-paused': status === 'paused',
        'status-waiting': status === 'waiting_human',
        'status-completed': status === 'completed',
        'status-stopped': status === 'stopped'
      };
    },
    hasStreamingMessage() {
      return this.store.crewMessages.some(m => m._streaming);
    }
  },

  watch: {
    'store.crewMessages': {
      handler() {
        this.$nextTick(() => this.scrollToBottom());
      },
      deep: true
    }
  },

  methods: {
    getEmptyRole() {
      return { name: '', displayName: '', icon: '🤖', description: '', model: 'sonnet', claudeMd: '', isDecisionMaker: false };
    },

    formatTime(ts) {
      if (!ts) return '';
      const d = new Date(ts);
      return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    },

    renderMarkdown(text) {
      if (!text) return '';
      let html = text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
      html = html.replace(/```(\w*)\n([\s\S]*?)```/g, '<pre><code class="language-$1">$2</code></pre>');
      html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
      html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
      html = html.replace(/\n/g, '<br>');
      html = html.replace(/---ROUTE---[\s\S]*?---END_ROUTE---/g, '');
      return html;
    },

    isRoleActive(roleName) {
      return this.store.crewStatus?.activeRoles?.includes(roleName);
    },

    insertAt(roleName) {
      this.inputText = `@${roleName} ` + this.inputText;
      this.$refs.inputRef?.focus();
    },

    sendMessage(e) {
      if (e && e.preventDefault) e.preventDefault();
      const text = this.inputText.trim();
      if (!text) return;
      this.store.sendCrewMessage(text);
      this.inputText = '';
    },

    controlAction(action, targetRole = null) {
      this.controlOpen = false;
      if (action === 'stop_all') {
        if (!confirm('确定要终止整个 Session？所有角色将被停止。')) return;
      }
      this.store.sendCrewControl(action, targetRole);
    },

    // 角色右键菜单
    openRoleMenu(event, role) {
      this.roleMenuTarget = role;
      this.roleMenuStyle = {
        left: event.clientX + 'px',
        top: event.clientY + 'px'
      };
      this.roleMenuVisible = true;
    },

    removeRole(roleName) {
      this.roleMenuVisible = false;
      if (!roleName) return;
      if (!confirm(`确定要移除 ${roleName}？角色的 Memory 将保留。`)) return;
      this.store.removeCrewRole(roleName);
    },

    // 添加角色
    applyPreset(preset) {
      // 检查是否已存在
      const existing = this.store.crewSession?.roles?.find(r => r.name === preset.name);
      if (existing) {
        // 如果已存在，加后缀
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
      if (el) {
        el.scrollTop = el.scrollHeight;
      }
    }
  },

  mounted() {
    const closeMenus = () => {
      this.controlOpen = false;
      this.roleMenuVisible = false;
    };
    document.addEventListener('click', closeMenus);
    this._cleanupClick = closeMenus;
  },

  beforeUnmount() {
    if (this._cleanupClick) {
      document.removeEventListener('click', this._cleanupClick);
    }
  }
};
