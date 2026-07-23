import { describe, expect, it, vi } from 'vitest';

globalThis.localStorage = {
  getItem: vi.fn(() => null),
  setItem: vi.fn(),
  removeItem: vi.fn(),
};
globalThis.Pinia = globalThis.Pinia || {};
globalThis.Pinia.defineStore = (_id, options) => () => ({
  ...(options.state ? options.state() : {}),
  ...(options.actions || {}),
});
globalThis.window = globalThis.window || globalThis;
globalThis.window.Pinia = globalThis.Pinia;
globalThis.Vue = globalThis.Vue || {
  ref: vi.fn(),
  computed: vi.fn(),
  watch: vi.fn(),
  onMounted: vi.fn(),
  onBeforeUnmount: vi.fn(),
  nextTick: vi.fn(),
};

const { useChatStore } = await import('../../../web/stores/chat.js');
const { default: ChatPage } = await import('../../../web/components/ChatPage.js');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeStore(view) {
  const store = useChatStore();
  store.currentView = view;
  store.currentAgent = 'agent-1';
  store.currentAgentInfo = { id: 'agent-1', online: true, capabilities: ['work_center'] };
  store.agents = [store.currentAgentInfo];
  store.listWorkItems = vi.fn().mockResolvedValue([]);
  return store;
}

