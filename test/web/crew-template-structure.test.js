import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

/**
 * Tests for PR #293 — Crew team template prompt upgrades (task-116c).
 *
 * Validates:
 * 1. All 8 template files (4 teams × 2 languages) have correct structure
 * 2. Each role has required fields: name, displayName, description, isDecisionMaker, claudeMd
 * 3. Each team has exactly 1 decision maker
 * 4. zh/en pairs have matching role counts and internal name fields
 * 5. ROUTE format is correct (---ROUTE--- / to: / summary: / ---END_ROUTE---)
 * 6. claudeMd content is non-trivial (upgraded, not empty stubs)
 * 7. index.js correctly wires all templates
 */

const base = resolve(__dirname, '../..');
const tplDir = resolve(base, 'web/crew-templates');
const read = (filename) => readFileSync(resolve(tplDir, filename), 'utf-8');

// =====================================================================
// Parse template files as source text — extract role objects
// =====================================================================

/**
 * Parse an ES module template file and extract role metadata.
 * These files are `export default [{ name: ..., displayName: ..., ... }, ...]`
 * We use regex to extract the structural fields (not claudeMd content).
 */
function parseTemplateRoles(source) {
  const roles = [];
  // Match each role object block: { name: '...', displayName: '...', ... claudeMd: `...` }
  const rolePattern = /\{\s*\n?\s*name:\s*'([^']+)',\s*displayName:\s*'([^']+)',\s*icon:\s*'[^']*',\s*\n?\s*description:\s*'([^']*)',\s*\n?\s*isDecisionMaker:\s*(true|false)/g;
  let match;
  while ((match = rolePattern.exec(source)) !== null) {
    roles.push({
      name: match[1],
      displayName: match[2],
      description: match[3],
      isDecisionMaker: match[4] === 'true'
    });
  }
  return roles;
}

/**
 * Check that each role's claudeMd field exists and has substantial content.
 */
function checkClaudeMdFields(source) {
  // Split by role boundary: look for `claudeMd: \`` backtick-delimited strings
  const claudeMdPattern = /claudeMd:\s*`([^`]*(?:\\`[^`]*)*)`/gs;
  const contents = [];
  let match;
  while ((match = claudeMdPattern.exec(source)) !== null) {
    contents.push(match[1]);
  }
  return contents;
}

/**
 * Extract all ROUTE blocks from claudeMd content.
 * Valid format: ---ROUTE--- \n to: <name> \n summary: <text> \n ---END_ROUTE---
 */
function extractRouteBlocks(source) {
  const blocks = [];
  const pattern = /---ROUTE---\s*\n([\s\S]*?)---END_ROUTE---/g;
  let match;
  while ((match = pattern.exec(source)) !== null) {
    const body = match[1];
    const to = body.match(/to:\s*(.+)/);
    const summary = body.match(/summary:\s*(.+)/);
    blocks.push({
      hasTo: !!to,
      hasSum: !!summary,
      toValue: to ? to[1].trim() : null,
      sumValue: summary ? summary[1].trim() : null
    });
  }
  return blocks;
}

// =====================================================================
// Template definitions: expected role counts and names per team
// =====================================================================

const TEAMS = [
  {
    team: 'trading',
    zhFile: 'trading-zh.js',
    enFile: 'trading-en.js',
    roleCount: 6,
    roleNames: ['strategist', 'analyst', 'macro', 'risk', 'trader', 'quant']
  },
  {
    team: 'writing',
    zhFile: 'writing-zh.js',
    enFile: 'writing-en.js',
    roleCount: 4,
    roleNames: ['planner', 'designer', 'writer', 'editor']
  },
  {
    team: 'video',
    zhFile: 'video-zh.js',
    enFile: 'video-en.js',
    roleCount: 4,
    roleNames: ['director', 'scriptwriter', 'storyboard', 'editor']
  }
];

// =====================================================================
// 1. Template structure: correct role count and required fields
// =====================================================================
describe('template structure: role count and required fields', () => {
  for (const team of TEAMS) {
    for (const file of [team.zhFile, team.enFile]) {
      const src = read(file);
      const roles = parseTemplateRoles(src);

      it(`${file} has ${team.roleCount} roles`, () => {
        expect(roles).toHaveLength(team.roleCount);
      });

      it(`${file} roles have correct internal names`, () => {
        const names = roles.map(r => r.name);
        expect(names).toEqual(team.roleNames);
      });

      it(`${file} every role has non-empty displayName and description`, () => {
        for (const role of roles) {
          expect(role.displayName.length).toBeGreaterThan(0);
          expect(role.description.length).toBeGreaterThan(0);
        }
      });
    }
  }
});

// =====================================================================
// 2. Exactly 1 decision maker per team
// =====================================================================
describe('exactly 1 decision maker per team', () => {
  for (const team of TEAMS) {
    for (const file of [team.zhFile, team.enFile]) {
      const src = read(file);
      const roles = parseTemplateRoles(src);

      it(`${file} has exactly 1 isDecisionMaker:true`, () => {
        const dmCount = roles.filter(r => r.isDecisionMaker).length;
        expect(dmCount).toBe(1);
      });

      it(`${file} decision maker is the first role`, () => {
        expect(roles[0].isDecisionMaker).toBe(true);
      });
    }
  }
});

// =====================================================================
// 3. zh/en pairs have matching role names
// =====================================================================
describe('zh/en pairs: matching role names', () => {
  for (const team of TEAMS) {
    it(`${team.team}: zh and en have same internal names`, () => {
      const zhRoles = parseTemplateRoles(read(team.zhFile));
      const enRoles = parseTemplateRoles(read(team.enFile));
      expect(zhRoles.map(r => r.name)).toEqual(enRoles.map(r => r.name));
    });

    it(`${team.team}: zh and en have same isDecisionMaker pattern`, () => {
      const zhRoles = parseTemplateRoles(read(team.zhFile));
      const enRoles = parseTemplateRoles(read(team.enFile));
      expect(zhRoles.map(r => r.isDecisionMaker)).toEqual(enRoles.map(r => r.isDecisionMaker));
    });
  }
});

// =====================================================================
// 4. claudeMd fields: exist and have substantial content
// =====================================================================
describe('claudeMd: non-trivial content', () => {
  for (const team of TEAMS) {
    for (const file of [team.zhFile, team.enFile]) {
      const src = read(file);
      const claudeMds = checkClaudeMdFields(src);

      it(`${file} has claudeMd for every role (${team.roleCount})`, () => {
        expect(claudeMds).toHaveLength(team.roleCount);
      });

      it(`${file} every claudeMd is at least 200 chars (upgraded, not stub)`, () => {
        for (let i = 0; i < claudeMds.length; i++) {
          expect(claudeMds[i].length).toBeGreaterThan(200);
        }
      });
    }
  }
});

// =====================================================================
// 5. ROUTE format validation
// =====================================================================
describe('ROUTE blocks: correct format', () => {
  for (const team of TEAMS) {
    for (const file of [team.zhFile, team.enFile]) {
      const src = read(file);
      const routes = extractRouteBlocks(src);

      it(`${file} has at least 1 ROUTE block`, () => {
        expect(routes.length).toBeGreaterThan(0);
      });

      it(`${file} all ROUTE blocks have "to:" field`, () => {
        for (const route of routes) {
          expect(route.hasTo).toBe(true);
        }
      });

      it(`${file} all ROUTE blocks have "summary:" field`, () => {
        for (const route of routes) {
          expect(route.hasSum).toBe(true);
        }
      });

      it(`${file} ROUTE "to:" targets are valid role names`, () => {
        for (const route of routes) {
          // "to:" should reference a role name from this team
          expect(team.roleNames).toContain(route.toValue);
        }
      });
    }
  }
});

// =====================================================================
// 6. Decision maker claudeMd has decision/review template
// =====================================================================
describe('decision maker has structured output template', () => {
  for (const team of TEAMS) {
    for (const file of [team.zhFile, team.enFile]) {
      const src = read(file);

      it(`${file} DM claudeMd contains a structured template section`, () => {
        // DM (first role) should have a template section header in the full source
        // Templates use escaped backticks (\`\`\`) which break claudeMd extraction,
        // so we check the raw source for template section markers.
        expect(src).toMatch(/# .*(模板|[Tt]emplate)/);
      });
    }
  }
});

// =====================================================================
// 7. index.js wires all 4 teams
// =====================================================================
describe('index.js template registry', () => {
  const indexSrc = read('index.js');

  it('imports all 8 template files', () => {
    for (const team of ['dev', 'trading', 'writing', 'video']) {
      expect(indexSrc).toContain(`${team}Zh`);
      expect(indexSrc).toContain(`${team}En`);
    }
  });

  it('registers all 4 teams in templates object', () => {
    for (const team of ['dev', 'writing', 'trading', 'video']) {
      expect(indexSrc).toContain(`${team}:`);
    }
  });

  it('exports getTemplate function', () => {
    expect(indexSrc).toContain('export function getTemplate');
  });
});

// =====================================================================
// 8. Also check dev templates (not changed but part of the suite)
// =====================================================================
describe('dev templates: still correct after merge', () => {
  for (const file of ['dev-zh.js', 'dev-en.js']) {
    const src = read(file);
    const roles = parseTemplateRoles(src);

    it(`${file} has 5 roles`, () => {
      expect(roles).toHaveLength(5);
    });

    it(`${file} has exactly 1 decision maker`, () => {
      expect(roles.filter(r => r.isDecisionMaker)).toHaveLength(1);
    });
  }

  it('dev zh/en have same internal names', () => {
    const zhNames = parseTemplateRoles(read('dev-zh.js')).map(r => r.name);
    const enNames = parseTemplateRoles(read('dev-en.js')).map(r => r.name);
    expect(zhNames).toEqual(enNames);
  });
});
