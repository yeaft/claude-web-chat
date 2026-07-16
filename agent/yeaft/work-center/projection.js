import { reconstructDebugRawRequest } from '../debug-trace.js';
import {
  enforceActionRequestDetailBudget,
  sanitizeDebugValue,
  sanitizeDiagnosticText,
} from './debug-projection.js';
import { normalizeActionBrief } from './workflow.js';

const MAX_ACTION_MESSAGE_CHARS = 16_000;
const MAX_ACTION_DIAGNOSTIC_CHARS = 8_000;
const MAX_ACTION_MESSAGES = 20;

function currentAction(detail) {
  if (!detail?.currentActionId || !Array.isArray(detail.actions)) return null;
  return detail.actions.find(action => action.id === detail.currentActionId) || null;
}

function count(value) {
  return Math.max(0, Number(value) || 0);
}

function emptyExecutionStats() {
  return {
    llmRequestCount: 0,
    loopCount: 0,
    toolCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
  };
}

function executionStats(value) {
  const stats = emptyExecutionStats();
  for (const key of Object.keys(stats)) stats[key] = count(value?.[key]);
  return stats;
}

function sumExecutionStats(values) {
  return values.reduce((total, value) => {
    const next = executionStats(value);
    for (const key of Object.keys(total)) total[key] += next[key];
    return total;
  }, emptyExecutionStats());
}

function normalizeProjectedMessage(message) {
  if (!message || typeof message !== 'object') return null;
  const text = typeof message.text === 'string'
    ? message.text.trim().slice(0, MAX_ACTION_MESSAGE_CHARS)
    : '';
  const attachments = projectAttachments(message.attachments);
  if (!text && attachments.length === 0) return null;
  return {
    id: String(message.id || ''),
    role: message.role === 'user' ? 'user' : 'assistant',
    kind: message.kind === 'input' ? 'input' : 'response',
    status: message.status || null,
    text,
    attachments,
    createdAt: count(message.createdAt),
    updatedAt: count(message.updatedAt || message.createdAt),
    ...(message.progressRevision == null ? {} : { progressRevision: count(message.progressRevision) }),
  };
}

function actionInputMessages(action, events) {
  return (Array.isArray(events) ? events : [])
    .filter(event => event?.actionId === action?.id
      && ['action.guidance_added', 'action.input_added'].includes(event.type))
    .map(event => normalizeProjectedMessage({
      id: `event:${event.id}`,
      role: 'user',
      kind: 'input',
      status: 'sent',
      text: event.data?.text || event.data?.guidance || '',
      attachments: event.data?.attachments,
      createdAt: event.createdAt,
    }))
    .filter(Boolean);
}

function runResponseMessage(run) {
  return normalizeProjectedMessage({
    id: `run:${run.id}`,
    role: 'assistant',
    kind: 'response',
    status: run.status || 'running',
    text: typeof run.response === 'string' ? run.response : '',
    createdAt: count(run.startedAt),
    updatedAt: count(run.endedAt || run.startedAt),
    progressRevision: count(run.progressRevision),
  });
}

function actionMessages(action, runs, events) {
  const matchingRuns = Array.isArray(runs)
    ? runs.filter(run => run?.actionId === action?.id)
    : [];
  return [...actionInputMessages(action, events), ...matchingRuns
    .sort((left, right) => count(left.startedAt) - count(right.startedAt))
    .map(run => runResponseMessage(run))
    .filter(Boolean)]
    .sort((left, right) => left.createdAt - right.createdAt
      || (left.role === 'user' ? -1 : 1)
      || left.id.localeCompare(right.id));
}

