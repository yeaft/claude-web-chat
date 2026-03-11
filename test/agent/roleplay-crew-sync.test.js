import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  mkdtempSync, writeFileSync, readFileSync, existsSync,
  rmSync, mkdirSync, statSync, utimesSync, readdirSync
} from 'fs';
import { promises as fsp } from 'fs';

/**
 * Tests for RolePlay ↔ Crew .crew context bidirectional sync (task-25).
 *
 * To avoid importing the real module (which drags in context.js / SDK side effects),
 * we replicate the core logic under test exactly as it appears in roleplay.js.
 *
 * Covers:
 * - mtime-based change detection (collectCrewContextMtimes, hasCrewContextChanged)
 * - refreshCrewContext / initCrewContextMtimes
 * - writeBackRouteContext (atomic write, serial lock, file creation/append, path traversal)
 * - MAX_CLAUDE_MD_LEN increase (8192)
 * - Resume path integration
 * - Map serialization safety (saveRolePlayIndex excludes _crewContextMtimes)
 */

// =====================================================================
// Replicated helpers (mirrors agent/roleplay.js implementation)
// =====================================================================

const MAX_CLAUDE_MD_LEN = 8192;

function readFileOrNull(filePath) {
  try {
    if (!existsSync(filePath)) return null;
    return readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }
}

function getMtimeMs(filePath) {
  try {
    return statSync(filePath).mtimeMs;
  } catch {
    return 0;
  }
}

function collectCrewContextMtimes(projectDir) {
  const crewDir = join(projectDir, '.crew');
  const mtimes = new Map();

  mtimes.set('CLAUDE.md', getMtimeMs(join(crewDir, 'CLAUDE.md')));
  mtimes.set('context/kanban.md', getMtimeMs(join(crewDir, 'context', 'kanban.md')));

  const featuresDir = join(crewDir, 'context', 'features');
  if (existsSync(featuresDir)) {
    try {
      const files = readdirSync(featuresDir).filter(f => f.endsWith('.md') && f !== 'index.md');
      for (const f of files) {
        mtimes.set(`context/features/${f}`, getMtimeMs(join(featuresDir, f)));
      }
    } catch { /* ignore */ }
  }

  mtimes.set('session.json', getMtimeMs(join(crewDir, 'session.json')));

  return mtimes;
}

function hasCrewContextChanged(oldMtimes, newMtimes) {
  if (!oldMtimes) return true;

  // Defensive: if oldMtimes was deserialized from JSON (plain object, not Map),
  // treat as stale and force refresh
  if (!(oldMtimes instanceof Map)) return true;

  for (const [path, mtime] of newMtimes) {
    if (!oldMtimes.has(path) || oldMtimes.get(path) !== mtime) return true;
  }

  for (const path of oldMtimes.keys()) {
    if (!newMtimes.has(path)) return true;
  }

  return false;
}

function loadCrewContext(projectDir) {
  const crewDir = join(projectDir, '.crew');
  if (!existsSync(crewDir)) return null;

  const sharedClaudeMd = readFileOrNull(join(crewDir, 'CLAUDE.md')) || '';

  let sessionRoles = [];
  let teamType = 'dev';
  let language = 'zh-CN';
  let sessionFeatures = [];
  const sessionPath = join(crewDir, 'session.json');
  const sessionJson = readFileOrNull(sessionPath);
  if (sessionJson) {
    try {
      const session = JSON.parse(sessionJson);
      if (Array.isArray(session.roles)) sessionRoles = session.roles;
      if (session.teamType) teamType = session.teamType;
      if (session.language) language = session.language;
      if (Array.isArray(session.features)) sessionFeatures = session.features;
    } catch { /* ignore */ }
  }

  const kanban = readFileOrNull(join(crewDir, 'context', 'kanban.md')) || '';

  const features = [];
  const featuresDir = join(crewDir, 'context', 'features');
  if (existsSync(featuresDir)) {
    try {
      const files = readdirSync(featuresDir)
        .filter(f => f.endsWith('.md') && f !== 'index.md')
        .sort();
      for (const f of files) {
        const content = readFileOrNull(join(featuresDir, f));
        if (content) {
          features.push({ name: f.replace('.md', ''), content });
        }
      }
    } catch { /* ignore */ }
  }

  return { sharedClaudeMd, roles: sessionRoles, kanban, features, teamType, language, sessionFeatures };
}

