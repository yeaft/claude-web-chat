import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

/**
 * Tests for PR #237 — Expert Panel team admin visibility control.
 *
 * Tests business logic ONLY:
 * 1. EXPERT_TEAMS data: adminOnly flags on trading/writing/video, not on dev
 * 2. getVisibleTeams(true) returns all 4 teams
 * 3. getVisibleTeams(false) returns only non-adminOnly teams (dev)
 * 4. ExpertPanel component uses visibleTeamIds to filter groups and search
 * 5. buildAutocompleteItems includes group field for search filtering
 */

const base = resolve(__dirname, '../..');
const read = (rel) => readFileSync(resolve(base, rel), 'utf-8');

// =====================================================================
// Parse EXPERT_TEAMS and getVisibleTeams from source
// =====================================================================

/**
 * Evaluate the frontend module in a safe way by extracting
 * the relevant constants and functions from source.
 */
function loadExpertRolesModule() {
  const src = read('web/utils/expert-roles.js');

  // Extract EXPERT_TEAMS object
  const teamsMatch = src.match(/export\s+const\s+EXPERT_TEAMS\s*=\s*(\{[\s\S]*?\n\});/);
  if (!teamsMatch) throw new Error('Could not extract EXPERT_TEAMS');
  const EXPERT_TEAMS = new Function(`return ${teamsMatch[1]}`)();

  // Extract getVisibleTeams function body and recreate it
  const fnMatch = src.match(/export\s+function\s+getVisibleTeams\(isAdmin\)\s*\{([\s\S]*?)\n\}/);
  if (!fnMatch) throw new Error('Could not extract getVisibleTeams');
  // Inject EXPERT_TEAMS into closure
  const getVisibleTeams = new Function('EXPERT_TEAMS', 'isAdmin', fnMatch[1]
    .replace('Object.values(EXPERT_TEAMS)', 'Object.values(EXPERT_TEAMS)')
  ).bind(null, EXPERT_TEAMS);

  return { EXPERT_TEAMS, getVisibleTeams };
}

const { EXPERT_TEAMS, getVisibleTeams } = loadExpertRolesModule();

// =====================================================================
// 1. EXPERT_TEAMS — adminOnly flags
// =====================================================================
describe('EXPERT_TEAMS — adminOnly flags', () => {
  it('dev team does NOT have adminOnly', () => {
    expect(EXPERT_TEAMS.dev.adminOnly).toBeFalsy();
  });

  it('trading team has adminOnly: true', () => {
    expect(EXPERT_TEAMS.trading.adminOnly).toBe(true);
  });

  it('writing team has adminOnly: true', () => {
    expect(EXPERT_TEAMS.writing.adminOnly).toBe(true);
  });

  it('video team has adminOnly: true', () => {
    expect(EXPERT_TEAMS.video.adminOnly).toBe(true);
  });

  it('has exactly 4 teams total', () => {
    expect(Object.keys(EXPERT_TEAMS)).toHaveLength(4);
  });
});

// =====================================================================
// 2. getVisibleTeams — admin sees all, non-admin sees dev only
// =====================================================================
describe('getVisibleTeams — visibility filtering', () => {
  it('admin (true) gets all 4 teams', () => {
    const teams = getVisibleTeams(true);
    expect(teams).toHaveLength(4);
    const ids = teams.map(t => t.id);
    expect(ids).toContain('dev');
    expect(ids).toContain('trading');
    expect(ids).toContain('writing');
    expect(ids).toContain('video');
  });

  it('non-admin (false) gets only dev team', () => {
    const teams = getVisibleTeams(false);
    expect(teams).toHaveLength(1);
    expect(teams[0].id).toBe('dev');
  });

  it('returned teams are sorted by order', () => {
    const teams = getVisibleTeams(true);
    for (let i = 1; i < teams.length; i++) {
      expect(teams[i].order).toBeGreaterThan(teams[i - 1].order);
    }
  });

  it('dev team is always first in the sorted result', () => {
    const adminTeams = getVisibleTeams(true);
    expect(adminTeams[0].id).toBe('dev');

    const nonAdminTeams = getVisibleTeams(false);
    expect(nonAdminTeams[0].id).toBe('dev');
  });
});

// =====================================================================
// 3. ExpertPanel component — uses getVisibleTeams and filters correctly
// =====================================================================
describe('ExpertPanel — admin visibility integration', () => {
  const panelSrc = read('web/components/ExpertPanel.js');

  it('imports getVisibleTeams from expert-roles', () => {
    expect(panelSrc).toContain('getVisibleTeams');
  });

  it('imports and uses authStore', () => {
    expect(panelSrc).toContain('useAuthStore');
  });

  it('computes isAdmin from authStore.role', () => {
    expect(panelSrc).toContain("authStore.role === 'admin'");
  });

  it('availableTeams computed calls getVisibleTeams with isAdmin', () => {
    expect(panelSrc).toContain('getVisibleTeams(isAdmin.value)');
    // The old unfiltered pattern should not be in availableTeams
    const availableTeamsBlock = panelSrc.match(/availableTeams\s*=\s*Vue\.computed\(\(\)\s*=>\s*\{([\s\S]*?)\}\)/);
    expect(availableTeamsBlock).toBeTruthy();
    expect(availableTeamsBlock[1]).not.toContain('Object.values(EXPERT_TEAMS)');
  });

  it('filteredGroups filters by visibleTeamIds', () => {
    expect(panelSrc).toContain('visibleTeamIds.value.has(g.teamId)');
  });
});

// =====================================================================
// 4. buildAutocompleteItems — every item has group field for filtering
// =====================================================================
describe('buildAutocompleteItems — group field for search filtering', () => {
  const src = read('web/utils/expert-roles.js');

  it('buildAutocompleteItems assigns group field to role items', () => {
    const fnBody = src.match(/export\s+function\s+buildAutocompleteItems\(\)\s*\{([\s\S]*?)\n\}/);
    expect(fnBody).toBeTruthy();
    expect(fnBody[1]).toContain('group: role.group');
  });

  it('every EXPERT_ROLES entry has a group field matching a team ID', () => {
    const teamIds = Object.keys(EXPERT_TEAMS);
    const roleBlocks = src.matchAll(/(\w+):\s*\{[^}]*?id:\s*'(\w+)'[^}]*?group:\s*'(\w+)'/g);
    let count = 0;
    for (const match of roleBlocks) {
      const group = match[3];
      expect(teamIds).toContain(group);
      count++;
    }
    expect(count).toBeGreaterThanOrEqual(26);
  });
});

// =====================================================================
// 5. DEFAULT_TEAM is 'dev' — unaffected by admin filtering
// =====================================================================
describe('DEFAULT_TEAM — unaffected by admin filtering', () => {
  const src = read('web/utils/expert-roles.js');

  it('DEFAULT_TEAM is dev', () => {
    expect(src).toContain("export const DEFAULT_TEAM = 'dev'");
  });

  it('dev team is visible to non-admin users (DEFAULT_TEAM always accessible)', () => {
    const nonAdminTeams = getVisibleTeams(false);
    const devTeam = nonAdminTeams.find(t => t.id === 'dev');
    expect(devTeam).toBeTruthy();
  });
});
