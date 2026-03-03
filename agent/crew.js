/**
 * Crew Mode - Multi-Agent Orchestrator
 *
 * 管理多个 AI 角色的协作：每个角色是一个独立的持久 query 实例，
 * 编排器负责解析路由、分发消息、管理生命周期。
 *
 * 支持：
 * - 动态添加/移除角色（群聊加人）
 * - 角色级 CLAUDE.md + memory.md（利用 Claude Code 的 CLAUDE.md 自动向上查找机制）
 * - 共享级 .crew/CLAUDE.md（所有角色自动继承）
 * - Session resume（每个角色的 claudeSessionId 持久化）
 * - 自动路由 + 人工混合
 */

import { query, Stream } from './sdk/index.js';
import { promises as fs } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import ctx from './context.js';

// =====================================================================
// Data Structures
// =====================================================================

/** @type {Map<string, CrewSession>} */
const crewSessions = new Map();

// 导出供 connection.js / conversation.js 使用
export { crewSessions };

// =====================================================================
// Crew Session Index (~/.claude/crew-sessions.json)
// =====================================================================

const CREW_INDEX_PATH = join(homedir(), '.claude', 'crew-sessions.json');

// 写入锁：防止并发写入导致文件损坏
let _indexWriteLock = Promise.resolve();

export async function loadCrewIndex() {
  try { return JSON.parse(await fs.readFile(CREW_INDEX_PATH, 'utf-8')); }
  catch { return []; }
}

async function saveCrewIndex(index) {
  const doWrite = async () => {
    await fs.mkdir(join(homedir(), '.claude'), { recursive: true });
    const data = JSON.stringify(index, null, 2);
    // 先写临时文件再 rename，保证原子性
    const tmpPath = CREW_INDEX_PATH + '.tmp';
    await fs.writeFile(tmpPath, data);
    await fs.rename(tmpPath, CREW_INDEX_PATH);
  };
  // 串行化写入
  _indexWriteLock = _indexWriteLock.then(doWrite, doWrite);
  return _indexWriteLock;
}

function sessionToIndexEntry(session) {
  return {
    sessionId: session.id,
    projectDir: session.projectDir,
    sharedDir: session.sharedDir,
    status: session.status,
    goal: session.goal,
    userId: session.userId,
    username: session.username,
    createdAt: session.createdAt,
    updatedAt: Date.now()
  };
}

async function upsertCrewIndex(session) {
  const index = await loadCrewIndex();
  const entry = sessionToIndexEntry(session);
  const idx = index.findIndex(e => e.sessionId === session.id);
  if (idx >= 0) index[idx] = entry; else index.push(entry);
  await saveCrewIndex(index);
}

export async function removeFromCrewIndex(sessionId) {
  const index = await loadCrewIndex();
  const filtered = index.filter(e => e.sessionId !== sessionId);
  if (filtered.length !== index.length) {
    await saveCrewIndex(filtered);
    console.log(`[Crew] Removed session ${sessionId} from index`);
  }
}

// =====================================================================
// Session Metadata (.crew/session.json)
// =====================================================================

async function saveSessionMeta(session) {
  const meta = {
    sessionId: session.id,
    projectDir: session.projectDir,
    sharedDir: session.sharedDir,
    goal: session.goal,
    status: session.status,
    roles: Array.from(session.roles.values()).map(r => ({
      name: r.name, displayName: r.displayName, icon: r.icon,
      description: r.description, isDecisionMaker: r.isDecisionMaker || false
    })),
    decisionMaker: session.decisionMaker,
    maxRounds: session.maxRounds,
    round: session.round,
    createdAt: session.createdAt,
    updatedAt: Date.now(),
    userId: session.userId,
    username: session.username
  };
  await fs.writeFile(join(session.sharedDir, 'session.json'), JSON.stringify(meta, null, 2));
  // 保存 UI 消息历史（用于恢复时重放）
  if (session.uiMessages && session.uiMessages.length > 0) {
    // 清理 _streaming 标记后保存
    const cleaned = session.uiMessages.map(m => {
      const { _streaming, ...rest } = m;
      return rest;
    });
    await fs.writeFile(join(session.sharedDir, 'messages.json'), JSON.stringify(cleaned));
  }
}

async function loadSessionMeta(sharedDir) {
  try { return JSON.parse(await fs.readFile(join(sharedDir, 'session.json'), 'utf-8')); }
  catch { return null; }
}

async function loadSessionMessages(sharedDir) {
  try { return JSON.parse(await fs.readFile(join(sharedDir, 'messages.json'), 'utf-8')); }
  catch { return []; }
}

// =====================================================================
// List & Resume Crew Sessions
// =====================================================================

/**
 * 列出所有 crew sessions（从索引文件 + 活跃 sessions 合并）
 */
export async function handleListCrewSessions(msg) {
  const { requestId, _requestClientId } = msg;
  const index = await loadCrewIndex();

  // 用活跃 session 更新实时状态
  for (const entry of index) {
    const active = crewSessions.get(entry.sessionId);
    if (active) {
      entry.status = active.status;
    }
  }

  ctx.sendToServer({
    type: 'crew_sessions_list',
    requestId,
    _requestClientId,
    sessions: index
  });
}

/**
 * 恢复已停止的 crew session
 */
