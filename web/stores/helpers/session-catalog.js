const CHAT_RUNTIME_PROVIDERS = new Set(['claude-code', 'copilot']);

export function normalizeChatRuntimeProvider(provider) {
  if (provider == null || provider === '') return 'claude-code';
  if (CHAT_RUNTIME_PROVIDERS.has(provider)) return provider;
  throw new Error(`Unknown Chat runtime provider: ${provider}`);
}

export function chatCatalogKey(conversationId) {
  if (typeof conversationId !== 'string' || !conversationId) {
    throw new Error('Chat catalog key requires conversationId');
  }
  return `chat:${conversationId}`;
}

export function yeaftCatalogKey(agentId, sessionId) {
  if (typeof agentId !== 'string' || !agentId || typeof sessionId !== 'string' || !sessionId) {
    throw new Error('Yeaft catalog key requires agentId and sessionId');
  }
  return `yeaft:${agentId}:${sessionId}`;
}

export function chatRouteRef(conversation) {
  if (!conversation?.id || !conversation?.agentId) {
    throw new Error('Chat route requires conversation id and agentId');
  }
  return {
    runtimeProvider: normalizeChatRuntimeProvider(conversation.provider),
    agentId: conversation.agentId,
    sessionId: conversation.id,
  };
}

export function yeaftRouteRef(session) {
  if (!session?.id || !session?.agentId) {
    throw new Error('Yeaft route requires session id and agentId');
  }
  return {
    runtimeProvider: 'yeaft',
    agentId: session.agentId,
    sessionId: session.id,
  };
}

export function catalogKeyForRoute(routeRef) {
  if (routeRef?.runtimeProvider === 'yeaft') {
    return yeaftCatalogKey(routeRef.agentId, routeRef.sessionId);
  }
  normalizeChatRuntimeProvider(routeRef?.runtimeProvider);
  return chatCatalogKey(routeRef?.sessionId);
}

export function beginCatalogMutation(store, requestId) {
  const previousCatalog = store.sessionCatalog.map(item => ({ ...item }));
  store.sessionCatalogMutationRequests[requestId] = { previousCatalog };
  return previousCatalog;
}

export function finishCatalogMutation(store, msg) {
  const request = msg?.requestId ? store.sessionCatalogMutationRequests[msg.requestId] : null;
  if (!request) return false;
  delete store.sessionCatalogMutationRequests[msg.requestId];
  if (msg.ok !== true) store.sessionCatalog = request.previousCatalog;
  return true;
}

export function beginChatHistoryRequest(store, conversationId, mode = 'recent', cursor = null) {
  const catalogKey = chatCatalogKey(conversationId);
  const prior = store.chatHistoryRequests[catalogKey] || {};
  const generation = Number(prior.generation || 0) + 1;
  const requestId = `chat_history_${generation}_${crypto.randomUUID()}`;
  store.chatHistoryRequests[catalogKey] = {
    requestId,
    catalogKey,
    generation,
    mode,
    cursor,
    connectionGeneration: Number(store.chatHistoryConnectionGeneration || 0),
    loading: true,
    cancelled: false,
    error: null,
  };
  return requestId;
}

export function cancelChatHistoryRequest(store, catalogKey, requestId, error) {
  const pending = store.chatHistoryRequests[catalogKey];
  if (pending?.requestId !== requestId) return false;
  store.chatHistoryRequests[catalogKey] = {
    ...pending,
    loading: false,
    cancelled: true,
    error,
  };
  return true;
}
