/**
 * Pure selectors over the chat store's "which conversation is the active
 * view sourcing from?" question.
 *
 * Lives in its own helper so:
 *   1. The Yeaft-vs-Chat routing rule has ONE canonical implementation
 *      (chat.js's `messages`, `vpsTypingInCurrentConv`,
 *      `isVpTypingInCurrentConv` all flow through it instead of each
 *      open-coding the ternary).
 *   2. We can unit-test the rule against a plain state shape without
 *      booting Pinia / Vue.
 *
 * Bug fixed: chat-mode WebSocket handlers (conversation_resumed,
 * conversation_selected and agent_list restore)
 * unconditionally write `state.activeConversations` regardless of
 * `currentView`. When the user is sitting on the Yeaft page, that
 * background clobber used to be observable through every getter that
 * read `state.activeConversations[0]` — chat messages bled into the
 * Yeaft view and VP typing badges silently disappeared.
 *
 * The fix: in Yeaft view, source only from the explicit visible pointer
 * `state.yeaftConversationId`. Per-agent conversation ids are transport/cache
 * metadata and can change when an inactive Session resolves local → real; they
 * must not masquerade as a user-visible conversation switch. Chat keeps the
 * existing behaviour.
 */

/**
 * Returns the conversation id the active VIEW should be reading from,
 * or null if the view has no active conversation yet.
 */
export function selectActiveConversationId(state) {
  if (state.currentView === 'yeaft') {
    // `yeaftConversationIdsByAgent` tracks each bridge's latest transport id.
    // Background Sessions on the same agent share that entry, so reading it
    // here lets an inactive local → real migration look like a visible switch.
    // User actions and visible output explicitly maintain this pointer instead.
    return state.yeaftConversationId || null;
  }
  // Chat uses `activeConversations[0]`.
  return state.activeConversations[0] || null;
}