export async function resumeCrewSession(msg) {
  const { sessionId, userId, username } = msg;

  // 如果已经在活跃 sessions 中，重新发送完整信息让前端重建
  if (crewSessions.has(sessionId)) {
    const session = crewSessions.get(sessionId);
    const roles = Array.from(session.roles.values());
    // 如果内存中没有 uiMessages，尝试从磁盘加载
    if ((!session.uiMessages || session.uiMessages.length === 0) && session.sharedDir) {
      session.uiMessages = await loadSessionMessages(session.sharedDir);
    }
    sendCrewMessage({
      type: 'crew_session_restored',
      sessionId,
      projectDir: session.projectDir,
      sharedDir: session.sharedDir,
      goal: session.goal,
      roles: roles.map(r => ({
        name: r.name, displayName: r.displayName, icon: r.icon,
        description: r.description, isDecisionMaker: r.isDecisionMaker || false
      })),
      decisionMaker: session.decisionMaker,
      maxRounds: session.maxRounds,
      userId: session.userId,
      username: session.username,
      uiMessages: session.uiMessages || []
    });
    sendStatusUpdate(session);
    return;
  }

  // 从索引获取 sharedDir
  const index = await loadCrewIndex();
  const indexEntry = index.find(e => e.sessionId === sessionId);
  if (!indexEntry) {
    sendCrewMessage({ type: 'error', sessionId, message: 'Crew session not found in index' });
    return;
  }

  // 从 session.json 加载详细元数据
  const meta = await loadSessionMeta(indexEntry.sharedDir);
  if (!meta) {
    sendCrewMessage({ type: 'error', sessionId, message: 'Crew session metadata not found' });
    return;
  }

  // 重建 session（跳过 initSharedDir，目录已存在）
  const roles = meta.roles || [];
  const decisionMaker = meta.decisionMaker || roles[0]?.name || null;
  const session = {
    id: sessionId,
    projectDir: meta.projectDir,
    sharedDir: meta.sharedDir || indexEntry.sharedDir,
    goal: meta.goal,
    roles: new Map(roles.map(r => [r.name, r])),
    roleStates: new Map(),
    decisionMaker,
    status: 'waiting_human',
    round: meta.round || 0,
    maxRounds: meta.maxRounds || 20,
    costUsd: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    messageHistory: [],
    uiMessages: [],          // will be loaded from messages.json
    humanMessageQueue: [],
    waitingHumanContext: null,
    pendingRoute: null,
    userId: userId || meta.userId,
    username: username || meta.username,
    createdAt: meta.createdAt || Date.now()
  };
  crewSessions.set(sessionId, session);

  // 加载 UI 消息历史
  session.uiMessages = await loadSessionMessages(session.sharedDir);

  // 通知 server
  sendCrewMessage({
    type: 'crew_session_restored',
    sessionId,
    projectDir: session.projectDir,
    sharedDir: session.sharedDir,
    goal: session.goal,
    roles: roles.map(r => ({
      name: r.name, displayName: r.displayName, icon: r.icon,
      description: r.description, isDecisionMaker: r.isDecisionMaker || false
    })),
    decisionMaker,
    maxRounds: session.maxRounds,
    userId: session.userId,
    username: session.username,
    uiMessages: session.uiMessages
  });
  sendStatusUpdate(session);

  // 更新索引和 session.json
  await upsertCrewIndex(session);
  await saveSessionMeta(session);

  console.log(`[Crew] Session ${sessionId} resumed, waiting for human input`);
}

// =====================================================================
// Session Lifecycle
// =====================================================================

/**
 * 创建 Crew Session
 * 支持带角色创建或空 session（后续动态添加角色）
 */
export async function createCrewSession(msg) {
  const {
    sessionId,
    projectDir,
    sharedDir: sharedDirRel,
    goal,
    roles = [],     // [{ name, displayName, icon, description, claudeMd, model, budget, isDecisionMaker }]
    maxRounds = 20,
    userId,
    username
  } = msg;

  // 解析共享目录（相对路径相对于 projectDir）
  const sharedDir = sharedDirRel?.startsWith('/')
    ? sharedDirRel
    : join(projectDir, sharedDirRel || '.crew');

  // 初始化共享区
  await initSharedDir(sharedDir, goal, roles, projectDir);

  // 找到决策者
  const decisionMaker = roles.find(r => r.isDecisionMaker)?.name || roles[0]?.name || null;

  const session = {
    id: sessionId,
    projectDir,
    sharedDir,
    goal,
    roles: new Map(roles.map(r => [r.name, r])),
    roleStates: new Map(),
    decisionMaker,
    status: 'running',       // running | paused | waiting_human | completed | stopped
    round: 0,
    maxRounds,
    costUsd: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    messageHistory: [],      // 群聊消息历史
    uiMessages: [],          // 精简的 UI 消息历史（用于恢复时重放）
    humanMessageQueue: [],   // 人的消息排队
    waitingHumanContext: null, // { fromRole, reason, message }
    pendingRoute: null,       // { fromRole, route } — 暂停时未完成的路由
    userId,
    username,
    createdAt: Date.now()
  };

  crewSessions.set(sessionId, session);

  // 通知 server
  sendCrewMessage({
    type: 'crew_session_created',
    sessionId,
    projectDir,
    sharedDir,
    goal,
    roles: roles.map(r => ({
      name: r.name,
      displayName: r.displayName,
      icon: r.icon,
      description: r.description,
      isDecisionMaker: r.isDecisionMaker || false,
      model: r.model
    })),
    decisionMaker,
    maxRounds,
    userId,
    username
  });

  // 发送状态
  sendStatusUpdate(session);

  // 持久化到索引和 session.json
  await upsertCrewIndex(session);
  await saveSessionMeta(session);

  // 如果有预设角色，启动第一个
  if (roles.length > 0) {
    const firstRole = roles.find(r => r.name === 'pm') || roles[0];
    if (firstRole) {
      const initialPrompt = buildInitialTask(goal, firstRole, roles);
      await dispatchToRole(session, firstRole.name, initialPrompt, 'system');
    }
  }

  return session;
}