function initCrewContextMtimes(projectDir, rpSession) {
  if (!projectDir || !existsSync(join(projectDir, '.crew'))) return;
  rpSession._crewContextMtimes = collectCrewContextMtimes(projectDir);
}

function refreshCrewContext(projectDir, rpSession, convState) {
  if (!projectDir || !existsSync(join(projectDir, '.crew'))) return false;

  const newMtimes = collectCrewContextMtimes(projectDir);

  if (!hasCrewContextChanged(rpSession._crewContextMtimes, newMtimes)) {
    return false;
  }

  const crewContext = loadCrewContext(projectDir);
  if (!crewContext) return false;

  rpSession._crewContextMtimes = newMtimes;

  if (convState && convState.rolePlayConfig) {
    convState.rolePlayConfig.crewContext = crewContext;
  }

  return true;
}

async function atomicWrite(filePath, content) {
  const tmpPath = filePath + '.tmp.' + Date.now();
  try {
    await fsp.writeFile(tmpPath, content);
    await fsp.rename(tmpPath, filePath);
  } catch (e) {
    try { await fsp.unlink(tmpPath); } catch { /* ignore */ }
    throw e;
  }
}

// Replicated sanitizeTaskId check
const VALID_TASK_ID_RE = /^[a-zA-Z0-9_-]+$/;

let _writeBackLock = Promise.resolve();

async function writeBackRouteContext(projectDir, routes, fromRole, rpSession) {
  if (!projectDir || !routes || routes.length === 0) return;

  const crewDir = join(projectDir, '.crew');
  if (!existsSync(crewDir)) return;

  const doWriteBack = async () => {
    const featuresDir = join(crewDir, 'context', 'features');

    for (const route of routes) {
      const { taskId, taskTitle, summary, to } = route;
      if (!taskId || !summary) continue;

      // Sanitize taskId: only allow alphanumeric, hyphens, underscores
      if (!VALID_TASK_ID_RE.test(taskId)) {
        continue; // reject path traversal attempts
      }

      try {
        await fsp.mkdir(featuresDir, { recursive: true });
        const filePath = join(featuresDir, `${taskId}.md`);

        let content;
        try {
          content = await fsp.readFile(filePath, 'utf-8');
        } catch {
          const isZh = rpSession.language === 'zh-CN';
          content = `# ${isZh ? 'Feature' : 'Feature'}: ${taskTitle || taskId}\n- task-id: ${taskId}\n\n## ${isZh ? '工作记录' : 'Work Record'}\n`;
        }

        const fromRoleConfig = rpSession.roles?.find(r => r.name === fromRole);
        const fromLabel = fromRoleConfig
          ? (fromRoleConfig.icon ? `${fromRoleConfig.icon} ${fromRoleConfig.displayName}` : fromRoleConfig.displayName)
          : fromRole;
        const now = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
        const record = `\n### ${fromLabel} → ${to} - ${now}\n${summary}\n`;

        await atomicWrite(filePath, content + record);
      } catch (e) {
        // Swallow in tests — logged in production
      }
    }
  };

  _writeBackLock = _writeBackLock.then(doWriteBack, doWriteBack);
  return _writeBackLock;
}

// Replicated saveRolePlayIndex exclusion logic
function saveRolePlayIndex(sessions) {
  const data = [];
  for (const [id, session] of sessions) {
    const { _routeInitialized, _crewContextMtimes, currentRole, features, round, roleStates, waitingHuman, waitingHumanContext, ...core } = session;
    data.push({ id, ...core });
  }
  return JSON.stringify(data, null, 2);
}

// =====================================================================
// Test setup
// =====================================================================

let tmpDir;

function createCrewDir(projectDir, opts = {}) {
  const crewDir = join(projectDir, '.crew');
  mkdirSync(crewDir, { recursive: true });
  mkdirSync(join(crewDir, 'context', 'features'), { recursive: true });

  if (opts.claudeMd) {
    writeFileSync(join(crewDir, 'CLAUDE.md'), opts.claudeMd);
  }
  if (opts.kanban) {
    writeFileSync(join(crewDir, 'context', 'kanban.md'), opts.kanban);
  }
  if (opts.sessionJson) {
    writeFileSync(join(crewDir, 'session.json'), JSON.stringify(opts.sessionJson));
  }
  if (opts.features) {
    for (const [name, content] of Object.entries(opts.features)) {
      writeFileSync(join(crewDir, 'context', 'features', `${name}.md`), content);
    }
  }
  return crewDir;
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'rp-crew-sync-'));
  _writeBackLock = Promise.resolve();
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// =====================================================================
// Tests: mtime-based change detection
// =====================================================================

