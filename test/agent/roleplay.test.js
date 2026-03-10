import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { join } from 'path';
import { tmpdir } from 'os';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, unlinkSync, rmSync } from 'fs';

/**
 * Tests for agent/roleplay.js — Role Play session persistence and system prompt building.
 *
 * To avoid importing the real module (which drags in context.js / SDK side effects),
 * we replicate the core logic under test exactly as it appears in roleplay.js.
 */

// =====================================================================
// Replicated helpers (mirrors agent/roleplay.js implementation)
// =====================================================================

function buildRolePlaySystemPrompt(config) {
  const { roles, teamType, language } = config;
  const isZh = language === 'zh-CN';

  const roleList = roles.map(r => {
    const desc = r.claudeMd || r.description || '';
    const icon = r.icon ? `${r.icon} ` : '';
    return `### ${icon}${r.displayName} (${r.name})\n${desc}`;
  }).join('\n\n');

  const workflow = getWorkflow(teamType, roles, isZh);

  const prompt = isZh
    ? buildZhPrompt(roleList, workflow)
    : buildEnPrompt(roleList, workflow);

  return prompt.trim();
}

function buildZhPrompt(roleList, workflow) {
  return `
# 多角色协作模式

你正在以多角色协作方式完成任务。你将依次扮演不同角色，每个角色有独立的视角、人格和专业能力。

## 可用角色

${roleList}

## 角色切换规则

切换角色时，输出以下信号（必须独占一行，前后不能有其他内容）：

---ROLE: {角色name}---

切换后，你必须完全以该角色的视角和人格思考、说话和行动。不要混用其他角色的口吻。

**重要**：
- 第一条输出必须先切换到起始角色（通常是 PM）
- 每次切换时先用 1-2 句话说明为什么要切换（作为上一个角色的收尾）
- 切换后立即以新角色身份开始工作
- 信号格式必须严格匹配：三个短横线 + ROLE: + 空格 + 角色name + 三个短横线

## 工作流程

${workflow}

## 交接规范

每次角色切换时，上一个角色必须留下清晰的交接信息：
- 完成了什么
- 未完成的部分（如有）
- 对下一个角色的具体要求或注意事项

## 输出格式

- 代码修改使用工具（Read, Edit, Write 等），不要在聊天中贴大段代码
- 每个角色专注做自己的事，不要代替其他角色
- Review 和 Test 角色如果发现问题，必须切回 Dev 修复后再继续

## 语言

使用中文交流。代码注释可以用英文。
`;
}

function buildEnPrompt(roleList, workflow) {
  return `
# Multi-Role Collaboration Mode

You are working in multi-role collaboration mode. You will take on different roles sequentially, each with its own perspective, personality, and expertise.

## Available Roles

${roleList}

## Role Switching Rules

When switching roles, output the following signal (must be on its own line, nothing else before or after):

---ROLE: {role_name}---

After switching, you must fully think, speak, and act from that role's perspective and personality. Do not mix tones from other roles.

**Important**:
- Your first output must switch to the starting role (usually PM)
- Before each switch, briefly explain why you're switching (as closure for the current role)
- After switching, immediately begin working as the new role
- Signal format must strictly match: three hyphens + ROLE: + space + role_name + three hyphens

## Workflow

${workflow}

## Handoff Convention

Each role switch must include clear handoff information from the previous role:
- What was completed
- What remains (if any)
- Specific requirements or notes for the next role

## Output Format

- Use tools (Read, Edit, Write, etc.) for code changes, don't paste large code blocks in chat
- Each role focuses on its own responsibility, don't do other roles' jobs
- If Review or Test finds issues, must switch back to Dev to fix before continuing

## Language

Communicate in English. Code comments in English.
`;
}

function getWorkflow(teamType, roles, isZh) {
  const roleNames = roles.map(r => r.name);

  if (teamType === 'dev') {
    return buildDevWorkflow(roleNames, isZh);
  }

  return isZh ? '按角色顺序依次完成任务。' : 'Complete tasks by following the role sequence.';
}

