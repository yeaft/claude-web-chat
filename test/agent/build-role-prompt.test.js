import { describe, it, expect, vi } from 'vitest';

// Mock SDK to avoid side effects (buildRoleSystemPrompt doesn't use them)
vi.mock('../../agent/sdk/index.js', () => ({
  query: vi.fn(),
  Stream: vi.fn()
}));

import { buildRoleSystemPrompt } from '../../agent/crew/role-query.js';
import { getMessages } from '../../agent/crew-i18n.js';

// =====================================================================
// Helpers
// =====================================================================

function createDevSession(overrides = {}) {
  const roles = overrides.roles || new Map([
    ['pm', {
      name: 'pm', displayName: 'PM-乔布斯', icon: '📋',
      description: '需求分析，任务拆分和进度跟踪',
      isDecisionMaker: true, roleType: 'pm', groupIndex: 0
    }],
    ['dev-1', {
      name: 'dev-1', displayName: '开发者-托瓦兹-1', icon: '💻',
      description: '代码编写、架构设计和功能实现',
      isDecisionMaker: false, roleType: 'developer', groupIndex: 1
    }],
    ['rev-1', {
      name: 'rev-1', displayName: '审查者-马丁-1', icon: '🔍',
      description: '代码审查和质量把控',
      isDecisionMaker: false, roleType: 'reviewer', groupIndex: 1
    }],
    ['test-1', {
      name: 'test-1', displayName: '测试-贝克-1', icon: '🧪',
      description: '测试用例编写和质量验证',
      isDecisionMaker: false, roleType: 'tester', groupIndex: 1
    }],
    ['designer', {
      name: 'designer', displayName: '设计师-拉姆斯', icon: '🎨',
      description: '用户交互设计和页面视觉设计',
      isDecisionMaker: false, roleType: 'designer', groupIndex: 0
    }]
  ]);
  return {
    id: 'crew_dev_test',
    projectDir: '/tmp/test-project',
    sharedDir: '/tmp/test-project/.crew',
    roles,
    roleStates: new Map(),
    decisionMaker: 'pm',
    teamType: 'dev',
    language: overrides.language || 'zh-CN',
    status: 'running',
    round: 0,
    costUsd: 0,
    messageHistory: [],
    humanMessageQueue: [],
    waitingHumanContext: null,
    userId: 'user_123',
    username: 'testuser',
    createdAt: Date.now()
  };
}

function createWritingSession(overrides = {}) {
  const roles = new Map([
    ['planner', {
      name: 'planner', displayName: '架构师-桑德森', icon: '',
      description: '长篇故事架构，伏笔管理，世界观构建',
      isDecisionMaker: true, roleType: 'planner', groupIndex: 0
    }],
    ['designer', {
      name: 'designer', displayName: '节奏设计-帕特森', icon: '',
      description: '节奏设计，章尾钩子，情绪曲线规划',
      isDecisionMaker: false, roleType: 'designer', groupIndex: 0
    }],
    ['writer', {
      name: 'writer', displayName: '写手-普拉切特', icon: '',
      description: '犀利文笔，幽默中藏深度，对话鲜活',
      isDecisionMaker: false, roleType: 'writer', groupIndex: 0
    }],
    ['editor', {
      name: 'editor', displayName: '编辑-托尔金', icon: '',
      description: '设定一致性校验，逻辑严密性审查',
      isDecisionMaker: false, roleType: 'editor', groupIndex: 0
    }]
  ]);
  return {
    id: 'crew_writing_test',
    projectDir: '/tmp/test-project',
    sharedDir: '/tmp/test-project/.crew',
    roles,
    roleStates: new Map(),
    decisionMaker: 'planner',
    teamType: 'writing',
    language: overrides.language || 'zh-CN',
    status: 'running',
    round: 0,
    costUsd: 0,
    messageHistory: [],
    humanMessageQueue: [],
    waitingHumanContext: null,
    userId: 'user_123',
    username: 'testuser',
    createdAt: Date.now()
  };
}