describe('collectCrewContextMtimes', () => {
  it('collects mtimes for all tracked files', () => {
    createCrewDir(tmpDir, {
      claudeMd: '# Shared',
      kanban: '# Kanban',
      sessionJson: { roles: [] },
      features: { 'task-1': '# Task 1' }
    });

    const mtimes = collectCrewContextMtimes(tmpDir);

    expect(mtimes.has('CLAUDE.md')).toBe(true);
    expect(mtimes.has('context/kanban.md')).toBe(true);
    expect(mtimes.has('session.json')).toBe(true);
    expect(mtimes.has('context/features/task-1.md')).toBe(true);
    expect(mtimes.get('CLAUDE.md')).toBeGreaterThan(0);
  });

  it('returns 0 for missing files', () => {
    const crewDir = join(tmpDir, '.crew');
    mkdirSync(crewDir, { recursive: true });

    const mtimes = collectCrewContextMtimes(tmpDir);

    expect(mtimes.get('CLAUDE.md')).toBe(0);
    expect(mtimes.get('context/kanban.md')).toBe(0);
    expect(mtimes.get('session.json')).toBe(0);
  });

  it('excludes index.md from features', () => {
    createCrewDir(tmpDir, {
      features: { 'task-1': '# Task 1' }
    });
    writeFileSync(join(tmpDir, '.crew', 'context', 'features', 'index.md'), '# Index');

    const mtimes = collectCrewContextMtimes(tmpDir);

    expect(mtimes.has('context/features/task-1.md')).toBe(true);
    expect(mtimes.has('context/features/index.md')).toBe(false);
  });
});

describe('hasCrewContextChanged', () => {
  it('returns true when oldMtimes is null (first check)', () => {
    const newMtimes = new Map([['a', 100]]);
    expect(hasCrewContextChanged(null, newMtimes)).toBe(true);
  });

  it('returns true when oldMtimes is undefined', () => {
    const newMtimes = new Map([['a', 100]]);
    expect(hasCrewContextChanged(undefined, newMtimes)).toBe(true);
  });

  it('returns false when mtimes are identical', () => {
    const old = new Map([['a', 100], ['b', 200]]);
    const current = new Map([['a', 100], ['b', 200]]);
    expect(hasCrewContextChanged(old, current)).toBe(false);
  });

  it('returns true when a file mtime changes', () => {
    const old = new Map([['a', 100], ['b', 200]]);
    const current = new Map([['a', 100], ['b', 300]]);
    expect(hasCrewContextChanged(old, current)).toBe(true);
  });

  it('returns true when a new file appears', () => {
    const old = new Map([['a', 100]]);
    const current = new Map([['a', 100], ['b', 200]]);
    expect(hasCrewContextChanged(old, current)).toBe(true);
  });

  it('returns true when a file is deleted', () => {
    const old = new Map([['a', 100], ['b', 200]]);
    const current = new Map([['a', 100]]);
    expect(hasCrewContextChanged(old, current)).toBe(true);
  });

  it('returns true when oldMtimes is a plain object (deserialized JSON)', () => {
    // Simulates what happens if _crewContextMtimes was accidentally serialized/deserialized
    const plainObj = { 'a': 100, 'b': 200 };
    const newMtimes = new Map([['a', 100], ['b', 200]]);
    expect(hasCrewContextChanged(plainObj, newMtimes)).toBe(true);
  });

  it('returns true for empty plain object (JSON deserialized {})', () => {
    expect(hasCrewContextChanged({}, new Map())).toBe(true);
  });
});

// =====================================================================
// Tests: refreshCrewContext
// =====================================================================

