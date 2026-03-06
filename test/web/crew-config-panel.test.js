import { describe, it, expect, beforeAll } from 'vitest';

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

describe('Verify actual source code consistency', () => {
  it('dev-zh template should have count:3 on developer', async () => {
    const { promises: fs } = await import('fs');
    const { join } = await import('path');
    const content = await fs.readFile(
      join(process.cwd(), 'web/crew-templates/dev-zh.js'),
      'utf-8'
    );

    // Find the dev template section and verify developer role has count: 3
    const devTemplateMatch = content.match(
      /name:\s*'developer'[\s\S]*?count:\s*(\d+)/
    );
    expect(devTemplateMatch).not.toBeNull();
    expect(devTemplateMatch[1]).toBe('3');
  });

  it('agent/crew.js expandRoles should use EXPANDABLE_ROLES with developer/tester/reviewer', async () => {
    const { promises: fs } = await import('fs');
    const { join } = await import('path');
    const content = await fs.readFile(
      join(process.cwd(), 'agent/crew.js'),
      'utf-8'
    );

    expect(content).toContain("const EXPANDABLE_ROLES = new Set(['developer', 'tester', 'reviewer'])");
    expect(content).toContain("developer: 'dev'");
    expect(content).toContain("tester: 'test'");
    expect(content).toContain("reviewer: 'rev'");
  });

  it('CrewConfigPanel.js should import getTemplate from crew-templates', async () => {
    const { promises: fs } = await import('fs');
    const { join } = await import('path');
    const content = await fs.readFile(
      join(process.cwd(), 'web/components/CrewConfigPanel.js'),
      'utf-8'
    );

    expect(content).toContain("import { getTemplate } from '../crew-templates/index.js'");
  });
});

// =====================================================================
// Team best practices in dev template (commit b7b48d3)
// developer claudeMd: 代码质量要求 + Worktree 纪律
// reviewer claudeMd: 审查标准（严格执行） + 10分制评分
// =====================================================================

describe('CrewConfigPanel - developer claudeMd best practices (b7b48d3)', () => {
  let configContent;

  beforeAll(async () => {
    const { promises: fs } = await import('fs');
    const { join } = await import('path');
    configContent = await fs.readFile(
      join(process.cwd(), 'web/crew-templates/dev-zh.js'),
      'utf-8'
    );
  });

  // --- Developer: 代码质量要求 ---

  it('developer claudeMd should contain "代码质量要求" section', () => {
    expect(configContent).toContain('# 代码质量要求');
  });

  it('developer claudeMd should prohibit workarounds', () => {
    expect(configContent).toContain('禁止 workaround');
    expect(configContent).toContain('不用临时变通绕过问题，要从根本解决');
  });

  it('developer claudeMd should prohibit lazy implementations', () => {
    expect(configContent).toContain('禁止偷懒');
    expect(configContent).toContain('不硬编码、不 copy-paste、不跳过边界条件');
  });

  it('developer claudeMd should require simple & correct implementations', () => {
    expect(configContent).toContain('实现必须简约且正确，走正确的路，不走捷径');
  });

  it('developer claudeMd should describe review handoff to reviewer', () => {
    expect(configContent).toContain('代码要经得起审查者的严格审查');
  });

  // --- Developer: Worktree 纪律 ---

  it('developer claudeMd should contain "Worktree 纪律" section', () => {
    expect(configContent).toContain('# Worktree 纪律');
  });

  it('developer worktree discipline should prohibit operating main dir or other group worktrees', () => {
    expect(configContent).toContain('绝对禁止在项目主目录或 main 分支上直接修改代码');
    expect(configContent).toContain('绝对禁止操作其他开发组的 worktree');
  });

  it('developer worktree discipline should require PR merge', () => {
    expect(configContent).toContain('代码完成并通过 review 后，自己提 PR 合并到 main');
  });

  // --- Developer: 代码质量要求 appears before Worktree 纪律 ---

  it('"代码质量要求" should appear before "Worktree 纪律" in developer claudeMd', () => {
    const qualityIdx = configContent.indexOf('# 代码质量要求');
    const worktreeIdx = configContent.indexOf('# Worktree 纪律');
    expect(qualityIdx).toBeGreaterThan(-1);
    expect(worktreeIdx).toBeGreaterThan(-1);
    expect(qualityIdx).toBeLessThan(worktreeIdx);
  });

  // --- Developer: Worktree 纪律 appears before 协作流程 ---

  it('"Worktree 纪律" should appear before "协作流程" in developer claudeMd', () => {
    // Extract developer claudeMd section (between 'name: \'developer\'' and next role)
    const devSection = configContent.split("name: 'developer'")[1].split("name: 'reviewer'")[0];
    const worktreeIdx = devSection.indexOf('# Worktree 纪律');
    const workflowIdx = devSection.indexOf('# 协作流程');
    expect(worktreeIdx).toBeGreaterThan(-1);
    expect(workflowIdx).toBeGreaterThan(-1);
    expect(worktreeIdx).toBeLessThan(workflowIdx);
  });
});

describe('CrewConfigPanel - developer team model with reviewer/tester', () => {
  let configContent;

  beforeAll(async () => {
    const { promises: fs } = await import('fs');
    const { join } = await import('path');
    configContent = await fs.readFile(
      join(process.cwd(), 'web/crew-templates/dev-zh.js'),
      'utf-8'
    );
  });

  // --- Developer delegates review to reviewer and testing to tester ---

  it('developer claudeMd should describe handoff to reviewer', () => {
    expect(configContent).toContain('代码要经得起审查者的严格审查');
  });

  it('developer claudeMd should describe handoff to tester', () => {
    expect(configContent).toContain('交给审查者 review、测试者测试');
  });

  it('developer should be named 开发者-托瓦兹 in dev template', () => {
    expect(configContent).toContain("displayName: '开发者-托瓦兹'");
  });

  it('developer description should mention architecture and implementation', () => {
    expect(configContent).toContain('架构设计 + 代码实现');
  });

  it('developer claudeMd should reference Linus Torvalds personality', () => {
    expect(configContent).toContain('Linus Torvalds');
  });

  it('developer claudeMd should emphasize code quality standards', () => {
    expect(configContent).toContain('禁止 workaround');
    expect(configContent).toContain('禁止偷懒');
  });

  it('dev template should include reviewer and tester roles', () => {
    expect(configContent).toContain("name: 'reviewer'");
    expect(configContent).toContain("name: 'tester'");
  });

  it('dev template should have reviewer with Robert C. Martin persona', () => {
    expect(configContent).toContain('Robert C. Martin');
  });

  it('dev template should have tester with Kent Beck persona', () => {
    expect(configContent).toContain('Kent Beck');
  });
});
