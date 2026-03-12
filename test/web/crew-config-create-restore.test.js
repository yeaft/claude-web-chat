import { describe, it, expect } from 'vitest';

/**
 * Tests for CrewConfigPanel create/restore flow refactoring.
 *
 * Verifies pure business logic:
 * - crewExistsResult watcher state transitions
 * - triggerCrewCheck preconditions
 * - canStart computed
 * - restoreFromDisk logic
 * - startSession output
 * - builtin/custom role management
 */

// =====================================================================
// Replicate key logic from CrewConfigPanel.js for unit testing
// =====================================================================

// Simulate crewCheckState transitions based on store.crewExistsResult watcher
function simulateCrewExistsWatch(currentProjectDir, storeResult) {
  if (!storeResult) return null; // no update
  if (storeResult.projectDir === currentProjectDir.trim()) {
    if (storeResult.exists) {
      return { crewCheckState: 'exists', crewExistsSessionInfo: storeResult.sessionInfo };
    } else {
      return { crewCheckState: 'none', crewExistsSessionInfo: null };
    }
  }
  return null; // projectDir mismatch, no state change
}

// Simulate triggerCrewCheck — verifies the logic of when check is triggered
function shouldTriggerCheck(selectedAgent, projectDir) {
  return !!(projectDir?.trim()) && !!selectedAgent;
}

// Simulate canStart computed — when the start button is enabled
function computeCanStart(selectedAgent, projectDir, crewCheckState) {
  return !!selectedAgent && !!projectDir?.trim() && crewCheckState === 'none';
}

// Simulate restoreFromDisk logic
function simulateRestoreFromDisk(selectedAgent, crewExistsSessionInfo, projectDir) {
  const result = { action: null, agentId: null, sessionId: null, projectDir: null };
  if (!selectedAgent) return result;
  result.agentId = selectedAgent;

  const sessionId = crewExistsSessionInfo?.sessionId;
  if (sessionId) {
    result.action = 'resumeCrewSession';
    result.sessionId = sessionId;
  } else {
    result.action = 'sendWsMessage_resume';
    result.projectDir = projectDir?.trim();
  }
  return result;
}

// Simulate startSession output
function simulateStartSession(selectedAgent, projectDir, name, roles) {
  if (!selectedAgent || !projectDir?.trim()) return null;
  return {
    agentId: selectedAgent,
    projectDir: projectDir.trim(),
    sharedDir: '.crew',
    name: name?.trim() || '',
    roles: roles.map(r => ({
      name: r.name || r.displayName.toLowerCase().replace(/\s+/g, '_'),
      displayName: r.displayName,
      icon: r.icon,
      description: r.description,
      claudeMd: r.claudeMd || '',
      model: r.model,
      isDecisionMaker: r.isDecisionMaker || false,
      count: r.count || 1
    })),
  };
}

// BUILTIN_ROLES list (replicated from source)
const BUILTIN_ROLES = [
  { name: 'pm', displayName: 'PM-乔布斯', icon: '', description: '需求分析，任务拆分和进度跟踪', claudeMd: '' },
  { name: 'developer', displayName: '开发者-托瓦兹', icon: '', description: '代码编写、架构设计和功能实现', claudeMd: '', count: 1 },
  { name: 'reviewer', displayName: '审查者-马丁', icon: '', description: '代码审查和质量把控', claudeMd: '' },
  { name: 'tester', displayName: '测试-贝克', icon: '', description: '测试用例编写和质量验证', claudeMd: '' },
  { name: 'designer', displayName: '设计师-拉姆斯', icon: '', description: '用户交互设计和页面视觉设计', claudeMd: '' },
  { name: 'architect', displayName: '架构师-福勒', icon: '', description: '系统架构设计和技术决策', claudeMd: '' },
  { name: 'devops', displayName: '运维-凤凰', icon: '', description: 'CI/CD 流水线和部署管理', claudeMd: '' },
  { name: 'researcher', displayName: '研究员', icon: '', description: '技术调研和可行性分析', claudeMd: '' }
];

// Simulate availableBuiltinRoles computed — filter out already added roles
function computeAvailableBuiltinRoles(existingRoles) {
  const existingNames = new Set(existingRoles.map(r => r.name));
  return BUILTIN_ROLES.filter(r => !existingNames.has(r.name));
}

