/**
 * Role Play — lightweight multi-role collaboration within a single conversation.
 *
 * Manages rolePlaySessions (in-memory + persisted to disk), builds the
 * appendSystemPrompt that instructs Claude to role-play multiple characters,
 * and handles ROUTE protocol for Crew-style role switching within a single
 * Claude conversation.
 */

import { join } from 'path';
import { homedir } from 'os';
import { readFileSync, writeFileSync, existsSync, renameSync, readdirSync, statSync } from 'fs';
import { promises as fsp } from 'fs';
import { parseRoutes } from './crew/routing.js';

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
    // Only persist core fields, skip runtime route state and mtime snapshots
    const { _routeInitialized, _crewContextMtimes, currentRole, features, round, roleStates, waitingHuman, waitingHumanContext, ...core } = session;
    data.push({ id, ...core });
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
// .crew context import
// ---------------------------------------------------------------------------

/**
 * Read a file if it exists, otherwise return null.
 * @param {string} filePath
 * @returns {string|null}
 */
function readFileOrNull(filePath) {
  try {
    if (!existsSync(filePath)) return null;
    return readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }
}

/**
 * Load .crew context from a project directory.
 * Returns null if .crew/ doesn't exist.
 *
 * @param {string} projectDir - absolute path to project root
 * @returns {{ sharedClaudeMd: string, roles: Array, kanban: string, features: Array, teamType: string, language: string } | null}
 */
export function loadCrewContext(projectDir) {
  const crewDir = join(projectDir, '.crew');
  if (!existsSync(crewDir)) return null;

  // 1. Shared CLAUDE.md
  const sharedClaudeMd = readFileOrNull(join(crewDir, 'CLAUDE.md')) || '';

  // 2. session.json → roles, teamType, language, features
  let sessionRoles = [];
  let teamType = 'dev';
  let language = 'zh-CN';
  let sessionFeatures = [];
  const sessionPath = join(crewDir, 'session.json');
  const sessionJson = readFileOrNull(sessionPath);
  if (sessionJson) {
    try {
      const session = JSON.parse(sessionJson);
      if (Array.isArray(session.roles)) {
        sessionRoles = session.roles;
      }
      if (session.teamType) teamType = session.teamType;
      if (session.language) language = session.language;
      if (Array.isArray(session.features)) {
        sessionFeatures = session.features;
      }
    } catch {
      // Invalid JSON — ignore
    }
  }

  // 3. Per-role CLAUDE.md from .crew/roles/*/CLAUDE.md
  const roleClaudes = {};
  const rolesDir = join(crewDir, 'roles');
  if (existsSync(rolesDir)) {
    try {
      const roleDirs = readdirSync(rolesDir, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => d.name);
      for (const dirName of roleDirs) {
        const md = readFileOrNull(join(rolesDir, dirName, 'CLAUDE.md'));
        if (md) roleClaudes[dirName] = md;
      }
    } catch {
      // Permission error or similar — ignore
    }
  }

  // 4. Merge roles: deduplicate by roleType, attach claudeMd
  const roles = deduplicateRoles(sessionRoles, roleClaudes);

  // 5. Kanban
  const kanban = readFileOrNull(join(crewDir, 'context', 'kanban.md')) || '';

  // 6. Feature files from context/features/*.md
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
    } catch {
      // ignore
    }
  }

  return { sharedClaudeMd, roles, kanban, features, teamType, language, sessionFeatures };
}

/**
 * Deduplicate Crew roles by roleType.
 * Crew may have dev-1, dev-2, dev-3 — collapse to a single "dev" for RolePlay.
 * Attaches per-role CLAUDE.md content.
 */
