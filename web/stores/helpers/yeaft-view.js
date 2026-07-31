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
 *   _savedChatIdentity: { agentId: string | null, agentInfo: object | null, workDir: string | null } | null,
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
      _savedChatIdentity: null,
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
    _savedChatIdentity: null,
    _pendingChatRestoreConversationId: pendingChatRestoreConversationId,
  };
}

/**
 * Capture the Chat identity before any Agent switch starts. Calling this again
 * during the same Yeaft visit preserves the original snapshot.
 *
 * @param {{
 *   activeConversations: string[],
 *   currentAgent: string | null,
 *   currentAgentInfo: object | null,
 *   currentWorkDir: string | null,
 *   _yeaftTransitionActive: boolean,
 *   _savedActiveConversations: string[] | null,
 *   _savedChatIdentity: { agentId: string | null, agentInfo: object | null, workDir: string | null } | null,
 * }} store — minimal store-shaped object
 * @returns {boolean} true if this call took a fresh snapshot
 */
export function beginYeaftTransition(store) {
  if (store._yeaftTransitionActive) return false;
  store._savedActiveConversations = [...store.activeConversations];
  store._savedChatIdentity = {
    agentId: store.currentAgent || null,
    agentInfo: store.currentAgentInfo ? { ...store.currentAgentInfo } : null,
    workDir: store.currentWorkDir || null,
  };
  store._yeaftTransitionActive = true;
  return true;
}

/** Swap the visible conversation after the Yeaft Agent target is known. */
export function applyEnterYeaftTransition(store) {
  const enteringFresh = beginYeaftTransition(store);
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
 *   currentAgent: string | null,
 *   currentAgentInfo: object | null,
 *   currentWorkDir: string | null,
 *   _yeaftTransitionActive: boolean,
 *   _savedActiveConversations: string[] | null,
 *   _savedChatIdentity: { agentId: string | null, agentInfo: object | null, workDir: string | null } | null,
 * }} store
 * @returns {{ agentId: string | null, agentInfo: object | null, workDir: string | null } | null}
 */
export function applyLeaveYeaftTransition(store) {
  if (!store._yeaftTransitionActive) return null;
  const chatIdentity = store._savedChatIdentity || null;
  store.activeConversations = store._savedActiveConversations || [];
  if (chatIdentity) {
    store.currentAgent = chatIdentity.agentId;
    store.currentAgentInfo = chatIdentity.agentInfo;
    store.currentWorkDir = chatIdentity.workDir;
  }
  store._savedActiveConversations = null;
  store._savedChatIdentity = null;
  store._yeaftTransitionActive = false;
  return chatIdentity;
}