// Simulate addBuiltinRole
function addBuiltinRole(roles, builtinRole, isEditMode) {
  const newRoles = [...roles];
  newRoles.push({
    ...builtinRole,
    isDecisionMaker: newRoles.length === 0,
    _isNew: isEditMode
  });
  return newRoles;
}

// Simulate addCustomRole
function addCustomRole(roles, isEditMode) {
  const idx = roles.length + 1;
  const newRoles = [...roles];
  newRoles.push({
    name: 'role' + idx,
    displayName: 'Role ' + idx,
    icon: '',
    description: '',
    claudeMd: '',
    isDecisionMaker: newRoles.length === 0,
    _isNew: isEditMode
  });
  return newRoles;
}

// =====================================================================
// 1. .crew 目录检测消息链路
// =====================================================================
describe('CrewConfigPanel - .crew directory detection message chain', () => {

  describe('triggerCrewCheck preconditions', () => {
    it('should trigger check when both agent and projectDir are set', () => {
      expect(shouldTriggerCheck('agent-1', '/home/user/project')).toBe(true);
    });

    it('should NOT trigger check when agent is empty', () => {
      expect(shouldTriggerCheck('', '/home/user/project')).toBe(false);
    });

    it('should NOT trigger check when projectDir is empty', () => {
      expect(shouldTriggerCheck('agent-1', '')).toBe(false);
    });

    it('should NOT trigger check when projectDir is only whitespace', () => {
      expect(shouldTriggerCheck('agent-1', '   ')).toBe(false);
    });

    it('should NOT trigger check when both are empty', () => {
      expect(shouldTriggerCheck('', '')).toBe(false);
    });
  });

  describe('store.crewExistsResult watcher → crewCheckState', () => {
    it('should set crewCheckState to "exists" when .crew is found', () => {
      const result = simulateCrewExistsWatch('/home/user/project', {
        exists: true,
        projectDir: '/home/user/project',
        sessionInfo: { sessionId: 'crew_abc123', name: '前端重构组' }
      });
      expect(result).not.toBeNull();
      expect(result.crewCheckState).toBe('exists');
      expect(result.crewExistsSessionInfo).toEqual({ sessionId: 'crew_abc123', name: '前端重构组' });
    });

    it('should set crewCheckState to "none" when .crew is not found', () => {
      const result = simulateCrewExistsWatch('/home/user/project', {
        exists: false,
        projectDir: '/home/user/project',
        sessionInfo: null
      });
      expect(result).not.toBeNull();
      expect(result.crewCheckState).toBe('none');
      expect(result.crewExistsSessionInfo).toBeNull();
    });

    it('should NOT update crewCheckState when projectDir does not match', () => {
      const result = simulateCrewExistsWatch('/home/user/project-a', {
        exists: true,
        projectDir: '/home/user/project-b',
        sessionInfo: { sessionId: 'crew_xyz' }
      });
      expect(result).toBeNull();
    });

    it('should handle null result (no update)', () => {
      const result = simulateCrewExistsWatch('/home/user/project', null);
      expect(result).toBeNull();
    });

    it('should trim projectDir before comparison', () => {
      const result = simulateCrewExistsWatch('  /home/user/project  ', {
        exists: true,
        projectDir: '/home/user/project',
        sessionInfo: null
      });
      expect(result).not.toBeNull();
      expect(result.crewCheckState).toBe('exists');
    });
  });
});

