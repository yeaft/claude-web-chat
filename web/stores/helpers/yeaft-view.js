// Helpers for the Chat ↔ Yeaft view transition.
//
// The split-out logic exists for one reason: the snapshot of
// `activeConversations` taken on entering Yeaft must NOT be overwritten
// by repeat calls to enterYeaft while the user is already in Yeaft view.
// If it is, leaveYeaft will "restore" the yeaft-only conversationId back
// into the Chat view's active list — which manifests as Yeaft messages
// bleeding into Chat after leaving and re-entering.
//
// Keeping this in a pure helper lets us unit-test the behaviour without
// standing up Pinia, the WebSocket harness, or the rest of the store.

const PREFERRED_CONVERSATION_VIEW_KEY = 'yeaft-preferred-conversation-view';
const DEFAULT_CONVERSATION_VIEW = 'chat';

/**
 * Read the last conversation surface selected by the user. Work Center is a
 * temporary Agent-level surface, so only Chat and Yeaft Session are persisted.
 * Invalid or unavailable browser storage falls back to Chat.
 *
 * @param {Storage | null | undefined} storage
 * @returns {'chat' | 'yeaft'}
 */
export function readPreferredConversationView(storage = globalThis.localStorage) {
  try {
    return storage?.getItem(PREFERRED_CONVERSATION_VIEW_KEY) === 'yeaft'
      ? 'yeaft'
      : DEFAULT_CONVERSATION_VIEW;
  } catch {
    return DEFAULT_CONVERSATION_VIEW;
  }
}

/**
 * Persist a user-selected conversation surface. Ignore unsupported values so
 * transient pages cannot replace the user's Chat/Yeaft Session preference.
 *
 * @param {string} view
 * @param {Storage | null | undefined} storage
 * @returns {boolean} whether the preference was written
 */
export function persistPreferredConversationView(view, storage = globalThis.localStorage) {
  if (view !== 'chat' && view !== 'yeaft') return false;
  try {
    storage?.setItem(PREFERRED_CONVERSATION_VIEW_KEY, view);
    return !!storage;
  } catch {
    return false;
  }
}

/**
 * Build the persisted view preference and the separate runtime transition
 * state. A restored Yeaft view starts with the last Chat conversation already
 * saved so leaving Yeaft works even before the first agent_list arrives.
 *
 * @param {Storage | null | undefined} storage
 * @returns {{
 *   currentView: 'chat' | 'yeaft',
 *   _yeaftTransitionActive: boolean,
 *   _savedActiveConversations: string[] | null,
 *   _pendingChatRestoreConversationId: string | null,
 * }}
 */
export function createInitialConversationViewState(storage = globalThis.localStorage) {
  const currentView = readPreferredConversationView(storage);
  if (currentView !== 'yeaft') {
    return {
      currentView,
      _yeaftTransitionActive: false,
      _savedActiveConversations: null,
      _pendingChatRestoreConversationId: null,
    };
  }

  let lastViewedConversation = null;
  try {
    lastViewedConversation = storage?.getItem('lastViewedConversation') || null;
  } catch {
    // Browser storage can be blocked. The Yeaft view still restores, but Chat
    // has no previous conversation to recover when the user leaves it.
  }
  const pendingChatRestoreConversationId = lastViewedConversation
    && !lastViewedConversation.startsWith('yeaft-')
    ? lastViewedConversation
    : null;
  return {
    currentView,
    _yeaftTransitionActive: true,
    _savedActiveConversations: null,
    _pendingChatRestoreConversationId: pendingChatRestoreConversationId,
  };
}

/**
 * Apply the entering-Yeaft side of the chat ↔ yeaft transition. Mutates
 * `store.activeConversations` and `store._savedActiveConversations` in
 * place, idempotently — calling this multiple times while already in
 * Yeaft is safe and preserves the original Chat snapshot.
 *
 * @param {{
 *   activeConversations: string[],
 *   _yeaftTransitionActive: boolean,
 *   _savedActiveConversations: string[] | null,
 *   yeaftConversationId: string,
 * }} store — minimal store-shaped object
 * @returns {boolean} true if this call took a fresh snapshot; false if it was
 *   a redundant call during the same runtime Yeaft transition.
 */
export function applyEnterYeaftTransition(store) {
  const enteringFresh = !store._yeaftTransitionActive;
  if (enteringFresh) {
    store._savedActiveConversations = [...store.activeConversations];
    store._yeaftTransitionActive = true;
  }
  store.activeConversations = [store.yeaftConversationId];
  return enteringFresh;
}

/**
 * Apply the leaving-Yeaft side of the transition. Restores the saved
 * snapshot if one exists; no-op if leaveYeaft is called without a prior
 * enterYeaft (e.g. on cold boot).
 *
 * @param {{
 *   activeConversations: string[],
 *   _yeaftTransitionActive: boolean,
 *   _savedActiveConversations: string[] | null,
 * }} store
 */
export function applyLeaveYeaftTransition(store) {
  if (!store._yeaftTransitionActive) return;
  store.activeConversations = store._savedActiveConversations || [];
  store._savedActiveConversations = null;
  store._yeaftTransitionActive = false;
}