function actionExecution(action, runs, events) {
  const matchingRuns = Array.isArray(runs)
    ? runs.filter(run => run?.actionId === action?.id)
    : [];
  if (matchingRuns.length === 0) {
    const messages = Array.isArray(action?.messages)
      ? action.messages.map(normalizeProjectedMessage).filter(Boolean)
      : actionInputMessages(action, events);
    return {
      ...executionStats(action?.executionStats || action),
      response: typeof action?.response === 'string' ? action.response : '',
      failure: action?.failure && typeof action.failure === 'object'
        ? {
            error: sanitizeDiagnosticText(action.failure.error, MAX_ACTION_DIAGNOSTIC_CHARS),
            summary: sanitizeDiagnosticText(action.failure.summary, MAX_ACTION_DIAGNOSTIC_CHARS),
            failedAt: count(action.failure.failedAt),
          }
        : null,
      progressRevision: count(action?.progressRevision),
      messages,
      liveMessage: normalizeProjectedMessage(action?.liveMessage),
      messageCount: count(action?.messageCount) || messages.length,
      messageCursor: action?.messageCursor == null ? null : String(action.messageCursor),
    };
  }
  const stats = sumExecutionStats(matchingRuns);
  const latest = [...matchingRuns].sort((left, right) => (
    count(right.progressRevision) - count(left.progressRevision)
      || count(right.startedAt) - count(left.startedAt)
  ))[0];
  const latestFailure = action?.status === 'failed'
    ? [...matchingRuns]
        .filter(run => run?.status === 'failed')
        .sort((left, right) => count(right.endedAt || right.startedAt) - count(left.endedAt || left.startedAt))[0]
    : null;
  const allMessages = actionMessages(action, matchingRuns, events);
  const messages = allMessages.slice(-MAX_ACTION_MESSAGES);
  const liveMessage = runResponseMessage(latest);
  return {
    ...stats,
    response: typeof latest?.response === 'string' ? latest.response : '',
    failure: latestFailure ? {
      error: sanitizeDiagnosticText(latestFailure.error, MAX_ACTION_DIAGNOSTIC_CHARS),
      summary: sanitizeDiagnosticText(latestFailure.summary, MAX_ACTION_DIAGNOSTIC_CHARS),
      failedAt: count(latestFailure.endedAt || latestFailure.startedAt),
    } : null,
    progressRevision: count(latest?.progressRevision),
    messages,
    liveMessage,
    messageCount: allMessages.length,
    messageCursor: allMessages.length > messages.length
      ? String(allMessages.length - messages.length)
      : null,
  };
}

function projectAttachments(value) {
  if (!Array.isArray(value)) return [];
  return value.map(attachment => ({
    id: attachment.id,
    name: attachment.name,
    mimeType: attachment.mimeType,
    size: count(attachment.size),
    isImage: attachment.isImage === true,
  }));
}

function projectAssignmentPolicy(policy) {
  if (!policy || typeof policy !== 'object') return null;
  return {
    mode: policy.mode || null,
    capability: policy.capability || null,
    fixedVpId: policy.fixedVpId || null,
  };
}

function projectAction(action, runs, events) {
  if (!action) return null;
  const execution = actionExecution(action, runs, events);
  const alreadyProjected = !Array.isArray(runs) && Array.isArray(action.messages);
  return {
    id: action.id,
    sequence: action.sequence,
    type: action.type,
    stageId: action.stageId || action.type,
    assignmentPolicy: alreadyProjected
      ? (action.assignmentPolicy || null)
      : projectAssignmentPolicy(action.assignmentPolicy),
    dependsOnStageIds: Array.isArray(action.dependsOnStageIds) ? action.dependsOnStageIds : [],
    workspaceMode: action.workspaceMode || 'shared',
    requiredRole: action.requiredRole || '',
    brief: alreadyProjected ? (action.brief || null) : normalizeActionBrief(action.brief, action.type),
    status: action.status,
    executionStats: executionStats(execution),
    loopCount: execution.loopCount,
    toolCount: execution.toolCount,
    response: execution.response,
    failure: execution.failure,
    progressRevision: execution.progressRevision,
    messages: execution.messages,
    liveMessage: execution.liveMessage,
    messageCount: execution.messageCount,
    messageCursor: execution.messageCursor,
  };
}

function projectActionStats(detail) {
  if (!Array.isArray(detail?.actions)) return [];
  return detail.actions.map(action => {
    const projected = projectAction(action, detail.runs, detail.events);
    return {
      id: projected.id,
      status: projected.status,
      executionStats: projected.executionStats,
      loopCount: projected.loopCount,
      toolCount: projected.toolCount,
      response: projected.response,
      failure: projected.failure,
      progressRevision: projected.progressRevision,
      ...(projected.liveMessage ? { liveMessage: projected.liveMessage } : {}),
    };
  });
}

function waitingReason(detail) {
  if (typeof detail?.waitingReason === 'string') return detail.waitingReason;
  if (detail?.status !== 'waiting' || !Array.isArray(detail.runs)) return '';
  return detail.runs.find(run => (
    run?.actionId === detail.currentActionId && typeof run.waitingReason === 'string'
  ))?.waitingReason || '';
}

/**
 * Authenticated browser detail DTO. Raw execution records stay Agent-local;
 * the browser receives only aggregate execution stats plus the explicit user-facing response.
 */
