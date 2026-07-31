const RETIRED_CONVERSATION_LIMIT = 8;

function retiredConversationIds(store, agentId) {
  return agentId && Array.isArray(store?._yeaftRetiredConversationIdsByAgent?.[agentId])
    ? store._yeaftRetiredConversationIdsByAgent[agentId]
    : [];
}

export function isRetiredYeaftConversation(store, agentId, conversationId) {
  if (!agentId || !conversationId) return false;
  return retiredConversationIds(store, agentId).includes(conversationId);
}

export function retireYeaftConversation(store, agentId, conversationId) {
  if (!agentId || !conversationId) return;
  const nextRetired = retiredConversationIds(store, agentId)
    .filter(id => id !== conversationId)
    .concat(conversationId)
    .slice(-RETIRED_CONVERSATION_LIMIT);
  store._yeaftRetiredConversationIdsByAgent = {
    ...(store._yeaftRetiredConversationIdsByAgent || {}),
    [agentId]: nextRetired,
  };
}

export function reviveYeaftConversation(store, agentId, conversationId) {
  if (!agentId || !conversationId || !store?._yeaftRetiredConversationIdsByAgent) return;
  const nextRetired = retiredConversationIds(store, agentId).filter(id => id !== conversationId);
  store._yeaftRetiredConversationIdsByAgent = {
    ...store._yeaftRetiredConversationIdsByAgent,
    [agentId]: nextRetired,
  };
}
