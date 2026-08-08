function cleanRoutePart(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Build the stable browser-side identity for one Workbench owner.
 * Each component cache and request must be scoped to this exact route.
 *
 * @param {{runtimeProvider?:string, agentId?:string, sessionId?:string}|null} route
 * @returns {string}
 */
export function workbenchRouteKey(route) {
  const runtimeProvider = cleanRoutePart(route?.runtimeProvider);
  const agentId = cleanRoutePart(route?.agentId);
  const sessionId = cleanRoutePart(route?.sessionId);
  if (!runtimeProvider || !agentId || !sessionId) return '';
  return [runtimeProvider, agentId, sessionId]
    .map(part => encodeURIComponent(part))
    .join(':');
}

export function workbenchConversationId(routeKey, scope = 'main') {
  if (!routeKey) return '';
  const normalizedScope = ['main', 'files-folder-picker', 'git-folder-picker'].includes(scope)
    ? scope
    : 'main';
  return normalizedScope === 'main'
    ? `_workbench:${routeKey}`
    : `_workbench:${routeKey}:${normalizedScope}`;
}

export function workbenchMessageScope(message, routeKey) {
  const conversationId = cleanRoutePart(message?.conversationId);
  if (!routeKey || !conversationId) return null;
  if (conversationId === workbenchConversationId(routeKey)) return 'main';
  for (const scope of ['files-folder-picker', 'git-folder-picker']) {
    if (conversationId === workbenchConversationId(routeKey, scope)) return scope;
  }
  return null;
}

/**
 * Bind legacy Workbench components to an immutable Session route without
 * duplicating the Pinia store. Explicit sub-tool conversation ids (folder
 * pickers) are preserved, while owner, default cwd and correlation metadata
 * always come from the route selected when the component was activated.
 *
 * @param {object} store
 * @param {{routeKey:string,runtimeProvider:string,agentId:string,sessionId:string,conversationId:string,workDir:string}} route
 * @returns {object}
 */
export function createRouteBoundWorkbenchStore(store, route) {
  const sendWsMessage = (message = {}) => {
    const workbenchRoute = {
      runtimeProvider: cleanRoutePart(route.runtimeProvider),
      agentId: cleanRoutePart(route.agentId),
      sessionId: cleanRoutePart(route.sessionId),
    };
    let workbenchScope = 'main';
    if (message.conversationId === '_folder_picker') workbenchScope = 'files-folder-picker';
    else if (message.conversationId === '_git_folder_picker') workbenchScope = 'git-folder-picker';
    const scoped = {
      ...message,
      agentId: workbenchRoute.agentId,
      workbenchRoute,
      workbenchRouteKey: route.routeKey,
      workbenchScope,
      conversationId: workbenchConversationId(route.routeKey, workbenchScope),
    };
    if (!Object.hasOwn(scoped, 'workDir') && route.workDir) scoped.workDir = route.workDir;
    return store.sendWsMessage(scoped);
  };

  return new Proxy(store, {
    get(target, property, receiver) {
      if (property === 'currentAgent') return route.agentId || null;
      if (property === 'currentConversation') return route.conversationId || route.sessionId || null;
      if (property === 'effectiveWorkDir') return route.workDir || '';
      if (property === 'activeSessionRoute') {
        return {
          runtimeProvider: route.runtimeProvider,
          agentId: route.agentId,
          sessionId: route.sessionId,
        };
      }
      if (property === 'sendWsMessage') return sendWsMessage;
      return Reflect.get(target, property, receiver);
    },
    set(target, property, value, receiver) {
      return Reflect.set(target, property, value, receiver);
    },
  });
}

export function isWorkbenchMessageForRoute(message, routeKey) {
  if (!routeKey) return true;
  if (message?.workbenchRouteKey) return message.workbenchRouteKey === routeKey;
  // Rolling-upgrade fallback: old Servers echo the synthetic conversation id
  // but do not yet project workbenchRouteKey.
  return workbenchMessageScope(message, routeKey) !== null;
}
