import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'path';
import { tmpdir } from 'os';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

/**
 * Tests for task-10: RolePlay 导入 .crew 上下文
 *
 * Covers:
 * 1. loadCrewContext — reads .crew directory structure
 * 2. deduplicateRoles — merges multi-instance roles (dev-1, dev-2 → dev)
 * 3. buildCrewContextBlock — injects crew context into system prompt
 * 4. buildRolePlaySystemPrompt + crewContext integration
 * 5. handleCheckCrewContext — WS message handler
 * 6. Frontend RolePlayConfigPanel — crew detection, banner, auto-import
 * 7. WS message routing chain
 * 8. i18n keys
 * 9. CSS structural
 *
 * Core logic is replicated to avoid importing modules with side effects.
 */

const __dirname2 = dirname(fileURLToPath(import.meta.url));
const webBase = resolve(__dirname2, '../../web');

// =====================================================================
// Replicated loadCrewContext + helpers (mirrors agent/roleplay.js)
// =====================================================================

const MAX_CLAUDE_MD_LEN = 4096;

function readFileOrNull(filePath) {
  try {
    const { existsSync } = await_free_existsSync();
    if (!existsSync(filePath)) return null;
    return readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }
}

// Sync existsSync helper (avoids import issues)
function await_free_existsSync() {
  const fs = require_fs();
  return { existsSync: fs.existsSync };
}
function require_fs() {
  // Already imported at top
  return { existsSync: (p) => { try { readFileSync(p); return true; } catch { return false; } } };
}

// Simpler: just replicate the logic directly using fs imports
import { existsSync, readdirSync } from 'fs';

function loadCrewContext(projectDir) {
  const crewDir = join(projectDir, '.crew');
  if (!existsSync(crewDir)) return null;

  const sharedClaudeMd = safeRead(join(crewDir, 'CLAUDE.md')) || '';

  let sessionRoles = [];
  let teamType = 'dev';
  let language = 'zh-CN';
  let sessionFeatures = [];
  const sessionPath = join(crewDir, 'session.json');
  const sessionJson = safeRead(sessionPath);
  if (sessionJson) {
    try {
      const session = JSON.parse(sessionJson);
      if (Array.isArray(session.roles)) sessionRoles = session.roles;
      if (session.teamType) teamType = session.teamType;
      if (session.language) language = session.language;
      if (Array.isArray(session.features)) sessionFeatures = session.features;
    } catch {}
  }

  const roleClaudes = {};
  const rolesDir = join(crewDir, 'roles');
  if (existsSync(rolesDir)) {
    try {
      const roleDirs = readdirSync(rolesDir, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => d.name);
      for (const dirName of roleDirs) {
        const md = safeRead(join(rolesDir, dirName, 'CLAUDE.md'));
        if (md) roleClaudes[dirName] = md;
      }
    } catch {}
  }

  const roles = deduplicateRoles(sessionRoles, roleClaudes);

  const kanban = safeRead(join(crewDir, 'context', 'kanban.md')) || '';

  const features = [];
  const featuresDir = join(crewDir, 'context', 'features');
  if (existsSync(featuresDir)) {
    try {
      const files = readdirSync(featuresDir)
        .filter(f => f.endsWith('.md') && f !== 'index.md')
        .sort();
      for (const f of files) {
        const content = safeRead(join(featuresDir, f));
        if (content) features.push({ name: f.replace('.md', ''), content });
      }
    } catch {}
  }

  return { sharedClaudeMd, roles, kanban, features, teamType, language, sessionFeatures };
}

function safeRead(filePath) {
  try {
    if (!existsSync(filePath)) return null;
    return readFileSync(filePath, 'utf-8');
  } catch { return null; }
}

function deduplicateRoles(sessionRoles, roleClaudes) {
  const byType = new Map();
  const merged = [];

  for (const r of sessionRoles) {
    const type = r.roleType || r.name;
    const claudeMd = roleClaudes[r.name] || '';

    if (byType.has(type)) continue;
    byType.set(type, true);

    const name = type;
    let displayName = r.displayName || name;
    displayName = displayName.replace(/-\d+$/, '');

    merged.push({
      name,
      displayName,
      icon: r.icon || '',
      description: r.description || '',
      claudeMd: claudeMd.substring(0, MAX_CLAUDE_MD_LEN),
      roleType: type,
      isDecisionMaker: !!r.isDecisionMaker,
    });
  }

  return merged;
}

