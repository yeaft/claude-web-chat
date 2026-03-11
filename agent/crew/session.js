/**
 * Crew Session — 核心数据结构、角色展开和 Session 生命周期管理
 */
import { promises as fs } from 'fs';
import { join, isAbsolute } from 'path';
import ctx from '../context.js';
import { getMessages } from '../crew-i18n.js';
import { initWorktrees } from './worktree.js';
import { initSharedDir, writeRoleClaudeMd, updateSharedClaudeMd } from './shared-dir.js';
import {
  loadCrewIndex, upsertCrewIndex, removeFromCrewIndex,
  loadSessionMeta, saveSessionMeta, loadSessionMessages, getMaxShardIndex
} from './persistence.js';
import { sendCrewMessage, sendCrewOutput, sendStatusUpdate } from './ui-messages.js';

// =====================================================================
// Data Structures
// =====================================================================

/** @type {Map<string, CrewSession>} */
export const crewSessions = new Map();

// =====================================================================
// Role Multi-Instance Expansion
// =====================================================================

const SHORT_PREFIX = {
  developer: 'dev',
  tester: 'test',
  reviewer: 'rev'
};

const EXPANDABLE_ROLES = new Set(['developer', 'tester', 'reviewer']);

/**
 * 展开角色列表：count > 1 的执行者角色展开为多个实例
 */
export function expandRoles(roles) {
  const devRole = roles.find(r => r.name === 'developer');
  const devCount = devRole?.count > 1 ? devRole.count : 1;

  const expanded = [];
  for (const role of roles) {
    const isExpandable = EXPANDABLE_ROLES.has(role.name);
    const count = isExpandable ? devCount : 1;

    if (count <= 1) {
      expanded.push({
        ...role,
        roleType: role.name,
        groupIndex: isExpandable ? 1 : 0
      });
    } else {
      const prefix = SHORT_PREFIX[role.name] || role.name;
      for (let i = 1; i <= count; i++) {
        expanded.push({
          ...role,
          name: `${prefix}-${i}`,
          displayName: `${role.displayName}-${i}`,
          roleType: role.name,
          groupIndex: i,
          count: undefined
        });
      }
    }
  }
  return expanded;
}

/** Format role label */
export function roleLabel(r) {
  return r.icon ? `${r.icon} ${r.displayName}` : r.displayName;
}

// =====================================================================
// Path Validation
// =====================================================================

function isValidProjectDir(dir) {
  if (!dir || typeof dir !== 'string') return false;
  if (!isAbsolute(dir)) return false;
  if (/(?:^|[\\/])\.\.(?:[\\/]|$)/.test(dir)) return false;
  return true;
}

// =====================================================================
// Session Lifecycle
// =====================================================================

/**
 * 查找指定 projectDir 的已有 crew session
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

/**
 * 创建 Crew Session
 */
