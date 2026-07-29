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
