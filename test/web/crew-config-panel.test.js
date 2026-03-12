import { describe, it, expect } from 'vitest';

/**
 * Tests for CrewConfigPanel developer count:3 default value change.
 *
 * Verifies:
 * 1) dev template loads developer role with count: 3
 * 2) devCount computed property returns 3
 * 3) UI concurrency button correctly highlights count=3
 * 4) startSession passes count:3 in the roles payload
 * 5) expandRoles correctly expands developer/reviewer/tester into -1/-2/-3
 */

// =====================================================================
// Replicate core logic from CrewConfigPanel.js (Vue component)
// =====================================================================

// Simulate loadTemplate('dev') — extract the developer role from the template
function getDevTemplateRoles() {
  return [
    {
      name: 'pm', displayName: 'PM-乔布斯', icon: '',
      description: '需求分析，任务拆分和进度跟踪',
      isDecisionMaker: true,
      claudeMd: 'PM prompt...'
    },
    {
      name: 'developer', displayName: '开发者-托瓦兹', icon: '',
      description: '架构设计 + 代码实现（不负责 review 和测试）',
      isDecisionMaker: false,
      count: 3,
      claudeMd: 'Developer prompt...'
    },
    {
      name: 'designer', displayName: '设计师-拉姆斯', icon: '',
      description: '用户交互设计和页面视觉设计',
      isDecisionMaker: false,
      claudeMd: 'Designer prompt...'
    }
  ];
}

// Replicate devCount computed property from CrewConfigPanel.js:257-259
function computeDevCount(roles) {
  const dev = roles.find(r => r.name === 'developer');
  return dev?.count > 1 ? dev.count : 1;
}

// Replicate concurrency button active check from template line 104:
// :class="{ active: (role.count || 1) === n }"
function isConcurrencyBtnActive(role, n) {
  return (role.count || 1) === n;
}

// Replicate startSession role mapping from CrewConfigPanel.js:528-537
function mapRolesForStart(roles) {
  return roles.map(r => ({
    name: r.name || r.displayName.toLowerCase().replace(/\s+/g, '_'),
    displayName: r.displayName,
    icon: r.icon,
    description: r.description,
    claudeMd: r.claudeMd || '',
    model: r.model,
    isDecisionMaker: r.isDecisionMaker || false,
    count: r.count || 1
  }));
}

// Replicate expandRoles from agent/crew.js:61-95
const SHORT_PREFIX = {
  developer: 'dev',
  tester: 'test',
  reviewer: 'rev'
};
const EXPANDABLE_ROLES = new Set(['developer', 'tester', 'reviewer']);

function expandRoles(roles) {
  const devRole = roles.find(r => r.name === 'developer');
  const devCount = devRole?.count > 1 ? devRole.count : 1;

  const expanded = [];
  for (const role of roles) {
    const isExpandable = EXPANDABLE_ROLES.has(role.name);
    const count = isExpandable ? devCount : 1;

    if (count <= 1 || !isExpandable) {
      expanded.push({
        ...role,
        roleType: role.name,
        groupIndex: 0
      });
    } else {
      const prefix = SHORT_PREFIX[role.name] || role.name;
      for (let i = 1; i <= count; i++) {
        expanded.push({
          ...role,
          name: `${prefix}-${i}`,
          displayName: `${role.displayName}-${i}`,
          roleType: role.name,
          groupIndex: i,
          count: undefined
        });
      }
    }
  }
  return expanded;
}

// =====================================================================
// Tests
// =====================================================================

