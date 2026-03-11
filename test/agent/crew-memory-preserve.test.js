import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

/**
 * Tests for Crew memory preservation across delete + recreate.
 *
 * Replicates key logic from agent/crew/shared-dir.js without importing
 * directly (to avoid SDK/context side effects).
 */

// =====================================================================
// Replicate core functions from crew-i18n.js and shared-dir.js
// =====================================================================

const messages = {
  'zh-CN': {
    sharedMemoryTitle: '# 共享记忆',
    sharedMemoryDefault: '_团队共同维护，记录重要的共识、决策和信息。_',
    personalMemory: '# 个人记忆',
    personalMemoryDefault: '_在这里记录重要的信息、决策、进展和待办事项。_',
    projectGoal: '# 项目目标',
    projectCodePath: '# 项目代码路径',
    useAbsolutePath: '所有代码操作请使用此绝对路径。',
    teamMembersTitle: '# 团队成员',
    roleTitle: (label) => `# 角色: ${label}`,
  },
  'en': {
    sharedMemoryTitle: '# Shared Memory',
    sharedMemoryDefault: '_Team-maintained shared knowledge, decisions, and information._',
    personalMemory: '# Personal Memory',
    personalMemoryDefault: '_Record important information, decisions, progress, and to-do items here._',
    projectGoal: '# Project Goal',
    projectCodePath: '# Project Code Path',
    useAbsolutePath: 'Use this absolute path for all code operations.',
    teamMembersTitle: '# Team Members',
    roleTitle: (label) => `# Role: ${label}`,
  }
};

function getAllMemoryTitles() {
  const sharedTitles = [];
  const sharedDefaults = [];
  const personalTitles = [];
  const personalDefaults = [];
  for (const lang of Object.keys(messages)) {
    const m = messages[lang];
    sharedTitles.push(m.sharedMemoryTitle);
    sharedDefaults.push(m.sharedMemoryDefault);
    personalTitles.push(m.personalMemory);
    personalDefaults.push(m.personalMemoryDefault);
  }
  return { sharedTitles, sharedDefaults, personalTitles, personalDefaults };
}

const MEMORY_BACKUP_FILE = '.memory-backup.json';