function createTradingSession(overrides = {}) {
  const roles = new Map([
    ['strategist', {
      name: 'strategist', displayName: '策略师-索罗斯', icon: '',
      description: '反身性决策，宏观对冲',
      isDecisionMaker: true, roleType: 'strategist', groupIndex: 0
    }],
    ['analyst', {
      name: 'analyst', displayName: '分析师-利弗莫尔', icon: '',
      description: '价格行为分析，关键位识别',
      isDecisionMaker: false, roleType: 'analyst', groupIndex: 0
    }],
    ['macro', {
      name: 'macro', displayName: '研究员-达里奥', icon: '',
      description: '经济机器拆解，债务周期定位',
      isDecisionMaker: false, roleType: 'macro', groupIndex: 0
    }],
    ['risk', {
      name: 'risk', displayName: '风控-塔勒布', icon: '',
      description: '黑天鹅猎人，反脆弱架构师',
      isDecisionMaker: false, roleType: 'risk', groupIndex: 0
    }],
    ['trader', {
      name: 'trader', displayName: '交易员-琼斯', icon: '',
      description: '纪律执行机器，盘感猎手',
      isDecisionMaker: false, roleType: 'trader', groupIndex: 0
    }]
  ]);
  return {
    id: 'crew_trading_test',
    projectDir: '/tmp/test-project',
    sharedDir: '/tmp/test-project/.crew',
    roles,
    roleStates: new Map(),
    decisionMaker: 'strategist',
    teamType: 'trading',
    language: overrides.language || 'en',
    status: 'running',
    round: 0,
    costUsd: 0,
    messageHistory: [],
    humanMessageQueue: [],
    waitingHumanContext: null,
    userId: 'user_123',
    username: 'testuser',
    createdAt: Date.now()
  };
}

function createVideoSession(overrides = {}) {
  const roles = new Map([
    ['director', {
      name: 'director', displayName: '导演-贾樟柯', icon: '',
      description: '整体把控，叙事节奏，团队决策',
      isDecisionMaker: true, roleType: 'director', groupIndex: 0
    }],
    ['scriptwriter', {
      name: 'scriptwriter', displayName: '编剧-史铁生', icon: '',
      description: '脚本构思，叙事结构，台词文案',
      isDecisionMaker: false, roleType: 'scriptwriter', groupIndex: 0
    }],
    ['storyboard', {
      name: 'storyboard', displayName: '分镜师-徐克', icon: '',
      description: '分镜设计，视觉语言，镜头规划',
      isDecisionMaker: false, roleType: 'storyboard', groupIndex: 0
    }],
    ['editor', {
      name: 'editor', displayName: '剪辑师-顾长卫', icon: '',
      description: '最终 prompt 生成，节奏剪辑，一致性把控',
      isDecisionMaker: false, roleType: 'editor', groupIndex: 0
    }]
  ]);
  return {
    id: 'crew_video_test',
    projectDir: '/tmp/test-project',
    sharedDir: '/tmp/test-project/.crew',
    roles,
    roleStates: new Map(),
    decisionMaker: 'director',
    teamType: 'video',
    language: overrides.language || 'zh-CN',
    status: 'running',
    round: 0,
    costUsd: 0,
    messageHistory: [],
    humanMessageQueue: [],
    waitingHumanContext: null,
    userId: 'user_123',
    username: 'testuser',
    createdAt: Date.now()
  };
}

// =====================================================================
// Tests: ROUTE format injection for ALL team types
// =====================================================================