// =====================================================================
// Dynamic Role Management
// =====================================================================

/**
 * 向现有 session 动态添加角色
 */
export async function addRoleToSession(msg) {
  const { sessionId, role } = msg;
  const session = crewSessions.get(sessionId);
  if (!session) {
    console.warn(`[Crew] Session not found: ${sessionId}`);
    return;
  }

  if (session.roles.has(role.name)) {
    console.warn(`[Crew] Role already exists: ${role.name}`);
    return;
  }

  // 添加角色到 session
  session.roles.set(role.name, role);

  // 如果还没有决策者且新角色是决策者，更新
  if (role.isDecisionMaker) {
    session.decisionMaker = role.name;
  }
  // 如果没有任何决策者，第一个角色作为决策者
  if (!session.decisionMaker) {
    session.decisionMaker = role.name;
  }

  // 初始化角色目录（CLAUDE.md + memory.md）
  await initRoleDir(session.sharedDir, role);

  // 更新共享 CLAUDE.md（增量添加新角色信息）
  await updateSharedClaudeMd(session);

  console.log(`[Crew] Role added: ${role.name} (${role.displayName}) to session ${sessionId}`);

  // 通知 Web 端
  sendCrewMessage({
    type: 'crew_role_added',
    sessionId,
    role: {
      name: role.name,
      displayName: role.displayName,
      icon: role.icon,
      description: role.description,
      isDecisionMaker: role.isDecisionMaker || false,
      model: role.model
    },
    decisionMaker: session.decisionMaker
  });

  // 发送系统消息
  sendCrewOutput(session, 'system', 'system', {
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text: `${role.icon} ${role.displayName} 加入了群聊` }] }
  });

  sendStatusUpdate(session);
}

/**
 * 从 session 移除角色
 */
export async function removeRoleFromSession(msg) {
  const { sessionId, roleName } = msg;
  const session = crewSessions.get(sessionId);
  if (!session) {
    console.warn(`[Crew] Session not found: ${sessionId}`);
    return;
  }

  const role = session.roles.get(roleName);
  if (!role) {
    console.warn(`[Crew] Role not found: ${roleName}`);
    return;
  }

  // 停止角色的 query（如果正在运行）
  const roleState = session.roleStates.get(roleName);
  if (roleState) {
    // 保存 sessionId 到文件（以便未来恢复）
    if (roleState.claudeSessionId) {
      await saveRoleSessionId(session.sharedDir, roleName, roleState.claudeSessionId);
    }
    if (roleState.abortController) {
      roleState.abortController.abort();
    }
    session.roleStates.delete(roleName);
  }

  // 从 roles 中移除
  session.roles.delete(roleName);

  // 如果移除的是决策者，重新选择
  if (session.decisionMaker === roleName) {
    const remaining = Array.from(session.roles.values());
    const newDM = remaining.find(r => r.isDecisionMaker) || remaining[0];
    session.decisionMaker = newDM?.name || null;
  }

  // 更新 CLAUDE.md
  await updateSharedClaudeMd(session);

  // Memory 文件保留（不删除，角色可能重新加入）

  console.log(`[Crew] Role removed: ${roleName} from session ${sessionId}`);

  sendCrewMessage({
    type: 'crew_role_removed',
    sessionId,
    roleName,
    decisionMaker: session.decisionMaker
  });

  sendCrewOutput(session, 'system', 'system', {
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text: `${role.icon} ${role.displayName} 离开了群聊` }] }
  });

  sendStatusUpdate(session);
}

// =====================================================================
// Shared Directory & Memory
// =====================================================================

/**
 * 初始化共享目录
 * 结构:
 *   .crew/
 *   ├── CLAUDE.md         ← 共享级（团队目标、成员、共享记忆）
 *   ├── context/          ← 文档产出
 *   ├── sessions/         ← sessionId 持久化
 *   └── roles/
 *       └── {roleName}/
 *           └── CLAUDE.md ← 角色定义 + 个人记忆
 */
async function initSharedDir(sharedDir, goal, roles, projectDir) {
  await fs.mkdir(sharedDir, { recursive: true });
  await fs.mkdir(join(sharedDir, 'context'), { recursive: true });
  await fs.mkdir(join(sharedDir, 'sessions'), { recursive: true });
  await fs.mkdir(join(sharedDir, 'roles'), { recursive: true });

  // 初始化每个角色的目录
  for (const role of roles) {
    await initRoleDir(sharedDir, role);
  }

  // 生成 .crew/CLAUDE.md（共享级）
  await writeSharedClaudeMd(sharedDir, goal, roles, projectDir);
}

/**
 * 初始化角色目录: .crew/roles/{roleName}/CLAUDE.md
 */
async function initRoleDir(sharedDir, role) {
  const roleDir = join(sharedDir, 'roles', role.name);
  await fs.mkdir(roleDir, { recursive: true });

  // 角色 CLAUDE.md（仅首次创建，后续角色自己维护记忆内容）
  const claudeMdPath = join(roleDir, 'CLAUDE.md');
  try {
    await fs.access(claudeMdPath);
    // 已存在，不覆盖（保留角色自己写入的记忆）
  } catch {
    await writeRoleClaudeMd(sharedDir, role);
  }
}

/**
 * 写入 .crew/CLAUDE.md — 共享级（所有角色自动继承）
 * 记忆直接写在 CLAUDE.md 中，Claude Code 会自动加载
 */
