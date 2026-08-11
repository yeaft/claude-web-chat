/**
 * Shared ownership checks and stream-json projection for asynchronous tasks.
 */

import { TASK_RESULT_DELIVERY, isTerminalTaskStatus, taskResultDeliveryFor } from './store.js';
import { formatTaskResultForVp } from './result-format.js';

function cleanString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function taskThreadId(task) {
  return cleanString(task?.source?.threadId) || cleanString(task?.runtime?.threadId) || 'main';
}

function publicTaskSnapshot(task) {
  return {
    id: task.id,
    sessionId: task.sessionId,
    ownerVpId: cleanString(task.ownerVpId),
    kind: task.kind || 'tool',
    status: task.status || 'unknown',
    resultDelivery: taskResultDeliveryFor(task),
    createdAt: task.createdAt || null,
    startedAt: task.startedAt || null,
    updatedAt: task.updatedAt || null,
    endedAt: task.endedAt || null,
  };
}

/**
 * Project one TaskManager event for an active stream-json Session.
 * Returns null for sibling, malformed, or unowned Session events.
 */
export function projectStreamTaskEvent(event, { sessionId } = {}) {
  const task = event?.task;
  const activeSessionId = cleanString(sessionId);
  const taskSessionId = cleanString(task?.sessionId);
  if (!event || typeof event !== 'object' || !task?.id || !activeSessionId || taskSessionId !== activeSessionId) {
    return null;
  }
  const vpId = cleanString(task.ownerVpId);
  const threadId = taskThreadId(task);
  return {
    type: 'task',
    subtype: event.event || 'updated',
    session_id: activeSessionId,
    task_id: task.id,
    taskId: task.id,
    ...(vpId ? { vp_id: vpId, vpId } : {}),
    thread_id: threadId,
    threadId,
    task: publicTaskSnapshot(task),
  };
}

/**
 * Build owner-scoped model context for a terminal model-reentry task.
 * When an expected owner is supplied, Session, VP, and thread must match
 * exactly before sensitive task details are formatted.
 */
export function taskResultReentryContext(event, { sessionId = null, owner = null } = {}) {
  if (!event || event.event !== 'completed' || !event.task) return null;
  const task = event.task;
  if (!task.id
      || !isTerminalTaskStatus(task.status)
      || taskResultDeliveryFor(task) !== TASK_RESULT_DELIVERY.MODEL_REENTRY) return null;
  const taskSessionId = cleanString(task.sessionId);
  const activeSessionId = cleanString(sessionId);
  if (!taskSessionId || (activeSessionId && taskSessionId !== activeSessionId)) return null;
  const vpId = cleanString(task.ownerVpId);
  const threadId = taskThreadId(task);
  if (owner) {
    if (cleanString(owner.sessionId) !== taskSessionId) return null;
    if (cleanString(owner.vpId) !== vpId) return null;
    if ((cleanString(owner.threadId) || 'main') !== threadId) return null;
  }
  return {
    task,
    sessionId: taskSessionId,
    vpId,
    threadId,
    content: formatTaskResultForVp(task),
    metadata: {
      preview: `task ${task.kind || 'tool'} ${task.status || 'completed'}`,
      sessionId: taskSessionId,
      vpId,
      threadId,
      taskKind: task.kind,
      taskStatus: task.status,
    },
  };
}

/** Deliver to a still-running exact owner Engine. */
export function notifyPendingTaskOwner(event, asyncTaskOwners, { sessionId = null } = {}) {
  const taskId = event?.task?.id;
  const owner = taskId ? asyncTaskOwners?.get?.(taskId) : null;
  if (!owner?.engine) return false;
  const context = taskResultReentryContext(event, { sessionId, owner });
  if (!context) return false;
  const engine = owner.engine;
  if (typeof engine.ownsPendingAsyncTask !== 'function'
      || !engine.ownsPendingAsyncTask(taskId)
      || typeof engine.notifyAsyncTaskCompleted !== 'function') return false;
  try {
    return engine.notifyAsyncTaskCompleted(taskId, context.content, context.metadata) === true;
  } catch {
    return false;
  }
}

/** Project and, when ownership matches, deliver one TaskManager event. */
export function emitStreamTaskEvent({ event, asyncTaskOwners, write, sessionId }) {
  const frame = projectStreamTaskEvent(event, { sessionId });
  if (!frame) return { projected: false, delivered: false };
  if (typeof write === 'function') write(frame);
  return {
    projected: true,
    delivered: notifyPendingTaskOwner(event, asyncTaskOwners, { sessionId }),
  };
}
