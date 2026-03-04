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
import { execFile as execFileCb } from 'child_process';
import { promisify } from 'util';
import ctx from './context.js';

const execFile = promisify(execFileCb);

/** Format role label: "icon displayName" or just "displayName" if no icon */
function roleLabel(r) {
  return r.icon ? `${r.icon} ${r.displayName}` : r.displayName;
}

// =====================================================================
// Data Structures
// =====================================================================

/** @type {Map<string, CrewSession>} */
const crewSessions = new Map();

// 导出供 connection.js / conversation.js 使用
export { crewSessions };

// =====================================================================
// Role Multi-Instance Expansion
// =====================================================================

// 短前缀映射：用于 count > 1 时生成实例名
const SHORT_PREFIX = {
  developer: 'dev',
  tester: 'test',
  reviewer: 'rev'
};

// 只有执行者角色支持多实例
const EXPANDABLE_ROLES = new Set(['developer', 'tester', 'reviewer']);

/**
 * 展开角色列表：count > 1 的执行者角色展开为多个实例
 * count === 1 或管理者角色保持原样（向后兼容）
 *
 * @param {Array} roles - 原始角色配置
 * @returns {Array} 展开后的角色列表
 */
function expandRoles(roles) {
  // 找到 developer 的 count，reviewer/tester 自动跟随
  const devRole = roles.find(r => r.name === 'developer');
  const devCount = devRole?.count > 1 ? devRole.count : 1;

  const expanded = [];
  for (const role of roles) {
    const isExpandable = EXPANDABLE_ROLES.has(role.name);
    // reviewer/tester 跟随 developer 的 count
    const count = isExpandable ? devCount : 1;

    if (count <= 1 || !isExpandable) {
      // 单实例：保持原样，添加元数据
      expanded.push({
        ...role,
        roleType: role.name,
        groupIndex: 0
      });
    } else {
      // 多实例展开
      const prefix = SHORT_PREFIX[role.name] || role.name;
      for (let i = 1; i <= count; i++) {
        expanded.push({
          ...role,
          name: `${prefix}-${i}`,
          displayName: `${role.displayName}-${i}`,
          roleType: role.name,
          groupIndex: i,
          count: undefined  // 展开后不再需要 count
        });
      }
    }
  }
  return expanded;
}

// =====================================================================
// Git Worktree Management
// =====================================================================

/**
 * 为多实例开发组创建 git worktree
 * 每个 groupIndex 对应一个 worktree，同组的 dev/rev/test 共享
 * count=1 时不创建（向后兼容）
 *
 * @param {string} projectDir - 主项目目录
 * @param {Array} roles - 展开后的角色列表
 * @returns {Map<number, string>} groupIndex → worktree 路径
 */
async function initWorktrees(projectDir, roles) {
  const groupIndices = [...new Set(roles.filter(r => r.groupIndex > 0).map(r => r.groupIndex))];
  if (groupIndices.length === 0) return new Map();

  const worktreeBase = join(projectDir, '.worktrees');
  await fs.mkdir(worktreeBase, { recursive: true });

  // 获取 git 已知的 worktree 列表
  let knownWorktrees = new Set();
  try {
    const { stdout } = await execFile('git', ['worktree', 'list', '--porcelain'], { cwd: projectDir });
    for (const line of stdout.split('\n')) {
      if (line.startsWith('worktree ')) {
        knownWorktrees.add(line.slice('worktree '.length).trim());
      }
    }
  } catch {
    // git worktree list 失败，视为空集
  }

  const worktreeMap = new Map();

  for (const idx of groupIndices) {
    const wtDir = join(worktreeBase, `dev-${idx}`);
    const branch = `crew/dev-${idx}`;

    // 检查目录是否存在
    let dirExists = false;
    try {
      await fs.access(wtDir);
      dirExists = true;
    } catch {}

    if (dirExists) {
      if (knownWorktrees.has(wtDir)) {
        // 目录存在且 git 记录中也有，直接复用
        console.log(`[Crew] Worktree already exists: ${wtDir}`);
        worktreeMap.set(idx, wtDir);
        continue;
      } else {
        // 孤立目录：目录存在但 git 不认识，先删除再重建
        console.warn(`[Crew] Orphaned worktree dir, removing: ${wtDir}`);
        await fs.rm(wtDir, { recursive: true, force: true }).catch(() => {});
      }
    }

    try {
      // 创建分支（如果不存在）
      try {
        await execFile('git', ['branch', branch], { cwd: projectDir });
      } catch {
        // 分支已存在，忽略
      }

      // 创建 worktree
      await execFile('git', ['worktree', 'add', wtDir, branch], { cwd: projectDir });
      console.log(`[Crew] Created worktree: ${wtDir} on branch ${branch}`);
      worktreeMap.set(idx, wtDir);
    } catch (e) {
      console.error(`[Crew] Failed to create worktree for group ${idx}:`, e.message);
    }
  }

  return worktreeMap;
}

/**
 * 清理 session 的 git worktrees
 * @param {string} projectDir - 主项目目录
 */