async function writeSharedClaudeMd(sharedDir, goal, roles, projectDir) {
  const claudeMd = `# 项目目标
${goal}

# 项目代码路径
${projectDir}
所有代码操作请使用此绝对路径。

# 团队成员
${roles.length > 0 ? roles.map(r => `- ${r.icon} ${r.displayName}(${r.name}): ${r.description}${r.isDecisionMaker ? ' (决策者)' : ''}`).join('\n') : '_暂无成员_'}

# 工作约定
- 文档产出写入 context/ 目录
- 重要决策记录在 context/decisions.md
- 代码修改使用项目代码路径的绝对路径

# 共享记忆
_团队共同维护，记录重要的共识、决策和信息。_
`;

  await fs.writeFile(join(sharedDir, 'CLAUDE.md'), claudeMd);
}

/**
 * 写入 .crew/roles/{roleName}/CLAUDE.md — 角色级
 * 记忆直接追加在此文件中，Claude Code 自动加载
 */
async function writeRoleClaudeMd(sharedDir, role) {
  const roleDir = join(sharedDir, 'roles', role.name);

  const claudeMd = `# 角色: ${role.icon} ${role.displayName}
${role.claudeMd || role.description}

# 个人记忆
_在这里记录重要的信息、决策、进展和待办事项。_
`;

  await fs.writeFile(join(roleDir, 'CLAUDE.md'), claudeMd);
}

/**
 * 角色变动时更新 .crew/CLAUDE.md
 */
async function updateSharedClaudeMd(session) {
  const roles = Array.from(session.roles.values());
  await writeSharedClaudeMd(session.sharedDir, session.goal, roles, session.projectDir);
}

// =====================================================================
// Session Persistence
// =====================================================================

/**
 * 保存角色的 claudeSessionId 到文件
 */
async function saveRoleSessionId(sharedDir, roleName, claudeSessionId) {
  const sessionsDir = join(sharedDir, 'sessions');
  await fs.mkdir(sessionsDir, { recursive: true });
  const filePath = join(sessionsDir, `${roleName}.json`);
  await fs.writeFile(filePath, JSON.stringify({
    claudeSessionId,
    savedAt: Date.now()
  }));
  console.log(`[Crew] Saved sessionId for ${roleName}: ${claudeSessionId}`);
}

/**
 * 从文件加载角色的 claudeSessionId
 */
async function loadRoleSessionId(sharedDir, roleName) {
  const filePath = join(sharedDir, 'sessions', `${roleName}.json`);
  try {
    const data = JSON.parse(await fs.readFile(filePath, 'utf-8'));
    return data.claudeSessionId || null;
  } catch {
    return null;
  }
}

// =====================================================================
// Role Query Management
// =====================================================================

/**
 * 为角色创建持久 query 实例
 * 支持 resume：如果角色之前有保存的 sessionId，自动恢复上下文
 */
async function createRoleQuery(session, roleName) {
  const role = session.roles.get(roleName);
  if (!role) throw new Error(`Role not found: ${roleName}`);

  const inputStream = new Stream();
  const abortController = new AbortController();

  const systemPrompt = buildRoleSystemPrompt(role, session);

  // 尝试加载之前保存的 sessionId
  const savedSessionId = await loadRoleSessionId(session.sharedDir, roleName);

  // ★ cwd 设为角色目录，Claude Code 自动加载：
  //   1. .crew/roles/{roleName}/CLAUDE.md（角色定义+个人记忆）
  //   2. .crew/CLAUDE.md（共享目标+团队信息+共享记忆）
  //   3. {projectDir}/CLAUDE.md（项目级，如果有的话）
  const roleCwd = join(session.sharedDir, 'roles', roleName);

  const queryOptions = {
    cwd: roleCwd,
    permissionMode: 'bypassPermissions',
    abort: abortController.signal,
    model: role.model || undefined,
    appendSystemPrompt: systemPrompt
  };

  // 如果有保存的 sessionId，使用 resume 恢复上下文
  if (savedSessionId) {
    queryOptions.resume = savedSessionId;
    console.log(`[Crew] Resuming ${roleName} with sessionId: ${savedSessionId}`);
  }

  const roleQuery = query({
    prompt: inputStream,
    options: queryOptions
  });

  const roleState = {
    query: roleQuery,
    inputStream,
    abortController,
    accumulatedText: '',
    turnActive: false,
    claudeSessionId: savedSessionId
  };

  session.roleStates.set(roleName, roleState);

  // 异步处理角色输出
  processRoleOutput(session, roleName, roleQuery, roleState);

  return roleState;
}

/**
 * 构建角色的 system prompt（精简版）
 * Memory 和工作区信息已通过 CLAUDE.md 自动加载，此处只补充路由规则
 */