function buildDevWorkflow(roleNames, isZh) {
  const hasPm = roleNames.includes('pm');
  const hasDev = roleNames.includes('dev');
  const hasReviewer = roleNames.includes('reviewer');
  const hasTester = roleNames.includes('tester');
  const hasDesigner = roleNames.includes('designer');

  const steps = [];

  if (isZh) {
    if (hasPm) steps.push(`${steps.length + 1}. **PM** 分析需求，拆分任务，确定验收标准`);
    if (hasDesigner) steps.push(`${steps.length + 1}. **设计师** 确认交互方案（如涉及 UI）`);
    if (hasDev) steps.push(`${steps.length + 1}. **开发者** 实现代码（使用工具读写文件）`);
    if (hasReviewer) steps.push(`${steps.length + 1}. **审查者** Code Review（不通过 → 返回开发者修复）`);
    if (hasTester) steps.push(`${steps.length + 1}. **测试者** 运行测试 & 验证（有 bug → 返回开发者修复）`);
    if (hasPm) steps.push(`${steps.length + 1}. **PM** 验收总结`);
  } else {
    if (hasPm) steps.push(`${steps.length + 1}. **PM** analyzes requirements, breaks down tasks, defines acceptance criteria`);
    if (hasDesigner) steps.push(`${steps.length + 1}. **Designer** confirms interaction design (if UI involved)`);
    if (hasDev) steps.push(`${steps.length + 1}. **Dev** implements code (using tools to read/write files)`);
    if (hasReviewer) steps.push(`${steps.length + 1}. **Reviewer** code review (if fails → back to Dev)`);
    if (hasTester) steps.push(`${steps.length + 1}. **Tester** runs tests & verifies (if bugs → back to Dev)`);
    if (hasPm) steps.push(`${steps.length + 1}. **PM** acceptance & summary`);
  }

  return steps.join('\n');
}

// Replicated persistence logic (uses a temp dir instead of ~/.claude)
function createPersistenceManager(indexPath) {
  const sessions = new Map();

  function saveIndex() {
    const data = [];
    for (const [id, session] of sessions) {
      data.push({ id, ...session });
    }
    try {
      writeFileSync(indexPath, JSON.stringify(data, null, 2));
    } catch (e) {
      console.warn('[roleplay-test] Failed to save index:', e.message);
    }
  }

  function loadIndex() {
    if (!existsSync(indexPath)) return;
    try {
      const data = JSON.parse(readFileSync(indexPath, 'utf-8'));
      for (const entry of data) {
        const { id, ...session } = entry;
        sessions.set(id, session);
      }
    } catch (e) {
      console.warn('[roleplay-test] Failed to load index:', e.message);
    }
  }

  function removeSession(conversationId) {
    sessions.delete(conversationId);
    saveIndex();
  }

  return { sessions, saveIndex, loadIndex, removeSession };
}

// =====================================================================
// Test data helpers
// =====================================================================

function makeDevTeamRoles() {
  return [
    { name: 'pm', displayName: 'PM乔布斯', icon: '📋', description: '需求分析和项目管理' },
    { name: 'dev', displayName: '开发者托瓦兹', icon: '💻', description: '编写代码' },
    { name: 'reviewer', displayName: '审查者马丁', icon: '🔍', description: '代码审查' },
    { name: 'tester', displayName: '测试贝克', icon: '🧪', description: '编写测试' },
  ];
}

function makeMinimalRoles() {
  return [
    { name: 'pm', displayName: 'PM', icon: '', description: 'manages project' },
    { name: 'dev', displayName: 'Developer', icon: '', description: 'writes code' },
  ];
}

function makeDesignerTeamRoles() {
  return [
    { name: 'pm', displayName: 'PM', icon: '📋', description: '需求分析' },
    { name: 'designer', displayName: '设计师', icon: '🎨', description: 'UI设计' },
    { name: 'dev', displayName: '开发者', icon: '💻', description: '编写代码' },
    { name: 'reviewer', displayName: '审查者', icon: '🔍', description: '代码审查' },
    { name: 'tester', displayName: '测试者', icon: '🧪', description: '编写测试' },
  ];
}

// =====================================================================
// Tests
// =====================================================================