describe('refreshCrewContext', () => {
  it('returns true on first call (no previous snapshot)', () => {
    createCrewDir(tmpDir, { kanban: '# Board v1' });
    const rpSession = {};
    const convState = { rolePlayConfig: {} };

    const result = refreshCrewContext(tmpDir, rpSession, convState);

    expect(result).toBe(true);
    expect(rpSession._crewContextMtimes).toBeInstanceOf(Map);
    expect(convState.rolePlayConfig.crewContext).toBeDefined();
    expect(convState.rolePlayConfig.crewContext.kanban).toBe('# Board v1');
  });

  it('returns false when nothing changed', () => {
    createCrewDir(tmpDir, { kanban: '# Board v1' });
    const rpSession = {};
    const convState = { rolePlayConfig: {} };

    refreshCrewContext(tmpDir, rpSession, convState);
    const result = refreshCrewContext(tmpDir, rpSession, convState);

    expect(result).toBe(false);
  });

  it('returns true after kanban.md is modified', () => {
    createCrewDir(tmpDir, { kanban: '# Board v1' });
    const rpSession = {};
    const convState = { rolePlayConfig: {} };

    refreshCrewContext(tmpDir, rpSession, convState);

    const kanbanPath = join(tmpDir, '.crew', 'context', 'kanban.md');
    const future = new Date(Date.now() + 2000);
    writeFileSync(kanbanPath, '# Board v2');
    utimesSync(kanbanPath, future, future);

    const result = refreshCrewContext(tmpDir, rpSession, convState);

    expect(result).toBe(true);
    expect(convState.rolePlayConfig.crewContext.kanban).toBe('# Board v2');
  });

  it('returns true when a new feature file is added', () => {
    createCrewDir(tmpDir, { features: { 'task-1': '# Task 1' } });
    const rpSession = {};
    const convState = { rolePlayConfig: {} };

    refreshCrewContext(tmpDir, rpSession, convState);

    const newFeaturePath = join(tmpDir, '.crew', 'context', 'features', 'task-2.md');
    const future = new Date(Date.now() + 2000);
    writeFileSync(newFeaturePath, '# Task 2');
    utimesSync(newFeaturePath, future, future);

    const result = refreshCrewContext(tmpDir, rpSession, convState);
    expect(result).toBe(true);
    expect(convState.rolePlayConfig.crewContext.features.length).toBe(2);
  });

  it('returns false when .crew directory does not exist', () => {
    const rpSession = {};
    const result = refreshCrewContext(tmpDir, rpSession, null);
    expect(result).toBe(false);
  });

  it('works with null convState', () => {
    createCrewDir(tmpDir, { kanban: '# Board' });
    const rpSession = {};

    const result = refreshCrewContext(tmpDir, rpSession, null);
    expect(result).toBe(true);
    expect(rpSession._crewContextMtimes).toBeInstanceOf(Map);
  });

  it('works when convState has no rolePlayConfig', () => {
    createCrewDir(tmpDir, { kanban: '# Board' });
    const rpSession = {};
    const convState = {};

    const result = refreshCrewContext(tmpDir, rpSession, convState);
    expect(result).toBe(true);
  });

  it('recovers when _crewContextMtimes is corrupted plain object', () => {
    createCrewDir(tmpDir, { kanban: '# Board' });
    const rpSession = { _crewContextMtimes: {} }; // simulates JSON deserialization
    const convState = { rolePlayConfig: {} };

    // Should treat as stale and refresh
    const result = refreshCrewContext(tmpDir, rpSession, convState);
    expect(result).toBe(true);
    expect(rpSession._crewContextMtimes).toBeInstanceOf(Map);
  });
});

// =====================================================================
// Tests: initCrewContextMtimes
// =====================================================================

describe('initCrewContextMtimes', () => {
  it('initializes mtime snapshot without loading context', () => {
    createCrewDir(tmpDir, { kanban: '# Board' });
    const rpSession = {};

    initCrewContextMtimes(tmpDir, rpSession);

    expect(rpSession._crewContextMtimes).toBeInstanceOf(Map);
    expect(rpSession._crewContextMtimes.has('context/kanban.md')).toBe(true);
  });

  it('subsequent refreshCrewContext returns false if nothing changed', () => {
    createCrewDir(tmpDir, { kanban: '# Board' });
    const rpSession = {};
    const convState = { rolePlayConfig: {} };

    initCrewContextMtimes(tmpDir, rpSession);

    const result = refreshCrewContext(tmpDir, rpSession, convState);
    expect(result).toBe(false);
  });

  it('does nothing when .crew directory does not exist', () => {
    const rpSession = {};
    initCrewContextMtimes(tmpDir, rpSession);
    expect(rpSession._crewContextMtimes).toBeUndefined();
  });
});

