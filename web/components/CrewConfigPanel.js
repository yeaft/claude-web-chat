/**
 * CrewConfigPanel - Crew 模式配置面板
 * 支持创建和编辑模式，参考会话 modal 的交互风格
 */

export default {
  name: 'CrewConfigPanel',
  template: `
    <div class="crew-config-overlay" @click.self="$emit('close')">
      <div class="crew-config-panel">
        <div class="crew-config-header">
          <h2>{{ isEditMode ? 'Crew Settings' : 'Crew Session' }}</h2>
          <button class="crew-config-close" @click="$emit('close')">&times;</button>
        </div>

        <div class="crew-config-body">
          <!-- 创建模式 -->
          <template v-if="!isEditMode">
            <!-- 可恢复的 Crew Sessions -->
            <div class="crew-config-section" v-if="resumableCrewSessions.length > 0">
              <label class="crew-config-label">恢复已有 Session</label>
              <div class="crew-stopped-list">
                <div
                  v-for="sc in resumableCrewSessions"
                  :key="sc.sessionId"
                  class="crew-stopped-item"
                  @click="resumeStoppedSession(sc)"
                >
                  <div class="crew-stopped-info">
                    <span class="crew-stopped-goal">{{ sc.goal || 'Crew Session' }}</span>
                    <span class="crew-stopped-meta">
                      {{ shortenPath(sc.projectDir) }}
                      <span class="crew-stopped-status-tag" :class="'status-' + (sc.status || 'stopped')">{{ formatStatus(sc.status) }}</span>
                      <span v-if="sc.createdAt" class="crew-stopped-time">{{ formatSessionTime(sc.createdAt) }}</span>
                    </span>
                  </div>
                  <div class="crew-stopped-actions">
                    <button class="crew-stopped-delete-btn" @click.stop="deleteStoppedSession(sc)" title="删除">
                      <svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>
                    </button>
                  </div>
                </div>
              </div>
            </div>

            <div class="crew-config-divider" v-if="resumableCrewSessions.length > 0">
              <span>或新建 Session</span>
            </div>

            <!-- Agent -->
            <div class="crew-config-section">
              <label class="crew-config-label">Agent</label>
              <div class="crew-select-wrapper">
                <select class="crew-config-select" v-model="selectedAgent">
                  <option value="">选择 Agent</option>
                  <option v-for="agent in crewAgents" :key="agent.id" :value="agent.id">
                    {{ agent.name }}{{ agent.latency ? ' (' + agent.latency + 'ms)' : '' }}
                  </option>
                </select>
                <svg class="select-arrow" viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M7 10l5 5 5-5z"/></svg>
              </div>
            </div>

            <!-- 工作区 -->
            <div class="crew-config-section" v-if="selectedAgent">
              <label class="crew-config-label">工作区</label>
              <div class="crew-workdir-group">
                <input class="crew-config-input" v-model="projectDir" :placeholder="selectedAgentWorkDir || '/home/user/projects/app'" />
                <button class="crew-browse-btn" @click="$emit('browse', 'crew')" title="浏览">
                  <svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M10 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/></svg>
                </button>
              </div>
            </div>

            <!-- 角色模板 -->
            <div class="crew-config-section" v-if="selectedAgent">
              <label class="crew-config-label">团队模板</label>
              <div class="crew-template-btns">
                <button class="crew-template-btn" @click="loadTemplate('dev')" :class="{ active: currentTemplate === 'dev' }">软件开发</button>
                <button class="crew-template-btn" @click="loadTemplate('writing')" :class="{ active: currentTemplate === 'writing' }">写作团队</button>
                <button class="crew-template-btn" @click="loadTemplate('trading')" :class="{ active: currentTemplate === 'trading' }">期货投资</button>
                <button class="crew-template-btn" @click="loadTemplate('custom')" :class="{ active: currentTemplate === 'custom' }">自定义</button>
              </div>
            </div>

            <!-- 角色配置（可编辑卡片） -->
            <div class="crew-config-section" v-if="selectedAgent">
              <label class="crew-config-label">角色配置</label>
              <div class="crew-roles-list">
                <div v-for="(role, idx) in roles" :key="idx" class="crew-role-item" :class="{ 'is-decision-maker': role.isDecisionMaker }">
                  <div class="crew-role-header">
                    <input class="crew-role-icon-input" v-model="role.icon" maxlength="4" />
                    <input class="crew-role-name-input" v-model="role.displayName" placeholder="角色名" />
                    <label class="crew-role-decision-label" :title="role.isDecisionMaker ? '决策者' : '设为决策者'">
                      <input type="radio" name="decisionMaker" :checked="role.isDecisionMaker" @change="setDecisionMaker(idx)" />
                      <svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z"/></svg>
                    </label>
                    <button class="crew-role-remove" @click="removeRole(idx)">&times;</button>
                  </div>
                  <input class="crew-role-desc-input" v-model="role.description" placeholder="角色职责描述" />
                  <div v-if="isExpandableRole(role.name)" class="crew-role-concurrency">
                    <template v-if="role.name === 'developer'">
                      <span class="crew-concurrency-label">并发:</span>
                      <button v-for="n in 3" :key="n" class="crew-concurrency-btn" :class="{ active: (role.count || 1) === n }" @click="setDevCount(n)">{{ n }}</button>
                    </template>
                    <template v-else>
                      <span class="crew-concurrency-follow">跟随开发者: {{ devCount }}</span>
                    </template>
                  </div>
                  <details class="crew-role-advanced">
                    <summary>高级设置</summary>
                    <textarea class="crew-config-textarea" v-model="role.claudeMd" placeholder="自定义 system prompt（可选）" rows="3"></textarea>
                  </details>
                </div>
              </div>
              <button class="crew-add-role-btn" @click="addRole">+ 添加角色</button>
            </div>

            <!-- 高级设置 (折叠) -->
            <details class="crew-config-section crew-advanced-section" v-if="selectedAgent">
              <summary class="crew-config-label crew-summary-label">高级设置</summary>
              <div class="crew-advanced-content">
                <div class="crew-config-row">
                  <label>共享目录:</label>
                  <input class="crew-config-input-sm" v-model="sharedDir" placeholder=".crew" />
                </div>
              </div>
            </details>
          </template>

          <!-- 编辑模式 -->
          <template v-else>
            <!-- 角色配置 -->
            <div class="crew-config-section">
              <label class="crew-config-label">角色配置</label>
              <div class="crew-roles-list">
                <div v-for="(role, idx) in roles" :key="idx" class="crew-role-item" :class="{ 'is-decision-maker': role.isDecisionMaker }">
                  <div class="crew-role-header">
                    <input class="crew-role-icon-input" v-model="role.icon" maxlength="4" :disabled="!role._isNew" />
                    <input class="crew-role-name-input" v-model="role.displayName" placeholder="角色名" :disabled="!role._isNew" />
                    <label class="crew-role-decision-label" :title="role.isDecisionMaker ? '决策者' : '设为决策者'">
                      <input type="radio" name="decisionMaker" :checked="role.isDecisionMaker" @change="setDecisionMaker(idx)" />
                      <svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z"/></svg>
                    </label>
                    <button class="crew-role-remove" @click="removeRole(idx)">&times;</button>
                  </div>
                  <input class="crew-role-desc-input" v-model="role.description" placeholder="角色职责描述" :disabled="!role._isNew" />
                  <details class="crew-role-advanced">
                    <summary>高级设置</summary>
                    <textarea class="crew-config-textarea" v-model="role.claudeMd" placeholder="自定义 system prompt（可选）" rows="3" :disabled="!role._isNew"></textarea>
                  </details>
                </div>
              </div>
              <button class="crew-add-role-btn" @click="addRole">+ 添加角色</button>
            </div>

            <!-- Session 控制 -->
            <div class="crew-config-section" v-if="status">
              <label class="crew-config-label">Session 控制</label>
              <div class="crew-config-controls">
                <div class="crew-config-status-info">
                  <span>状态: <strong>{{ statusLabel }}</strong></span>
                  <span v-if="status.round">轮次: {{ status.round }}</span>
                  <span v-if="status.costUsd">费用: \${{ (status.costUsd || 0).toFixed(3) }}</span>
                </div>
                <div class="crew-config-control-btns">
                  <button class="crew-control-action-btn" @click="doControl('pause')" v-if="status.status === 'running'">
                    <svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>
                    暂停
                  </button>
                  <button class="crew-control-action-btn" @click="doControl('resume')" v-if="status.status === 'paused'">
                    <svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M8 5v14l11-7z"/></svg>
                    恢复
                  </button>
                  <button class="crew-control-action-btn danger" @click="doControl('stop_all')">
                    <svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M6 6h12v12H6z"/></svg>
                    终止
                  </button>
                </div>
              </div>
            </div>
          </template>

          <!-- 没有选择 Agent 时的提示 -->
          <div class="crew-empty-state" v-if="!isEditMode && !selectedAgent">
            <div class="crew-empty-icon">
              <svg viewBox="0 0 24 24" width="40" height="40"><path fill="currentColor" d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z"/></svg>
            </div>
            <div class="crew-empty-text" v-if="crewAgents.length === 0">没有支持 Crew 模式的在线 Agent</div>
            <div class="crew-empty-text" v-else>请选择一个 Agent 开始配置</div>
          </div>
        </div>

        <div class="crew-config-footer" v-if="isEditMode || selectedAgent">
          <template v-if="isEditMode">
            <span class="crew-config-hint" v-if="pendingNewRoles.length > 0">{{ pendingNewRoles.length }} 个新角色待添加</span>
            <button class="modern-btn" @click="$emit('close')">关闭</button>
            <button class="modern-btn" @click="applyChanges" :disabled="pendingNewRoles.length === 0 && pendingRemovals.length === 0" v-if="pendingNewRoles.length > 0 || pendingRemovals.length > 0">应用变更</button>
          </template>
          <template v-else>
            <button class="modern-btn" @click="$emit('close')">取消</button>
            <button class="modern-btn" @click="startSession" :disabled="!canStart">
              <svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M8 5v14l11-7z"/></svg>
              启动
            </button>
          </template>
        </div>
      </div>
    </div>
  `,

  props: {
    defaultWorkDir: { type: String, default: '' },
    mode: { type: String, default: 'create' },
    session: { type: Object, default: null },
    status: { type: Object, default: null }
  },

  emits: ['close', 'start', 'browse'],

  setup() {
    const store = Pinia.useChatStore();
    return { store };
  },

  data() {
    return {
      selectedAgent: '',
      projectDir: this.defaultWorkDir || '',
      sharedDir: '.crew',
      goal: '',
      maxRounds: 20,
      currentTemplate: 'dev',
      roles: [],
      pendingRemovals: []
    };
  },

  computed: {
    isEditMode() {
      return this.mode === 'edit' && this.session;
    },
    crewAgents() {
      return this.store.agents.filter(a => a.online && a.capabilities?.includes('crew'));
    },
    selectedAgentWorkDir() {
      if (!this.selectedAgent) return '';
      const agent = this.store.agents.find(a => a.id === this.selectedAgent);
      return agent?.workDir || '';
    },
    canStart() {
      return this.selectedAgent && this.projectDir.trim();
    },
    pendingNewRoles() {
      return this.roles.filter(r => r._isNew);
    },
    devCount() {
      const dev = this.roles.find(r => r.name === 'developer');
      return dev?.count > 1 ? dev.count : 1;
    },
    statusLabel() {
      const s = this.status?.status;
      if (s === 'running') return '运行中';
      if (s === 'paused') return '已暂停';
      if (s === 'waiting_human') return '等待人工';
      if (s === 'completed') return '已完成';
      if (s === 'stopped') return '已停止';
      return '初始化';
    },
    resumableCrewSessions() {
      // 从 crew index 获取所有 session，排除当前活跃的
      const activeIds = new Set(Object.keys(this.store.crewSessions));
      const fromIndex = (this.store.crewSessionsList || []).filter(s => !activeIds.has(s.sessionId));
      // 也包括 conversations 中的已停止 crew（向后兼容）
      const indexIds = new Set(fromIndex.map(s => s.sessionId));
      const fromConvs = this.store.conversations
        .filter(c => c.type === 'crew' && !activeIds.has(c.id) && !indexIds.has(c.id))
        .map(c => ({ sessionId: c.id, goal: c.goal, projectDir: c.workDir, status: 'stopped', createdAt: c.createdAt, agentId: c.agentId }));
      const all = [...fromIndex, ...fromConvs];
      // 按创建时间倒序
      all.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      return all;
    }
  },

  watch: {
    selectedAgent(newVal) {
      if (newVal && !this.projectDir) {
        this.projectDir = this.selectedAgentWorkDir;
      }
      // 切换 agent 时重新加载 crew sessions 列表
      if (newVal && !this.isEditMode) {
        this.store.sendWsMessage({
          type: 'list_crew_sessions',
          agentId: newVal
        });
      }
    }
  },

  created() {
    if (this.isEditMode) {
      this.goal = this.session.goal || '';
      this.projectDir = this.session.projectDir || '';
      this.sharedDir = this.session.sharedDir || '.crew';
      this.maxRounds = this.session.maxRounds || 20;
      this.roles = (this.session.roles || []).map(r => ({ ...r }));
    } else {
      this.loadTemplate('dev');
      if (this.store.currentAgent) {
        const current = this.store.agents.find(a => a.id === this.store.currentAgent);
        if (current?.online && current?.capabilities?.includes('crew')) {
          this.selectedAgent = current.id;
        }
      }
      if (!this.selectedAgent && this.crewAgents.length > 0) {
        this.selectedAgent = this.crewAgents[0].id;
      }
    }
  },

  methods: {
    resumeStoppedSession(session) {
      const agentId = session.agentId || this.selectedAgent;
      if (agentId) this.store.selectAgent(agentId);
      this.store.resumeCrewSession(session.sessionId, agentId);
      this.$emit('close');
    },
    deleteStoppedSession(session) {
      if (!confirm('确定要删除此 Crew Session？此操作不可恢复。')) return;
      const agentId = session.agentId || this.selectedAgent;
      this.store.sendWsMessage({
        type: 'delete_crew_session',
        sessionId: session.sessionId,
        agentId: agentId
      });
      // 从本地列表中移除
      if (this.store.crewSessionsList) {
        const idx = this.store.crewSessionsList.findIndex(s => s.sessionId === session.sessionId);
        if (idx >= 0) this.store.crewSessionsList.splice(idx, 1);
      }
      // 如果在 conversations 中也移除
      const convIdx = this.store.conversations.findIndex(c => c.id === session.sessionId);
      if (convIdx >= 0) {
        this.store.conversations.splice(convIdx, 1);
      }
      delete this.store.crewSessions?.[session.sessionId];
      delete this.store.crewMessagesMap?.[session.sessionId];
      delete this.store.crewStatuses?.[session.sessionId];
    },
    formatStatus(s) {
      if (s === 'running') return '运行中';
      if (s === 'paused') return '已暂停';
      if (s === 'waiting_human') return '等待人工';
      if (s === 'completed') return '已完成';
      if (s === 'stopped') return '已停止';
      if (s === 'max_rounds_reached') return '达到上限';
      return '已停止';
    },
    formatSessionTime(ts) {
      if (!ts) return '';
      const d = new Date(ts);
      const now = new Date();
      if (d.toDateString() === now.toDateString()) {
        return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
      }
      return d.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' }) + ' ' +
             d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
    },
    shortenPath(p) {
      if (!p) return '';
      const home = '/home/';
      if (p.startsWith(home)) {
        const rest = p.slice(home.length);
        const slash = rest.indexOf('/');
        return slash >= 0 ? '~' + rest.slice(slash) : '~';
      }
      return p;
    },
    isExpandableRole(name) {
      return ['developer', 'tester', 'reviewer'].includes(name);
    },
    setDevCount(n) {
      const dev = this.roles.find(r => r.name === 'developer');
      if (dev) dev.count = n;
    },
    loadTemplate(type) {
      this.currentTemplate = type;
      if (type === 'dev') {
        this.roles = [
          {
            name: 'pm', displayName: 'PM-乔布斯', icon: '',
            description: '需求分析，任务拆分和进度跟踪',
            isDecisionMaker: true,
            claudeMd: '你是 Steve Jobs（史蒂夫·乔布斯），以他的思维方式和工作风格来管理这个项目。\n追求极致简洁，对产品品质零容忍，善于从用户视角思考，敢于砍掉不必要的功能。\n\n# 绝对禁令：工具使用限制\n你**绝对不能**使用以下工具修改任何文件：\n- Edit 工具 — 禁止\n- Write 工具 — 禁止\n- NotebookEdit 工具 — 禁止\n\n你**可以**使用的工具：\n- Read — 读取文件内容\n- Grep — 搜索代码\n- Glob — 查找文件\n- Bash — 仅限 git 命令（git status/add/commit/push/tag/log/diff）和只读命令\n\n如果你需要修改任何文件（无论多小的改动），必须 ROUTE 给 developer 执行。\n\n# 工作约束\n- 收到新任务后，先制定实施计划（列出任务清单、优先级、负责角色），然后 @human 请用户审核计划，审核通过后再分配执行。\n- 收到包含多个独立任务的消息时，必须用多个 ROUTE 块一次性并行分配给不同的 dev，不要逐个处理。\n- PM 拥有 commit + push + tag 的自主权。测试全通过即可自行 commit/push/tag。\n\n# 协作流程\n- 收到目标后：分析需求，拆分任务，制定计划，@human 审核\n- 审核通过后：所有文件改动（无论大小）都 ROUTE 给 developer\n  - 涉及 UI/前端/用户体验的需求：先交给设计师(designer)出方案，再交给开发者实现\n  - 涉及架构/系统设计的需求：交给架构师(architect)做技术设计\n- 开发者实现完成后：审查者 + 测试并行验证\n- 多实例模式下，可将大任务拆成子任务并行分配给多个 dev\n- 所有角色完成工作且测试通过：汇总成果，commit/push/tag，向 human 汇报\n- 遇到需要业务判断的问题：找 human 决定'
          },
          {
            name: 'architect', displayName: '架构师-福勒', icon: '',
            description: '系统设计和技术决策',
            isDecisionMaker: false,
            claudeMd: '你是 Martin Fowler（马丁·福勒），以他的架构哲学来设计系统。\n推崇演进式架构，重视重构和代码整洁，善用设计模式但不过度设计，用最合适而非最新的技术。\n\n# 协作流程\n- 收到 📋 PM(pm) 的任务后：进行系统设计，完成后交给 📋 PM(pm) 审阅\n- PM 审阅通过后：交给 💻 开发者(developer) 实现\n- 收到 🔍 审查者(reviewer) 的架构问题反馈：评估并调整设计\n- 收到 🧪 测试(tester) 的设计缺陷反馈：分析问题，修改设计方案\n- 遇到需求不明确：找 📋 PM(pm) 确认\n- 遇到自己无法解决的问题：交给 📋 PM(pm) 决策'
          },
          {
            name: 'developer', displayName: '开发者-托瓦兹', icon: '',
            description: '代码编写和功能实现',
            isDecisionMaker: false,
            claudeMd: '你是 Linus Torvalds（林纳斯·托瓦兹），以他的编码风格来写代码。\n代码简洁高效，厌恶不必要的抽象，追求性能和正确性，注重实用主义而非教条。\n\n# 协作流程\n- 收到任务后：按架构设计或设计师方案实现代码。如果任务涉及 UI/前端，严格按照 🎨 设计师(designer) 的交互方案和视觉设计来实现\n- 代码完成后，你必须同时发两个 ROUTE 块，分别交给审查者和测试者（缺一不可）：\n\n---ROUTE---\nto: reviewer\nsummary: 请审查代码变更...\n---END_ROUTE---\n\n---ROUTE---\nto: tester\nsummary: 请测试以下变更...\n---END_ROUTE---\n\n- 多实例模式下，你会被分配到一个开发组，系统会自动告诉你搭档的 reviewer 和 tester 是谁\n- 收到审查者的代码质量问题：修改后重新提交审核（再次同时 ROUTE 给 reviewer + tester）\n- 收到测试者的 Bug 报告：修复后再次同时 ROUTE 给 reviewer + tester\n- 技术方案不确定：找 🏗️ 架构师(architect) 讨论\n- UI/交互方案不确定：找 🎨 设计师(designer) 确认\n- 需求不明确：找 📋 PM(pm) 确认\n- 遇到自己无法解决的问题：交给 📋 PM(pm) 决策'
          },
          {
            name: 'reviewer', displayName: '审查者-马丁', icon: '',
            description: '代码审查和质量把控',
            isDecisionMaker: false,
            claudeMd: '你是 Robert C. Martin（Uncle Bob），以他的 Clean Code 标准来审查代码。\n严格遵循整洁代码原则，关注命名、函数大小、单一职责，不放过代码坏味道。\n\n# 协作流程\n- 收到代码审核请求：审核代码质量，关注命名、职责、设计模式\n- 发现代码质量问题：打回给 💻 开发者(developer) 修改，说明具体问题\n- 发现架构/设计问题：反馈给 🏗️ 架构师(architect)\n- 发现需求理解偏差：反馈给 📋 PM(pm)\n- 审核通过后，你必须 ROUTE 给 📋 PM(pm) 报告审核结果：\n\n---ROUTE---\nto: pm\nsummary: 代码审核通过，具体结论...\n---END_ROUTE---\n\n- 遇到自己无法解决的问题：交给 📋 PM(pm) 决策'
          },
          {
            name: 'tester', displayName: '测试-贝克', icon: '',
            description: '测试用例编写和质量验证',
            isDecisionMaker: false,
            claudeMd: '你是 Kent Beck（肯特·贝克），以他的 TDD 哲学来编写测试。\n测试先行，每个测试都要有明确意图，覆盖边界条件和异常路径，追求简洁而全面的测试套件。\n\n# 协作流程\n- 收到测试请求：编写测试用例，执行测试\n- 发现代码 Bug：交给 💻 开发者(developer) 修复，提供复现步骤\n- 发现设计缺陷：反馈给 🏗️ 架构师(architect)\n- 需求不明确导致的问题：找 📋 PM(pm) 确认预期行为\n- 所有测试通过后，你必须 ROUTE 给 📋 PM(pm) 报告测试结果：\n\n---ROUTE---\nto: pm\nsummary: 测试全部通过，具体结论...\n---END_ROUTE---\n\n- 遇到自己无法解决的问题：交给 📋 PM(pm) 决策'
          },
          {
            name: 'designer', displayName: '设计师-拉姆斯', icon: '',
            description: '用户交互设计和页面视觉设计',
            isDecisionMaker: false,
            claudeMd: '你是 Dieter Rams（迪特·拉姆斯），以他的设计十诫来指导设计工作。\n好的设计是创新的、实用的、美观的、易懂的、谦逊的、诚实的、经久的、注重细节的、环保的、尽可能少的。\n\n# 协作流程\n- 收到 📋 PM(pm) 的设计任务：分析需求，产出交互方案和视觉设计（布局、颜色、间距、交互流程）\n- 设计完成后：交给 📋 PM(pm) 审阅，通过后交给 💻 开发者(developer) 实现\n- 收到 🔍 审查者(reviewer) 的 UI 问题反馈：评估并调整设计方案\n- 收到 🧪 测试(tester) 的体验问题反馈：分析问题，优化设计\n- 遇到需求不明确：找 📋 PM(pm) 确认\n- 遇到自己无法解决的问题：交给 📋 PM(pm) 决策'
          }
        ];
      } else if (type === 'writing') {
        this.roles = [
          {
            name: 'planner', displayName: '编排师-金庸', icon: '',
            description: '结构规划，内容编排',
            isDecisionMaker: true,
            claudeMd: '你是金庸（查良镛），以他构建长篇叙事的能力来规划内容结构。\n善于搭建宏大而有序的框架，每条线索伏笔照应，结构严谨又不失灵动。\n\n# 协作流程\n- 收到目标后：分析主题，规划内容结构和大纲，交给 🎨 设计师(designer) 做风格设计\n- 设计师完成后：审核风格方案，通过后分配给 ✍️ 执笔师(writer) 撰写\n- 收到 🔎 审稿师(editor) 反馈的结构问题：调整内容编排\n- 所有角色完成且审稿通过：汇总成果，向 human 汇报\n- 遇到需要决策的问题：找 human 决定'
          },
          {
            name: 'designer', displayName: '设计师-陈丹青', icon: '',
            description: '风格设计，框架构建',
            isDecisionMaker: false,
            claudeMd: '你是陈丹青，以他的美学素养和跨界视野来指导内容设计。\n追求视觉与文字的统一，风格鲜明不媚俗，善于用直觉和经验打破常规框架。\n\n# 协作流程\n- 收到 📐 编排师(planner) 的任务后：设计内容风格和视觉框架，完成后交给 📐 编排师(planner) 审阅\n- 编排师审阅通过后：交给 ✍️ 执笔师(writer) 按风格撰写\n- 收到 🔎 审稿师(editor) 的风格问题反馈：评估并调整设计方案\n- 遇到主题不明确：找 📐 编排师(planner) 确认\n- 遇到自己无法解决的问题：交给 📐 编排师(planner) 决策'
          },
          {
            name: 'writer', displayName: '执笔师-鲁迅', icon: '',
            description: '内容撰写',
            isDecisionMaker: false,
            claudeMd: '你是鲁迅（周树人），以他的文风来撰写内容。\n文字精炼如刀，一针见血，绝不废话，善于用最短的句子表达最深的意思，幽默与犀利并存。\n\n# 协作流程\n- 收到任务后：按结构和风格要求撰写内容，完成后交给 🔎 审稿师(editor) 审核\n- 收到 🔎 审稿师(editor) 的修改意见：修改后重新提交审核\n- 风格方向不确定：找 🎨 设计师(designer) 确认\n- 结构或主题不明确：找 📐 编排师(planner) 确认\n- 遇到自己无法解决的问题：交给 📐 编排师(planner) 决策'
          },
          {
            name: 'editor', displayName: '审稿师-叶圣陶', icon: '',
            description: '审核校对，质量把关',
            isDecisionMaker: false,
            claudeMd: '你是叶圣陶，以他的编辑标准来审稿。\n文章要让人看得懂，语言要规范准确，删去一切可有可无的字词，追求平实、干净、通顺。\n\n# 协作流程\n- 收到审稿请求：审核内容质量，关注语言规范、逻辑通顺、风格一致\n- 发现文字质量问题：打回给 ✍️ 执笔师(writer) 修改，说明具体问题\n- 发现风格/设计问题：反馈给 🎨 设计师(designer)\n- 发现结构/编排问题：反馈给 📐 编排师(planner)\n- 审核通过：通知 📐 编排师(planner) 验收完成\n- 遇到自己无法解决的问题：交给 📐 编排师(planner) 决策'
          }
        ];
      } else if (type === 'trading') {
        this.roles = [
          {
            name: 'strategist', displayName: '策略师-索罗斯', icon: '',
            description: '宏观判断，策略方向，团队决策',
            isDecisionMaker: true,
            claudeMd: '你是 George Soros（乔治·索罗斯），以他的反身性理论和宏观对冲思维来主导投资策略。\n善于发现市场认知与现实的偏差，敢于在关键时刻下重注，同时保持对自身判断的怀疑。\n\n# 重要约束\n- 你是团队决策者，负责最终的交易决策和策略方向。\n- 所有分析结论必须形成可执行的策略建议（做多/做空/观望，品种，周期，仓位建议）。\n- 每个决策都要说明逻辑链条和关键假设，以及假设被证伪时的应对方案。\n\n# 协作流程\n- 收到投资任务后：先交给 🌍 宏观研究员(macro) 做宏观面分析，同时交给 📊 技术分析师(analyst) 做技术面分析\n- 综合两方分析后：形成策略方案，交给 🛡️ 风控官(risk) 评估风险和仓位\n- 风控通过后：下达交易指令给 💹 交易员(trader) 执行\n- 定期复盘：收集所有角色的反馈，调整策略\n- 遇到重大不确定性：@human 请人类决定'
          },
          {
            name: 'analyst', displayName: '分析师-利弗莫尔', icon: '',
            description: 'K线量价分析，趋势判断，进出场时机',
            isDecisionMaker: false,
            claudeMd: '你是 Jesse Livermore（杰西·利弗莫尔），以他的价格行为分析和趋势跟踪哲学来做技术分析。\n只相信价格和成交量，善于识别关键价位和市场转折点，耐心等待最佳入场时机，绝不逆势交易。\n\n# 协作流程\n- 收到 📐 首席策略师(strategist) 的分析任务后：对指定品种做全面技术分析（趋势、支撑阻力、量价关系、形态、指标）\n- 分析完成后：交给 📐 首席策略师(strategist) 综合判断\n- 给出明确的技术面结论：趋势方向、关键价位、建议进出场点位、止损位\n- 收到 💹 交易员(trader) 的实时盘面反馈：更新技术判断\n- 遇到技术面与基本面严重矛盾时：找 📐 首席策略师(strategist) 讨论'
          },
          {
            name: 'macro', displayName: '研究员-达里奥', icon: '',
            description: '宏观经济周期分析，跨品种关联研究',
            isDecisionMaker: false,
            claudeMd: '你是 Ray Dalio（雷·达里奥），以他的经济机器原理和全天候策略思维来做宏观研究。\n善于分析债务周期、货币政策、地缘政治对大宗商品的影响，用系统化思维理解跨资产联动关系。\n\n# 协作流程\n- 收到 📐 首席策略师(strategist) 的研究任务后：分析宏观经济环境、政策变化、供需格局、季节性因素\n- 研究完成后：交给 📐 首席策略师(strategist) 综合判断\n- 给出明确的宏观面结论：经济周期位置、政策方向、供需平衡预期、跨品种联动关系\n- 重点关注：央行政策、通胀数据、库存变化、产业链利润、地缘冲突\n- 遇到数据矛盾或不确定性大时：标注置信度，列出不同情景及概率'
          },
          {
            name: 'risk', displayName: '风控官-塔勒布', icon: '',
            description: '风险评估，仓位管理，极端情景防范',
            isDecisionMaker: false,
            claudeMd: '你是 Nassim Taleb（纳西姆·塔勒布），以他的黑天鹅理论和反脆弱思维来管理风险。\n永远假设极端事件会发生，追求凸性收益结构，厌恶隐性风险，宁可错过机会也不承担不对称的下行风险。\n\n# 协作流程\n- 收到 📐 首席策略师(strategist) 的策略方案后：评估风险敞口、最大回撤、相关性风险\n- 给出风控意见：建议仓位大小、止损设置、对冲方案、极端情景预案\n- 核心原则：单笔亏损不超过总资金 2%，总持仓风险不超过 10%，永远留有应对黑天鹅的余地\n- 如果策略风险不可接受：打回给 📐 首席策略师(strategist) 修改\n- 风控通过后：策略师会将指令转给 💹 交易员(trader) 执行\n- 持续监控：对已有持仓的风险状态保持关注，异常时主动预警'
          },
          {
            name: 'trader', displayName: '交易员-琼斯', icon: '',
            description: '交易执行，盯盘观察，订单管理',
            isDecisionMaker: false,
            claudeMd: '你是 Paul Tudor Jones（保罗·都铎·琼斯），以他的交易纪律和盘感来执行交易。\n严格执行策略指令，善于把握盘中节奏，在最佳价位执行，绝不情绪化交易，止损坚决不犹豫。\n\n# 协作流程\n- 收到 📐 首席策略师(strategist) 的交易指令后：确认品种、方向、仓位、进场价位、止损止盈\n- 执行交易并汇报结果：成交价、滑点、实际仓位\n- 盯盘过程中发现异常（急涨急跌、放量异动、突发消息）：立即通知 📊 技术分析师(analyst) 和 📐 首席策略师(strategist)\n- 严格执行止损纪律：到达止损位必须执行，不等不看不侥幸\n- 定期汇报持仓状态和盈亏情况给 📐 首席策略师(strategist)\n- 遇到无法执行的指令（流动性不足、涨跌停等）：反馈给 📐 首席策略师(strategist) 调整'
          }
        ];
      } else if (type === 'custom') {
        this.roles = [];
      }
    },

    addRole() {
      const idx = this.roles.length + 1;
      this.roles.push({
        name: 'role' + idx,
        displayName: 'Role ' + idx,
        icon: '🤖',
        description: '',
        claudeMd: '',
        isDecisionMaker: this.roles.length === 0,
        _isNew: this.isEditMode
      });
    },

    removeRole(idx) {
      const role = this.roles[idx];
      const wasDecisionMaker = role.isDecisionMaker;

      if (this.isEditMode && !role._isNew) {
        this.pendingRemovals.push(role.name);
      }

      this.roles.splice(idx, 1);
      if (wasDecisionMaker && this.roles.length > 0) {
        this.roles[0].isDecisionMaker = true;
      }
    },

    setDecisionMaker(idx) {
      this.roles.forEach((r, i) => { r.isDecisionMaker = (i === idx); });
    },

    startSession() {
      if (!this.canStart) return;
      this.store.selectAgent(this.selectedAgent);
      const roles = this.roles.map(r => ({
        name: r.name || r.displayName.toLowerCase().replace(/\s+/g, '_'),
        displayName: r.displayName,
        icon: r.icon,
        description: r.description,
        claudeMd: r.claudeMd || '',
        model: r.model,
        isDecisionMaker: r.isDecisionMaker || false,
        count: r.count || 1
      }));
      this.$emit('start', {
        agentId: this.selectedAgent,
        projectDir: this.projectDir.trim(),
        sharedDir: this.sharedDir.trim() || '.crew',
        goal: '',
        roles,
        maxRounds: this.maxRounds
      });
    },

    applyChanges() {
      for (const name of this.pendingRemovals) {
        this.store.removeCrewRole(name);
      }
      for (const role of this.pendingNewRoles) {
        const { _isNew, ...roleData } = role;
        roleData.name = roleData.name || roleData.displayName.toLowerCase().replace(/\s+/g, '_');
        this.store.addCrewRole(roleData);
      }
      this.pendingRemovals = [];
      this.roles.forEach(r => { delete r._isNew; });
      this.$emit('close');
    },

    doControl(action) {
      if (action === 'stop_all') {
        if (!confirm('确定要终止整个 Session？')) return;
      }
      this.store.sendCrewControl(action);
    }
  }
};