export function projectWorkItemDetail(detail) {
  if (!detail) return null;
  return {
    id: detail.id,
    revision: detail.revision,
    title: detail.title,
    goal: detail.goal,
    acceptanceCriteria: Array.isArray(detail.acceptanceCriteria) ? detail.acceptanceCriteria : [],
    workflowTemplate: detail.workflowTemplate,
    workItemType: detail.workflowSnapshot?.workItemType || detail.workItemType || null,
    planningMode: detail.workflowSnapshot?.planningMode || detail.planningMode || 'static',
    executionMode: detail.workflowSnapshot?.executionMode || detail.executionMode || 'linear',
    status: detail.status,
    currentActionId: detail.currentActionId || null,
    executionStats: Array.isArray(detail.runs)
      ? sumExecutionStats(detail.runs)
      : executionStats(detail.executionStats),
    reuseMemory: detail.reuseMemory !== false,
    waitingReason: sanitizeDiagnosticText(waitingReason(detail), MAX_ACTION_DIAGNOSTIC_CHARS),
    origin: detail.origin?.sessionId ? { sessionId: detail.origin.sessionId } : null,
    linkedSessionIds: Array.isArray(detail.linkedSessionIds) ? detail.linkedSessionIds : [],
    attachments: projectAttachments(detail.attachments),
    createdAt: detail.createdAt,
    updatedAt: detail.updatedAt,
    actionCount: Array.isArray(detail.actions) ? detail.actions.length : count(detail.actionCount),
    actionSummary: Array.isArray(detail.actions)
      ? detail.actions.map(action => action.type).filter(Boolean).join(' → ')
      : String(detail.actionSummary || ''),
    actions: Array.isArray(detail.actions)
      ? detail.actions.map(action => projectAction(action, detail.runs, detail.events))
      : [],
  };
}

/**
 * Browser list projection. This deliberately excludes local filesystem paths
 * and all Run-level execution detail.
 */
export function projectWorkItemSummary(detail) {
  if (!detail) return null;
  if (!Array.isArray(detail.actions)) {
    return {
      id: detail.id,
      revision: detail.revision,
      title: detail.title,
      goal: detail.goal,
      workItemType: detail.workflowSnapshot?.workItemType || detail.workItemType || null,
      planningMode: detail.workflowSnapshot?.planningMode || detail.planningMode || 'static',
      status: detail.status,
      currentActionId: detail.currentActionId || null,
      currentAction: null,
      executionStats: executionStats(detail.executionStats),
      origin: detail.origin?.sessionId ? { sessionId: detail.origin.sessionId } : null,
      linkedSessionIds: Array.isArray(detail.linkedSessionIds) ? detail.linkedSessionIds : [],
      attachmentCount: Array.isArray(detail.attachments) ? detail.attachments.length : 0,
      createdAt: detail.createdAt,
      updatedAt: detail.updatedAt,
    };
  }
  const action = currentAction(detail);
  const projectedAction = action ? projectAction(action, detail.runs, detail.events) : null;
  return {
    id: detail.id,
    revision: detail.revision,
    title: detail.title,
    goal: detail.goal,
    workItemType: detail.workflowSnapshot?.workItemType || detail.workItemType || null,
    planningMode: detail.workflowSnapshot?.planningMode || detail.planningMode || 'static',
    executionMode: detail.workflowSnapshot?.executionMode || detail.executionMode || 'linear',
    status: detail.status,
    currentActionId: detail.currentActionId || null,
    executionStats: Array.isArray(detail.runs)
      ? sumExecutionStats(detail.runs)
      : executionStats(detail.executionStats),
    currentAction: projectedAction ? {
      id: projectedAction.id,
      type: projectedAction.type,
      stageId: projectedAction.stageId,
      assignmentMode: projectedAction.assignmentPolicy?.mode || (projectedAction.requiredRole ? 'fixed' : null),
      status: projectedAction.status,
    } : null,
    origin: detail.origin?.sessionId ? { sessionId: detail.origin.sessionId } : null,
    linkedSessionIds: Array.isArray(detail.linkedSessionIds) ? detail.linkedSessionIds : [],
    attachmentCount: Array.isArray(detail.attachments) ? detail.attachments.length : 0,
    createdAt: detail.createdAt,
    updatedAt: detail.updatedAt,
  };
}

export function projectWorkCenterEvent(event) {
  return {
    type: event?.type || 'work_item.updated',
    workItem: {
      ...projectWorkItemSummary(event?.workItem),
      actionStats: projectActionStats(event?.workItem),
    },
  };
}