function extractMemorySection(fileContent, titles, defaults) {
  for (const title of titles) {
    const idx = fileContent.indexOf(title);
    if (idx === -1) continue;
    const afterTitle = fileContent.slice(idx + title.length);
    const nextHeading = afterTitle.search(/\n#\s/);
    const raw = nextHeading === -1 ? afterTitle : afterTitle.slice(0, nextHeading);
    const trimmed = raw.trim();
    if (!trimmed) return null;
    for (const d of defaults) {
      if (trimmed === d.trim()) return null;
    }
    return trimmed;
  }
  return null;
}

async function backupMemoryContent(crewDir) {
  const { sharedTitles, sharedDefaults, personalTitles, personalDefaults } = getAllMemoryTitles();
  const backup = { shared: null, roles: {} };

  try {
    const sharedContent = await fs.readFile(join(crewDir, 'CLAUDE.md'), 'utf-8');
    backup.shared = extractMemorySection(sharedContent, sharedTitles, sharedDefaults);
  } catch { /* skip */ }

  try {
    const rolesDir = join(crewDir, 'roles');
    const roleDirs = await fs.readdir(rolesDir);
    for (const roleName of roleDirs) {
      try {
        const roleClaudeMd = await fs.readFile(join(rolesDir, roleName, 'CLAUDE.md'), 'utf-8');
        const memory = extractMemorySection(roleClaudeMd, personalTitles, personalDefaults);
        if (memory) {
          backup.roles[roleName] = memory;
        }
      } catch { /* skip */ }
    }
  } catch { /* skip */ }

  if (backup.shared || Object.keys(backup.roles).length > 0) {
    await fs.writeFile(join(crewDir, MEMORY_BACKUP_FILE), JSON.stringify(backup, null, 2));
  }
  return backup;
}

async function loadMemoryBackup(sharedDir) {
  try {
    const data = await fs.readFile(join(sharedDir, MEMORY_BACKUP_FILE), 'utf-8');
    return JSON.parse(data);
  } catch {
    return null;
  }
}

async function cleanupMemoryBackup(sharedDir) {
  try {
    await fs.rm(join(sharedDir, MEMORY_BACKUP_FILE), { force: true });
  } catch { /* ignore */ }
}

// =====================================================================
// Test fixtures
// =====================================================================

let testDir;

beforeEach(async () => {
  testDir = join(tmpdir(), `crew-memory-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await fs.mkdir(testDir, { recursive: true });
});

afterEach(async () => {
  try {
    await fs.rm(testDir, { recursive: true, force: true });
  } catch { /* ignore */ }
});

// Helper: create a .crew dir with CLAUDE.md and role dirs
async function createCrewDir(crewDir, sharedMemory, roleMemories = {}, lang = 'zh-CN') {
  const m = messages[lang];
  await fs.mkdir(crewDir, { recursive: true });

  // Write shared CLAUDE.md
  const sharedContent = `${m.projectGoal}

${m.projectCodePath}
/test/project
${m.useAbsolutePath}

${m.teamMembersTitle}
- PM(pm): 需求分析

${m.sharedMemoryTitle}
${sharedMemory || m.sharedMemoryDefault}
`;
  await fs.writeFile(join(crewDir, 'CLAUDE.md'), sharedContent);

  // Write role CLAUDE.md files
  const rolesDir = join(crewDir, 'roles');
  await fs.mkdir(rolesDir, { recursive: true });
  for (const [roleName, memory] of Object.entries(roleMemories)) {
    const roleDir = join(rolesDir, roleName);
    await fs.mkdir(roleDir, { recursive: true });
    const roleContent = `${m.roleTitle(roleName)}
Some role description

${m.personalMemory}
${memory || m.personalMemoryDefault}
`;
    await fs.writeFile(join(roleDir, 'CLAUDE.md'), roleContent);
  }
}

// =====================================================================
// Tests
// =====================================================================

describe('extractMemorySection', () => {
  const { sharedTitles, sharedDefaults, personalTitles, personalDefaults } = getAllMemoryTitles();

  it('extracts user-written shared memory (zh-CN)', () => {
    const content = `# 项目目标

# 共享记忆
这是团队共享的重要决策记录
- 使用 Vue 3 + Vite
- API 用 REST 风格
`;
    const result = extractMemorySection(content, sharedTitles, sharedDefaults);
    expect(result).toContain('这是团队共享的重要决策记录');
    expect(result).toContain('使用 Vue 3 + Vite');
  });

  it('extracts user-written shared memory (en)', () => {
    const content = `# Project Goal

# Shared Memory
Important team decisions:
- Using React + TypeScript
- REST API design
`;
    const result = extractMemorySection(content, sharedTitles, sharedDefaults);
    expect(result).toContain('Important team decisions');
    expect(result).toContain('Using React + TypeScript');
  });

  it('returns null for default placeholder (zh-CN)', () => {
    const content = `# 共享记忆
_团队共同维护，记录重要的共识、决策和信息。_
`;
    const result = extractMemorySection(content, sharedTitles, sharedDefaults);
    expect(result).toBeNull();
  });

  it('returns null for default placeholder (en)', () => {
    const content = `# Shared Memory
_Team-maintained shared knowledge, decisions, and information._
`;
    const result = extractMemorySection(content, sharedTitles, sharedDefaults);
    expect(result).toBeNull();
  });

  it('returns null when section is empty', () => {
    const content = `# 共享记忆

`;
    const result = extractMemorySection(content, sharedTitles, sharedDefaults);
    expect(result).toBeNull();
  });

  it('returns null when title is not found', () => {
    const content = `# 其他标题
一些内容
`;
    const result = extractMemorySection(content, sharedTitles, sharedDefaults);
    expect(result).toBeNull();
  });

  it('stops at next top-level heading', () => {
    const content = `# 共享记忆
用户记忆内容

# 其他标题
这不是记忆内容
`;
    const result = extractMemorySection(content, sharedTitles, sharedDefaults);
    expect(result).toBe('用户记忆内容');
    expect(result).not.toContain('其他标题');
  });

  it('extracts personal memory', () => {
    const content = `# 角色: PM
描述信息

# 个人记忆
我正在处理 task-19 的修复工作
- 已完成 PR 审查
`;
    const result = extractMemorySection(content, personalTitles, personalDefaults);
    expect(result).toContain('正在处理 task-19');
    expect(result).toContain('已完成 PR 审查');
  });

  it('returns null for default personal memory placeholder', () => {
    const content = `# 个人记忆
_在这里记录重要的信息、决策、进展和待办事项。_
`;
    const result = extractMemorySection(content, personalTitles, personalDefaults);
    expect(result).toBeNull();
  });
});

describe('backupMemoryContent', () => {
  it('backs up shared memory with user content', async () => {
    const crewDir = join(testDir, '.crew');
    await createCrewDir(crewDir, '重要决策：使用 Vitest 做测试');

    const backup = await backupMemoryContent(crewDir);
    expect(backup.shared).toContain('重要决策：使用 Vitest 做测试');
  });

  it('backs up role personal memories', async () => {
    const crewDir = join(testDir, '.crew');
    await createCrewDir(crewDir, null, {
      'pm': '我负责需求分析',
      'dev-1': '我正在修复 bug #123',
    });

    const backup = await backupMemoryContent(crewDir);
    expect(backup.shared).toBeNull(); // default placeholder
    expect(backup.roles['pm']).toContain('我负责需求分析');
    expect(backup.roles['dev-1']).toContain('我正在修复 bug #123');
  });

  it('backs up both shared and role memories', async () => {
    const crewDir = join(testDir, '.crew');
    await createCrewDir(crewDir, '共享决策记录', {
      'pm': 'PM 记忆',
      'dev-1': 'Dev-1 记忆',
    });

    const backup = await backupMemoryContent(crewDir);
    expect(backup.shared).toContain('共享决策记录');
    expect(backup.roles['pm']).toContain('PM 记忆');
    expect(backup.roles['dev-1']).toContain('Dev-1 记忆');
  });

  it('skips roles with only default placeholder', async () => {
    const crewDir = join(testDir, '.crew');
    await createCrewDir(crewDir, null, {
      'pm': null, // default placeholder
      'dev-1': '有记忆内容',
    });

    const backup = await backupMemoryContent(crewDir);
    expect(backup.roles['pm']).toBeUndefined();
    expect(backup.roles['dev-1']).toContain('有记忆内容');
  });

  it('writes backup file when there is content to preserve', async () => {
    const crewDir = join(testDir, '.crew');
    await createCrewDir(crewDir, '需要保留的记忆');

    await backupMemoryContent(crewDir);

    const backupFile = join(crewDir, MEMORY_BACKUP_FILE);
    const data = JSON.parse(await fs.readFile(backupFile, 'utf-8'));
    expect(data.shared).toContain('需要保留的记忆');
  });

  it('does not write backup file when nothing to preserve', async () => {
    const crewDir = join(testDir, '.crew');
    await createCrewDir(crewDir, null, { 'pm': null }); // all defaults

    await backupMemoryContent(crewDir);

    const backupFile = join(crewDir, MEMORY_BACKUP_FILE);
    await expect(fs.access(backupFile)).rejects.toThrow();
  });

  it('handles missing .crew/CLAUDE.md gracefully', async () => {
    const crewDir = join(testDir, '.crew');
    await fs.mkdir(crewDir, { recursive: true });
    // no CLAUDE.md at all

    const backup = await backupMemoryContent(crewDir);
    expect(backup.shared).toBeNull();
    expect(Object.keys(backup.roles)).toHaveLength(0);
  });

  it('handles missing roles/ directory gracefully', async () => {
    const crewDir = join(testDir, '.crew');
    await createCrewDir(crewDir, '有共享记忆');
    await fs.rm(join(crewDir, 'roles'), { recursive: true, force: true });

    const backup = await backupMemoryContent(crewDir);
    expect(backup.shared).toContain('有共享记忆');
    expect(Object.keys(backup.roles)).toHaveLength(0);
  });

  it('works with English locale', async () => {
    const crewDir = join(testDir, '.crew');
    await createCrewDir(crewDir, 'Team decision: use TypeScript', {
      'pm': 'I am tracking task-29',
    }, 'en');

    const backup = await backupMemoryContent(crewDir);
    expect(backup.shared).toContain('Team decision: use TypeScript');
    expect(backup.roles['pm']).toContain('I am tracking task-29');
  });
});

describe('loadMemoryBackup', () => {
  it('loads valid backup file', async () => {
    const crewDir = join(testDir, '.crew');
    await fs.mkdir(crewDir, { recursive: true });
    await fs.writeFile(join(crewDir, MEMORY_BACKUP_FILE), JSON.stringify({
      shared: 'test memory',
      roles: { 'dev-1': 'dev memory' }
    }));

    const backup = await loadMemoryBackup(crewDir);
    expect(backup.shared).toBe('test memory');
    expect(backup.roles['dev-1']).toBe('dev memory');
  });

  it('returns null when file does not exist', async () => {
    const crewDir = join(testDir, '.crew');
    await fs.mkdir(crewDir, { recursive: true });

    const backup = await loadMemoryBackup(crewDir);
    expect(backup).toBeNull();
  });

  it('returns null for invalid JSON', async () => {
    const crewDir = join(testDir, '.crew');
    await fs.mkdir(crewDir, { recursive: true });
    await fs.writeFile(join(crewDir, MEMORY_BACKUP_FILE), 'not valid json');

    const backup = await loadMemoryBackup(crewDir);
    expect(backup).toBeNull();
  });
});

describe('cleanupMemoryBackup', () => {
  it('deletes backup file', async () => {
    const crewDir = join(testDir, '.crew');
    await fs.mkdir(crewDir, { recursive: true });
    await fs.writeFile(join(crewDir, MEMORY_BACKUP_FILE), '{}');

    await cleanupMemoryBackup(crewDir);

    await expect(fs.access(join(crewDir, MEMORY_BACKUP_FILE))).rejects.toThrow();
  });

  it('does not throw when file does not exist', async () => {
    const crewDir = join(testDir, '.crew');
    await fs.mkdir(crewDir, { recursive: true });

    await expect(cleanupMemoryBackup(crewDir)).resolves.not.toThrow();
  });
});

describe('full delete + recreate flow', () => {
  it('preserves shared memory across delete and recreate', async () => {
    const crewDir = join(testDir, '.crew');
    const userMemory = '## 重要决策\n- 使用 Vue 3\n- 使用 Pinia 状态管理\n- API 格式: REST';

    // Step 1: Create crew with user memory
    await createCrewDir(crewDir, userMemory);

    // Step 2: Backup (simulating handleDeleteCrewDir)
    await backupMemoryContent(crewDir);

    // Step 3: Delete CLAUDE.md and roles (simulating handleDeleteCrewDir)
    await fs.rm(join(crewDir, 'CLAUDE.md'), { force: true });
    await fs.rm(join(crewDir, 'roles'), { recursive: true, force: true });

    // Step 4: Load backup (simulating writeSharedClaudeMd restore)
    const backup = await loadMemoryBackup(crewDir);
    expect(backup).not.toBeNull();
    expect(backup.shared).toContain('使用 Vue 3');
    expect(backup.shared).toContain('使用 Pinia 状态管理');

    // Step 5: Cleanup (simulating initSharedDir completion)
    await cleanupMemoryBackup(crewDir);
    expect(await loadMemoryBackup(crewDir)).toBeNull();
  });

  it('preserves role personal memories across delete and recreate', async () => {
    const crewDir = join(testDir, '.crew');

    await createCrewDir(crewDir, null, {
      'pm': '当前在跟踪 task-29\n- PR #188 待审查',
      'dev-1': '## 进度\n已完成 shared-dir.js 修改',
      'rev-1': null, // default placeholder — should not be preserved
    });

    await backupMemoryContent(crewDir);
    await fs.rm(join(crewDir, 'CLAUDE.md'), { force: true });
    await fs.rm(join(crewDir, 'roles'), { recursive: true, force: true });

    const backup = await loadMemoryBackup(crewDir);
    expect(backup.roles['pm']).toContain('task-29');
    expect(backup.roles['dev-1']).toContain('shared-dir.js');
    expect(backup.roles['rev-1']).toBeUndefined();
  });

  it('handles recreate when no memory was written (fresh crew)', async () => {
    const crewDir = join(testDir, '.crew');
    await createCrewDir(crewDir, null, { 'pm': null }); // all defaults

    await backupMemoryContent(crewDir);

    // No backup file should exist
    const backup = await loadMemoryBackup(crewDir);
    expect(backup).toBeNull();
  });

  it('preserves multiline memory with special characters', async () => {
    const crewDir = join(testDir, '.crew');
    const complexMemory = `## 版本信息
- v0.1.78: Windows 升级修复
- v0.1.77: Crew clear/refresh 修复

## 决策记录
| 日期 | 决策 | 原因 |
|------|------|------|
| 3/11 | 恢复 detached:true | 子进程被杀 |

\`\`\`json
{ "key": "value" }
\`\`\``;

    await createCrewDir(crewDir, complexMemory);
    await backupMemoryContent(crewDir);

    const backup = await loadMemoryBackup(crewDir);
    expect(backup.shared).toContain('v0.1.78');
    expect(backup.shared).toContain('detached:true');
    expect(backup.shared).toContain('"key": "value"');
  });
});

