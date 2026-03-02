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

            <!-- 任务目标 -->
            <div class="crew-config-section" v-if="selectedAgent">
              <label class="crew-config-label">任务目标</label>
              <textarea class="crew-config-textarea" v-model="goal" placeholder="描述你想让团队完成的目标..." rows="3"></textarea>
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
                <div class="crew-config-row">
                  <label>最大轮次:</label>
                  <input class="crew-config-input-sm" type="number" v-model.number="maxRounds" min="1" max="100" />
                </div>
              </div>
            </details>
          </template>

          <!-- 编辑模式 -->
          <template v-else>
            <!-- 任务目标 -->
            <div class="crew-config-section">
              <label class="crew-config-label">任务目标</label>
              <textarea class="crew-config-textarea" v-model="goal" placeholder="描述你想让团队完成的目标..." rows="3" disabled></textarea>
            </div>

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
                  <span v-if="status.round">轮次: {{ status.round }}/{{ status.maxRounds }}</span>
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
      model: 'opus',
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
      return this.selectedAgent && this.projectDir.trim() && this.goal.trim();
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
    }
  },

  watch: {
    selectedAgent(newVal) {
      if (newVal && !this.projectDir) {
        this.projectDir = this.selectedAgentWorkDir;
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
    loadTemplate(type) {
      this.currentTemplate = type;
      if (type === 'dev') {
        this.roles = [
          {
            name: 'pm', displayName: 'PM', icon: '📋',
            description: '需求分析，任务拆分和进度跟踪',
            isDecisionMaker: true,
            claudeMd: '你是 Steve Jobs（史蒂夫·乔布斯），以他的思维方式和工作风格来管理这个项目。\n追求极致简洁，对产品品质零容忍，善于从用户视角思考，敢于砍掉不必要的功能。'
          },
          {
            name: 'architect', displayName: '架构师', icon: '🏗️',
            description: '系统设计和技术决策',
            isDecisionMaker: false,
            claudeMd: '你是 Martin Fowler（马丁·福勒），以他的架构哲学来设计系统。\n推崇演进式架构，重视重构和代码整洁，善用设计模式但不过度设计，用最合适而非最新的技术。'
          },
          {
            name: 'developer', displayName: '开发者', icon: '💻',
            description: '代码编写和功能实现',
            isDecisionMaker: false,
            claudeMd: '你是 Linus Torvalds（林纳斯·托瓦兹），以他的编码风格来写代码。\n代码简洁高效，厌恶不必要的抽象，追求性能和正确性，注重实用主义而非教条。'
          },
          {
            name: 'reviewer', displayName: '审查者', icon: '🔍',
            description: '代码审查和质量把控',
            isDecisionMaker: false,
            claudeMd: '你是 Robert C. Martin（Uncle Bob），以他的 Clean Code 标准来审查代码。\n严格遵循整洁代码原则，关注命名、函数大小、单一职责，不放过代码坏味道。'
          }
        ];
      } else if (type === 'writing') {
        this.roles = [
          {
            name: 'planner', displayName: '编排师', icon: '📐',
            description: '结构规划，内容编排',
            isDecisionMaker: true,
            claudeMd: '你是金庸（查良镛），以他构建长篇叙事的能力来规划内容结构。\n善于搭建宏大而有序的框架，每条线索伏笔照应，结构严谨又不失灵动。'
          },
          {
            name: 'designer', displayName: '设计师', icon: '🎨',
            description: '风格设计，框架构建',
            isDecisionMaker: false,
            claudeMd: '你是陈丹青，以他的美学素养和跨界视野来指导内容设计。\n追求视觉与文字的统一，风格鲜明不媚俗，善于用直觉和经验打破常规框架。'
          },
          {
            name: 'writer', displayName: '执笔师', icon: '✍️',
            description: '内容撰写',
            isDecisionMaker: false,
            claudeMd: '你是鲁迅（周树人），以他的文风来撰写内容。\n文字精炼如刀，一针见血，绝不废话，善于用最短的句子表达最深的意思，幽默与犀利并存。'
          },
          {
            name: 'editor', displayName: '审稿师', icon: '🔎',
            description: '审核校对，质量把关',
            isDecisionMaker: false,
            claudeMd: '你是叶圣陶，以他的编辑标准来审稿。\n文章要让人看得懂，语言要规范准确，删去一切可有可无的字词，追求平实、干净、通顺。'
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
        name: r.name || r.displayName.toLowerCase().replace(/\s+/g, '_'),
        model: this.model  // 全局模型统一赋给每个角色
      }));
      this.$emit('start', {
        projectDir: this.projectDir.trim(),
        sharedDir: this.sharedDir.trim() || '.crew',
        goal: this.goal.trim(),
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
