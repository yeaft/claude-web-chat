/**
 * 帮帮团 (Expert Panel) — Frontend role metadata
 *
 * This file contains ONLY display metadata (id, name, title, icon, group, actions list).
 * Message templates live in agent/expert-roles.js (agent-side).
 */

export const EXPERT_TEAMS = {
  dev: { id: 'dev', name: '软件开发', nameEn: 'Software Dev', icon: '🖥️', order: 0 },
  trading: { id: 'trading', name: '交易', nameEn: 'Trading', icon: '📈', order: 1, adminOnly: true },
  writing: { id: 'writing', name: '写作', nameEn: 'Writing', icon: '✍️', order: 2, adminOnly: true },
  video: { id: 'video', name: '视频', nameEn: 'Video', icon: '🎬', order: 3, adminOnly: true }
};

export const EXPERT_ROLES = {
  // ============================================================
  // 🖥️ 软件开发团队 (12 roles)
  // ============================================================
  jobs: {
    id: 'jobs',
    name: 'Jobs',
    fullName: 'Steve Jobs',
    title: '产品经理',
    titleEn: 'Product Manager',
    group: 'dev',
    actions: [
      { id: 'product-analysis', name: '产品分析', nameEn: 'Product Analysis' },
      { id: 'design-review', name: '设计审查', nameEn: 'Design Review' },
      { id: 'requirements', name: '需求拆解', nameEn: 'Requirements' }
    ]
  },
  fowler: {
    id: 'fowler',
    name: 'Fowler',
    fullName: 'Martin Fowler',
    title: '软件架构师',
    titleEn: 'Software Architect',
    group: 'dev',
    actions: [
      { id: 'architecture', name: '架构审查', nameEn: 'Architecture Review' },
      { id: 'refactoring', name: '重构分析', nameEn: 'Refactoring' },
      { id: 'code-review', name: '代码审查', nameEn: 'Code Review' }
    ]
  },
  torvalds: {
    id: 'torvalds',
    name: 'Torvalds',
    fullName: 'Linus Torvalds',
    title: '系统开发工程师',
    titleEn: 'Systems Engineer',
    group: 'dev',
    actions: [
      { id: 'system-design', name: '系统设计', nameEn: 'System Design' },
      { id: 'performance', name: '性能优化', nameEn: 'Performance' },
      { id: 'code-style', name: '代码风格', nameEn: 'Code Style' },
      { id: 'implementation', name: '代码实现', nameEn: 'Implementation' }
    ]
  },
  beck: {
    id: 'beck',
    name: 'Beck',
    fullName: 'Kent Beck',
    title: '测试工程师',
    titleEn: 'Test Engineer',
    group: 'dev',
    actions: [
      { id: 'test-strategy', name: '测试策略', nameEn: 'Test Strategy' },
      { id: 'tdd-guide', name: 'TDD 指导', nameEn: 'TDD Guide' },
      { id: 'quality-check', name: '质量评估', nameEn: 'Quality Check' }
    ]
  },
  schneier: {
    id: 'schneier',
    name: 'Schneier',
    fullName: 'Bruce Schneier',
    title: '安全工程师',
    titleEn: 'Security Engineer',
    group: 'dev',
    actions: [
      { id: 'security-audit', name: '安全审计', nameEn: 'Security Audit' },
      { id: 'threat-model', name: '威胁建模', nameEn: 'Threat Model' },
      { id: 'auth-review', name: '认证审查', nameEn: 'Auth Review' }
    ]
  },
  rams: {
    id: 'rams',
    name: 'Rams',
    fullName: 'Dieter Rams',
    title: 'UI/UX 设计师',
    titleEn: 'UI/UX Designer',
    group: 'dev',
    actions: [
      { id: 'ui-review', name: '界面审查', nameEn: 'UI Review' },
      { id: 'interaction', name: '交互设计', nameEn: 'Interaction Design' },
      { id: 'layout', name: '布局优化', nameEn: 'Layout Optimization' }
    ]
  },
  graham: {
    id: 'graham',
    name: 'Graham',
    fullName: 'Paul Graham',
    title: '技术写作 / 方案评估师',
    titleEn: 'Tech Writer / Evaluator',
    group: 'dev',
    actions: [
      { id: 'writing', name: '技术写作', nameEn: 'Tech Writing' },
      { id: 'proposal-review', name: '方案评估', nameEn: 'Proposal Review' },
      { id: 'explain', name: '概念解释', nameEn: 'Explain' }
    ]
  },
  hightower: {
    id: 'hightower',
    name: 'Hightower',
    fullName: 'Kelsey Hightower',
    title: 'DevOps / 运维工程师',
    titleEn: 'DevOps Engineer',
    group: 'dev',
    actions: [
      { id: 'deployment', name: '部署审查', nameEn: 'Deployment Review' },
      { id: 'cicd', name: 'CI/CD 评估', nameEn: 'CI/CD Review' },
      { id: 'infra', name: '基础设施', nameEn: 'Infrastructure' }
    ]
  },
  gregg: {
    id: 'gregg',
    name: 'Gregg',
    fullName: 'Brendan Gregg',
    title: '性能工程师',
    titleEn: 'Performance Engineer',
    group: 'dev',
    actions: [
      { id: 'perf-analysis', name: '性能分析', nameEn: 'Perf Analysis' },
      { id: 'tuning', name: '系统调优', nameEn: 'Tuning' },
      { id: 'benchmark', name: '基准测试', nameEn: 'Benchmark' }
    ]
  },
  codd: {
    id: 'codd',
    name: 'Codd',
    fullName: 'Edgar Codd',
    title: '数据库 / SQL 专家',
    titleEn: 'Database / SQL Expert',
    group: 'dev',
    actions: [
      { id: 'sql-optimization', name: 'SQL 优化', nameEn: 'SQL Optimization' },
      { id: 'schema-design', name: 'Schema 设计', nameEn: 'Schema Design' },
      { id: 'data-modeling', name: '数据建模', nameEn: 'Data Modeling' }
    ]
  },
  knuth: {
    id: 'knuth',
    name: 'Knuth',
    fullName: 'Donald Knuth',
    title: '算法 / 数据处理专家',
    titleEn: 'Algorithm Expert',
    group: 'dev',
    actions: [
      { id: 'algorithm-design', name: '算法设计', nameEn: 'Algorithm Design' },
      { id: 'data-processing', name: '数据处理', nameEn: 'Data Processing' },
      { id: 'optimization', name: '优化', nameEn: 'Optimization' }
    ]
  },
  thomas: {
    id: 'thomas',
    name: 'Thomas',
    fullName: 'Dave Thomas',
    title: '技术文档工程师',
    titleEn: 'Tech Doc Engineer',
    group: 'dev',
    actions: [
      { id: 'api-docs', name: 'API 文档', nameEn: 'API Docs' },
      { id: 'readme', name: 'README', nameEn: 'README' },
      { id: 'comment-review', name: '注释审查', nameEn: 'Comment Review' }
    ]
  },

  // ============================================================
  // 📈 交易团队 (6 roles)
  // ============================================================
  soros: {
    id: 'soros',
    name: 'Soros',
    fullName: 'George Soros',
    title: '宏观策略师',
    titleEn: 'Macro Strategist',
    group: 'trading',
    actions: [
      { id: 'macro-analysis', name: '宏观分析', nameEn: 'Macro Analysis' },
      { id: 'risk-assessment', name: '风险评估', nameEn: 'Risk Assessment' },
      { id: 'thesis-review', name: '论点审查', nameEn: 'Thesis Review' }
    ]
  },
  livermore: {
    id: 'livermore',
    name: 'Livermore',
    fullName: 'Jesse Livermore',
    title: '技术分析师',
    titleEn: 'Technical Analyst',
    group: 'trading',
    actions: [
      { id: 'price-action', name: '价格行为', nameEn: 'Price Action' },
      { id: 'pattern-recognition', name: '图形识别', nameEn: 'Pattern Recognition' },
      { id: 'trade-plan', name: '交易计划', nameEn: 'Trade Plan' }
    ]
  },
  dalio: {
    id: 'dalio',
    name: 'Dalio',
    fullName: 'Ray Dalio',
    title: '研究员 / 经济分析师',
    titleEn: 'Research / Economist',
    group: 'trading',
    actions: [
      { id: 'economic-analysis', name: '经济分析', nameEn: 'Economic Analysis' },
      { id: 'portfolio-review', name: '组合审查', nameEn: 'Portfolio Review' },
      { id: 'research-report', name: '研究报告', nameEn: 'Research Report' }
    ]
  },
  taleb: {
    id: 'taleb',
    name: 'Taleb',
    fullName: 'Nassim Taleb',
    title: '风控官',
    titleEn: 'Risk Manager',
    group: 'trading',
    actions: [
      { id: 'risk-audit', name: '风险审计', nameEn: 'Risk Audit' },
      { id: 'antifragile', name: '反脆弱评估', nameEn: 'Antifragile Assessment' },
      { id: 'stress-test', name: '压力测试', nameEn: 'Stress Test' }
    ]
  },
  jones: {
    id: 'jones',
    name: 'Jones',
    fullName: 'Paul Tudor Jones',
    title: '交易执行员',
    titleEn: 'Trade Executor',
    group: 'trading',
    actions: [
      { id: 'execution', name: '执行计划', nameEn: 'Execution Plan' },
      { id: 'position-sizing', name: '仓位计算', nameEn: 'Position Sizing' },
      { id: 'trade-review', name: '交易复盘', nameEn: 'Trade Review' }
    ]
  },
  simons: {
    id: 'simons',
    name: 'Simons',
    fullName: 'Jim Simons',
    title: '量化分析师',
    titleEn: 'Quant Analyst',
    group: 'trading',
    actions: [
      { id: 'quant-signal', name: '量化信号', nameEn: 'Quant Signal' },
      { id: 'backtest-review', name: '回测审查', nameEn: 'Backtest Review' },
      { id: 'model-design', name: '模型设计', nameEn: 'Model Design' }
    ]
  },

  // ============================================================
  // ✍️ 写作团队 (4 roles)
  // ============================================================
  sanderson: {
    id: 'sanderson',
    name: 'Sanderson',
    fullName: 'Brandon Sanderson',
    title: '小说架构师',
    titleEn: 'Story Architect',
    group: 'writing',
    actions: [
      { id: 'story-structure', name: '故事结构', nameEn: 'Story Structure' },
      { id: 'world-building', name: '世界观', nameEn: 'World Building' },
      { id: 'outline', name: '大纲设计', nameEn: 'Outline' }
    ]
  },
  patterson: {
    id: 'patterson',
    name: 'Patterson',
    fullName: 'James Patterson',
    title: '节奏设计师',
    titleEn: 'Pacing Designer',
    group: 'writing',
    actions: [
      { id: 'pacing', name: '节奏分析', nameEn: 'Pacing' },
      { id: 'chapter-hooks', name: '章节钩子', nameEn: 'Chapter Hooks' },
      { id: 'tension-curve', name: '张力曲线', nameEn: 'Tension Curve' }
    ]
  },
  pratchett: {
    id: 'pratchett',
    name: 'Pratchett',
    fullName: 'Terry Pratchett',
    title: '幽默写手',
    titleEn: 'Humor Writer',
    group: 'writing',
    actions: [
      { id: 'dialogue', name: '对话优化', nameEn: 'Dialogue' },
      { id: 'humor', name: '幽默元素', nameEn: 'Humor' },
      { id: 'voice-check', name: '叙事声音', nameEn: 'Voice Check' }
    ]
  },
  tolkien: {
    id: 'tolkien',
    name: 'Tolkien',
    fullName: 'J.R.R. Tolkien',
    title: '编辑 / 设定审校',
    titleEn: 'Editor / Continuity',
    group: 'writing',
    actions: [
      { id: 'continuity-check', name: '一致性检查', nameEn: 'Continuity Check' },
      { id: 'prose-polish', name: '文笔润色', nameEn: 'Prose Polish' },
      { id: 'logic-review', name: '逻辑审查', nameEn: 'Logic Review' }
    ]
  },

  // ============================================================
  // 🎬 视频团队 (4 roles)
  // ============================================================
  kubrick: {
    id: 'kubrick',
    name: 'Kubrick',
    fullName: 'Stanley Kubrick',
    title: '导演 / 视觉总监',
    titleEn: 'Director / Visual Director',
    group: 'video',
    actions: [
      { id: 'narrative-pacing', name: '叙事节奏', nameEn: 'Narrative Pacing' },
      { id: 'visual-concept', name: '视觉概念', nameEn: 'Visual Concept' },
      { id: 'scene-breakdown', name: '场景拆解', nameEn: 'Scene Breakdown' }
    ]
  },
  kaufman: {
    id: 'kaufman',
    name: 'Kaufman',
    fullName: 'Charlie Kaufman',
    title: '编剧',
    titleEn: 'Screenwriter',
    group: 'video',
    actions: [
      { id: 'script-writing', name: '脚本写作', nameEn: 'Script Writing' },
      { id: 'character-design', name: '角色设计', nameEn: 'Character Design' },
      { id: 'narrative-structure', name: '叙事结构', nameEn: 'Narrative Structure' }
    ]
  },
  spielberg: {
    id: 'spielberg',
    name: 'Spielberg',
    fullName: 'Steven Spielberg',
    title: '分镜 / 视觉叙事师',
    titleEn: 'Storyboard / Visual Storyteller',
    group: 'video',
    actions: [
      { id: 'storyboard', name: '分镜设计', nameEn: 'Storyboard' },
      { id: 'shot-design', name: '镜头方案', nameEn: 'Shot Design' },
      { id: 'visual-storytelling', name: '视觉叙事', nameEn: 'Visual Storytelling' }
    ]
  },
  schoonmaker: {
    id: 'schoonmaker',
    name: 'Schoonmaker',
    fullName: 'Thelma Schoonmaker',
    title: '剪辑师',
    titleEn: 'Editor',
    group: 'video',
    actions: [
      { id: 'editing-rhythm', name: '剪辑节奏', nameEn: 'Editing Rhythm' },
      { id: 'sequence-design', name: '序列设计', nameEn: 'Sequence Design' },
      { id: 'final-cut', name: '最终审片', nameEn: 'Final Cut' }
    ]
  }
};