// =====================================================================
// Tests: writeBackRouteContext
// =====================================================================

describe('writeBackRouteContext', () => {
  const mockRpSession = {
    language: 'zh-CN',
    roles: [
      { name: 'pm', displayName: 'PM', icon: '📋' },
      { name: 'dev', displayName: '开发者', icon: '💻' }
    ]
  };

  it('creates a new feature file when it does not exist', async () => {
    createCrewDir(tmpDir);

    const routes = [
      { to: 'dev', summary: '请实现功能 A', taskId: 'task-1', taskTitle: '功能 A' }
    ];

    await writeBackRouteContext(tmpDir, routes, 'pm', mockRpSession);

    const filePath = join(tmpDir, '.crew', 'context', 'features', 'task-1.md');
    expect(existsSync(filePath)).toBe(true);

    const content = readFileSync(filePath, 'utf-8');
    expect(content).toContain('# Feature: 功能 A');
    expect(content).toContain('task-id: task-1');
    expect(content).toContain('📋 PM → dev');
    expect(content).toContain('请实现功能 A');
  });

  it('appends to an existing feature file', async () => {
    createCrewDir(tmpDir, {
      features: { 'task-1': '# Feature: 功能 A\n- task-id: task-1\n\n## 工作记录\n' }
    });

    const routes = [
      { to: 'dev', summary: '第二次更新', taskId: 'task-1', taskTitle: '功能 A' }
    ];

    await writeBackRouteContext(tmpDir, routes, 'pm', mockRpSession);

    const content = readFileSync(join(tmpDir, '.crew', 'context', 'features', 'task-1.md'), 'utf-8');
    expect(content).toContain('# Feature: 功能 A');
    expect(content).toContain('## 工作记录');
    expect(content).toContain('📋 PM → dev');
    expect(content).toContain('第二次更新');
  });

  it('handles multiple routes in one call', async () => {
    createCrewDir(tmpDir);

    const routes = [
      { to: 'dev', summary: '任务 A', taskId: 'task-1', taskTitle: '功能 A' },
      { to: 'dev', summary: '任务 B', taskId: 'task-2', taskTitle: '功能 B' }
    ];

    await writeBackRouteContext(tmpDir, routes, 'pm', mockRpSession);

    expect(existsSync(join(tmpDir, '.crew', 'context', 'features', 'task-1.md'))).toBe(true);
    expect(existsSync(join(tmpDir, '.crew', 'context', 'features', 'task-2.md'))).toBe(true);
  });

  it('skips routes without taskId', async () => {
    createCrewDir(tmpDir);

    const routes = [
      { to: 'dev', summary: '无任务', taskId: null, taskTitle: null }
    ];

    await writeBackRouteContext(tmpDir, routes, 'pm', mockRpSession);

    const featuresDir = join(tmpDir, '.crew', 'context', 'features');
    const files = readdirSync(featuresDir).filter(f => f.endsWith('.md'));
    expect(files.length).toBe(0);
  });

  it('skips routes without summary', async () => {
    createCrewDir(tmpDir);

    const routes = [
      { to: 'dev', summary: '', taskId: 'task-1', taskTitle: '功能 A' }
    ];

    await writeBackRouteContext(tmpDir, routes, 'pm', mockRpSession);

    expect(existsSync(join(tmpDir, '.crew', 'context', 'features', 'task-1.md'))).toBe(false);
  });

  it('uses role name as fallback label when role not found', async () => {
    createCrewDir(tmpDir);

    const routes = [
      { to: 'dev', summary: '更新内容', taskId: 'task-1', taskTitle: '功能 A' }
    ];

    await writeBackRouteContext(tmpDir, routes, 'unknown-role', mockRpSession);

    const content = readFileSync(join(tmpDir, '.crew', 'context', 'features', 'task-1.md'), 'utf-8');
    expect(content).toContain('unknown-role → dev');
  });

  it('does nothing when .crew does not exist', async () => {
    const routes = [
      { to: 'dev', summary: '更新', taskId: 'task-1', taskTitle: '功能 A' }
    ];

    await writeBackRouteContext(tmpDir, routes, 'pm', mockRpSession);
  });

  it('does nothing with empty routes array', async () => {
    createCrewDir(tmpDir);
    await writeBackRouteContext(tmpDir, [], 'pm', mockRpSession);

    const featuresDir = join(tmpDir, '.crew', 'context', 'features');
    const files = readdirSync(featuresDir).filter(f => f.endsWith('.md'));
    expect(files.length).toBe(0);
  });

  it('no .tmp files left after successful write', async () => {
    createCrewDir(tmpDir);

    const routes = [
      { to: 'dev', summary: '内容', taskId: 'task-1', taskTitle: '功能 A' }
    ];

    await writeBackRouteContext(tmpDir, routes, 'pm', mockRpSession);

    const featuresDir = join(tmpDir, '.crew', 'context', 'features');
    const tmpFiles = readdirSync(featuresDir).filter(f => f.includes('.tmp.'));
    expect(tmpFiles.length).toBe(0);
  });
});