function buildCrewContextBlock(crewContext, isZh) {
  const sections = [];

  if (crewContext.sharedClaudeMd) {
    const header = isZh ? '## 项目共享指令（来自 .crew）' : '## Shared Project Instructions (from .crew)';
    sections.push(`${header}\n\n${crewContext.sharedClaudeMd}`);
  }

  if (crewContext.kanban) {
    const header = isZh ? '## 当前任务看板' : '## Current Task Board';
    sections.push(`${header}\n\n${crewContext.kanban}`);
  }

  if (crewContext.features && crewContext.features.length > 0) {
    const header = isZh ? '## 历史工作记录' : '## Work History';
    const recentFeatures = crewContext.features.slice(-5);
    const featureTexts = recentFeatures.map(f => {
      const content = f.content.length > 2000 ? f.content.substring(0, 2000) + '\n...(truncated)' : f.content;
      return `### ${f.name}\n${content}`;
    }).join('\n\n');
    sections.push(`${header}\n\n${featureTexts}`);
  }

  return sections.join('\n\n');
}

function handleCheckCrewContext(msg, sendFn) {
  const { projectDir, requestId } = msg;
  if (!projectDir) {
    sendFn({ type: 'crew_context_result', requestId, found: false });
    return;
  }
  const crewContext = loadCrewContext(projectDir);
  if (!crewContext) {
    sendFn({ type: 'crew_context_result', requestId, found: false });
    return;
  }
  sendFn({
    type: 'crew_context_result',
    requestId,
    found: true,
    roles: crewContext.roles.map(r => ({
      name: r.name, displayName: r.displayName, icon: r.icon,
      description: r.description, roleType: r.roleType,
      isDecisionMaker: r.isDecisionMaker,
      hasClaudeMd: !!(r.claudeMd && r.claudeMd.length > 0),
    })),
    teamType: crewContext.teamType,
    language: crewContext.language,
    featureCount: crewContext.features.length,
  });
}

// =====================================================================
// Test helper: create .crew directory structure
// =====================================================================

function createCrewDir(tmpDir, options = {}) {
  const projectDir = join(tmpDir, 'project');
  const crewDir = join(projectDir, '.crew');
  mkdirSync(crewDir, { recursive: true });

  if (options.claudeMd) {
    writeFileSync(join(crewDir, 'CLAUDE.md'), options.claudeMd);
  }

  if (options.sessionJson) {
    writeFileSync(join(crewDir, 'session.json'), JSON.stringify(options.sessionJson));
  }

  if (options.roles) {
    const rolesDir = join(crewDir, 'roles');
    mkdirSync(rolesDir, { recursive: true });
    for (const [name, claudeMd] of Object.entries(options.roles)) {
      const roleDir = join(rolesDir, name);
      mkdirSync(roleDir, { recursive: true });
      writeFileSync(join(roleDir, 'CLAUDE.md'), claudeMd);
    }
  }

  if (options.kanban) {
    const contextDir = join(crewDir, 'context');
    mkdirSync(contextDir, { recursive: true });
    writeFileSync(join(contextDir, 'kanban.md'), options.kanban);
  }

  if (options.features) {
    const featuresDir = join(crewDir, 'context', 'features');
    mkdirSync(featuresDir, { recursive: true });
    for (const [name, content] of Object.entries(options.features)) {
      writeFileSync(join(featuresDir, `${name}.md`), content);
    }
  }

  return projectDir;
}

// =====================================================================
// Tests
// =====================================================================