describe('buildRoleSystemPrompt — ROUTE format injection', () => {
  describe('dev team', () => {
    it('decision maker (PM) should get ROUTE format block', () => {
      const session = createDevSession();
      const pm = session.roles.get('pm');
      const prompt = buildRoleSystemPrompt(pm, session);

      expect(prompt).toContain('---ROUTE---');
      expect(prompt).toContain('---END_ROUTE---');
      expect(prompt).toContain('to: <roleName>');
      expect(prompt).toContain('summary:');
    });

    it('non-DM developer should get ROUTE format block', () => {
      const session = createDevSession();
      const dev = session.roles.get('dev-1');
      const prompt = buildRoleSystemPrompt(dev, session);

      expect(prompt).toContain('---ROUTE---');
      expect(prompt).toContain('---END_ROUTE---');
    });

    it('non-DM reviewer should get ROUTE format block', () => {
      const session = createDevSession();
      const rev = session.roles.get('rev-1');
      const prompt = buildRoleSystemPrompt(rev, session);

      expect(prompt).toContain('---ROUTE---');
      expect(prompt).toContain('---END_ROUTE---');
    });

    it('non-DM tester should get ROUTE format block', () => {
      const session = createDevSession();
      const test = session.roles.get('test-1');
      const prompt = buildRoleSystemPrompt(test, session);

      expect(prompt).toContain('---ROUTE---');
      expect(prompt).toContain('---END_ROUTE---');
    });

    it('designer should get ROUTE format block', () => {
      const session = createDevSession();
      const designer = session.roles.get('designer');
      const prompt = buildRoleSystemPrompt(designer, session);

      expect(prompt).toContain('---ROUTE---');
      expect(prompt).toContain('---END_ROUTE---');
    });
  });

  describe('writing team (non-dev)', () => {
    it('decision maker (planner) should get ROUTE format block', () => {
      const session = createWritingSession();
      const planner = session.roles.get('planner');
      const prompt = buildRoleSystemPrompt(planner, session);

      expect(prompt).toContain('---ROUTE---');
      expect(prompt).toContain('---END_ROUTE---');
      expect(prompt).toContain('to: <roleName>');
    });

    it('non-DM writer should get ROUTE format block', () => {
      const session = createWritingSession();
      const writer = session.roles.get('writer');
      const prompt = buildRoleSystemPrompt(writer, session);

      expect(prompt).toContain('---ROUTE---');
      expect(prompt).toContain('---END_ROUTE---');
    });

    it('non-DM editor should get ROUTE format block', () => {
      const session = createWritingSession();
      const editor = session.roles.get('editor');
      const prompt = buildRoleSystemPrompt(editor, session);

      expect(prompt).toContain('---ROUTE---');
      expect(prompt).toContain('---END_ROUTE---');
    });

    it('non-DM designer should get ROUTE format block', () => {
      const session = createWritingSession();
      const designer = session.roles.get('designer');
      const prompt = buildRoleSystemPrompt(designer, session);

      expect(prompt).toContain('---ROUTE---');
      expect(prompt).toContain('---END_ROUTE---');
    });
  });

  describe('trading team (non-dev, English)', () => {
    it('decision maker (strategist) should get ROUTE format block', () => {
      const session = createTradingSession();
      const strategist = session.roles.get('strategist');
      const prompt = buildRoleSystemPrompt(strategist, session);

      expect(prompt).toContain('---ROUTE---');
      expect(prompt).toContain('---END_ROUTE---');
    });

    it('non-DM analyst should get ROUTE format block', () => {
      const session = createTradingSession();
      const analyst = session.roles.get('analyst');
      const prompt = buildRoleSystemPrompt(analyst, session);

      expect(prompt).toContain('---ROUTE---');
      expect(prompt).toContain('---END_ROUTE---');
    });

    it('non-DM risk officer should get ROUTE format block', () => {
      const session = createTradingSession();
      const risk = session.roles.get('risk');
      const prompt = buildRoleSystemPrompt(risk, session);

      expect(prompt).toContain('---ROUTE---');
      expect(prompt).toContain('---END_ROUTE---');
    });
  });
});

// =====================================================================
// Tests: Route targets correctness
// =====================================================================