function buildRoleSystemPrompt(role, session) {
  const allRoles = Array.from(session.roles.values());
  const otherRoles = allRoles.filter(r => r.name !== role.name);

  let prompt = `# 团队协作
你正在一个 AI 团队中工作。项目目标是: ${session.goal}

团队成员:
${allRoles.map(r => `- ${r.icon} ${r.displayName}: ${r.description}${r.isDecisionMaker ? ' (决策者)' : ''}`).join('\n')}`;

  if (otherRoles.length > 0) {
    prompt += `\n\n# 路由规则
当你完成当前任务并需要将结果传递给其他角色时，在你的回复最末尾添加一个 ROUTE 块：

\`\`\`
---ROUTE---
to: <角色name>
summary: <简要说明要传递什么>
---END_ROUTE---
\`\`\`

可用的路由目标:
${otherRoles.map(r => `- ${r.name}: ${r.displayName}`).join('\n')}
- human: 人工（只在决策者也无法决定时使用）

注意：
- 如果你的工作还没完成，不需要添加 ROUTE 块
- 如果你遇到不确定的问题，@ 决策者 "${session.decisionMaker}"，而不是直接 @ human
- 如果你是决策者且遇到需要人类判断的问题，才 @ human
- 每次回复最多只能有一个 ROUTE 块
- ROUTE 块必须在回复的最末尾`;
  }

  // 决策者额外 prompt
  if (role.isDecisionMaker) {
    prompt += `\n\n# 决策者职责
你是团队的决策者。其他角色遇到不确定的情况会请求你的决策。
- 如果你有足够的信息做出决策，直接决定并 @相关角色执行
- 如果你需要更多信息，@具体角色请求补充
- 如果问题超出你的能力范围或需要业务判断，@human 请人类决定
- 你可以随时审查其他角色的工作并给出反馈

# 任务清单
你可以在回复中添加 TASKS 块来发布/更新任务清单，团队界面会自动展示：

\`\`\`
---TASKS---
- [ ] 任务描述 @角色name
- [x] 已完成的任务 @角色name
---END_TASKS---
\`\`\`

注意：
- 每行一个任务，[ ] 表示待办，[x] 表示已完成
- @角色name 标注负责人（可选）
- 后续回复中可更新 TASKS 块（标记完成的任务）
- TASKS 块不需要在回复最末尾，可以放在任意位置`;
  }

  return prompt;
}

/**
 * 构建初始任务 prompt
 */
function buildInitialTask(goal, firstRole, allRoles) {
  return `项目启动！

目标: ${goal}

你是第一个开始工作的角色。请分析目标，开始你的工作。
完成后，通过 ROUTE 块将结果传递给下一个合适的角色。

团队中可用的角色:
${allRoles.map(r => `- ${r.icon} ${r.name}: ${r.displayName} - ${r.description}`).join('\n')}`;
}

// =====================================================================
// Role Output Processing
// =====================================================================

/**
 * 处理角色的流式输出
 */
async function processRoleOutput(session, roleName, roleQuery, roleState) {
  try {
    for await (const message of roleQuery) {
      // 检查 session 是否已停止或暂停
      if (session.status === 'stopped' || session.status === 'paused') break;

      if (message.type === 'system' && message.subtype === 'init') {
        roleState.claudeSessionId = message.session_id;
        console.log(`[Crew] ${roleName} session: ${message.session_id}`);
        continue;
      }

      if (message.type === 'assistant') {
        // 转发流式输出到 Web
        sendCrewOutput(session, roleName, 'text', message);

        // 累积文本用于路由解析
        const content = message.message?.content;
        if (content) {
          if (typeof content === 'string') {
            roleState.accumulatedText += content;
          } else if (Array.isArray(content)) {
            for (const block of content) {
              if (block.type === 'text') {
                roleState.accumulatedText += block.text;
              } else if (block.type === 'tool_use') {
                // 转发 tool use + 记录当前工具
                roleState.currentTool = block.name;
                sendCrewOutput(session, roleName, 'tool_use', message);
              }
            }
          }
        }
      } else if (message.type === 'user') {
        // tool results — clear currentTool
        roleState.currentTool = null;
        sendCrewOutput(session, roleName, 'tool_result', message);
      } else if (message.type === 'result') {
        // ★ Turn 完成！
        console.log(`[Crew] ${roleName} turn completed`);

        // 结束 uiMessages 中最后一条的 streaming 标记
        const lastUi = session.uiMessages[session.uiMessages.length - 1];
        if (lastUi && lastUi._streaming) delete lastUi._streaming;

        // 更新费用
        if (message.total_cost_usd) {
          session.costUsd += message.total_cost_usd;
        }
        // 更新 token 用量
        if (message.usage) {
          session.totalInputTokens += message.usage.input_tokens || 0;
          session.totalOutputTokens += message.usage.output_tokens || 0;
        }

        // ★ 持久化 sessionId（每次 turn 完成后保存，用于后续 resume）
        if (roleState.claudeSessionId) {
          saveRoleSessionId(session.sharedDir, roleName, roleState.claudeSessionId)
            .catch(e => console.warn(`[Crew] Failed to save sessionId for ${roleName}:`, e.message));
        }

        // 解析路由
        const route = parseRoute(roleState.accumulatedText);
        roleState.accumulatedText = '';
        roleState.turnActive = false;

        // 通知 turn 完成
        sendCrewMessage({
          type: 'crew_turn_completed',
          sessionId: session.id,
          role: roleName
        });

        // 发送状态更新
        sendStatusUpdate(session);

        // 执行路由
        if (route) {
          await executeRoute(session, roleName, route);
        } else {
          // 没有路由，角色完成了当前工作但没有指定下一步
          // 检查是否有人的消息在排队
          await processHumanQueue(session);
        }
      }
    }
  } catch (error) {
    if (error.name === 'AbortError') {
      console.log(`[Crew] ${roleName} aborted`);
      // 暂停时：检查已累积的文本中是否有 route，保存为 pendingRoute
      if (session.status === 'paused' && roleState.accumulatedText) {
        const route = parseRoute(roleState.accumulatedText);
        if (route && !session.pendingRoute) {
          session.pendingRoute = { fromRole: roleName, route };
          console.log(`[Crew] Saved pending route from aborted ${roleName}: -> ${route.to}`);
        }
        roleState.accumulatedText = '';
      }
    } else {
      console.error(`[Crew] ${roleName} error:`, error.message);
      // 通知决策者
      if (roleName !== session.decisionMaker) {
        const errorMsg = `角色 ${roleName} 发生错误: ${error.message}`;
        await dispatchToRole(session, session.decisionMaker, errorMsg, roleName);
      } else {
        // 决策者自己出错了，通知人
        sendCrewMessage({
          type: 'crew_human_needed',
          sessionId: session.id,
          fromRole: roleName,
          reason: 'error',
          message: `决策者 ${roleName} 发生错误: ${error.message}`
        });
        session.status = 'waiting_human';
        sendStatusUpdate(session);
      }
    }
  }
}

