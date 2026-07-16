import { normalizeActionBrief } from './workflow.js';

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

const MAX_FAILURE_REASON_LENGTH = 2_000;
const MAX_FAILURE_INSPECTION_LENGTH = 16_000;
const SAFE_FAILURE_FALLBACK = 'The Action failed. Sensitive details were omitted.';
const CREDENTIAL_ASSIGNMENT_PATTERN = /\b(?:[A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)|api[_-]?key|access[_-]?token|authorization|password|secret|token)\s*[:=]/i;
const PROVIDER_TOKEN_PATTERN = /\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{12,}|github_pat_[A-Za-z0-9_]{12,}|gh[pousr]_[A-Za-z0-9_]{12,}|xox[baprs]-[A-Za-z0-9-]{12,}|AKIA[A-Z0-9]{12,})\b/i;
const HIGH_ENTROPY_SECRET_PATTERN = /\b(?=[A-Za-z0-9_./+=-]{32,}\b)(?=[A-Za-z0-9_./+=-]*[A-Za-z])(?=[A-Za-z0-9_./+=-]*\d)[A-Za-z0-9_./+=-]+\b/;
const LOCAL_PATH_ASSIGNMENT_PATTERN = /\b(?:path|cwd|file|filename|directory)\s*[:=]\s*(?:\/(?!\/)|[A-Za-z]:\\|\\\\)/i;
const POSIX_ABSOLUTE_PATH_PATTERN = /(?:^|[\s("'`])\/(?!\/)[^\r\n]*/m;
const WINDOWS_ABSOLUTE_PATH_PATTERN = /(?:^|[\s("'`])(?:[A-Za-z]:\\|\\\\)[^\r\n]*/m;

function sanitizedUrl(raw) {
  try {
    const url = new URL(raw);
    if (!['http:', 'https:'].includes(url.protocol)) return '[redacted URL]';
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    return '[redacted URL]';
  }
}

function sanitizeFailureReason(value) {
  const raw = typeof value === 'string'
    ? value.trim().slice(0, MAX_FAILURE_INSPECTION_LENGTH)
    : '';
  if (!raw) return '';
  const text = raw.replace(/https?:\/\/[^\s<>'"`]+/gi, sanitizedUrl);
  if (CREDENTIAL_ASSIGNMENT_PATTERN.test(text) || PROVIDER_TOKEN_PATTERN.test(text)
      || HIGH_ENTROPY_SECRET_PATTERN.test(text)) return SAFE_FAILURE_FALLBACK;
  if (LOCAL_PATH_ASSIGNMENT_PATTERN.test(text) || POSIX_ABSOLUTE_PATH_PATTERN.test(text)
      || WINDOWS_ABSOLUTE_PATH_PATTERN.test(text)) {
    return SAFE_FAILURE_FALLBACK;
  }
  return text
    .replace(/\b(?:Bearer|Basic)\s+[^\s,;]+/gi, '[redacted credential]')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .slice(0, MAX_FAILURE_REASON_LENGTH);
}

function actionExecution(action, runs) {
  const matchingRuns = Array.isArray(runs)
    ? runs.filter(run => run?.actionId === action?.id)
    : [];
  if (matchingRuns.length === 0) {
    return {
      ...executionStats(action),
      response: '',
      failureReason: '',
      progressRevision: 0,
      messages: [],
    };
  }
  const stats = sumExecutionStats(matchingRuns);
  const latest = [...matchingRuns].sort((left, right) => (
    count(right.progressRevision) - count(left.progressRevision)
      || count(right.startedAt) - count(left.startedAt)
  ))[0];
  const runsByEnd = [...matchingRuns]
    .sort((left, right) => count(right.endedAt || right.startedAt) - count(left.endedAt || left.startedAt));
  const latestRun = runsByEnd[0];
  const showCurrentFailure = action?.status === 'failed'
    || ['failed', 'retryable', 'interrupted'].includes(latestRun?.status);
  const latestFailure = showCurrentFailure
    ? runsByEnd.find(run => sanitizeFailureReason(run?.error))
    : null;
  const messages = [...matchingRuns]
    .sort((left, right) => count(left.startedAt) - count(right.startedAt))
    .map((run, index) => ({
      id: `${action.id}:${index + 1}`,
      status: run.status || 'running',
      text: typeof run.response === 'string' ? run.response.trim().slice(0, 16_000) : '',
      failureReason: sanitizeFailureReason(run.error),
      createdAt: count(run.startedAt),
      updatedAt: count(run.endedAt || run.startedAt),
    }))
    .filter(message => message.text || message.failureReason);
  return {
    ...stats,
    response: typeof latest?.response === 'string' ? latest.response : '',
    failureReason: sanitizeFailureReason(latestFailure?.error),
    progressRevision: count(latest?.progressRevision),
    messages,
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

function projectAction(action, runs) {
  if (!action) return null;
  const execution = actionExecution(action, runs);
  return {
    id: action.id,
    sequence: action.sequence,
    type: action.type,
    stageId: action.stageId || action.type,
    assignmentPolicy: projectAssignmentPolicy(action.assignmentPolicy),
    dependsOnStageIds: Array.isArray(action.dependsOnStageIds) ? action.dependsOnStageIds : [],
    workspaceMode: action.workspaceMode || 'shared',
    requiredRole: action.requiredRole || '',
    brief: normalizeActionBrief(action.brief, action.type),
    status: action.status,
    executionStats: executionStats(execution),
    loopCount: execution.loopCount,
    toolCount: execution.toolCount,
    response: execution.response,
    failureReason: execution.failureReason,
    progressRevision: execution.progressRevision,
    messages: execution.messages,
  };
}

function projectActionStats(detail) {
  if (!Array.isArray(detail?.actions)) return [];
  return detail.actions.map(action => {
    const projected = projectAction(action, detail.runs);
    return {
      id: projected.id,
      status: projected.status,
      executionStats: projected.executionStats,
      loopCount: projected.loopCount,
      toolCount: projected.toolCount,
      response: projected.response,
      failureReason: projected.failureReason,
      progressRevision: projected.progressRevision,
      messages: projected.messages
        .map(({ failureReason, ...message }) => message)
        .filter(message => message.text),
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

function workItemFailureReason(detail) {
  if (!['needs_attention', 'cancelled'].includes(detail?.status) || !Array.isArray(detail?.runs)) return '';
  const ordered = [...detail.runs].sort((left, right) => (
    count(right.endedAt || right.startedAt) - count(left.endedAt || left.startedAt)
  ));
  const current = ordered.find(run => run?.actionId === detail.currentActionId && sanitizeFailureReason(run.error));
  return sanitizeFailureReason(current?.error || ordered.find(run => sanitizeFailureReason(run?.error))?.error);
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
    workItemType: detail.workflowSnapshot?.workItemType || null,
    planningMode: detail.workflowSnapshot?.planningMode || 'static',
    executionMode: detail.workflowSnapshot?.executionMode || 'linear',
    status: detail.status,
    currentActionId: detail.currentActionId || null,
    executionStats: sumExecutionStats(Array.isArray(detail.runs) ? detail.runs : []),
    reuseMemory: detail.reuseMemory !== false,
    waitingReason: waitingReason(detail),
    failureReason: workItemFailureReason(detail),
    origin: detail.origin?.sessionId ? { sessionId: detail.origin.sessionId } : null,
    linkedSessionIds: Array.isArray(detail.linkedSessionIds) ? detail.linkedSessionIds : [],
    attachments: projectAttachments(detail.attachments),
    createdAt: detail.createdAt,
    updatedAt: detail.updatedAt,
    actionCount: Array.isArray(detail.actions) ? detail.actions.length : 0,
    actionSummary: Array.isArray(detail.actions)
      ? detail.actions.map(action => action.type).filter(Boolean).join(' → ')
      : '',
    actions: Array.isArray(detail.actions)
      ? detail.actions.map(action => projectAction(action, detail.runs))
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
      workItemType: detail.workflowSnapshot?.workItemType || null,
      planningMode: detail.workflowSnapshot?.planningMode || 'static',
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
  const projectedAction = action ? projectAction(action, detail.runs) : null;
  return {
    id: detail.id,
    revision: detail.revision,
    title: detail.title,
    goal: detail.goal,
    workItemType: detail.workflowSnapshot?.workItemType || null,
    planningMode: detail.workflowSnapshot?.planningMode || 'static',
    executionMode: detail.workflowSnapshot?.executionMode || 'linear',
    status: detail.status,
    currentActionId: detail.currentActionId || null,
    executionStats: sumExecutionStats(Array.isArray(detail.runs) ? detail.runs : []),
    failureReason: workItemFailureReason(detail),
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