function deduplicateRoles(sessionRoles, roleClaudes) {
  const byType = new Map(); // roleType -> first role seen
  const merged = [];

  for (const r of sessionRoles) {
    const type = r.roleType || r.name;
    const claudeMd = roleClaudes[r.name] || '';

    if (byType.has(type)) {
      // Already have this roleType — skip duplicate instance
      continue;
    }

    byType.set(type, true);

    // Use roleType as the RolePlay name (e.g. "developer" instead of "dev-1")
    // But keep "pm" and "designer" as-is since they're typically single-instance
    const name = type;
    // Strip instance suffix from displayName (e.g. "开发者-托瓦兹-1" → "开发者-托瓦兹")
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

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

const ALLOWED_TEAM_TYPES = ['dev', 'writing', 'trading', 'video', 'custom'];
const MAX_ROLE_NAME_LEN = 64;
const MAX_DISPLAY_NAME_LEN = 128;
const MAX_CLAUDE_MD_LEN = 8192;
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
 * @param {{ roles: Array, teamType: string, language: string, crewContext?: object }} config
 * @returns {string}
 */
export function buildRolePlaySystemPrompt(config) {
  const { roles, teamType, language, crewContext } = config;
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

  // Append .crew context if available
  if (crewContext) {
    const contextBlock = buildCrewContextBlock(crewContext, isZh);
    if (contextBlock) {
      return (prompt + '\n\n' + contextBlock).trim();
    }
  }

  return prompt.trim();
}

function buildZhPrompt(roleList, workflow) {
  return `
# 多角色协作模式

你正在以多角色协作方式完成任务。你将依次扮演不同角色，每个角色有独立的视角、人格和专业能力。

## 可用角色

${roleList}

## 角色切换规则

### 方式一：ROUTE 协议（推荐）

当一个角色完成工作需要交给另一个角色时，使用 ROUTE 块：

\`\`\`
---ROUTE---
to: {目标角色name}
summary: {交接内容摘要}
task: {任务ID，如 task-1}（可选）
taskTitle: {任务标题}（可选）
---END_ROUTE---
\`\`\`

ROUTE 规则：
- 一次可以输出多个 ROUTE 块（例如同时发给 reviewer 和 tester）
- \`to\` 必须是有效的角色 name，或 \`human\` 表示需要用户输入
- \`summary\` 是交给目标角色的具体任务和上下文
- \`task\` / \`taskTitle\` 用于追踪 feature/任务（PM 分配任务时应填写）
- ROUTE 块必须在角色输出的末尾

### 方式二：ROLE 信号（简单切换）

---ROLE: {角色name}---

直接切换到目标角色继续工作，适用于简单的角色轮转。

### 通用规则

- 切换后，你必须完全以该角色的视角和人格思考、说话和行动
- 第一条输出必须先切换到起始角色（通常是 PM）
- 每次切换前留下交接信息（完成了什么、对下一角色的要求）

## 工作流程

${workflow}

## 交接规范

每次角色切换时，上一个角色必须留下清晰的交接信息：
- 完成了什么
- 未完成的部分（如有）
- 对下一个角色的具体要求或注意事项

## 输出格式

- 不要在回复开头添加角色名称或"XX视角"等标题，对话界面已经显示了角色信息，直接以角色身份开始回复内容
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

### Method 1: ROUTE Protocol (Recommended)

When a role finishes work and needs to hand off to another role, use a ROUTE block:

\`\`\`
---ROUTE---
to: {target_role_name}
summary: {handoff content summary}
task: {task ID, e.g. task-1} (optional)
taskTitle: {task title} (optional)
---END_ROUTE---
\`\`\`

ROUTE rules:
- You can output multiple ROUTE blocks at once (e.g., send to both reviewer and tester)
- \`to\` must be a valid role name, or \`human\` to request user input
- \`summary\` is the specific task and context for the target role
- \`task\` / \`taskTitle\` are for tracking features/tasks (PM should fill these when assigning)
- ROUTE blocks must be at the end of the role's output

### Method 2: ROLE Signal (Simple Switch)

---ROLE: {role_name}---

Directly switch to the target role to continue working. Suitable for simple role rotation.

### General Rules

- After switching, you must fully think, speak, and act from that role's perspective
- Your first output must switch to the starting role (usually PM)
- Before each switch, leave handoff information (what was done, requirements for next role)

## Workflow

${workflow}

## Handoff Convention

Each role switch must include clear handoff information from the previous role:
- What was completed
- What remains (if any)
- Specific requirements or notes for the next role

## Output Format

- Do not add role names or titles like "XX's perspective" at the beginning of responses; the chat UI already displays role information — start directly with the role's content
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
  if (teamType === 'writing') {
    return buildWritingWorkflow(roleNames, isZh);
  }
  if (teamType === 'trading') {
    return buildTradingWorkflow(roleNames, isZh);
  }
  if (teamType === 'video') {
    return buildVideoWorkflow(roleNames, isZh);
  }

  // Generic fallback for custom / unknown team types
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

function buildWritingWorkflow(roleNames, isZh) {
  const hasEditor = roleNames.includes('editor');
  const hasWriter = roleNames.includes('writer');
  const hasProofreader = roleNames.includes('proofreader');

  const steps = [];

  if (isZh) {
    if (hasEditor) steps.push(`${steps.length + 1}. **编辑** 分析需求，确定内容方向和框架`);
    if (hasWriter) steps.push(`${steps.length + 1}. **作者** 根据大纲撰写内容`);
    if (hasProofreader) steps.push(`${steps.length + 1}. **审校** 检查逻辑一致性、事实准确性和文字质量（不通过 → 返回作者修改）`);
    if (hasEditor) steps.push(`${steps.length + 1}. **编辑** 验收最终成果`);
  } else {
    if (hasEditor) steps.push(`${steps.length + 1}. **Editor** analyzes requirements, determines content direction and framework`);
    if (hasWriter) steps.push(`${steps.length + 1}. **Writer** writes content based on outline`);
    if (hasProofreader) steps.push(`${steps.length + 1}. **Proofreader** checks logical consistency, factual accuracy, and writing quality (if fails → back to Writer)`);
    if (hasEditor) steps.push(`${steps.length + 1}. **Editor** final acceptance of deliverables`);
  }

  return steps.join('\n');
}

function buildTradingWorkflow(roleNames, isZh) {
  const hasAnalyst = roleNames.includes('analyst');
  const hasStrategist = roleNames.includes('strategist');
  const hasRiskManager = roleNames.includes('risk-manager');

  const steps = [];

  if (isZh) {
    if (hasAnalyst) steps.push(`${steps.length + 1}. **分析师** 研究市场，输出技术分析和关键价位`);
    if (hasStrategist) steps.push(`${steps.length + 1}. **策略师** 综合分析，制定投资策略和仓位方案`);
    if (hasRiskManager) steps.push(`${steps.length + 1}. **风控官** 压力测试策略，评估尾部风险（不通过 → 返回策略师调整）`);
    if (hasStrategist) steps.push(`${steps.length + 1}. **策略师** 确认最终方案并总结`);
  } else {
    if (hasAnalyst) steps.push(`${steps.length + 1}. **Analyst** researches market, outputs technical analysis and key levels`);
    if (hasStrategist) steps.push(`${steps.length + 1}. **Strategist** synthesizes analysis, formulates investment strategy and position plan`);
    if (hasRiskManager) steps.push(`${steps.length + 1}. **Risk Manager** stress-tests strategy, assesses tail risks (if fails → back to Strategist)`);
    if (hasStrategist) steps.push(`${steps.length + 1}. **Strategist** confirms final plan and summarizes`);
  }

  return steps.join('\n');
}

function buildVideoWorkflow(roleNames, isZh) {
  const hasDirector = roleNames.includes('director');
  const hasWriter = roleNames.includes('writer');
  const hasProducer = roleNames.includes('producer');

  const steps = [];

  if (isZh) {
    if (hasDirector) steps.push(`${steps.length + 1}. **导演** 确定主题、情绪基调和视觉风格`);
    if (hasWriter) steps.push(`${steps.length + 1}. **编剧** 构思故事线，撰写分段脚本`);
    if (hasProducer) steps.push(`${steps.length + 1}. **制片** 审核可行性，生成最终 prompt 序列（不通过 → 返回编剧调整）`);
    if (hasDirector) steps.push(`${steps.length + 1}. **导演** 最终审核并验收`);
  } else {
    if (hasDirector) steps.push(`${steps.length + 1}. **Director** establishes theme, emotional tone, and visual style`);
    if (hasWriter) steps.push(`${steps.length + 1}. **Screenwriter** conceives storyline, writes segmented script`);
    if (hasProducer) steps.push(`${steps.length + 1}. **Producer** reviews feasibility, generates final prompt sequence (if fails → back to Screenwriter)`);
    if (hasDirector) steps.push(`${steps.length + 1}. **Director** final review and acceptance`);
  }

  return steps.join('\n');
}

// Re-export parseRoutes for use by claude.js and tests
export { parseRoutes } from './crew/routing.js';

/**
 * Initialize RolePlay route state on a session.
 * Called when a roleplay conversation is first created or resumed.
 *
 * @param {object} session - rolePlaySessions entry
 * @param {object} convState - ctx.conversations entry
 */
export function initRolePlayRouteState(session, convState) {
  if (!session._routeInitialized) {
    session.currentRole = null;
    session.features = new Map();
    session.round = 0;
    session.roleStates = {};
    session.waitingHuman = false;
    session.waitingHumanContext = null;

    // Initialize per-role states
    for (const role of session.roles) {
      session.roleStates[role.name] = {
        currentTask: null,
        status: 'idle'
      };
    }
    session._routeInitialized = true;
  }

  // Also store accumulated text on convState for ROUTE detection during streaming
  if (!convState._roleplayAccumulated) {
    convState._roleplayAccumulated = '';
  }
}

/**
 * Detect a ROLE signal in text: ---ROLE: xxx---
 * Returns the role name if found at the end of accumulated text, null otherwise.
 */
export function detectRoleSignal(text) {
  const match = text.match(/---ROLE:\s*([a-zA-Z0-9_-]+)\s*---/);
  return match ? match[1].toLowerCase() : null;
}

/**
 * Process ROUTE blocks detected in a completed turn's output.
 * Called from claude.js when a result message is received.
 *
 * Returns { routes, hasHumanRoute, continueRoles } for the caller to act on.
 *
 * @param {string} accumulatedText - full text output from the current turn
 * @param {object} session - rolePlaySessions entry
 * @returns {{ routes: Array, hasHumanRoute: boolean, continueRoles: Array<{to, prompt}> }}
 */
export function processRolePlayRoutes(accumulatedText, session) {
  const routes = parseRoutes(accumulatedText);
  if (routes.length === 0) {
    return { routes: [], hasHumanRoute: false, continueRoles: [] };
  }

  const roleNames = new Set(session.roles.map(r => r.name));
  let hasHumanRoute = false;
  const continueRoles = [];

  for (const route of routes) {
    const { to, summary, taskId, taskTitle } = route;

    // Track features
    if (taskId && taskTitle && !session.features.has(taskId)) {
      session.features.set(taskId, { taskId, taskTitle, createdAt: Date.now() });
    }

    // Update source role state
    if (session.currentRole && session.roleStates[session.currentRole]) {
      session.roleStates[session.currentRole].status = 'idle';
    }

    if (to === 'human') {
      hasHumanRoute = true;
      session.waitingHuman = true;
      session.waitingHumanContext = {
        fromRole: session.currentRole,
        reason: 'requested',
        message: summary
      };
    } else if (roleNames.has(to)) {
      // Update target role state
      if (session.roleStates[to]) {
        session.roleStates[to].status = 'active';
        if (taskId) {
          session.roleStates[to].currentTask = { taskId, taskTitle };
        }
      }

      // Build prompt for the target role
      const fromRole = session.currentRole || 'unknown';
      const fromRoleConfig = session.roles.find(r => r.name === fromRole);
      const fromLabel = fromRoleConfig
        ? (fromRoleConfig.icon ? `${fromRoleConfig.icon} ${fromRoleConfig.displayName}` : fromRoleConfig.displayName)
        : fromRole;

      const targetRoleConfig = session.roles.find(r => r.name === to);
      const targetClaudeMd = targetRoleConfig?.claudeMd || '';

      let prompt = `来自 ${fromLabel} 的消息:\n${summary}\n\n`;
      if (targetClaudeMd) {
        prompt += `---\n<role-context>\n${targetClaudeMd}\n</role-context>\n\n`;
      }
      prompt += `你现在是 ${targetRoleConfig?.displayName || to}。请开始你的工作。完成后通过 ROUTE 块传递给下一个角色。`;

      continueRoles.push({ to, prompt, taskId, taskTitle });
    } else {
      console.warn(`[RolePlay] Unknown route target: ${to}`);
    }
  }

  // Increment round
  session.round++;

  return { routes, hasHumanRoute, continueRoles };
}

/**
 * Build the route event message to send to the frontend via WebSocket.
 *
 * @param {string} conversationId
 * @param {string} fromRole
 * @param {{ to, summary, taskId, taskTitle }} route
 * @returns {object} WebSocket message
 */
export function buildRouteEventMessage(conversationId, fromRole, route) {
  return {
    type: 'roleplay_route',
    conversationId,
    from: fromRole,
    to: route.to,
    taskId: route.taskId || null,
    taskTitle: route.taskTitle || null,
    summary: route.summary || ''
  };
}

/**
 * Get the current RolePlay route state summary for frontend status updates.
 *
 * @param {string} conversationId
 * @returns {object|null} Route state summary or null if not a roleplay session
 */
export function getRolePlayRouteState(conversationId) {
  const session = rolePlaySessions.get(conversationId);
  if (!session || !session._routeInitialized) return null;

  return {
    currentRole: session.currentRole,
    round: session.round,
    features: session.features ? Array.from(session.features.values()) : [],
    roleStates: session.roleStates || {},
    waitingHuman: session.waitingHuman || false,
    waitingHumanContext: session.waitingHumanContext || null
  };
}

// ---------------------------------------------------------------------------
// .crew context block for system prompt
// ---------------------------------------------------------------------------

/**
 * Build the .crew context block to append to the system prompt.
 * Includes shared instructions, kanban, and feature history.
 */
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
    // Only include the last few features to avoid blowing up context
    const recentFeatures = crewContext.features.slice(-5);
    const featureTexts = recentFeatures.map(f => {
      // Truncate each feature to keep total size reasonable
      const content = f.content.length > 2000 ? f.content.substring(0, 2000) + '\n...(truncated)' : f.content;
      return `### ${f.name}\n${content}`;
    }).join('\n\n');
    sections.push(`${header}\n\n${featureTexts}`);
  }

  return sections.join('\n\n');
}

