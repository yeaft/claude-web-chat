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
import { join, isAbsolute } from 'path';
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

    if (count <= 1) {
      // 单实例：保持原名，expandable 角色也分配 groupIndex=1 以获得独立 worktree
      expanded.push({
        ...role,
        roleType: role.name,
        groupIndex: isExpandable ? 1 : 0
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
 * 为开发组创建 git worktree
 * 每个 groupIndex 对应一个 worktree，同组的 dev/rev/test 共享
 * 所有 EXPANDABLE_ROLES（包括 count=1）都会获得独立 worktree
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
    agentId: session.agentId || null,
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
      description: r.description, isDecisionMaker: r.isDecisionMaker || false,
      groupIndex: r.groupIndex, roleType: r.roleType, model: r.model
    })),
    decisionMaker: session.decisionMaker,
    maxRounds: session.maxRounds,
    round: session.round,
    createdAt: session.createdAt,
    updatedAt: Date.now(),
    userId: session.userId,
    username: session.username,
    agentId: session.agentId || null,
    costUsd: session.costUsd,
    totalInputTokens: session.totalInputTokens,
    totalOutputTokens: session.totalOutputTokens,
    features: Array.from(session.features.values())
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

  // 按 agentId 过滤（兼容旧数据：无 agentId 的 session 在所有 agent 中显示）
  const agentId = ctx.CONFIG?.agentName || null;
  const filtered = agentId
    ? index.filter(e => !e.agentId || e.agentId === agentId)
    : index;

  // 用活跃 session 更新实时状态
  for (const entry of filtered) {
    const active = crewSessions.get(entry.sessionId);
    if (active) {
      entry.status = active.status;
    }
  }

  ctx.sendToServer({
    type: 'crew_sessions_list',
    requestId,
    _requestClientId,
    sessions: filtered
  });
}

/**
 * 验证 projectDir 路径安全性：必须是绝对路径且不包含路径遍历
 */
function isValidProjectDir(dir) {
  if (!dir || typeof dir !== 'string') return false;
  if (!isAbsolute(dir)) return false;
  if (/(?:^|[\\/])\.\.(?:[\\/]|$)/.test(dir)) return false;
  return true;
}

/**
 * 检查工作目录下是否存在 .crew 目录
 */
export async function handleCheckCrewExists(msg) {
  const { projectDir, requestId, _requestClientId } = msg;
  if (!projectDir || !isValidProjectDir(projectDir)) {
    ctx.sendToServer({
      type: 'crew_exists_result',
      requestId,
      _requestClientId,
      exists: false,
      error: 'projectDir is required'
    });
    return;
  }

  const crewDir = join(projectDir, '.crew');
  try {
    const stat = await fs.stat(crewDir);
    if (stat.isDirectory()) {
      // 尝试读取 session.json 获取 session 信息
      let sessionInfo = null;
      try {
        const sessionPath = join(crewDir, 'session.json');
        const data = await fs.readFile(sessionPath, 'utf-8');
        sessionInfo = JSON.parse(data);
      } catch {
        // session.json 可能不存在，不影响
      }
      ctx.sendToServer({
        type: 'crew_exists_result',
        requestId,
        _requestClientId,
        exists: true,
        projectDir,
        sessionInfo
      });
    } else {
      ctx.sendToServer({
        type: 'crew_exists_result',
        requestId,
        _requestClientId,
        exists: false,
        projectDir
      });
    }
  } catch {
    ctx.sendToServer({
      type: 'crew_exists_result',
      requestId,
      _requestClientId,
      exists: false,
      projectDir
    });
  }
}

/**
 * 删除工作目录下的 .crew 目录
 */