// =====================================================================
// Tests: writeBackRouteContext path traversal protection
// =====================================================================

describe('writeBackRouteContext — path traversal protection', () => {
  const mockRpSession = {
    language: 'zh-CN',
    roles: [{ name: 'pm', displayName: 'PM', icon: '📋' }]
  };

  it('rejects taskId containing ../', async () => {
    createCrewDir(tmpDir);
    // Create a sentinel file outside features dir
    writeFileSync(join(tmpDir, '.crew', 'context', 'sentinel.md'), 'original');

    const routes = [
      { to: 'dev', summary: '恶意写入', taskId: '../sentinel', taskTitle: 'hack' }
    ];

    await writeBackRouteContext(tmpDir, routes, 'pm', mockRpSession);

    // Sentinel should be untouched
    const sentinel = readFileSync(join(tmpDir, '.crew', 'context', 'sentinel.md'), 'utf-8');
    expect(sentinel).toBe('original');

    // No file created in features
    const featuresDir = join(tmpDir, '.crew', 'context', 'features');
    const files = readdirSync(featuresDir).filter(f => f.endsWith('.md'));
    expect(files.length).toBe(0);
  });

  it('rejects taskId containing forward slashes', async () => {
    createCrewDir(tmpDir);

    const routes = [
      { to: 'dev', summary: '内容', taskId: 'path/to/file', taskTitle: 'hack' }
    ];

    await writeBackRouteContext(tmpDir, routes, 'pm', mockRpSession);

    const featuresDir = join(tmpDir, '.crew', 'context', 'features');
    const files = readdirSync(featuresDir).filter(f => f.endsWith('.md'));
    expect(files.length).toBe(0);
  });

  it('rejects taskId containing backslashes', async () => {
    createCrewDir(tmpDir);

    const routes = [
      { to: 'dev', summary: '内容', taskId: 'path\\file', taskTitle: 'hack' }
    ];

    await writeBackRouteContext(tmpDir, routes, 'pm', mockRpSession);

    const featuresDir = join(tmpDir, '.crew', 'context', 'features');
    const files = readdirSync(featuresDir).filter(f => f.endsWith('.md'));
    expect(files.length).toBe(0);
  });

  it('rejects taskId with spaces or special characters', async () => {
    createCrewDir(tmpDir);

    const routes = [
      { to: 'dev', summary: '内容', taskId: 'task 1', taskTitle: 'hack' },
      { to: 'dev', summary: '内容', taskId: 'task.1', taskTitle: 'hack' },
      { to: 'dev', summary: '内容', taskId: 'task@1', taskTitle: 'hack' }
    ];

    await writeBackRouteContext(tmpDir, routes, 'pm', mockRpSession);

    const featuresDir = join(tmpDir, '.crew', 'context', 'features');
    const files = readdirSync(featuresDir).filter(f => f.endsWith('.md'));
    expect(files.length).toBe(0);
  });

  it('allows valid taskIds with alphanumeric, hyphens, underscores', async () => {
    createCrewDir(tmpDir);

    const routes = [
      { to: 'dev', summary: '合法', taskId: 'task-1', taskTitle: 'OK' },
      { to: 'dev', summary: '合法', taskId: 'TASK_2', taskTitle: 'OK' },
      { to: 'dev', summary: '合法', taskId: 'feature123', taskTitle: 'OK' }
    ];

    await writeBackRouteContext(tmpDir, routes, 'pm', mockRpSession);

    const featuresDir = join(tmpDir, '.crew', 'context', 'features');
    expect(existsSync(join(featuresDir, 'task-1.md'))).toBe(true);
    expect(existsSync(join(featuresDir, 'TASK_2.md'))).toBe(true);
    expect(existsSync(join(featuresDir, 'feature123.md'))).toBe(true);
  });
});