async function cleanupWorktrees(projectDir) {
  const worktreeBase = join(projectDir, '.worktrees');

  try {
    await fs.access(worktreeBase);
  } catch {
    return; // .worktrees 目录不存在，无需清理
  }

  try {
    const entries = await fs.readdir(worktreeBase);
    for (const entry of entries) {
      if (!entry.startsWith('dev-')) continue;
      const wtDir = join(worktreeBase, entry);
      const branch = `crew/${entry}`;

      try {
        await execFile('git', ['worktree', 'remove', wtDir, '--force'], { cwd: projectDir });
        console.log(`[Crew] Removed worktree: ${wtDir}`);
      } catch (e) {
        console.warn(`[Crew] Failed to remove worktree ${wtDir}:`, e.message);
      }

      try {
        await execFile('git', ['branch', '-D', branch], { cwd: projectDir });
        console.log(`[Crew] Deleted branch: ${branch}`);
      } catch (e) {
        console.warn(`[Crew] Failed to delete branch ${branch}:`, e.message);
      }
    }

    // 尝试删除 .worktrees 目录（如果已空）
    try {
      await fs.rmdir(worktreeBase);
    } catch {
      // 目录不空或其他原因，忽略
    }
  } catch (e) {
    console.error(`[Crew] Failed to cleanup worktrees:`, e.message);
  }
}

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
    name: session.name || '',
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
  const entry = index.find(e => e.sessionId === sessionId);
  const filtered = index.filter(e => e.sessionId !== sessionId);
  if (filtered.length !== index.length) {
    await saveCrewIndex(filtered);
    console.log(`[Crew] Removed session ${sessionId} from index`);
  }
  // 从内存中也移除（防止 sendConversationList 重新加入）
  if (crewSessions.has(sessionId)) {
    crewSessions.delete(sessionId);
    console.log(`[Crew] Removed session ${sessionId} from active sessions`);
  }
  // 删除磁盘上的 session 数据文件
  const sharedDir = entry?.sharedDir;
  if (sharedDir) {
    try {
      for (const file of ['session.json', 'messages.json']) {
        await fs.unlink(join(sharedDir, file)).catch(() => {});
      }
      console.log(`[Crew] Cleaned session files in ${sharedDir}`);
    } catch (e) {
      console.warn(`[Crew] Failed to clean session files:`, e.message);
    }
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
    name: session.name || '',
    sharedKnowledge: session.sharedKnowledge || '',
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
    username: session.username,
    costUsd: session.costUsd,
    totalInputTokens: session.totalInputTokens,
    totalOutputTokens: session.totalOutputTokens
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
    // 发送前清理 _streaming 标记（跟磁盘保存逻辑保持一致）
    const cleanedMessages = (session.uiMessages || []).map(m => {
      const { _streaming, ...rest } = m;
      return rest;
    });

    sendCrewMessage({
      type: 'crew_session_restored',
      sessionId,
      projectDir: session.projectDir,
      sharedDir: session.sharedDir,
      goal: session.goal,
      name: session.name || '',
      sharedKnowledge: session.sharedKnowledge || '',
      roles: roles.map(r => ({
        name: r.name, displayName: r.displayName, icon: r.icon,
        description: r.description, isDecisionMaker: r.isDecisionMaker || false
      })),
      decisionMaker: session.decisionMaker,
      maxRounds: session.maxRounds,
      userId: session.userId,
      username: session.username,
      uiMessages: cleanedMessages
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
    name: meta.name || '',
    sharedKnowledge: meta.sharedKnowledge || '',
    roles: new Map(roles.map(r => [r.name, r])),
    roleStates: new Map(),
    decisionMaker,
    status: 'waiting_human',
    round: meta.round || 0,
    maxRounds: meta.maxRounds || 20,
    costUsd: meta.costUsd || 0,
    totalInputTokens: meta.totalInputTokens || 0,
    totalOutputTokens: meta.totalOutputTokens || 0,
    messageHistory: [],
    uiMessages: [],          // will be loaded from messages.json
    humanMessageQueue: [],
    waitingHumanContext: null,
    pendingRoutes: [],
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
    name: session.name || '',
    sharedKnowledge: session.sharedKnowledge || '',
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
    name,
    sharedKnowledge,
    roles: rawRoles = [],     // [{ name, displayName, icon, description, claudeMd, model, budget, isDecisionMaker, count }]
    maxRounds = 20,
    userId,
    username
  } = msg;

  // 展开多实例角色（count > 1 的执行者角色）
  const roles = expandRoles(rawRoles);

  // 解析共享目录（相对路径相对于 projectDir）
  const sharedDir = sharedDirRel?.startsWith('/')
    ? sharedDirRel
    : join(projectDir, sharedDirRel || '.crew');

  // 初始化共享区
  await initSharedDir(sharedDir, goal, roles, projectDir, sharedKnowledge);

  // 初始化 git worktrees（仅多实例时）
  const worktreeMap = await initWorktrees(projectDir, roles);
  // 回填 workDir：同组的 dev-N/rev-N/test-N 共享同一个 worktree
  for (const role of roles) {
    if (role.groupIndex > 0 && worktreeMap.has(role.groupIndex)) {
      role.workDir = worktreeMap.get(role.groupIndex);
      // 重新写入 CLAUDE.md（加入工作目录信息）
      await writeRoleClaudeMd(sharedDir, role);
    }
  }

  // 找到决策者
  const decisionMaker = roles.find(r => r.isDecisionMaker)?.name || roles[0]?.name || null;

  const session = {
    id: sessionId,
    projectDir,
    sharedDir,
    goal,
    name: name || '',
    sharedKnowledge: sharedKnowledge || '',
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
    pendingRoutes: [],        // [{ fromRole, route }] — 暂停时未完成的路由
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
    name: name || '',
    sharedKnowledge: sharedKnowledge || '',
    roles: roles.map(r => ({
      name: r.name,
      displayName: r.displayName,
      icon: r.icon,
      description: r.description,
      isDecisionMaker: r.isDecisionMaker || false,
      model: r.model,
      roleType: r.roleType,
      groupIndex: r.groupIndex
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

  // 如果有目标，自动启动第一个角色；否则等待用户输入
  if (goal && roles.length > 0) {
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

  // 展开多实例（count > 1 时）
  const rolesToAdd = expandRoles([role]);

  for (const r of rolesToAdd) {
    if (session.roles.has(r.name)) {
      console.warn(`[Crew] Role already exists: ${r.name}`);
      continue;
    }

    // 添加角色到 session
    session.roles.set(r.name, r);

    // 如果还没有决策者且新角色是决策者，更新
    if (r.isDecisionMaker) {
      session.decisionMaker = r.name;
    }
    // 如果没有任何决策者，第一个角色作为决策者
    if (!session.decisionMaker) {
      session.decisionMaker = r.name;
    }

    // 初始化角色目录（CLAUDE.md + memory.md）
    await initRoleDir(session.sharedDir, r);

    console.log(`[Crew] Role added: ${r.name} (${r.displayName}) to session ${sessionId}`);

    // 通知 Web 端
    sendCrewMessage({
      type: 'crew_role_added',
      sessionId,
      role: {
        name: r.name,
        displayName: r.displayName,
        icon: r.icon,
        description: r.description,
        isDecisionMaker: r.isDecisionMaker || false,
        model: r.model,
        roleType: r.roleType,
        groupIndex: r.groupIndex
      },
      decisionMaker: session.decisionMaker
    });

    // 发送系统消息
    sendCrewOutput(session, 'system', 'system', {
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: `${roleLabel(r)} 加入了群聊` }] }
    });
  }

  // 更新共享 CLAUDE.md（增量添加新角色信息）
  await updateSharedClaudeMd(session);

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
    message: { role: 'assistant', content: [{ type: 'text', text: `${roleLabel(role)} 离开了群聊` }] }
  });

  sendStatusUpdate(session);
}

/**
 * 更新 crew session 的 name 和 sharedKnowledge
 */
export async function handleUpdateCrewSession(msg) {
  const { sessionId, name, sharedKnowledge } = msg;
  const session = crewSessions.get(sessionId);
  if (!session) {
    console.warn(`[Crew] Session not found for update: ${sessionId}`);
    return;
  }
  if (name !== undefined) session.name = name;
  if (sharedKnowledge !== undefined) session.sharedKnowledge = sharedKnowledge;
  await updateSharedClaudeMd(session);
  await saveSessionMeta(session);
  await upsertCrewIndex(session);
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
async function initSharedDir(sharedDir, goal, roles, projectDir, sharedKnowledge = '') {
  await fs.mkdir(sharedDir, { recursive: true });
  await fs.mkdir(join(sharedDir, 'context'), { recursive: true });
  await fs.mkdir(join(sharedDir, 'sessions'), { recursive: true });
  await fs.mkdir(join(sharedDir, 'roles'), { recursive: true });

  // 初始化每个角色的目录
  for (const role of roles) {
    await initRoleDir(sharedDir, role);
  }

  // 生成 .crew/CLAUDE.md（共享级）
  await writeSharedClaudeMd(sharedDir, goal, roles, projectDir, sharedKnowledge);
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
async function writeSharedClaudeMd(sharedDir, goal, roles, projectDir, sharedKnowledge = '') {
  const sharedMemoryContent = sharedKnowledge
    ? `# 共享记忆\n${sharedKnowledge}\n`
    : `# 共享记忆\n_团队共同维护，记录重要的共识、决策和信息。_\n`;

  const claudeMd = `# 项目目标
${goal}

# 项目代码路径
${projectDir}
所有代码操作请使用此绝对路径。

# 团队成员
${roles.length > 0 ? roles.map(r => `- ${roleLabel(r)}(${r.name}): ${r.description}${r.isDecisionMaker ? ' (决策者)' : ''}`).join('\n') : '_暂无成员_'}

# 工作约定
- 文档产出写入 context/ 目录
- 重要决策记录在 context/decisions.md
- 代码修改使用项目代码路径的绝对路径

# 卡住上报规则
当你遇到以下情况时，不要自己空转或反复重试，立即 ROUTE 给 PM（pm）请求协调：
1. 缺少前置依赖（如需要的文件、目录、代码不存在）
2. 等待其他角色的产出但迟迟没有收到
3. 任务描述不清楚或有歧义，无法判断正确做法
4. 遇到超出自己职责范围的问题
5. 连续尝试5次相同操作仍然失败
上报时请说明：你在做什么任务、卡在哪里、你认为需要谁来协助。

# Worktree 隔离规则
- 多实例模式下，每个开发组（dev-N/rev-N/test-N）在独立的 git worktree 中工作
- 每个角色必须在自己的 worktree 路径下操作代码，绝对不要操作项目主目录
- 绝对禁止在其他开发组的 branch 或 worktree 中操作代码
- 代码完成并通过 review 后，dev 自己提 PR 合并到 main 分支
- PM 不做 cherry-pick，只负责打 tag
- 合并完成后清理旧的 worktree
- 每次新任务/新 feature 必须基于最新的 main 分支创建新的 worktree，确保在最新代码上开发
- 禁止复用旧的 worktree 开发新任务，因为旧 worktree 的代码基线可能已过时

${sharedMemoryContent}`;

  await fs.writeFile(join(sharedDir, 'CLAUDE.md'), claudeMd);
}

/**
 * 写入 .crew/roles/{roleName}/CLAUDE.md — 角色级
 * 记忆直接追加在此文件中，Claude Code 自动加载
 */
async function writeRoleClaudeMd(sharedDir, role) {
  const roleDir = join(sharedDir, 'roles', role.name);

  let claudeMd = `# 角色: ${roleLabel(role)}
${role.claudeMd || role.description}
`;

  // 有独立 worktree 的角色，覆盖代码工作目录
  if (role.workDir) {
    claudeMd += `
# 代码工作目录（重要！）
${role.workDir}
所有代码操作必须在此 worktree 路径下进行。
绝对禁止直接操作项目主目录或其他组的 worktree，否则会覆盖其他开发组的修改。
代码完成并通过 review 后，自己提 PR 合并到 main。
此 worktree 仅用于当前任务，合并后会被清理，新任务会创建新的 worktree。
`;
  }

  claudeMd += `
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
  await writeSharedClaudeMd(session.sharedDir, session.goal, roles, session.projectDir, session.sharedKnowledge);
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

  // 按组裁剪路由目标：
  // - 有 groupIndex > 0 的执行者只看到同组成员 + 管理者（PM/architect/designer）
  // - 管理者（groupIndex === 0）看到所有角色
  let routeTargets;
  if (role.groupIndex > 0) {
    routeTargets = allRoles.filter(r =>
      r.name !== role.name && (r.groupIndex === role.groupIndex || r.groupIndex === 0)
    );
  } else {
    routeTargets = allRoles.filter(r => r.name !== role.name);
  }

  let prompt = `# 团队协作
你正在一个 AI 团队中工作。${session.goal ? `项目目标是: ${session.goal}` : '等待用户提出任务或问题。'}

团队成员:
${allRoles.map(r => `- ${roleLabel(r)}: ${r.description}${r.isDecisionMaker ? ' (决策者)' : ''}`).join('\n')}`;

  const hasMultiInstance = allRoles.some(r => r.groupIndex > 0);

  if (routeTargets.length > 0) {
    const multiRouteAllowed = role.isDecisionMaker && hasMultiInstance;
    prompt += `\n\n# 路由规则
当你完成当前任务并需要将结果传递给其他角色时，在你的回复最末尾添加一个 ROUTE 块：

\`\`\`
---ROUTE---
to: <角色name>
summary: <简要说明要传递什么>
---END_ROUTE---
\`\`\`

可用的路由目标:
${routeTargets.map(r => `- ${r.name}: ${roleLabel(r)} — ${r.description}`).join('\n')}
- human: 人工（只在决策者也无法决定时使用）

注意：
- 如果你的工作还没完成，不需要添加 ROUTE 块
- 如果你遇到不确定的问题，@ 决策者 "${session.decisionMaker}"，而不是直接 @ human
- 如果你是决策者且遇到需要人类判断的问题，才 @ human
${multiRouteAllowed ? '- 决策者可以一次发多个 ROUTE 块来并行分配任务' : '- 每次回复最多只能有一个 ROUTE 块'}
- ROUTE 块必须在回复的最末尾
- 当你的任务已完成且不需要其他角色继续时，ROUTE 回决策者 "${session.decisionMaker}" 做总结
- 在正文中可用 @角色name 提及某个角色（如 @developer），但这不会触发路由，仅供阅读`;
  }

  // 决策者额外 prompt
  if (role.isDecisionMaker) {

    prompt += `\n\n# 工具使用限制（绝对禁令）
你**绝对不能**使用以下工具修改任何文件：
- Edit 工具 — 禁止
- Write 工具 — 禁止
- NotebookEdit 工具 — 禁止

你**可以**使用的工具：
- Read — 读取文件内容
- Grep — 搜索代码
- Glob — 查找文件
- Bash — 仅限 git 命令（git status/add/commit/push/tag/log/diff）和只读命令

如果你需要修改任何文件（无论多小的改动），必须 ROUTE 给 developer 执行。`;

    prompt += `\n\n# 决策者职责
你是团队的决策者。其他角色遇到不确定的情况会请求你的决策。
- 如果你有足够的信息做出决策，直接决定并 @相关角色执行
- 如果你需要更多信息，@具体角色请求补充
- 如果问题超出你的能力范围或需要业务判断，@human 请人类决定
- 你可以随时审查其他角色的工作并给出反馈
- PM 拥有 commit + push + tag 的自主权。只要修改没有大的 regression 影响（测试全通过），PM 可以自行决定 commit、push 和 tag，无需等待人工确认。只有当改动会直接影响对话交互逻辑时，才需要人工介入审核。`;

    // 多实例模式：注入开发组状态和调度规则
    if (hasMultiInstance) {
      // 构建开发组实时状态
      const maxGroup = Math.max(...allRoles.map(r => r.groupIndex));
      const groupLines = [];
      for (let g = 1; g <= maxGroup; g++) {
        const members = allRoles.filter(r => r.groupIndex === g);
        const memberStrs = members.map(r => {
          const state = session.roleStates.get(r.name);
          const busy = state?.turnActive;
          const task = state?.currentTask;
          if (busy && task) return `${r.name}(忙:${task.taskId} ${task.taskTitle})`;
          if (busy) return `${r.name}(忙)`;
          return `${r.name}(空闲)`;
        });
        groupLines.push(`组${g}: ${memberStrs.join(' ')}`);
      }

      prompt += `\n\n# 执行组状态
${groupLines.join(' / ')}

# 并行任务调度规则
你有 ${maxGroup} 个开发组可以并行工作。拆分任务时：
1. 每个子任务分配 task-id（如 task-1）和 taskTitle（如 "实现登录页面"）
2. 优先分配给**空闲**的开发组，避免给忙碌的 dev 发新任务
3. 一次可以发**多个 ROUTE 块**来并行分配任务：

\`\`\`
---ROUTE---
to: dev-1
task: task-1
taskTitle: 实现登录页面
summary: 请实现登录页面，包括表单验证和API调用
---END_ROUTE---

---ROUTE---
to: dev-2
task: task-2
taskTitle: 实现注册页面
summary: 请实现注册页面，包括邮箱验证
---END_ROUTE---
\`\`\`

4. 每个 dev 完成后会独立经过 reviewer 和 tester 审核，最后 ROUTE 回你
5. 等待**所有子任务完成**后再做汇总报告
6. **每次 ROUTE 都必须包含 task 和 taskTitle 字段，不能省略。没有 task 字段的 ROUTE 会导致消息无法按 feature 分组显示**`;
    }

    prompt += `\n
# 工作流终结点
团队的工作流有明确的结束条件。当以下任一条件满足时，你应该给出总结并结束当前工作流：
1. **代码已提交** - 所有代码修改已经 commit（如需要，可让 developer 执行 git commit）
2. **需要用户输入** - 遇到需要用户决定的问题时，@human 提出具体问题，等待用户回复
3. **任务完成** - 所有任务已完成，给出完成总结（列出完成了什么、变更了哪些文件、还有什么后续建议）

重要：不要无限循环地在角色之间传递。当工作实质性完成时，主动给出总结并结束。

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

  // 执行者角色的组绑定 prompt（count > 1 时）
  if (role.groupIndex > 0 && role.roleType === 'developer') {
    const gi = role.groupIndex;
    const rev = allRoles.find(r => r.roleType === 'reviewer' && r.groupIndex === gi);
    const test = allRoles.find(r => r.roleType === 'tester' && r.groupIndex === gi);
    if (rev && test) {
      prompt += `\n\n# 开发组绑定
你属于开发组 ${gi}。你的搭档：
- 审查者: ${roleLabel(rev)} (${rev.name})
- 测试: ${roleLabel(test)} (${test.name})

开发完成后，请同时发两个 ROUTE 块分别给 ${rev.name} 和 ${test.name}：

\`\`\`
---ROUTE---
to: ${rev.name}
summary: 请审查代码变更
---END_ROUTE---

---ROUTE---
to: ${test.name}
summary: 请测试功能
---END_ROUTE---
\`\`\`

两者会并行工作，各自完成后独立 ROUTE 回 PM。`;
    }
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
${allRoles.map(r => `- ${r.name}: ${roleLabel(r)} - ${r.description}`).join('\n')}`;
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
        // 累积文本用于路由解析
        const content = message.message?.content;
        if (content) {
          if (typeof content === 'string') {
            roleState.accumulatedText += content;
            // 转发流式文本到 Web
            sendCrewOutput(session, roleName, 'text', message);
          } else if (Array.isArray(content)) {
            let hasText = false;
            for (const block of content) {
              if (block.type === 'text') {
                roleState.accumulatedText += block.text;
                hasText = true;
              } else if (block.type === 'tool_use') {
                // ★ 修复5: tool_use 时结束该角色前一条 streaming 文本
                endRoleStreaming(session, roleName);
                roleState.currentTool = block.name;
                sendCrewOutput(session, roleName, 'tool_use', message);
              }
            }
            if (hasText) {
              sendCrewOutput(session, roleName, 'text', message);
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

        // ★ 修复2: 反向搜索该角色最后一条 streaming 消息并结束
        endRoleStreaming(session, roleName);

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

        // 解析路由（支持多 ROUTE 块）
        const routes = parseRoutes(roleState.accumulatedText);
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
        if (routes.length > 0) {
          // ★ 修复1: 多 ROUTE 只增 1 轮（round++ 从 executeRoute 移到这里）
          session.round++;

          // task 继承：如果路由没有指定 taskId，从当前角色继承
          const currentTask = roleState.currentTask;
          for (const route of routes) {
            if (!route.taskId && currentTask) {
              route.taskId = currentTask.taskId;
              route.taskTitle = currentTask.taskTitle;
            }
          }

          // 并行执行所有路由（allSettled 保证单个失败不中断其他）
          const results = await Promise.allSettled(routes.map(route =>
            executeRoute(session, roleName, route)
          ));
          for (const r of results) {
            if (r.status === 'rejected') {
              console.warn(`[Crew] Route execution failed:`, r.reason);
            }
          }
        } else {
          // 没有路由，检查是否有人的消息在排队
          await processHumanQueue(session);
        }
      }
    }
  } catch (error) {
    if (error.name === 'AbortError') {
      console.log(`[Crew] ${roleName} aborted`);
      // 暂停时：检查已累积的文本中是否有 route，保存为 pendingRoutes
      if (session.status === 'paused' && roleState.accumulatedText) {
        const routes = parseRoutes(roleState.accumulatedText);
        if (routes.length > 0 && session.pendingRoutes.length === 0) {
          session.pendingRoutes = routes.map(route => ({ fromRole: roleName, route }));
          console.log(`[Crew] Saved ${routes.length} pending route(s) from aborted ${roleName}`);
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

/**
 * 结束指定角色的最后一条 streaming 消息（反向搜索）
 */
function endRoleStreaming(session, roleName) {
  for (let i = session.uiMessages.length - 1; i >= 0; i--) {
    if (session.uiMessages[i].role === roleName && session.uiMessages[i]._streaming) {
      delete session.uiMessages[i]._streaming;
      break;
    }
  }
}

// =====================================================================
// Route Parsing & Execution
// =====================================================================

/**
 * 从累积文本中解析所有 ROUTE 块（支持多 ROUTE + task 字段）
 * @returns {Array<{ to, summary, taskId, taskTitle }>}
 */
function parseRoutes(text) {
  const routes = [];
  const regex = /---ROUTE---\s*\n([\s\S]*?)---END_ROUTE---/g;
  let match;

  while ((match = regex.exec(text)) !== null) {
    const block = match[1];
    const toMatch = block.match(/to:\s*(.+)/i);
    if (!toMatch) continue;

    const summaryMatch = block.match(/summary:\s*([\s\S]+)/i);
    const taskMatch = block.match(/^task:\s*(.+)/im);
    const taskTitleMatch = block.match(/^taskTitle:\s*(.+)/im);

    routes.push({
      to: toMatch[1].trim().toLowerCase(),
      summary: summaryMatch ? summaryMatch[1].trim() : '',
      taskId: taskMatch ? taskMatch[1].trim() : null,
      taskTitle: taskTitleMatch ? taskTitleMatch[1].trim() : null
    });
  }

  return routes;
}

/**
 * 执行路由
 */
async function executeRoute(session, fromRole, route) {
  const { to, summary, taskId, taskTitle } = route;

  // ★ round++ 已移到 processRoleOutput 中（多 ROUTE 只增 1 轮）

  // 如果 session 已暂停或停止，保存为 pendingRoutes
  if (session.status === 'paused' || session.status === 'stopped') {
    session.pendingRoutes.push({ fromRole, route });
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
    // task 信息通过 dispatchToRole 内部设置（createRoleQuery 之后 roleState 才存在）

    // 先检查是否有人的消息在排队
    if (session.humanMessageQueue.length > 0) {
      // 人的消息优先
      await processHumanQueue(session);
    } else {
      const taskPrompt = buildRoutePrompt(fromRole, summary, session);
      await dispatchToRole(session, to, taskPrompt, fromRole, taskId, taskTitle);
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
  const fromName = fromRoleConfig ? roleLabel(fromRoleConfig) : fromRole;
  return `来自 ${fromName} 的消息:\n${summary}\n\n请开始你的工作。完成后通过 ROUTE 块传递给下一个角色。`;
}

// =====================================================================
// Message Dispatching
// =====================================================================

/**
 * 向角色发送消息
 */
async function dispatchToRole(session, roleName, content, fromSource, taskId, taskTitle) {
  if (session.status === 'paused' || session.status === 'stopped') {
    console.log(`[Crew] Session ${session.status}, skipping dispatch to ${roleName}`);
    return;
  }

  let roleState = session.roleStates.get(roleName);

  // 如果角色没有 query 实例，创建一个（支持 resume）
  if (!roleState || !roleState.query || !roleState.inputStream) {
    roleState = await createRoleQuery(session, roleName);
  }

  // 设置 task（createRoleQuery 之后 roleState 一定存在）
  if (taskId) {
    roleState.currentTask = { taskId, taskTitle };
  }

  // 记录消息历史
  session.messageHistory.push({
    from: fromSource,
    to: roleName,
    content: typeof content === 'string' ? content.substring(0, 200) : '...',
    taskId: taskId || roleState.currentTask?.taskId || null,
    timestamp: Date.now()
  });

  // 发送
  roleState.turnActive = true;
  roleState.accumulatedText = '';
  roleState.inputStream.enqueue({
    type: 'user',
    message: { role: 'user', content }
  });

  console.log(`[Crew] Dispatched to ${roleName} from ${fromSource}${taskId ? ` (task: ${taskId})` : ''}`);
}

// =====================================================================
// Human Interaction
// =====================================================================

/**
 * 处理人的输入
 */
export async function handleCrewHumanInput(msg) {
  const { sessionId, content, targetRole, files } = msg;
  const session = crewSessions.get(sessionId);
  if (!session) {
    console.warn(`[Crew] Session not found: ${sessionId}`);
    return;
  }

  // Build dispatch content (supports image attachments)
  function buildHumanContent(prefix, text) {
    if (files && files.length > 0) {
      const blocks = [];
      for (const file of files) {
        if (file.isImage || file.mimeType?.startsWith('image/')) {
          blocks.push({
            type: 'image',
            source: { type: 'base64', media_type: file.mimeType, data: file.data }
          });
        }
      }
      blocks.push({ type: 'text', text: `${prefix}\n${text}` });
      return blocks;
    }
    return `${prefix}\n${text}`;
  }

  // 注意：不在这里发送人的消息到 Web（前端已本地添加，避免重复）
  // 但需要记录到 uiMessages 用于恢复时重放
  session.uiMessages.push({
    role: 'human', roleIcon: '', roleName: '你',
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
    await dispatchToRole(session, target, buildHumanContent('人工回复:', content), 'human');
    return;
  }

  // 解析 @role 指令（支持 name 和 displayName）
  const atMatch = content.match(/^@(\S+)\s*([\s\S]*)/);
  if (atMatch) {
    const atTarget = atMatch[1];
    const message = atMatch[2].trim() || content;

    // 先精确匹配 role.name，再匹配 displayName
    let target = null;
    for (const [name, role] of session.roles) {
      if (name === atTarget.toLowerCase()) {
        target = name;
        break;
      }
      if (role.displayName === atTarget) {
        target = name;
        break;
      }
    }

    if (target) {
      await dispatchToRole(session, target, buildHumanContent('人工消息:', message), 'human');
      return;
    }
  }

  // 没有 @ 指定目标，默认发给决策者（PM）
  const target = targetRole || session.decisionMaker;

  await dispatchToRole(session, target, buildHumanContent('人工消息:', content), 'human');
}

/**
 * 处理排队的人的消息
 */
async function processHumanQueue(session) {
  if (session.humanMessageQueue.length === 0) return;
  if (session._processingHumanQueue) return;
  session._processingHumanQueue = true;
  try {
    const msgs = session.humanMessageQueue.splice(0);
    if (msgs.length === 1) {
      const humanPrompt = `人工消息:\n${msgs[0].content}`;
      await dispatchToRole(session, msgs[0].target, humanPrompt, 'human');
    } else {
      // 按 target 分组，合并发送
      const byTarget = new Map();
      for (const m of msgs) {
        if (!byTarget.has(m.target)) byTarget.set(m.target, []);
        byTarget.get(m.target).push(m.content);
      }
      for (const [target, contents] of byTarget) {
        const combined = contents.join('\n\n---\n\n');
        const humanPrompt = `人工消息:\n你有 ${contents.length} 条待处理消息，请一并分析并用多个 ROUTE 块并行分配：\n\n${combined}`;
        await dispatchToRole(session, target, humanPrompt, 'human');
      }
    }
  } finally {
    session._processingHumanQueue = false;
  }
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
    case 'interrupt_role':
      if (targetRole && msg.content) {
        await interruptRole(session, targetRole, msg.content, 'human');
      }
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

  // 显式 await 保存，确保暂停状态落盘
  await saveSessionMeta(session);
}

/**
 * 恢复 session
 * 重新执行被暂停时保存的 pendingRoutes
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

  // 恢复被中断的路由（可能有多条）
  if (session.pendingRoutes.length > 0) {
    const pending = session.pendingRoutes.slice();
    session.pendingRoutes = [];
    console.log(`[Crew] Replaying ${pending.length} pending route(s)`);
    const results = await Promise.allSettled(pending.map(({ fromRole, route }) =>
      executeRoute(session, fromRole, route)
    ));
    for (const r of results) {
      if (r.status === 'rejected') {
        console.warn(`[Crew] Pending route replay failed:`, r.reason);
      }
    }
    return;
  }

  // 没有 pendingRoutes，检查排队的人的消息
  await processHumanQueue(session);
}

/**
 * 停止单个角色
 */
/**
 * 中断角色当前 turn 并发送新消息
 */
async function interruptRole(session, roleName, newContent, fromSource = 'human') {
  const roleState = session.roleStates.get(roleName);
  if (!roleState) {
    console.warn(`[Crew] Cannot interrupt ${roleName}: no roleState`);
    return;
  }

  console.log(`[Crew] Interrupting ${roleName}`);

  // 结束 streaming 状态
  endRoleStreaming(session, roleName);

  // 保存 sessionId 用于 resume 上下文连续性
  if (roleState.claudeSessionId) {
    await saveRoleSessionId(session.sharedDir, roleName, roleState.claudeSessionId)
      .catch(e => console.warn(`[Crew] Failed to save sessionId for ${roleName}:`, e.message));
  }

  // Abort 当前 query
  if (roleState.abortController) {
    roleState.abortController.abort();
  }

  // 清理旧状态
  roleState.query = null;
  roleState.inputStream = null;
  roleState.turnActive = false;
  roleState.accumulatedText = '';

  // 通知前端中断
  sendCrewMessage({
    type: 'crew_turn_completed',
    sessionId: session.id,
    role: roleName,
    interrupted: true
  });

  sendStatusUpdate(session);

  // 系统消息记录
  sendCrewOutput(session, 'system', 'system', {
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text: `${roleName} 被中断` }] }
  });

  // 创建新 query 并 dispatch
  await dispatchToRole(session, roleName, newContent, fromSource);
}

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

  // 清理 git worktrees
  await cleanupWorktrees(session.projectDir);

  // 显式 await 保存，确保 session.json 落盘后再从内存中移除
  await saveSessionMeta(session);
  await upsertCrewIndex(session);

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
  const roleIcon = role?.icon || '';
  const displayName = role?.displayName || roleName;

  // 从 roleState 获取当前 task 信息
  const roleState = session.roleStates.get(roleName);
  const taskId = roleState?.currentTask?.taskId || null;
  const taskTitle = roleState?.currentTask?.taskTitle || null;

  sendCrewMessage({
    type: 'crew_output',
    sessionId: session.id,
    role: roleName,
    roleIcon,
    roleName: displayName,
    outputType,  // 'text' | 'tool_use' | 'tool_result' | 'route' | 'system'
    data: rawMessage,
    taskId,
    taskTitle,
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
    // ★ 修复2: 反向搜索该角色最后一条 _streaming 消息
    let found = false;
    for (let i = session.uiMessages.length - 1; i >= 0; i--) {
      const msg = session.uiMessages[i];
      if (msg.role === roleName && msg.type === 'text' && msg._streaming) {
        msg.content += text;
        found = true;
        break;
      }
    }
    if (!found) {
      session.uiMessages.push({
        role: roleName, roleIcon, roleName: displayName,
        type: 'text', content: text, _streaming: true,
        taskId, taskTitle,
        timestamp: Date.now()
      });
    }
  } else if (outputType === 'route') {
    // 结束该角色前一条 streaming
    endRoleStreaming(session, roleName);
    session.uiMessages.push({
      role: roleName, roleIcon, roleName: displayName,
      type: 'route', routeTo: extra.routeTo,
      routeSummary: extra.routeSummary || '',
      content: `→ @${extra.routeTo} ${extra.routeSummary || ''}`,
      taskId, taskTitle,
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
  } else if (outputType === 'tool_use') {
    // 结束该角色前一条 streaming
    endRoleStreaming(session, roleName);
    const content = rawMessage?.message?.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block.type === 'tool_use') {
          // Save trimmed toolInput for restore — only key fields, skip large content
          const input = block.input || {};
          const trimmedInput = {};
          if (input.file_path) trimmedInput.file_path = input.file_path;
          if (input.command) trimmedInput.command = input.command.substring(0, 200);
          if (input.pattern) trimmedInput.pattern = input.pattern;
          if (input.old_string) trimmedInput.old_string = input.old_string.substring(0, 100);
          if (input.new_string) trimmedInput.new_string = input.new_string.substring(0, 100);
          if (input.url) trimmedInput.url = input.url;
          if (input.query) trimmedInput.query = input.query;
          session.uiMessages.push({
            role: roleName, roleIcon, roleName: displayName,
            type: 'tool',
            toolName: block.name,
            toolId: block.id,
            toolInput: Object.keys(trimmedInput).length > 0 ? trimmedInput : null,
            content: `${block.name} ${block.input?.file_path || block.input?.command?.substring(0, 60) || ''}`,
            hasResult: false,
            taskId, taskTitle,
            timestamp: Date.now()
          });
        }
      }
    }
  } else if (outputType === 'tool_result') {
    // 标记对应 tool 的 hasResult
    const toolId = rawMessage?.message?.tool_use_id;
    if (toolId) {
      for (let i = session.uiMessages.length - 1; i >= 0; i--) {
        if (session.uiMessages[i].type === 'tool' && session.uiMessages[i].toolId === toolId) {
          session.uiMessages[i].hasResult = true;
          break;
        }
      }
    }
    // Check for image blocks in tool_result content
    const resultContent = rawMessage?.message?.content;
    if (Array.isArray(resultContent)) {
      for (const item of resultContent) {
        if (item.type === 'image' && item.source?.type === 'base64') {
          sendCrewMessage({
            type: 'crew_image',
            sessionId: session.id,
            role: roleName,
            roleIcon,
            roleName: displayName,
            toolId: toolId || '',
            mimeType: item.source.media_type,
            data: item.source.data,
            taskId, taskTitle
          });
          session.uiMessages.push({
            role: roleName, roleIcon, roleName: displayName,
            type: 'image', toolId: toolId || '',
            mimeType: item.source.media_type,
            taskId, taskTitle,
            timestamp: Date.now()
          });
        }
      }
    }
  }
  // tool 只保存精简信息（toolName + 摘要），不存完整 toolInput/toolResult
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
