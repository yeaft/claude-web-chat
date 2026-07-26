import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkItemStore } from '../../../agent/yeaft/work-center/store.js';
import { WorkflowController } from '../../../agent/yeaft/work-center/controller.js';
import { WorkCenterService } from '../../../agent/yeaft/work-center/service.js';
import {
  projectActionMessagePage,
  projectWorkCenterEvent,
} from '../../../agent/yeaft/work-center/projection.js';

globalThis.localStorage = {
  _m: new Map(),
  getItem(k) { return this._m.has(k) ? this._m.get(k) : null; },
  setItem(k, v) { this._m.set(k, String(v)); },
  removeItem(k) { this._m.delete(k); },
};

function createStoreFactory(_id, options) {
  let instance = null;
  return () => {
    if (instance) return instance;
    instance = { ...(typeof options.state === 'function' ? options.state() : {}) };
    for (const [name, getter] of Object.entries(options.getters || {})) {
      Object.defineProperty(instance, name, { enumerable: true, get() { return getter(instance); } });
    }
    for (const [name, action] of Object.entries(options.actions || {})) instance[name] = action.bind(instance);
    return instance;
  };
}

globalThis.Pinia = { defineStore: createStoreFactory };
const sessionsStore = {
  sessionById: (id, agentId) => ({ id, agentId: agentId || (id === 'same' ? 'agent-a' : 'agent-a') }),
};
globalThis.window = {
  addEventListener: vi.fn(), removeEventListener: vi.fn(),
  Pinia: { useSessionsStore: () => sessionsStore },
};
globalThis.document = { addEventListener: vi.fn(), removeEventListener: vi.fn(), documentElement: { setAttribute() {}, classList: { toggle() {} } } };

const { useChatStore } = await import('../../../web/stores/chat.js');
const { handleAssistantOutputFrame } = await import('../../../web/stores/helpers/assistantOutput.js');
const { handleYeaftHistoryWindow: mergeYeaftHistoryWindow } = await import('../../../web/stores/helpers/handlers/conversationHandler.js');
const {
  mergeActionMessages,
  workCenterActionMessageKey,
  workItemDetailRefreshIdentity,
} = await import('../../../web/stores/helpers/work-center.js');
const { yeaftHistoryIdentityKey } = await import('../../../web/stores/helpers/yeaft-history-identity.js');
const { revealOutlineResult } = await import('../../../web/utils/message-search-navigation.js');

function primeStore() {
  const store = useChatStore();
  store.currentView = 'yeaft';
  store.currentAgent = 'agent-a';
  store.currentAgentInfo = { id: 'agent-a', version: '1.0.201', capabilities: ['session_history_outline'] };
  store.agents = [{ id: 'agent-a', version: '1.0.201', capabilities: ['session_history_outline'] }];
  store.yeaftActiveSessionFilter = 'same';
  store.yeaftSessionAgentById = { same: 'agent-a' };
  store.yeaftHistoryOutlineBySession = {};
  store._yeaftHistoryOutlineTimeouts = {};
  store.messagesMap = {};
  store.yeaftConversationId = 'conv-a';
  store.yeaftConversationIdsByAgent = { 'agent-a': 'conv-a' };
  const sent = [];
  store.sendWsMessage = msg => sent.push(msg);
  store._sent = sent;
  return store;
}