describe('task-10: RolePlay .crew context import', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'crew-context-test-'));
  });

  afterEach(() => {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  // ---------------------------------------------------------------
  // 1. loadCrewContext — with .crew directory
  // ---------------------------------------------------------------

  describe('loadCrewContext — with .crew directory', () => {
    it('returns null when projectDir has no .crew directory', () => {
      const projectDir = join(tmpDir, 'no-crew');
      mkdirSync(projectDir, { recursive: true });
      const result = loadCrewContext(projectDir);
      expect(result).toBeNull();
    });

    it('loads sharedClaudeMd from .crew/CLAUDE.md', () => {
      const projectDir = createCrewDir(tmpDir, {
        claudeMd: '# Shared instructions\nDo this.',
      });
      const result = loadCrewContext(projectDir);
      expect(result).not.toBeNull();
      expect(result.sharedClaudeMd).toBe('# Shared instructions\nDo this.');
    });

    it('returns empty string for sharedClaudeMd when CLAUDE.md is missing', () => {
      const projectDir = createCrewDir(tmpDir, {});
      const result = loadCrewContext(projectDir);
      expect(result.sharedClaudeMd).toBe('');
    });

    it('reads session.json for roles, teamType, language', () => {
      const projectDir = createCrewDir(tmpDir, {
        sessionJson: {
          roles: [
            { name: 'pm', displayName: 'PM', roleType: 'pm', icon: '📋', description: 'Project manager' },
          ],
          teamType: 'dev',
          language: 'en',
        },
      });
      const result = loadCrewContext(projectDir);
      expect(result.teamType).toBe('dev');
      expect(result.language).toBe('en');
      expect(result.roles).toHaveLength(1);
      expect(result.roles[0].name).toBe('pm');
    });

    it('defaults teamType to "dev" when session.json has no teamType', () => {
      const projectDir = createCrewDir(tmpDir, {
        sessionJson: { roles: [] },
      });
      const result = loadCrewContext(projectDir);
      expect(result.teamType).toBe('dev');
    });

    it('defaults language to "zh-CN" when session.json has no language', () => {
      const projectDir = createCrewDir(tmpDir, {
        sessionJson: { roles: [] },
      });
      const result = loadCrewContext(projectDir);
      expect(result.language).toBe('zh-CN');
    });

    it('handles invalid session.json gracefully', () => {
      const projectDir = createCrewDir(tmpDir, {});
      writeFileSync(join(projectDir, '.crew', 'session.json'), 'NOT_JSON');
      const result = loadCrewContext(projectDir);
      expect(result).not.toBeNull();
      expect(result.roles).toEqual([]);
    });

    it('reads per-role CLAUDE.md from .crew/roles/*/CLAUDE.md', () => {
      const projectDir = createCrewDir(tmpDir, {
        sessionJson: {
          roles: [
            { name: 'dev-1', displayName: '开发者-1', roleType: 'dev', icon: '💻', description: '开发' },
          ],
        },
        roles: {
          'dev-1': '# Dev-1 instructions\nWrite code.',
        },
      });
      const result = loadCrewContext(projectDir);
      expect(result.roles[0].claudeMd).toBe('# Dev-1 instructions\nWrite code.');
    });

    it('reads kanban.md from .crew/context/kanban.md', () => {
      const projectDir = createCrewDir(tmpDir, {
        kanban: '# Kanban\n| task | status |\n|------|--------|\n| t1 | done |',
      });
      const result = loadCrewContext(projectDir);
      expect(result.kanban).toContain('# Kanban');
    });

    it('reads feature files from .crew/context/features/*.md', () => {
      const projectDir = createCrewDir(tmpDir, {
        features: {
          'task-1': '# Feature task-1\nDone.',
          'task-2': '# Feature task-2\nIn progress.',
        },
      });
      const result = loadCrewContext(projectDir);
      expect(result.features).toHaveLength(2);
      expect(result.features[0].name).toBe('task-1');
      expect(result.features[1].name).toBe('task-2');
    });

    it('excludes index.md from features', () => {
      const projectDir = createCrewDir(tmpDir, {
        features: {
          'index': 'Index file',
          'task-1': 'Feature content',
        },
      });
      const result = loadCrewContext(projectDir);
      expect(result.features).toHaveLength(1);
      expect(result.features[0].name).toBe('task-1');
    });

    it('returns empty features when context/features dir is missing', () => {
      const projectDir = createCrewDir(tmpDir, {});
      const result = loadCrewContext(projectDir);
      expect(result.features).toEqual([]);
    });

    it('returns all fields in result object', () => {
      const projectDir = createCrewDir(tmpDir, {
        claudeMd: 'shared',
        sessionJson: { roles: [], teamType: 'dev', language: 'en', features: ['f1'] },
        kanban: 'kanban',
      });
      const result = loadCrewContext(projectDir);
      expect(result).toHaveProperty('sharedClaudeMd');
      expect(result).toHaveProperty('roles');
      expect(result).toHaveProperty('kanban');
      expect(result).toHaveProperty('features');
      expect(result).toHaveProperty('teamType');
      expect(result).toHaveProperty('language');
      expect(result).toHaveProperty('sessionFeatures');
    });
  });

  // ---------------------------------------------------------------
  // 2. deduplicateRoles — role merging
  // ---------------------------------------------------------------

  describe('deduplicateRoles — role merging', () => {
    it('collapses dev-1, dev-2, dev-3 into single "dev" role', () => {
      const sessionRoles = [
        { name: 'dev-1', displayName: '开发者-托瓦兹-1', roleType: 'dev', icon: '💻', description: '开发' },
        { name: 'dev-2', displayName: '开发者-托瓦兹-2', roleType: 'dev', icon: '💻', description: '开发' },
        { name: 'dev-3', displayName: '开发者-托瓦兹-3', roleType: 'dev', icon: '💻', description: '开发' },
      ];
      const roleClaudes = {
        'dev-1': '# Dev 1 instructions',
        'dev-2': '# Dev 2 instructions',
        'dev-3': '# Dev 3 instructions',
      };
      const result = deduplicateRoles(sessionRoles, roleClaudes);
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('dev');
      expect(result[0].roleType).toBe('dev');
    });

    it('strips numeric suffix from displayName (e.g. "开发者-托瓦兹-1" → "开发者-托瓦兹")', () => {
      const sessionRoles = [
        { name: 'dev-1', displayName: '开发者-托瓦兹-1', roleType: 'dev', icon: '💻', description: '' },
      ];
      const result = deduplicateRoles(sessionRoles, {});
      expect(result[0].displayName).toBe('开发者-托瓦兹');
    });

    it('keeps single-instance roles (pm, designer) as-is', () => {
      const sessionRoles = [
        { name: 'pm', displayName: 'PM-乔布斯', roleType: 'pm', icon: '📋', description: 'PM', isDecisionMaker: true },
        { name: 'designer', displayName: '设计师-拉姆斯', roleType: 'designer', icon: '🎨', description: '设计' },
      ];
      const result = deduplicateRoles(sessionRoles, {});
      expect(result).toHaveLength(2);
      expect(result[0].name).toBe('pm');
      expect(result[0].displayName).toBe('PM-乔布斯');
      expect(result[0].isDecisionMaker).toBe(true);
      expect(result[1].name).toBe('designer');
    });

    it('uses first occurrence claudeMd for deduplicated roles', () => {
      const sessionRoles = [
        { name: 'dev-1', displayName: 'Dev-1', roleType: 'dev', icon: '', description: '' },
        { name: 'dev-2', displayName: 'Dev-2', roleType: 'dev', icon: '', description: '' },
      ];
      const roleClaudes = {
        'dev-1': '# First dev instructions',
        'dev-2': '# Second dev instructions (should be skipped)',
      };
      const result = deduplicateRoles(sessionRoles, roleClaudes);
      expect(result[0].claudeMd).toBe('# First dev instructions');
    });

    it('handles roles without roleType (falls back to name)', () => {
      const sessionRoles = [
        { name: 'custom', displayName: 'Custom Role', icon: '', description: 'custom' },
      ];
      const result = deduplicateRoles(sessionRoles, {});
      expect(result[0].name).toBe('custom');
      expect(result[0].roleType).toBe('custom');
    });

    it('truncates claudeMd to MAX_CLAUDE_MD_LEN', () => {
      const longMd = 'x'.repeat(10000);
      const sessionRoles = [
        { name: 'dev', displayName: 'Dev', roleType: 'dev', icon: '', description: '' },
      ];
      const result = deduplicateRoles(sessionRoles, { dev: longMd });
      expect(result[0].claudeMd.length).toBe(MAX_CLAUDE_MD_LEN);
    });

    it('returns empty array for empty sessionRoles', () => {
      const result = deduplicateRoles([], {});
      expect(result).toEqual([]);
    });

    it('preserves icon and description from first occurrence', () => {
      const sessionRoles = [
        { name: 'rev-1', displayName: '审查者-1', roleType: 'reviewer', icon: '🔍', description: '代码审查' },
        { name: 'rev-2', displayName: '审查者-2', roleType: 'reviewer', icon: '🔎', description: '另一个描述' },
      ];
      const result = deduplicateRoles(sessionRoles, {});
      expect(result).toHaveLength(1);
      expect(result[0].icon).toBe('🔍');
      expect(result[0].description).toBe('代码审查');
    });

    it('handles full crew team: pm + dev-1/2/3 + rev-1/2/3 + test-1/2/3 + designer → 5 roles', () => {
      const sessionRoles = [
        { name: 'pm', displayName: 'PM', roleType: 'pm', icon: '📋', description: 'PM' },
        { name: 'dev-1', displayName: 'Dev-1', roleType: 'dev', icon: '💻', description: 'dev' },
        { name: 'dev-2', displayName: 'Dev-2', roleType: 'dev', icon: '💻', description: 'dev' },
        { name: 'dev-3', displayName: 'Dev-3', roleType: 'dev', icon: '💻', description: 'dev' },
        { name: 'rev-1', displayName: 'Rev-1', roleType: 'reviewer', icon: '🔍', description: 'review' },
        { name: 'rev-2', displayName: 'Rev-2', roleType: 'reviewer', icon: '🔍', description: 'review' },
        { name: 'rev-3', displayName: 'Rev-3', roleType: 'reviewer', icon: '🔍', description: 'review' },
        { name: 'test-1', displayName: 'Test-1', roleType: 'tester', icon: '🧪', description: 'test' },
        { name: 'test-2', displayName: 'Test-2', roleType: 'tester', icon: '🧪', description: 'test' },
        { name: 'test-3', displayName: 'Test-3', roleType: 'tester', icon: '🧪', description: 'test' },
        { name: 'designer', displayName: 'Designer', roleType: 'designer', icon: '🎨', description: 'design' },
      ];
      const result = deduplicateRoles(sessionRoles, {});
      expect(result).toHaveLength(5);
      const names = result.map(r => r.name);
      expect(names).toEqual(['pm', 'dev', 'reviewer', 'tester', 'designer']);
    });
  });

  // ---------------------------------------------------------------
  // 3. buildCrewContextBlock — prompt injection
  // ---------------------------------------------------------------

  describe('buildCrewContextBlock — prompt injection', () => {
    it('includes shared instructions section when sharedClaudeMd is present', () => {
      const block = buildCrewContextBlock({
        sharedClaudeMd: '# Project rules',
        kanban: '',
        features: [],
      }, true);
      expect(block).toContain('项目共享指令');
      expect(block).toContain('# Project rules');
    });

    it('includes kanban section when kanban is present', () => {
      const block = buildCrewContextBlock({
        sharedClaudeMd: '',
        kanban: '| task | status |',
        features: [],
      }, false);
      expect(block).toContain('Current Task Board');
      expect(block).toContain('| task | status |');
    });

    it('includes features section with truncation', () => {
      const longContent = 'x'.repeat(3000);
      const block = buildCrewContextBlock({
        sharedClaudeMd: '',
        kanban: '',
        features: [{ name: 'task-1', content: longContent }],
      }, false);
      expect(block).toContain('Work History');
      expect(block).toContain('### task-1');
      expect(block).toContain('...(truncated)');
    });

    it('limits to last 5 features', () => {
      const features = Array.from({ length: 10 }, (_, i) => ({
        name: `task-${i + 1}`,
        content: `Feature ${i + 1}`,
      }));
      const block = buildCrewContextBlock({
        sharedClaudeMd: '',
        kanban: '',
        features,
      }, false);
      // Should contain task-6 through task-10, not task-1 through task-5
      expect(block).toContain('### task-6');
      expect(block).toContain('### task-10');
      expect(block).not.toContain('### task-1\n');
    });

    it('returns empty string when all context is empty', () => {
      const block = buildCrewContextBlock({
        sharedClaudeMd: '',
        kanban: '',
        features: [],
      }, false);
      expect(block).toBe('');
    });

    it('uses Chinese headers when isZh is true', () => {
      const block = buildCrewContextBlock({
        sharedClaudeMd: 'content',
        kanban: 'kanban',
        features: [{ name: 't', content: 'c' }],
      }, true);
      expect(block).toContain('项目共享指令');
      expect(block).toContain('当前任务看板');
      expect(block).toContain('历史工作记录');
    });

    it('uses English headers when isZh is false', () => {
      const block = buildCrewContextBlock({
        sharedClaudeMd: 'content',
        kanban: 'kanban',
        features: [{ name: 't', content: 'c' }],
      }, false);
      expect(block).toContain('Shared Project Instructions');
      expect(block).toContain('Current Task Board');
      expect(block).toContain('Work History');
    });
  });

  // ---------------------------------------------------------------
  // 4. handleCheckCrewContext — WS handler
  // ---------------------------------------------------------------

  describe('handleCheckCrewContext — WS handler', () => {
    it('returns found: false when projectDir is empty', () => {
      const sent = [];
      handleCheckCrewContext({ projectDir: '', requestId: 'r1' }, m => sent.push(m));
      expect(sent).toHaveLength(1);
      expect(sent[0].found).toBe(false);
    });

    it('returns found: false when projectDir is null', () => {
      const sent = [];
      handleCheckCrewContext({ projectDir: null, requestId: 'r2' }, m => sent.push(m));
      expect(sent[0].found).toBe(false);
    });

    it('returns found: false when no .crew directory', () => {
      const projectDir = join(tmpDir, 'no-crew');
      mkdirSync(projectDir, { recursive: true });
      const sent = [];
      handleCheckCrewContext({ projectDir, requestId: 'r3' }, m => sent.push(m));
      expect(sent[0].found).toBe(false);
    });

    it('returns found: true with roles when .crew exists', () => {
      const projectDir = createCrewDir(tmpDir, {
        sessionJson: {
          roles: [
            { name: 'pm', displayName: 'PM', roleType: 'pm', icon: '📋', description: 'PM' },
            { name: 'dev-1', displayName: 'Dev-1', roleType: 'dev', icon: '💻', description: 'dev' },
          ],
        },
        roles: { 'pm': '# PM instructions' },
      });
      const sent = [];
      handleCheckCrewContext({ projectDir, requestId: 'r4' }, m => sent.push(m));
      expect(sent[0].found).toBe(true);
      expect(sent[0].roles).toHaveLength(2);
      expect(sent[0].requestId).toBe('r4');
      expect(sent[0].teamType).toBe('dev');
    });

    it('does not send full claudeMd to frontend (only hasClaudeMd flag)', () => {
      const projectDir = createCrewDir(tmpDir, {
        sessionJson: {
          roles: [{ name: 'pm', displayName: 'PM', roleType: 'pm', icon: '', description: '' }],
        },
        roles: { 'pm': '# Sensitive instructions' },
      });
      const sent = [];
      handleCheckCrewContext({ projectDir, requestId: 'r5' }, m => sent.push(m));
      const pmRole = sent[0].roles[0];
      expect(pmRole.hasClaudeMd).toBe(true);
      expect(pmRole.claudeMd).toBeUndefined();
    });

    it('includes featureCount in response', () => {
      const projectDir = createCrewDir(tmpDir, {
        features: { 'task-1': 'content', 'task-2': 'content' },
      });
      const sent = [];
      handleCheckCrewContext({ projectDir, requestId: 'r6' }, m => sent.push(m));
      expect(sent[0].featureCount).toBe(2);
    });

    it('preserves requestId for response matching', () => {
      const projectDir = createCrewDir(tmpDir, {});
      const sent = [];
      const reqId = 'unique_req_' + Date.now();
      handleCheckCrewContext({ projectDir, requestId: reqId }, m => sent.push(m));
      expect(sent[0].requestId).toBe(reqId);
    });
  });

  // ---------------------------------------------------------------
  // 5. Full integration: loadCrewContext → buildCrewContextBlock
  // ---------------------------------------------------------------

  describe('integration: load → build context', () => {
    it('loads full .crew structure and produces valid context block', () => {
      const projectDir = createCrewDir(tmpDir, {
        claudeMd: '# Shared\nFollow conventions.',
        sessionJson: {
          roles: [
            { name: 'pm', displayName: 'PM', roleType: 'pm', icon: '📋', description: 'PM' },
            { name: 'dev-1', displayName: 'Dev-1', roleType: 'dev', icon: '💻', description: 'dev' },
            { name: 'dev-2', displayName: 'Dev-2', roleType: 'dev', icon: '💻', description: 'dev' },
          ],
          teamType: 'dev',
          language: 'zh-CN',
        },
        roles: { 'pm': '# PM Role', 'dev-1': '# Dev Role' },
        kanban: '# Kanban\nAll tasks done.',
        features: { 'task-1': '# Task 1\nCompleted.' },
      });

      const ctx = loadCrewContext(projectDir);
      expect(ctx.roles).toHaveLength(2); // pm + dev (deduped)

      const block = buildCrewContextBlock(ctx, true);
      expect(block).toContain('项目共享指令');
      expect(block).toContain('# Shared');
      expect(block).toContain('当前任务看板');
      expect(block).toContain('# Kanban');
      expect(block).toContain('历史工作记录');
      expect(block).toContain('### task-1');
    });
  });
});

