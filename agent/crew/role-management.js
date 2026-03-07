/**
 * Crew — 动态角色管理
 * addRoleToSession, removeRoleFromSession
 */
import { initRoleDir, updateSharedClaudeMd } from './shared-dir.js';
import { saveRoleSessionId } from './role-query.js';
import { sendCrewMessage, sendCrewOutput, sendStatusUpdate } from './ui-messages.js';

/** Format role label */
function roleLabel(r) {
  return r.icon ? `${r.icon} ${r.displayName}` : r.displayName;
}

/**
 * 向现有 session 动态添加角色
 */
export async function addRoleToSession(msg) {
  // Lazy import to avoid circular dependency
  const { crewSessions, expandRoles } = await import('./session.js');

  const { sessionId, role } = msg;
  const session = crewSessions.get(sessionId);
  if (!session) {
    console.warn(`[Crew] Session not found: ${sessionId}`);
    return;
  }

  const rolesToAdd = expandRoles([role]);

  for (const r of rolesToAdd) {
    if (session.roles.has(r.name)) {
      console.warn(`[Crew] Role already exists: ${r.name}`);
      continue;
    }

    session.roles.set(r.name, r);

    if (r.isDecisionMaker) {
      session.decisionMaker = r.name;
    }
    if (!session.decisionMaker) {
      session.decisionMaker = r.name;
    }

    await initRoleDir(session.sharedDir, r, session.language || 'zh-CN');

    console.log(`[Crew] Role added: ${r.name} (${r.displayName}) to session ${sessionId}`);

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

    sendCrewOutput(session, 'system', 'system', {
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: `${roleLabel(r)} 加入了群聊` }] }
    });
  }

  await updateSharedClaudeMd(session);
  sendStatusUpdate(session);
}

/**
 * 从 session 移除角色
 */
export async function removeRoleFromSession(msg) {
  const { crewSessions } = await import('./session.js');

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

  // 停止角色的 query
  const roleState = session.roleStates.get(roleName);
  if (roleState) {
    if (roleState.claudeSessionId) {
      await saveRoleSessionId(session.sharedDir, roleName, roleState.claudeSessionId);
    }
    if (roleState.abortController) {
      roleState.abortController.abort();
    }
    session.roleStates.delete(roleName);
  }

  session.roles.delete(roleName);

  if (session.decisionMaker === roleName) {
    const remaining = Array.from(session.roles.values());
    const newDM = remaining.find(r => r.isDecisionMaker) || remaining[0];
    session.decisionMaker = newDM?.name || null;
  }

  await updateSharedClaudeMd(session);

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
