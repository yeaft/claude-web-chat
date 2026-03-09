/**
 * Crew — 路由解析与执行
 * parseRoutes, executeRoute, buildRoutePrompt, dispatchToRole
 */
import { join } from 'path';
import { sendCrewMessage, sendCrewOutput, sendStatusUpdate } from './ui-messages.js';
import { ensureTaskFile, appendTaskRecord, readTaskFile, updateKanban, readKanban } from './task-files.js';
import { createRoleQuery } from './role-query.js';

/** Format role label */
function roleLabel(r) {
  return r.icon ? `${r.icon} ${r.displayName}` : r.displayName;
}

/**
 * 从累积文本中解析所有 ROUTE 块（支持多 ROUTE + task 字段）
 * @returns {Array<{ to, summary, taskId, taskTitle }>}
 */
export function parseRoutes(text) {
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
export async function executeRoute(session, fromRole, route) {
  const { to, summary, taskId, taskTitle } = route;

  // 如果 session 已暂停或停止，保存为 pendingRoutes
  if (session.status === 'paused' || session.status === 'stopped') {
    session.pendingRoutes.push({ fromRole, route });
    console.log(`[Crew] Session ${session.status}, route saved as pending: ${fromRole} -> ${to}`);
    return;
  }

  // Task 文件自动管理（fire-and-forget）
  if (taskId && summary) {
    const fromRoleConfig = session.roles.get(fromRole);
    if (fromRoleConfig?.isDecisionMaker && taskTitle && to !== 'human') {
      ensureTaskFile(session, taskId, taskTitle, to, summary)
        .catch(e => console.warn(`[Crew] Failed to create task file ${taskId}:`, e.message));
    }
    appendTaskRecord(session, taskId, fromRole, summary)
      .catch(e => console.warn(`[Crew] Failed to append task record ${taskId}:`, e.message));

    // 更新工作看板：推断状态
    const { getMessages } = await import('../crew-i18n.js');
    const m = getMessages(session.language || 'zh-CN');
    const toRoleConfig = session.roles.get(to);
    let status = m.kanbanStatusDev;
    if (toRoleConfig) {
      switch (toRoleConfig.roleType) {
        case 'reviewer': status = m.kanbanStatusReview; break;
        case 'tester': status = m.kanbanStatusTest; break;
        default:
          if (toRoleConfig.isDecisionMaker) status = m.kanbanStatusDecision;
      }
    }
    updateKanban(session, {
      taskId, taskTitle, assignee: to,
      status, summary: summary.substring(0, 100)
    }).catch(e => console.warn(`[Crew] Failed to update kanban:`, e.message));
  }

  // 发送路由消息（UI 显示）
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
    if (session.humanMessageQueue.length > 0) {
      const { processHumanQueue } = await import('./human-interaction.js');
      await processHumanQueue(session);
    } else {
      const taskPrompt = buildRoutePrompt(fromRole, summary, session);
      await dispatchToRole(session, to, taskPrompt, fromRole, taskId, taskTitle);
    }
  } else {
    console.warn(`[Crew] Unknown route target: ${to}`);
    const errorMsg = `路由目标 "${to}" 不存在。来自 ${fromRole} 的消息: ${summary}`;
    await dispatchToRole(session, session.decisionMaker, errorMsg, 'system');
  }
}

/**
 * 构建路由转发的 prompt
 */
export function buildRoutePrompt(fromRole, summary, session) {
  const fromRoleConfig = session.roles.get(fromRole);
  const fromName = fromRoleConfig ? roleLabel(fromRoleConfig) : fromRole;
  return `来自 ${fromName} 的消息:\n${summary}\n\n请开始你的工作。完成后通过 ROUTE 块传递给下一个角色。`;
}

/**
 * 向角色发送消息
 */
export async function dispatchToRole(session, roleName, content, fromSource, taskId, taskTitle) {
  if (session.status === 'paused' || session.status === 'stopped' || session.status === 'initializing') {
    console.log(`[Crew] Session ${session.status}, skipping dispatch to ${roleName}`);
    return;
  }

  let roleState = session.roleStates.get(roleName);

  // 如果角色没有 query 实例，创建一个（支持 resume）
  if (!roleState || !roleState.query || !roleState.inputStream) {
    roleState = await createRoleQuery(session, roleName);
  }

  // 设置 task
  if (taskId) {
    roleState.currentTask = { taskId, taskTitle };
  }

  // Task 上下文注入
  const effectiveTaskId = taskId || roleState.currentTask?.taskId;
  if (effectiveTaskId && typeof content === 'string') {
    const taskContent = await readTaskFile(session, effectiveTaskId);
    if (taskContent) {
      content = `${content}\n\n---\n<task-context file="context/features/${effectiveTaskId}.md">\n${taskContent}\n</task-context>`;
    }
  }

  // 看板上下文注入（角色重启后知道全局状态）
  if (typeof content === 'string') {
    const kanbanContent = await readKanban(session);
    if (kanbanContent) {
      content = `${content}\n\n---\n<kanban file="context/kanban.md">\n${kanbanContent}\n</kanban>`;
    }
  }

  // 最近路由消息注入（帮助 clear 后的角色恢复上下文）
  if (typeof content === 'string' && session.messageHistory.length > 0) {
    const recentRoutes = session.messageHistory
      .filter(m => m.from !== 'system')
      .slice(-5)
      .map(m => `[${m.from} → ${m.to}${m.taskId ? ` (${m.taskId})` : ''}] ${m.content}`)
      .join('\n');
    if (recentRoutes) {
      content = `${content}\n\n---\n<recent-routes>\n${recentRoutes}\n</recent-routes>`;
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
