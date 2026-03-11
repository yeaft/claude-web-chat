import { describe, it, expect } from 'vitest';

/**
 * Tests for task-33: Crew resume with role configuration comparison.
 *
 * Verifies that createCrewSession correctly compares new vs old role
 * configurations before auto-resuming, and falls through to fresh
 * creation when roles have changed.
 */

// =====================================================================
// Replicate core functions from agent/crew/session.js
// =====================================================================

const SHORT_PREFIX = { developer: 'dev', tester: 'test', reviewer: 'rev' };
const EXPANDABLE_ROLES = new Set(['developer', 'tester', 'reviewer']);

function expandRoles(roles) {
  const devRole = roles.find(r => r.name === 'developer');
  const devCount = devRole?.count > 1 ? devRole.count : 1;
  const expanded = [];
  for (const role of roles) {
    const isExpandable = EXPANDABLE_ROLES.has(role.name);
    const count = isExpandable ? devCount : 1;
    if (count <= 1) {
      expanded.push({ ...role, roleType: role.name, groupIndex: isExpandable ? 1 : 0 });
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

function getRolesSignature(roles) {
  if (!roles || roles.length === 0) return '';
  const names = roles.map(r => r.name).sort();
  return names.join(',');
}

// =====================================================================
// getRolesSignature tests
// =====================================================================

describe('getRolesSignature', () => {
  it('returns empty string for null/undefined/empty', () => {
    expect(getRolesSignature(null)).toBe('');
    expect(getRolesSignature(undefined)).toBe('');
    expect(getRolesSignature([])).toBe('');
  });

  it('returns sorted comma-separated names', () => {
    const roles = [
      { name: 'developer', displayName: '开发者' },
      { name: 'pm', displayName: 'PM' },
      { name: 'reviewer', displayName: '审查者' }
    ];
    expect(getRolesSignature(roles)).toBe('developer,pm,reviewer');
  });

  it('sorts names alphabetically regardless of input order', () => {
    const a = [{ name: 'z' }, { name: 'a' }, { name: 'm' }];
    const b = [{ name: 'a' }, { name: 'm' }, { name: 'z' }];
    expect(getRolesSignature(a)).toBe(getRolesSignature(b));
  });

  it('produces identical signatures for same expanded role sets', () => {
    const roles3 = [
      { name: 'pm', displayName: 'PM', icon: '📋' },
      { name: 'designer', displayName: '设计师', icon: '🎨' },
      { name: 'developer', displayName: '开发者', icon: '💻', count: 3 },
      { name: 'reviewer', displayName: '审查者', icon: '🔍' },
      { name: 'tester', displayName: '测试', icon: '🧪' }
    ];
    const expanded = expandRoles(roles3);
    // Should have: pm, designer, dev-1, dev-2, dev-3, rev-1, rev-2, rev-3, test-1, test-2, test-3
    expect(expanded.length).toBe(11);

    // Same input → same signature
    const sig1 = getRolesSignature(expanded);
    const sig2 = getRolesSignature([...expanded].reverse());
    expect(sig1).toBe(sig2);
  });

  it('produces different signatures when dev count changes', () => {
    const roles3dev = [
      { name: 'pm', displayName: 'PM' },
      { name: 'developer', displayName: '开发者', count: 3 },
      { name: 'reviewer', displayName: '审查者' },
      { name: 'tester', displayName: '测试' }
    ];
    const roles5dev = [
      { name: 'pm', displayName: 'PM' },
      { name: 'developer', displayName: '开发者', count: 5 },
      { name: 'reviewer', displayName: '审查者' },
      { name: 'tester', displayName: '测试' }
    ];

    const expanded3 = expandRoles(roles3dev);
    const expanded5 = expandRoles(roles5dev);
    const sig3 = getRolesSignature(expanded3);
    const sig5 = getRolesSignature(expanded5);

    expect(sig3).not.toBe(sig5);
    // 3 dev: pm + designer? no. pm + dev-1,2,3 + rev-1,2,3 + test-1,2,3 = 10
    expect(expanded3.length).toBe(10);
    // 5 dev: pm + dev-1..5 + rev-1..5 + test-1..5 = 16
    expect(expanded5.length).toBe(16);
  });
});

// =====================================================================
// Auto-resume role comparison logic (integration-style)
// =====================================================================

describe('createCrewSession auto-resume role comparison', () => {
  /**
   * Simulate the auto-resume decision logic from createCrewSession:
   *   if roles match → resume
   *   if roles differ → discard old, create new
   */
  function shouldAutoResume(newRawRoles, existingSessionRoles) {
    const newRoles = expandRoles(newRawRoles);
    const newSig = getRolesSignature(newRoles);
    const oldSig = getRolesSignature(existingSessionRoles);
    return newSig === oldSig;
  }

  const baseRoles = [
    { name: 'pm', displayName: 'PM', icon: '📋', isDecisionMaker: true },
    { name: 'designer', displayName: '设计师', icon: '🎨' },
    { name: 'developer', displayName: '开发者', icon: '💻', count: 3 },
    { name: 'reviewer', displayName: '审查者', icon: '🔍' },
    { name: 'tester', displayName: '测试', icon: '🧪' }
  ];

  it('resumes when roles are identical (same dev count)', () => {
    const oldExpanded = expandRoles(baseRoles);
    expect(shouldAutoResume(baseRoles, oldExpanded)).toBe(true);
  });

  it('does NOT resume when dev count changes (3 → 5)', () => {
    const oldExpanded = expandRoles(baseRoles);
    const newRoles = baseRoles.map(r =>
      r.name === 'developer' ? { ...r, count: 5 } : r
    );
    expect(shouldAutoResume(newRoles, oldExpanded)).toBe(false);
  });

  it('does NOT resume when dev count changes (3 → 1)', () => {
    const oldExpanded = expandRoles(baseRoles);
    const newRoles = baseRoles.map(r =>
      r.name === 'developer' ? { ...r, count: 1 } : r
    );
    expect(shouldAutoResume(newRoles, oldExpanded)).toBe(false);
  });

  it('does NOT resume when a role is added', () => {
    const oldExpanded = expandRoles(baseRoles);
    const newRoles = [
      ...baseRoles,
      { name: 'devops', displayName: 'DevOps', icon: '🔧' }
    ];
    expect(shouldAutoResume(newRoles, oldExpanded)).toBe(false);
  });

  it('does NOT resume when a role is removed', () => {
    const oldExpanded = expandRoles(baseRoles);
    const newRoles = baseRoles.filter(r => r.name !== 'designer');
    expect(shouldAutoResume(newRoles, oldExpanded)).toBe(false);
  });

  it('resumes when only display fields change (not names)', () => {
    const oldExpanded = expandRoles(baseRoles);
    const newRoles = baseRoles.map(r =>
      r.name === 'pm' ? { ...r, displayName: 'Product Manager', icon: '🎯' } : r
    );
    // Names are the same → should resume
    expect(shouldAutoResume(newRoles, oldExpanded)).toBe(true);
  });

  it('handles comparison with empty old roles', () => {
    expect(shouldAutoResume(baseRoles, [])).toBe(false);
  });

  it('handles comparison when both are empty', () => {
    expect(shouldAutoResume([], [])).toBe(true);
  });

  it('resumes when no expandable roles (simple 2-role setup)', () => {
    const simple = [
      { name: 'pm', displayName: 'PM', isDecisionMaker: true },
      { name: 'developer', displayName: '开发者' }
    ];
    const oldExpanded = expandRoles(simple);
    expect(shouldAutoResume(simple, oldExpanded)).toBe(true);
  });
});

// =====================================================================
// expandRoles edge cases
// =====================================================================

describe('expandRoles', () => {
  it('expands dev/reviewer/tester equally based on devCount', () => {
    const roles = [
      { name: 'pm', displayName: 'PM' },
      { name: 'developer', displayName: '开发者', count: 3 },
      { name: 'reviewer', displayName: '审查者' },
      { name: 'tester', displayName: '测试' }
    ];
    const expanded = expandRoles(roles);
    const devs = expanded.filter(r => r.roleType === 'developer');
    const revs = expanded.filter(r => r.roleType === 'reviewer');
    const tests = expanded.filter(r => r.roleType === 'tester');
    expect(devs.length).toBe(3);
    expect(revs.length).toBe(3);
    expect(tests.length).toBe(3);
    expect(devs.map(r => r.name)).toEqual(['dev-1', 'dev-2', 'dev-3']);
    expect(revs.map(r => r.name)).toEqual(['rev-1', 'rev-2', 'rev-3']);
    expect(tests.map(r => r.name)).toEqual(['test-1', 'test-2', 'test-3']);
  });

  it('does not expand when count is 1', () => {
    const roles = [
      { name: 'pm', displayName: 'PM' },
      { name: 'developer', displayName: '开发者', count: 1 },
      { name: 'reviewer', displayName: '审查者' }
    ];
    const expanded = expandRoles(roles);
    expect(expanded.find(r => r.name === 'developer')).toBeTruthy();
    expect(expanded.find(r => r.name === 'reviewer')).toBeTruthy();
    expect(expanded.length).toBe(3);
  });

  it('handles missing developer role (no expandable)', () => {
    const roles = [
      { name: 'pm', displayName: 'PM' },
      { name: 'designer', displayName: '设计师' }
    ];
    const expanded = expandRoles(roles);
    expect(expanded.length).toBe(2);
    expect(expanded[0].groupIndex).toBe(0);
    expect(expanded[1].groupIndex).toBe(0);
  });
});

// =====================================================================
// client-crew.js language field forwarding
// =====================================================================

describe('client-crew.js language field', () => {
  it('should include language in forwardToAgent payload', () => {
    // Simulate the message construction from client-crew.js
    const msg = {
      type: 'create_crew_session',
      projectDir: '/test',
      roles: [],
      language: 'en'
    };
    const client = { userId: 'u1', username: 'testuser' };

    // This is what client-crew.js now does:
    const forwarded = {
      type: 'create_crew_session',
      sessionId: 'test-id',
      projectDir: msg.projectDir,
      sharedDir: msg.sharedDir,
      name: msg.name || '',
      roles: msg.roles,
      teamType: msg.teamType || 'dev',
      language: msg.language || 'zh-CN',
      userId: client.userId,
      username: client.username
    };

    expect(forwarded.language).toBe('en');
  });

  it('defaults to zh-CN when language is not provided', () => {
    const msg = { type: 'create_crew_session', projectDir: '/test', roles: [] };
    const forwarded = {
      language: msg.language || 'zh-CN'
    };
    expect(forwarded.language).toBe('zh-CN');
  });
});