describe('buildRoleSystemPrompt — route targets', () => {
  it('PM should see all other roles as route targets', () => {
    const session = createDevSession();
    const pm = session.roles.get('pm');
    const prompt = buildRoleSystemPrompt(pm, session);

    expect(prompt).toContain('- dev-1:');
    expect(prompt).toContain('- rev-1:');
    expect(prompt).toContain('- test-1:');
    expect(prompt).toContain('- designer:');
    expect(prompt).not.toMatch(/- pm:.*PM/);
  });

  it('developer (groupIndex > 0) should only see same-group + groupIndex-0 roles', () => {
    const session = createDevSession();
    const dev = session.roles.get('dev-1');
    const prompt = buildRoleSystemPrompt(dev, session);

    // Same group (1): rev-1, test-1
    expect(prompt).toContain('- rev-1:');
    expect(prompt).toContain('- test-1:');
    // GroupIndex 0: pm, designer
    expect(prompt).toContain('- pm:');
    expect(prompt).toContain('- designer:');
    // Self should not appear
    expect(prompt).not.toMatch(/- dev-1:.*开发者/);
  });

  it('non-dev team roles (groupIndex 0) should see all other roles', () => {
    const session = createWritingSession();
    const writer = session.roles.get('writer');
    const prompt = buildRoleSystemPrompt(writer, session);

    expect(prompt).toContain('- planner:');
    expect(prompt).toContain('- designer:');
    expect(prompt).toContain('- editor:');
    expect(prompt).not.toMatch(/- writer:.*普拉切特/);
  });

  it('human target should always be listed', () => {
    const session = createDevSession();
    const dev = session.roles.get('dev-1');
    const prompt = buildRoleSystemPrompt(dev, session);

    expect(prompt).toContain('- human:');
  });
});

// =====================================================================
// Tests: Decision maker extra sections
// =====================================================================

describe('buildRoleSystemPrompt — decision maker sections', () => {
  it('dev team PM should get DM role, tool usage, workflow end, task list', () => {
    const session = createDevSession();
    const pm = session.roles.get('pm');
    const m = getMessages('zh-CN');
    const prompt = buildRoleSystemPrompt(pm, session);

    expect(prompt).toContain(m.dmRole);
    expect(prompt).toContain(m.toolUsage);
    expect(prompt).toContain(m.workflowEnd);
    expect(prompt).toContain(m.taskList);
  });

  it('dev team PM should get dmDevExtra but NOT collabMode', () => {
    const session = createDevSession();
    const pm = session.roles.get('pm');
    const m = getMessages('zh-CN');
    const prompt = buildRoleSystemPrompt(pm, session);

    // dmDevExtra is dev-specific
    expect(prompt).toContain('PM 不做代码分析');
    // collabMode is for non-dev teams only
    expect(prompt).not.toContain(m.collabMode);
  });

  it('writing team DM should get collabMode but NOT dmDevExtra', () => {
    const session = createWritingSession();
    const planner = session.roles.get('planner');
    const m = getMessages('zh-CN');
    const prompt = buildRoleSystemPrompt(planner, session);

    expect(prompt).toContain(m.collabMode);
    expect(prompt).toContain(m.collabModeContent);
    expect(prompt).not.toContain('PM 不做代码分析');
  });

  it('trading team DM (English) should get collabMode', () => {
    const session = createTradingSession();
    const strategist = session.roles.get('strategist');
    const m = getMessages('en');
    const prompt = buildRoleSystemPrompt(strategist, session);

    expect(prompt).toContain(m.collabMode);
    expect(prompt).toContain(m.collabModeContent);
  });

  it('non-DM in dev team should NOT get DM sections', () => {
    const session = createDevSession();
    const dev = session.roles.get('dev-1');
    const m = getMessages('zh-CN');
    const prompt = buildRoleSystemPrompt(dev, session);

    expect(prompt).not.toContain(m.dmRole);
    expect(prompt).not.toContain(m.toolUsage);
    expect(prompt).not.toContain(m.workflowEnd);
    expect(prompt).not.toContain(m.taskList);
  });
});