describe('Yeaft history outline state', () => {
  beforeEach(() => vi.useFakeTimers());



  it('sends sender-only searches and rejects stale sender responses', () => {
    const store = primeStore();
    store.currentAgentInfo.capabilities.push('session_history_search');
    store.agents[0].capabilities.push('session_history_search');

    expect(store.searchYeaftHistory('', { senderKey: 'vp:linus' })).toBe(true);
    const first = store._sent.at(-1);
    expect(first).toMatchObject({
      type: 'yeaft_search_history', query: '', senderKey: 'vp:linus', sessionId: 'same',
    });

    store.yeaftHistorySearchState.nextBeforeSeq = 40;
    expect(store.searchYeaftHistory('', { senderKey: 'user', append: true })).toBe(true);
    const second = store._sent.at(-1);
    expect(second).toMatchObject({ query: '', senderKey: 'user' });
    expect(second).not.toHaveProperty('beforeSeq');
    expect(store.handleYeaftHistorySearchResult({
      agentId: 'agent-a', sessionId: 'same', requestId: second.requestId,
      query: '', senderKey: 'vp:linus', results: [],
    })).toBe(false);
  });

  it('loads and expands an uncached old anchor through the click action', async () => {
    const store = primeStore();
    store.currentAgentInfo.capabilities.push('session_history_search', 'session_history_window_prefetch');
    store.agents[0].capabilities.push('session_history_search', 'session_history_window_prefetch');
    store.messagesMap['conv-a'] = Array.from({ length: 12 }, (_, index) => ({
      id: `m${index + 50}`,
      messageId: `m${index + 50}`,
      type: index % 2 ? 'assistant' : 'user',
      content: `recent ${index}`,
      sessionId: 'same',
      timestamp: index + 50,
    }));
    store.yeaftMessageWindowState = { same: { visibleTurns: 5 } };

    const renderedReveal = vi.fn(() => store.yeaftMessageWindowState.same.visibleTurns > 5);
    const clicked = revealOutlineResult({
      result: { messageId: 'm42', seq: 42 },
      revealWindow: candidate => store.revealYeaftHistoryResult(candidate),
      nextTick: vi.fn().mockResolvedValue(undefined),
      revealMessage: renderedReveal,
      isMobile: false,
    });
    const request = store._sent.at(-1);
    const response = {
      agentId: 'agent-a',
      sessionId: 'same',
      requestId: request.requestId,
      messages: [{ id: 'm42', role: 'assistant', content: 'old answer', createdAt: 42 }],
    };
    const conversationId = mergeYeaftHistoryWindow(store, response);

    expect(conversationId).toBe('conv-a');
    expect(store.messagesMap['conv-a'].some(row => row.persistedMessageId === 'm42' || row.messageId === 'm42')).toBe(true);
    expect(store.handleYeaftHistoryWindow(response, conversationId)).toBe(true);
    await expect(clicked).resolves.toBe(true);
    expect(renderedReveal).toHaveBeenCalledWith('m42');
    expect(store.isYeaftMessageCached('same', 'm42')).toBe(true);
    expect(store.yeaftMessageWindowState.same.visibleTurns).toBeGreaterThan(5);
  });

  it('reuses one bounded history-window request across hover prefetch and click', async () => {
    const store = primeStore();
    const result = { messageId: 'm42', seq: 42 };

    const prefetched = store.loadYeaftHistoryWindow(result);
    const clicked = store.loadYeaftHistoryWindow(result);

    expect(clicked).toBe(prefetched);
    expect(store._sent).toHaveLength(1);
    const request = store._sent[0];
    expect(request).toMatchObject({ beforeTurns: 5, afterTurns: 5 });

    const response = {
      agentId: 'agent-a',
      sessionId: 'same',
      requestId: request.requestId,
      messages: [{ id: 'm42', role: 'assistant', content: 'old answer', createdAt: 42 }],
    };
    const conversationId = mergeYeaftHistoryWindow(store, response);
    expect(store.handleYeaftHistoryWindow(response, conversationId)).toBe(true);
    await expect(prefetched).resolves.toBe(true);
    expect(store._yeaftHistoryWindowPendingByKey).toEqual({});
  });

  it('keeps prefetch cache-only, then expands an already-prefetched anchor on click', async () => {
    const store = primeStore();
    store.messagesMap['conv-a'] = Array.from({ length: 12 }, (_, index) => ({
      id: `m${index + 50}`,
      messageId: `m${index + 50}`,
      type: index % 2 ? 'assistant' : 'user',
      content: `recent ${index}`,
      sessionId: 'same',
      timestamp: index + 50,
    }));
    const initialWindow = { visibleTurns: 5 };
    store.yeaftMessageWindowState = { same: initialWindow };

    const prefetched = store.loadYeaftHistoryWindow({ messageId: 'm42', seq: 42 });
    const request = store._sent.at(-1);
    const response = {
      agentId: 'agent-a',
      sessionId: 'same',
      requestId: request.requestId,
      messages: [{ id: 'm42', role: 'assistant', content: 'old answer', createdAt: 42 }],
    };
    const conversationId = mergeYeaftHistoryWindow(store, response);
    expect(store.handleYeaftHistoryWindow(response, conversationId)).toBe(true);
    await expect(prefetched).resolves.toBe(true);

    expect(store.yeaftMessageWindowState.same).toBe(initialWindow);
    expect(store.isYeaftMessageCached('same', 'm42')).toBe(true);
    const renderedReveal = vi.fn(() => store.yeaftMessageWindowState.same.visibleTurns > 5);
    await expect(revealOutlineResult({
      result: { messageId: 'm42', seq: 42 },
      revealWindow: candidate => store.revealYeaftHistoryResult(candidate),
      nextTick: vi.fn().mockResolvedValue(undefined),
      revealMessage: renderedReveal,
      isMobile: false,
    })).resolves.toBe(true);
    expect(renderedReveal).toHaveBeenCalledWith('m42');
    expect(store._sent).toHaveLength(1);
    expect(store.yeaftMessageWindowState.same.visibleTurns).toBeGreaterThan(5);
  });

  it('does not expand or render after the active Session changes while a window is pending', async () => {
    const store = primeStore();
    store.messagesMap['conv-a'] = Array.from({ length: 12 }, (_, index) => ({
      id: `m${index + 50}`,
      messageId: `m${index + 50}`,
      type: 'user',
      content: `recent ${index}`,
      sessionId: 'same',
      timestamp: index + 50,
    }));
    store.yeaftMessageWindowState = { same: { visibleTurns: 5 }, other: { visibleTurns: 5 } };
    const renderedReveal = vi.fn();

    const clicked = revealOutlineResult({
      result: { messageId: 'm42', seq: 42 },
      revealWindow: candidate => store.revealYeaftHistoryResult(candidate),
      nextTick: vi.fn().mockResolvedValue(undefined),
      revealMessage: renderedReveal,
      isMobile: false,
    });
    const request = store._sent.at(-1);
    store.yeaftActiveSessionFilter = 'other';
    store.yeaftSessionAgentById.other = 'agent-a';

    const response = {
      agentId: 'agent-a',
      sessionId: 'same',
      requestId: request.requestId,
      messages: [{ id: 'm42', role: 'assistant', content: 'old answer', createdAt: 42 }],
    };
    const conversationId = mergeYeaftHistoryWindow(store, response);
    expect(store.handleYeaftHistoryWindow(response, conversationId)).toBe(true);

    await expect(clicked).resolves.toBe(false);
    expect(store.yeaftMessageWindowState.same.visibleTurns).toBe(5);
    expect(store.yeaftMessageWindowState.other.visibleTurns).toBe(5);
    expect(renderedReveal).not.toHaveBeenCalled();
  });

  it('does not expand or render after the same Session migrates conversation while a window is pending', async () => {
    const store = primeStore();
    store.messagesMap['conv-a'] = Array.from({ length: 12 }, (_, index) => ({
      id: `m${index + 50}`,
      messageId: `m${index + 50}`,
      type: 'user',
      content: `recent ${index}`,
      sessionId: 'same',
      timestamp: index + 50,
    }));
    store.messagesMap['conv-b'] = [];
    store.yeaftMessageWindowState = { same: { visibleTurns: 5 } };
    const renderedReveal = vi.fn();

    const clicked = revealOutlineResult({
      result: { messageId: 'm42', seq: 42 },
      revealWindow: candidate => store.revealYeaftHistoryResult(candidate),
      nextTick: vi.fn().mockResolvedValue(undefined),
      revealMessage: renderedReveal,
      isMobile: false,
    });
    const request = store._sent.at(-1);
    store.yeaftConversationIdsByAgent = { 'agent-a': 'conv-b' };
    store.yeaftConversationId = 'conv-b';

    const response = {
      agentId: 'agent-a',
      sessionId: 'same',
      requestId: request.requestId,
      messages: [{ id: 'm42', role: 'assistant', content: 'old answer', createdAt: 42 }],
    };
    const conversationId = mergeYeaftHistoryWindow(store, response);
    expect(conversationId).toBe('conv-b');
    expect(store.handleYeaftHistoryWindow(response, conversationId)).toBe(true);

    await expect(clicked).resolves.toBe(false);
    expect(store.yeaftMessageWindowState.same.visibleTurns).toBe(5);
    expect(renderedReveal).not.toHaveBeenCalled();
  });







  it('reveals a tool-only response through its persisted anchor', () => {
    const store = primeStore();
    store.messagesMap['conv-a'] = [{
      id: 'm42:tool-summary',
      messageId: 'm42:tool-summary',
      persistedMessageId: 'm42',
      type: 'tool-summary',
      sessionId: 'same',
      turnId: 'response-tool-only',
    }];

    expect(store.revealYeaftMessage('same', 'm42')).toBe(true);
  });



  it('force-refreshes a loaded visible outline when a completed response has no durable anchor yet', () => {
    const store = primeStore();
    const key = yeaftHistoryIdentityKey('agent-a', 'same');
    store.messagesMap['conv-a'] = [{
      id: 'local-answer', messageId: 'local-answer', type: 'assistant', content: 'finished answer',
      sessionId: 'same', turnId: 'response-local', speakerVpId: 'maker', isStreaming: true, status: 'pending',
    }];
    store.yeaftHistoryOutlineBySession[key] = {
      agentId: 'agent-a', sessionId: 'same', loaded: true, loading: false,
      results: [], hasMore: false, nextBeforeSeq: null, totalCount: 0, error: null,
    };
    store._currentYeaftSessionId = 'same';
    store._currentYeaftTurnId = 'response-local';
    store._currentYeaftVpId = 'maker';
    store.processingConversations = { 'conv-a': true };
    store.activeVpTurns = {};
    store.executionStatusMap = {};
    store.conversations = [];
    store.vpStatuses = {};
    store._turnCompletedConvs = new Set();

    handleAssistantOutputFrame(store, 'conv-a', { type: 'result', result_text: '' });

    expect(store._sent).toHaveLength(1);
    expect(store._sent[0]).toMatchObject({
      type: 'yeaft_load_history_outline', agentId: 'agent-a', sessionId: 'same', includeTotal: true,
    });
    expect(store.yeaftHistoryOutlineBySession[key]).toMatchObject({ loaded: false, loading: true });
  });







  it('keeps pending refresh state isolated by agent and Session identity', () => {
    const store = primeStore();
    const keyA = yeaftHistoryIdentityKey('agent-a', 'same');
    const keyB = yeaftHistoryIdentityKey('agent-b', 'other');
    store.agents.push({ id: 'agent-b', version: '1.0.201', capabilities: ['session_history_outline'] });
    store.yeaftSessionAgentById.other = 'agent-b';
    store.yeaftHistoryOutlineBySession[keyA] = {
      agentId: 'agent-a', sessionId: 'same', loaded: true, loading: true,
      requestId: 'request-a', requestAppend: true, refreshPending: false,
      results: [], hasMore: false, nextBeforeSeq: null, totalCount: 0, error: null,
    };
    store.yeaftHistoryOutlineBySession[keyB] = {
      agentId: 'agent-b', sessionId: 'other', loaded: true, loading: true,
      requestId: 'request-b', requestAppend: true, refreshPending: false,
      results: [], hasMore: false, nextBeforeSeq: null, totalCount: 0, error: null,
    };

    expect(store.invalidateYeaftHistoryOutline('same')).toBe(true);
    expect(store.yeaftHistoryOutlineBySession[keyA].refreshPending).toBe(true);
    expect(store.yeaftHistoryOutlineBySession[keyB].refreshPending).toBe(false);

    expect(store.handleYeaftHistoryOutline({
      agentId: 'agent-b', sessionId: 'other', requestId: 'request-b', results: [],
      hasMore: false, nextBeforeSeq: null,
    })).toBe(true);
    expect(store._sent).toHaveLength(0);

    expect(store.handleYeaftHistoryOutline({
      agentId: 'agent-a', sessionId: 'same', requestId: 'request-a', results: [],
      hasMore: false, nextBeforeSeq: null,
    })).toBe(true);
    expect(store._sent).toHaveLength(1);
    expect(store._sent[0]).toMatchObject({ agentId: 'agent-a', sessionId: 'same' });
  });



  it('keeps the promoted recent page bounded and exposes the displaced older cursor', () => {
    const store = primeStore();
    const key = yeaftHistoryIdentityKey('agent-a', 'same');
    store.yeaftHistoryOutlineBySession[key] = {
      agentId: 'agent-a', sessionId: 'same', loaded: true, loading: false,
      results: Array.from({ length: 50 }, (_, index) => ({
        messageId: `m${index + 1}`, seq: index + 1, role: 'user', snippet: `row ${index + 1}`,
      })),
      hasMore: false, nextBeforeSeq: null, totalCount: 50, error: null,
    };

    expect(store.promoteYeaftHistoryOutlineRow({
      id: 'm51', messageId: 'm51', type: 'assistant', content: 'new response',
      sessionId: 'same', turnId: 'response-51', speakerVpId: 'maker',
    })).toBe(true);

    expect(store.yeaftHistoryOutlineBySession[key]).toMatchObject({
      hasMore: true, nextBeforeSeq: 2, totalCount: 51,
    });
    expect(store.yeaftHistoryOutlineBySession[key].results).toHaveLength(50);
    expect(store.yeaftHistoryOutlineBySession[key].results[0].messageId).toBe('m2');
    expect(store.yeaftHistoryOutlineBySession[key].results.at(-1).messageId).toBe('m51');
  });



  it('merges one in-flight response and advances another client to a retried Action generation', async () => {
    const store = primeStore();
    store.messagesMap['conv-a'] = [
      { id: 'live-a', messageId: 'live-a', type: 'assistant', content: 'working ', sessionId: 'same', turnId: 'response-live', speakerVpId: 'maker', isStreaming: true },
      { id: 'live-b', messageId: 'live-b', type: 'assistant', content: 'done', sessionId: 'same', turnId: 'response-live', speakerVpId: 'maker', isStreaming: true },
    ];
    store.yeaftHistoryOutlineBySession[yeaftHistoryIdentityKey('agent-a', 'same')] = {
      agentId: 'agent-a', sessionId: 'same', loaded: true, loading: false,
      results: [], hasMore: false, nextBeforeSeq: null, totalCount: 0, error: null,
    };

    const state = store.getYeaftHistoryOutlineState();
    expect(state.results).toHaveLength(1);
    expect(state.results[0]).toMatchObject({ role: 'assistant', turnId: 'response-live' });
    expect(state.totalCount).toBe(1);

    const sameTime = 100;
    const mergedActionMessages = mergeActionMessages(
      [{ id: 'event:10', role: 'user', text: 'legacy ten', createdAt: sameTime, updatedAt: 1 }],
      [
        { id: 'event:2', role: 'user', text: 'page two', createdAt: sameTime },
        { id: 'event:10', role: 'user', text: 'fresh ten', createdAt: sameTime, updatedAt: 2 },
      ],
      [
        { id: 'run:z', role: 'assistant', text: 'inline z', createdAt: sameTime, generation: 2, attempt: 2 },
        { id: 'event:9', role: 'user', text: 'inline nine', createdAt: sameTime },
      ],
      { id: 'run:a', role: 'assistant', text: 'live a', createdAt: sameTime, generation: 2, attempt: 3 },
    );
    expect(mergedActionMessages.map(message => message.id)).toEqual([
      'event:2', 'event:9', 'event:10', 'run:z', 'run:a',
    ]);
    expect(mergedActionMessages.find(message => message.id === 'event:10')?.text).toBe('fresh ten');

    store.workCenterItemsByAgent = { 'agent-a': [] };
    store.workCenterDetailByAgent = {
      'agent-a': {
        id: 'wi-1', revision: 4, updatedAt: 10, currentActionId: 'action-1',
        actions: [{
          id: 'action-1', generation: 1, status: 'failed', progressRevision: 2,
          messages: [{ id: 'old-inline', text: 'Old failure' }],
          thread: [{ generation: 1, canonical: true, messages: [] }],
          liveMessage: { id: 'old-live', text: 'Old live failure' },
          response: 'Old failure', failure: { error: 'Old failure' }, messageCursor: '1', messageCount: 1,
        }],
      },
    };
    store.workCenterActionMessages = {
      'agent-a:wi-1:action-1:1': {
        generation: 1, messages: [{ id: 'old-cache', text: 'Old failure' }], nextCursor: null, total: 1,
      },
    };
    const pendingRequests = [];
    store.workCenterRequest = vi.fn(operation => new Promise(resolve => {
      const entry = {
        operation,
        resolved: false,
        resolve(value) {
          entry.resolved = true;
          resolve(value);
        },
      };
      pendingRequests.push(entry);
    }));
    const eventSummary = {
      id: 'wi-1', revision: 5, updatedAt: 20, currentActionId: 'action-1',
      currentAction: { id: 'action-1', generation: 2, status: 'ready' },
      actionStats: [{ id: 'action-1', generation: 2, status: 'ready', progressRevision: 3 }],
    };

    store.applyWorkCenterEvent('agent-a', { type: 'action.retried', workItem: eventSummary });

    const advanced = store.workCenterDetailByAgent['agent-a'].actions[0];
    expect(advanced).toMatchObject({ id: 'action-1', generation: 2, status: 'ready' });
    expect(advanced).not.toHaveProperty('messages');
    expect(advanced).not.toHaveProperty('thread');
    expect(advanced).not.toHaveProperty('liveMessage');
    expect(advanced).not.toHaveProperty('response');
    const oldKey = workCenterActionMessageKey('agent-a', 'wi-1', 'action-1', 1);
    const currentKey = workCenterActionMessageKey(
      'agent-a', 'wi-1', 'action-1', advanced.generation,
    );
    expect(currentKey).toBe('agent-a:wi-1:action-1:2');
    expect(store.workCenterActionMessages[oldKey].messages)
      .toEqual([expect.objectContaining({ id: 'old-cache' })]);
    expect(store.workCenterActionMessages[currentKey]).toBeUndefined();
    expect(store._workCenterActionMessageGenerationByKey[currentKey]).toBe(1);
    expect(store._workCenterDetailEventRefreshByAgent['agent-a']).toMatchObject({
      key: 'wi-1:action-1:2',
    });

    const staleMessagePage = store.loadWorkItemActionMessages(
      'wi-1', 'action-1', advanced.generation, null, 'agent-a',
    );
    pendingRequests.find(request => request.operation === 'get_action_messages').resolve({
      actionId: 'action-1', generation: 1,
      messages: [{ id: 'late-old', text: 'Late old failure' }], nextCursor: null, total: 1,
    });
    await staleMessagePage;
    expect(store.workCenterActionMessages[currentKey]).toBeUndefined();

    pendingRequests.find(request => request.operation === 'get').resolve({
      ...eventSummary,
      actions: [{ id: 'action-1', generation: 2, status: 'ready', progressRevision: 3, messages: [] }],
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(store.workCenterDetailByAgent['agent-a'].actions[0]).toMatchObject({
      id: 'action-1', generation: 2, messages: [],
    });

    store.workCenterDetailByAgent = {
      ...store.workCenterDetailByAgent,
      'agent-a': {
        id: 'wi-1', revision: 6, coordinatorRevision: 0, updatedAt: 30,
        status: 'running', currentActionId: 'action-1',
        actions: [{
          id: 'action-1', generation: 2, status: 'running', progressRevision: 4,
          messages: [{ id: 'event:input', role: 'user', status: 'sent', text: 'input' }],
          liveMessage: {
            id: 'run:terminal', runId: 'terminal', role: 'assistant', status: 'running',
            text: 'partial response', generation: 2, attempt: 1, createdAt: 40,
          },
        }],
      },
    };
    store.workCenterActionMessages[currentKey] = {
      generation: 2,
      messages: [{ id: 'event:cached', role: 'user', text: 'cached input', createdAt: 10 }],
      nextCursor: '1',
      total: 2,
    };
    let resolveStalePage;
    const stalePage = store.loadWorkItemActionMessages(
      'wi-1', 'action-1', 2, '1', 'agent-a',
    );
    const stalePageRequest = pendingRequests.find(request => (
      request.operation === 'get_action_messages' && !request.resolved
    ));
    resolveStalePage = stalePageRequest.resolve;
    const terminalSummary = {
      id: 'wi-1', revision: 7, coordinatorRevision: 0, updatedAt: 40,
      status: 'done', currentActionId: null, currentAction: null,
      actionStats: [{
        id: 'action-1', generation: 2, status: 'completed', progressRevision: 5,
        response: 'FINAL REPLY',
        liveMessage: {
          id: 'run:terminal', runId: 'terminal', role: 'assistant', status: 'completed',
          text: 'FINAL REPLY', generation: 2, attempt: 1, createdAt: 50, updatedAt: 50,
        },
      }],
    };
    expect(workItemDetailRefreshIdentity(
      store.workCenterDetailByAgent['agent-a'], terminalSummary,
    )).toEqual({ actionId: 'action-1', generation: 2 });
    store.applyWorkCenterEvent('agent-a', { type: 'run.finished', workItem: terminalSummary });
    expect(store.workCenterActionMessages[currentKey]).toBeUndefined();
    expect(store._workCenterActionMessageGenerationByKey[currentKey]).toBe(2);
    expect(store._workCenterDetailEventRefreshByAgent['agent-a']).toMatchObject({
      key: 'wi-1:action-1:2',
    });
    expect(store.workCenterDetailByAgent['agent-a'].actions[0].liveMessage).toMatchObject({
      status: 'completed', text: 'FINAL REPLY',
    });
    expect(pendingRequests.filter(request => (
      request !== stalePageRequest
        && ['get', 'get_action_messages'].includes(request.operation)
        && !request.resolved
    )).map(request => request.operation).sort()).toEqual(['get', 'get_action_messages']);

    const terminalRefresh = pendingRequests.find(request => request.operation === 'get' && !request.resolved);
    const terminalMessages = pendingRequests.find(request => (
      request.operation === 'get_action_messages' && !request.resolved && request !== stalePageRequest
    ));
    terminalRefresh.resolve({
      ...terminalSummary,
      actions: [{
        id: 'action-1', generation: 2, status: 'completed', progressRevision: 5,
        messages: [{
          id: 'run:terminal', runId: 'terminal', role: 'assistant', status: 'completed',
          text: 'FINAL REPLY', generation: 2, attempt: 1, createdAt: 50,
        }],
      }],
    });
    terminalMessages.resolve({
      actionId: 'action-1', generation: 2,
      messages: [{
        id: 'run:terminal', runId: 'terminal', role: 'assistant', status: 'completed',
        text: 'FINAL REPLY', generation: 2, attempt: 1, createdAt: 50,
      }],
      nextCursor: null,
      total: 2,
    });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(store.workCenterDetailByAgent['agent-a']).toMatchObject({
      status: 'done', currentActionId: null,
      actions: [expect.objectContaining({
        id: 'action-1', status: 'completed', messages: [expect.objectContaining({ text: 'FINAL REPLY' })],
      })],
    });
    expect(store.workCenterActionMessages[currentKey]).toMatchObject({
      nextCursor: null,
      messages: [expect.objectContaining({ text: 'FINAL REPLY' })],
    });
    resolveStalePage({
      actionId: 'action-1', generation: 2,
      messages: [{ id: 'event:stale', role: 'user', text: 'stale older input' }],
      nextCursor: null,
      total: 2,
    });
    await stalePage;
    expect(JSON.stringify(store.workCenterActionMessages[currentKey])).not.toContain('stale older input');

    const overlapDir = mkdtempSync(join(tmpdir(), 'yeaft-work-center-overlap-event-'));
    let overlapNow = 2_000;
    const overlapStore = new WorkItemStore(join(overlapDir, 'work-center.db'), { now: () => overlapNow });
    const overlapController = new WorkflowController(overlapStore);
    const overlapService = new WorkCenterService({
      yeaftDir: overlapDir,
      store: overlapStore,
      controller: overlapController,
      runner: null,
      ownerBootId: 'overlap-event',
      settingsReader: () => ({}),
    });
    const originalOverlapRequest = store.workCenterRequest;
    try {
      const overlapItem = overlapController.create({
        id: 'overlap-event',
        title: 'Keep overlapping terminal refreshes ordered',
        goal: 'Show the newest attempt without accepting stale refreshes',
        acceptanceCriteria: [],
        workflowTemplate: 'software-change',
        workDir: '/tmp',
        start: true,
      });
      const firstClaim = overlapStore.claimReadyAction('overlap-event', 5_000);
      expect(firstClaim.action.type).toBe('triage');
      overlapNow += 10;
      const firstRunning = overlapStore.updateRunProgress(
        firstClaim.run.id,
        'overlap-event',
        firstClaim.run.leaseEpoch,
        { response: 'ATTEMPT ONE PARTIAL', loopCount: 1 },
      );
      const overlapAgent = 'agent-overlap';
      store.workCenterDetailByAgent[overlapAgent] = overlapService.projectBrowserDetail(firstRunning);
      store.workCenterItemsByAgent[overlapAgent] = [];
      store.workCenterAgentId = overlapAgent;
      const overlapKey = workCenterActionMessageKey(
        overlapAgent,
        overlapItem.id,
        firstClaim.action.id,
        firstClaim.action.generation,
      );
      store.workCenterActionMessages[overlapKey] = {
        generation: firstClaim.action.generation,
        messages: [{ id: 'run:partial-one', role: 'assistant', text: 'ATTEMPT ONE PARTIAL' }],
        nextCursor: '1',
        total: 1,
      };

      overlapNow += 10;
      const firstTerminal = overlapController.submit(
        firstClaim.run.id,
        'overlap-event',
        firstClaim.run.leaseEpoch,
        {
          outcome: 'retryable',
          response: 'ATTEMPT ONE TERMINAL',
          summary: 'attempt one will retry',
          evidence: [],
          error: 'retry attempt one',
        },
      );
      const overlapRequests = [];
      store.workCenterRequest = vi.fn((operation, payload) => {
        const value = operation === 'get'
          ? overlapService.projectBrowserDetail(overlapStore.getWorkItemDetail(payload.id))
          : operation === 'get_action_messages'
            ? projectActionMessagePage(
                overlapStore.getAction(payload.actionId),
                overlapStore.getWorkItemDetail(payload.id).runs,
                overlapStore.listActionEvents(payload.actionId),
                payload,
              )
            : null;
        if (!value) throw new Error(`Unexpected overlap event operation: ${operation}`);
        let resolveRequest;
        let rejectRequest;
        const request = new Promise((resolve, reject) => {
          resolveRequest = resolve;
          rejectRequest = reject;
        });
        overlapRequests.push({
          operation,
          payload,
          getValue: () => operation === 'get'
            ? overlapService.projectBrowserDetail(overlapStore.getWorkItemDetail(payload.id))
            : projectActionMessagePage(
                overlapStore.getAction(payload.actionId),
                overlapStore.getWorkItemDetail(payload.id).runs,
                overlapStore.listActionEvents(payload.actionId),
                payload,
              ),
          value,
          resolve: resolveRequest,
          reject: rejectRequest,
        });
        return request;
      });

      const firstTerminalRefresh = store.refreshWorkItemDetailAfterActionChange;
      let firstTerminalRefreshPromise = null;
      store.refreshWorkItemDetailAfterActionChange = function (...args) {
        firstTerminalRefreshPromise = firstTerminalRefresh.apply(this, args);
        return firstTerminalRefreshPromise;
      };
      store.applyWorkCenterEvent(overlapAgent, projectWorkCenterEvent({
        type: 'run.finished',
        actionId: firstClaim.action.id,
        runId: firstClaim.run.id,
        workItem: firstTerminal,
      }));
      store.refreshWorkItemDetailAfterActionChange = firstTerminalRefresh;
      expect(store._workCenterActionMessageGenerationByKey[overlapKey]).toBe(1);
      const firstRefreshGeneration = store._workCenterDetailEventRefreshByAgent[overlapAgent]?.generation;
      expect(firstRefreshGeneration).toBeGreaterThan(0);
      expect(overlapRequests.map(request => request.operation).sort())
        .toEqual(['get', 'get_action_messages']);
      const staleOverlapPage = store.loadWorkItemActionMessages(
        overlapItem.id,
        firstClaim.action.id,
        firstClaim.action.generation,
        '1',
        overlapAgent,
      ).catch(() => null);

      overlapNow += 10;
      const secondClaim = overlapStore.claimReadyAction('overlap-event', 5_000);
      expect(secondClaim.action.id).toBe(firstClaim.action.id);
      expect(secondClaim.run.actionAttempt).toBe(2);
      store.applyWorkCenterEvent(overlapAgent, projectWorkCenterEvent({
        type: 'run.started',
        actionId: secondClaim.action.id,
        runId: secondClaim.run.id,
        workItem: overlapStore.getWorkItemDetail(overlapItem.id),
      }));
      overlapNow += 10;
      const secondRunning = overlapStore.updateRunProgress(
        secondClaim.run.id,
        'overlap-event',
        secondClaim.run.leaseEpoch,
        { response: 'ATTEMPT TWO PARTIAL', loopCount: 1 },
      );
      store.applyWorkCenterEvent(overlapAgent, projectWorkCenterEvent({
        type: 'run.progress',
        actionId: secondClaim.action.id,
        runId: secondClaim.run.id,
        workItem: secondRunning,
      }));
      expect(store.workCenterDetailByAgent[overlapAgent].actions
        .find(action => action.id === firstClaim.action.id)?.liveMessage).toMatchObject({
        attempt: 2,
        status: 'running',
        text: 'ATTEMPT TWO PARTIAL',
      });

      overlapNow += 10;
      const secondTerminal = overlapController.submit(
        secondClaim.run.id,
        'overlap-event',
        secondClaim.run.leaseEpoch,
        {
          outcome: 'completed',
          response: 'ATTEMPT TWO FINAL',
          summary: 'attempt two completed',
          evidence: ['attempt-two-evidence'],
          acceptanceChecks: [],
        },
      );
      const secondTerminalEvent = projectWorkCenterEvent({
        type: 'run.finished',
        actionId: secondClaim.action.id,
        runId: secondClaim.run.id,
        workItem: secondTerminal,
      });
      expect(secondTerminalEvent).toMatchObject({
        actionId: secondClaim.action.id,
        runId: secondClaim.run.id,
      });
      const secondTerminalRefresh = store.refreshWorkItemDetailAfterActionChange;
      let secondTerminalRefreshPromise = null;
      store.refreshWorkItemDetailAfterActionChange = function (...args) {
        secondTerminalRefreshPromise = secondTerminalRefresh.apply(this, args);
        return secondTerminalRefreshPromise;
      };
      store.applyWorkCenterEvent(overlapAgent, secondTerminalEvent);
      store.refreshWorkItemDetailAfterActionChange = secondTerminalRefresh;

      const immediateOverlapAction = store.workCenterDetailByAgent[overlapAgent].actions
        .find(action => action.id === firstClaim.action.id);
      expect(immediateOverlapAction.liveMessage).toMatchObject({
        attempt: 2,
        status: 'completed',
        text: 'ATTEMPT TWO FINAL',
      });
      expect(store._workCenterActionMessageGenerationByKey[overlapKey]).toBe(2);
      expect(store._workCenterDetailEventRefreshByAgent[overlapAgent]).toMatchObject({
        key: `${overlapItem.id}:${firstClaim.action.id}:${firstClaim.action.generation}:2`,
        generation: firstRefreshGeneration + 1,
      });
      const overlapMessageRequests = overlapRequests
        .filter(request => request.operation === 'get_action_messages');
      const overlapDetailRequests = overlapRequests.filter(request => request.operation === 'get');
      expect(overlapMessageRequests).toHaveLength(3);
      expect(overlapDetailRequests).toHaveLength(2);

      overlapMessageRequests.at(-1).resolve(overlapMessageRequests.at(-1).getValue());
      overlapDetailRequests.at(-1).resolve(overlapDetailRequests.at(-1).getValue());
      await secondTerminalRefreshPromise;
      await vi.waitFor(() => {
        expect(store.workCenterActionMessages[overlapKey]?.messages).toEqual(expect.arrayContaining([
          expect.objectContaining({ text: 'ATTEMPT ONE TERMINAL' }),
          expect.objectContaining({ text: 'ATTEMPT TWO FINAL' }),
        ]));
      });

      const canonicalOverlapMessages = store.workCenterActionMessages[overlapKey]?.messages || [];
      expect(canonicalOverlapMessages.map(message => message.text)).toEqual([
        'ATTEMPT ONE TERMINAL',
        'ATTEMPT TWO FINAL',
      ]);
      expect(JSON.stringify(canonicalOverlapMessages)).not.toContain('ATTEMPT TWO PARTIAL');
      expect(store.workCenterDetailByAgent[overlapAgent].currentActionId)
        .toBe(secondTerminal.currentActionId);

      overlapDetailRequests[0].resolve(overlapDetailRequests[0].value);
      overlapMessageRequests[0].resolve(overlapMessageRequests[0].value);
      overlapMessageRequests[1].reject(new Error('late attempt one message failure'));
      await firstTerminalRefreshPromise;
      await staleOverlapPage;
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      const settledOverlapMessages = store.workCenterActionMessages[overlapKey]?.messages || [];
      expect(settledOverlapMessages.map(message => message.text)).toEqual([
        'ATTEMPT ONE TERMINAL',
        'ATTEMPT TWO FINAL',
      ]);
      expect(store.workCenterActionMessagesError[overlapKey]).toBeNull();
      expect(store.workCenterActionMessagesLoading[overlapKey]).toBe(false);
      expect(store.workCenterDetailByAgent[overlapAgent]).toMatchObject({
        status: secondTerminal.status,
        currentActionId: secondTerminal.currentActionId,
        actions: expect.arrayContaining([
          expect.objectContaining({ id: firstClaim.action.id, status: 'completed' }),
        ]),
      });
    } finally {
      store.workCenterRequest = originalOverlapRequest;
      overlapStore.close();
      rmSync(overlapDir, { recursive: true, force: true });
    }

    const finalDir = mkdtempSync(join(tmpdir(), 'yeaft-work-center-final-event-'));
    let finalNow = 1_000;
    const finalStore = new WorkItemStore(join(finalDir, 'work-center.db'), { now: () => finalNow });
    const finalController = new WorkflowController(finalStore);
    const finalService = new WorkCenterService({
      yeaftDir: finalDir,
      store: finalStore,
      controller: finalController,
      runner: null,
      ownerBootId: 'final-event',
      settingsReader: () => ({}),
    });
    try {
      const finalItem = finalController.create({
        id: 'final-event',
        title: 'Deliver the final reply',
        goal: 'Keep the terminal Action conversation complete',
        acceptanceCriteria: [],
        workflowTemplate: 'software-change',
        workDir: '/tmp',
        start: true,
      });
      let finalClaim = null;
      for (const type of ['triage', 'implement', 'review']) {
        const claim = finalStore.claimReadyAction('final-event', 5_000);
        expect(claim.action.type).toBe(type);
        finalNow += 10;
        finalController.submit(claim.run.id, 'final-event', claim.run.leaseEpoch, {
          outcome: 'completed',
          response: `${type} reply`,
          summary: `${type} complete`,
          evidence: [`${type}-evidence`],
          acceptanceChecks: [],
          ...(type === 'review' ? { reviewDecision: 'approved' } : {}),
        });
        finalNow += 10;
      }
      finalClaim = finalStore.claimReadyAction('final-event', 5_000);
      expect(finalClaim.action.type).toBe('deliver');
      const runningDetail = finalStore.updateRunProgress(
        finalClaim.run.id,
        'final-event',
        finalClaim.run.leaseEpoch,
        { response: 'PARTIAL DELIVERY', loopCount: 1 },
      );
      const runningBrowserDetail = finalService.projectBrowserDetail(runningDetail);
      const finalAgent = 'agent-final';
      store.workCenterDetailByAgent[finalAgent] = runningBrowserDetail;
      store.workCenterItemsByAgent[finalAgent] = [];
      store.workCenterAgentId = finalAgent;
      const runningAction = runningBrowserDetail.actions.find(action => action.id === finalClaim.action.id);
      const finalKey = workCenterActionMessageKey(
        finalAgent,
        finalItem.id,
        finalClaim.action.id,
        finalClaim.action.generation,
      );
      store.workCenterActionMessages[finalKey] = {
        generation: finalClaim.action.generation,
        messages: [],
        nextCursor: '1',
        total: 1,
      };
      expect(runningAction.liveMessage).toMatchObject({
        status: 'running', text: 'PARTIAL DELIVERY',
      });
      finalNow += 10;
      const finishedDetail = finalController.submit(
        finalClaim.run.id,
        'final-event',
        finalClaim.run.leaseEpoch,
        {
          outcome: 'completed',
          response: 'FINAL DELIVERY REPLY',
          summary: 'deliver complete',
          evidence: ['deliver-evidence'],
          acceptanceChecks: [],
        },
      );
      const finishedEvent = projectWorkCenterEvent({
        type: 'run.finished',
        actionId: finalClaim.action.id,
        runId: finalClaim.run.id,
        workItem: finishedDetail,
      });
      expect(finishedEvent.workItem).toMatchObject({
        status: 'done', currentActionId: null,
        actionStats: [
          expect.any(Object), expect.any(Object), expect.any(Object),
          expect.objectContaining({
            id: finalClaim.action.id,
            generation: finalClaim.action.generation,
            status: 'completed',
            liveMessage: expect.objectContaining({
              status: 'completed', text: 'FINAL DELIVERY REPLY',
            }),
          }),
        ],
      });
      const finalRequests = [];
      const originalWorkCenterRequest = store.workCenterRequest;
      store.workCenterRequest = vi.fn((operation, payload) => {
        finalRequests.push({ operation, payload });
        if (operation === 'get') {
          return Promise.resolve(finalService.projectBrowserDetail(finalStore.getWorkItemDetail(finalItem.id)));
        }
        if (operation === 'get_action_messages') {
          const action = finalStore.getAction(payload.actionId);
          return Promise.resolve(projectActionMessagePage(
            action,
            finalStore.getWorkItemDetail(finalItem.id).runs,
            finalStore.listActionEvents(payload.actionId),
            payload,
          ));
        }
        throw new Error(`Unexpected final event operation: ${operation}`);
      });
      store.applyWorkCenterEvent(finalAgent, finishedEvent);
      const immediateAction = store.workCenterDetailByAgent[finalAgent].actions
        .find(action => action.id === finalClaim.action.id);
      expect(immediateAction.liveMessage).toMatchObject({
        status: 'completed', text: 'FINAL DELIVERY REPLY',
      });
      expect(immediateAction.liveMessage.text).not.toBe('PARTIAL DELIVERY');
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      const settledDetail = store.workCenterDetailByAgent[finalAgent];
      const settledAction = settledDetail.actions.find(action => action.id === finalClaim.action.id);
      expect(settledDetail).toMatchObject({ status: 'done', currentActionId: null });
      expect(settledAction.messages.filter(message => message.text === 'FINAL DELIVERY REPLY')).toHaveLength(1);
      expect(JSON.stringify(settledAction.messages)).not.toContain('PARTIAL DELIVERY');
      expect(store.workCenterActionMessages[finalKey]).toMatchObject({
        nextCursor: null,
        messages: [expect.objectContaining({ text: 'FINAL DELIVERY REPLY' })],
      });
      expect(finalRequests.map(request => request.operation).sort()).toEqual([
        'get', 'get_action_messages',
      ]);
      store.workCenterRequest = originalWorkCenterRequest;
    } finally {
      finalStore.close();
      rmSync(finalDir, { recursive: true, force: true });
    }

    const nextActionSummary = {
      ...terminalSummary,
      revision: 8,
      updatedAt: 55,
      status: 'ready',
      currentActionId: 'action-2',
      currentAction: { id: 'action-2', generation: 1, status: 'ready' },
      actionStats: [
        terminalSummary.actionStats[0],
        { id: 'action-2', generation: 1, status: 'ready', progressRevision: 1 },
      ],
    };
    const nextActionCurrent = {
      ...store.workCenterDetailByAgent['agent-a'],
      revision: 7,
      updatedAt: 50,
      status: 'running',
      currentActionId: 'action-1',
      actions: [
        ...store.workCenterDetailByAgent['agent-a'].actions,
        { id: 'action-2', generation: 1, status: 'ready', progressRevision: 1 },
      ],
    };
    expect(workItemDetailRefreshIdentity(nextActionCurrent, nextActionSummary))
      .toEqual({ actionId: 'action-1', generation: 2 });

    const coordinatorSummary = {
      ...eventSummary,
      revision: 8,
      updatedAt: 60,
      coordinatorRevision: 3,
      currentActionId: null,
      currentAction: null,
      actionStats: [],
    };
    store.applyWorkCenterEvent('agent-a', {
      type: 'coordinator.turn_completed', workItem: coordinatorSummary,
    });
    expect(store._workCenterDetailEventRefreshByAgent['agent-a']).toMatchObject({
      key: 'wi-1:coordinator:3',
    });
    const coordinatorRefresh = pendingRequests.find(request => request.operation === 'get' && !request.resolved);
    coordinatorRefresh.resolve({
      ...coordinatorSummary,
      messages: [{ id: 'turn-1', role: 'assistant', status: 'completed', text: 'Plan updated' }],
      actions: [],
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(store.workCenterDetailByAgent['agent-a']).toMatchObject({
      coordinatorRevision: 3,
      messages: [expect.objectContaining({ text: 'Plan updated' })],
    });
    const sent = store.sendWorkItemMessage('wi-1', 'Change the target', 8, 'agent-a');
    const coordinatorRequest = pendingRequests.find(request => request.operation === 'work_item_message');
    expect(store.workCenterRequest).toHaveBeenLastCalledWith('work_item_message', {
      id: 'wi-1', text: 'Change the target', revision: 8,
      planRevision: 0, ledgerRevision: 0, coordinatorRevision: 3,
    }, 'agent-a');
    coordinatorRequest.resolve({ accepted: true, turnId: 'turn-2' });
    await expect(sent).resolves.toEqual({ accepted: true, turnId: 'turn-2' });
  });
});
