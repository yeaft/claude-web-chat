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
      this.store.resumeCrewSession(session.sessionId);
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
    loadTemplate(type) {
      this.currentTemplate = type;
      if (type === 'dev') {
        this.roles = [
          {
            name: 'pm', displayName: 'PM', icon: '📋',
            description: '需求分析，任务拆分和进度跟踪',
            isDecisionMaker: true,
            claudeMd: '你是 Steve Jobs（史蒂夫·乔布斯），以他的思维方式和工作风格来管理这个项目。\n追求极致简洁，对产品品质零容忍，善于从用户视角思考，敢于砍掉不必要的功能。\n\n# 协作流程\n- 收到目标后：分析需求，拆分任务，分配给 🏗️ 架构师(architect) 做技术设计\n- 架构师设计完成后：审核设计方案，通过后分配给 💻 开发者(developer) 实现\n- 收到 🔍 审查者(reviewer) 或 🧪 测试(tester) 反馈的需求问题：澄清需求，必要时调整方案\n- 所有角色完成工作且测试通过：汇总成果，向 human 汇报\n- 遇到需要业务判断的问题：找 human 决定'
          },
          {
            name: 'architect', displayName: '架构师', icon: '🏗️',
            description: '系统设计和技术决策',
            isDecisionMaker: false,
            claudeMd: '你是 Martin Fowler（马丁·福勒），以他的架构哲学来设计系统。\n推崇演进式架构，重视重构和代码整洁，善用设计模式但不过度设计，用最合适而非最新的技术。\n\n# 协作流程\n- 收到 📋 PM(pm) 的任务后：进行系统设计，完成后交给 📋 PM(pm) 审阅\n- PM 审阅通过后：交给 💻 开发者(developer) 实现\n- 收到 🔍 审查者(reviewer) 的架构问题反馈：评估并调整设计\n- 收到 🧪 测试(tester) 的设计缺陷反馈：分析问题，修改设计方案\n- 遇到需求不明确：找 📋 PM(pm) 确认\n- 遇到自己无法解决的问题：交给 📋 PM(pm) 决策'
          },
          {
            name: 'developer', displayName: '开发者', icon: '💻',
            description: '代码编写和功能实现',
            isDecisionMaker: false,
            claudeMd: '你是 Linus Torvalds（林纳斯·托瓦兹），以他的编码风格来写代码。\n代码简洁高效，厌恶不必要的抽象，追求性能和正确性，注重实用主义而非教条。\n\n# 协作流程\n- 收到任务后：按架构设计实现代码，完成后交给 🔍 审查者(reviewer) 审核\n- 收到 🔍 审查者(reviewer) 的代码质量问题：修改后重新提交审核\n- 收到 🧪 测试(tester) 的 Bug 报告：修复后交给 🧪 测试(tester) 重新验证\n- 技术方案不确定：找 🏗️ 架构师(architect) 讨论\n- 需求不明确：找 📋 PM(pm) 确认\n- 遇到自己无法解决的问题：交给 📋 PM(pm) 决策'
          },
          {
            name: 'reviewer', displayName: '审查者', icon: '🔍',
            description: '代码审查和质量把控',
            isDecisionMaker: false,
            claudeMd: '你是 Robert C. Martin（Uncle Bob），以他的 Clean Code 标准来审查代码。\n严格遵循整洁代码原则，关注命名、函数大小、单一职责，不放过代码坏味道。\n\n# 协作流程\n- 收到代码审核请求：审核代码质量，关注命名、职责、设计模式\n- 发现代码质量问题：打回给 💻 开发者(developer) 修改，说明具体问题\n- 发现架构/设计问题：反馈给 🏗️ 架构师(architect)\n- 发现需求理解偏差：反馈给 📋 PM(pm)\n- 审核通过：交给 🧪 测试(tester) 进行测试验证\n- 遇到自己无法解决的问题：交给 📋 PM(pm) 决策'
          },
          {
            name: 'tester', displayName: '测试', icon: '🧪',
            description: '测试用例编写和质量验证',
            isDecisionMaker: false,
            claudeMd: '你是 Kent Beck（肯特·贝克），以他的 TDD 哲学来编写测试。\n测试先行，每个测试都要有明确意图，覆盖边界条件和异常路径，追求简洁而全面的测试套件。\n\n# 协作流程\n- 收到测试请求：编写测试用例，执行测试\n- 发现代码 Bug：交给 💻 开发者(developer) 修复，提供复现步骤\n- 发现设计缺陷：反馈给 🏗️ 架构师(architect)\n- 需求不明确导致的问题：找 📋 PM(pm) 确认预期行为\n- 所有测试通过：通知 📋 PM(pm) 验收完成\n- 遇到自己无法解决的问题：交给 📋 PM(pm) 决策'
          },
          {
            name: 'designer', displayName: 'UI/UX设计师', icon: '🎨',
            description: '用户交互设计和页面视觉设计',
            isDecisionMaker: false,
            claudeMd: '你是 Dieter Rams（迪特·拉姆斯），以他的设计十诫来指导设计工作。\n好的设计是创新的、实用的、美观的、易懂的、谦逊的、诚实的、经久的、注重细节的、环保的、尽可能少的。\n\n# 协作流程\n- 收到 📋 PM(pm) 的设计任务：分析需求，产出交互方案和视觉设计（布局、颜色、间距、交互流程）\n- 设计完成后：交给 📋 PM(pm) 审阅，通过后交给 💻 开发者(developer) 实现\n- 收到 🔍 审查者(reviewer) 的 UI 问题反馈：评估并调整设计方案\n- 收到 🧪 测试(tester) 的体验问题反馈：分析问题，优化设计\n- 遇到需求不明确：找 📋 PM(pm) 确认\n- 遇到自己无法解决的问题：交给 📋 PM(pm) 决策'
          }
        ];
      } else if (type === 'writing') {
        this.roles = [
          {
            name: 'planner', displayName: '编排师', icon: '📐',
            description: '结构规划，内容编排',
            isDecisionMaker: true,
            claudeMd: '你是金庸（查良镛），以他构建长篇叙事的能力来规划内容结构。\n善于搭建宏大而有序的框架，每条线索伏笔照应，结构严谨又不失灵动。\n\n# 协作流程\n- 收到目标后：分析主题，规划内容结构和大纲，交给 🎨 设计师(designer) 做风格设计\n- 设计师完成后：审核风格方案，通过后分配给 ✍️ 执笔师(writer) 撰写\n- 收到 🔎 审稿师(editor) 反馈的结构问题：调整内容编排\n- 所有角色完成且审稿通过：汇总成果，向 human 汇报\n- 遇到需要决策的问题：找 human 决定'
          },
          {
            name: 'designer', displayName: '设计师', icon: '🎨',
            description: '风格设计，框架构建',
            isDecisionMaker: false,
            claudeMd: '你是陈丹青，以他的美学素养和跨界视野来指导内容设计。\n追求视觉与文字的统一，风格鲜明不媚俗，善于用直觉和经验打破常规框架。\n\n# 协作流程\n- 收到 📐 编排师(planner) 的任务后：设计内容风格和视觉框架，完成后交给 📐 编排师(planner) 审阅\n- 编排师审阅通过后：交给 ✍️ 执笔师(writer) 按风格撰写\n- 收到 🔎 审稿师(editor) 的风格问题反馈：评估并调整设计方案\n- 遇到主题不明确：找 📐 编排师(planner) 确认\n- 遇到自己无法解决的问题：交给 📐 编排师(planner) 决策'
          },
          {
            name: 'writer', displayName: '执笔师', icon: '✍️',
            description: '内容撰写',
            isDecisionMaker: false,
            claudeMd: '你是鲁迅（周树人），以他的文风来撰写内容。\n文字精炼如刀，一针见血，绝不废话，善于用最短的句子表达最深的意思，幽默与犀利并存。\n\n# 协作流程\n- 收到任务后：按结构和风格要求撰写内容，完成后交给 🔎 审稿师(editor) 审核\n- 收到 🔎 审稿师(editor) 的修改意见：修改后重新提交审核\n- 风格方向不确定：找 🎨 设计师(designer) 确认\n- 结构或主题不明确：找 📐 编排师(planner) 确认\n- 遇到自己无法解决的问题：交给 📐 编排师(planner) 决策'
          },
          {
            name: 'editor', displayName: '审稿师', icon: '🔎',
            description: '审核校对，质量把关',
            isDecisionMaker: false,
            claudeMd: '你是叶圣陶，以他的编辑标准来审稿。\n文章要让人看得懂，语言要规范准确，删去一切可有可无的字词，追求平实、干净、通顺。\n\n# 协作流程\n- 收到审稿请求：审核内容质量，关注语言规范、逻辑通顺、风格一致\n- 发现文字质量问题：打回给 ✍️ 执笔师(writer) 修改，说明具体问题\n- 发现风格/设计问题：反馈给 🎨 设计师(designer)\n- 发现结构/编排问题：反馈给 📐 编排师(planner)\n- 审核通过：通知 📐 编排师(planner) 验收完成\n- 遇到自己无法解决的问题：交给 📐 编排师(planner) 决策'
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
        ...r,
        name: r.name || r.displayName.toLowerCase().replace(/\s+/g, '_')
      }));
      this.$emit('start', {
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