// =====================================================================
// Tests: collabMode for non-DM in non-dev teams
// =====================================================================

describe('buildRoleSystemPrompt — collabMode for non-DM non-dev roles', () => {
  it('writer (non-DM, writing team) should get collabMode', () => {
    const session = createWritingSession();
    const writer = session.roles.get('writer');
    const m = getMessages('zh-CN');
    const prompt = buildRoleSystemPrompt(writer, session);

    expect(prompt).toContain(m.collabMode);
    expect(prompt).toContain(m.collabModeContent);
  });

  it('editor (non-DM, writing team) should get collabMode', () => {
    const session = createWritingSession();
    const editor = session.roles.get('editor');
    const m = getMessages('zh-CN');
    const prompt = buildRoleSystemPrompt(editor, session);

    expect(prompt).toContain(m.collabMode);
  });

  it('analyst (non-DM, trading team, English) should get collabMode', () => {
    const session = createTradingSession();
    const analyst = session.roles.get('analyst');
    const m = getMessages('en');
    const prompt = buildRoleSystemPrompt(analyst, session);

    expect(prompt).toContain(m.collabMode);
    expect(prompt).toContain('collaborative discussion team');
  });

  it('risk officer (non-DM, trading team, English) should get collabMode', () => {
    const session = createTradingSession();
    const risk = session.roles.get('risk');
    const m = getMessages('en');
    const prompt = buildRoleSystemPrompt(risk, session);

    expect(prompt).toContain(m.collabMode);
  });

  it('developer (non-DM, dev team) should NOT get collabMode', () => {
    const session = createDevSession();
    const dev = session.roles.get('dev-1');
    const m = getMessages('zh-CN');
    const prompt = buildRoleSystemPrompt(dev, session);

    expect(prompt).not.toContain(m.collabMode);
  });

  it('reviewer (non-DM, dev team) should NOT get collabMode', () => {
    const session = createDevSession();
    const rev = session.roles.get('rev-1');
    const m = getMessages('zh-CN');
    const prompt = buildRoleSystemPrompt(rev, session);

    expect(prompt).not.toContain(m.collabMode);
  });
});

// =====================================================================
// Tests: Dev group binding
// =====================================================================

describe('buildRoleSystemPrompt — dev group binding', () => {
  it('developer with groupIndex > 0 should get group binding with reviewer+tester', () => {
    const session = createDevSession();
    const dev = session.roles.get('dev-1');
    const m = getMessages('zh-CN');
    const prompt = buildRoleSystemPrompt(dev, session);

    expect(prompt).toContain(m.devGroupBinding);
    expect(prompt).toContain('rev-1');
    expect(prompt).toContain('test-1');
    // Should contain ROUTE examples for reviewer and tester
    expect(prompt).toContain('to: rev-1');
    expect(prompt).toContain('to: test-1');
  });

  it('PM (groupIndex 0) should NOT get group binding', () => {
    const session = createDevSession();
    const pm = session.roles.get('pm');
    const m = getMessages('zh-CN');
    const prompt = buildRoleSystemPrompt(pm, session);

    expect(prompt).not.toContain(m.devGroupBinding);
  });

  it('reviewer (non-developer roleType) should NOT get group binding', () => {
    const session = createDevSession();
    const rev = session.roles.get('rev-1');
    const m = getMessages('zh-CN');
    const prompt = buildRoleSystemPrompt(rev, session);

    expect(prompt).not.toContain(m.devGroupBinding);
  });

  it('writing team roles should NOT get group binding', () => {
    const session = createWritingSession();
    const writer = session.roles.get('writer');
    const m = getMessages('zh-CN');
    const prompt = buildRoleSystemPrompt(writer, session);

    expect(prompt).not.toContain(m.devGroupBinding);
  });
});

