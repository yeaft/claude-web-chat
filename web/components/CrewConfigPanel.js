/**
 * CrewConfigPanel - Crew 模式配置面板
 * 配置项目目标、角色、工作区等
 */

export default {
  name: 'CrewConfigPanel',
  template: `
    <div class="crew-config-overlay" @click.self="$emit('close')">
      <div class="crew-config-panel">
        <div class="crew-config-header">
          <h2>新建 Crew Session</h2>
          <button class="crew-config-close" @click="$emit('close')">&times;</button>
        </div>

        <div class="crew-config-body">
          <!-- 工作区配置 -->
          <div class="crew-config-section">
            <label class="crew-config-label">开发工作区</label>
            <input class="crew-config-input" v-model="projectDir" placeholder="/home/user/projects/app" />
          </div>

          <div class="crew-config-section">
            <label class="crew-config-label">共享内容区</label>
            <input class="crew-config-input" v-model="sharedDir" placeholder=".crew (相对于项目目录)" />
          </div>

          <!-- 任务目标 -->
          <div class="crew-config-section">
            <label class="crew-config-label">任务目标</label>
            <textarea class="crew-config-textarea" v-model="goal" placeholder="描述你想让团队完成的目标..." rows="3"></textarea>
          </div>

          <!-- 角色配置 -->
          <div class="crew-config-section">
            <label class="crew-config-label">角色配置</label>

            <div class="crew-roles-list">
              <div v-for="(role, idx) in roles" :key="idx" class="crew-role-item" :class="{ 'is-decision-maker': role.isDecisionMaker }">
                <div class="crew-role-header">
                  <input class="crew-role-icon-input" v-model="role.icon" maxlength="4" />
                  <input class="crew-role-name-input" v-model="role.displayName" placeholder="角色名" />
                  <select class="crew-role-model-select" v-model="role.model">
                    <option value="sonnet">Sonnet</option>
                    <option value="haiku">Haiku</option>
                    <option value="opus">Opus</option>
                  </select>
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

          <!-- 角色模板 -->
          <div class="crew-config-section">
            <label class="crew-config-label">角色模板</label>
            <div class="crew-template-btns">
              <button class="crew-template-btn" @click="loadTemplate('dev')" :class="{ active: currentTemplate === 'dev' }">软件开发</button>
              <button class="crew-template-btn" @click="loadTemplate('writing')" :class="{ active: currentTemplate === 'writing' }">写作团队</button>
            </div>
          </div>

          <!-- 高级设置 -->
          <div class="crew-config-section">
            <label class="crew-config-label">高级设置</label>
            <div class="crew-config-row">
              <label>最大轮次:</label>
              <input class="crew-config-input-sm" type="number" v-model.number="maxRounds" min="1" max="100" />
            </div>
          </div>
        </div>

        <div class="crew-config-footer">
          <span class="crew-config-hint" v-if="roles.length === 0">不添加角色也可以启动，之后在群聊中动态添加</span>
          <button class="crew-cancel-btn" @click="$emit('close')">取消</button>
          <button class="crew-start-btn" @click="startSession" :disabled="!canStart">启动 Session</button>
        </div>
      </div>
    </div>
  `,

  props: {
    defaultWorkDir: { type: String, default: '' }
  },

  emits: ['close', 'start'],

  data() {
    return {
      projectDir: this.defaultWorkDir || '',
      sharedDir: '.crew',
      goal: '',
      maxRounds: 20,
      currentTemplate: 'dev',
      roles: []
    };
  },

  computed: {
    canStart() {
      return this.projectDir.trim() && this.goal.trim();
    }
  },

  created() {
    this.loadTemplate('dev');
  },

  methods: {
    loadTemplate(type) {
      this.currentTemplate = type;
      if (type === 'dev') {
        this.roles = [
          {
            name: 'pm', displayName: 'PM', icon: '📋',
            description: '需求分析，任务拆分和进度跟踪',
            model: 'sonnet', isDecisionMaker: true,
            claudeMd: '你是 Steve Jobs（史蒂夫·乔布斯），以他的思维方式和工作风格来管理这个项目。\n追求极致简洁，对产品品质零容忍，善于从用户视角思考，敢于砍掉不必要的功能。'
          },
          {
            name: 'architect', displayName: '架构师', icon: '🏗️',
            description: '系统设计和技术决策',
            model: 'opus', isDecisionMaker: false,
            claudeMd: '你是 Martin Fowler（马丁·福勒），以他的架构哲学来设计系统。\n推崇演进式架构，重视重构和代码整洁，善用设计模式但不过度设计，用最合适而非最新的技术。'
          },
          {
            name: 'developer', displayName: '开发者', icon: '💻',
            description: '代码编写和功能实现',
            model: 'sonnet', isDecisionMaker: false,
            claudeMd: '你是 Linus Torvalds（林纳斯·托瓦兹），以他的编码风格来写代码。\n代码简洁高效，厌恶不必要的抽象，追求性能和正确性，注重实用主义而非教条。'
          },
          {
            name: 'reviewer', displayName: '审查者', icon: '🔍',
            description: '代码审查和质量把控',
            model: 'sonnet', isDecisionMaker: false,
            claudeMd: '你是 Robert C. Martin（Uncle Bob），以他的 Clean Code 标准来审查代码。\n严格遵循整洁代码原则，关注命名、函数大小、单一职责，不放过代码坏味道。'
          }
        ];
      } else if (type === 'writing') {
        this.roles = [
          {
            name: 'planner', displayName: '编排师', icon: '📐',
            description: '结构规划，内容编排',
            model: 'sonnet', isDecisionMaker: true,
            claudeMd: '你是金庸（查良镛），以他构建长篇叙事的能力来规划内容结构。\n善于搭建宏大而有序的框架，每条线索伏笔照应，结构严谨又不失灵动。'
          },
          {
            name: 'designer', displayName: '设计师', icon: '🎨',
            description: '风格设计，框架构建',
            model: 'sonnet', isDecisionMaker: false,
            claudeMd: '你是陈丹青，以他的美学素养和跨界视野来指导内容设计。\n追求视觉与文字的统一，风格鲜明不媚俗，善于用直觉和经验打破常规框架。'
          },
          {
            name: 'writer', displayName: '执笔师', icon: '✍️',
            description: '内容撰写',
            model: 'sonnet', isDecisionMaker: false,
            claudeMd: '你是鲁迅（周树人），以他的文风来撰写内容。\n文字精炼如刀，一针见血，绝不废话，善于用最短的句子表达最深的意思，幽默与犀利并存。'
          },
          {
            name: 'editor', displayName: '审稿师', icon: '🔎',
            description: '审核校对，质量把关',
            model: 'sonnet', isDecisionMaker: false,
            claudeMd: '你是叶圣陶，以他的编辑标准来审稿。\n文章要让人看得懂，语言要规范准确，删去一切可有可无的字词，追求平实、干净、通顺。'
          }
        ];
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
        model: 'sonnet',
        isDecisionMaker: false
      });
    },

    removeRole(idx) {
      const wasDecisionMaker = this.roles[idx].isDecisionMaker;
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
      // 生成 name 从 displayName
      const roles = this.roles.map(r => ({
        ...r,
        name: r.name || r.displayName.toLowerCase().replace(/\s+/g, '_')
      }));
      this.$emit('start', {
        projectDir: this.projectDir.trim(),
        sharedDir: this.sharedDir.trim() || '.crew',
        goal: this.goal.trim(),
        roles,
        maxRounds: this.maxRounds
      });
    }
  }
};