export async function createCrewSession(msg) {
  const {
    sessionId,
    projectDir,
    sharedDir: sharedDirRel,
    name,
    roles: rawRoles = [],
    teamType = 'dev',
    language = 'zh-CN',
    userId,
    username
  } = msg;

  // 同目录检查
  const existingSession = await findExistingSessionByProjectDir(projectDir);
  if (existingSession) {
    console.log(`[Crew] Found existing session for ${projectDir}: ${existingSession.sessionId}, auto-resuming`);
    await resumeCrewSession({ sessionId: existingSession.sessionId, userId, username });
    return;
  }

  const roles = expandRoles(rawRoles);
  const sharedDir = sharedDirRel?.startsWith('/')
    ? sharedDirRel
    : join(projectDir, sharedDirRel || '.crew');
  const decisionMaker = roles.find(r => r.isDecisionMaker)?.name || roles[0]?.name || null;

  // 尝试读取旧 session.json，合并统计数据（deleteCrewDir 保留了该文件）
  const oldMeta = await loadSessionMeta(sharedDir);

  const session = {
    id: sessionId,
    projectDir,
    sharedDir,
    name: name || '',
    roles: new Map(roles.map(r => [r.name, r])),
    roleStates: new Map(),
    decisionMaker,
    status: 'initializing',
    round: oldMeta?.round || 0,
    costUsd: oldMeta?.costUsd || 0,
    totalInputTokens: oldMeta?.totalInputTokens || 0,
    totalOutputTokens: oldMeta?.totalOutputTokens || 0,
    messageHistory: [],
    uiMessages: [],
    humanMessageQueue: [],
    waitingHumanContext: null,
    pendingRoutes: [],
    features: new Map((oldMeta?.features || []).map(f => [f.taskId, f])),
    _completedTaskIds: new Set(oldMeta?._completedTaskIds || []),
    initProgress: null,
    userId,
    username,
    agentId: ctx.CONFIG?.agentName || null,
    teamType,
    language,
    createdAt: oldMeta?.createdAt || Date.now()
  };

  if (oldMeta) {
    console.log(`[Crew] Merged stats from previous session: round=${session.round}, cost=$${session.costUsd.toFixed(4)}, inputTokens=${session.totalInputTokens}, outputTokens=${session.totalOutputTokens}`);
    // 恢复旧消息历史（deleteCrewDir 保留了 messages*.json）
    const loaded = await loadSessionMessages(sharedDir);
    if (loaded.messages.length > 0) {
      session.uiMessages = loaded.messages;
      console.log(`[Crew] Restored ${loaded.messages.length} messages from previous session`);
    }
  }

  crewSessions.set(sessionId, session);

  // 如果有旧消息，检查是否有更早的分片
  const hasOlderMessages = oldMeta ? await getMaxShardIndex(sharedDir) > 0 : false;

  sendCrewMessage({
    type: 'crew_session_created',
    sessionId,
    projectDir,
    sharedDir,
    name: name || '',
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
    userId,
    username,
    // 旧消息（recreate 时保留的历史）
    uiMessages: session.uiMessages.length > 0 ? session.uiMessages : undefined,
    hasOlderMessages: hasOlderMessages || undefined
  });

  sendStatusUpdate(session);

  try {
    session.initProgress = 'roles';
    sendStatusUpdate(session);
    await initSharedDir(sharedDir, roles, projectDir, language);

    const groupIndices = [...new Set(roles.filter(r => r.groupIndex > 0).map(r => r.groupIndex))];
    if (groupIndices.length > 0) {
      session.initProgress = 'worktrees';
      sendStatusUpdate(session);
    }
    const worktreeMap = await initWorktrees(projectDir, roles);

    for (const role of roles) {
      if (role.groupIndex > 0 && worktreeMap.has(role.groupIndex)) {
        role.workDir = worktreeMap.get(role.groupIndex);
        await writeRoleClaudeMd(sharedDir, role, language, roles);
      }
    }

    await upsertCrewIndex(session);
    await saveSessionMeta(session);

    if (session.status === 'initializing') {
      session.status = 'running';
    }
    session.initProgress = null;
    sendStatusUpdate(session);
  } catch (e) {
    console.error('[Crew] Session initialization failed:', e);
    if (session.status === 'initializing') {
      session.status = 'running';
    }
    session.initProgress = null;
    sendStatusUpdate(session);
    sendCrewMessage({
      type: 'crew_output',
      sessionId,
      roleName: 'system',
      roleIcon: 'S',
      roleDisplayName: '系统',
      content: `工作环境初始化失败: ${e.message}`,
      isTurnEnd: true
    });
  }

  return session;
}

// =====================================================================
// List & Resume Sessions
// =====================================================================

/**
 * 列出所有 crew sessions
 */