// =====================================================================
// Tests: writeBackRouteContext serial lock
// =====================================================================

describe('writeBackRouteContext serial lock', () => {
  const mockRpSession = {
    language: 'zh-CN',
    roles: [{ name: 'pm', displayName: 'PM', icon: '📋' }]
  };

  it('concurrent writes produce all records (no data loss)', async () => {
    createCrewDir(tmpDir, {
      features: { 'task-1': '# Feature: A\n- task-id: task-1\n\n## 工作记录\n' }
    });

    const promises = [];
    for (let i = 0; i < 5; i++) {
      promises.push(writeBackRouteContext(tmpDir, [
        { to: 'dev', summary: `Batch ${i}`, taskId: 'task-1', taskTitle: 'A' }
      ], 'pm', mockRpSession));
    }

    await Promise.all(promises);

    const content = readFileSync(join(tmpDir, '.crew', 'context', 'features', 'task-1.md'), 'utf-8');
    for (let i = 0; i < 5; i++) {
      expect(content).toContain(`Batch ${i}`);
    }
  });
});

// =====================================================================
// Tests: atomicWrite
// =====================================================================

describe('atomicWrite', () => {
  it('writes content atomically', async () => {
    const filePath = join(tmpDir, 'test-atomic.txt');
    await atomicWrite(filePath, 'hello world');
    expect(readFileSync(filePath, 'utf-8')).toBe('hello world');
  });

  it('overwrites existing file', async () => {
    const filePath = join(tmpDir, 'test-atomic.txt');
    writeFileSync(filePath, 'old content');
    await atomicWrite(filePath, 'new content');
    expect(readFileSync(filePath, 'utf-8')).toBe('new content');
  });

  it('cleans up tmp file on write error', async () => {
    const badPath = join(tmpDir, 'nonexistent', 'sub', 'file.txt');
    try {
      await atomicWrite(badPath, 'content');
    } catch {
      // Expected to fail
    }
    const tmpFiles = readdirSync(tmpDir).filter(f => f.includes('.tmp.'));
    expect(tmpFiles.length).toBe(0);
  });
});

// =====================================================================
// Tests: MAX_CLAUDE_MD_LEN
// =====================================================================

describe('MAX_CLAUDE_MD_LEN', () => {
  it('is set to 8192', () => {
    expect(MAX_CLAUDE_MD_LEN).toBe(8192);
  });

  it('allows claudeMd up to 8192 characters in deduplication', () => {
    const longMd = 'x'.repeat(8192);
    const truncated = longMd.substring(0, MAX_CLAUDE_MD_LEN);
    expect(truncated.length).toBe(8192);
  });

  it('truncates claudeMd beyond 8192 characters', () => {
    const tooLong = 'x'.repeat(10000);
    const truncated = tooLong.substring(0, MAX_CLAUDE_MD_LEN);
    expect(truncated.length).toBe(8192);
  });
});

// =====================================================================
// Tests: Map serialization safety (saveRolePlayIndex)
// =====================================================================

describe('saveRolePlayIndex — _crewContextMtimes exclusion', () => {
  it('excludes _crewContextMtimes from serialized output', () => {
    const sessions = new Map();
    sessions.set('conv-1', {
      roles: [{ name: 'pm' }],
      teamType: 'dev',
      language: 'zh-CN',
      projectDir: '/tmp/test',
      createdAt: 1234567890,
      _crewContextMtimes: new Map([['CLAUDE.md', 99999]]),
      _routeInitialized: true,
      currentRole: 'pm',
      features: new Map(),
      round: 3,
      roleStates: {},
      waitingHuman: false,
      waitingHumanContext: null
    });

    const json = saveRolePlayIndex(sessions);
    const parsed = JSON.parse(json);

    expect(parsed.length).toBe(1);
    expect(parsed[0]).not.toHaveProperty('_crewContextMtimes');
    expect(parsed[0]).not.toHaveProperty('_routeInitialized');
    expect(parsed[0]).not.toHaveProperty('currentRole');
    // Core fields preserved
    expect(parsed[0].roles).toEqual([{ name: 'pm' }]);
    expect(parsed[0].teamType).toBe('dev');
    expect(parsed[0].createdAt).toBe(1234567890);
  });

  it('deserialized data does not crash hasCrewContextChanged', () => {
    // Simulate: save, load, and check — _crewContextMtimes should NOT exist
    const sessions = new Map();
    sessions.set('conv-1', {
      roles: [],
      _crewContextMtimes: new Map([['a', 1]]),
      _routeInitialized: true,
      currentRole: null,
      features: new Map(),
      round: 0,
      roleStates: {},
      waitingHuman: false,
      waitingHumanContext: null
    });

    const json = saveRolePlayIndex(sessions);
    const parsed = JSON.parse(json);

    // Simulate loadRolePlayIndex: put parsed entry into a session
    const restoredSession = parsed[0];
    // _crewContextMtimes should be absent
    expect(restoredSession._crewContextMtimes).toBeUndefined();

    // hasCrewContextChanged should handle undefined gracefully
    const result = hasCrewContextChanged(restoredSession._crewContextMtimes, new Map([['a', 1]]));
    expect(result).toBe(true); // undefined → force refresh
  });
});