/**
 * Get all roles grouped by team
 * @returns {{ teamId: string, team: object, roles: object[] }[]}
 */
export function getRolesByTeam() {
  const teamOrder = Object.values(EXPERT_TEAMS).sort((a, b) => a.order - b.order);
  return teamOrder.map(team => ({
    teamId: team.id,
    team,
    roles: Object.values(EXPERT_ROLES).filter(r => r.group === team.id)
  }));
}

/**
 * Build autocomplete items for @ mention search.
 * Returns flat list of { roleId, roleName, actionId?, actionName?, searchText, displayText }
 */
export function buildAutocompleteItems() {
  const items = [];
  for (const role of Object.values(EXPERT_ROLES)) {
    // Pure role entry (no action)
    items.push({
      roleId: role.id,
      roleName: role.name,
      roleTitle: role.title,
      actionId: null,
      actionName: null,
      searchText: `${role.name} ${role.fullName} ${role.title} ${role.titleEn}`.toLowerCase(),
      displayText: role.name,
      group: role.group
    });
    // Role + Action entries
    for (const action of role.actions) {
      items.push({
        roleId: role.id,
        roleName: role.name,
        roleTitle: role.title,
        actionId: action.id,
        actionName: action.name,
        searchText: `${role.name} ${role.fullName} ${role.title} ${action.name} ${action.nameEn}`.toLowerCase(),
        displayText: `${role.name}\u00B7${action.name}`,
        group: role.group
      });
    }
  }
  return items;
}

/**
 * Get display label for a selection { role, action }
 */
export function getSelectionLabel(selection) {
  const role = EXPERT_ROLES[selection.role];
  if (!role) return selection.role;
  if (selection.action) {
    const action = role.actions.find(a => a.id === selection.action);
    return action ? `${role.name}\u00B7${action.name}` : role.name;
  }
  return role.name;
}

/**
 * Default team to load when panel first opens
 */
export const DEFAULT_TEAM = 'dev';

/**
 * Maximum number of expert selections allowed
 */
export const MAX_SELECTIONS = 3;

/**
 * Get teams visible to the current user.
 * Non-admin users only see teams without adminOnly flag.
 * @param {boolean} isAdmin
 * @returns {object[]} sorted team list
 */
export function getVisibleTeams(isAdmin) {
  return Object.values(EXPERT_TEAMS)
    .filter(team => isAdmin || !team.adminOnly)
    .sort((a, b) => a.order - b.order);
}