// =====================================================================
// 2. .crew 存在时恢复 banner 和按钮
// =====================================================================
describe('CrewConfigPanel - restore flow when .crew exists', () => {

  describe('restore banner visibility', () => {
    it('should show restore banner when crewCheckState is "exists" and agent is selected', () => {
      const selectedAgent = 'agent-1';
      const crewCheckState = 'exists';
      const showBanner = !!selectedAgent && crewCheckState === 'exists';
      expect(showBanner).toBe(true);
    });

    it('should NOT show restore banner when crewCheckState is "none"', () => {
      const selectedAgent = 'agent-1';
      const crewCheckState = 'none';
      const showBanner = !!selectedAgent && crewCheckState === 'exists';
      expect(showBanner).toBe(false);
    });

    it('should NOT show restore banner when crewCheckState is "checking"', () => {
      const selectedAgent = 'agent-1';
      const crewCheckState = 'checking';
      const showBanner = !!selectedAgent && crewCheckState === 'exists';
      expect(showBanner).toBe(false);
    });

    it('should NOT show restore banner when agent is not selected', () => {
      const selectedAgent = '';
      const crewCheckState = 'exists';
      const showBanner = !!selectedAgent && crewCheckState === 'exists';
      expect(showBanner).toBe(false);
    });
  });

  describe('restoreFromDisk logic', () => {
    it('should call resumeCrewSession when sessionInfo has sessionId', () => {
      const result = simulateRestoreFromDisk('agent-1', { sessionId: 'crew_abc' }, '/project');
      expect(result.action).toBe('resumeCrewSession');
      expect(result.agentId).toBe('agent-1');
      expect(result.sessionId).toBe('crew_abc');
    });

    it('should send resume_crew_session ws message when no sessionId', () => {
      const result = simulateRestoreFromDisk('agent-1', {}, '/project');
      expect(result.action).toBe('sendWsMessage_resume');
      expect(result.agentId).toBe('agent-1');
      expect(result.projectDir).toBe('/project');
    });

    it('should send resume_crew_session ws message when sessionInfo is null', () => {
      const result = simulateRestoreFromDisk('agent-1', null, '/project');
      expect(result.action).toBe('sendWsMessage_resume');
      expect(result.projectDir).toBe('/project');
    });

    it('should do nothing when no agent is selected', () => {
      const result = simulateRestoreFromDisk('', { sessionId: 'crew_abc' }, '/project');
      expect(result.action).toBeNull();
    });

    it('should trim projectDir', () => {
      const result = simulateRestoreFromDisk('agent-1', null, '  /project  ');
      expect(result.projectDir).toBe('/project');
    });
  });

  describe('footer visibility on restore flow', () => {
    it('footer should NOT appear when crewCheckState is "exists"', () => {
      const isEditMode = false;
      const selectedAgent = 'agent-1';
      const crewCheckState = 'exists';
      const showFooter = isEditMode || (!!selectedAgent && crewCheckState === 'none');
      expect(showFooter).toBe(false);
    });
  });
});

// =====================================================================
// 3. .crew 不存在时正常创建流程
// =====================================================================
describe('CrewConfigPanel - create flow when .crew does not exist', () => {

  describe('create form visibility', () => {
    it('should show create form when crewCheckState is "none" and agent is selected', () => {
      const selectedAgent = 'agent-1';
      const crewCheckState = 'none';
      const showCreateForm = !!selectedAgent && crewCheckState === 'none';
      expect(showCreateForm).toBe(true);
    });

    it('should NOT show create form when crewCheckState is "exists"', () => {
      const selectedAgent = 'agent-1';
      const crewCheckState = 'exists';
      const showCreateForm = !!selectedAgent && crewCheckState === 'none';
      expect(showCreateForm).toBe(false);
    });

    it('should NOT show create form when crewCheckState is "checking"', () => {
      const selectedAgent = 'agent-1';
      const crewCheckState = 'checking';
      const showCreateForm = !!selectedAgent && crewCheckState === 'none';
      expect(showCreateForm).toBe(false);
    });

    it('should NOT show create form when crewCheckState is "idle"', () => {
      const selectedAgent = 'agent-1';
      const crewCheckState = 'idle';
      const showCreateForm = !!selectedAgent && crewCheckState === 'none';
      expect(showCreateForm).toBe(false);
    });
  });

  describe('canStart computed', () => {
    it('should return true when all conditions met', () => {
      expect(computeCanStart('agent-1', '/project', 'none')).toBe(true);
    });

    it('should return false when no agent', () => {
      expect(computeCanStart('', '/project', 'none')).toBe(false);
    });

    it('should return false when no projectDir', () => {
      expect(computeCanStart('agent-1', '', 'none')).toBe(false);
    });

    it('should return false when crewCheckState is not "none"', () => {
      expect(computeCanStart('agent-1', '/project', 'exists')).toBe(false);
      expect(computeCanStart('agent-1', '/project', 'checking')).toBe(false);
      expect(computeCanStart('agent-1', '/project', 'idle')).toBe(false);
    });
  });

  describe('startSession output', () => {
    it('should produce correct config shape on start', () => {
      const roles = [
        { name: 'pm', displayName: 'PM', icon: '', description: 'PM desc', isDecisionMaker: true }
      ];
      const result = simulateStartSession('agent-1', '/project', '团队A', roles);
      expect(result).not.toBeNull();
      expect(result.agentId).toBe('agent-1');
      expect(result.projectDir).toBe('/project');
      expect(result.sharedDir).toBe('.crew');
      expect(result.name).toBe('团队A');
      expect(result.roles).toHaveLength(1);
      expect(result.roles[0].name).toBe('pm');
      expect(result.roles[0].count).toBe(1);
    });

    it('should return null when agent not selected', () => {
      expect(simulateStartSession('', '/project', '', [])).toBeNull();
    });

    it('should return null when projectDir empty', () => {
      expect(simulateStartSession('agent-1', '', '', [])).toBeNull();
    });
  });
});

