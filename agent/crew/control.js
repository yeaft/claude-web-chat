/**
 * Crew — 控制操作
 * pause, resume, stop, clear, abort, interrupt 等
 */
import { join } from 'path';
import { promises as fs } from 'fs';
import { sendCrewMessage, sendCrewOutput, sendStatusUpdate, endRoleStreaming } from './ui-messages.js';
import { saveRoleSessionId, clearRoleSessionId, createRoleQuery } from './role-query.js';
import { saveSessionMeta, cleanupMessageShards } from './persistence.js';
import { executeRoute, dispatchToRole } from './routing.js';
import { cleanupWorktrees } from './worktree.js';
import { upsertCrewIndex } from './persistence.js';
import { processHumanQueue } from './human-interaction.js';

/**
 * 处理控制命令
 */
export async function handleCrewControl(msg) {
  // Lazy import to avoid circular dependency
  const { crewSessions } = await import('./session.js');

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
    case 'abort_role':
      if (targetRole) await abortRole(session, targetRole);
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
 * 清空单个角色的对话
 */
async function clearSingleRole(session, roleName) {
  const roleState = session.roleStates.get(roleName);

  if (roleState) {
    if (roleState.abortController) {
      roleState.abortController.abort();
    }
    roleState.query = null;
    roleState.inputStream = null;
    roleState.turnActive = false;
    roleState.claudeSessionId = null;
    roleState.consecutiveErrors = 0;
    roleState.accumulatedText = '';
    roleState.lastDispatchContent = null;
    roleState.lastDispatchFrom = null;
    roleState.lastDispatchTaskId = null;
    roleState.lastDispatchTaskTitle = null;
  }

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
 * 暂停所有角色
 */
async function pauseAll(session) {
  session.status = 'paused';

  for (const [roleName, roleState] of session.roleStates) {
    if (roleState.claudeSessionId) {
      await saveRoleSessionId(session.sharedDir, roleName, roleState.claudeSessionId)
        .catch(e => console.warn(`[Crew] Failed to save sessionId for ${roleName}:`, e.message));
    }
    if (roleState.abortController) {
      roleState.abortController.abort();
    }
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

  await saveSessionMeta(session);
}

/**
 * 恢复 session
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

  await processHumanQueue(session);
}

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

  endRoleStreaming(session, roleName);

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
  roleState.accumulatedText = '';

  sendCrewMessage({
    type: 'crew_turn_completed',
    sessionId: session.id,
    role: roleName,
    interrupted: true
  });

  sendStatusUpdate(session);

  sendCrewOutput(session, 'system', 'system', {
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text: `${roleName} 被中断` }] }
  });

  await dispatchToRole(session, roleName, newContent, fromSource);
}

/**
 * 中止角色当前 turn
 */
async function abortRole(session, roleName) {
  const roleState = session.roleStates.get(roleName);
  if (!roleState) {
    console.warn(`[Crew] Cannot abort ${roleName}: no roleState`);
    return;
  }

  if (!roleState.turnActive) {
    console.log(`[Crew] ${roleName} is not active, nothing to abort`);
    return;
  }

  console.log(`[Crew] Aborting ${roleName}`);

  endRoleStreaming(session, roleName);

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
  roleState.accumulatedText = '';

  sendCrewMessage({
    type: 'crew_turn_completed',
    sessionId: session.id,
    role: roleName,
    interrupted: true
  });

  sendStatusUpdate(session);

  sendCrewOutput(session, 'system', 'system', {
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text: `${roleName} 已中止` }] }
  });
}

async function stopRole(session, roleName) {
  const roleState = session.roleStates.get(roleName);
  if (roleState) {
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
  const { crewSessions } = await import('./session.js');

  session.status = 'stopped';

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

  await cleanupWorktrees(session.projectDir);

  await saveSessionMeta(session);
  await upsertCrewIndex(session);

  crewSessions.delete(session.id);
  console.log(`[Crew] Session ${session.id} stopped`);
}

/**
 * 清空 session
 */
async function clearSession(session) {
  for (const [roleName, roleState] of session.roleStates) {
    if (roleState.abortController) {
      roleState.abortController.abort();
    }
    console.log(`[Crew] Clearing role: ${roleName}`);
  }
  session.roleStates.clear();

  for (const [roleName] of session.roles) {
    await clearRoleSessionId(session.sharedDir, roleName);
  }

  session.messageHistory = [];
  session.uiMessages = [];
  session.humanMessageQueue = [];
  session.waitingHumanContext = null;
  session.pendingRoutes = [];

  session.round = 0;

  const messagesPath = join(session.sharedDir, 'messages.json');
  await fs.writeFile(messagesPath, '[]').catch(() => {});
  await cleanupMessageShards(session.sharedDir);

  session.status = 'running';

  sendCrewMessage({
    type: 'crew_session_cleared',
    sessionId: session.id
  });

  sendCrewOutput(session, 'system', 'system', {
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text: '会话已清空，所有角色将使用全新对话' }] }
  });
  sendStatusUpdate(session);

  await saveSessionMeta(session);

  console.log(`[Crew] Session ${session.id} cleared`);
}