export async function handleDeleteCrewDir(msg) {
  const { projectDir, _requestClientId } = msg;
  if (!isValidProjectDir(projectDir)) return;
  const crewDir = join(projectDir, '.crew');
  try {
    await fs.rm(crewDir, { recursive: true, force: true });
  } catch {
    // ignore errors (dir may not exist)
  }
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
        description: r.description, isDecisionMaker: r.isDecisionMaker || false,
        groupIndex: r.groupIndex, roleType: r.roleType, model: r.model
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
    features: new Map((meta.features || []).map(f => [f.taskId, f])),
    userId: userId || meta.userId,
    username: username || meta.username,
    agentId: meta.agentId || ctx.CONFIG?.agentName || null,
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
      description: r.description, isDecisionMaker: r.isDecisionMaker || false,
      groupIndex: r.groupIndex, roleType: r.roleType, model: r.model
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

/**
 * 查找指定 projectDir 的已有 crew session（内存活跃 > 磁盘索引）
 */
async function findExistingSessionByProjectDir(projectDir) {
  const normalizedDir = projectDir.replace(/\/+$/, '');

  for (const [, session] of crewSessions) {
    if (session.projectDir.replace(/\/+$/, '') === normalizedDir
        && session.status !== 'completed') {
      return { sessionId: session.id, source: 'active' };
    }
  }

  const index = await loadCrewIndex();
  const agentId = ctx.CONFIG?.agentName || null;
  const match = index.find(e =>
    e.projectDir.replace(/\/+$/, '') === normalizedDir
    && (!agentId || !e.agentId || e.agentId === agentId)
    && e.status !== 'completed'
  );

  if (match) {
    const meta = await loadSessionMeta(match.sharedDir);
    if (meta) return { sessionId: match.sessionId, source: 'index' };
    await removeFromCrewIndex(match.sessionId);
  }

  return null;
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

  // 同目录检查：如果 projectDir 已有活跃或可恢复的 session，自动 resume
  const existingSession = await findExistingSessionByProjectDir(projectDir);
  if (existingSession) {
    console.log(`[Crew] Found existing session for ${projectDir}: ${existingSession.sessionId}, auto-resuming`);
    await resumeCrewSession({ sessionId: existingSession.sessionId, userId, username });
    return;
  }

  // 展开多实例角色（count > 1 的执行者角色）
  const roles = expandRoles(rawRoles);

  // 解析共享目录（相对路径相对于 projectDir）
  const sharedDir = sharedDirRel?.startsWith('/')
    ? sharedDirRel
    : join(projectDir, sharedDirRel || '.crew');

  // 初始化共享区
  await initSharedDir(sharedDir, goal, roles, projectDir, sharedKnowledge);

  // 初始化 git worktrees（所有 EXPANDABLE_ROLES 都会获得独立 worktree）
  const worktreeMap = await initWorktrees(projectDir, roles);
  // 回填 workDir：同组的 dev/rev/test 共享同一个 worktree
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
    features: new Map(),      // taskId → { taskId, taskTitle, createdAt } — 持久化 feature 列表
    userId,
    username,
    agentId: ctx.CONFIG?.agentName || null,
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
5. 连续尝试 2 次相同操作仍然失败
上报时请说明：你在做什么任务、卡在哪里、你认为需要谁来协助。PM 会统筹全局，判断是分配给合适的人还是调整任务顺序。

# Worktree 隔离规则
- dev/reviewer/tester 角色必须在各自分配的 worktree 中工作，绝对禁止在项目主目录或 main 分支上修改代码
- 每个角色的 CLAUDE.md 会标明「代码工作目录」，该路径就是你的 worktree，所有文件操作必须使用该路径
- PM 和 designer 不使用 worktree，他们在项目主目录下以只读方式工作
- 绝对禁止在其他开发组的 worktree 中操作代码
- 代码完成并通过 review 后，dev 自己提 PR 合并到 main 分支
- PM 不做 cherry-pick，只负责打 tag
- 每次新任务/新 feature 必须基于最新的 main 分支创建新的 worktree，确保在最新代码上开发

# Feature 工作记录
系统自动管理 \`context/features/{task-id}.md\` 工作记录文件：
- PM 通过 ROUTE 分配任务（带 task + taskTitle 字段）时自动创建
- 每次角色 ROUTE 传递时自动追加工作记录
- 角色收到消息时自动注入对应 task 文件内容作为上下文
角色不需要手动创建或更新这些文件。

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
# 代码工作目录
${role.workDir}
所有代码操作请使用此路径。不要使用项目主目录。
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
// Task File Management (auto-managed by system)
// =====================================================================

/**
 * 自动创建 task 进度文件
 * 当 ROUTE 带有 taskId + taskTitle 时，如果文件不存在则自动创建
 */
async function ensureTaskFile(session, taskId, taskTitle, assignee, summary) {
  const featuresDir = join(session.sharedDir, 'context', 'features');
  const filePath = join(featuresDir, `${taskId}.md`);

  try {
    await fs.access(filePath);
    // 文件已存在，不覆盖
    return;
  } catch {
    // 文件不存在，创建
  }

  await fs.mkdir(featuresDir, { recursive: true });

  const now = new Date().toISOString();
  const content = `# Feature: ${taskTitle}
- task-id: ${taskId}
- 状态: 待开发
- 负责人: ${assignee}
- 创建时间: ${now}

## 需求描述
${summary}

## 工作记录
`;

  await fs.writeFile(filePath, content);

  // 同步到 session.features
  if (!session.features.has(taskId)) {
    session.features.set(taskId, { taskId, taskTitle, createdAt: Date.now() });
  }

  console.log(`[Crew] Task file created: ${taskId} (${taskTitle})`);
}

/**
 * 追加工作记录到 task 文件
 * 当角色 ROUTE 时，自动将 summary 追加到对应 task 文件
 */
async function appendTaskRecord(session, taskId, roleName, summary) {
  const filePath = join(session.sharedDir, 'context', 'features', `${taskId}.md`);

  try {
    await fs.access(filePath);
  } catch {
    // 文件不存在，跳过（不应该发生，但防御性处理）
    return;
  }

  const role = session.roles.get(roleName);
  const label = role ? roleLabel(role) : roleName;
  const now = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
  const record = `\n### ${label} - ${now}\n${summary}\n`;

  await fs.appendFile(filePath, record);
  console.log(`[Crew] Task record appended: ${taskId} by ${roleName}`);
}

/**
 * 读取 task 文件内容（用于注入上下文）
 */
async function readTaskFile(session, taskId) {
  const filePath = join(session.sharedDir, 'context', 'features', `${taskId}.md`);
  try {
    return await fs.readFile(filePath, 'utf-8');
  } catch {
    return null;
  }
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


/**
 * 清除角色的 savedSessionId（用于强制新建 conversation）
 */
async function clearRoleSessionId(sharedDir, roleName) {
  const filePath = join(sharedDir, 'sessions', `${roleName}.json`);
  try {
    await fs.unlink(filePath);
    console.log(`[Crew] Cleared sessionId for ${roleName} (force new conversation)`);
  } catch {
    // 文件不存在也正常
  }
}

/**
 * 判断角色错误是否可恢复
 */
function classifyRoleError(error) {
  const msg = error.message || '';
  if (/context.*(window|limit|exceeded)|token.*limit|too.*(long|large)|max.*token/i.test(msg)) {
    return { recoverable: true, reason: 'context_exceeded', skipResume: true };
  }
  if (/compact|compress|context.*reduc/i.test(msg)) {
    return { recoverable: true, reason: 'compact_failed', skipResume: true };
  }
  if (/rate.?limit|429|overloaded|503|502|timeout|ECONNRESET|ETIMEDOUT/i.test(msg)) {
    return { recoverable: true, reason: 'transient_api_error', skipResume: false };
  }
  if (/exited with code [1-9]/i.test(msg) && msg.length < 100) {
    return { recoverable: true, reason: 'process_crashed', skipResume: false };
  }
  if (/spawn|ENOENT|not found/i.test(msg)) {
    return { recoverable: false, reason: 'spawn_failed' };
  }
  return { recoverable: true, reason: 'unknown', skipResume: false };
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
    claudeSessionId: savedSessionId,
    lastCostUsd: 0,
    lastInputTokens: 0,
    lastOutputTokens: 0,
    consecutiveErrors: 0,
    lastDispatchContent: null,
    lastDispatchFrom: null,
    lastDispatchTaskId: null,
    lastDispatchTaskTitle: null,
    // compact 状态
    _compacting: false,           // 是否正在 compact
    _compactSummaryPending: false, // 是否等待过滤 compact summary
    _pendingCompactRoutes: null,  // compact 期间缓存的待执行路由 Array|null
    _pendingDispatch: null,       // compact 完成后待重派的内容 { content, from, taskId, taskTitle }
    _fromRole: null               // 缓存路由的来源角色
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
- 可以一次发多个 ROUTE 块来并行分配任务给不同角色
- ROUTE 块必须在回复的最末尾
- 当你的任务已完成且不需要其他角色继续时，ROUTE 回决策者 "${session.decisionMaker}" 做总结
- 在正文中可用 @角色name 提及某个角色（如 @developer），但这不会触发路由，仅供阅读`;
  }

  // 决策者额外 prompt
  if (role.isDecisionMaker) {

    prompt += `\n\n# 工具使用
PM 可以使用所有工具，包括 Read、Grep、Glob、Bash、Edit、Write。代码文件的改动仍建议 ROUTE 给 developer 执行，但不做硬性限制。`;

    prompt += `\n\n# 决策者职责
你是团队的决策者。其他角色遇到不确定的情况会请求你的决策。
- 如果你有足够的信息做出决策，直接决定并 @相关角色执行
- 如果你需要更多信息，@具体角色请求补充
- 如果问题超出你的能力范围或需要业务判断，@human 请人类决定
- 你可以随时审查其他角色的工作并给出反馈
- PM 不做代码分析。收到需求后直接将原始需求 ROUTE 给空闲 dev 做技术分析，dev 分析完返回 PM，PM 再拆分任务并直接分配执行。
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
- [ ] 任务描述 #task-1 @角色name
- [x] 已完成的任务 #task-2 @角色name
---END_TASKS---
\`\`\`

注意：
- 每行一个任务，[ ] 表示待办，[x] 表示已完成
- #taskId 标注对应的 feature ID（如 #task-1），用于精确关联任务完成状态
- @角色name 标注负责人（可选）
- 后续回复中可更新 TASKS 块（标记完成的任务）
- TASKS 块不需要在回复最末尾，可以放在任意位置`;
  }

  // Feature 进度文件说明（系统自动管理，告知角色即可）
  prompt += `\n\n# Feature 工作记录
系统会自动管理 \`context/features/{task-id}.md\` 工作记录文件：
- PM 分配任务时自动创建文件（包含 task-id、标题、需求描述）
- 每次 ROUTE 传递时自动追加工作记录（角色名、时间、summary）
- 你收到的消息中会包含 <task-context> 标签，里面是该任务的完整工作记录
你不需要手动创建或更新这些文件，专注于你的本职工作即可。`;

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

// Context 使用率阈值常量
const MAX_CONTEXT = 128000;       // API max_prompt_tokens 限制
const COMPACT_THRESHOLD = 0.85;   // 85% → 触发预防性 compact
const CLEAR_THRESHOLD = 0.95;     // 95% → compact 后仍超限则 clear + rebuild

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

      // ★ compact 消息过滤（compact 期间只放行 result，其余过滤）
      if (roleState._compacting && message.type !== 'result') {
        if (message.type === 'system') {
          if (message.subtype === 'compact_boundary') {
            roleState._compactSummaryPending = true;
          }
          continue; // 过滤所有 compact 期间的 system 消息
        }
        if (message.type === 'user' && roleState._compactSummaryPending) {
          roleState._compactSummaryPending = false;
          continue; // 过滤 compact summary
        }
        // 其他消息（assistant 等）在 compact 期间也过滤
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
        roleState.consecutiveErrors = 0;

        // ★ 修复2: 反向搜索该角色最后一条 streaming 消息并结束
        endRoleStreaming(session, roleName);

        // 更新费用（差值计算：每个角色独立进程，total_cost_usd 是该角色的累计值）
        if (message.total_cost_usd != null) {
          const costDelta = message.total_cost_usd - roleState.lastCostUsd;
          if (costDelta > 0) session.costUsd += costDelta;
          roleState.lastCostUsd = message.total_cost_usd;
        }
        // 更新 token 用量（差值计算：usage 是 query 实例级累计值）
        if (message.usage) {
          const inputDelta = (message.usage.input_tokens || 0) - (roleState.lastInputTokens || 0);
          const outputDelta = (message.usage.output_tokens || 0) - (roleState.lastOutputTokens || 0);
          if (inputDelta > 0) session.totalInputTokens += inputDelta;
          if (outputDelta > 0) session.totalOutputTokens += outputDelta;
          roleState.lastInputTokens = message.usage.input_tokens || 0;
          roleState.lastOutputTokens = message.usage.output_tokens || 0;
        }

        // ★ compact turn 完成的处理
        if (roleState._compacting) {
          roleState._compacting = false;
          const postCompactTokens = message.usage?.input_tokens || 0;
          const postCompactPercentage = postCompactTokens / MAX_CONTEXT;
          console.log(`[Crew] ${roleName} compact completed, context now at ${Math.round(postCompactPercentage * 100)}%`);

          sendCrewMessage({
            type: 'crew_role_compact',
            sessionId: session.id,
            role: roleName,
            contextPercentage: Math.round(postCompactPercentage * 100),
            status: 'completed'
          });

          // Layer 2: compact 后仍超 95% → clear + rebuild
          if (postCompactPercentage >= CLEAR_THRESHOLD) {
            console.warn(`[Crew] ${roleName} still at ${Math.round(postCompactPercentage * 100)}% after compact, escalating to clear`);

            await clearRoleSessionId(session.sharedDir, roleName);
            roleState.claudeSessionId = null;

            if (roleState.abortController) roleState.abortController.abort();
            roleState.query = null;
            roleState.inputStream = null;

            sendCrewMessage({
              type: 'crew_role_compact',
              sessionId: session.id,
              role: roleName,
              status: 'cleared'
            });

            // 重新 dispatch 缓存的路由（用新会话）
            if (roleState._pendingCompactRoutes) {
              const routes = roleState._pendingCompactRoutes;
              const fromRole = roleState._fromRole;
              roleState._pendingCompactRoutes = null;
              roleState._fromRole = null;
              session.round++;
              const results = await Promise.allSettled(routes.map(route =>
                executeRoute(session, fromRole, route)
              ));
              for (const r of results) {
                if (r.status === 'rejected') {
                  console.warn(`[Crew] Route execution failed:`, r.reason);
                }
              }
            } else if (roleState._pendingDispatch) {
              const pd = roleState._pendingDispatch;
              roleState._pendingDispatch = null;
              await dispatchToRole(session, roleName, pd.content, pd.from, pd.taskId, pd.taskTitle);
            }
            return; // abort 后 query 已清空，退出 processRoleOutput
          }

          // 执行之前缓存的路由
          if (roleState._pendingCompactRoutes) {
            const routes = roleState._pendingCompactRoutes;
            const fromRole = roleState._fromRole;
            roleState._pendingCompactRoutes = null;
            roleState._fromRole = null;
            session.round++;
            const results = await Promise.allSettled(routes.map(route =>
              executeRoute(session, fromRole, route)
            ));
            for (const r of results) {
              if (r.status === 'rejected') {
                console.warn(`[Crew] Route execution failed:`, r.reason);
              }
            }
          } else if (roleState._pendingDispatch) {
            const pd = roleState._pendingDispatch;
            roleState._pendingDispatch = null;
            await dispatchToRole(session, roleName, pd.content, pd.from, pd.taskId, pd.taskTitle);
          }
          continue; // 不要重复处理这个 compact result
        }

        // ★ 持久化 sessionId（每次 turn 完成后保存，用于后续 resume）
        if (roleState.claudeSessionId) {
          saveRoleSessionId(session.sharedDir, roleName, roleState.claudeSessionId)
            .catch(e => console.warn(`[Crew] Failed to save sessionId for ${roleName}:`, e.message));
        }

        // ★ context 使用率监控
        const inputTokens = message.usage?.input_tokens || 0;
        if (inputTokens > 0) {
          sendCrewMessage({
            type: 'crew_context_usage',
            sessionId: session.id,
            role: roleName,
            inputTokens,
            maxTokens: MAX_CONTEXT,
            percentage: Math.min(100, Math.round((inputTokens / MAX_CONTEXT) * 100))
          });
        }

        const contextPercentage = inputTokens / MAX_CONTEXT;
        const needCompact = contextPercentage >= COMPACT_THRESHOLD;

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

        // ★ 需要 compact：缓存路由，先执行 compact
        if (needCompact) {
          console.log(`[Crew] ${roleName} context at ${Math.round(contextPercentage * 100)}%, compacting before next dispatch`);

          roleState._pendingCompactRoutes = routes.length > 0 ? routes : null;
          roleState._compacting = true;
          roleState._compactSummaryPending = false;
          roleState._fromRole = roleName;

          // task 继承
          const currentTask = roleState.currentTask;
          if (roleState._pendingCompactRoutes) {
            for (const route of roleState._pendingCompactRoutes) {
              if (!route.taskId && currentTask) {
                route.taskId = currentTask.taskId;
                route.taskTitle = currentTask.taskTitle;
              }
            }
          }

          // 发送 /compact
          roleState.inputStream.enqueue({
            type: 'user',
            message: { role: 'user', content: '/compact' }
          });

          sendCrewMessage({
            type: 'crew_role_compact',
            sessionId: session.id,
            role: roleName,
            contextPercentage: Math.round(contextPercentage * 100),
            status: 'compacting'
          });

          continue; // 等 compact turn 完成
        }

        // 执行路由（无需 compact 时）
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

      // Step 1: 清理 roleState（防止后续写入死进程）
      endRoleStreaming(session, roleName);
      roleState.query = null;
      roleState.inputStream = null;
      roleState.turnActive = false;
      roleState.accumulatedText = '';
      // 重置 compact 状态（防止 compact 期间出错导致后续消息被永久过滤）
      roleState._compacting = false;
      roleState._compactSummaryPending = false;

      // Step 2: 错误分类
      const classification = classifyRoleError(error);
      roleState.consecutiveErrors++;

      // Step 3: 通知前端
      sendCrewMessage({
        type: 'crew_role_error',
        sessionId: session.id,
        role: roleName,
        error: error.message.substring(0, 500),
        reason: classification.reason,
        recoverable: classification.recoverable,
        retryCount: roleState.consecutiveErrors
      });
      sendStatusUpdate(session);

      // Step 4: 判断是否重试
      const MAX_RETRIES = 3;
      if (!classification.recoverable || roleState.consecutiveErrors > MAX_RETRIES) {
        const exhausted = roleState.consecutiveErrors > MAX_RETRIES;
        const errDetail = exhausted
          ? `角色 ${roleName} 连续 ${MAX_RETRIES} 次错误后停止重试。最后错误: ${error.message}`
          : `角色 ${roleName} 不可恢复错误: ${error.message}`;
        if (roleName !== session.decisionMaker) {
          await dispatchToRole(session, session.decisionMaker, errDetail, 'system');
        } else {
          session.status = 'waiting_human';
          sendCrewMessage({
            type: 'crew_human_needed',
            sessionId: session.id,
            fromRole: roleName,
            reason: 'error',
            message: errDetail
          });
          sendStatusUpdate(session);
        }
        return;
      }

      // Step 5: 可恢复 → 自动重建并重试
      console.log(`[Crew] ${roleName} attempting recovery (${classification.reason}), retry ${roleState.consecutiveErrors}/${MAX_RETRIES}`);

      sendCrewOutput(session, 'system', 'system', {
        type: 'assistant',
        message: { role: 'assistant', content: [{
          type: 'text',
          text: `${roleName} 遇到 ${classification.reason}，正在自动恢复 (${roleState.consecutiveErrors}/${MAX_RETRIES})...`
        }] }
      });

      if (roleState.lastDispatchContent) {
        // ★ context_exceeded: clear sessionId → rebuild query → /compact → 重派
        if (classification.reason === 'context_exceeded') {
          await clearRoleSessionId(session.sharedDir, roleName);
          const newState = await createRoleQuery(session, roleName);

          // 缓存待重派内容，compact 完成后自动发送
          newState._pendingDispatch = {
            content: roleState.lastDispatchContent,
            from: roleState.lastDispatchFrom || 'system',
            taskId: roleState.lastDispatchTaskId,
            taskTitle: roleState.lastDispatchTaskTitle
          };
          newState._compacting = true;
          newState._compactSummaryPending = false;
          newState.consecutiveErrors = roleState.consecutiveErrors;

          newState.inputStream.enqueue({
            type: 'user',
            message: { role: 'user', content: '/compact' }
          });

          sendCrewMessage({
            type: 'crew_role_compact',
            sessionId: session.id,
            role: roleName,
            status: 'compacting'
          });
        } else {
          // 其他可恢复错误：原有重派逻辑
          if (classification.skipResume) {
            await clearRoleSessionId(session.sharedDir, roleName);
          }
          await dispatchToRole(
            session, roleName,
            roleState.lastDispatchContent,
            roleState.lastDispatchFrom || 'system',
            roleState.lastDispatchTaskId,
            roleState.lastDispatchTaskTitle
          );
        }
      } else {
        const msg = `角色 ${roleName} 已恢复（${classification.reason}），但无待重试消息。`;
        if (roleName !== session.decisionMaker) {
          await dispatchToRole(session, session.decisionMaker, msg, 'system');
        }
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

  // ★ Task 文件自动管理（fire-and-forget，不阻塞路由执行）
  if (taskId && summary) {
    // 如果是决策者发出的 ROUTE（分配任务），自动创建 task 文件
    const fromRoleConfig = session.roles.get(fromRole);
    if (fromRoleConfig?.isDecisionMaker && taskTitle && to !== 'human') {
      ensureTaskFile(session, taskId, taskTitle, to, summary)
        .catch(e => console.warn(`[Crew] Failed to create task file ${taskId}:`, e.message));
    }
    // 任何角色的 ROUTE 都追加工作记录
    appendTaskRecord(session, taskId, fromRole, summary)
      .catch(e => console.warn(`[Crew] Failed to append task record ${taskId}:`, e.message));
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

  // ★ Task 上下文注入：如果有 taskId，读取 task 文件注入到消息中
  const effectiveTaskId = taskId || roleState.currentTask?.taskId;
  if (effectiveTaskId && typeof content === 'string') {
    const taskContent = await readTaskFile(session, effectiveTaskId);
    if (taskContent) {
      content = `${content}\n\n---\n<task-context file="context/features/${effectiveTaskId}.md">\n${taskContent}\n</task-context>`;
    }
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
  roleState.lastDispatchContent = content;
  roleState.lastDispatchFrom = fromSource;
  roleState.lastDispatchTaskId = taskId || null;
  roleState.lastDispatchTaskTitle = taskTitle || null;
  roleState.turnActive = true;
  roleState.accumulatedText = '';
  roleState.inputStream.enqueue({
    type: 'user',
    message: { role: 'user', content }
  });

  sendStatusUpdate(session);
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
 * 清空单个角色的对话（重置为全新状态）
 */
async function clearSingleRole(session, roleName) {
  const roleState = session.roleStates.get(roleName);

  // 如果角色正在 streaming，先 abort
  if (roleState) {
    if (roleState.abortController) {
      roleState.abortController.abort();
    }
    roleState.query = null;
    roleState.inputStream = null;
    roleState.turnActive = false;
    roleState._compacting = false;
    roleState._compactSummaryPending = false;
    roleState._pendingCompactRoutes = null;
    roleState._pendingDispatch = null;
    roleState._fromRole = null;
    roleState.claudeSessionId = null;
    roleState.consecutiveErrors = 0;
    roleState.accumulatedText = '';
    roleState.lastDispatchContent = null;
    roleState.lastDispatchFrom = null;
    roleState.lastDispatchTaskId = null;
    roleState.lastDispatchTaskTitle = null;
  }

  // 清除持久化的 sessionId
  await clearRoleSessionId(session.sharedDir, roleName);

  sendCrewMessage({
    type: 'crew_role_compact',
    sessionId: session.id,
    role: roleName,
    status: 'cleared'
  });

  sendCrewOutput(session, 'system', 'system', {
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text: `${roleName} 对话已清空` }] }
  });
  sendStatusUpdate(session);
  console.log(`[Crew] Role ${roleName} cleared`);
}

/**
 * 手动压缩指定角色的上下文
 * - 无活跃 query → 重建 query 后发 /compact
 * - 有 query 且非 turnActive → 直接发 /compact
 * - turnActive → 提示用户先停止该角色
 */
async function compactRole(session, roleName) {
  const roleState = session.roleStates.get(roleName);

  // Case 1: 角色正在 streaming，不能 compact
  if (roleState?.turnActive) {
    sendCrewMessage({
      type: 'crew_role_compact',
      sessionId: session.id,
      role: roleName,
      status: 'rejected',
      reason: '角色正在工作中，请先停止该角色再压缩上下文'
    });
    return;
  }

  // Case 2: 已经在 compacting
  if (roleState?._compacting) {
    sendCrewMessage({
      type: 'crew_role_compact',
      sessionId: session.id,
      role: roleName,
      status: 'rejected',
      reason: '该角色正在压缩中，请等待完成'
    });
    return;
  }

  // Case 3: 无活跃 query → 重建
  let state = roleState;
  if (!state || !state.query || !state.inputStream) {
    console.log(`[Crew] ${roleName} has no active query, rebuilding for compact`);
    state = await createRoleQuery(session, roleName);
  }

  // 发送 /compact
  console.log(`[Crew] Manual compact requested for ${roleName}`);
  state._compacting = true;
  state._compactSummaryPending = false;
  state._pendingCompactRoutes = null;
  state._fromRole = null;

  state.inputStream.enqueue({
    type: 'user',
    message: { role: 'user', content: '/compact' }
  });

  sendCrewMessage({
    type: 'crew_role_compact',
    sessionId: session.id,
    role: roleName,
    status: 'compacting'
  });
}

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
    case 'compact_role':
      if (targetRole) await compactRole(session, targetRole);
      break;
    case 'clear_role':
      if (targetRole) await clearSingleRole(session, targetRole);
      break;
    case 'stop_all':
      await stopAll(session);
      break;
    case 'clear':
      await clearSession(session);
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

/**
 * 清空 session：保留角色配置，重置所有对话
 * 每个角色创建全新的 Claude conversation
 */
async function clearSession(session) {
  // 1. Abort 所有运行中的 queries
  for (const [roleName, roleState] of session.roleStates) {
    if (roleState.abortController) {
      roleState.abortController.abort();
    }
    console.log(`[Crew] Clearing role: ${roleName}`);
  }
  session.roleStates.clear();

  // 2. 删除所有角色的 savedSessionId（强制新建 conversation）
  for (const [roleName] of session.roles) {
    await clearRoleSessionId(session.sharedDir, roleName);
  }

  // 3. 清空消息历史
  session.messageHistory = [];
  session.uiMessages = [];
  session.humanMessageQueue = [];
  session.waitingHumanContext = null;
  session.pendingRoutes = [];

  // 4. 重置计数
  session.round = 0;

  // 5. 清空磁盘上的 messages.json
  const messagesPath = join(session.sharedDir, 'messages.json');
  await fs.writeFile(messagesPath, '[]').catch(() => {});

  // 6. 恢复运行状态
  session.status = 'running';

  // 7. 通知前端
  sendCrewMessage({
    type: 'crew_session_cleared',
    sessionId: session.id
  });

  sendCrewOutput(session, 'system', 'system', {
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text: '会话已清空，所有角色将使用全新对话' }] }
  });
  sendStatusUpdate(session);

  // 8. 保存 meta
  await saveSessionMeta(session);

  console.log(`[Crew] Session ${session.id} cleared`);
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

  // ★ 累积 feature 到持久化列表
  if (taskId && taskTitle && !session.features.has(taskId)) {
    session.features.set(taskId, { taskId, taskTitle, createdAt: Date.now() });
  }

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
          // TodoWrite: preserve full input (todos array is small and needed for sticky banner)
          const input = block.input || {};
          let savedInput;
          if (block.name === 'TodoWrite') {
            savedInput = input;
          } else {
            const trimmedInput = {};
            if (input.file_path) trimmedInput.file_path = input.file_path;
            if (input.command) trimmedInput.command = input.command.substring(0, 200);
            if (input.pattern) trimmedInput.pattern = input.pattern;
            if (input.old_string) trimmedInput.old_string = input.old_string.substring(0, 100);
            if (input.new_string) trimmedInput.new_string = input.new_string.substring(0, 100);
            if (input.url) trimmedInput.url = input.url;
            if (input.query) trimmedInput.query = input.query;
            savedInput = Object.keys(trimmedInput).length > 0 ? trimmedInput : null;
          }
          session.uiMessages.push({
            role: roleName, roleIcon, roleName: displayName,
            type: 'tool',
            toolName: block.name,
            toolId: block.id,
            toolInput: savedInput,
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
      model: r.model,
      roleType: r.roleType,
      groupIndex: r.groupIndex
    })),
    activeRoles: Array.from(session.roleStates.entries())
      .filter(([, s]) => s.turnActive)
      .map(([name]) => name),
    currentToolByRole: Object.fromEntries(
      Array.from(session.roleStates.entries())
        .filter(([, s]) => s.turnActive && s.currentTool)
        .map(([name, s]) => [name, s.currentTool])
    ),
    features: Array.from(session.features.values())
  });

  // 异步更新持久化
  upsertCrewIndex(session).catch(e => console.warn('[Crew] Failed to update index:', e.message));
  saveSessionMeta(session).catch(e => console.warn('[Crew] Failed to save session meta:', e.message));
}