describe('agent/roleplay.js — Role Play', () => {

  // ---------------------------------------------------------------
  // buildRolePlaySystemPrompt
  // ---------------------------------------------------------------

  describe('buildRolePlaySystemPrompt', () => {
    it('should produce Chinese prompt when language is zh-CN', () => {
      const prompt = buildRolePlaySystemPrompt({
        roles: makeDevTeamRoles(),
        teamType: 'dev',
        language: 'zh-CN',
      });

      expect(prompt).toContain('# 多角色协作模式');
      expect(prompt).toContain('## 可用角色');
      expect(prompt).toContain('---ROLE: {角色name}---');
      expect(prompt).toContain('使用中文交流');
    });

    it('should produce English prompt when language is en', () => {
      const prompt = buildRolePlaySystemPrompt({
        roles: makeDevTeamRoles(),
        teamType: 'dev',
        language: 'en',
      });

      expect(prompt).toContain('# Multi-Role Collaboration Mode');
      expect(prompt).toContain('## Available Roles');
      expect(prompt).toContain('---ROLE: {role_name}---');
      expect(prompt).toContain('Communicate in English');
    });

    it('should include all role names and display names in the role list', () => {
      const roles = makeDevTeamRoles();
      const prompt = buildRolePlaySystemPrompt({ roles, teamType: 'dev', language: 'en' });

      for (const r of roles) {
        expect(prompt).toContain(`(${r.name})`);
        expect(prompt).toContain(r.displayName);
      }
    });

    it('should include role descriptions in the role list', () => {
      const roles = makeDevTeamRoles();
      const prompt = buildRolePlaySystemPrompt({ roles, teamType: 'dev', language: 'en' });

      for (const r of roles) {
        expect(prompt).toContain(r.description);
      }
    });

    it('should include role icons when present', () => {
      const roles = makeDevTeamRoles();
      const prompt = buildRolePlaySystemPrompt({ roles, teamType: 'dev', language: 'en' });

      expect(prompt).toContain('📋 PM乔布斯');
      expect(prompt).toContain('💻 开发者托瓦兹');
      expect(prompt).toContain('🔍 审查者马丁');
      expect(prompt).toContain('🧪 测试贝克');
    });

    it('should not add extra icon space when icon is empty string', () => {
      const roles = makeMinimalRoles();
      const prompt = buildRolePlaySystemPrompt({ roles, teamType: 'dev', language: 'en' });

      // Should NOT have a leading space before the displayName in the heading
      expect(prompt).toContain('### PM (pm)');
      expect(prompt).toContain('### Developer (dev)');
    });

    it('should use claudeMd as description when available', () => {
      const roles = [
        { name: 'pm', displayName: 'PM', icon: '', description: 'short desc', claudeMd: '# Full PM instructions\nDetailed markdown.' },
      ];
      const prompt = buildRolePlaySystemPrompt({ roles, teamType: 'dev', language: 'en' });

      expect(prompt).toContain('# Full PM instructions');
      expect(prompt).toContain('Detailed markdown.');
      // claudeMd takes priority — short desc should NOT appear
      expect(prompt).not.toContain('short desc');
    });

    it('should fall back to description when claudeMd is absent', () => {
      const roles = [
        { name: 'dev', displayName: 'Dev', icon: '', description: 'writes code' },
      ];
      const prompt = buildRolePlaySystemPrompt({ roles, teamType: 'dev', language: 'en' });

      expect(prompt).toContain('writes code');
    });

    it('should handle role with no description and no claudeMd gracefully', () => {
      const roles = [
        { name: 'pm', displayName: 'PM', icon: '' },
      ];
      const prompt = buildRolePlaySystemPrompt({ roles, teamType: 'dev', language: 'en' });

      // Should not crash, just produce an empty description area
      expect(prompt).toContain('### PM (pm)');
    });

    it('should always return a trimmed string (no leading/trailing whitespace)', () => {
      const prompt = buildRolePlaySystemPrompt({
        roles: makeDevTeamRoles(),
        teamType: 'dev',
        language: 'en',
      });
      expect(prompt).toBe(prompt.trim());
    });
  });

  // ---------------------------------------------------------------
  // Workflow generation (dev team type)
  // ---------------------------------------------------------------

  describe('getWorkflow — dev team type', () => {
    it('should generate numbered steps for a full dev team (Chinese)', () => {
      const roles = makeDevTeamRoles();
      const prompt = buildRolePlaySystemPrompt({ roles, teamType: 'dev', language: 'zh-CN' });

      expect(prompt).toContain('1. **PM** 分析需求');
      expect(prompt).toContain('2. **开发者** 实现代码');
      expect(prompt).toContain('3. **审查者** Code Review');
      expect(prompt).toContain('4. **测试者** 运行测试');
      expect(prompt).toContain('5. **PM** 验收总结');
    });

    it('should generate numbered steps for a full dev team (English)', () => {
      const roles = makeDevTeamRoles();
      const prompt = buildRolePlaySystemPrompt({ roles, teamType: 'dev', language: 'en' });

      expect(prompt).toContain('1. **PM** analyzes requirements');
      expect(prompt).toContain('2. **Dev** implements code');
      expect(prompt).toContain('3. **Reviewer** code review');
      expect(prompt).toContain('4. **Tester** runs tests');
      expect(prompt).toContain('5. **PM** acceptance');
    });

    it('should include designer step when designer role is present', () => {
      const roles = makeDesignerTeamRoles();
      const prompt = buildRolePlaySystemPrompt({ roles, teamType: 'dev', language: 'zh-CN' });

      expect(prompt).toContain('**设计师** 确认交互方案');
      // Designer step should be between PM and Dev
      const designerIdx = prompt.indexOf('设计师');
      const devIdx = prompt.indexOf('开发者');
      expect(designerIdx).toBeLessThan(devIdx);
    });

    it('should omit missing roles from the workflow (dev+reviewer only)', () => {
      const roles = [
        { name: 'dev', displayName: '开发者', icon: '', description: '' },
        { name: 'reviewer', displayName: '审查者', icon: '', description: '' },
      ];
      const prompt = buildRolePlaySystemPrompt({ roles, teamType: 'dev', language: 'zh-CN' });

      expect(prompt).toContain('**开发者** 实现代码');
      expect(prompt).toContain('**审查者** Code Review');
      expect(prompt).not.toContain('**PM**');
      expect(prompt).not.toContain('**测试者**');
    });

    it('should number steps sequentially even when roles are skipped', () => {
      const roles = [
        { name: 'dev', displayName: 'Dev', icon: '', description: '' },
        { name: 'tester', displayName: 'Tester', icon: '', description: '' },
      ];
      const prompt = buildRolePlaySystemPrompt({ roles, teamType: 'dev', language: 'en' });

      expect(prompt).toContain('1. **Dev**');
      expect(prompt).toContain('2. **Tester**');
      // Should NOT have step 3
      expect(prompt).not.toContain('3. ');
    });
  });

  // ---------------------------------------------------------------
  // Workflow generation — non-dev team type
  // ---------------------------------------------------------------

  describe('getWorkflow — non-dev team type', () => {
    it('should produce generic fallback for unknown teamType (Chinese)', () => {
      const roles = [{ name: 'pm', displayName: 'PM', icon: '', description: '' }];
      const prompt = buildRolePlaySystemPrompt({ roles, teamType: 'writing', language: 'zh-CN' });

      expect(prompt).toContain('按角色顺序依次完成任务');
    });

    it('should produce generic fallback for unknown teamType (English)', () => {
      const roles = [{ name: 'pm', displayName: 'PM', icon: '', description: '' }];
      const prompt = buildRolePlaySystemPrompt({ roles, teamType: 'marketing', language: 'en' });

      expect(prompt).toContain('Complete tasks by following the role sequence');
    });
  });

  // ---------------------------------------------------------------
  // Persistence (save / load / remove)
  // ---------------------------------------------------------------

  describe('rolePlaySessions persistence', () => {
    let tmpDir;
    let indexPath;

    beforeEach(() => {
      tmpDir = mkdtempSync(join(tmpdir(), 'roleplay-test-'));
      indexPath = join(tmpDir, 'roleplay-sessions.json');
    });

    afterEach(() => {
      try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    });

    it('should save sessions to disk as JSON array', () => {
      const { sessions, saveIndex } = createPersistenceManager(indexPath);

      sessions.set('conv-1', {
        roles: makeMinimalRoles(),
        teamType: 'dev',
        language: 'en',
        projectDir: '/project/a',
        createdAt: 1000,
        userId: 'u1',
        username: 'alice',
      });
      sessions.set('conv-2', {
        roles: makeDevTeamRoles(),
        teamType: 'dev',
        language: 'zh-CN',
        projectDir: '/project/b',
        createdAt: 2000,
        userId: 'u2',
        username: 'bob',
      });

      saveIndex();

      const onDisk = JSON.parse(readFileSync(indexPath, 'utf-8'));
      expect(onDisk).toHaveLength(2);
      expect(onDisk[0].id).toBe('conv-1');
      expect(onDisk[0].username).toBe('alice');
      expect(onDisk[1].id).toBe('conv-2');
      expect(onDisk[1].language).toBe('zh-CN');
    });

    it('should load sessions from disk into the Map', () => {
      // Pre-seed a file
      const seedData = [
        { id: 'conv-x', roles: makeMinimalRoles(), teamType: 'dev', language: 'en', projectDir: '/p', createdAt: 999, userId: 'u', username: 'u' },
      ];
      writeFileSync(indexPath, JSON.stringify(seedData));

      const { sessions, loadIndex } = createPersistenceManager(indexPath);
      expect(sessions.size).toBe(0);

      loadIndex();

      expect(sessions.size).toBe(1);
      expect(sessions.has('conv-x')).toBe(true);
      const entry = sessions.get('conv-x');
      expect(entry.teamType).toBe('dev');
      expect(entry.createdAt).toBe(999);
      // `id` should NOT be present in the session value — it's the Map key
      expect(entry.id).toBeUndefined();
    });

    it('should not throw if index file does not exist on load', () => {
      const { sessions, loadIndex } = createPersistenceManager(join(tmpDir, 'nonexistent.json'));
      expect(() => loadIndex()).not.toThrow();
      expect(sessions.size).toBe(0);
    });

    it('should not throw if index file contains invalid JSON', () => {
      writeFileSync(indexPath, 'NOT JSON');
      const { sessions, loadIndex } = createPersistenceManager(indexPath);
      expect(() => loadIndex()).not.toThrow();
      expect(sessions.size).toBe(0);
    });

    it('should remove a session and persist the change', () => {
      const { sessions, saveIndex, removeSession } = createPersistenceManager(indexPath);

      sessions.set('conv-a', { roles: [], teamType: 'dev', language: 'en', projectDir: '/', createdAt: 1, userId: 'u', username: 'u' });
      sessions.set('conv-b', { roles: [], teamType: 'dev', language: 'en', projectDir: '/', createdAt: 2, userId: 'u', username: 'u' });
      saveIndex();

      removeSession('conv-a');

      expect(sessions.size).toBe(1);
      expect(sessions.has('conv-a')).toBe(false);

      const onDisk = JSON.parse(readFileSync(indexPath, 'utf-8'));
      expect(onDisk).toHaveLength(1);
      expect(onDisk[0].id).toBe('conv-b');
    });

    it('should survive save → load round-trip preserving all fields', () => {
      const { sessions: s1, saveIndex } = createPersistenceManager(indexPath);
      const originalRoles = makeDevTeamRoles();
      s1.set('conv-rt', {
        roles: originalRoles,
        teamType: 'dev',
        language: 'zh-CN',
        projectDir: '/home/user/project',
        createdAt: 12345,
        userId: 'user-42',
        username: '张三',
      });
      saveIndex();

      // Load into a fresh manager
      const { sessions: s2, loadIndex } = createPersistenceManager(indexPath);
      loadIndex();

      expect(s2.size).toBe(1);
      const loaded = s2.get('conv-rt');
      expect(loaded.teamType).toBe('dev');
      expect(loaded.language).toBe('zh-CN');
      expect(loaded.projectDir).toBe('/home/user/project');
      expect(loaded.createdAt).toBe(12345);
      expect(loaded.userId).toBe('user-42');
      expect(loaded.username).toBe('张三');
      expect(loaded.roles).toHaveLength(4);
      expect(loaded.roles[0].name).toBe('pm');
    });

    it('should save empty array when Map is empty', () => {
      const { saveIndex } = createPersistenceManager(indexPath);
      saveIndex();

      const onDisk = JSON.parse(readFileSync(indexPath, 'utf-8'));
      expect(onDisk).toEqual([]);
    });

    it('should remove a non-existent session without error', () => {
      const { sessions, removeSession } = createPersistenceManager(indexPath);
      sessions.set('keep', { roles: [], teamType: 'dev', language: 'en', projectDir: '/', createdAt: 1, userId: 'u', username: 'u' });

      expect(() => removeSession('does-not-exist')).not.toThrow();
      expect(sessions.size).toBe(1); // 'keep' is still there
    });
  });

  // ---------------------------------------------------------------
  // Conversation integration (replicated logic from conversation.js)
  // ---------------------------------------------------------------

  describe('conversation.js roleplay integration (replicated logic)', () => {

    // Minimal ctx mock
    let ctx;
    let rolePlaySessions;
    let sentMessages;

    beforeEach(() => {
      rolePlaySessions = new Map();
      sentMessages = [];
      ctx = {
        CONFIG: { workDir: '/default' },
        conversations: new Map(),
        mcpServers: [],
        sendToServer: (msg) => sentMessages.push(msg),
      };
    });

    // Replicate createConversation logic (roleplay-relevant parts)
    function createConversation(msg) {
      const { conversationId, workDir, userId, username, disallowedTools, rolePlayConfig } = msg;
      const effectiveWorkDir = workDir || ctx.CONFIG.workDir;

      ctx.conversations.set(conversationId, {
        query: null,
        inputStream: null,
        workDir: effectiveWorkDir,
        claudeSessionId: null,
        createdAt: Date.now(),
        abortController: null,
        tools: [],
        slashCommands: [],
        model: null,
        userId,
        username,
        disallowedTools: disallowedTools || null,
        rolePlayConfig: rolePlayConfig || null,
        usage: { inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheCreation: 0, totalCostUsd: 0 }
      });

      if (rolePlayConfig) {
        rolePlaySessions.set(conversationId, {
          roles: rolePlayConfig.roles,
          teamType: rolePlayConfig.teamType,
          language: rolePlayConfig.language,
          projectDir: effectiveWorkDir,
          createdAt: Date.now(),
          userId,
          username,
        });
      }

      sentMessages.push({
        type: 'conversation_created',
        conversationId,
        workDir: effectiveWorkDir,
        userId,
        username,
        disallowedTools: disallowedTools || null,
        rolePlayConfig: rolePlayConfig || null,
      });
    }

    // Replicate sendConversationList logic (roleplay-relevant parts)
    function sendConversationList() {
      const list = [];
      for (const [id, state] of ctx.conversations) {
        const entry = {
          id,
          workDir: state.workDir,
          claudeSessionId: state.claudeSessionId,
          createdAt: state.createdAt,
          processing: !!state.turnActive,
          userId: state.userId,
          username: state.username,
        };
        if (rolePlaySessions.has(id)) {
          entry.type = 'rolePlay';
          entry.rolePlayRoles = rolePlaySessions.get(id).roles;
        }
        list.push(entry);
      }
      sentMessages.push({ type: 'conversation_list', conversations: list });
    }

    // Replicate deleteConversation roleplay cleanup
    function deleteConversation(conversationId) {
      const conv = ctx.conversations.get(conversationId);
      if (conv) {
        ctx.conversations.delete(conversationId);
      }
      if (rolePlaySessions.has(conversationId)) {
        rolePlaySessions.delete(conversationId);
      }
      sentMessages.push({ type: 'conversation_deleted', conversationId });
    }

    // Replicate resumeConversation roleplay restoration
    function resumeConversation(conversationId, claudeSessionId, workDir, userId, username) {
      const effectiveWorkDir = workDir || ctx.CONFIG.workDir;

      const rolePlayEntry = rolePlaySessions.get(conversationId);
      const rolePlayConfig = rolePlayEntry
        ? { roles: rolePlayEntry.roles, teamType: rolePlayEntry.teamType, language: rolePlayEntry.language }
        : null;

      ctx.conversations.set(conversationId, {
        query: null,
        inputStream: null,
        workDir: effectiveWorkDir,
        claudeSessionId,
        createdAt: Date.now(),
        abortController: null,
        tools: [],
        slashCommands: [],
        model: null,
        userId,
        username,
        disallowedTools: null,
        rolePlayConfig,
        usage: { inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheCreation: 0, totalCostUsd: 0 }
      });
    }

    it('should store rolePlayConfig in conversation state when provided', () => {
      const rolePlayConfig = { roles: makeMinimalRoles(), teamType: 'dev', language: 'en' };
      createConversation({
        conversationId: 'c1',
        workDir: '/p',
        userId: 'u1',
        username: 'alice',
        rolePlayConfig,
      });

      const state = ctx.conversations.get('c1');
      expect(state.rolePlayConfig).toEqual(rolePlayConfig);
    });

    it('should set rolePlayConfig to null when not provided', () => {
      createConversation({
        conversationId: 'c2',
        workDir: '/p',
        userId: 'u1',
        username: 'bob',
      });

      const state = ctx.conversations.get('c2');
      expect(state.rolePlayConfig).toBeNull();
    });

    it('should register in rolePlaySessions when rolePlayConfig is provided', () => {
      const roles = makeDevTeamRoles();
      createConversation({
        conversationId: 'c3',
        workDir: '/project',
        userId: 'u1',
        username: 'carol',
        rolePlayConfig: { roles, teamType: 'dev', language: 'zh-CN' },
      });

      expect(rolePlaySessions.has('c3')).toBe(true);
      const entry = rolePlaySessions.get('c3');
      expect(entry.teamType).toBe('dev');
      expect(entry.language).toBe('zh-CN');
      expect(entry.roles).toBe(roles);
      expect(entry.projectDir).toBe('/project');
    });

    it('should NOT register in rolePlaySessions when rolePlayConfig is absent', () => {
      createConversation({
        conversationId: 'c4',
        workDir: '/p',
        userId: 'u1',
        username: 'dave',
      });

      expect(rolePlaySessions.has('c4')).toBe(false);
    });

    it('should include rolePlayConfig in conversation_created message', () => {
      const rolePlayConfig = { roles: makeMinimalRoles(), teamType: 'dev', language: 'en' };
      createConversation({
        conversationId: 'c5',
        workDir: '/p',
        userId: 'u1',
        username: 'eve',
        rolePlayConfig,
      });

      const created = sentMessages.find(m => m.type === 'conversation_created');
      expect(created.rolePlayConfig).toEqual(rolePlayConfig);
    });

    it('should set rolePlayConfig to null in conversation_created when not provided', () => {
      createConversation({
        conversationId: 'c6',
        workDir: '/p',
        userId: 'u1',
        username: 'frank',
      });

      const created = sentMessages.find(m => m.type === 'conversation_created');
      expect(created.rolePlayConfig).toBeNull();
    });

    it('should mark roleplay conversations with type=rolePlay in conversation list', () => {
      const roles = makeMinimalRoles();
      createConversation({
        conversationId: 'roleplay-1',
        workDir: '/p',
        userId: 'u1',
        username: 'grace',
        rolePlayConfig: { roles, teamType: 'dev', language: 'en' },
      });
      createConversation({
        conversationId: 'normal-1',
        workDir: '/p',
        userId: 'u1',
        username: 'heidi',
      });

      sentMessages = [];
      sendConversationList();

      const listMsg = sentMessages.find(m => m.type === 'conversation_list');
      expect(listMsg).toBeDefined();

      const rolePlayEntry = listMsg.conversations.find(c => c.id === 'roleplay-1');
      expect(rolePlayEntry.type).toBe('rolePlay');
      expect(rolePlayEntry.rolePlayRoles).toEqual(roles);

      const normalEntry = listMsg.conversations.find(c => c.id === 'normal-1');
      expect(normalEntry.type).toBeUndefined();
      expect(normalEntry.rolePlayRoles).toBeUndefined();
    });

    it('should clean up rolePlaySessions on deleteConversation', () => {
      createConversation({
        conversationId: 'del-1',
        workDir: '/p',
        userId: 'u1',
        username: 'ivan',
        rolePlayConfig: { roles: makeMinimalRoles(), teamType: 'dev', language: 'en' },
      });
      expect(rolePlaySessions.has('del-1')).toBe(true);

      deleteConversation('del-1');

      expect(rolePlaySessions.has('del-1')).toBe(false);
      expect(ctx.conversations.has('del-1')).toBe(false);
    });

    it('should not error when deleting a non-roleplay conversation', () => {
      createConversation({
        conversationId: 'del-2',
        workDir: '/p',
        userId: 'u1',
        username: 'judy',
      });

      expect(() => deleteConversation('del-2')).not.toThrow();
      expect(ctx.conversations.has('del-2')).toBe(false);
    });

    it('should restore rolePlayConfig from rolePlaySessions on resumeConversation', () => {
      const roles = makeDevTeamRoles();
      // Simulate a previously created roleplay session persisted in rolePlaySessions
      rolePlaySessions.set('resume-1', {
        roles,
        teamType: 'dev',
        language: 'zh-CN',
        projectDir: '/project',
        createdAt: 1000,
        userId: 'u1',
        username: 'karl',
      });

      resumeConversation('resume-1', 'session-uuid', '/project', 'u1', 'karl');

      const state = ctx.conversations.get('resume-1');
      expect(state.rolePlayConfig).not.toBeNull();
      expect(state.rolePlayConfig.teamType).toBe('dev');
      expect(state.rolePlayConfig.language).toBe('zh-CN');
      expect(state.rolePlayConfig.roles).toBe(roles);
    });

    it('should set rolePlayConfig to null on resumeConversation when not in rolePlaySessions', () => {
      resumeConversation('resume-2', 'session-uuid', '/project', 'u1', 'larry');

      const state = ctx.conversations.get('resume-2');
      expect(state.rolePlayConfig).toBeNull();
    });
  });

  // ---------------------------------------------------------------
  // claude.js integration (replicated logic)
  // ---------------------------------------------------------------

  describe('claude.js roleplay integration (replicated logic)', () => {
    it('should save and restore rolePlayConfig across startClaudeQuery restarts', () => {
      // Simulate the save/restore pattern in startClaudeQuery
      const conversations = new Map();
      const rolePlayConfig = { roles: makeMinimalRoles(), teamType: 'dev', language: 'en' };

      // Initial state
      conversations.set('cq-1', {
        rolePlayConfig,
        disallowedTools: ['mcp__foo'],
        userId: 'u1',
        username: 'mike',
      });

      // Step 1: Save settings from existing state (as startClaudeQuery does)
      const existing = conversations.get('cq-1');
      const savedDisallowedTools = existing.disallowedTools ?? null;
      const savedRolePlayConfig = existing.rolePlayConfig ?? null;
      const savedUserId = existing.userId;
      const savedUsername = existing.username;

      // Step 2: Delete old entry and create fresh state (simulating restart)
      conversations.delete('cq-1');
      conversations.set('cq-1', {
        rolePlayConfig: savedRolePlayConfig,
        disallowedTools: savedDisallowedTools,
        userId: savedUserId,
        username: savedUsername,
      });

      // Verify restoration
      const restored = conversations.get('cq-1');
      expect(restored.rolePlayConfig).toEqual(rolePlayConfig);
      expect(restored.disallowedTools).toEqual(['mcp__foo']);
    });

    it('should set rolePlayConfig to null when original state had no rolePlayConfig', () => {
      const conversations = new Map();

      conversations.set('cq-2', {
        disallowedTools: null,
        userId: 'u1',
        username: 'nancy',
        // no rolePlayConfig property
      });

      const existing = conversations.get('cq-2');
      const savedRolePlayConfig = existing.rolePlayConfig ?? null;

      conversations.delete('cq-2');
      conversations.set('cq-2', {
        rolePlayConfig: savedRolePlayConfig,
      });

      expect(conversations.get('cq-2').rolePlayConfig).toBeNull();
    });

    it('should inject appendSystemPrompt when rolePlayConfig is present', () => {
      const rolePlayConfig = { roles: makeDevTeamRoles(), teamType: 'dev', language: 'en' };
      const options = {};

      // Replicate the injection logic from claude.js
      if (rolePlayConfig) {
        options.appendSystemPrompt = buildRolePlaySystemPrompt(rolePlayConfig);
      }

      expect(options.appendSystemPrompt).toBeDefined();
      expect(options.appendSystemPrompt).toContain('# Multi-Role Collaboration Mode');
      expect(options.appendSystemPrompt).toContain('PM乔布斯');
    });

    it('should NOT inject appendSystemPrompt when rolePlayConfig is null', () => {
      const savedRolePlayConfig = null;
      const options = {};

      if (savedRolePlayConfig) {
        options.appendSystemPrompt = buildRolePlaySystemPrompt(savedRolePlayConfig);
      }

      expect(options.appendSystemPrompt).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------
  // client-conversation.js transparent pass-through
  // ---------------------------------------------------------------

  describe('client-conversation.js rolePlayConfig passthrough', () => {
    it('should pass rolePlayConfig to agent when present in client message', () => {
      const clientMsg = {
        type: 'create_conversation',
        conversationId: 'cc-1',
        workDir: '/p',
        disallowedTools: null,
        rolePlayConfig: { roles: makeMinimalRoles(), teamType: 'dev', language: 'en' },
      };

      // Replicate the handler logic
      const agentMsg = {
        type: 'create_conversation',
        conversationId: clientMsg.conversationId,
        workDir: clientMsg.workDir,
        userId: 'u1',
        username: 'test',
        disallowedTools: clientMsg.disallowedTools,
        rolePlayConfig: clientMsg.rolePlayConfig || null,
      };

      expect(agentMsg.rolePlayConfig).toEqual(clientMsg.rolePlayConfig);
    });

    it('should default rolePlayConfig to null when not in client message', () => {
      const clientMsg = {
        type: 'create_conversation',
        conversationId: 'cc-2',
        workDir: '/p',
      };

      const agentMsg = {
        type: 'create_conversation',
        conversationId: clientMsg.conversationId,
        workDir: clientMsg.workDir,
        userId: 'u1',
        username: 'test',
        disallowedTools: clientMsg.disallowedTools,
        rolePlayConfig: clientMsg.rolePlayConfig || null,
      };

      expect(agentMsg.rolePlayConfig).toBeNull();
    });
  });

  // ---------------------------------------------------------------
  // Edge cases and boundary conditions
  // ---------------------------------------------------------------

  describe('edge cases', () => {
    it('should handle single-role config without crashing', () => {
      const roles = [{ name: 'pm', displayName: 'PM', icon: '📋', description: '唯一角色' }];
      const prompt = buildRolePlaySystemPrompt({ roles, teamType: 'dev', language: 'zh-CN' });

      expect(prompt).toContain('PM (pm)');
      expect(prompt).toContain('唯一角色');
    });

    it('should handle roles with unicode characters in names', () => {
      const roles = [
        { name: 'pm', displayName: 'PM-乔布斯💡', icon: '📋', description: '产品经理' },
      ];
      const prompt = buildRolePlaySystemPrompt({ roles, teamType: 'dev', language: 'zh-CN' });

      expect(prompt).toContain('PM-乔布斯💡');
    });

    it('should handle empty roles array gracefully', () => {
      const prompt = buildRolePlaySystemPrompt({ roles: [], teamType: 'dev', language: 'en' });

      // Should still produce a valid prompt structure, just no roles listed
      expect(prompt).toContain('## Available Roles');
      expect(prompt).toContain('## Workflow');
    });

    it('should handle undefined teamType with generic workflow', () => {
      const roles = [{ name: 'pm', displayName: 'PM', icon: '', description: '' }];
      const prompt = buildRolePlaySystemPrompt({ roles, teamType: undefined, language: 'en' });

      expect(prompt).toContain('Complete tasks by following the role sequence');
    });
  });
});