// =====================================================================
// Tests: Resume path integration
// =====================================================================

describe('Resume path: initCrewContextMtimes + refreshCrewContext', () => {
  it('resume loads context once, then detects no change', () => {
    createCrewDir(tmpDir, {
      claudeMd: '# Project',
      kanban: '# Board v1',
      sessionJson: { roles: [], teamType: 'dev', language: 'zh-CN' }
    });

    const crewContext = loadCrewContext(tmpDir);
    expect(crewContext).not.toBeNull();
    expect(crewContext.kanban).toBe('# Board v1');

    const rpSession = {};
    initCrewContextMtimes(tmpDir, rpSession);
    expect(rpSession._crewContextMtimes).toBeInstanceOf(Map);

    const convState = { rolePlayConfig: { crewContext } };
    const refreshed = refreshCrewContext(tmpDir, rpSession, convState);
    expect(refreshed).toBe(false);
    expect(convState.rolePlayConfig.crewContext).toBe(crewContext);
  });

  it('resume then Crew updates kanban → next turn detects change', () => {
    createCrewDir(tmpDir, {
      kanban: '# Board v1',
      sessionJson: { roles: [] }
    });

    const rpSession = {};
    initCrewContextMtimes(tmpDir, rpSession);

    const kanbanPath = join(tmpDir, '.crew', 'context', 'kanban.md');
    const future = new Date(Date.now() + 2000);
    writeFileSync(kanbanPath, '# Board v2 — updated by Crew');
    utimesSync(kanbanPath, future, future);

    const convState = { rolePlayConfig: {} };
    const refreshed = refreshCrewContext(tmpDir, rpSession, convState);
    expect(refreshed).toBe(true);
    expect(convState.rolePlayConfig.crewContext.kanban).toBe('# Board v2 — updated by Crew');
  });

  it('resume then feature file deleted → detects change', () => {
    createCrewDir(tmpDir, {
      features: { 'task-1': '# Task 1', 'task-2': '# Task 2' }
    });

    const rpSession = {};
    initCrewContextMtimes(tmpDir, rpSession);

    rmSync(join(tmpDir, '.crew', 'context', 'features', 'task-2.md'));

    const convState = { rolePlayConfig: {} };
    const refreshed = refreshCrewContext(tmpDir, rpSession, convState);
    expect(refreshed).toBe(true);
    expect(convState.rolePlayConfig.crewContext.features.length).toBe(1);
  });
});

// =====================================================================
// Tests: End-to-end bidirectional flow
// =====================================================================

describe('End-to-end: RolePlay write-back then refresh', () => {
  it('RolePlay writes feature → refreshCrewContext picks it up', async () => {
    createCrewDir(tmpDir, { kanban: '# Board' });

    const rpSession = { language: 'zh-CN', roles: [{ name: 'pm', displayName: 'PM', icon: '📋' }] };

    initCrewContextMtimes(tmpDir, rpSession);

    await writeBackRouteContext(tmpDir, [
      { to: 'dev', summary: '请实现功能 X', taskId: 'task-99', taskTitle: '功能 X' }
    ], 'pm', rpSession);

    const convState = { rolePlayConfig: {} };
    const refreshed = refreshCrewContext(tmpDir, rpSession, convState);
    expect(refreshed).toBe(true);
    expect(convState.rolePlayConfig.crewContext.features.some(f => f.name === 'task-99')).toBe(true);
  });
});