// =====================================================================
// Route Parsing & Execution
// =====================================================================

/**
 * 从累积文本中解析 ROUTE 块
 */
function parseRoute(text) {
  // 主格式
  const match = text.match(/---ROUTE---\s*\n\s*to:\s*(.+?)\s*\n\s*summary:\s*(.+?)\s*\n\s*---END_ROUTE---/s);
  if (match) {
    return {
      to: match[1].trim().toLowerCase(),
      summary: match[2].trim()
    };
  }

  // 备用格式（更宽松）
  const altMatch = text.match(/---ROUTE---\s*\n([\s\S]*?)---END_ROUTE---/);
  if (altMatch) {
    const block = altMatch[1];
    const toMatch = block.match(/to:\s*(.+)/i);
    const summaryMatch = block.match(/summary:\s*(.+)/i);
    if (toMatch) {
      return {
        to: toMatch[1].trim().toLowerCase(),
        summary: summaryMatch ? summaryMatch[1].trim() : ''
      };
    }
  }

  return null;
}

/**
 * 执行路由
 */
async function executeRoute(session, fromRole, route) {
  const { to, summary } = route;

  // 增加轮次计数
  session.round++;

  // 检查最大轮次
  if (session.round >= session.maxRounds) {
    console.log(`[Crew] Max rounds (${session.maxRounds}) reached`);
    session.status = 'completed';
    sendCrewMessage({
      type: 'crew_status',
      sessionId: session.id,
      status: 'max_rounds_reached',
      round: session.round,
      maxRounds: session.maxRounds
    });
    sendStatusUpdate(session);
    return;
  }

  // 如果 session 已暂停或停止，保存 pendingRoute 等恢复时重放
  if (session.status === 'paused' || session.status === 'stopped') {
    session.pendingRoute = { fromRole, route };
    console.log(`[Crew] Session ${session.status}, route saved as pending: ${fromRole} -> ${to}`);
    return;
  }

  // 发送路由消息（UI 显示 → @xxx）
  sendCrewOutput(session, fromRole, 'route', null, { routeTo: to, routeSummary: summary });

  // 路由到 human
  if (to === 'human') {
    session.status = 'waiting_human';
    session.waitingHumanContext = {
      fromRole,
      reason: 'requested',
      message: summary
    };
    sendCrewMessage({
      type: 'crew_human_needed',
      sessionId: session.id,
      fromRole,
      reason: 'requested',
      message: summary
    });
    sendStatusUpdate(session);
    return;
  }

  // 路由到指定角色
  if (session.roles.has(to)) {
    // 先检查是否有人的消息在排队
    if (session.humanMessageQueue.length > 0) {
      // 人的消息优先
      await processHumanQueue(session);
    } else {
      const taskPrompt = buildRoutePrompt(fromRole, summary, session);
      await dispatchToRole(session, to, taskPrompt, fromRole);
    }
  } else {
    console.warn(`[Crew] Unknown route target: ${to}`);
    // 转给决策者
    const errorMsg = `路由目标 "${to}" 不存在。来自 ${fromRole} 的消息: ${summary}`;
    await dispatchToRole(session, session.decisionMaker, errorMsg, 'system');
  }
}

/**
 * 构建路由转发的 prompt
 */
function buildRoutePrompt(fromRole, summary, session) {
  const fromRoleConfig = session.roles.get(fromRole);
  const fromName = fromRoleConfig ? `${fromRoleConfig.icon} ${fromRoleConfig.displayName}` : fromRole;
  return `来自 ${fromName} 的消息:\n${summary}\n\n请开始你的工作。完成后通过 ROUTE 块传递给下一个角色。`;
}

// =====================================================================
// Message Dispatching
// =====================================================================

/**
 * 向角色发送消息
 */
async function dispatchToRole(session, roleName, content, fromSource) {
  if (session.status === 'paused' || session.status === 'stopped') {
    console.log(`[Crew] Session ${session.status}, skipping dispatch to ${roleName}`);
    return;
  }

  let roleState = session.roleStates.get(roleName);

  // 如果角色没有 query 实例，创建一个（支持 resume）
  if (!roleState || !roleState.query || !roleState.inputStream) {
    roleState = await createRoleQuery(session, roleName);
  }

  // 记录消息历史
  session.messageHistory.push({
    from: fromSource,
    to: roleName,
    content: typeof content === 'string' ? content.substring(0, 200) : '...',
    timestamp: Date.now()
  });

  // 发送
  roleState.turnActive = true;
  roleState.accumulatedText = '';
  roleState.inputStream.enqueue({
    type: 'user',
    message: { role: 'user', content }
  });

  console.log(`[Crew] Dispatched to ${roleName} from ${fromSource}`);
}

// =====================================================================
// Human Interaction
// =====================================================================

/**
 * 处理人的输入
 */