// =====================================================================
// 4. sharedDir — startSession always hardcodes ".crew"
// =====================================================================
describe('CrewConfigPanel - sharedDir removal', () => {

  it('startSession output should always have sharedDir: ".crew"', () => {
    const roles = [{ name: 'pm', displayName: 'PM', icon: '', description: '', isDecisionMaker: true }];
    const result = simulateStartSession('agent-1', '/project', '', roles);
    expect(result.sharedDir).toBe('.crew');
  });
});

// =====================================================================
// 5. addRole 按钮展示内置角色列表，自定义角色入口弱化
// =====================================================================
describe('CrewConfigPanel - addRole builtin role picker', () => {

  describe('BUILTIN_ROLES constant', () => {
    it('BUILTIN_ROLES should have 8 entries', () => {
      expect(BUILTIN_ROLES).toHaveLength(8);
    });
  });

  describe('availableBuiltinRoles computed', () => {
    it('should show all 8 builtin roles when no roles exist', () => {
      const available = computeAvailableBuiltinRoles([]);
      expect(available).toHaveLength(8);
    });

    it('should filter out already added roles', () => {
      const existing = [
        { name: 'pm', displayName: 'PM' },
        { name: 'developer', displayName: '开发者' }
      ];
      const available = computeAvailableBuiltinRoles(existing);
      expect(available).toHaveLength(6);
      expect(available.find(r => r.name === 'pm')).toBeUndefined();
      expect(available.find(r => r.name === 'developer')).toBeUndefined();
    });

    it('should return empty when all builtin roles are added', () => {
      const existing = BUILTIN_ROLES.map(r => ({ name: r.name }));
      const available = computeAvailableBuiltinRoles(existing);
      expect(available).toHaveLength(0);
    });
  });

  describe('addBuiltinRole behavior', () => {
    it('should add builtin role to roles list', () => {
      const roles = [{ name: 'pm', displayName: 'PM' }];
      const updated = addBuiltinRole(roles, BUILTIN_ROLES.find(r => r.name === 'developer'), false);
      expect(updated).toHaveLength(2);
      expect(updated[1].name).toBe('developer');
    });

    it('should set isDecisionMaker=true when adding to empty list', () => {
      const updated = addBuiltinRole([], BUILTIN_ROLES[0], false);
      expect(updated[0].isDecisionMaker).toBe(true);
    });

    it('should set isDecisionMaker=false when adding to non-empty list', () => {
      const roles = [{ name: 'pm', displayName: 'PM' }];
      const updated = addBuiltinRole(roles, BUILTIN_ROLES.find(r => r.name === 'developer'), false);
      expect(updated[1].isDecisionMaker).toBe(false);
    });

    it('should set _isNew=true in edit mode', () => {
      const roles = [{ name: 'pm', displayName: 'PM' }];
      const updated = addBuiltinRole(roles, BUILTIN_ROLES.find(r => r.name === 'developer'), true);
      expect(updated[1]._isNew).toBe(true);
    });

    it('should set _isNew=false in create mode', () => {
      const roles = [{ name: 'pm', displayName: 'PM' }];
      const updated = addBuiltinRole(roles, BUILTIN_ROLES.find(r => r.name === 'developer'), false);
      expect(updated[1]._isNew).toBe(false);
    });
  });

  describe('addCustomRole behavior (weakened entry)', () => {
    it('should create generic role with default values', () => {
      const roles = [{ name: 'pm', displayName: 'PM' }];
      const updated = addCustomRole(roles, false);
      expect(updated).toHaveLength(2);
      expect(updated[1].name).toBe('role2');
      expect(updated[1].displayName).toBe('Role 2');
      expect(updated[1].icon).toBe('');
      expect(updated[1].description).toBe('');
      expect(updated[1].claudeMd).toBe('');
    });

    it('should set isDecisionMaker=true when adding to empty list', () => {
      const updated = addCustomRole([], false);
      expect(updated[0].isDecisionMaker).toBe(true);
    });
  });
});