// ---------------------------------------------------------------------------
// .crew context refresh (mtime-based change detection)
// ---------------------------------------------------------------------------

/**
 * Get mtime of a file, or 0 if it doesn't exist.
 * @param {string} filePath
 * @returns {number} mtime in ms
 */
function getMtimeMs(filePath) {
  try {
    return statSync(filePath).mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * Collect mtimes for all .crew context files that matter for RolePlay.
 * Returns a map of { relativePath → mtimeMs }.
 *
 * @param {string} projectDir
 * @returns {Map<string, number>}
 */
function collectCrewContextMtimes(projectDir) {
  const crewDir = join(projectDir, '.crew');
  const mtimes = new Map();

  // Shared CLAUDE.md
  mtimes.set('CLAUDE.md', getMtimeMs(join(crewDir, 'CLAUDE.md')));

  // context/kanban.md
  mtimes.set('context/kanban.md', getMtimeMs(join(crewDir, 'context', 'kanban.md')));

  // context/features/*.md
  const featuresDir = join(crewDir, 'context', 'features');
  if (existsSync(featuresDir)) {
    try {
      const files = readdirSync(featuresDir).filter(f => f.endsWith('.md') && f !== 'index.md');
      for (const f of files) {
        mtimes.set(`context/features/${f}`, getMtimeMs(join(featuresDir, f)));
      }
    } catch { /* ignore */ }
  }

  // session.json (roles may change)
  mtimes.set('session.json', getMtimeMs(join(crewDir, 'session.json')));

  return mtimes;
}

/**
 * Check if .crew context has changed since last snapshot.
 *
 * @param {Map<string, number>} oldMtimes - previous mtime snapshot
 * @param {Map<string, number>} newMtimes - current mtime snapshot
 * @returns {boolean} true if any file has been added, removed, or modified
 */
function hasCrewContextChanged(oldMtimes, newMtimes) {
  if (!oldMtimes) return true; // first check → always refresh

  // Defensive: if oldMtimes was deserialized from JSON (plain object, not Map),
  // treat as stale and force refresh
  if (!(oldMtimes instanceof Map)) return true;

  // Check for new or modified files
  for (const [path, mtime] of newMtimes) {
    if (!oldMtimes.has(path) || oldMtimes.get(path) !== mtime) return true;
  }

  // Check for deleted files
  for (const path of oldMtimes.keys()) {
    if (!newMtimes.has(path)) return true;
  }

  return false;
}

/**
 * Initialize the mtime snapshot for a RolePlay session without reloading context.
 * Use this when the caller has already loaded crewContext (e.g. resume path)
 * to avoid a redundant disk read.
 *
 * @param {string} projectDir - absolute path to project root
 * @param {object} rpSession - rolePlaySessions entry
 */
export function initCrewContextMtimes(projectDir, rpSession) {
  if (!projectDir || !existsSync(join(projectDir, '.crew'))) return;
  rpSession._crewContextMtimes = collectCrewContextMtimes(projectDir);
}

/**
 * Refresh .crew context for a RolePlay session if files have changed.
 * Updates the session's crewContext and returns true if refreshed.
 *
 * Call this before building the system prompt (on resume, or before each turn).
 *
 * @param {string} projectDir - absolute path to project root
 * @param {object} rpSession - rolePlaySessions entry
 * @param {object} convState - ctx.conversations entry (has rolePlayConfig)
 * @returns {boolean} true if context was refreshed
 */
export function refreshCrewContext(projectDir, rpSession, convState) {
  if (!projectDir || !existsSync(join(projectDir, '.crew'))) return false;

  const newMtimes = collectCrewContextMtimes(projectDir);

  // Compare with stored snapshot
  if (!hasCrewContextChanged(rpSession._crewContextMtimes, newMtimes)) {
    return false; // no change
  }

  // Reload
  const crewContext = loadCrewContext(projectDir);
  if (!crewContext) return false;

  // Update session and convState
  rpSession._crewContextMtimes = newMtimes;

  if (convState && convState.rolePlayConfig) {
    convState.rolePlayConfig.crewContext = crewContext;
  }

  console.log(`[RolePlay] Crew context refreshed from ${projectDir} (${crewContext.features.length} features, kanban: ${crewContext.kanban ? 'yes' : 'no'})`);
  return true;
}

// ---------------------------------------------------------------------------
// .crew context write-back (RolePlay → .crew/context)
// ---------------------------------------------------------------------------

// Write lock for atomic write-back
let _writeBackLock = Promise.resolve();

/**
 * Atomic write: write to temp file then rename.
 * @param {string} filePath
 * @param {string} content
 */
async function atomicWrite(filePath, content) {
  const tmpPath = filePath + '.tmp.' + Date.now();
  try {
    await fsp.writeFile(tmpPath, content);
    await fsp.rename(tmpPath, filePath);
  } catch (e) {
    // Clean up temp file on failure
    try { await fsp.unlink(tmpPath); } catch { /* ignore */ }
    throw e;
  }
}

/**
 * Write back RolePlay route output to .crew/context files.
 * Called after processRolePlayRoutes detects ROUTE blocks with task info.
 *
 * - Creates/updates context/features/{taskId}.md with route summary
 * - Serialized via write lock to prevent concurrent corruption
 *
 * NOTE: The atomic write (tmp→rename) prevents partial writes within this
 * process, and the serial lock prevents intra-process races. However, if a
 * Crew session in a separate process writes the same file concurrently,
 * a TOCTOU race is possible (read-then-write is not locked across processes).
 * In practice this is acceptable: Crew and RolePlay rarely write the same
 * task file simultaneously, and the worst case is a lost append (not corruption).
 *
 * @param {string} projectDir - absolute path to project root
 * @param {Array<{to: string, summary: string, taskId?: string, taskTitle?: string}>} routes
 * @param {string} fromRole - name of the role that produced the output
 * @param {object} rpSession - rolePlaySessions entry
 */
export function writeBackRouteContext(projectDir, routes, fromRole, rpSession) {
  if (!projectDir || !routes || routes.length === 0) return;

  const crewDir = join(projectDir, '.crew');
  if (!existsSync(crewDir)) return;

  const doWriteBack = async () => {
    const featuresDir = join(crewDir, 'context', 'features');

    for (const route of routes) {
      const { taskId, taskTitle, summary, to } = route;
      if (!taskId || !summary) continue;

      // ★ Sanitize taskId: only allow alphanumeric, hyphens, underscores
      // Prevents path traversal (e.g. "../" in taskId from Claude output)
      if (!/^[a-zA-Z0-9_-]+$/.test(taskId)) {
        console.warn(`[RolePlay] Write-back rejected: invalid taskId "${taskId}"`);
        continue;
      }

      try {
        await fsp.mkdir(featuresDir, { recursive: true });
        const filePath = join(featuresDir, `${taskId}.md`);

        let content;
        try {
          content = await fsp.readFile(filePath, 'utf-8');
        } catch {
          // File doesn't exist — create it
          const isZh = rpSession.language === 'zh-CN';
          content = `# ${isZh ? 'Feature' : 'Feature'}: ${taskTitle || taskId}\n- task-id: ${taskId}\n\n## ${isZh ? '工作记录' : 'Work Record'}\n`;
        }

        // Append the route record
        const fromRoleConfig = rpSession.roles?.find(r => r.name === fromRole);
        const fromLabel = fromRoleConfig
          ? (fromRoleConfig.icon ? `${fromRoleConfig.icon} ${fromRoleConfig.displayName}` : fromRoleConfig.displayName)
          : fromRole;
        const now = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
        const record = `\n### ${fromLabel} → ${to} - ${now}\n${summary}\n`;

        await atomicWrite(filePath, content + record);
        console.log(`[RolePlay] Write-back: task ${taskId} updated (${fromRole} → ${to})`);
      } catch (e) {
        console.warn(`[RolePlay] Write-back failed for ${taskId}:`, e.message);
      }
    }
  };

  // Serialize write-backs
  _writeBackLock = _writeBackLock.then(doWriteBack, doWriteBack);
  return _writeBackLock;
}