// =====================================================================
// Tests: Feature record + context restart (all roles)
// =====================================================================

describe('buildRoleSystemPrompt — feature record injection', () => {
  it('all dev team roles should get feature record section', () => {
    const session = createDevSession();
    const m = getMessages('zh-CN');

    for (const [, role] of session.roles) {
      const prompt = buildRoleSystemPrompt(role, session);
      expect(prompt).toContain(m.featureRecordTitle);
      expect(prompt).toContain(m.contextRestartTitle);
    }
  });

  it('all writing team roles should get feature record section', () => {
    const session = createWritingSession();
    const m = getMessages('zh-CN');

    for (const [, role] of session.roles) {
      const prompt = buildRoleSystemPrompt(role, session);
      expect(prompt).toContain(m.featureRecordTitle);
      expect(prompt).toContain(m.contextRestartTitle);
    }
  });

  it('all trading team roles (English) should get feature record section', () => {
    const session = createTradingSession();
    const m = getMessages('en');

    for (const [, role] of session.roles) {
      const prompt = buildRoleSystemPrompt(role, session);
      expect(prompt).toContain(m.featureRecordTitle);
      expect(prompt).toContain(m.contextRestartTitle);
    }
  });
});

// =====================================================================
// Tests: Language instruction
// =====================================================================

describe('buildRoleSystemPrompt — language instruction', () => {
  it('zh-CN session should get Chinese language instruction', () => {
    const session = createDevSession({ language: 'zh-CN' });
    const pm = session.roles.get('pm');
    const prompt = buildRoleSystemPrompt(pm, session);

    expect(prompt).toContain('# Language');
    expect(prompt).toContain('中文');
  });

  it('en session should get English language instruction', () => {
    const session = createTradingSession({ language: 'en' });
    const strategist = session.roles.get('strategist');
    const prompt = buildRoleSystemPrompt(strategist, session);

    expect(prompt).toContain('# Language');
    expect(prompt).toContain('Always respond in English');
  });
});

// =====================================================================
// Tests: Parallel dispatch (DM of multi-instance dev team)
// =====================================================================

describe('buildRoleSystemPrompt — parallel dispatch for dev PM', () => {
  it('PM with multi-instance dev team should get parallel rules', () => {
    const session = createDevSession();
    const pm = session.roles.get('pm');
    const m = getMessages('zh-CN');
    const prompt = buildRoleSystemPrompt(pm, session);

    expect(prompt).toContain(m.execGroupStatus);
    expect(prompt).toContain(m.parallelRules);
  });

  it('writing team DM should NOT get parallel rules (no multi-instance)', () => {
    const session = createWritingSession();
    const planner = session.roles.get('planner');
    const m = getMessages('zh-CN');
    const prompt = buildRoleSystemPrompt(planner, session);

    expect(prompt).not.toContain(m.execGroupStatus);
    expect(prompt).not.toContain(m.parallelRules);
  });
});

// =====================================================================
// Tests: Team-specific collaboration flow for non-DM roles
// =====================================================================