export async function handleCrewHumanInput(msg) {
  const { sessionId, content, targetRole } = msg;
  const session = crewSessions.get(sessionId);
  if (!session) {
    console.warn(`[Crew] Session not found: ${sessionId}`);
    return;
  }

  // 注意：不在这里发送人的消息到 Web（前端已本地添加，避免重复）
  // 但需要记录到 uiMessages 用于恢复时重放
  session.uiMessages.push({
    role: 'human', roleIcon: 'H', roleName: '你',
    type: 'text', content,
    timestamp: Date.now()
  });

  // 如果在等待人工介入
  if (session.status === 'waiting_human') {
    const waitingContext = session.waitingHumanContext;
    session.status = 'running';
    session.waitingHumanContext = null;
    sendStatusUpdate(session);

    // 发给请求人工介入的角色，或指定的目标角色
    const target = targetRole || waitingContext?.fromRole || session.decisionMaker;
    const humanPrompt = `人工回复:\n${content}`;
    await dispatchToRole(session, target, humanPrompt, 'human');
    return;
  }

  // 解析 @role 指令
  const atMatch = content.match(/^@(\w+)\s*([\s\S]*)/);
  if (atMatch) {
    const target = atMatch[1].toLowerCase();
    const message = atMatch[2].trim() || content;

    if (session.roles.has(target)) {
      // 检查目标角色是否正在忙
      const targetState = session.roleStates.get(target);
      if (targetState?.turnActive) {
        // 排队
        session.humanMessageQueue.push({ target, content: message, timestamp: Date.now() });
        console.log(`[Crew] Human message queued for ${target} (busy)`);
        return;
      }
      const humanPrompt = `人工消息:\n${message}`;
      await dispatchToRole(session, target, humanPrompt, 'human');
      return;
    }
  }

  // 没有 @ 指定目标，发给决策者或当前活跃角色
  const activeRole = findActiveRole(session);
  const target = targetRole || activeRole || session.decisionMaker;

  // 检查目标是否忙
  const targetState = session.roleStates.get(target);
  if (targetState?.turnActive) {
    session.humanMessageQueue.push({ target, content, timestamp: Date.now() });
    console.log(`[Crew] Human message queued for ${target} (busy)`);
    return;
  }

  const humanPrompt = `人工消息:\n${content}`;
  await dispatchToRole(session, target, humanPrompt, 'human');
}

/**
 * 处理排队的人的消息
 */
async function processHumanQueue(session) {
  if (session.humanMessageQueue.length === 0) return;

  const msg = session.humanMessageQueue.shift();
  const humanPrompt = `人工消息:\n${msg.content}`;
  await dispatchToRole(session, msg.target, humanPrompt, 'human');
}

/**
 * 找到当前活跃的角色（最近一个 turnActive 的）
 */
function findActiveRole(session) {
  for (const [name, state] of session.roleStates) {
    if (state.turnActive) return name;
  }
  return null;
}

// =====================================================================
// Control Operations
// =====================================================================

/**
 * 处理控制命令
 */
export async function handleCrewControl(msg) {
  const { sessionId, action, targetRole } = msg;
  const session = crewSessions.get(sessionId);
  if (!session) {
    console.warn(`[Crew] Session not found: ${sessionId}`);
    return;
  }

  switch (action) {
    case 'pause':
      await pauseAll(session);
      break;
    case 'resume':
      await resumeSession(session);
      break;
    case 'stop_role':
      if (targetRole) await stopRole(session, targetRole);
      break;
    case 'stop_all':
      await stopAll(session);
      break;
    default:
      console.warn(`[Crew] Unknown control action: ${action}`);
  }
}

/**
 * 暂停所有角色
 * abort 运行中的 query 并保存 sessionId，恢复时 resume
 */
async function pauseAll(session) {
  session.status = 'paused';

  // abort 所有运行中的角色，保存 sessionId 以便 resume
  for (const [roleName, roleState] of session.roleStates) {
    if (roleState.claudeSessionId) {
      await saveRoleSessionId(session.sharedDir, roleName, roleState.claudeSessionId)
        .catch(e => console.warn(`[Crew] Failed to save sessionId for ${roleName}:`, e.message));
    }
    if (roleState.abortController) {
      roleState.abortController.abort();
    }
    // 记录哪些角色在暂停时正在工作
    roleState.wasActive = roleState.turnActive;
    roleState.turnActive = false;
    roleState.query = null;
    roleState.inputStream = null;
  }

  console.log(`[Crew] Session ${session.id} paused, all active queries aborted`);

  sendCrewOutput(session, 'system', 'system', {
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text: 'Session 已暂停' }] }
  });
  sendStatusUpdate(session);
}

/**
 * 恢复 session
 * 重新执行被暂停时保存的 pendingRoute
 */
async function resumeSession(session) {
  if (session.status !== 'paused') return;

  session.status = 'running';
  console.log(`[Crew] Session ${session.id} resumed`);

  sendCrewOutput(session, 'system', 'system', {
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text: 'Session 已恢复' }] }
  });
  sendStatusUpdate(session);

  // 恢复被中断的路由
  if (session.pendingRoute) {
    const { fromRole, route } = session.pendingRoute;
    session.pendingRoute = null;
    console.log(`[Crew] Replaying pending route: ${fromRole} -> ${route.to}`);
    await executeRoute(session, fromRole, route);
    return;
  }

  // 没有 pendingRoute，检查排队的人的消息
  await processHumanQueue(session);
}

/**
 * 停止单个角色
 */