describe('getAllMemoryTitles', () => {
  it('returns titles for both locales', () => {
    const titles = getAllMemoryTitles();
    expect(titles.sharedTitles).toContain('# 共享记忆');
    expect(titles.sharedTitles).toContain('# Shared Memory');
    expect(titles.personalTitles).toContain('# 个人记忆');
    expect(titles.personalTitles).toContain('# Personal Memory');
  });

  it('returns defaults for both locales', () => {
    const titles = getAllMemoryTitles();
    expect(titles.sharedDefaults).toHaveLength(2);
    expect(titles.personalDefaults).toHaveLength(2);
  });
});

describe('source code verification', () => {
  it('session.js imports backupMemoryContent from shared-dir.js', async () => {
    const source = await fs.readFile(
      join(__dirname, '../../agent/crew/session.js'), 'utf-8'
    );
    expect(source).toContain('backupMemoryContent');
    expect(source).toContain("from './shared-dir.js'");
  });

  it('session.js calls backupMemoryContent before deletion in handleDeleteCrewDir', async () => {
    const source = await fs.readFile(
      join(__dirname, '../../agent/crew/session.js'), 'utf-8'
    );
    // backupMemoryContent should appear before fs.rm in handleDeleteCrewDir
    const fnStart = source.indexOf('async function handleDeleteCrewDir');
    expect(fnStart).toBeGreaterThan(-1);
    const fnBody = source.slice(fnStart, fnStart + 800);
    const backupIdx = fnBody.indexOf('backupMemoryContent');
    const deleteIdx = fnBody.indexOf("fs.rm(join(crewDir, 'CLAUDE.md')");
    expect(backupIdx).toBeGreaterThan(-1);
    expect(deleteIdx).toBeGreaterThan(backupIdx);
  });

  it('shared-dir.js writeSharedClaudeMd loads backup', async () => {
    const source = await fs.readFile(
      join(__dirname, '../../agent/crew/shared-dir.js'), 'utf-8'
    );
    const fnStart = source.indexOf('async function writeSharedClaudeMd');
    const fnBody = source.slice(fnStart, fnStart + 600);
    expect(fnBody).toContain('loadMemoryBackup');
    expect(fnBody).toContain('backup.shared');
  });

  it('shared-dir.js writeRoleClaudeMd loads backup', async () => {
    const source = await fs.readFile(
      join(__dirname, '../../agent/crew/shared-dir.js'), 'utf-8'
    );
    const fnStart = source.indexOf('async function writeRoleClaudeMd');
    const fnBody = source.slice(fnStart, fnStart + 600);
    expect(fnBody).toContain('loadMemoryBackup');
    expect(fnBody).toContain('backup.roles');
  });

  it('shared-dir.js initSharedDir calls cleanupMemoryBackup', async () => {
    const source = await fs.readFile(
      join(__dirname, '../../agent/crew/shared-dir.js'), 'utf-8'
    );
    const fnStart = source.indexOf('async function initSharedDir');
    const fnBody = source.slice(fnStart, fnStart + 600);
    expect(fnBody).toContain('cleanupMemoryBackup');
  });

  it('crew-i18n.js exports getAllMemoryTitles', async () => {
    const source = await fs.readFile(
      join(__dirname, '../../agent/crew-i18n.js'), 'utf-8'
    );
    expect(source).toContain('export function getAllMemoryTitles');
  });
});
