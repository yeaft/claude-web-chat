/**
 * Role Play — lightweight multi-role collaboration within a single conversation.
 *
 * Manages rolePlaySessions (in-memory + persisted to disk) and builds the
 * appendSystemPrompt that instructs Claude to role-play multiple characters.
 */

import { join } from 'path';
import { homedir } from 'os';
import { readFileSync, writeFileSync, existsSync, renameSync } from 'fs';

const ROLEPLAY_INDEX_PATH = join(homedir(), '.claude', 'roleplay-sessions.json');
// ★ backward compat: old filename before rename
const LEGACY_INDEX_PATH = join(homedir(), '.claude', 'vcrew-sessions.json');

// In-memory map: conversationId -> { roles, teamType, language, projectDir, createdAt, userId, username }
export const rolePlaySessions = new Map();

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

export function saveRolePlayIndex() {
  const data = [];
  for (const [id, session] of rolePlaySessions) {
    data.push({ id, ...session });
  }
  try {
    writeFileSync(ROLEPLAY_INDEX_PATH, JSON.stringify(data, null, 2));
  } catch (e) {
    console.warn('[roleplay] Failed to save index:', e.message);
  }
}

export function loadRolePlayIndex() {
  let indexPath = ROLEPLAY_INDEX_PATH;

  // ★ backward compat: migrate old vcrew-sessions.json → roleplay-sessions.json
  if (!existsSync(indexPath) && existsSync(LEGACY_INDEX_PATH)) {
    try {
      renameSync(LEGACY_INDEX_PATH, indexPath);
      console.log('[roleplay] Migrated vcrew-sessions.json → roleplay-sessions.json');
    } catch (e) {
      // rename failed (e.g. permissions), fall back to reading old file directly
      console.warn('[roleplay] Could not rename legacy index, reading in-place:', e.message);
      indexPath = LEGACY_INDEX_PATH;
    }
  }

  if (!existsSync(indexPath)) return;
  try {
    const data = JSON.parse(readFileSync(indexPath, 'utf-8'));
    for (const entry of data) {
      const { id, ...session } = entry;
      rolePlaySessions.set(id, session);
    }
    console.log(`[roleplay] Loaded ${rolePlaySessions.size} sessions from index`);
  } catch (e) {
    console.warn('[roleplay] Failed to load index:', e.message);
  }
}

export function removeRolePlaySession(conversationId) {
  rolePlaySessions.delete(conversationId);
  saveRolePlayIndex();
}

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

const ALLOWED_TEAM_TYPES = ['dev', 'writing', 'trading', 'video', 'custom'];
const MAX_ROLE_NAME_LEN = 64;
const MAX_DISPLAY_NAME_LEN = 128;
const MAX_CLAUDE_MD_LEN = 4096;
const MAX_ROLES = 10;

/**
 * Validate and sanitize rolePlayConfig from the client.
 * Returns { valid: true, config: sanitizedConfig } or { valid: false, error: string }.
 *
 * @param {*} config - raw rolePlayConfig from client message
 * @returns {{ valid: boolean, config?: object, error?: string }}
 */
export function validateRolePlayConfig(config) {
  if (!config || typeof config !== 'object') {
    return { valid: false, error: 'rolePlayConfig must be an object' };
  }

  // teamType
  const teamType = config.teamType;
  if (typeof teamType !== 'string' || !ALLOWED_TEAM_TYPES.includes(teamType)) {
    return { valid: false, error: `teamType must be one of: ${ALLOWED_TEAM_TYPES.join(', ')}` };
  }

  // language
  const language = config.language;
  if (language !== 'zh-CN' && language !== 'en') {
    return { valid: false, error: 'language must be "zh-CN" or "en"' };
  }

  // roles
  if (!Array.isArray(config.roles) || config.roles.length === 0) {
    return { valid: false, error: 'roles must be a non-empty array' };
  }
  if (config.roles.length > MAX_ROLES) {
    return { valid: false, error: `roles must have at most ${MAX_ROLES} entries` };
  }

  const sanitizedRoles = [];
  const seenNames = new Set();

  for (let i = 0; i < config.roles.length; i++) {
    const r = config.roles[i];
    if (!r || typeof r !== 'object') {
      return { valid: false, error: `roles[${i}] must be an object` };
    }

    // name: required string, alphanumeric + hyphens/underscores
    if (typeof r.name !== 'string' || r.name.length === 0 || r.name.length > MAX_ROLE_NAME_LEN) {
      return { valid: false, error: `roles[${i}].name must be a non-empty string (max ${MAX_ROLE_NAME_LEN} chars)` };
    }
    if (!/^[a-zA-Z0-9_-]+$/.test(r.name)) {
      return { valid: false, error: `roles[${i}].name must contain only alphanumeric, hyphens, or underscores` };
    }
    if (seenNames.has(r.name)) {
      return { valid: false, error: `roles[${i}].name "${r.name}" is duplicated` };
    }
    seenNames.add(r.name);

    // displayName: required string
    if (typeof r.displayName !== 'string' || r.displayName.length === 0 || r.displayName.length > MAX_DISPLAY_NAME_LEN) {
      return { valid: false, error: `roles[${i}].displayName must be a non-empty string (max ${MAX_DISPLAY_NAME_LEN} chars)` };
    }

    sanitizedRoles.push({
      name: r.name,
      displayName: r.displayName.substring(0, MAX_DISPLAY_NAME_LEN),
      icon: typeof r.icon === 'string' ? r.icon.substring(0, 8) : '',
      description: typeof r.description === 'string' ? r.description.substring(0, 500) : '',
      claudeMd: typeof r.claudeMd === 'string' ? r.claudeMd.substring(0, MAX_CLAUDE_MD_LEN) : '',
    });
  }

  return {
    valid: true,
    config: {
      roles: sanitizedRoles,
      teamType,
      language,
    }
  };
}

// ---------------------------------------------------------------------------
// System prompt construction
// ---------------------------------------------------------------------------

/**
 * Build the appendSystemPrompt that tells Claude about the role play roles
 * and how to switch between them.
 *
 * @param {{ roles: Array, teamType: string, language: string }} config
 * @returns {string}
 */
export function buildRolePlaySystemPrompt(config) {
  const { roles, teamType, language } = config;
  const isZh = language === 'zh-CN';

  // Build role list
  const roleList = roles.map(r => {
    const desc = r.claudeMd || r.description || '';
    const icon = r.icon ? `${r.icon} ` : '';
    return `### ${icon}${r.displayName} (${r.name})\n${desc}`;
  }).join('\n\n');

  // Build workflow
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

// ---------------------------------------------------------------------------
// Workflow generation per team type
// ---------------------------------------------------------------------------

function getWorkflow(teamType, roles, isZh) {
  const roleNames = roles.map(r => r.name);

  if (teamType === 'dev') {
    return buildDevWorkflow(roleNames, isZh);
  }

  // Generic fallback for other team types
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