function projectDebugUsage(value) {
  return {
    inputTokens: count(value?.inputTokens),
    outputTokens: count(value?.outputTokens),
    cacheReadTokens: count(value?.cacheReadTokens),
    cacheWriteTokens: count(value?.cacheWriteTokens),
    totalInputTokens: count(value?.totalInputTokens),
    totalTokens: count(value?.totalTokens),
  };
}

export function projectActionMessagePage(action, runs, events, options = {}) {
  const messages = actionMessages(action, runs, events);
  const requestedCursor = options.cursor == null ? messages.length : Number(options.cursor);
  const end = Number.isFinite(requestedCursor)
    ? Math.max(0, Math.min(messages.length, Math.floor(requestedCursor)))
    : messages.length;
  const limit = Math.max(1, Math.min(50, Number(options.limit) || MAX_ACTION_MESSAGES));
  const start = Math.max(0, end - limit);
  return {
    actionId: action.id,
    messages: messages.slice(start, end),
    nextCursor: start > 0 ? String(start) : null,
    total: messages.length,
  };
}

export function projectActionRequestIndex(action, entries) {
  return {
    actionId: action.id,
    requests: (Array.isArray(entries) ? entries : []).map(({ run, turn }) => ({
      id: turn.turnId,
      runId: run.id,
      status: run.status || 'running',
      model: run.modelSnapshot?.id || null,
      vp: run.vpSnapshot ? {
        id: run.vpSnapshot.id || null,
        name: run.vpSnapshot.name || run.vpSnapshot.id || null,
      } : null,
      openedAt: count(turn.openedAt || run.startedAt),
      closedAt: count(turn.closedAt || run.endedAt),
      loopCount: count(turn.loopCount),
      totalMs: count(turn.totalMs),
      inputTokens: count(turn.summaryInputTokens),
      outputTokens: count(turn.summaryOutputTokens),
      totalTokens: count(turn.totalTokens),
    })).sort((left, right) => right.openedAt - left.openedAt || right.id.localeCompare(left.id)),
  };
}

export function projectActionRequestDetail(action, run, history) {
  const turn = Array.isArray(history?.turns) ? history.turns[0] : null;
  if (!turn) return null;
  const tools = Array.isArray(turn.tools) ? turn.tools : [];
  const loops = (Array.isArray(history?.loops) ? history.loops : []).map(loop => ({
    id: loop.loopInstanceId || `${turn.turnId}:${loop.loopNumber}`,
    loopNumber: count(loop.loopNumber),
    model: loop.model || run.modelSnapshot?.id || null,
    systemPrompt: sanitizeDebugValue(typeof loop.systemPrompt === 'string' ? loop.systemPrompt : ''),
    messages: sanitizeDebugValue(Array.isArray(loop.messages) ? loop.messages : []),
    response: sanitizeDebugValue(typeof loop.response === 'string' ? loop.response : ''),
    usage: projectDebugUsage(loop.usage),
    latencyMs: count(loop.latencyMs),
    ttfbMs: loop.ttfbMs == null ? null : count(loop.ttfbMs),
    stopReason: loop.stopReason || null,
    at: count(loop.at),
    tools: (Array.isArray(loop.toolCalls) ? loop.toolCalls : []).map(call => {
      const result = tools.find(tool => tool.callId === call.id && count(tool.loopNumber) === count(loop.loopNumber));
      return {
        id: call.id || null,
        name: call.name || result?.name || '?',
        input: sanitizeDebugValue(call.input),
        output: sanitizeDebugValue(result?.toolOutput ?? null),
        durationMs: count(result?.durationMs),
        isError: result?.isError === true,
      };
    }),
    rawRequest: sanitizeDebugValue(reconstructDebugRawRequest(
      loop.rawRequestBase ?? loop.requestBase?.rawRequest ?? null,
      loop.requestDelta || null,
    )),
    rawResponse: sanitizeDebugValue(loop.rawResponse ?? null),
  }));
  return enforceActionRequestDetailBudget({
    actionId: action.id,
    request: {
      id: turn.turnId,
      runId: run.id,
      status: run.status || 'running',
      model: run.modelSnapshot?.id || loops[0]?.model || null,
      vp: run.vpSnapshot ? {
        id: run.vpSnapshot.id || null,
        name: run.vpSnapshot.name || run.vpSnapshot.id || null,
      } : null,
      openedAt: count(turn.openedAt || run.startedAt),
      closedAt: count(turn.closedAt || run.endedAt),
      loopCount: loops.length,
      totalMs: count(turn.totalMs),
      totalTokens: count(turn.totalTokens),
      loops,
    },
  });
}