describe('Work Center navigation', () => {
  it('leaves Work Center when a split-panel Session is selected', () => {
    const store = {
      isSplitMode: true,
      activePanelId: 'panel-1',
      leaveWorkCenter: vi.fn(),
      setPanelConversation: vi.fn(),
      closeSessionSidebar: vi.fn(),
    };

    ChatPage.methods.onSessionClick.call({ store }, {
      id: 'conversation-2',
      agentId: 'agent-1',
      agentOnline: true,
    });

    expect(store.leaveWorkCenter).toHaveBeenCalledOnce();
    expect(store.setPanelConversation).toHaveBeenCalledWith('panel-1', 'conversation-2');
    expect(store.closeSessionSidebar).toHaveBeenCalledOnce();
  });

  it('opens and closes inside the Chat provider without replacing it', () => {
    const store = makeStore('chat');

    store.enterWorkCenter('agent-1');
    expect(store.currentView).toBe('chat');
    expect(store.workCenterOpen).toBe(true);

    store.leaveWorkCenter();
    expect(store.currentView).toBe('chat');
    expect(store.workCenterOpen).toBe(false);
  });

  it('opens and closes inside Yeaft without tearing down the Session view', () => {
    const store = makeStore('yeaft');
    store.yeaftActiveSessionFilter = 'session-1';

    store.enterWorkCenter('agent-1');
    expect(store.currentView).toBe('yeaft');
    expect(store.yeaftActiveSessionFilter).toBe('session-1');
    expect(store.workCenterOpen).toBe(true);

    store.leaveWorkCenter();
    expect(store.currentView).toBe('yeaft');
    expect(store.yeaftActiveSessionFilter).toBe('session-1');
  });

  it('switches Work Center Agents without changing the provider', () => {
    const store = makeStore('yeaft');
    store.enterWorkCenter('agent-1');
    store.agents.push({ id: 'agent-2', online: true, capabilities: ['work_center'] });
    store.selectAgent = vi.fn();

    store.enterWorkCenter('agent-2');

    expect(store.currentView).toBe('yeaft');
    expect(store.workCenterOpen).toBe(true);
    expect(store.workCenterAgentId).toBe('agent-2');
  });

  it('opens a Session-linked draft without changing the active provider', () => {
    const store = makeStore('yeaft');
    store.yeaftActiveSessionFilter = 'session-1';

    store.enterWorkCenterFromSession({ id: 'session-1', title: 'Investigate', agentId: 'agent-1' }, 'Fix it');

    expect(store.currentView).toBe('yeaft');
    expect(store.yeaftActiveSessionFilter).toBe('session-1');
    expect(store.workCenterOpen).toBe(true);
    expect(store.workCenterCreateDraft.sourceAgentId).toBe('agent-1');
    expect(store.workCenterCreateDraft.linkedSessionIds).toEqual(['session-1']);
  });

  it('keeps only the latest Board query response for the selected Agent', async () => {
    const store = makeStore('yeaft');
    store.workCenterAgentId = 'agent-1';
    store.listWorkItems = useChatStore().listWorkItems;
    const pending = [];
    store.workCenterRequest = vi.fn((_op, payload, agentId) => {
      const request = deferred();
      pending.push({ payload, agentId, request });
      return request.promise;
    });

    const first = store.listWorkItems('agent-1', { keyword: 'old' });
    const second = store.listWorkItems('agent-1', { keyword: 'new' });
    pending[1].request.resolve({ items: [{ id: 'new', boardLane: 'active' }], nextCursor: 'next' });
    await second;
    pending[0].request.resolve({ items: [{ id: 'old', boardLane: 'closed' }] });
    await first;

    expect(store.workCenterItemsByAgent['agent-1']).toEqual([{ id: 'new', boardLane: 'active' }]);
    expect(store.workCenterListPageByAgent['agent-1']).toMatchObject({ nextCursor: 'next' });
    expect(store.workCenterLoadingByAgent['agent-1']).toBe(false);
  });

  it('appends a stable Board page without duplicating Work Items', async () => {
    const store = makeStore('yeaft');
    store.workCenterAgentId = 'agent-1';
    store.workCenterItemsByAgent['agent-1'] = [{ id: 'wi-1' }, { id: 'wi-2', title: 'old' }];
    store.workCenterListPageByAgent['agent-1'] = { nextCursor: 'cursor-1', queryKey: 'query-1' };
    store._workCenterListQueryByAgent['agent-1'] = 'query-1';
    store._workCenterListGenerationByAgent['agent-1'] = 4;
    store._workCenterListFiltersByAgent['agent-1'] = { keyword: '' };
    store.workCenterRequest = vi.fn().mockResolvedValue({
      items: [{ id: 'wi-2', title: 'fresh' }, { id: 'wi-3' }], nextCursor: null,
    });

    await store.loadMoreWorkItems('agent-1');
    expect(store.workCenterItemsByAgent['agent-1']).toEqual([
      { id: 'wi-1' }, { id: 'wi-2', title: 'fresh' }, { id: 'wi-3' },
    ]);
    expect(store.workCenterListPageByAgent['agent-1'].nextCursor).toBeNull();
  });

  it('deduplicates a pending Board page and fences a stale cursor response', async () => {
    const store = makeStore('yeaft');
    store.workCenterAgentId = 'agent-1';
    store.workCenterItemsByAgent['agent-1'] = [{ id: 'wi-1', revision: 1 }];
    store.workCenterListPageByAgent['agent-1'] = { nextCursor: 'cursor-1', queryKey: 'query-1' };
    store._workCenterListQueryByAgent['agent-1'] = 'query-1';
    store._workCenterListGenerationByAgent['agent-1'] = 4;
    store._workCenterListFiltersByAgent['agent-1'] = { keyword: '' };
    const page = deferred();
    store.workCenterRequest = vi.fn(() => page.promise);

    const first = store.loadMoreWorkItems('agent-1');
    const duplicate = store.loadMoreWorkItems('agent-1');
    expect(store.workCenterRequest).toHaveBeenCalledTimes(1);
    expect(store.workCenterListMoreLoadingByAgent['agent-1']).toBe(true);
    store.workCenterListPageByAgent['agent-1'] = { nextCursor: 'cursor-2', queryKey: 'query-1' };
    page.resolve({ items: [{ id: 'stale-page', revision: 1 }], nextCursor: null });
    await Promise.all([first, duplicate]);

    expect(store.workCenterItemsByAgent['agent-1']).toEqual([{ id: 'wi-1', revision: 1 }]);
    expect(store.workCenterListPageByAgent['agent-1'].nextCursor).toBe('cursor-2');
    expect(store.workCenterListMoreLoadingByAgent['agent-1']).toBe(false);
  });

  it('keeps a live Board event when the initial list or a page returns stale data', async () => {
    const store = makeStore('yeaft');
    store.workCenterAgentId = 'agent-1';
    store.listWorkItems = useChatStore().listWorkItems;
    const list = deferred();
    store.workCenterRequest = vi.fn(() => list.promise);

    const pending = store.listWorkItems('agent-1', {});
    store.applyWorkCenterEvent('agent-1', {
      workItem: { id: 'wi-1', revision: 2, updatedAt: 20, status: 'running', boardLane: 'active' },
    });
    list.resolve({ items: [{ id: 'wi-1', revision: 1, updatedAt: 10, status: 'ready', boardLane: 'active' }] });
    await pending;
    expect(store.workCenterItemsByAgent['agent-1'][0]).toMatchObject({ revision: 2, status: 'running' });

    store.workCenterListPageByAgent['agent-1'] = { nextCursor: 'cursor-1', queryKey: store._workCenterListQueryByAgent['agent-1'] };
    store.workCenterRequest = vi.fn().mockResolvedValue({
      items: [{ id: 'wi-1', revision: 1, updatedAt: 10, status: 'ready', boardLane: 'active' }],
      nextCursor: null,
    });
    await store.loadMoreWorkItems('agent-1');
    expect(store.workCenterItemsByAgent['agent-1'][0]).toMatchObject({ revision: 2, status: 'running' });
  });

  it('does not let a stale Board page insert an unloaded card removed by a live event', async () => {
    const store = makeStore('yeaft');
    store.workCenterAgentId = 'agent-1';
    const filters = { keyword: 'release' };
    const queryKey = JSON.stringify(filters);
    store.workCenterListPageByAgent['agent-1'] = { nextCursor: 'cursor-1', queryKey };
    store._workCenterListQueryByAgent['agent-1'] = queryKey;
    store._workCenterListGenerationByAgent['agent-1'] = 4;
    store._workCenterListFiltersByAgent['agent-1'] = filters;
    const page = deferred();
    store.workCenterRequest = vi.fn(() => page.promise);

    const pending = store.loadMoreWorkItems('agent-1');
    store.applyWorkCenterEvent('agent-1', {
      workItem: { id: 'wi-page', title: 'Renamed', goal: 'No longer matches', revision: 2 },
    });
    page.resolve({
      items: [{ id: 'wi-page', title: 'Release build', revision: 1 }],
      nextCursor: null,
    });
    await pending;

    expect(store.workCenterItemsByAgent['agent-1'] || []).toEqual([]);
  });

  it('keeps filtered Board events out and removes cards that leave the query', () => {
    const store = makeStore('yeaft');
    store.workCenterAgentId = 'agent-1';
    store._workCenterListFiltersByAgent['agent-1'] = { keyword: 'release', vpId: 'linus' };
    store.workCenterItemsByAgent['agent-1'] = [{
      id: 'wi-1', title: 'Release build', goal: 'Ship', executors: [{ id: 'linus' }], revision: 1,
    }];

    store.applyWorkCenterEvent('agent-1', {
      workItem: { id: 'wi-2', title: 'Unrelated', goal: 'Ignore', executors: [{ id: 'linus' }] },
    });
    expect(store.workCenterItemsByAgent['agent-1'].map(item => item.id)).toEqual(['wi-1']);
    store.applyWorkCenterEvent('agent-1', {
      workItem: { id: 'wi-1', title: 'Renamed', goal: 'Ignore', executors: [{ id: 'martin' }], revision: 2 },
    });
    expect(store.workCenterItemsByAgent['agent-1']).toEqual([]);
  });

  it('rejects a late Board response after switching Agents', async () => {
    const store = makeStore('yeaft');
    store.workCenterAgentId = 'agent-1';
    store.listWorkItems = useChatStore().listWorkItems;
    const request = deferred();
    store.workCenterRequest = vi.fn(() => request.promise);
    const pending = store.listWorkItems('agent-1', { keyword: 'agent one' });
    store.workCenterAgentId = 'agent-2';
    request.resolve({ items: [{ id: 'wrong-agent' }] });
    await pending;

    expect(store.workCenterItemsByAgent['agent-1']).toBeUndefined();
  });

  it('keeps only the latest explicit WorkItem detail request', async () => {
    const store = makeStore('yeaft');
    const pending = {};
    store.workCenterRequest = vi.fn((_op, payload) => new Promise(resolve => {
      pending[payload.id] = resolve;
    }));

    const first = store.getWorkItem('wi-1', 'agent-1');
    const second = store.getWorkItem('wi-2', 'agent-1');
    pending['wi-2']({ id: 'wi-2', actions: [] });
    await second;
    pending['wi-1']({ id: 'wi-1', actions: [] });
    await first;

    expect(store.workCenterDetailByAgent['agent-1']).toEqual({ id: 'wi-2', actions: [] });
  });

  it('keeps explicit detail requests numeric while event refresh is pending', async () => {
    const store = makeStore('yeaft');
    store.workCenterItemsByAgent = { 'agent-1': [] };
    store.workCenterDetailByAgent = {
      'agent-1': { id: 'wi-1', revision: 1, currentActionId: 'action-1', actions: [{ id: 'action-1' }] },
    };
    const pending = [];
    store.workCenterRequest = vi.fn((_op, payload) => new Promise(resolve => {
      pending.push({ id: payload.id, resolve });
    }));

    store.applyWorkCenterEvent('agent-1', {
      workItem: { id: 'wi-1', revision: 2, currentActionId: 'action-2' },
    });
    const explicit = store.getWorkItem('wi-2', 'agent-1');
    expect(store._workCenterDetailEventRefreshByAgent['agent-1']).toBe('wi-1:action-2');
    expect(store._workCenterDetailRequestGenerationByAgent['agent-1']).toBe(1);
    pending.find(item => item.id === 'wi-2').resolve({ id: 'wi-2', actions: [] });
    await explicit;
    pending.find(item => item.id === 'wi-1').resolve({ id: 'wi-1', currentActionId: 'action-2', actions: [] });
    await Promise.resolve();
    await Promise.resolve();

    expect(store.workCenterDetailByAgent['agent-1']).toMatchObject({ id: 'wi-2' });
  });

  it('keeps a newer event-refreshed Action when an older explicit detail response finishes last', async () => {
    const store = makeStore('yeaft');
    store.workCenterItemsByAgent = { 'agent-1': [] };
    store.workCenterDetailByAgent = {
      'agent-1': { id: 'wi-1', revision: 1, currentActionId: 'action-1', actions: [{ id: 'action-1' }] },
    };
    const pending = [];
    store.workCenterRequest = vi.fn((_op, payload) => new Promise(resolve => {
      pending.push({ id: payload.id, resolve });
    }));

    const explicit = store.getWorkItem('wi-1', 'agent-1');
    store.applyWorkCenterEvent('agent-1', {
      workItem: { id: 'wi-1', revision: 2, currentActionId: 'action-2', updatedAt: 2 },
    });
    pending[1].resolve({
      id: 'wi-1', revision: 2, currentActionId: 'action-2', updatedAt: 2,
      actions: [{ id: 'action-1' }, { id: 'action-2' }],
    });
    await Promise.resolve();
    await Promise.resolve();
    pending[0].resolve({
      id: 'wi-1', revision: 1, currentActionId: 'action-1', updatedAt: 1,
      actions: [{ id: 'action-1' }],
    });

    expect(await explicit).toMatchObject({ revision: 2, currentActionId: 'action-2' });
    expect(store.workCenterDetailByAgent['agent-1']).toMatchObject({
      revision: 2, currentActionId: 'action-2',
    });
  });

  it('merges concurrent Action message pages without dropping a valid cursor page', async () => {
    const store = makeStore('yeaft');
    const pending = [];
    store.workCenterRequest = vi.fn((_op, payload) => new Promise(resolve => {
      pending.push({ payload, resolve });
    }));

    const page40 = store.loadWorkItemActionMessages('wi-1', 'action-1', '40', 'agent-1');
    const page20 = store.loadWorkItemActionMessages('wi-1', 'action-1', '20', 'agent-1');
    pending[1].resolve({ messages: [{ id: 'm-1', createdAt: 1 }], nextCursor: null, total: 3 });
    await page20;
    pending[0].resolve({ messages: [{ id: 'm-2', createdAt: 2 }], nextCursor: '20', total: 3 });
    await page40;

    expect(store.workCenterActionMessages['agent-1:wi-1:action-1']).toEqual({
      messages: [{ id: 'm-1', createdAt: 1 }, { id: 'm-2', createdAt: 2 }],
      nextCursor: null,
      total: 3,
    });
    expect(store.workCenterActionMessagesLoading['agent-1:wi-1:action-1']).toBe(false);
  });

  it('deduplicates identical Action message page requests while one is pending', async () => {
    const store = makeStore('yeaft');
    let resolvePage;
    store.workCenterRequest = vi.fn(() => new Promise(resolve => { resolvePage = resolve; }));

    const first = store.loadWorkItemActionMessages('wi-1', 'action-1', '20', 'agent-1');
    const second = store.loadWorkItemActionMessages('wi-1', 'action-1', '20', 'agent-1');
    expect(store.workCenterRequest).toHaveBeenCalledTimes(1);
    resolvePage({ messages: [], nextCursor: null, total: 0 });
    await Promise.all([first, second]);
  });

  it('commits a successful input response for a non-pointer sibling Action', async () => {
    const store = makeStore('yeaft');
    store.workCenterDetailByAgent = {
      'agent-1': {
        id: 'wi-1', revision: 5, currentActionId: 'action-waiting',
        actions: [
          { id: 'action-waiting', status: 'waiting', generation: 1 },
          { id: 'action-running', status: 'running', generation: 3 },
        ],
      },
    };
    store.workCenterRequest = vi.fn().mockResolvedValue({
      id: 'wi-1', revision: 6, currentActionId: 'action-waiting',
      actions: [
        { id: 'action-waiting', status: 'waiting', generation: 1 },
        { id: 'action-running', status: 'running', generation: 3 },
      ],
    });

    const result = await store.sendWorkItemActionInput(
      'wi-1', 'Update only the running sibling', 'action-running', 5, 3, [], 'agent-1',
    );

    expect(result).toMatchObject({ revision: 6, currentActionId: 'action-waiting' });
    expect(store.workCenterDetailByAgent['agent-1']).toMatchObject({
      revision: 6, currentActionId: 'action-waiting',
    });
  });

  it('preserves the active Board filters after Action input', async () => {
    const store = makeStore('yeaft');
    const filters = { keyword: 'release', vpId: 'linus', workItemType: 'bug-fix', updatedFrom: 100 };
    store._workCenterListFiltersByAgent['agent-1'] = filters;
    store.workCenterDetailByAgent['agent-1'] = {
      id: 'wi-1', revision: 5, currentActionId: 'action-1',
      actions: [{ id: 'action-1', status: 'waiting', generation: 2 }],
    };
    store.workCenterRequest = vi.fn().mockResolvedValue({
      id: 'wi-1', revision: 6, currentActionId: 'action-1',
      actions: [{ id: 'action-1', status: 'running', generation: 2 }],
    });
    store.listWorkItems = vi.fn().mockResolvedValue([]);

    await store.sendWorkItemActionInput('wi-1', 'Continue', 'action-1', 5, 2, [], 'agent-1');

    expect(store.listWorkItems).toHaveBeenCalledWith('agent-1', filters);
  });

  it('does not let an old Action input response overwrite a newer Action in the same Work Item', async () => {
    const store = makeStore('yeaft');
    store.workCenterDetailByAgent = {
      'agent-1': {
        id: 'wi-1', revision: 1, currentActionId: 'action-1',
        actions: [{ id: 'action-1' }],
      },
    };
    let resolveInput;
    store.workCenterRequest = vi.fn((op) => {
      if (op === 'action_input') return new Promise(resolve => { resolveInput = resolve; });
      throw new Error(`Unexpected Work Center operation: ${op}`);
    });

    const input = store.sendWorkItemActionInput(
      'wi-1', 'Keep the public API unchanged', 'action-1', 1, 1, [], 'agent-1',
    );
    store.workCenterDetailByAgent = {
      'agent-1': {
        id: 'wi-1', revision: 2, currentActionId: 'action-2',
        actions: [{ id: 'action-1' }, { id: 'action-2' }],
      },
    };
    resolveInput({
      id: 'wi-1', revision: 2, currentActionId: 'action-1',
      actions: [{ id: 'action-1' }],
    });

    const result = await input;
    expect(result).toMatchObject({ revision: 2, currentActionId: 'action-2' });
    expect(store.workCenterDetailByAgent['agent-1']).toMatchObject({
      revision: 2, currentActionId: 'action-2',
    });
  });

  it('ignores stale Action index/detail responses and isolates request details by run', async () => {
    const store = makeStore('yeaft');
    const pending = [];
    store.workCenterRequest = vi.fn((op, payload) => new Promise((resolve, reject) => {
      pending.push({ op, payload, resolve, reject });
    }));

    const firstIndex = store.loadWorkItemActionRequests('wi-1', 'action-1', 'agent-1');
    const secondIndex = store.loadWorkItemActionRequests('wi-1', 'action-1', 'agent-1');
    pending[1].resolve({ requests: [{ id: 'request-new', runId: 'run-2' }] });
    await secondIndex;
    pending[0].resolve({ requests: [{ id: 'request-old', runId: 'run-1' }] });
    await firstIndex;
    expect(store.workCenterActionRequests['agent-1:wi-1:action-1'])
      .toEqual([{ id: 'request-new', runId: 'run-2' }]);

    const failed = store.loadWorkItemActionRequest('wi-1', 'action-1', 'run-1', 'shared', 'agent-1');
    pending[2].reject(new Error('detail failed'));
    await expect(failed).rejects.toThrow('detail failed');
    const failedKey = 'agent-1:wi-1:action-1:run-1:shared';
    expect(store.workCenterActionRequestDetailsLoading[failedKey]).toBe(false);
    expect(store.workCenterActionRequestDetailsError[failedKey]).toBe('detail failed');

    const otherRun = store.loadWorkItemActionRequest('wi-1', 'action-1', 'run-2', 'shared', 'agent-1');
    pending[3].resolve({ request: { id: 'shared', runId: 'run-2' } });
    await otherRun;
    expect(store.workCenterActionRequestDetails['agent-1:wi-1:action-1:run-2:shared'])
      .toMatchObject({ runId: 'run-2' });
  });

  it('does not let an older explicit detail response overwrite a newer same-item event', async () => {
    const store = makeStore('yeaft');
    store.workCenterItemsByAgent = { 'agent-1': [] };
    store.workCenterDetailByAgent = {
      'agent-1': {
        id: 'wi-1', revision: 1, updatedAt: 10, status: 'running', failureReason: '',
        currentActionId: 'action-1',
        actions: [{ id: 'action-1', status: 'running', progressRevision: 1 }],
      },
    };
    const pending = deferred();
    store.workCenterRequest = vi.fn(() => pending.promise);

    const load = store.getWorkItem('wi-1', 'agent-1');
    store.applyWorkCenterEvent('agent-1', {
      workItem: {
        id: 'wi-1', revision: 2, updatedAt: 20, status: 'needs_attention',
        currentActionId: 'action-1', failureReason: 'NEW failure',
        actionStats: [{ id: 'action-1', status: 'failed', failureReason: 'NEW failure', progressRevision: 2 }],
      },
    });
    pending.resolve({
      id: 'wi-1', revision: 1, updatedAt: 10, status: 'running', failureReason: '',
      currentActionId: 'action-1',
      actions: [{ id: 'action-1', status: 'running', progressRevision: 1 }],
    });
    await load;

    expect(store.workCenterDetailByAgent['agent-1']).toMatchObject({
      revision: 2, status: 'needs_attention', failureReason: 'NEW failure',
      actions: [{ id: 'action-1', status: 'failed', failureReason: 'NEW failure', progressRevision: 2 }],
    });
  });

  it('invalidates an older explicit detail response when a same-item mutation starts', async () => {
    const store = makeStore('yeaft');
    store.workCenterDetailByAgent = {
      'agent-1': {
        id: 'wi-1', revision: 1, updatedAt: 10, status: 'running',
        currentActionId: 'action-1', actions: [{ id: 'action-1', progressRevision: 1 }],
      },
    };
    const pendingGet = deferred();
    store.workCenterRequest = vi.fn((operation) => {
      if (operation === 'get') return pendingGet.promise;
      if (operation === 'update') {
        return Promise.resolve({
          id: 'wi-1', revision: 2, updatedAt: 20, status: 'ready',
          currentActionId: 'action-1', actions: [{ id: 'action-1', progressRevision: 2 }],
        });
      }
      throw new Error(`Unexpected operation: ${operation}`);
    });

    const load = store.getWorkItem('wi-1', 'agent-1');
    await store.updateWorkItem('wi-1', { title: 'Updated' }, 'agent-1');
    pendingGet.resolve({
      id: 'wi-1', revision: 1, updatedAt: 10, status: 'running',
      currentActionId: 'action-1', actions: [{ id: 'action-1', progressRevision: 1 }],
    });
    await load;

    expect(store.workCenterDetailByAgent['agent-1']).toMatchObject({
      revision: 2, updatedAt: 20, status: 'ready',
      actions: [{ id: 'action-1', progressRevision: 2 }],
    });
  });

  it('rejects an explicit detail response with stale same-version Action progress', async () => {
    const store = makeStore('yeaft');
    store.workCenterDetailByAgent = {
      'agent-1': {
        id: 'wi-1', revision: 2, updatedAt: 20, status: 'needs_attention', failureReason: 'NEW failure',
        currentActionId: 'action-1',
        actions: [{ id: 'action-1', status: 'failed', failureReason: 'NEW failure', progressRevision: 3 }],
      },
    };
    store.workCenterRequest = vi.fn().mockResolvedValue({
      id: 'wi-1', revision: 2, updatedAt: 20, status: 'running', failureReason: '',
      currentActionId: 'action-1',
      actions: [{ id: 'action-1', status: 'running', progressRevision: 2 }],
    });

    await store.getWorkItem('wi-1', 'agent-1');

    expect(store.workCenterDetailByAgent['agent-1']).toMatchObject({
      status: 'needs_attention', failureReason: 'NEW failure',
      actions: [{ id: 'action-1', status: 'failed', progressRevision: 3 }],
    });
  });

  it('ignores an older explicit detail response after a newer selection resolves', async () => {
    const store = makeStore('yeaft');
    const older = deferred();
    const latest = deferred();
    store.workCenterRequest = vi.fn()
      .mockReturnValueOnce(older.promise)
      .mockReturnValueOnce(latest.promise);

    const olderLoad = store.getWorkItem('wi-1', 'agent-1');
    const latestLoad = store.getWorkItem('wi-2', 'agent-1');
    latest.resolve({ id: 'wi-2', revision: 2, updatedAt: 20, actions: [] });
    await latestLoad;
    older.resolve({ id: 'wi-1', revision: 1, updatedAt: 10, actions: [] });
    await olderLoad;

    expect(store.workCenterDetailByAgent['agent-1']).toMatchObject({ id: 'wi-2', revision: 2 });

  });

  it('refetches detail once when an event advances to an Action missing locally', async () => {
    const store = makeStore('yeaft');
    store.workCenterItemsByAgent = { 'agent-1': [] };
    store.workCenterDetailByAgent = {
      'agent-1': {
        id: 'wi-1', revision: 1, currentActionId: 'action-1', actionCount: 1,
        actionSummary: 'triage', actions: [{ id: 'action-1', type: 'triage' }],
      },
    };
    let resolveDetail;
    store.workCenterRequest = vi.fn(() => new Promise(resolve => { resolveDetail = resolve; }));
    const summary = {
      id: 'wi-1', revision: 2, currentActionId: 'action-2', actionCount: 2,
      actionSummary: 'triage → implement', actions: [],
    };

    store.applyWorkCenterEvent('agent-1', { workItem: summary });
    store.applyWorkCenterEvent('agent-1', { workItem: summary });
    expect(store.workCenterRequest).toHaveBeenCalledTimes(1);
    expect(store.workCenterRequest).toHaveBeenCalledWith('get', { id: 'wi-1' }, 'agent-1');

    resolveDetail({
      ...summary,
      actions: [{ id: 'action-1', type: 'triage' }, { id: 'action-2', type: 'implement' }],
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(store.workCenterDetailByAgent['agent-1']).toMatchObject({
      currentActionId: 'action-2', actionCount: 2, actionSummary: 'triage → implement',
    });
    expect(store.workCenterDetailByAgent['agent-1'].actions.map(action => action.id))
      .toEqual(['action-1', 'action-2']);
  });

  it('does not let a same-version Action refresh roll failed progress backwards', async () => {
    const store = makeStore('yeaft');
    store.workCenterItemsByAgent = { 'agent-1': [] };
    store.workCenterDetailByAgent = {
      'agent-1': {
        id: 'wi-1', revision: 2, updatedAt: 20, currentActionId: 'action-2',
        status: 'needs_attention', failureReason: 'NEW failure',
        actions: [{
          id: 'action-2', status: 'failed', failureReason: 'NEW failure', progressRevision: 3,
        }],
      },
    };
    const pending = deferred();
    store.workCenterRequest = vi.fn(() => pending.promise);

    const refresh = store.refreshWorkItemDetailAfterActionChange('agent-1', {
      id: 'wi-1', revision: 2, updatedAt: 20, currentActionId: 'action-2',
    });
    pending.resolve({
      id: 'wi-1', revision: 2, updatedAt: 20, currentActionId: 'action-2',
      status: 'running', failureReason: '',
      actions: [{ id: 'action-2', status: 'running', failureReason: '', progressRevision: 2 }],
    });
    await refresh;

    expect(store.workCenterDetailByAgent['agent-1']).toMatchObject({
      status: 'needs_attention', failureReason: 'NEW failure',
      actions: [{
        id: 'action-2', status: 'failed', failureReason: 'NEW failure', progressRevision: 3,
      }],
    });
  });

  it('does not let a pending Action refresh overwrite a newer explicit detail write', async () => {
    const store = makeStore('yeaft');
    store.workCenterItemsByAgent = { 'agent-1': [] };
    store.workCenterDetailByAgent = {
      'agent-1': {
        id: 'wi-1', revision: 1, updatedAt: 10, currentActionId: 'action-2',
        status: 'running', actions: [{ id: 'action-2', progressRevision: 1 }],
      },
    };
    const pendingRefresh = deferred();
    store.workCenterRequest = vi.fn()
      .mockReturnValueOnce(pendingRefresh.promise)
      .mockResolvedValueOnce({
        id: 'wi-1', revision: 3, updatedAt: 30, currentActionId: 'action-2',
        status: 'needs_attention', failureReason: 'LATEST failure',
        actions: [{ id: 'action-2', status: 'failed', failureReason: 'LATEST failure', progressRevision: 4 }],
      });

    const refresh = store.refreshWorkItemDetailAfterActionChange('agent-1', {
      id: 'wi-1', revision: 2, updatedAt: 20, currentActionId: 'action-2',
    });
    await store.getWorkItem('wi-1', 'agent-1');
    pendingRefresh.resolve({
      id: 'wi-1', revision: 2, updatedAt: 20, currentActionId: 'action-2',
      status: 'running', failureReason: '',
      actions: [{ id: 'action-2', status: 'running', progressRevision: 2 }],
    });
    await refresh;

    expect(store.workCenterDetailByAgent['agent-1']).toMatchObject({
      revision: 3, status: 'needs_attention', failureReason: 'LATEST failure',
      actions: [{ id: 'action-2', status: 'failed', progressRevision: 4 }],
    });
  });

  it('does not let a pending Action refresh overwrite a newer mutation response', async () => {
    const store = makeStore('yeaft');
    store.workCenterItemsByAgent = { 'agent-1': [] };
    store.workCenterDetailByAgent = {
      'agent-1': {
        id: 'wi-1', revision: 1, updatedAt: 10, currentActionId: 'action-2',
        status: 'running', actions: [{ id: 'action-2', progressRevision: 1 }],
      },
    };
    const pendingRefresh = deferred();
    store.workCenterRequest = vi.fn((operation) => {
      if (operation === 'get') return pendingRefresh.promise;
      if (operation === 'update') {
        return Promise.resolve({
          id: 'wi-1', revision: 3, updatedAt: 30, currentActionId: 'action-2',
          status: 'ready', actions: [{ id: 'action-2', progressRevision: 4 }],
        });
      }
      throw new Error(`Unexpected operation: ${operation}`);
    });

    const refresh = store.refreshWorkItemDetailAfterActionChange('agent-1', {
      id: 'wi-1', revision: 2, updatedAt: 20, currentActionId: 'action-2',
    });
    await store.updateWorkItem('wi-1', { title: 'Updated' }, 'agent-1');
    pendingRefresh.resolve({
      id: 'wi-1', revision: 2, updatedAt: 20, currentActionId: 'action-2',
      status: 'running', actions: [{ id: 'action-2', progressRevision: 2 }],
    });
    await refresh;

    expect(store.workCenterDetailByAgent['agent-1']).toMatchObject({
      revision: 3, status: 'ready', actions: [{ id: 'action-2', progressRevision: 4 }],
    });
  });

  it('does not let a stale same-item Action refresh overwrite newer detail', async () => {
    const store = makeStore('yeaft');
    store.workCenterItemsByAgent = { 'agent-1': [] };
    store.workCenterDetailByAgent = {
      'agent-1': {
        id: 'wi-1', revision: 2, updatedAt: 20, currentActionId: 'action-2',
        actions: [{ id: 'action-2' }],
      },
    };
    let resolveDetail;
    store.workCenterRequest = vi.fn(() => new Promise(resolve => { resolveDetail = resolve; }));

    const refresh = store.refreshWorkItemDetailAfterActionChange('agent-1', {
      id: 'wi-1', revision: 2, updatedAt: 20, currentActionId: 'action-2',
    });
    resolveDetail({
      id: 'wi-1', revision: 1, updatedAt: 10, currentActionId: 'action-2', actions: [{ id: 'action-2' }],
    });
    await refresh;

    expect(store.workCenterDetailByAgent['agent-1']).toMatchObject({ revision: 2, updatedAt: 20 });
  });

  it('does not let a delayed Action refresh overwrite a newly selected Work Item', async () => {
    const store = makeStore('yeaft');
    store.workCenterItemsByAgent = { 'agent-1': [] };
    store.workCenterDetailByAgent = {
      'agent-1': { id: 'wi-1', revision: 1, currentActionId: 'action-1', actions: [{ id: 'action-1' }] },
    };
    let resolveDetail;
    store.workCenterRequest = vi.fn(() => new Promise(resolve => { resolveDetail = resolve; }));

    store.applyWorkCenterEvent('agent-1', {
      workItem: { id: 'wi-1', revision: 2, currentActionId: 'action-2' },
    });
    store.workCenterDetailByAgent = {
      'agent-1': { id: 'wi-2', revision: 1, currentActionId: 'other-action', actions: [] },
    };
    resolveDetail({ id: 'wi-1', revision: 2, currentActionId: 'action-2', actions: [{ id: 'action-2' }] });
    await Promise.resolve();
    await Promise.resolve();

    expect(store.workCenterDetailByAgent['agent-1']).toMatchObject({ id: 'wi-2' });
  });
});