describe('buildRoleSystemPrompt — team-specific collaboration flow', () => {
  describe('writing team (zh-CN)', () => {
    it('writer should get writer-specific collaboration suggestions', () => {
      const session = createWritingSession();
      const writer = session.roles.get('writer');
      const m = getMessages('zh-CN');
      const prompt = buildRoleSystemPrompt(writer, session);

      expect(prompt).toContain(m.teamCollabFlowTitle);
      expect(prompt).toContain('审稿师');
      expect(prompt).toContain('planner');
    });

    it('designer should get designer_writing-specific suggestions (disambiguated)', () => {
      const session = createWritingSession();
      const designer = session.roles.get('designer');
      const m = getMessages('zh-CN');
      const prompt = buildRoleSystemPrompt(designer, session);

      expect(prompt).toContain(m.teamCollabFlowTitle);
      expect(prompt).toContain('planner');
    });

    it('editor should get editor_writing-specific suggestions (disambiguated)', () => {
      const session = createWritingSession();
      const editor = session.roles.get('editor');
      const m = getMessages('zh-CN');
      const prompt = buildRoleSystemPrompt(editor, session);

      expect(prompt).toContain(m.teamCollabFlowTitle);
      expect(prompt).toContain('planner');
    });

    it('planner (DM) should NOT get team-specific flow', () => {
      const session = createWritingSession();
      const planner = session.roles.get('planner');
      const m = getMessages('zh-CN');
      const prompt = buildRoleSystemPrompt(planner, session);

      expect(prompt).not.toContain(m.teamCollabFlowTitle);
    });
  });

  describe('trading team (en)', () => {
    it('analyst should get analyst-specific collaboration suggestions', () => {
      const session = createTradingSession();
      const analyst = session.roles.get('analyst');
      const m = getMessages('en');
      const prompt = buildRoleSystemPrompt(analyst, session);

      expect(prompt).toContain(m.teamCollabFlowTitle);
      expect(prompt).toContain('strategist');
    });

    it('risk officer should get risk-specific collaboration suggestions', () => {
      const session = createTradingSession();
      const risk = session.roles.get('risk');
      const m = getMessages('en');
      const prompt = buildRoleSystemPrompt(risk, session);

      expect(prompt).toContain(m.teamCollabFlowTitle);
      expect(prompt).toContain('strategist');
    });

    it('strategist (DM) should NOT get team-specific flow', () => {
      const session = createTradingSession();
      const strategist = session.roles.get('strategist');
      const m = getMessages('en');
      const prompt = buildRoleSystemPrompt(strategist, session);

      expect(prompt).not.toContain(m.teamCollabFlowTitle);
    });
  });

  describe('video team (zh-CN)', () => {
    it('scriptwriter should get scriptwriter-specific suggestions', () => {
      const session = createVideoSession();
      const sw = session.roles.get('scriptwriter');
      const m = getMessages('zh-CN');
      const prompt = buildRoleSystemPrompt(sw, session);

      expect(prompt).toContain(m.teamCollabFlowTitle);
      expect(prompt).toContain('director');
    });

    it('storyboard should get storyboard-specific suggestions', () => {
      const session = createVideoSession();
      const sb = session.roles.get('storyboard');
      const m = getMessages('zh-CN');
      const prompt = buildRoleSystemPrompt(sb, session);

      expect(prompt).toContain(m.teamCollabFlowTitle);
      expect(prompt).toContain('director');
    });

    it('editor should get editor_video-specific suggestions (disambiguated)', () => {
      const session = createVideoSession();
      const editor = session.roles.get('editor');
      const m = getMessages('zh-CN');
      const prompt = buildRoleSystemPrompt(editor, session);

      expect(prompt).toContain(m.teamCollabFlowTitle);
      expect(prompt).toContain('director');
    });

    it('director (DM) should NOT get team-specific flow', () => {
      const session = createVideoSession();
      const director = session.roles.get('director');
      const m = getMessages('zh-CN');
      const prompt = buildRoleSystemPrompt(director, session);

      expect(prompt).not.toContain(m.teamCollabFlowTitle);
    });
  });

  describe('dev team', () => {
    it('developer should NOT get team-specific collaboration flow (uses group binding instead)', () => {
      const session = createDevSession();
      const dev = session.roles.get('dev-1');
      const m = getMessages('zh-CN');
      const prompt = buildRoleSystemPrompt(dev, session);

      expect(prompt).not.toContain(m.teamCollabFlowTitle);
    });

    it('reviewer should NOT get team-specific collaboration flow', () => {
      const session = createDevSession();
      const rev = session.roles.get('rev-1');
      const m = getMessages('zh-CN');
      const prompt = buildRoleSystemPrompt(rev, session);

      expect(prompt).not.toContain(m.teamCollabFlowTitle);
    });
  });
});