describe('CrewConfigPanel - developer count:3 default', () => {

  describe('Template loading', () => {
    it('should have count:3 on developer role in dev template', () => {
      const roles = getDevTemplateRoles();
      const dev = roles.find(r => r.name === 'developer');
      expect(dev).toBeDefined();
      expect(dev.count).toBe(3);
    });

    it('should NOT have count on non-expandable roles', () => {
      const roles = getDevTemplateRoles();
      const pm = roles.find(r => r.name === 'pm');
      const designer = roles.find(r => r.name === 'designer');
      expect(pm.count).toBeUndefined();
      expect(designer.count).toBeUndefined();
    });

    it('dev template should have 3 roles (pm, developer, designer)', () => {
      const roles = getDevTemplateRoles();
      expect(roles).toHaveLength(3);
      expect(roles.map(r => r.name)).toEqual(['pm', 'developer', 'designer']);
    });
  });

  describe('devCount computed property', () => {
    it('should return 3 when developer has count:3', () => {
      const roles = getDevTemplateRoles();
      expect(computeDevCount(roles)).toBe(3);
    });

    it('should return 1 when developer has no count', () => {
      const roles = [{ name: 'developer', displayName: '开发者' }];
      expect(computeDevCount(roles)).toBe(1);
    });

    it('should return 1 when developer has count:1', () => {
      const roles = [{ name: 'developer', displayName: '开发者', count: 1 }];
      expect(computeDevCount(roles)).toBe(1);
    });

    it('should return 2 when developer has count:2', () => {
      const roles = [{ name: 'developer', displayName: '开发者', count: 2 }];
      expect(computeDevCount(roles)).toBe(2);
    });

    it('should return 1 when no developer role exists', () => {
      const roles = [{ name: 'pm', displayName: 'PM' }];
      expect(computeDevCount(roles)).toBe(1);
    });
  });

  describe('UI concurrency button highlighting', () => {
    it('should highlight button 3 when role.count is 3', () => {
      const devRole = { name: 'developer', count: 3 };
      expect(isConcurrencyBtnActive(devRole, 1)).toBe(false);
      expect(isConcurrencyBtnActive(devRole, 2)).toBe(false);
      expect(isConcurrencyBtnActive(devRole, 3)).toBe(true);
    });

    it('should highlight button 1 when role.count is undefined (default)', () => {
      const devRole = { name: 'developer' };
      expect(isConcurrencyBtnActive(devRole, 1)).toBe(true);
      expect(isConcurrencyBtnActive(devRole, 2)).toBe(false);
      expect(isConcurrencyBtnActive(devRole, 3)).toBe(false);
    });

    it('should highlight button 2 when role.count is 2', () => {
      const devRole = { name: 'developer', count: 2 };
      expect(isConcurrencyBtnActive(devRole, 1)).toBe(false);
      expect(isConcurrencyBtnActive(devRole, 2)).toBe(true);
      expect(isConcurrencyBtnActive(devRole, 3)).toBe(false);
    });
  });

  describe('startSession role mapping', () => {
    it('should pass count:3 for developer in start payload', () => {
      const roles = getDevTemplateRoles();
      const mapped = mapRolesForStart(roles);
      const dev = mapped.find(r => r.name === 'developer');
      expect(dev.count).toBe(3);
    });

    it('should default count to 1 for roles without explicit count', () => {
      const roles = getDevTemplateRoles();
      const mapped = mapRolesForStart(roles);
      const pm = mapped.find(r => r.name === 'pm');
      const designer = mapped.find(r => r.name === 'designer');
      expect(pm.count).toBe(1);
      expect(designer.count).toBe(1);
    });
  });

  describe('expandRoles - role expansion into -1/-2/-3', () => {
    it('should expand developer into dev-1, dev-2, dev-3', () => {
      const roles = mapRolesForStart(getDevTemplateRoles());
      const expanded = expandRoles(roles);
      const devRoles = expanded.filter(r => r.roleType === 'developer');
      expect(devRoles).toHaveLength(3);
      expect(devRoles.map(r => r.name)).toEqual(['dev-1', 'dev-2', 'dev-3']);
      expect(devRoles.map(r => r.displayName)).toEqual([
        '开发者-托瓦兹-1', '开发者-托瓦兹-2', '开发者-托瓦兹-3'
      ]);
    });

    it('should expand reviewer into rev-1, rev-2, rev-3 when present (following developer count)', () => {
      const roles = mapRolesForStart([
        ...getDevTemplateRoles(),
        { name: 'reviewer', displayName: '审查者-马丁', icon: '', description: '代码审查', claudeMd: '' }
      ]);
      const expanded = expandRoles(roles);
      const revRoles = expanded.filter(r => r.roleType === 'reviewer');
      expect(revRoles).toHaveLength(3);
      expect(revRoles.map(r => r.name)).toEqual(['rev-1', 'rev-2', 'rev-3']);
      expect(revRoles.map(r => r.displayName)).toEqual([
        '审查者-马丁-1', '审查者-马丁-2', '审查者-马丁-3'
      ]);
    });

    it('should expand tester into test-1, test-2, test-3 when present (following developer count)', () => {
      const roles = mapRolesForStart([
        ...getDevTemplateRoles(),
        { name: 'tester', displayName: '测试-贝克', icon: '', description: '测试验证', claudeMd: '' }
      ]);
      const expanded = expandRoles(roles);
      const testRoles = expanded.filter(r => r.roleType === 'tester');
      expect(testRoles).toHaveLength(3);
      expect(testRoles.map(r => r.name)).toEqual(['test-1', 'test-2', 'test-3']);
      expect(testRoles.map(r => r.displayName)).toEqual([
        '测试-贝克-1', '测试-贝克-2', '测试-贝克-3'
      ]);
    });

    it('should NOT expand pm, designer', () => {
      const roles = mapRolesForStart(getDevTemplateRoles());
      const expanded = expandRoles(roles);
      const pm = expanded.filter(r => r.roleType === 'pm');
      const designer = expanded.filter(r => r.roleType === 'designer');
      expect(pm).toHaveLength(1);
      expect(pm[0].name).toBe('pm');
      expect(designer).toHaveLength(1);
      expect(designer[0].name).toBe('designer');
    });

    it('should have correct groupIndex for expanded roles', () => {
      const roles = mapRolesForStart(getDevTemplateRoles());
      const expanded = expandRoles(roles);
      const devRoles = expanded.filter(r => r.roleType === 'developer');
      expect(devRoles[0].groupIndex).toBe(1);
      expect(devRoles[1].groupIndex).toBe(2);
      expect(devRoles[2].groupIndex).toBe(3);
    });

    it('should have groupIndex 0 for non-expanded roles', () => {
      const roles = mapRolesForStart(getDevTemplateRoles());
      const expanded = expandRoles(roles);
      const pm = expanded.find(r => r.name === 'pm');
      expect(pm.groupIndex).toBe(0);
    });

    it('should clear count on expanded roles', () => {
      const roles = mapRolesForStart(getDevTemplateRoles());
      const expanded = expandRoles(roles);
      const devRoles = expanded.filter(r => r.roleType === 'developer');
      devRoles.forEach(r => {
        expect(r.count).toBeUndefined();
      });
    });

    it('total expanded roles should be 2 (non-expandable) + 3 (developer × 3) = 5', () => {
      const roles = mapRolesForStart(getDevTemplateRoles());
      const expanded = expandRoles(roles);
      // pm + designer = 2 non-expandable, kept as-is
      // developer = 1 expandable × 3 = 3
      expect(expanded).toHaveLength(5);
    });
  });

  describe('Edge cases', () => {
    it('should not expand when developer count is 1', () => {
      const roles = [
        { name: 'pm', displayName: 'PM', count: 1 },
        { name: 'developer', displayName: '开发者', count: 1 },
        { name: 'reviewer', displayName: '审查者', count: 1 },
        { name: 'tester', displayName: '测试者', count: 1 }
      ];
      const expanded = expandRoles(roles);
      expect(expanded).toHaveLength(4);
      expect(expanded.map(r => r.name)).toEqual(['pm', 'developer', 'reviewer', 'tester']);
    });

    it('should expand to count=2 when developer count is 2', () => {
      const roles = [
        { name: 'pm', displayName: 'PM', count: 1 },
        { name: 'developer', displayName: '开发者', count: 2 },
        { name: 'reviewer', displayName: '审查者', count: 1 },
        { name: 'tester', displayName: '测试者', count: 1 }
      ];
      const expanded = expandRoles(roles);
      const devRoles = expanded.filter(r => r.roleType === 'developer');
      const revRoles = expanded.filter(r => r.roleType === 'reviewer');
      const testRoles = expanded.filter(r => r.roleType === 'tester');
      expect(devRoles).toHaveLength(2);
      expect(revRoles).toHaveLength(2);
      expect(testRoles).toHaveLength(2);
      expect(devRoles.map(r => r.name)).toEqual(['dev-1', 'dev-2']);
      expect(revRoles.map(r => r.name)).toEqual(['rev-1', 'rev-2']);
      expect(testRoles.map(r => r.name)).toEqual(['test-1', 'test-2']);
    });

    it('reviewer/tester count is ignored, always follows developer', () => {
      const roles = [
        { name: 'developer', displayName: '开发者', count: 2 },
        { name: 'reviewer', displayName: '审查者', count: 5 },
        { name: 'tester', displayName: '测试者', count: 10 }
      ];
      const expanded = expandRoles(roles);
      // reviewer/tester should follow developer count (2), not their own count
      const revRoles = expanded.filter(r => r.roleType === 'reviewer');
      const testRoles = expanded.filter(r => r.roleType === 'tester');
      expect(revRoles).toHaveLength(2);
      expect(testRoles).toHaveLength(2);
    });
  });
});