async function stopRole(session, roleName) {
  const roleState = session.roleStates.get(roleName);
  if (roleState) {
    // 保存 sessionId
    if (roleState.claudeSessionId) {
      await saveRoleSessionId(session.sharedDir, roleName, roleState.claudeSessionId)
        .catch(e => console.warn(`[Crew] Failed to save sessionId for ${roleName}:`, e.message));
    }
    if (roleState.abortController) {
      roleState.abortController.abort();
    }
    roleState.query = null;
    roleState.inputStream = null;
    roleState.turnActive = false;
    session.roleStates.delete(roleName);
  }

  sendCrewOutput(session, 'system', 'system', {
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text: `${roleName} 已停止` }] }
  });
  sendStatusUpdate(session);
  console.log(`[Crew] Role ${roleName} stopped`);
}

/**
 * 终止整个 session
 */
async function stopAll(session) {
  session.status = 'stopped';

  // 保存所有角色的 sessionId
  for (const [roleName, roleState] of session.roleStates) {
    if (roleState.claudeSessionId) {
      await saveRoleSessionId(session.sharedDir, roleName, roleState.claudeSessionId)
        .catch(e => console.warn(`[Crew] Failed to save sessionId for ${roleName}:`, e.message));
    }
    if (roleState.abortController) {
      roleState.abortController.abort();
    }
    console.log(`[Crew] Stopping role: ${roleName}`);
  }
  session.roleStates.clear();

  sendCrewOutput(session, 'system', 'system', {
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text: 'Session 已终止' }] }
  });
  sendStatusUpdate(session);

  // 从活跃 sessions 中移除
  crewSessions.delete(session.id);
  console.log(`[Crew] Session ${session.id} stopped`);
}

// =====================================================================
// Message Helpers
// =====================================================================

/**
 * 发送 crew 消息到 server（透传到 Web）
 */
function sendCrewMessage(msg) {
  if (ctx.sendToServer) {
    ctx.sendToServer(msg);
  }
}

/**
 * 发送角色输出到 Web
 */
function sendCrewOutput(session, roleName, outputType, rawMessage, extra = {}) {
  const role = session.roles.get(roleName);
  const roleIcon = role?.icon || (roleName === 'human' ? 'H' : roleName === 'system' ? 'S' : 'A');
  const displayName = role?.displayName || roleName;

  sendCrewMessage({
    type: 'crew_output',
    sessionId: session.id,
    role: roleName,
    roleIcon,
    roleName: displayName,
    outputType,  // 'text' | 'tool_use' | 'tool_result' | 'route' | 'system'
    data: rawMessage,
    ...extra
  });

  // ★ 记录精简 UI 消息用于恢复（跳过 tool_use/tool_result，只记录可见内容）
  if (outputType === 'text') {
    const content = rawMessage?.message?.content;
    let text = '';
    if (typeof content === 'string') {
      text = content;
    } else if (Array.isArray(content)) {
      text = content.filter(b => b.type === 'text').map(b => b.text).join('');
    }
    if (!text) return;
    // 合并同一角色的连续文本
    const last = session.uiMessages[session.uiMessages.length - 1];
    if (last && last.role === roleName && last.type === 'text' && last._streaming) {
      last.content += text;
    } else {
      session.uiMessages.push({
        role: roleName, roleIcon, roleName: displayName,
        type: 'text', content: text, _streaming: true,
        timestamp: Date.now()
      });
    }
  } else if (outputType === 'route') {
    // 结束前一条消息的 streaming
    const last = session.uiMessages[session.uiMessages.length - 1];
    if (last && last._streaming) delete last._streaming;
    session.uiMessages.push({
      role: roleName, roleIcon, roleName: displayName,
      type: 'route', routeTo: extra.routeTo,
      content: `→ @${extra.routeTo} ${extra.routeSummary || ''}`,
      timestamp: Date.now()
    });
  } else if (outputType === 'system') {
    const content = rawMessage?.message?.content;
    let text = '';
    if (typeof content === 'string') {
      text = content;
    } else if (Array.isArray(content)) {
      text = content.filter(b => b.type === 'text').map(b => b.text).join('');
    }
    if (!text) return;
    session.uiMessages.push({
      role: roleName, roleIcon, roleName: displayName,
      type: 'system', content: text,
      timestamp: Date.now()
    });
  }
  // tool_use 和 tool_result 不记录（太大，恢复时不需要）
}

/**
 * 发送 session 状态更新
 */
function sendStatusUpdate(session) {
  const currentRole = findActiveRole(session);

  sendCrewMessage({
    type: 'crew_status',
    sessionId: session.id,
    status: session.status,
    currentRole,
    round: session.round,
    maxRounds: session.maxRounds,
    costUsd: session.costUsd,
    totalInputTokens: session.totalInputTokens,
    totalOutputTokens: session.totalOutputTokens,
    roles: Array.from(session.roles.values()).map(r => ({
      name: r.name,
      displayName: r.displayName,
      icon: r.icon,
      description: r.description,
      isDecisionMaker: r.isDecisionMaker || false,
      model: r.model
    })),
    activeRoles: Array.from(session.roleStates.entries())
      .filter(([, s]) => s.turnActive)
      .map(([name]) => name),
    currentToolByRole: Object.fromEntries(
      Array.from(session.roleStates.entries())
        .filter(([, s]) => s.turnActive && s.currentTool)
        .map(([name, s]) => [name, s.currentTool])
    )
  });

  // 异步更新持久化
  upsertCrewIndex(session).catch(e => console.warn('[Crew] Failed to update index:', e.message));
  saveSessionMeta(session).catch(e => console.warn('[Crew] Failed to save session meta:', e.message));
}
