import { CONFIG } from './config.js';
import { agents } from './context.js';
import { sessionDb } from './db/session-db.js';
import { yeaftSessionDb } from './db/yeaft-session-db.js';

export const WORKBENCH_SESSION_ROUTE_CAPABILITY = 'workbench_session_routes';

const PROVIDERS = new Set(['yeaft', 'claude-code', 'copilot']);
const SCOPES = new Set(['main', 'files-folder-picker', 'git-folder-picker']);

function clean(value, maxLength = 300) {
  if (typeof value !== 'string') return '';
  const result = value.trim();
  return result && result.length <= maxLength ? result : '';
}

export function workbenchRouteKey(route) {
  const runtimeProvider = clean(route?.runtimeProvider, 32);
  const agentId = clean(route?.agentId);
  const sessionId = clean(route?.sessionId);
  if (!PROVIDERS.has(runtimeProvider) || !agentId || !sessionId) return '';
  return [runtimeProvider, agentId, sessionId]
    .map(part => encodeURIComponent(part))
    .join(':');
}

export function workbenchConversationId(route, scope = 'main') {
  const routeKey = workbenchRouteKey(route);
  if (!routeKey) return '';
  const normalizedScope = SCOPES.has(scope) ? scope : 'main';
  return normalizedScope === 'main'
    ? `_workbench:${routeKey}`
    : `_workbench:${routeKey}:${normalizedScope}`;
}

export function workbenchRouteKeyFromConversationId(conversationId, expectedAgentId = '') {
  const raw = clean(conversationId, 4096);
  if (!raw.startsWith('_workbench:')) return '';
  const parts = raw.slice('_workbench:'.length).split(':');
  if (parts.length < 3) return '';
  const routeKey = parts.slice(0, 3).join(':');
  try {
    const decodedRoute = {
      runtimeProvider: decodeURIComponent(parts[0]),
      agentId: decodeURIComponent(parts[1]),
      sessionId: decodeURIComponent(parts[2]),
    };
    if (expectedAgentId && decodedRoute.agentId !== expectedAgentId) return '';
    return workbenchRouteKey(decodedRoute) === routeKey ? routeKey : '';
  } catch {
    return '';
  }
}

function resolveYeaftRow(client, route) {
  if (client?.userId) {
    const owned = yeaftSessionDb.getForAgent(client.userId, route.agentId, route.sessionId);
    if (owned) return owned;
  }
  if (!CONFIG.skipAuth) return null;
  return agents.get(route.agentId)?.yeaftSessions?.get(route.sessionId)
    || yeaftSessionDb.getByAgent(route.agentId).find(row => row?.id === route.sessionId)
    || null;
}

function resolveChatRow(client, route) {
  const row = sessionDb.get(route.sessionId);
  if (!row || row.agent_id !== route.agentId) return null;
  const provider = row.provider === 'copilot' ? 'copilot' : 'claude-code';
  if (provider !== route.runtimeProvider) return null;
  if (!CONFIG.skipAuth) {
    if (!client?.userId) return null;
    if (row.user_id) {
      if (row.user_id !== client.userId) return null;
    } else if (client.role !== 'admin' && agents.get(route.agentId)?.ownerId !== client.userId) {
      return null;
    }
  }
  return row;
}

/**
 * Validate a browser-provided Workbench route against Server-owned Session
 * metadata and return canonical execution fields. Browser cwd and synthetic
 * conversation ids are never authoritative.
 *
 * `legacy: true` preserves old clients that predate route-scoped Workbench.
 */
export function resolveWorkbenchRequest(client, msg, targetAgentId, { allowMissingSession = false } = {}) {
  if (!msg?.workbenchRoute) {
    return {
      legacy: true,
      agentId: targetAgentId,
      conversationId: clean(msg?.conversationId) || null,
      workDir: clean(msg?.workDir, 4096),
      routeKey: '',
    };
  }

  const route = {
    runtimeProvider: clean(msg.workbenchRoute.runtimeProvider, 32),
    agentId: clean(msg.workbenchRoute.agentId),
    sessionId: clean(msg.workbenchRoute.sessionId),
  };
  const routeKey = workbenchRouteKey(route);
  if (!routeKey || route.agentId !== targetAgentId) return null;
  const agent = agents.get(targetAgentId);
  if (!Array.isArray(agent?.capabilities)
      || !agent.capabilities.includes(WORKBENCH_SESSION_ROUTE_CAPABILITY)) return null;

  const row = route.runtimeProvider === 'yeaft'
    ? resolveYeaftRow(client, route)
    : resolveChatRow(client, route);
  if (!row && !allowMissingSession) return null;

  let scope = SCOPES.has(msg.workbenchScope) ? msg.workbenchScope : 'main';
  if (scope === 'main') {
    if (msg.conversationId === '_folder_picker') scope = 'files-folder-picker';
    else if (msg.conversationId === '_git_folder_picker') scope = 'git-folder-picker';
  }
  const sessionWorkDir = clean(row
    ? (route.runtimeProvider === 'yeaft' ? row.workDir : row.work_dir)
    : '', 4096);
  return {
    legacy: false,
    route,
    routeKey,
    scope,
    agentId: route.agentId,
    conversationId: workbenchConversationId(route, scope),
    // Terminal is pinned to this Server-owned cwd. Git and Files retain their
    // existing Agent-path picker and use requestedWorkDir after route auth.
    workDir: sessionWorkDir,
    requestedWorkDir: clean(msg.workDir, 4096) || sessionWorkDir,
  };
}