export async function handleListCrewSessions(msg) {
  const { requestId, _requestClientId } = msg;
  const index = await loadCrewIndex();

  const agentId = ctx.CONFIG?.agentName || null;
  const filtered = agentId
    ? index.filter(e => !e.agentId || e.agentId === agentId)
    : index;

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
      let sessionInfo = null;
      try {
        const sessionPath = join(crewDir, 'session.json');
        const data = await fs.readFile(sessionPath, 'utf-8');
        sessionInfo = JSON.parse(data);
      } catch {}
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
 * 删除 Crew 定义文件（模板/角色配置），保留所有用户数据和工作产出
 *
 * 删除: CLAUDE.md（共享模板）、roles/（角色模板）
 * 清空: sessions/ 下的文件（旧角色的 Claude Code session IDs，已失效）
 * 保留: context/、session.json、messages*.json 及任何其他生成文件（截图、设计文档等）
 */
export async function handleDeleteCrewDir(msg) {
  const { projectDir } = msg;
  if (!isValidProjectDir(projectDir)) return;
  const crewDir = join(projectDir, '.crew');
  try {
    // 删除 Crew 模板定义
    await fs.rm(join(crewDir, 'CLAUDE.md'), { force: true }).catch(() => {});
    await fs.rm(join(crewDir, 'roles'), { recursive: true, force: true }).catch(() => {});

    // 清空 sessions/ 内容（旧角色的 session IDs 已失效），保留目录本身
    const sessionsDir = join(crewDir, 'sessions');
    try {
      const sessionFiles = await fs.readdir(sessionsDir);
      await Promise.all(
        sessionFiles.map(f => fs.rm(join(sessionsDir, f), { force: true }).catch(() => {}))
      );
    } catch { /* sessions/ may not exist */ }
  } catch {}
}

/**
 * 恢复已停止的 crew session
 */
export async function resumeCrewSession(msg) {
  const { sessionId, userId, username } = msg;

  if (crewSessions.has(sessionId)) {
    const session = crewSessions.get(sessionId);
    const roles = Array.from(session.roles.values());
    if ((!session.uiMessages || session.uiMessages.length === 0) && session.sharedDir) {
      const loaded = await loadSessionMessages(session.sharedDir);
      session.uiMessages = loaded.messages;
    }
    const cleanedMessages = (session.uiMessages || []).map(m => {
      const { _streaming, ...rest } = m;
      return rest;
    });
    const hasOlderMessages = await getMaxShardIndex(session.sharedDir) > 0;

    sendCrewMessage({
      type: 'crew_session_restored',
      sessionId,
      projectDir: session.projectDir,
      sharedDir: session.sharedDir,
      name: session.name || '',
      roles: roles.map(r => ({
        name: r.name, displayName: r.displayName, icon: r.icon,
        description: r.description, isDecisionMaker: r.isDecisionMaker || false,
        groupIndex: r.groupIndex, roleType: r.roleType, model: r.model
      })),
      decisionMaker: session.decisionMaker,
      userId: session.userId,
      username: session.username,
      uiMessages: cleanedMessages,
      hasOlderMessages
    });
    sendStatusUpdate(session);
    return;
  }

  const index = await loadCrewIndex();
  const indexEntry = index.find(e => e.sessionId === sessionId);
  if (!indexEntry) {
    sendCrewMessage({ type: 'error', sessionId, message: 'Crew session not found in index' });
    return;
  }

  const meta = await loadSessionMeta(indexEntry.sharedDir);
  if (!meta) {
    sendCrewMessage({ type: 'error', sessionId, message: 'Crew session metadata not found' });
    return;
  }

  const roles = meta.roles || [];
  const decisionMaker = meta.decisionMaker || roles[0]?.name || null;
  const session = {
    id: sessionId,
    projectDir: meta.projectDir,
    sharedDir: meta.sharedDir || indexEntry.sharedDir,
    name: meta.name || '',
    roles: new Map(roles.map(r => [r.name, r])),
    roleStates: new Map(),
    decisionMaker,
    status: 'waiting_human',
    round: meta.round || 0,
    costUsd: meta.costUsd || 0,
    totalInputTokens: meta.totalInputTokens || 0,
    totalOutputTokens: meta.totalOutputTokens || 0,
    messageHistory: [],
    uiMessages: [],
    humanMessageQueue: [],
    waitingHumanContext: null,
    pendingRoutes: [],
    features: new Map((meta.features || []).map(f => [f.taskId, f])),
    _completedTaskIds: new Set(meta._completedTaskIds || []),
    userId: userId || meta.userId,
    username: username || meta.username,
    agentId: meta.agentId || ctx.CONFIG?.agentName || null,
    teamType: meta.teamType || 'dev',
    language: meta.language || 'zh-CN',
    createdAt: meta.createdAt || Date.now()
  };
  crewSessions.set(sessionId, session);

  const loaded = await loadSessionMessages(session.sharedDir);
  session.uiMessages = loaded.messages;

  sendCrewMessage({
    type: 'crew_session_restored',
    sessionId,
    projectDir: session.projectDir,
    sharedDir: session.sharedDir,
    name: session.name || '',
    roles: roles.map(r => ({
      name: r.name, displayName: r.displayName, icon: r.icon,
      description: r.description, isDecisionMaker: r.isDecisionMaker || false,
      groupIndex: r.groupIndex, roleType: r.roleType, model: r.model
    })),
    decisionMaker,
    userId: session.userId,
    username: session.username,
    uiMessages: session.uiMessages,
    hasOlderMessages: loaded.hasOlderMessages
  });
  sendStatusUpdate(session);

  await upsertCrewIndex(session);
  await saveSessionMeta(session);

  console.log(`[Crew] Session ${sessionId} resumed, waiting for human input`);
}

/**
 * 更新 crew session 的 name
 */
export async function handleUpdateCrewSession(msg) {
  const { sessionId, name } = msg;
  const session = crewSessions.get(sessionId);
  if (!session) {
    console.warn(`[Crew] Session not found for update: ${sessionId}`);
    return;
  }
  if (name !== undefined) session.name = name;
  await saveSessionMeta(session);
  await upsertCrewIndex(session);
}