// =====================================================================
// 6. Frontend static analysis tests
// =====================================================================

describe('task-10: Frontend & infrastructure', () => {
  let configPanelSource;
  let messageHandlerSource;
  let clientConvSource;
  let agentConvSource;
  let messageRouterSource;
  let zhSource;
  let enSource;
  let cssSource;
  let roleplayJsSource;

  beforeEach(() => {
    const base = resolve(__dirname2, '../../');
    configPanelSource = readFileSync(resolve(webBase, 'components/RolePlayConfigPanel.js'), 'utf-8');
    messageHandlerSource = readFileSync(resolve(webBase, 'stores/helpers/messageHandler.js'), 'utf-8');
    clientConvSource = readFileSync(resolve(base, 'server/handlers/client-conversation.js'), 'utf-8');
    agentConvSource = readFileSync(resolve(base, 'server/handlers/agent-conversation.js'), 'utf-8');
    messageRouterSource = readFileSync(resolve(base, 'agent/connection/message-router.js'), 'utf-8');
    zhSource = readFileSync(resolve(webBase, 'i18n/zh-CN.js'), 'utf-8');
    enSource = readFileSync(resolve(webBase, 'i18n/en.js'), 'utf-8');
    cssSource = readFileSync(resolve(webBase, 'styles/crew-config.css'), 'utf-8');
    roleplayJsSource = readFileSync(resolve(base, 'agent/roleplay.js'), 'utf-8');
  });

  // ---------------------------------------------------------------
  // RolePlayConfigPanel — crew detection
  // ---------------------------------------------------------------

  describe('RolePlayConfigPanel — crew context detection', () => {
    it('has crewDetected data property', () => {
      expect(configPanelSource).toContain('crewDetected');
    });

    it('has _crewCheckRequestId for request matching', () => {
      expect(configPanelSource).toContain('_crewCheckRequestId');
    });

    it('watches projectDir with debounce timer', () => {
      expect(configPanelSource).toContain("projectDir(newVal)");
      expect(configPanelSource).toContain('_dirCheckTimer');
      expect(configPanelSource).toContain('setTimeout');
    });

    it('debounce is set to 400ms', () => {
      expect(configPanelSource).toContain('400');
    });

    it('sends check_crew_context WS message with requestId', () => {
      expect(configPanelSource).toContain("type: 'check_crew_context'");
      expect(configPanelSource).toContain('requestId');
      expect(configPanelSource).toContain('projectDir');
    });

    it('listens for crew-context-result window event', () => {
      expect(configPanelSource).toContain("addEventListener('crew-context-result'");
    });

    it('cleans up event listener in beforeUnmount', () => {
      expect(configPanelSource).toContain("removeEventListener('crew-context-result'");
    });

    it('clears debounce timer in beforeUnmount', () => {
      expect(configPanelSource).toContain('clearTimeout(this._dirCheckTimer)');
    });

    it('checkCrewContext resets crewDetected when dir is empty', () => {
      // Method should set crewDetected = false at the start
      const checkFn = configPanelSource.split('checkCrewContext(dir)')[1]?.split('handleCrewContextResult')[0] || '';
      expect(checkFn).toContain('crewDetected = false');
    });

    it('handleCrewContextResult validates requestId match', () => {
      // The method definition is the 2nd occurrence (1st is the call in created())
      const methodsSection = configPanelSource.split('methods:')[1] || '';
      const handler = methodsSection.split('handleCrewContextResult')[1]?.split('  },')[0] || '';
      expect(handler).toContain('_crewCheckRequestId');
      expect(handler).toContain('return');
    });

    it('handleCrewContextResult imports roles when found', () => {
      const methodsSection = configPanelSource.split('methods:')[1] || '';
      const handler = methodsSection.split('handleCrewContextResult')[1]?.split('  },')[0] || '';
      expect(handler).toContain('this.roles');
      expect(handler).toContain('msg.roles');
    });
  });

  // ---------------------------------------------------------------
  // RolePlayConfigPanel — banner display
  // ---------------------------------------------------------------

  describe('RolePlayConfigPanel — crew import banner', () => {
    it('has crew-import-banner element controlled by v-if with crewDetected', () => {
      expect(configPanelSource).toContain('crew-import-banner');
      expect(configPanelSource).toContain('crewDetected');
    });

    it('banner uses roleplay.crewDetected i18n key', () => {
      expect(configPanelSource).toContain("$t('roleplay.crewDetected')");
    });

    it('banner has a checkmark SVG icon', () => {
      // Check SVG path for checkmark (the specific path from the diff)
      const bannerSection = configPanelSource.split('crew-import-banner')[1]?.split('</div>')[0] || '';
      expect(bannerSection).toContain('<svg');
    });
  });

  // ---------------------------------------------------------------
  // WS message routing chain
  // ---------------------------------------------------------------

  describe('WS message routing — check_crew_context chain', () => {
    it('client-conversation.js handles check_crew_context', () => {
      expect(clientConvSource).toContain("case 'check_crew_context'");
    });

    it('client-conversation.js forwards to agent with _requestClientId', () => {
      // The case block contains 'check_crew_context' twice (case label + forwarded type),
      // so grab text from case label through the closing break
      const caseStart = clientConvSource.indexOf("case 'check_crew_context'");
      const caseBlock = clientConvSource.substring(caseStart, caseStart + 500);
      expect(caseBlock).toContain('forwardToAgent');
      expect(caseBlock).toContain('_requestClientId');
    });

    it('client-conversation.js validates agentId access', () => {
      const checkBlock = clientConvSource.split("'check_crew_context'")[1]?.split('break')[0] || '';
      expect(checkBlock).toContain('checkAgentAccess');
    });

    it('agent message-router.js routes check_crew_context to handler', () => {
      expect(messageRouterSource).toContain("case 'check_crew_context'");
      expect(messageRouterSource).toContain('handleCheckCrewContext');
    });

    it('agent-conversation.js forwards crew_context_result to clients', () => {
      expect(agentConvSource).toContain("case 'crew_context_result'");
    });

    it('messageHandler.js dispatches crew-context-result custom event', () => {
      expect(messageHandlerSource).toContain("case 'crew_context_result'");
      expect(messageHandlerSource).toContain("new CustomEvent('crew-context-result'");
    });
  });

  // ---------------------------------------------------------------
  // Backend: roleplay.js exports
  // ---------------------------------------------------------------

  describe('agent/roleplay.js — new exports', () => {
    it('exports loadCrewContext function', () => {
      expect(roleplayJsSource).toContain('export function loadCrewContext');
    });

    it('loadCrewContext checks for .crew directory', () => {
      const fn = roleplayJsSource.split('function loadCrewContext')[1]?.split('\nexport')[0] || '';
      expect(fn).toContain('.crew');
      expect(fn).toContain('existsSync');
    });

    it('deduplicateRoles function exists', () => {
      expect(roleplayJsSource).toContain('function deduplicateRoles');
    });

    it('buildCrewContextBlock function exists', () => {
      expect(roleplayJsSource).toContain('function buildCrewContextBlock');
    });

    it('buildRolePlaySystemPrompt accepts crewContext parameter', () => {
      const fn = roleplayJsSource.split('function buildRolePlaySystemPrompt')[1]?.split('\n}')[0] || '';
      expect(fn).toContain('crewContext');
    });

    it('buildRolePlaySystemPrompt appends crew context block when crewContext is present', () => {
      const fn = roleplayJsSource.split('function buildRolePlaySystemPrompt')[1]?.split('\n}')[0] || '';
      expect(fn).toContain('buildCrewContextBlock');
    });
  });

  // ---------------------------------------------------------------
  // conversation.js integration
  // ---------------------------------------------------------------

  describe('agent/conversation.js — crewContext integration', () => {
    let convSource;

    beforeEach(() => {
      convSource = readFileSync(resolve(__dirname2, '../../agent/conversation.js'), 'utf-8');
    });

    it('imports loadCrewContext from roleplay.js', () => {
      expect(convSource).toContain('loadCrewContext');
    });

    it('calls loadCrewContext when rolePlayConfig is present', () => {
      const createFn = convSource.split('async function createConversation')[1]?.split('\nexport')[0] || '';
      expect(createFn).toContain('loadCrewContext');
      expect(createFn).toContain('rolePlayConfig');
    });

    it('attaches crewContext to rolePlayConfig', () => {
      const createFn = convSource.split('async function createConversation')[1]?.split('\nexport')[0] || '';
      expect(createFn).toContain('rolePlayConfig.crewContext');
    });

    it('exports handleCheckCrewContext', () => {
      expect(convSource).toContain('export function handleCheckCrewContext');
    });
  });

  // ---------------------------------------------------------------
  // i18n keys
  // ---------------------------------------------------------------

  describe('i18n — roleplay.crewDetected key', () => {
    it('zh-CN has roleplay.crewDetected key', () => {
      expect(zhSource).toContain("'roleplay.crewDetected'");
    });

    it('en has roleplay.crewDetected key', () => {
      expect(enSource).toContain("'roleplay.crewDetected'");
    });

    it('zh-CN value mentions .crew and auto-import', () => {
      // Extract value
      const match = zhSource.match(/roleplay\.crewDetected['"]\s*:\s*['"]([^'"]+)/);
      expect(match).not.toBeNull();
      expect(match[1]).toContain('.crew');
    });

    it('en value mentions .crew and auto-import', () => {
      const match = enSource.match(/roleplay\.crewDetected['"]\s*:\s*['"]([^'"]+)/);
      expect(match).not.toBeNull();
      expect(match[1]).toContain('.crew');
    });
  });

  // ---------------------------------------------------------------
  // CSS — crew-import-banner style
  // ---------------------------------------------------------------

  describe('CSS — crew-import-banner', () => {
    it('.crew-import-banner style exists', () => {
      expect(cssSource).toContain('.crew-import-banner');
    });

    it('.crew-import-banner has flex layout', () => {
      expect(cssSource).toMatch(/\.crew-import-banner\s*\{[^}]*display:\s*flex/);
    });

    it('.crew-import-banner has border and background', () => {
      expect(cssSource).toMatch(/\.crew-import-banner\s*\{[^}]*border:/);
      expect(cssSource).toMatch(/\.crew-import-banner\s*\{[^}]*background:/);
    });

    it('.crew-import-banner has border-radius', () => {
      expect(cssSource).toMatch(/\.crew-import-banner\s*\{[^}]*border-radius:/);
    });

    it('crew-config.css has balanced braces', () => {
      const opens = (cssSource.match(/\{/g) || []).length;
      const closes = (cssSource.match(/\}/g) || []).length;
      expect(opens).toBe(closes);
    });
  });
});
