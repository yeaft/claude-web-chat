import { reconstructDebugRawRequest } from '../debug-trace.js';
import {
  enforceActionRequestDetailBudget,
  limitActionRequestDebugInput,
  sanitizeDebugValue,
  sanitizeDiagnosticText,
} from './debug-projection.js';
import { eventMatchesActionGeneration, runMatchesActionIdentity } from './action-identity.js';
import { taskSpecificActionBrief } from './workflow.js';
import { buildMainlineProjection } from './mainline-projection.js';

const MAX_ACTION_MESSAGE_CHARS = 16_000;
const MAX_ACTION_DIAGNOSTIC_CHARS = 8_000;
const MAX_ACTION_MESSAGES = 20;
const MAX_ACTION_REQUEST_TOOL_CALLS = 128;
const MAX_HISTORICAL_BRIEF_CHARS = 256;
const MAX_CURRENT_BRIEF_BYTES = 8 * 1024;
export const MAX_WORK_ITEM_BROWSER_DTO_BYTES = 512 * 1024;

function jsonByteLength(value) {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function truncateUtf8(value, maxBytes) {
  const bytes = Buffer.from(String(value || ''), 'utf8');
  if (bytes.length <= maxBytes) return bytes.toString('utf8');
  let end = Math.min(maxBytes, bytes.length);
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString('utf8');
}

function currentAction(detail) {
  if (!detail?.currentActionId || !Array.isArray(detail.actions)) return null;
  return detail.actions.find(action => action.id === detail.currentActionId) || null;
}

function projectCurrentActionSummary(action, projectedAction = action) {
  if (!projectedAction?.id) return null;
  return {
    id: projectedAction.id,
    type: projectedAction.type,
    stageId: projectedAction.stageId,
    assignmentMode: projectedAction.assignmentPolicy?.mode || (projectedAction.requiredRole ? 'fixed' : null),
    status: projectedAction.status,
    objective: truncateUtf8(action?.brief?.objective, 1_000) || null,
    ...(projectedAction.assignedVp ? { assignedVp: projectedAction.assignedVp } : {}),
  };
}

const BOARD_ACTION_STATUSES = ['completed', 'running', 'ready', 'waiting', 'failed'];

function boardActionCounts(actions) {
  const counts = Object.fromEntries(BOARD_ACTION_STATUSES.map(status => [status, 0]));
  for (const action of Array.isArray(actions) ? actions : []) {
    if (Object.hasOwn(counts, action?.status)) counts[action.status] += 1;
  }
  return counts;
}

export function workItemBoardLane(detail) {
  const actions = (Array.isArray(detail?.actions) ? detail.actions : [])
    .filter(action => !['superseded', 'cancelled'].includes(action?.status));
  if (['done', 'cancelled'].includes(detail?.status)) return 'closed';
  if (['draft', 'waiting', 'needs_attention'].includes(detail?.status)
      || actions.some(action => ['waiting', 'failed'].includes(action?.status))) {
    return 'needs_attention';
  }
  return 'active';
}

function boardActionSummary(action, runs, events) {
  if (!action) return null;
  const projected = projectAction(action, runs, events, false);
  return {
    id: projected.id,
    type: projected.type,
    stageId: projected.stageId,
    status: projected.status,
    objective: truncateUtf8(action?.brief?.objective, 1_000) || null,
    assignedVp: projected.assignedVp || null,
  };
}

function boardFields(detail) {
  const actions = (Array.isArray(detail?.actions) ? detail.actions : [])
    .filter(action => !['superseded', 'cancelled'].includes(action?.status));
  const runs = Array.isArray(detail?.runs) ? detail.runs : [];
  const events = Array.isArray(detail?.events) ? detail.events : [];
  const bySequence = (left, right) => count(left?.sequence) - count(right?.sequence)
    || String(left?.id || '').localeCompare(String(right?.id || ''));
  const attentionAction = [...actions]
    .filter(action => ['waiting', 'failed'].includes(action?.status))
    .sort((left, right) => {
      const priority = { waiting: 0, failed: 1 };
      return priority[left.status] - priority[right.status] || bySequence(left, right);
    })[0] || null;
  const activeAction = [...actions]
    .filter(action => ['running', 'ready'].includes(action?.status))
    .sort((left, right) => {
      const priority = { running: 0, ready: 1 };
      return priority[left.status] - priority[right.status] || bySequence(left, right);
    })[0] || null;
  const executors = [];
  const seenExecutors = new Set();
  for (const action of actions) {
    const assignedVp = projectAction(action, runs, events, false).assignedVp;
    if (!assignedVp?.id || seenExecutors.has(assignedVp.id)) continue;
    seenExecutors.add(assignedVp.id);
    executors.push(assignedVp);
  }
  return {
    boardLane: workItemBoardLane({ ...detail, actions }),
    actionCounts: boardActionCounts(actions),
    attentionAction: boardActionSummary(attentionAction, runs, events),
    activeAction: boardActionSummary(activeAction, runs, events),
    executors,
  };
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

function actionGeneration(value) {
  return Math.max(1, count(value) || 1);
}

function runGeneration(run) {
  return actionGeneration(run?.actionGeneration ?? run?.executionManifest?.actionGeneration);
}

function runSpecHash(run) {
  return typeof run?.actionSpecHash === 'string' && run.actionSpecHash
    ? run.actionSpecHash
    : typeof run?.executionManifest?.actionSpecHash === 'string'
      ? run.executionManifest.actionSpecHash
      : '';
}

function threadRuns(action, runs) {
  const source = (Array.isArray(runs) ? runs : []).filter(run => run?.actionId === action?.id);
  const selectedSpecByGeneration = new Map((Array.isArray(action?.identityHistory) ? action.identityHistory : [])
    .filter(identity => typeof identity?.specHash === 'string' && identity.specHash)
    .map(identity => [actionGeneration(identity.generation), identity.specHash]));
  const currentGeneration = actionGeneration(action?.generation);
  if (typeof action?.specHash === 'string' && action.specHash) {
    selectedSpecByGeneration.set(currentGeneration, action.specHash);
  }
  return source.filter(run => {
    const generation = runGeneration(run);
    const selectedSpec = selectedSpecByGeneration.get(generation) || '';
    const spec = runSpecHash(run);
    return selectedSpec ? spec === selectedSpec : generation === 1 && !spec;
  });
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
    ...(message.generation == null ? {} : { generation: Math.max(1, count(message.generation) || 1) }),
    ...(message.attempt == null ? {} : { attempt: Math.max(1, count(message.attempt) || 1) }),
    ...(message.runId == null ? {} : { runId: String(message.runId) }),
  };
}

function actionInputMessages(action, events, generation = actionGeneration(action?.generation), includeThreadIdentity = false) {
  return (Array.isArray(events) ? events : [])
    .filter(event => event?.actionId === action?.id
      && actionGeneration(event.actionGeneration) === generation
      && ['action.guidance_added', 'action.input_added'].includes(event.type))
    .map(event => normalizeProjectedMessage({
      id: `event:${event.id}`,
      role: 'user',
      kind: 'input',
      status: 'sent',
      text: event.data?.text || event.data?.guidance || '',
      attachments: event.data?.attachments,
      createdAt: event.createdAt,
      ...(includeThreadIdentity ? { generation } : {}),
    }))
    .filter(Boolean);
}

function runResponseMessage(run, includeThreadIdentity = false) {
  return normalizeProjectedMessage({
    id: `run:${run.id}`,
    role: 'assistant',
    kind: 'response',
    status: run.status || 'running',
    text: typeof run.response === 'string' ? run.response : '',
    createdAt: count(run.startedAt),
    updatedAt: count(run.endedAt || run.startedAt),
    progressRevision: count(run.progressRevision),
    ...(includeThreadIdentity ? {
      generation: runGeneration(run),
      attempt: run.actionAttempt,
      runId: run.id,
    } : {}),
  });
}

function loopOutputMessages(action, events, matchingRunIds, generation = actionGeneration(action?.generation), includeThreadIdentity = false) {
  return (Array.isArray(events) ? events : [])
    .filter(event => event?.actionId === action?.id
      && actionGeneration(event.actionGeneration ?? event.data?.actionGeneration) === generation
      && matchingRunIds.has(event.runId)
      && event.type === 'run.loop_output')
    .map(event => normalizeProjectedMessage({
      id: `event:${event.id}`,
      role: 'assistant',
      kind: 'response',
      status: 'completed',
      text: event.data?.response || '',
      createdAt: event.createdAt,
      ...(includeThreadIdentity ? {
        generation: event.actionGeneration ?? event.data?.actionGeneration,
        attempt: event.data?.actionAttempt,
        runId: event.runId,
      } : {}),
    }))
    .filter(Boolean);
}

function messagesForGeneration(action, runs, events, generation, includeThreadIdentity = false) {
  const matchingRuns = threadRuns(action, runs).filter(run => runGeneration(run) === generation);
  const matchingRunIds = new Set(matchingRuns.map(run => run.id));
  const runsWithLoopOutput = new Set((Array.isArray(events) ? events : [])
    .filter(event => event?.actionId === action?.id
      && actionGeneration(event.actionGeneration ?? event.data?.actionGeneration) === generation
      && matchingRunIds.has(event.runId)
      && event.type === 'run.loop_output')
    .map(event => event.runId));
  return [
    ...actionInputMessages(action, events, generation, includeThreadIdentity),
    ...loopOutputMessages(action, events, matchingRunIds, generation, includeThreadIdentity),
    ...matchingRuns
    .sort((left, right) => count(left.startedAt) - count(right.startedAt))
    .filter(run => !runsWithLoopOutput.has(run.id))
    .map(run => runResponseMessage(run, includeThreadIdentity))
    .filter(Boolean)]
    .sort((left, right) => left.createdAt - right.createdAt
      || (left.role === 'user' ? -1 : 1)
      || left.id.localeCompare(right.id));
}

function actionMessages(action, runs, events) {
  return messagesForGeneration(action, runs, events, actionGeneration(action?.generation));
}

function projectActionThread(action, runs, events) {
  const allRuns = threadRuns(action, runs);
  const generations = new Set([
    actionGeneration(action?.generation),
    ...allRuns.map(runGeneration),
    ...(Array.isArray(events) ? events : [])
      .filter(event => event?.actionId === action?.id
        && ['action.guidance_added', 'action.input_added', 'run.loop_output'].includes(event.type))
      .map(event => actionGeneration(event.actionGeneration ?? event.data?.actionGeneration)),
  ]);
  return [...generations].sort((left, right) => left - right).map(generation => {
    const canonical = generation === actionGeneration(action?.generation);
    return {
      generation,
      canonical,
      messages: canonical ? [] : messagesForGeneration(action, allRuns, events, generation, true).slice(-MAX_ACTION_MESSAGES),
      runs: allRuns.filter(run => runGeneration(run) === generation)
        .sort((left, right) => count(left.startedAt) - count(right.startedAt) || String(left.id).localeCompare(String(right.id)))
        .map(run => ({
          id: run.id,
          attempt: Math.max(1, count(run.actionAttempt) || 1),
          status: run.status || 'running',
          startedAt: count(run.startedAt),
          endedAt: count(run.endedAt),
          progressRevision: count(run.progressRevision),
          loopCount: count(run.loopCount),
          toolCount: count(run.toolCount),
        })),
    };
  }).filter(entry => entry.messages.length > 0 || entry.runs.length > 0 || entry.canonical);
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

function unsafeFailureText(raw) {
  return PROVIDER_TOKEN_PATTERN.test(raw) || HIGH_ENTROPY_SECRET_PATTERN.test(raw)
    || LOCAL_PATH_ASSIGNMENT_PATTERN.test(raw) || POSIX_ABSOLUTE_PATH_PATTERN.test(raw)
    || WINDOWS_ABSOLUTE_PATH_PATTERN.test(raw);
}

function sanitizeFailureDiagnostic(value) {
  const raw = typeof value === 'string'
    ? value.trim().slice(0, MAX_FAILURE_INSPECTION_LENGTH)
    : '';
  if (!raw) return '';
  if (unsafeFailureText(raw)) return SAFE_FAILURE_FALLBACK;
  return sanitizeDiagnosticText(raw, MAX_ACTION_DIAGNOSTIC_CHARS);
}

function sanitizeFailureReason(value) {
  const raw = typeof value === 'string'
    ? value.trim().slice(0, MAX_FAILURE_INSPECTION_LENGTH)
    : '';
  if (!raw) return '';
  if (unsafeFailureText(raw)) return SAFE_FAILURE_FALLBACK;
  const text = raw.replace(/https?:\/\/[^\s<>'"`]+/gi, sanitizedUrl);
  if (CREDENTIAL_ASSIGNMENT_PATTERN.test(text)) return SAFE_FAILURE_FALLBACK;
  return text
    .replace(/\b(?:Bearer|Basic)\s+[^\s,;]+/gi, '[redacted credential]')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .slice(0, MAX_FAILURE_REASON_LENGTH);
}



function actionExecution(action, runs, events, includeBody = true) {
  const matchingRuns = Array.isArray(runs)
    ? runs.filter(run => run?.actionId === action?.id && runMatchesActionIdentity(run, action))
    : [];
  if (matchingRuns.length === 0) {
    const inputMessageCount = Array.isArray(events) ? events.filter(event => (
      event?.actionId === action?.id
        && eventMatchesActionGeneration(event, action)
        && ['action.guidance_added', 'action.input_added'].includes(event.type)
    )).length : 0;
    const messages = includeBody
      ? (Array.isArray(action?.messages)
          ? action.messages.slice(-MAX_ACTION_MESSAGES).map(normalizeProjectedMessage).filter(Boolean)
          : actionInputMessages(action, events))
      : [];
    const messageCount = count(action?.messageCount) || (includeBody ? messages.length : inputMessageCount);
    return {
      ...executionStats(action?.executionStats || action),
      response: includeBody && typeof action?.response === 'string' ? action.response : '',
      failure: includeBody && action?.failure && typeof action.failure === 'object'
        ? {
            ...(action.failure.kind === 'system_blocked' ? {
              kind: 'system_blocked',
              code: typeof action.failure.code === 'string' ? truncateUtf8(action.failure.code, 128) : null,
            } : {}),
            error: sanitizeFailureDiagnostic(action.failure.error),
            summary: sanitizeFailureDiagnostic(action.failure.summary),
            failedAt: count(action.failure.failedAt),
          }
        : null,
      progressRevision: count(action?.progressRevision),
      messages,
      liveMessage: includeBody ? normalizeProjectedMessage(action?.liveMessage) : null,
      messageCount,
      messageCursor: action?.messageCursor == null
        ? (!includeBody && messageCount > 0 ? String(messageCount) : null)
        : String(action.messageCursor),
      failureReason: sanitizeFailureReason(action?.failureReason),

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
  const inputMessageCount = includeBody
    ? 0
    : (Array.isArray(events) ? events : []).filter(event => (
        event?.actionId === action?.id
          && eventMatchesActionGeneration(event, action)
          && ['action.guidance_added', 'action.input_added'].includes(event.type)
      )).length;
  const allMessages = includeBody ? actionMessages(action, matchingRuns, events) : [];
  const totalMessageCount = includeBody ? allMessages.length : matchingRuns.length + inputMessageCount;
  const messages = allMessages.slice(-MAX_ACTION_MESSAGES);
  const liveMessage = includeBody ? runResponseMessage(latest) : null;
  return {
    ...stats,
    response: includeBody && typeof latest?.response === 'string' ? latest.response : '',
    failure: includeBody && latestFailure ? {
      ...(latestFailure.failureKind === 'system_blocked' ? {
        kind: 'system_blocked',
        code: typeof latestFailure.failureCode === 'string' ? truncateUtf8(latestFailure.failureCode, 128) : null,
      } : {}),
      error: sanitizeFailureDiagnostic(latestFailure.error),
      summary: sanitizeFailureDiagnostic(latestFailure.summary),
      failedAt: count(latestFailure.endedAt || latestFailure.startedAt),
    } : null,
    failureReason: sanitizeFailureReason(latestFailure?.error),

    progressRevision: count(latest?.progressRevision),
    messages,
    liveMessage,
    messageCount: totalMessageCount,
    messageCursor: includeBody
      ? (totalMessageCount > messages.length ? String(totalMessageCount - messages.length) : null)
      : (totalMessageCount > 0 ? String(totalMessageCount) : null),
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

function projectAction(action, runs, events, includeBody = true) {
  if (!action) return null;
  const execution = actionExecution(action, runs, events, includeBody);
  const alreadyProjected = !Array.isArray(runs) && Array.isArray(action.messages);
  const brief = taskSpecificActionBrief(action.brief, action.type);
  const projectedBrief = !brief
    ? brief
    : Object.fromEntries(Object.entries(brief).map(([key, value]) => [
        key,
        truncateUtf8(value, includeBody ? MAX_CURRENT_BRIEF_BYTES : MAX_HISTORICAL_BRIEF_CHARS),
      ]));
  const matchingRuns = Array.isArray(runs)
    ? runs.filter(run => run?.actionId === action.id && runMatchesActionIdentity(run, action))
    : [];
  const latestRun = [...matchingRuns].sort((left, right) => (
    count(right.startedAt) - count(left.startedAt) || count(right.progressRevision) - count(left.progressRevision)
  ))[0];
  const assignedVp = latestRun?.vpSnapshot ? {
    id: latestRun.vpSnapshot.id || null,
    name: latestRun.vpSnapshot.name || latestRun.vpSnapshot.id || null,
  } : null;
  const contentSummary = truncateUtf8(
    execution.response || latestRun?.summary || brief?.objective || brief?.expectedOutcome || '',
    MAX_HISTORICAL_BRIEF_CHARS,
  );
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
    generation: Math.max(1, count(action.generation) || 1),
    replacesActionId: action.replacesActionId || null,
    brief: projectedBrief,
    status: action.status,
    assignedVp,
    contentSummary,
    executionStats: executionStats(execution),
    loopCount: execution.loopCount,
    toolCount: execution.toolCount,
    ...(includeBody ? {
      response: execution.response,
      failureReason: execution.failureReason,
    } : {}),
    progressRevision: execution.progressRevision,
    messageCount: execution.messageCount,
    messageCursor: execution.messageCursor,
    ...(includeBody ? {
      response: execution.response,
      failure: execution.failure,
      messages: execution.messages,
      thread: Array.isArray(runs) ? projectActionThread(action, runs, events) : (action.thread || []),
      liveMessage: execution.liveMessage,
    } : {}),
  };
}

function bodyActionId(detail) {
  const actions = Array.isArray(detail?.actions) ? detail.actions : [];
  if (detail?.currentActionId && actions.some(action => action?.id === detail.currentActionId)) {
    return detail.currentActionId;
  }
  return [...actions].sort((left, right) => (
    count(right?.sequence) - count(left?.sequence)
      || String(right?.id || '').localeCompare(String(left?.id || ''))
  ))[0]?.id || null;
}

function stripActionBody(action, keepFailure = false) {
  if (!action) return action;
  const projected = { ...action };
  delete projected.response;
  delete projected.messages;
  delete projected.thread;
  delete projected.liveMessage;
  if (!keepFailure) delete projected.failure;
  if (projected.brief) {
    projected.brief = Object.fromEntries(Object.entries(projected.brief).map(([key, value]) => [
      key,
      truncateUtf8(value, MAX_HISTORICAL_BRIEF_CHARS),
    ]));
  }
  return projected;
}

function projectActionStats(detail) {
  if (!Array.isArray(detail?.actions)) return [];
  const liveActionId = bodyActionId(detail);
  return detail.actions.map(action => {
    const projected = projectAction(
      action,
      detail.runs,
      detail.events,
      action?.id === liveActionId,
    );
    const stats = {
      id: projected.id,
      status: projected.status,
      assignedVp: projected.assignedVp,
      contentSummary: projected.contentSummary,
      executionStats: projected.executionStats,
      loopCount: projected.loopCount,
      toolCount: projected.toolCount,
      progressRevision: projected.progressRevision,
    };
    if (projected.failureReason) stats.failureReason = projected.failureReason;
    if (projected.id === liveActionId) {
      stats.response = projected.response;
      stats.failure = projected.failure;
      if (projected.liveMessage) stats.liveMessage = projected.liveMessage;
    }
    return stats;
  });
}

function enforceWorkItemBrowserDtoBudget(value, options = {}) {
  if (!value || jsonByteLength(value) <= MAX_WORK_ITEM_BROWSER_DTO_BYTES) return value;
  const dto = value;
  const workItem = options.event === true ? dto.workItem : dto;
  const actions = Array.isArray(workItem?.actions)
    ? workItem.actions
    : Array.isArray(workItem?.actionStats) ? workItem.actionStats : [];
  const keepId = options.keepActionId || workItem?.currentActionId || actions.at(-1)?.id || null;
  workItem.truncated = true;

  for (let index = 0; index < actions.length; index += 1) {
    if (actions[index]?.id === keepId) continue;
    actions[index] = stripActionBody(actions[index]);
  }
  if (jsonByteLength(dto) <= MAX_WORK_ITEM_BROWSER_DTO_BYTES) return dto;

  const keep = actions.find(action => action?.id === keepId);
  if (keep) {
    delete keep.response;
    delete keep.messages;
    delete keep.thread;
    delete keep.liveMessage;
  }
  if (jsonByteLength(dto) <= MAX_WORK_ITEM_BROWSER_DTO_BYTES) return dto;

  const originalCount = actions.length;
  const retained = keep ? [stripActionBody(keep, true)] : [];
  if (Array.isArray(workItem.actions)) workItem.actions = retained;
  else workItem.actionStats = retained;
  workItem.omittedActionCount = originalCount - retained.length;
  if (jsonByteLength(dto) <= MAX_WORK_ITEM_BROWSER_DTO_BYTES) return dto;

  if (retained[0]) {
    delete retained[0].brief;
    delete retained[0].failure;
  }
  workItem.title = truncateUtf8(workItem.title, 4 * 1024);
  workItem.goal = truncateUtf8(workItem.goal, 4 * 1024);
  workItem.waitingReason = truncateUtf8(workItem.waitingReason, 4 * 1024);
  workItem.actionSummary = truncateUtf8(workItem.actionSummary, 4 * 1024);
  if (Array.isArray(workItem.acceptanceCriteria)) workItem.acceptanceCriteria = [];
  if (Array.isArray(workItem.linkedSessionIds)) workItem.linkedSessionIds = [];
  if (Array.isArray(workItem.attachments)) workItem.attachments = [];
  if (jsonByteLength(dto) <= MAX_WORK_ITEM_BROWSER_DTO_BYTES) return dto;

  const minimalWorkItem = {
    id: truncateUtf8(workItem.id, 4 * 1024),
    revision: count(workItem.revision),
    title: truncateUtf8(workItem.title, 4 * 1024),
    goal: truncateUtf8(workItem.goal, 4 * 1024),
    status: truncateUtf8(workItem.status, 256),
    currentActionId: truncateUtf8(workItem.currentActionId, 4 * 1024) || null,
    executionStats: workItem.executionStats,
    actionCount: count(workItem.actionCount),
    actions: Array.isArray(workItem.actions) ? [] : undefined,
    actionStats: Array.isArray(workItem.actionStats) ? [] : undefined,
    truncated: true,
    omittedActionCount: originalCount,
    createdAt: count(workItem.createdAt),
    updatedAt: count(workItem.updatedAt),
  };
  if (options.event === true) dto.workItem = minimalWorkItem;
  else return minimalWorkItem;
  return dto;
}

function sanitizeMainlineDiagnostic(value, maxBytes) {
  return sanitizeDiagnosticText(value, maxBytes)
    .replace(/\bfile:\/\/[^\r\n"'<>]+/gi, '[path redacted]')
    .replace(/\\\\(?:\?\\)?[^\\\r\n"'<>]+(?:\\[^\\\r\n"'<>]+)+/g, '[path redacted]')
    .replace(/\b[A-Za-z]:\\[^\r\n"'<>]+/g, '[path redacted]')
    .replace(/(?<![:/])\/(?:[^/\s"'<>]+\/)*[^/\s"'<>]+/g, '[path redacted]');
}

function projectCanonicalEvidence(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 20).map(item => {
    if (typeof item === 'string') return sanitizeMainlineDiagnostic(item, 1_000);
    if (!item || typeof item !== 'object') return null;
    const projected = {};
    for (const key of ['kind', 'label', 'ref', 'status']) {
      if (typeof item[key] === 'string') projected[key] = sanitizeMainlineDiagnostic(item[key], 1_000);
    }
    return Object.keys(projected).length > 0 ? projected : null;
  }).filter(Boolean);
}

function projectMainlineBrowser(detail) {
  if (!detail?.id || detail.executionSchemaVersion !== 2) return null;
  const mainline = buildMainlineProjection(detail);
  const actionById = new Map((detail.actions || []).map(action => [action.id, action]));
  const activeActionIds = Array.isArray(detail.activeActionIds)
    ? detail.activeActionIds
    : mainline.graph.nodes.filter(node => ['ready', 'running'].includes(node.status)).map(node => node.id);
  const attentionActionIds = Array.isArray(detail.attentionActionIds)
    ? detail.attentionActionIds
    : mainline.graph.nodes.filter(node => ['waiting', 'failed'].includes(node.status)).map(node => node.id);
  const counts = Object.fromEntries(['completed', 'running', 'ready', 'waiting', 'failed']
    .map(status => [status, mainline.graph.nodes.filter(node => node.status === status).length]));
  return {
    contract: {
      title: truncateUtf8(mainline.contract.title, 8_000),
      goal: truncateUtf8(mainline.contract.goal, 16_000),
      acceptanceCriteria: mainline.contract.acceptanceCriteria.slice(0, 100)
        .map(criterion => truncateUtf8(criterion, 4_000)),
    },
    progress: {
      lifecycle: detail.lifecycle || (counts.completed === mainline.graph.nodes.length ? 'done' : 'active'),
      attentionState: detail.attentionState || (counts.waiting && counts.failed ? 'mixed'
        : counts.waiting ? 'waiting' : counts.failed ? 'failed' : 'none'),
      activeActionIds: [...activeActionIds],
      attentionActionIds: [...attentionActionIds],
      frontierActionIds: [...mainline.graph.frontier],
      counts,
    },
    actions: mainline.graph.nodes.map(node => {
      const action = actionById.get(node.id) || {};
      const result = mainline.canonicalActionResults[node.id];
      return {
        id: node.id,
        stageId: node.stageId,
        type: node.type,
        status: node.status,
        generation: node.generation,
        brief: taskSpecificActionBrief(action.brief, action.type)
          ? Object.fromEntries(Object.entries(taskSpecificActionBrief(action.brief, action.type)).map(([key, value]) => [
              key,
              truncateUtf8(value, MAX_CURRENT_BRIEF_BYTES),
            ]))
          : null,
        dependencies: [...node.dependsOnStageIds],
        canonicalResult: result ? {
          status: result.status,
          summary: sanitizeMainlineDiagnostic(result.summary, MAX_ACTION_DIAGNOSTIC_CHARS),
          evidence: projectCanonicalEvidence(result.evidence),
          waitingReason: sanitizeDiagnosticText(result.waitingReason, MAX_ACTION_DIAGNOSTIC_CHARS) || null,
          reviewDecision: typeof result.reviewDecision === 'string'
            ? truncateUtf8(result.reviewDecision, 256) : null,
        } : null,
      };
    }),
  };
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
  const liveActionId = bodyActionId(detail);
  const mainline = projectMainlineBrowser(detail);
  const mainlineActionById = new Map((mainline?.actions || []).map(action => [action.id, action]));
  const projected = {
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
    lifecycle: detail.lifecycle,
    attentionState: detail.attentionState,
    activeActionIds: Array.isArray(detail.activeActionIds) ? detail.activeActionIds : undefined,
    attentionActionIds: Array.isArray(detail.attentionActionIds) ? detail.attentionActionIds : undefined,
    mainline,
    currentActionId: detail.currentActionId || null,
    executionStats: Array.isArray(detail.runs)
      ? sumExecutionStats(detail.runs)
      : executionStats(detail.executionStats),
    reuseMemory: detail.reuseMemory !== false,
    waitingReason: sanitizeDiagnosticText(waitingReason(detail), MAX_ACTION_DIAGNOSTIC_CHARS),
    failureReason: workItemFailureReason(detail),

    origin: detail.origin?.sessionId ? { sessionId: detail.origin.sessionId } : null,
    linkedSessionIds: Array.isArray(detail.linkedSessionIds) ? detail.linkedSessionIds : [],
    messages: (Array.isArray(detail.messages) ? detail.messages : []).slice(-100).map(message => ({
      id: String(message.id || ''),
      text: truncateUtf8(message.text || '', MAX_ACTION_MESSAGE_CHARS),
      createdAt: count(message.createdAt),
    })),
    attachments: projectAttachments(detail.attachments),
    createdAt: detail.createdAt,
    updatedAt: detail.updatedAt,
    actionCount: Array.isArray(detail.actions) ? detail.actions.length : count(detail.actionCount),
    actionSummary: Array.isArray(detail.actions)
      ? detail.actions.map(action => action.type).filter(Boolean).join(' → ')
      : String(detail.actionSummary || ''),
    actions: Array.isArray(detail.actions)
      ? detail.actions.map(action => ({
          ...projectAction(action, detail.runs, detail.events, action?.id === liveActionId),
          ...(mainlineActionById.get(action.id) || {}),
        }))
      : [],
  };
  return enforceWorkItemBrowserDtoBudget(projected, { keepActionId: liveActionId });
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
      lifecycle: detail.lifecycle,
      attentionState: detail.attentionState,
      activeActionIds: Array.isArray(detail.activeActionIds) ? detail.activeActionIds : undefined,
      attentionActionIds: Array.isArray(detail.attentionActionIds) ? detail.attentionActionIds : undefined,
      currentActionId: detail.currentActionId || null,
      currentAction: projectCurrentActionSummary(detail.currentAction),
      actionCount: count(detail.actionCount),
      completedActionCount: count(detail.completedActionCount),
      executionStats: executionStats(detail.executionStats),
      origin: detail.origin?.sessionId ? { sessionId: detail.origin.sessionId } : null,
      linkedSessionIds: Array.isArray(detail.linkedSessionIds) ? detail.linkedSessionIds : [],
      attachmentCount: Array.isArray(detail.attachments) ? detail.attachments.length : 0,
      createdAt: detail.createdAt,
      updatedAt: detail.updatedAt,
      boardLane: detail.boardLane || workItemBoardLane(detail),
      actionCounts: detail.actionCounts || boardActionCounts([]),
      attentionAction: detail.attentionAction || null,
      activeAction: detail.activeAction || null,
      executors: Array.isArray(detail.executors) ? detail.executors : [],
    };
  }
  const action = currentAction(detail);
  const projectedAction = action ? projectAction(action, detail.runs, detail.events, false) : null;
  return {
    id: detail.id,
    revision: detail.revision,
    title: detail.title,
    goal: detail.goal,
    workItemType: detail.workflowSnapshot?.workItemType || detail.workItemType || null,
    planningMode: detail.workflowSnapshot?.planningMode || detail.planningMode || 'static',
    executionMode: detail.workflowSnapshot?.executionMode || detail.executionMode || 'linear',
    status: detail.status,
    lifecycle: detail.lifecycle,
    attentionState: detail.attentionState,
    activeActionIds: Array.isArray(detail.activeActionIds) ? detail.activeActionIds : undefined,
    attentionActionIds: Array.isArray(detail.attentionActionIds) ? detail.attentionActionIds : undefined,
    currentActionId: detail.currentActionId || null,
    actionCount: detail.actions.filter(item => !['superseded', 'cancelled'].includes(item?.status)).length,
    completedActionCount: detail.actions.filter(item => item?.status === 'completed').length,
    executionStats: Array.isArray(detail.runs)
      ? sumExecutionStats(detail.runs)
      : executionStats(detail.executionStats),
    failureReason: workItemFailureReason(detail),

    currentAction: projectCurrentActionSummary(action, projectedAction),
    origin: detail.origin?.sessionId ? { sessionId: detail.origin.sessionId } : null,
    linkedSessionIds: Array.isArray(detail.linkedSessionIds) ? detail.linkedSessionIds : [],
    attachmentCount: Array.isArray(detail.attachments) ? detail.attachments.length : 0,
    createdAt: detail.createdAt,
    updatedAt: detail.updatedAt,
    ...boardFields(detail),
  };
}

export function projectWorkCenterEvent(event) {
  const type = truncateUtf8(event?.type || 'work_item.updated', 256);
  if (type === 'work_item.deleted') {
    return {
      type,
      workItem: {
        id: String(event?.workItem?.id || ''),
        revision: count(event?.workItem?.revision),
      },
    };
  }
  const liveActionId = bodyActionId(event?.workItem);
  return enforceWorkItemBrowserDtoBudget({
    type,
    workItem: {
      ...projectWorkItemSummary(event?.workItem),
      actionStats: projectActionStats(event?.workItem),
    },
  }, { event: true, keepActionId: liveActionId });
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
    generation: Math.max(1, count(action.generation) || 1),
    messages: messages.slice(start, end),
    nextCursor: start > 0 ? String(start) : null,
    total: messages.length,
  };
}

export function actionThreadIncludesRun(action, runs, runId) {
  return threadRuns(action, runs).some(run => run.id === runId);
}

export function projectActionRequestIndex(action, entries) {
  const source = Array.isArray(entries) ? entries : [];
  const allowedRunIds = new Set(threadRuns(action, source.map(({ run }) => run)).map(run => run.id));
  return {
    actionId: action.id,
    generation: Math.max(1, count(action.generation) || 1),
    requests: source
      .filter(({ run }) => allowedRunIds.has(run?.id))
      .map(({ run, turn }) => ({
      id: turn.turnId,
      runId: run.id,
      generation: Math.max(1, count(run.actionGeneration) || 1),
      attempt: Math.max(1, count(run.actionAttempt) || 1),
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

export function projectActionRequestDetail(action, run, history, runs = [run]) {
  if (!actionThreadIncludesRun(action, runs, run?.id)) return null;
  const turn = Array.isArray(history?.turns) ? history.turns[0] : null;
  if (!turn) return null;
  const sourceLoops = Array.isArray(history?.loops) ? history.loops : [];
  const limited = limitActionRequestDebugInput(sourceLoops, turn.tools);
  const tools = limited.tools;
  const toolsByCall = new Map(tools.map(tool => [
    `${count(tool.loopNumber)}:${tool.callId}`,
    tool,
  ]));
  const loops = limited.loops.map(loop => ({
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
    detailTruncated: loop.detailTruncated === true,
    tools: (Array.isArray(loop.toolCalls) ? loop.toolCalls : [])
      .slice(0, MAX_ACTION_REQUEST_TOOL_CALLS)
      .map(call => {
        const result = toolsByCall.get(`${count(loop.loopNumber)}:${call.id}`);
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
      loopCount: sourceLoops.length,
      totalMs: count(turn.totalMs),
      totalTokens: count(turn.totalTokens),
      loops,
      truncated: limited.omittedLoopCount > 0 || limited.summarizedLoopCount > 0,
      omittedLoopCount: limited.omittedLoopCount,
      summarizedLoopCount: limited.summarizedLoopCount,
    },
  }, limited.omittedLoopCount);
}
