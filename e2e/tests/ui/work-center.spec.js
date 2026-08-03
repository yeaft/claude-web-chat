import { expect } from '@playwright/test';
import { test } from '../../fixtures/test-server.js';
import { BUILT_IN_ACTION_TYPES } from '../../../agent/yeaft/work-center/workflow.js';

const WORK_CENTER_SETTINGS = {
  settings: {
    version: 1,
    revision: 7,
    defaultWorkflowId: 'software-change',
    startImmediately: true,
    defaultWorkDir: '/tmp/test',
    globalInstructions: 'Follow the Agent release policy for every Action.',
    modelPolicy: { mode: 'specific', model: 'provider/review', effort: 'high' },
    coordinatorModelPolicy: { mode: 'inherit', model: null, effort: 'high' },
    actionModelPolicies: Object.fromEntries(BUILT_IN_ACTION_TYPES.map(type => [type, {
      mode: 'inherit', model: null, effort: ['triage', 'research', 'design', 'diagnose', 'review'].includes(type) ? 'high' : 'medium',
    }])),
    actionInstructions: {
      triage: 'Plan the task', research: 'Research the problem', design: 'Design the solution',
      diagnose: 'Diagnose the root cause', implement: 'Implement the change', migrate: 'Migrate safely',
      test: 'Test the change', review: 'Review independently', integrate: 'Integrate the changes',
      document: 'Document the result',
      operate: 'Operate safely', deliver: 'Deliver the result', write: 'Write the content',
      custom: 'Complete the custom Action',
    },
    workflows: [{
      version: 1,
      id: 'software-change',
      name: 'Software change',
      stages: [
        { id: 'triage', name: 'Triage', type: 'triage', instruction: '', assignmentPolicy: { mode: 'auto', capability: 'triage', candidateVpIds: [], fixedVpId: null, separateFromStageTypes: [] }, modelPolicy: { mode: 'inherit', model: null, effort: null }, maxAttempts: 2 },
        { id: 'implement', name: 'Implement', type: 'implement', instruction: '', assignmentPolicy: { mode: 'auto', capability: 'implement', candidateVpIds: [], fixedVpId: null, separateFromStageTypes: [] }, modelPolicy: { mode: 'inherit', model: null, effort: null }, maxAttempts: 2 },
        { id: 'review', name: 'Review', type: 'review', instruction: '', assignmentPolicy: { mode: 'auto', capability: 'review', candidateVpIds: [], fixedVpId: null, separateFromStageTypes: ['implement'] }, modelPolicy: { mode: 'specific', model: 'provider/review', effort: 'high' }, maxAttempts: 2, changesRequestedStageId: 'implement' },
      ],
    }],
  },
  runtime: {
    vps: [
      { id: 'omni', name: 'Omni', role: 'Requirement Lead', traits: ['triage'] },
      { id: 'linus', name: 'Linus', role: 'Systems Engineer', traits: ['implementation'] },
      { id: 'martin', name: 'Martin', role: 'Code Reviewer', traits: ['review'] },
    ],
    models: [
      { id: 'primary', ref: 'provider/primary', provider: 'provider', label: 'primary' },
      { id: 'review', ref: 'provider/review', provider: 'provider', label: 'review', effortOptions: ['medium', 'high'] },
    ],
    primaryModel: 'provider/primary',
    fastModel: null,
    workItemAttachments: true,
    workItemTypes: [{ id: 'software-change', name: 'Software change', actionCount: 3 }],
  },
};

const OPEN_ITEM = {
  id: 'work-item-open',
  title: 'Fix Work Center layout',
  goal: 'Keep the Work Center usable at every supported viewport width.',
  status: 'running',
  boardLane: 'active',
  updatedAt: Date.now(),
  currentAction: { id: 'action-1', type: 'implement', requiredRole: 'developer' },
  coordinatorRevision: 0,
};

const OPEN_ITEM_DETAIL = {
  ...OPEN_ITEM,
  revision: 1,
  currentActionId: 'action-1',
  workDir: '/tmp/project',
  workflowTemplate: 'software-change',
  acceptanceCriteria: ['The Action flow remains readable'],
  planRevision: 2,
  ledgerRevision: 4,
  coordinatorRevision: 0,
  messages: [],
  executionStats: {
    llmRequestCount: 4, loopCount: 3, toolCount: 8,
    inputTokens: 1200, outputTokens: 300, cacheReadTokens: 200, cacheWriteTokens: 50,
    totalTokens: 1750,
  },
  actionCount: 1,
  actionSummary: 'implement',
  actions: [{
    id: 'action-1', generation: 1, sequence: 1, type: 'implement', requiredRole: 'developer', status: 'running',
    assignedVp: { id: 'linus', name: 'Linus' },
    contentSummary: 'Updated the existing layout styles and verified supported breakpoints.',
    brief: {
      objective: 'Make the Work Center layout responsive',
      approach: 'Update the existing layout styles and verify supported breakpoints',
      expectedOutcome: 'The Work Center remains readable without horizontal overflow',
    },
    executionStats: {
      llmRequestCount: 4, loopCount: 3, toolCount: 8,
      inputTokens: 1200, outputTokens: 300, cacheReadTokens: 200, cacheWriteTokens: 50,
      totalTokens: 1750,
    },
    loopCount: 3, toolCount: 8, progressRevision: 4,
    response: 'Updated the existing layout styles and verified supported breakpoints.',
    messages: [{
      id: 'action-1:1', role: 'assistant', status: 'running',
      speaker: { id: 'linus', name: 'Linus' },
      text: 'Updated the existing layout styles and verified supported breakpoints.',
      createdAt: Date.now(), updatedAt: Date.now(),
    }],
  }],
};

function detailWithActions(count) {
  const actions = Array.from({ length: count }, (_, index) => ({
    ...OPEN_ITEM_DETAIL.actions[0],
    id: `action-${index + 1}`,
    sequence: index + 1,
    type: index % 2 ? 'review' : 'implement',
    status: index === count - 1 ? 'ready' : 'completed',
    response: `Action ${index + 1} response`,
    messages: [],
  }));
  return {
    ...OPEN_ITEM_DETAIL,
    actionCount: count,
    currentActionId: actions.at(-1).id,
    actions,
  };
}

const FAILED_ITEM = {
  ...OPEN_ITEM,
  status: 'needs_attention',
  boardLane: 'needs_attention',
  title: 'Local run',
};

const GENERATION_ITEM = {
  ...OPEN_ITEM,
  id: 'work-item-generation',
  title: 'Generation-bound draft',
  updatedAt: Number(OPEN_ITEM.updatedAt) + 10,
};

const GENERATION_ITEM_DETAIL = {
  ...OPEN_ITEM_DETAIL,
  ...GENERATION_ITEM,
  currentActionId: 'action-generation',
  currentAction: { ...OPEN_ITEM.currentAction, id: 'action-generation' },
  actions: [{ ...OPEN_ITEM_DETAIL.actions[0], id: 'action-generation', generation: 1 }],
};

const FAILED_ITEM_DETAIL = {
  ...OPEN_ITEM_DETAIL,
  ...FAILED_ITEM,
  status: 'needs_attention',
  messages: [],
  actions: [{
    ...OPEN_ITEM_DETAIL.actions[0],
    status: 'failed',
    failure: {
      error: 'The implementation produced an unsafe patch and validation could not load its configuration.',
      summary: 'All unverified changes were reverted; the Action still needs implementation.',
      failedAt: Date.now(),
    },
  }],
};

const WAITING_ITEM = {
  ...OPEN_ITEM,
  id: 'work-item-waiting',
  title: 'Choose the database',
  status: 'waiting',
  currentAction: { ...OPEN_ITEM.currentAction, generation: 1, status: 'waiting' },
};

const WAITING_ITEM_DETAIL = {
  ...OPEN_ITEM_DETAIL,
  ...WAITING_ITEM,
  currentActionId: 'action-1',
  messages: [{
    id: 'coordinator-human-request', role: 'assistant', status: 'completed',
    speaker: { id: 'omni', name: 'Omni' },
    text: 'Choose the database so the Work Item can continue.',
    decision: { kind: 'request_human', reason: 'The database target is missing.' },
    recovery: {
      actionId: 'action-1', actionGeneration: 1, stageId: 'implement', attempt: 1,
    },
    createdAt: Date.now(), updatedAt: Date.now(),
  }],
  actions: [{
    ...OPEN_ITEM_DETAIL.actions[0],
    status: 'waiting',
    canonicalResult: {
      waitingReason: 'Choose PostgreSQL or SQLite before the migration continues.',
    },
  }],
};

const ACTION_OVERFLOW_DETAIL = structuredClone(OPEN_ITEM_DETAIL);
ACTION_OVERFLOW_DETAIL.actions[0].status = 'waiting';
ACTION_OVERFLOW_DETAIL.actions[0].canonicalResult = { waitingReason: `waiting-${'w'.repeat(1200)}` };
ACTION_OVERFLOW_DETAIL.actions[0].messages = [
  {
    id: 'action-overflow-message',
    role: 'assistant',
    status: 'completed',
    speaker: { id: `speaker-${'s'.repeat(1200)}` },
    text: 'Action overflow probe',
    attachments: [{ id: 'action-overflow-attachment', name: `attachment-${'a'.repeat(1800)}.txt`, size: 12 }],
    createdAt: Date.now() - 1,
    updatedAt: Date.now() - 1,
  },
  {
    id: 'action-overflow-user',
    role: 'user',
    status: 'completed',
    text: 'Keep the correction small.',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  },
];

function closedWorkItem(status) {
  const suffix = status === 'done' ? 'done' : 'cancelled';
  return {
    ...OPEN_ITEM,
    id: `work-item-${suffix}`,
    title: status === 'done' ? 'Released layout fix' : 'Cancelled layout experiment',
    status,
    boardLane: 'closed',
    revision: status === 'done' ? 4 : 3,
    currentAction: null,
    actionCount: 1,
    completedActionCount: status === 'done' ? 1 : 0,
  };
}

function closedWorkItemDetail(item) {
  const cancelled = item.status === 'cancelled';
  return {
    ...OPEN_ITEM_DETAIL,
    ...item,
    currentActionId: null,
    messages: [
      {
        id: `${item.id}:user`, role: 'user', status: 'completed',
        text: `Close ${item.title}`, createdAt: Date.now() - 2, updatedAt: Date.now() - 2,
      },
      {
        id: `${item.id}:assistant`, role: 'assistant', status: 'completed',
        text: cancelled ? 'Yeaft recorded the cancellation.' : 'Yeaft confirmed every acceptance criterion.',
        createdAt: Date.now() - 1, updatedAt: Date.now() - 1,
      },
    ],
    actionCount: 1,
    actionSummary: 'implement',
    actions: [{
      ...OPEN_ITEM_DETAIL.actions[0],
      id: `action-${item.status}`,
      status: cancelled ? 'cancelled' : 'completed',
      response: cancelled ? 'Execution stopped without publishing changes.' : 'Verified and released the layout fix.',
      messages: [{
        id: `action-${item.status}:message`, role: 'assistant', status: cancelled ? 'cancelled' : 'completed',
        text: cancelled ? 'Execution stopped without publishing changes.' : 'Verified and released the layout fix.',
        createdAt: Date.now(), updatedAt: Date.now(),
      }],
    }],
  };
}

const DONE_ITEM = closedWorkItem('done');
const CANCELLED_ITEM = closedWorkItem('cancelled');
const DONE_ITEM_DETAIL = closedWorkItemDetail(DONE_ITEM);
const CANCELLED_ITEM_DETAIL = closedWorkItemDetail(CANCELLED_ITEM);

const ACTION_REQUEST_INDEX = {
  actionId: 'action-1',
  generation: 1,
  requests: [{
    id: 'request-1', runId: 'run-1', generation: 1, attempt: 1,
    status: 'running', model: 'provider/primary',
    vp: { id: 'linus', name: 'Linus' }, openedAt: Date.now(), closedAt: null,
    loopCount: 2, totalMs: 820, inputTokens: 1200, outputTokens: 300, totalTokens: 1500,
  }],
};

const ACTION_REQUEST_DETAIL = {
  actionId: 'action-1',
  generation: 1,
  request: {
    ...ACTION_REQUEST_INDEX.requests[0],
    loops: [{
      id: 'loop-1', loopNumber: 1, model: 'provider/primary', systemPrompt: 'System prompt',
      messages: [{ role: 'user', content: 'Fix the layout' }], response: 'Inspecting the layout.',
      usage: { inputTokens: 1200, outputTokens: 300, totalTokens: 1500 },
      latencyMs: 820, ttfbMs: 120, stopReason: 'tool_use', at: Date.now(),
      tools: [{ id: 'tool-1', name: 'FileRead', input: { file_path: 'web/styles/work-center.css' }, output: 'css', durationMs: 20, isError: false }],
      rawRequest: { method: 'POST', url: 'https://provider.test/v1/responses', headers: { Authorization: '***' } },
      rawResponse: { status: 200 },
    }],
  },
};

const workCenterTransports = new WeakMap();

async function installWorkCenterTransport(chatPage) {
  if (workCenterTransports.has(chatPage)) return workCenterTransports.get(chatPage);
  await chatPage.evaluate(() => {
    const store = window.Pinia.useChatStore();
    if (store.__workCenterE2ETransportInstalled) return;
    store.__workCenterE2ETransportInstalled = true;
    store.__workCenterE2ERequests = [];
    store.__workCenterE2EWaiters = [];
    store.workCenterRequest = (op, payload = {}, agentId = null) => new Promise((resolve, reject) => {
      const request = { op, payload, agentId: agentId || store.workCenterAgentId || store.currentAgent };
      const waiter = store.__workCenterE2EWaiters.shift();
      if (waiter) waiter(request);
      else store.__workCenterE2ERequests.push(request);
      request.resolve = resolve;
      request.reject = reject;
    });
  });
  const transport = {
    async takeNow() {
      return chatPage.evaluate(() => {
        const store = window.Pinia.useChatStore();
        const request = store.__workCenterE2ERequests.shift();
        if (!request) return null;
        const id = `${Date.now()}-${Math.random()}`;
        store.__workCenterE2EInflight ||= {};
        store.__workCenterE2EInflight[id] = request;
        return { id, op: request.op, payload: request.payload, agentId: request.agentId };
      });
    },
    async next() {
      return chatPage.evaluate(() => new Promise(resolve => {
        const store = window.Pinia.useChatStore();
        const request = store.__workCenterE2ERequests.shift();
        if (request) {
          const id = `${Date.now()}-${Math.random()}`;
          store.__workCenterE2EInflight ||= {};
          store.__workCenterE2EInflight[id] = request;
          resolve({ id, op: request.op, payload: request.payload, agentId: request.agentId });
          return;
        }
        store.__workCenterE2EWaiters.push(nextRequest => {
          const id = `${Date.now()}-${Math.random()}`;
          store.__workCenterE2EInflight ||= {};
          store.__workCenterE2EInflight[id] = nextRequest;
          resolve({ id, op: nextRequest.op, payload: nextRequest.payload, agentId: nextRequest.agentId });
        });
      }));
    },
    async resolve(request, data) {
      await chatPage.evaluate(({ id, data: response }) => {
        const store = window.Pinia.useChatStore();
        const pending = store.__workCenterE2EInflight?.[id];
        if (!pending) throw new Error(`Missing Work Center E2E request ${id}`);
        delete store.__workCenterE2EInflight[id];
        pending.resolve(response);
      }, { id: request.id, data });
    },
    async reject(request, message) {
      await chatPage.evaluate(({ id, message: errorMessage }) => {
        const store = window.Pinia.useChatStore();
        const pending = store.__workCenterE2EInflight?.[id];
        if (!pending) throw new Error(`Missing Work Center E2E request ${id}`);
        delete store.__workCenterE2EInflight[id];
        pending.reject(new Error(errorMessage));
      }, { id: request.id, message });
    },
  };
  workCenterTransports.set(chatPage, transport);
  return transport;
}

async function respondToWorkCenterRequest(mockAgent, data) {
  if (mockAgent?.__workCenterTransport) {
    const request = await mockAgent.__workCenterTransport.next();
    await mockAgent.__workCenterTransport.resolve(request, data);
    return request;
  }
  const request = await mockAgent.waitForMessage('work_center_request');
  mockAgent.send({
    type: 'work_center_response',
    requestId: request.requestId,
    op: request.op,
    ok: true,
    data,
  });
  return request;
}

async function respondToWorkCenterOp(mockAgent, op, data, listItems = [OPEN_ITEM]) {
  if (mockAgent?.__workCenterTransport) {
    for (;;) {
      const request = await mockAgent.__workCenterTransport.next();
      if (request.op === op) {
        await mockAgent.__workCenterTransport.resolve(request, data);
        return request;
      }
      const fallbackData = request.op === 'list' ? { items: listItems, watcher: { enabled: true } }
        : request.op === 'get_settings' ? WORK_CENTER_SETTINGS
        : request.op === 'get_runtime' ? WORK_CENTER_SETTINGS.runtime
        : request.op === 'get' ? data : null;
      if (!fallbackData) throw new Error(`Expected Work Center ${op}, received ${request.op}`);
      await mockAgent.__workCenterTransport.resolve(request, fallbackData);
    }
  }
  for (;;) {
    const request = await mockAgent.waitForMessage('work_center_request');
    if (request.op === op) {
      mockAgent.send({
        type: 'work_center_response', requestId: request.requestId, op, ok: true, data,
      });
      return request;
    }
    const fallbackData = request.op === 'list'
      ? { items: listItems, watcher: { enabled: true } }
      : request.op === 'get'
        ? data
        : null;
    if (!fallbackData) throw new Error(`Expected Work Center ${op}, received ${request.op}`);
    mockAgent.send({
      type: 'work_center_response',
      requestId: request.requestId,
      op: request.op,
      ok: true,
      data: fallbackData,
    });
  }
}

async function respondByOperation(mockAgent, responses) {
  if (mockAgent?.__workCenterTransport) {
    const request = await mockAgent.__workCenterTransport.next();
    const data = typeof responses[request.op] === 'function' ? responses[request.op](request) : responses[request.op];
    if (data === undefined) throw new Error(`No E2E response configured for Work Center op ${request.op}`);
    await mockAgent.__workCenterTransport.resolve(request, data);
    return request;
  }
  const request = await mockAgent.waitForMessage('work_center_request');
  const data = typeof responses[request.op] === 'function'
    ? responses[request.op](request)
    : responses[request.op];
  if (data === undefined) throw new Error(`No E2E response configured for Work Center op ${request.op}`);
  mockAgent.send({
    type: 'work_center_response', requestId: request.requestId, op: request.op, ok: true, data,
  });
  return request;
}

async function respondUntilOperation(mockAgent, targetOp, responses, limit = 8) {
  for (let index = 0; index < limit; index++) {
    const request = await respondByOperation(mockAgent, responses);
    if (request.op === targetOp) return request;
  }
  throw new Error(`Work Center op ${targetOp} did not arrive within ${limit} requests`);
}

function expectedActionPolicyCount() {
  return BUILT_IN_ACTION_TYPES.length + 1;
}

function expectedModelPolicyCount() {
  return BUILT_IN_ACTION_TYPES.length + 3;
}

function workCenterRequestOps(mockAgent) {
  return mockAgent.messages('work_center_request').map(request => request.op);
}

async function openWorkCenter(chatPage, mockAgent, items = [OPEN_ITEM]) {
  const transport = await installWorkCenterTransport(chatPage);
  mockAgent.__workCenterTransport = transport;
  for (;;) {
    const pending = await transport.takeNow();
    if (!pending) break;
    const response = pending.op === 'get_settings' ? WORK_CENTER_SETTINGS
      : pending.op === 'get_runtime' ? WORK_CENTER_SETTINGS.runtime
      : pending.op === 'list' ? { items, watcher: { enabled: true } }
      : null;
    if (response == null) throw new Error(`Unexpected Work Center startup op ${pending.op}`);
    await transport.resolve(pending, response);
  }
  await chatPage.evaluate(({ agentId, items: boardItems, settings, runtime }) => {
    const store = window.Pinia.useChatStore();
    store.hydrateWorkCenterBrowserState();
    store.workCenterAgentId = agentId;
    store.workCenterOpen = true;
    store.workCenterItemsByAgent[agentId] = boardItems;
    store.workCenterLoadedByAgent[agentId] = true;
    store.workCenterLoadingByAgent[agentId] = false;
    store.workCenterSettingsByAgent[agentId] = settings;
    store.workCenterRuntimeByAgent[agentId] = runtime;
  }, {
    agentId: mockAgent.agentId,
    items,
    settings: WORK_CENTER_SETTINGS.settings,
    runtime: WORK_CENTER_SETTINGS.runtime,
  });
  await expect(chatPage.locator('.work-center-main')).toBeVisible();
  await expect(chatPage.locator('.work-center-card')).toHaveCount(items.length);
}

async function layoutMetrics(page) {
  return page.evaluate(() => {
    const rect = selector => document.querySelector(selector)?.getBoundingClientRect() || null;
    const main = document.querySelector('.work-center-main');
    const body = document.querySelector('.work-center-body');
    return {
      viewportWidth: window.innerWidth,
      documentScrollWidth: document.documentElement.scrollWidth,
      sidebar: rect('.session-sidebar-shell'),
      main: rect('.work-center-main'),
      list: rect('.work-center-list'),
      detail: rect('.work-center-detail'),
      actionDetail: rect('.work-center-action-detail-pane'),
      mainClientWidth: main?.clientWidth || 0,
      mainScrollWidth: main?.scrollWidth || 0,
      bodyClientWidth: body?.clientWidth || 0,
      bodyScrollWidth: body?.scrollWidth || 0,
    };
  });
}

async function resizeWorkbenchForMainWidth(page, targetWidth) {
  await page.waitForTimeout(350);
  const resized = await page.evaluate(width => {
    const handle = document.querySelector('.workbench-panel .resize-handle');
    const main = document.querySelector('.work-center-main');
    if (!handle || !main) return false;
    const handleBox = handle.getBoundingClientRect();
    const startX = handleBox.x + handleBox.width / 2;
    const targetX = startX + main.getBoundingClientRect().width - width;
    handle.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, clientX: startX }));
    document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: targetX }));
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: targetX }));
    return true;
  }, targetWidth);
  if (!resized) throw new Error('Workbench resize geometry is unavailable');
  await page.waitForTimeout(350);
}

async function expectNoHorizontalOverflow(root, selectors) {
  const metrics = await root.evaluate((element, targetSelectors) => Object.fromEntries(
    Object.entries(targetSelectors).map(([name, selector]) => {
      const target = selector === ':scope' ? element : element.querySelector(selector);
      return [name, target ? { clientWidth: target.clientWidth, scrollWidth: target.scrollWidth } : null];
    }),
  ), selectors);
  for (const [name, metric] of Object.entries(metrics)) {
    expect(metric, `${name} overflow probe must exist`).not.toBeNull();
    expect(metric.scrollWidth, `${name} must not overflow horizontally`)
      .toBeLessThanOrEqual(metric.clientWidth + 1);
  }
  return metrics;
}

test.describe('Work Center responsive UI', () => {
  test('forwards canonical Work Item messages through the real browser-server-Agent wire', async ({ chatPage, mockAgent }) => {
    mockAgent.__workCenterTransport = null;
    const requestPromise = mockAgent.waitForMessage('work_center_request');
    const responsePromise = chatPage.evaluate(async ({ agentId, item }) => {
      const store = window.Pinia.useChatStore();
      store.workCenterAgentId = agentId;
      store.workCenterDetailByAgent[agentId] = item;
      return store.postWorkItemMessage(
        item.id,
        'Real canonical message',
        { kind: 'action', actionId: 'action-1', generation: 1 },
        item.revision,
        [],
        agentId,
        { planRevision: item.planRevision, ledgerRevision: item.ledgerRevision, coordinatorRevision: 0 },
      );
    }, { agentId: mockAgent.agentId, item: OPEN_ITEM_DETAIL });
    const request = await requestPromise;
    expect(request).toMatchObject({
      op: 'post_work_item_message',
      payload: {
        id: OPEN_ITEM.id,
        text: 'Real canonical message',
        target: { kind: 'action', actionId: 'action-1', generation: 1 },
        revision: 1,
        planRevision: 2,
        ledgerRevision: 4,
        coordinatorRevision: 0,
      },
    });
    expect(request.payload.clientMessageId).toEqual(expect.any(String));
    mockAgent.send({
      type: 'work_center_response', requestId: request.requestId,
      op: request.op, ok: true, data: OPEN_ITEM_DETAIL,
    });
    const listRequest = await mockAgent.waitForMessage('work_center_request');
    expect(listRequest.op).toBe('list');
    mockAgent.send({
      type: 'work_center_response', requestId: listRequest.requestId,
      op: listRequest.op, ok: true, data: { items: [OPEN_ITEM], watcher: { enabled: true } },
    });
    await expect(responsePromise).resolves.toMatchObject({ id: OPEN_ITEM.id });
    await expect.poll(() => chatPage.evaluate(() => {
      const store = window.Pinia.useChatStore();
      return Object.keys(store.workCenterMessageOutbox || {}).length;
    })).toBe(0);

    const firstUpload = await chatPage.evaluate(async () => {
      const formData = new FormData();
      formData.append('files', new File(['initial staged bytes'], 'initial-note.txt', { type: 'text/plain' }));
      const response = await fetch('/api/upload', { method: 'POST', body: formData });
      return (await response.json()).files[0];
    });
    const lostResponseRequest = mockAgent.waitForMessage('work_center_request');
    chatPage.evaluate(({ agentId, item, attachment }) => {
      const store = window.Pinia.useChatStore();
      store.workCenterAgentId = agentId;
      store.workCenterDetailByAgent[agentId] = item;
      store.postWorkItemMessage(
        item.id,
        'Retry this durable message after reload',
        { kind: 'action', actionId: 'action-1', generation: 1 },
        item.revision,
        [attachment],
        agentId,
        { planRevision: item.planRevision, ledgerRevision: item.ledgerRevision, coordinatorRevision: 0 },
      ).catch(() => {});
    }, { agentId: mockAgent.agentId, item: OPEN_ITEM_DETAIL, attachment: firstUpload });
    const firstAttempt = await lostResponseRequest;
    const durableClientMessageId = firstAttempt.payload.clientMessageId;
    expect(durableClientMessageId).toEqual(expect.any(String));
    expect(firstAttempt.payload.attachments[0].fileId).toBe(firstUpload.fileId);
    await expect.poll(() => chatPage.evaluate(id => {
      const store = window.Pinia.useChatStore();
      return Object.values(store.workCenterMessageOutbox || {})
        .some(envelope => envelope.clientMessageId === id);
    }, durableClientMessageId)).toBe(true);

    await chatPage.reload();
    await chatPage.waitForSelector('.chat-page');
    await chatPage.waitForFunction(agentId => {
      const store = window.Pinia?.useChatStore?.();
      return (store?.agents || []).some(agent => agent.id === agentId && agent.online === true);
    }, mockAgent.agentId);
    const messagesBeforeExpiredRetry = mockAgent.messages('work_center_request').length;
    const expiredRetry = chatPage.evaluate(({ agentId, item }) => {
      const store = window.Pinia.useChatStore();
      store.hydrateWorkCenterBrowserState();
      store.workCenterAgentId = agentId;
      store.workCenterDetailByAgent[agentId] = item;
      const envelope = store.loadWorkCenterMessageEnvelope(agentId, item.id);
      store.replaceWorkCenterMessageEnvelopeAttachments(agentId, item.id, [{
        ...envelope.attachments[0], fileId: 'expired-file-id',
      }]);
      return store.postWorkItemMessage(
        item.id, envelope.text, envelope.target, envelope.revision,
        envelope.attachments, agentId,
        {
          planRevision: envelope.planRevision,
          ledgerRevision: envelope.ledgerRevision,
          coordinatorRevision: envelope.coordinatorRevision,
        },
      );
    }, { agentId: mockAgent.agentId, item: OPEN_ITEM_DETAIL });
    await expect(expiredRetry).rejects.toThrow(/attachment expired/i);
    expect(mockAgent.messages('work_center_request')).toHaveLength(messagesBeforeExpiredRetry);

    const replacement = await chatPage.evaluate(async () => {
      const formData = new FormData();
      formData.append('files', new File(['replacement staged bytes'], 'replacement-note.txt', { type: 'text/plain' }));
      const response = await fetch('/api/upload', { method: 'POST', body: formData });
      return (await response.json()).files[0];
    });
    const retryRequestPromise = mockAgent.waitForMessage('work_center_request');
    const retryResponse = chatPage.evaluate(({ agentId, item, attachment }) => {
      const store = window.Pinia.useChatStore();
      const envelope = store.replaceWorkCenterMessageEnvelopeAttachments(
        agentId, item.id, [attachment],
      );
      return store.postWorkItemMessage(
        item.id, envelope.text, envelope.target, envelope.revision,
        envelope.attachments, agentId,
        {
          planRevision: envelope.planRevision,
          ledgerRevision: envelope.ledgerRevision,
          coordinatorRevision: envelope.coordinatorRevision,
        },
      );
    }, { agentId: mockAgent.agentId, item: OPEN_ITEM_DETAIL, attachment: replacement });
    const retryRequest = await retryRequestPromise;
    expect(retryRequest.payload).toMatchObject({
      clientMessageId: durableClientMessageId,
      text: 'Retry this durable message after reload',
      target: { kind: 'action', actionId: 'action-1', generation: 1 },
      revision: 1,
      planRevision: 2,
      ledgerRevision: 4,
      coordinatorRevision: 0,
    });
    expect(retryRequest.payload.attachments[0].fileId).toBe(replacement.fileId);
    mockAgent.send({
      type: 'work_center_event',
      event: {
        type: 'action.input_added',
        actionId: 'action-1',
        clientMessageId: durableClientMessageId,
        workItem: { ...OPEN_ITEM, revision: 2, updatedAt: Number(OPEN_ITEM.updatedAt) + 1 },
      },
    });
    const retryListRequest = await mockAgent.waitForMessage('work_center_request');
    expect(retryListRequest.op).toBe('list');
    mockAgent.send({
      type: 'work_center_response', requestId: retryListRequest.requestId,
      op: retryListRequest.op, ok: true,
      data: { items: [{ ...OPEN_ITEM, revision: 2 }], watcher: { enabled: true } },
    });
    await expect(retryResponse).resolves.toMatchObject({ id: OPEN_ITEM.id });
    await expect.poll(() => chatPage.evaluate(() => {
      const store = window.Pinia.useChatStore();
      return Object.keys(store.workCenterMessageOutbox || {}).length;
    })).toBe(0);
  });

  test('keeps sidebar and content inside tablet and compact desktop viewports', async ({ chatPage, mockAgent }) => {
    await openWorkCenter(chatPage, mockAgent);

    for (const width of [768, 960, 961, 1024]) {
      await chatPage.setViewportSize({ width, height: 900 });
      await chatPage.waitForTimeout(350);
      const metrics = await layoutMetrics(chatPage);

      expect(metrics.sidebar.x, `${width}px sidebar x`).toBeGreaterThanOrEqual(0);
      expect(metrics.documentScrollWidth, `${width}px document width`).toBeLessThanOrEqual(width);
      expect(metrics.mainScrollWidth, `${width}px main overflow`).toBeLessThanOrEqual(metrics.mainClientWidth + 1);
      expect(metrics.bodyScrollWidth, `${width}px workspace overflow`).toBeLessThanOrEqual(metrics.bodyClientWidth + 1);
      expect(metrics.detail.right, `${width}px detail edge`).toBeLessThanOrEqual(width + 1);
    }
  });

  test('keeps Conversation primary and opens Actions only on demand', async ({ chatPage, mockAgent }) => {
    await openWorkCenter(chatPage, mockAgent);
    await chatPage.setViewportSize({ width: 1600, height: 900 });
    const select = chatPage.locator('.work-center-card').click();
    await respondToWorkCenterOp(mockAgent, 'get', OPEN_ITEM_DETAIL);
    await select;

    const detail = chatPage.locator('.work-center-detail');
    const conversation = detail.locator('.work-center-conversation');
    const content = detail.locator('.work-center-content-pane');
    const actionsButton = detail.getByRole('button', { name: /^\d+ Actions$/ });
    await expect(chatPage.locator('.work-center-list')).toBeHidden();
    await expect(detail).toBeVisible();
    await expect(conversation).toBeVisible();
    await expect(content).toHaveCount(0);
    await expect(actionsButton).toHaveAttribute('aria-expanded', 'false');
    await expect(chatPage).not.toHaveURL(/workContent=/);
    await expect(detail.locator('textarea')).toHaveCount(1);

    await actionsButton.click();
    await expect(content).toBeVisible();
    await expect(actionsButton).toHaveAttribute('aria-expanded', 'true');
    await expect(chatPage).toHaveURL(/workContent=action-list/);
    await content.locator('.work-center-action-summary').click();
    const actionDetail = content.locator('.work-center-action-detail-pane');
    await expect(detail).toBeVisible();
    await expect(conversation).toBeVisible();
    await expect(actionDetail).toBeVisible();
    await expect(actionDetail.locator('textarea')).toHaveCount(0);
    await expect(detail.locator('textarea')).toHaveCount(1);
    await actionDetail.getByRole('button', { name: 'Back to Actions' }).click();
    await expect(content.locator('.work-center-action-list')).toBeVisible();
    await content.getByRole('button', { name: 'Close Actions' }).click();
    await expect(content).toHaveCount(0);
    await expect(conversation).toBeVisible();
    await expect(actionsButton).toBeFocused();
    await expect(chatPage).not.toHaveURL(/workContent=/);

    await chatPage.setViewportSize({ width: 867, height: 900 });
    await actionsButton.click();
    await expect(content).toBeVisible();
    await expect(conversation).toBeHidden();
    await content.getByRole('button', { name: 'Close Actions' }).click();
    await expect(conversation).toBeVisible();

    await chatPage.setViewportSize({ width: 720, height: 900 });
    await actionsButton.click();
    await expect(content).toBeVisible();
    await expect(conversation).toBeHidden();
    const metrics = await layoutMetrics(chatPage);
    expect(metrics.mainScrollWidth).toBeLessThanOrEqual(metrics.mainClientWidth + 1);
    expect(metrics.bodyScrollWidth).toBeLessThanOrEqual(metrics.bodyClientWidth + 1);
    await content.getByRole('button', { name: 'Close Actions' }).click();
    await expect(conversation).toBeVisible();
  });

  test('switches to drilldown when the Workbench reduces the actual Work Center width', async ({ chatPage, mockAgent }) => {
    await openWorkCenter(chatPage, mockAgent);
    await chatPage.setViewportSize({ width: 1600, height: 900 });
    const select = chatPage.locator('.work-center-card').click();
    await respondToWorkCenterOp(mockAgent, 'get', OPEN_ITEM_DETAIL);
    await select;

    await expect(chatPage.locator('.work-center-list')).toBeHidden();
    await expect(chatPage.locator('.work-center-detail')).toBeVisible();
    await expect(chatPage.locator('.work-center-action-detail-pane')).toBeHidden();

    await chatPage.locator('.session-sidebar-shell .sidebar-icon-btn[title="Workbench"]').click();
    await expect(chatPage.locator('.workbench-panel')).toHaveClass(/expanded/);
    await expect(chatPage.locator('.work-center-list')).toBeHidden();
    await expect(chatPage.locator('.work-center-detail')).toBeVisible();
    await expect(chatPage.locator('.work-center-action-detail-pane')).toBeHidden();

    const metrics = await layoutMetrics(chatPage);
    expect(metrics.mainScrollWidth).toBeLessThanOrEqual(metrics.mainClientWidth + 1);
    expect(metrics.bodyScrollWidth).toBeLessThanOrEqual(metrics.bodyClientWidth + 1);
  });

  test('switches cleanly across the container breakpoint when the Workbench is dragged wider', async ({ chatPage, mockAgent }) => {
    await openWorkCenter(chatPage, mockAgent);
    await chatPage.setViewportSize({ width: 1920, height: 900 });
    const select = chatPage.locator('.work-center-card').click();
    await respondToWorkCenterOp(mockAgent, 'get', ACTION_OVERFLOW_DETAIL);
    await select;

    await chatPage.getByRole('button', { name: /^\d+ Actions$/ }).click();
    await chatPage.locator('.work-center-action-summary').click();
    const actionPane = chatPage.locator('.work-center-action-detail-pane');
    await expect(actionPane).toBeVisible();
    await chatPage.locator('.session-sidebar-shell .sidebar-icon-btn[title="Workbench"]').click();
    await expect(chatPage.locator('.workbench-panel')).toHaveClass(/expanded/);

    await resizeWorkbenchForMainWidth(chatPage, 1280);
    let metrics = await layoutMetrics(chatPage);
    expect(metrics.main.width).toBeGreaterThan(1250);
    await expect(chatPage.locator('.work-center-list')).toBeHidden();
    await expect(chatPage.locator('.work-center-detail')).toBeVisible();
    await expect(chatPage.locator('.work-center-action-detail-pane')).toBeVisible();
    expect(metrics.mainScrollWidth).toBeLessThanOrEqual(metrics.mainClientWidth + 1);
    expect(metrics.bodyScrollWidth).toBeLessThanOrEqual(metrics.bodyClientWidth + 1);
    await expectNoHorizontalOverflow(actionPane, {
      pane: ':scope',
      transcript: '.work-center-action-transcript',
      column: '.work-center-action-conversation-column',
      waiting: '.work-center-action-waiting',
      waitingText: '.work-center-action-waiting p',
      messageList: '.work-center-action-message-list',
      message: '.work-center-action-message',
      messageHeader: '.work-center-action-message header',
      speaker: '.work-center-action-message header strong',
      attachmentList: '.work-center-attachment-list',
      attachmentChip: '.work-center-attachment-chip',
    });

    await resizeWorkbenchForMainWidth(chatPage, 1200);
    metrics = await layoutMetrics(chatPage);
    expect(metrics.main.width).toBeGreaterThan(1160);
    expect(metrics.main.width).toBeLessThanOrEqual(1250);
    await expect(chatPage.locator('.work-center-list')).toBeHidden();
    await expect(chatPage.locator('.work-center-detail')).toBeVisible();
    await expect(chatPage.locator('.work-center-action-detail-pane')).toBeVisible();
    expect(metrics.mainScrollWidth).toBeLessThanOrEqual(metrics.mainClientWidth + 1);
    expect(metrics.bodyScrollWidth).toBeLessThanOrEqual(metrics.bodyClientWidth + 1);
    await expectNoHorizontalOverflow(actionPane, {
      pane: ':scope',
      transcript: '.work-center-action-transcript',
      column: '.work-center-action-conversation-column',
      waiting: '.work-center-action-waiting',
      waitingText: '.work-center-action-waiting p',
      messageList: '.work-center-action-message-list',
      message: '.work-center-action-message',
      messageHeader: '.work-center-action-message header',
      speaker: '.work-center-action-message header strong',
      attachmentList: '.work-center-attachment-list',
      attachmentChip: '.work-center-attachment-chip',
    });
  });

  test('keeps a long Action list reachable in a short workspace', async ({ chatPage, mockAgent }) => {
    const detail = detailWithActions(24);
    await openWorkCenter(chatPage, mockAgent);
    await chatPage.setViewportSize({ width: 1440, height: 520 });
    const select = chatPage.locator('.work-center-card').click();
    await respondToWorkCenterOp(mockAgent, 'get', detail);
    await select;

    await chatPage.getByRole('button', { name: /^\d+ Actions$/ }).click();
    const actionList = chatPage.locator('.work-center-action-list');
    const cards = actionList.locator('.work-center-action-card');
    const workflow = chatPage.locator('.work-center-workflow');
    await expect(cards).toHaveCount(24);
    const columns = await chatPage.locator('.work-center-detail-layout').evaluate(element => getComputedStyle(element).gridTemplateColumns);
    expect(columns).toContain('500px');
    await cards.last().scrollIntoViewIfNeeded();
    await expect(cards.last()).toBeInViewport();
    const scroll = await workflow.evaluate(element => ({
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
      scrollTop: element.scrollTop,
    }));
    expect(scroll.scrollHeight).toBeGreaterThan(scroll.clientHeight);
    expect(scroll.scrollTop).toBeGreaterThan(0);

    const firstCard = cards.first();
    const cardLayout = await firstCard.evaluate(element => {
      const title = element.querySelector('.work-center-action-primary strong');
      const summary = element.querySelector('.work-center-action-description');
      const titleStyle = title ? getComputedStyle(title) : null;
      return {
        cardWidth: element.getBoundingClientRect().width,
        scrollWidth: element.scrollWidth,
        titleWidth: title?.getBoundingClientRect().width || 0,
        summaryWidth: summary?.getBoundingClientRect().width || 0,
        titleWritingMode: titleStyle?.writingMode || '',
      };
    });
    expect(cardLayout.scrollWidth).toBeLessThanOrEqual(cardLayout.cardWidth + 1);
    expect(cardLayout.titleWidth).toBeGreaterThan(100);
    expect(cardLayout.summaryWidth).toBeGreaterThan(100);
    expect(cardLayout.titleWritingMode).toBe('horizontal-tb');

    await chatPage.setViewportSize({ width: 520, height: 760 });
    await chatPage.waitForTimeout(350);
    await expect(chatPage.locator('.work-center-conversation-pane')).toBeHidden();
    await expect(chatPage.locator('.work-center-content-pane')).toBeVisible();
    await expect(workflow).toBeVisible();
    await workflow.getByRole('button', { name: 'Close Actions' }).click();
    await expect(chatPage.locator('.work-center-conversation-pane')).toBeVisible();
  });

  test('maximizes and restores the Workbench without leaving the main area in the layout', async ({ chatPage, mockAgent }) => {
    await openWorkCenter(chatPage, mockAgent);
    await chatPage.setViewportSize({ width: 1440, height: 900 });

    await chatPage.locator('.session-sidebar-shell .sidebar-icon-btn[title="Workbench"]').click();
    const panel = chatPage.locator('.workbench-panel');
    const main = chatPage.locator('.work-center-main');
    await expect(panel).toHaveClass(/expanded/);
    await expect(main).toBeVisible();

    const maximize = panel.locator('.wb-tab-action').first();
    await maximize.click();
    await expect(panel).toHaveClass(/maximized/);
    await expect(main).toBeHidden();

    await maximize.click();
    await expect(panel).not.toHaveClass(/maximized/);
    await expect(panel).toHaveClass(/expanded/);
    await expect(main).toBeVisible();
  });

  test('uses one composer and changes wire target only after an explicit target choice', async ({ chatPage, mockAgent }) => {
    await openWorkCenter(chatPage, mockAgent, [OPEN_ITEM, GENERATION_ITEM]);
    const select = chatPage.locator('.work-center-card', { hasText: OPEN_ITEM.title }).click();
    const getRequest = await respondToWorkCenterOp(mockAgent, 'get', OPEN_ITEM_DETAIL);
    await select;
    expect(getRequest.op).toBe('get');

    await expect(chatPage.locator('.work-center-content-pane')).toHaveCount(0);
    await chatPage.getByRole('button', { name: /^\d+ Actions$/ }).click();
    await expect(chatPage.locator('.work-center-action-list-heading')).toContainText('1 Actions');
    const action = chatPage.locator('.work-center-action-card');
    await expect(action).toHaveCount(1);
    await expect(chatPage.locator('.work-center-action-list-heading small')).toHaveText('implement');
    await expect(action).toContainText('Linus');
    await expect(action).toContainText('Update the existing layout styles and verify supported breakpoints');
    await expect(action).not.toContainText('LLM requests');
    await expect(action).not.toContainText('loops');
    await expect(action).not.toContainText('tools');
    await expect(action).not.toContainText('tokens');
    await expect(chatPage.locator('.work-center-detail-usage')).toContainText('4 LLM requests');
    await expect(chatPage.locator('.work-center-detail-usage')).toContainText('1.8k tokens');
    await chatPage.locator('.work-center-content-pane').getByRole('button', { name: 'Close Actions' }).click();
    const conversation = chatPage.locator('.work-center-conversation');
    await expect(conversation).toHaveAttribute('aria-label', 'Conversation');
    await expect(conversation.locator('.work-center-coordinator-empty')).toHaveCount(0);
    const workItemComposer = conversation.locator('textarea');
    const target = conversation.getByTestId('work-center-composer-target');
    await expect(chatPage.locator('.work-center-detail textarea')).toHaveCount(1);
    await expect(target).toHaveValue('coordinator');
    await workItemComposer.fill('Change the goal\nand replan the remaining Actions');
    const workItemComposerMetrics = await workItemComposer.evaluate(element => ({
      clientHeight: element.clientHeight,
      lineHeight: Number.parseFloat(getComputedStyle(element).lineHeight),
      overflowY: getComputedStyle(element).overflowY,
    }));
    expect(workItemComposerMetrics.clientHeight).toBeGreaterThan(workItemComposerMetrics.lineHeight * 1.5);
    expect(workItemComposerMetrics.overflowY).toBe('hidden');
    const workItemInputWidth = await conversation.locator('.work-center-item-message-input')
      .evaluate(element => element.getBoundingClientRect().width);
    const conversationWidth = await conversation.evaluate(element => element.getBoundingClientRect().width);
    expect(workItemInputWidth).toBeGreaterThan(conversationWidth * 0.72);
    const conversationResponse = respondToWorkCenterOp(mockAgent, 'post_work_item_message', {
      accepted: true,
      turnId: 'turn-1',
    });
    await conversation.getByRole('button', { name: 'Send to Coordinator' }).click();
    const conversationRequest = await conversationResponse;
    expect(conversationRequest.payload).toMatchObject({
      id: OPEN_ITEM.id,
      target: { kind: 'coordinator' },
      text: 'Change the goal\nand replan the remaining Actions',
      revision: 1,
      planRevision: 2,
      ledgerRevision: 4,
      coordinatorRevision: 0,
    });
    await expect(workItemComposer).toHaveValue('');

    await workItemComposer.fill('Recover this request after its staged attachment expires');
    await conversation.locator('.work-center-item-message-input input[type="file"]').setInputFiles({
      name: 'expired-note.txt', mimeType: 'text/plain',
      buffer: Buffer.from('expired staged attachment'),
    });
    await expect(conversation.locator('.work-center-message-draft-attachments'))
      .toContainText('expired-note.txt');
    const expiredAttemptPromise = mockAgent.__workCenterTransport.next();
    await conversation.locator('.send-btn').click();
    const expiredAttempt = await expiredAttemptPromise;
    expect(expiredAttempt.op).toBe('post_work_item_message');
    const expiredClientMessageId = expiredAttempt.payload.clientMessageId;
    const expiredFileId = expiredAttempt.payload.attachments[0].fileId;
    expect(expiredClientMessageId).toEqual(expect.any(String));
    await mockAgent.__workCenterTransport.reject(
      expiredAttempt, 'WorkItem attachment expired; upload it again',
    );
    await expect(conversation.locator('.work-center-error'))
      .toContainText('WorkItem attachment expired; upload it again');
    const pendingActions = conversation.locator('.work-center-stale-target', {
      hasText: 'An unconfirmed request is locked to its original identity.',
    });
    await expect(pendingActions).toBeVisible();
    await expect(pendingActions.getByText('Replace attachments')).toBeVisible();
    await expect(pendingActions.getByRole('button', { name: 'Discard pending request' })).toBeVisible();
    await expect(workItemComposer).toBeDisabled();

    await pendingActions.locator('input[type="file"]').setInputFiles({
      name: 'replacement-note.txt', mimeType: 'text/plain',
      buffer: Buffer.from('replacement staged attachment'),
    });
    await expect(conversation.locator('.work-center-message-draft-attachments'))
      .toContainText('replacement-note.txt');
    const retryAttemptPromise = mockAgent.__workCenterTransport.next();
    await conversation.locator('.send-btn').click();
    const retryAttempt = await retryAttemptPromise;
    expect(retryAttempt.op).toBe('post_work_item_message');
    expect(retryAttempt.payload).toMatchObject({
      id: OPEN_ITEM.id,
      clientMessageId: expiredClientMessageId,
      text: 'Recover this request after its staged attachment expires',
      target: { kind: 'coordinator' },
      revision: 1,
      planRevision: 2,
      ledgerRevision: 4,
      coordinatorRevision: 0,
    });
    expect(retryAttempt.payload.attachments[0].fileId).not.toBe(expiredFileId);
    expect(retryAttempt.payload.attachments[0].name).toBe('replacement-note.txt');
    await mockAgent.__workCenterTransport.resolve(retryAttempt, {
      accepted: true, turnId: 'turn-replaced-attachment',
    });
    await expect(pendingActions).toHaveCount(0);
    await expect(workItemComposer).toBeEnabled();
    await expect(workItemComposer).toHaveValue('');

    await workItemComposer.fill('Discard this pending request but keep the editable text');
    const discardAttemptPromise = mockAgent.__workCenterTransport.next();
    await conversation.locator('.send-btn').click();
    const discardAttempt = await discardAttemptPromise;
    expect(discardAttempt.payload.clientMessageId).not.toBe(expiredClientMessageId);
    await mockAgent.__workCenterTransport.reject(discardAttempt, 'Response was lost');
    await expect(pendingActions).toBeVisible();
    await pendingActions.getByRole('button', { name: 'Discard pending request' }).click();
    await expect(pendingActions).toHaveCount(0);
    await expect(workItemComposer).toBeEnabled();
    await expect(workItemComposer)
      .toHaveValue('Discard this pending request but keep the editable text');
    await workItemComposer.fill('Discarded request is editable again');
    await expect(workItemComposer).toHaveValue('Discarded request is editable again');
    await workItemComposer.fill('');

    await chatPage.getByRole('button', { name: /^\d+ Actions$/ }).click();
    await action.locator('.work-center-action-summary').click();
    const actionDetail = chatPage.locator('.work-center-action-detail-pane');
    await expect(actionDetail.locator('.work-center-action-message')).toContainText('Updated the existing layout styles');
    await expect(actionDetail.locator('textarea')).toHaveCount(0);
    await expect(chatPage.locator('.work-center-detail textarea')).toHaveCount(1);
    await expect(target).toHaveValue('coordinator');
    await expect(chatPage).toHaveURL(new RegExp(`workItemId=${OPEN_ITEM.id}.*workContent=action-list%2Faction%3Aaction-1`));
    await expect(actionDetail.getByRole('tab')).toHaveCount(2);
    await expect(actionDetail.getByRole('tab', { name: 'Task context' })).toHaveCount(0);
    await actionDetail.locator('.work-center-action-brief-disclosure summary').click();
    await expect(actionDetail.locator('.work-center-action-context-list')).toContainText('How to do it');
    await expect(actionDetail.locator('.work-center-action-context-list')).toContainText('Expected result');

    mockAgent.send({
      type: 'work_center_event',
      event: {
        type: 'run.progress',
        workItem: {
          ...OPEN_ITEM,
          revision: 1,
          currentActionId: 'action-1',
          updatedAt: Number(OPEN_ITEM.updatedAt) + 1,
          actionStats: [{
            id: 'action-1', status: 'running', progressRevision: 5,
            executionStats: OPEN_ITEM_DETAIL.actions[0].executionStats,
            liveMessage: {
              id: 'run:run-live', role: 'assistant', kind: 'response', status: 'running',
              text: 'Live AI response from the active Run.', attachments: [],
              createdAt: Date.now(), updatedAt: Date.now(), progressRevision: 5,
            },
          }],
        },
      },
    });
    await expect(actionDetail.locator('.work-center-action-message', { hasText: 'Live AI response from the active Run.' })).toHaveCount(1);

    await actionDetail.getByRole('button', { name: 'Send to this Action' }).click();
    await expect(target).toHaveValue('action:action-1:1');
    await expect(workItemComposer).toBeFocused();
    await workItemComposer.fill('Keep the current implementation\nand verify the narrow layout');
    const actionInputResponse = (async () => {
      const operations = [];
      while (!operations.some(request => request.op === 'post_work_item_message')
        || !operations.some(request => request.op === 'list')) {
        operations.push(await respondByOperation(mockAgent, {
          post_work_item_message: {
            ...OPEN_ITEM_DETAIL,
            actions: [{ ...OPEN_ITEM_DETAIL.actions[0], status: 'running' }],
          },
          list: { items: [OPEN_ITEM, GENERATION_ITEM], watcher: { enabled: true } },
          get: OPEN_ITEM_DETAIL,
        }));
      }
      return operations;
    })();
    await conversation.getByRole('button', { name: /Send to/ }).click();
    const actionInputOps = await actionInputResponse;
    const actionInputRequest = actionInputOps.find(request => request.op === 'post_work_item_message');
    expect(actionInputRequest.payload).toMatchObject({
      id: OPEN_ITEM.id,
      target: { kind: 'action', actionId: 'action-1', generation: 1 },
      revision: 1,
      text: 'Keep the current implementation\nand verify the narrow layout',
    });
    await expect(workItemComposer).toHaveValue('');
    await expect(actionDetail).toHaveCount(0);
    await chatPage.getByRole('button', { name: /^\d+ Actions$/ }).click();
    await chatPage.locator('.work-center-action-summary').click();
    await expect(actionDetail).toContainText('Live AI response from the active Run.');

    mockAgent.send({
      type: 'work_center_event',
      event: {
        type: 'run.finished',
        workItem: {
          ...OPEN_ITEM,
          revision: 2,
          status: 'done',
          currentActionId: null,
          currentAction: null,
          updatedAt: Number(OPEN_ITEM.updatedAt) + 2,
          actionStats: [{
            id: 'action-1', generation: 1, status: 'completed', progressRevision: 6,
            executionStats: OPEN_ITEM_DETAIL.actions[0].executionStats,
            response: 'FINAL REPLY',
            liveMessage: {
              id: 'run:run-live', runId: 'run-live', role: 'assistant', kind: 'response',
              status: 'completed', text: 'FINAL REPLY', attachments: [],
              generation: 1, attempt: 1,
              createdAt: Date.now(), updatedAt: Date.now(), progressRevision: 6,
            },
          }],
        },
      },
    });
    await expect(actionDetail.locator('.work-center-action-message', { hasText: 'FINAL REPLY' })).toHaveCount(1);
    await expect(actionDetail.locator('.work-center-action-message', { hasText: 'Live AI response from the active Run.' })).toHaveCount(0);

    const terminalDetail = {
      ...OPEN_ITEM_DETAIL,
      revision: 2,
      status: 'done',
      currentActionId: null,
      currentAction: null,
      updatedAt: Number(OPEN_ITEM.updatedAt) + 2,
      actions: [{
        ...OPEN_ITEM_DETAIL.actions[0],
        status: 'completed',
        progressRevision: 6,
        response: 'FINAL REPLY',
        messages: [{
          id: 'run:run-live', runId: 'run-live', role: 'assistant', kind: 'response',
          status: 'completed', text: 'FINAL REPLY', attachments: [],
          generation: 1, attempt: 1,
          createdAt: Date.now(), updatedAt: Date.now(), progressRevision: 6,
        }],
        liveMessage: {
          id: 'run:run-live', runId: 'run-live', role: 'assistant', kind: 'response',
          status: 'completed', text: 'FINAL REPLY', attachments: [],
          generation: 1, attempt: 1,
          createdAt: Date.now(), updatedAt: Date.now(), progressRevision: 6,
        },
      }],
    };
    const terminalPage = {
      actionId: 'action-1', generation: 1,
      messages: terminalDetail.actions[0].messages,
      nextCursor: null,
      total: 1,
    };
    const terminalRequestOps = [
      (await respondByOperation(mockAgent, {
        get: terminalDetail,
        get_action_messages: terminalPage,
        list: { items: [terminalDetail, GENERATION_ITEM], watcher: { enabled: true } },
      })).op,
      (await respondByOperation(mockAgent, {
        get: terminalDetail,
        get_action_messages: terminalPage,
        list: { items: [terminalDetail, GENERATION_ITEM], watcher: { enabled: true } },
      })).op,
    ];
    await expect(actionDetail.locator('.work-center-action-message', { hasText: 'FINAL REPLY' })).toHaveCount(1);
    await expect(actionDetail.locator('.work-center-action-message', { hasText: 'Live AI response from the active Run.' })).toHaveCount(0);
    const readFinalState = () => chatPage.evaluate(() => {
      const store = window.Pinia.useChatStore();
      const agentId = store.workCenterAgentId;
      const detail = store.workCenterDetailByAgent[agentId];
      const action = detail.actions.find(candidate => candidate.id === 'action-1');
      const key = `${agentId}:${detail.id}:action-1:1`;
      return {
        status: detail.status,
        currentActionId: detail.currentActionId,
        messages: action.messages.map(message => message.text),
        cachedMessages: (store.workCenterActionMessages[key]?.messages || []).map(message => message.text),
        nextCursor: store.workCenterActionMessages[key]?.nextCursor,
      };
    });
    expect(terminalRequestOps.sort()).toEqual(['get', 'get_action_messages']);
    await expect.poll(readFinalState).toEqual({
      status: 'done',
      currentActionId: null,
      messages: ['FINAL REPLY'],
      cachedMessages: ['FINAL REPLY'],
      nextCursor: null,
    });

    await chatPage.locator('.work-center-detail-close').click();
    const openFailed = chatPage.locator('.work-center-card', { hasText: GENERATION_ITEM.title }).click();
    await respondToWorkCenterOp(mockAgent, 'get', GENERATION_ITEM_DETAIL, [OPEN_ITEM, GENERATION_ITEM]);
    await openFailed;
    const failedConversation = chatPage.locator('.work-center-conversation');
    const failedTarget = failedConversation.getByTestId('work-center-composer-target');
    const failedComposer = failedConversation.locator('textarea');
    await chatPage.getByRole('button', { name: /^\d+ Actions$/ }).click();
    await chatPage.locator('.work-center-action-summary').click();
    await chatPage.locator('.work-center-action-detail-pane')
      .getByRole('button', { name: 'Send to this Action' }).click();
    await expect(failedTarget).toHaveValue('action:action-generation:1');
    await failedComposer.fill('Keep this draft bound to Action generation one.');
    await chatPage.locator('.work-center-detail-close').click();
    const reopenDone = chatPage.locator('.work-center-card', { hasText: OPEN_ITEM.title }).click();
    await respondToWorkCenterOp(mockAgent, 'get', terminalDetail, [OPEN_ITEM, GENERATION_ITEM]);
    await reopenDone;
    mockAgent.send({
      type: 'work_center_event',
      event: {
        type: 'action.retried',
        actionId: 'action-generation',
        workItem: {
          ...GENERATION_ITEM,
          revision: 2,
          currentActionId: 'action-generation',
          updatedAt: Number(GENERATION_ITEM.updatedAt) + 1,
          actionStats: [{ ...GENERATION_ITEM_DETAIL.actions[0], generation: 2, status: 'ready' }],
        },
      },
    });
    await chatPage.locator('.work-center-detail-close').click();
    const generationTwoFailedDetail = {
      ...GENERATION_ITEM_DETAIL,
      revision: 2,
      actions: [{ ...GENERATION_ITEM_DETAIL.actions[0], generation: 2, status: 'ready' }],
    };
    const returnToFailed = chatPage.locator('.work-center-card', { hasText: GENERATION_ITEM.title }).click();
    await respondUntilOperation(mockAgent, 'get', {
      get: generationTwoFailedDetail,
      get_action_messages: {
        actionId: 'action-generation', generation: 2, messages: [], nextCursor: null, total: 0,
      },
    });
    await returnToFailed;
    await expect(failedTarget).toHaveValue('action:action-generation:1');
    await expect(chatPage.locator('.work-center-stale-target')).toBeVisible();
    await expect(failedComposer).toHaveValue('Keep this draft bound to Action generation one.');
    await expect(failedConversation.locator('.send-btn')).toBeDisabled();
    await failedTarget.selectOption('action:action-generation:2');
    await expect(chatPage.locator('.work-center-stale-target')).toHaveCount(0);
    await expect(failedConversation.locator('.send-btn')).toBeEnabled();
    const confirmedGenerationResponse = (async () => {
      const operations = [];
      while (!operations.some(request => request.op === 'post_work_item_message')
        || !operations.some(request => request.op === 'list')) {
        operations.push(await respondByOperation(mockAgent, {
          post_work_item_message: {
            ...generationTwoFailedDetail,
            revision: 3,
            actions: [{ ...GENERATION_ITEM_DETAIL.actions[0], generation: 3, status: 'ready' }],
          },
          list: { items: [OPEN_ITEM, { ...GENERATION_ITEM, revision: 3 }], watcher: { enabled: true } },
          get: generationTwoFailedDetail,
        }));
      }
      return operations;
    })();
    await failedConversation.locator('.send-btn').click();
    const confirmedGenerationOps = await confirmedGenerationResponse;
    expect(confirmedGenerationOps.find(request => request.op === 'post_work_item_message').payload)
      .toMatchObject({
        id: GENERATION_ITEM.id,
        target: { kind: 'action', actionId: 'action-generation', generation: 2 },
        text: 'Keep this draft bound to Action generation one.',
      });
  });

  test('restores the Work Item and top ContentRef from the URL and browser back', async ({ chatPage, mockAgent }) => {
    await openWorkCenter(chatPage, mockAgent);
    const select = chatPage.locator('.work-center-card').click();
    await respondToWorkCenterOp(mockAgent, 'get', OPEN_ITEM_DETAIL);
    await select;
    await chatPage.getByRole('button', { name: /^\d+ Actions$/ }).click();
    await chatPage.locator('.work-center-action-summary').click();

    await expect(chatPage).toHaveURL(new RegExp(`workItemId=${OPEN_ITEM.id}.*workContent=action-list%2Faction%3Aaction-1`));
    await expect(chatPage.locator('.work-center-action-detail-pane')).toBeVisible();

    await chatPage.reload();
    await chatPage.waitForSelector('.chat-page');
    workCenterTransports.delete(chatPage);
    mockAgent.__workCenterTransport = null;
    const restoredTransport = await installWorkCenterTransport(chatPage);
    mockAgent.__workCenterTransport = restoredTransport;
    await chatPage.evaluate(({ agentId, item, settings }) => {
      const store = window.Pinia.useChatStore();
      store.workCenterAgentId = agentId;
      store.workCenterOpen = false;
      store.workCenterItemsByAgent[agentId] = [item];
      store.workCenterLoadedByAgent[agentId] = true;
      store.workCenterLoadingByAgent[agentId] = false;
      store.workCenterSettingsByAgent[agentId] = settings;
      store.workCenterRuntimeByAgent[agentId] = settings.runtime;
    }, { agentId: mockAgent.agentId, item: OPEN_ITEM, settings: WORK_CENTER_SETTINGS });
    const getResponse = respondToWorkCenterOp(mockAgent, 'get', OPEN_ITEM_DETAIL);
    await chatPage.evaluate(() => {
      const store = window.Pinia.useChatStore();
      store.workCenterOpen = true;
    });
    await getResponse;
    await expect(chatPage.locator('.work-center-detail')).toBeVisible();
    await expect(chatPage.locator('.work-center-action-detail-pane')).toBeVisible();
    await expect(chatPage.getByTestId('work-center-composer-target')).toHaveValue('coordinator');

    await chatPage.goBack();
    await expect(chatPage).toHaveURL(new RegExp(`workItemId=${OPEN_ITEM.id}.*workContent=action-list`));
    await expect(chatPage.locator('.work-center-action-list')).toBeVisible();
    await expect(chatPage.locator('.work-center-action-detail-pane')).toHaveCount(0);
    await expect(chatPage.getByTestId('work-center-composer-target')).toHaveValue('coordinator');

    await chatPage.goBack();
    await expect(chatPage).toHaveURL(new RegExp(`workItemId=${OPEN_ITEM.id}(?!.*workContent=)`));
    await expect(chatPage.locator('.work-center-content-pane')).toHaveCount(0);
    await expect(chatPage.locator('.work-center-conversation')).toBeVisible();
  });

  test('loads one retained conversation when an earlier Action is selected', async ({ chatPage, mockAgent }) => {
    const detail = detailWithActions(2);
    delete detail.actions[0].messages;
    delete detail.actions[0].response;
    detail.actions[0].brief = { ...detail.actions[0].brief, objective: 'Earlier Action' };
    detail.actions[0].messageCount = 3;
    detail.actions[0].messageCursor = '1';
    detail.actions[0].thread = [{
      generation: 1,
      canonical: false,
      messages: [{
        id: 'run:first-execution', role: 'assistant', kind: 'response', status: 'failed',
        text: 'First execution failed.', attachments: [],
        createdAt: Date.now() - 3, updatedAt: Date.now() - 3, progressRevision: 1,
      }],
    }];
    await openWorkCenter(chatPage, mockAgent);
    const select = chatPage.locator('.work-center-card').click();
    await respondToWorkCenterOp(mockAgent, 'get', detail);
    await select;
    await chatPage.getByRole('button', { name: /^\d+ Actions$/ }).click();

    const messagesResponse = respondToWorkCenterOp(mockAgent, 'get_action_messages', {
      actionId: detail.actions[0].id,
      generation: detail.actions[0].generation,
      messages: [
        {
          id: 'event:retry-input', role: 'user', kind: 'input', status: 'sent',
          text: 'Retry with the corrected constraint.', attachments: [],
          createdAt: Date.now() - 2, updatedAt: Date.now() - 2,
        },
        {
          id: 'run:second-execution', role: 'assistant', kind: 'response', status: 'completed',
          text: 'Second execution completed.', attachments: [],
          createdAt: Date.now() - 1, updatedAt: Date.now() - 1, progressRevision: 2,
        },
      ],
      nextCursor: null,
      total: 2,
    });
    await chatPage.locator('.work-center-action-card', { hasText: 'Earlier Action' }).click();
    const request = await messagesResponse;

    expect(request.payload).toEqual({
      id: OPEN_ITEM.id, actionId: detail.actions[0].id,
      generation: 1, cursor: null, limit: 20,
    });
    const messages = chatPage.locator('.work-center-action-message');
    await expect(messages).toHaveCount(3);
    await expect(messages.nth(0)).toContainText('First execution failed.');
    await expect(messages.nth(1)).toContainText('Retry with the corrected constraint.');
    await expect(messages.nth(2)).toContainText('Second execution completed.');
    await expect(chatPage.locator('.work-center-action-generation')).toHaveCount(0);
    await expect(chatPage.getByText('Previous execution')).toHaveCount(0);
  });

  test('explains Action recovery states and exposes the waiting question', async ({ chatPage, mockAgent }) => {
    const items = [FAILED_ITEM, WAITING_ITEM];
    await openWorkCenter(chatPage, mockAgent, items);
    const selectFailure = chatPage.locator('.work-center-card', { hasText: FAILED_ITEM.title }).click();
    await respondToWorkCenterOp(mockAgent, 'get', FAILED_ITEM_DETAIL, items);
    await selectFailure;
    await chatPage.getByRole('button', { name: /^\d+ Actions$/ }).click();
    await chatPage.locator('.work-center-action-summary').click();

    let actionDetail = chatPage.locator('.work-center-action-detail-pane');
    await expect(actionDetail.locator('.work-center-action-failure')).toContainText('Why this Action failed');
    await expect(actionDetail.locator('.work-center-action-failure')).toContainText('unsafe patch');
    await expect(actionDetail.locator('.work-center-action-failure')).toContainText('All unverified changes were reverted');
    await expect(actionDetail.locator('.work-center-action-failure')).toContainText('Target this Action in the Conversation composer');
    await expect(actionDetail.locator('textarea')).toHaveCount(0);

    await actionDetail.getByRole('button', { name: 'Close Actions' }).click();
    await chatPage.locator('.work-center-detail-close').click();
    const selectWaiting = chatPage.locator('.work-center-card', { hasText: WAITING_ITEM.title }).click();
    await respondToWorkCenterOp(mockAgent, 'get', WAITING_ITEM_DETAIL, items);
    await selectWaiting;
    await chatPage.getByRole('button', { name: /^\d+ Actions$/ }).click();
    await chatPage.locator('.work-center-action-summary').click();

    actionDetail = chatPage.locator('.work-center-action-detail-pane');
    const waitingQuestion = actionDetail.locator('#work-center-action-waiting-question');
    await expect(waitingQuestion).toContainText('Input required');
    await expect(waitingQuestion).toContainText('Choose PostgreSQL or SQLite before the migration continues.');
    const conversation = chatPage.locator('.work-center-conversation');
    await expect(conversation.locator('.work-center-item-message-list article.role-assistant header strong'))
      .toHaveText('Omni · Coordinator');
    await expect(actionDetail.locator('.work-center-action-message header strong'))
      .toHaveText('Linus · Action 1');
    const composer = conversation.locator('textarea');
    const target = conversation.getByTestId('work-center-composer-target');
    await expect(actionDetail.locator('textarea')).toHaveCount(0);
    await expect(target).toHaveValue('coordinator');
    await actionDetail.getByRole('button', { name: 'Send to this Action' }).click();
    await expect(target).toHaveValue('action:action-1:1');
    await expect(composer).toHaveAttribute('placeholder', 'Message Make the Work Center layout responsive from the Conversation composer');

    await composer.fill('Use PostgreSQL and explain the migration tradeoff.');
    const continuedDetail = {
      ...WAITING_ITEM_DETAIL,
      status: 'ready',
      revision: 2,
      currentAction: { ...WAITING_ITEM.currentAction, generation: 2, status: 'ready' },
      actions: [{ ...WAITING_ITEM_DETAIL.actions[0], generation: 2, status: 'ready' }],
    };
    const actionInputResponse = (async () => {
      const operations = [];
      while (!operations.some(request => request.op === 'post_work_item_message')
        || !operations.some(request => request.op === 'list')) {
        operations.push(await respondByOperation(mockAgent, {
          post_work_item_message: continuedDetail,
          list: { items: [{ ...WAITING_ITEM, status: 'ready' }], watcher: { enabled: true } },
          get: continuedDetail,
        }));
      }
      return operations;
    })();
    await conversation.getByRole('button', { name: /Send to/ }).click();
    const operations = await actionInputResponse;
    expect(operations.find(request => request.op === 'post_work_item_message').payload).toMatchObject({
      id: WAITING_ITEM.id,
      target: { kind: 'action', actionId: 'action-1', generation: 1 },
      revision: 1,
      text: 'Use PostgreSQL and explain the migration tradeoff.',
    });
  });

  test('uses compact stop controls and resumes a stopped Work Item', async ({ chatPage, mockAgent }) => {
    await openWorkCenter(chatPage, mockAgent, [OPEN_ITEM, CANCELLED_ITEM]);
    const selectOpen = chatPage.locator('.work-center-card', { hasText: OPEN_ITEM.title }).click();
    await respondToWorkCenterOp(mockAgent, 'get', OPEN_ITEM_DETAIL, [OPEN_ITEM, CANCELLED_ITEM]);
    await selectOpen;

    const stop = chatPage.getByRole('button', { name: 'Stop work item' });
    await expect(stop).toBeVisible();
    await expect(chatPage.locator('.work-center-danger-zone')).toHaveCount(0);
    const stopBounds = await stop.evaluate(element => {
      const button = element.getBoundingClientRect();
      const heading = element.closest('.work-center-detail-heading');
      const title = heading?.querySelector('h2')?.getBoundingClientRect();
      return {
        height: button.height,
        insideHeading: !!heading,
        afterTitle: !!title && button.left >= title.right,
      };
    });
    expect(stopBounds.height).toBeLessThanOrEqual(36);
    expect(stopBounds.insideHeading).toBe(true);
    expect(stopBounds.afterTitle).toBe(true);
    await expect(chatPage.locator('.work-center-detail-controls')).toHaveCount(0);

    await chatPage.setViewportSize({ width: 430, height: 900 });
    const compactBounds = await stop.evaluate(element => {
      const button = element.getBoundingClientRect();
      const heading = element.closest('.work-center-detail-heading')?.getBoundingClientRect();
      const back = element.closest('.work-center-detail')
        ?.querySelector('.work-center-detail-close')?.getBoundingClientRect();
      return {
        insideHeading: !!heading && button.left >= heading.left && button.right <= heading.right,
        clearOfBack: !back || button.left >= back.right || button.bottom <= back.top,
      };
    });
    expect(compactBounds.insideHeading).toBe(true);
    expect(compactBounds.clearOfBack).toBe(true);

    await chatPage.evaluate(() => {
      document.documentElement.setAttribute('data-theme', 'dark');
      localStorage.setItem('theme', 'dark');
    });
    await expect(chatPage.locator('html')).toHaveAttribute('data-theme', 'dark');
    await expect(stop).toBeVisible();
    const stopColors = await stop.evaluate(element => {
      const probe = document.createElement('span');
      probe.style.color = 'var(--error)';
      document.body.appendChild(probe);
      const expected = getComputedStyle(probe).color;
      probe.remove();
      return { actual: getComputedStyle(element).color, expected };
    });
    expect(stopColors.actual).toBe(stopColors.expected);

    chatPage.once('dialog', dialog => dialog.accept());
    const cancelResponses = (async () => {
      const operations = [];
      while (!operations.some(request => request.op === 'cancel')
        || !operations.some(request => request.op === 'list')) {
        operations.push(await respondByOperation(mockAgent, {
          cancel: CANCELLED_ITEM_DETAIL,
          list: { items: [CANCELLED_ITEM], watcher: { enabled: true } },
          get: CANCELLED_ITEM_DETAIL,
        }));
      }
      return operations;
    })();
    await stop.click();
    const cancelOps = await cancelResponses;
    expect(cancelOps.some(request => request.op === 'list')).toBe(true);
    expect(cancelOps.find(request => request.op === 'cancel').payload).toEqual({ id: OPEN_ITEM.id });
    await expect(chatPage.getByText('Work item details')).toBeVisible();

    const selectCancelled = chatPage.locator('.work-center-card', { hasText: CANCELLED_ITEM.title })
      .locator('.work-center-card-open').dispatchEvent('click');
    await respondToWorkCenterOp(mockAgent, 'get', CANCELLED_ITEM_DETAIL, [CANCELLED_ITEM]);
    await selectCancelled;
    const resume = chatPage.getByRole('button', { name: 'Resume work item' });
    await expect(resume).toBeVisible();
    const resumedDetail = {
      ...OPEN_ITEM_DETAIL,
      id: CANCELLED_ITEM.id,
      title: CANCELLED_ITEM.title,
      status: 'ready',
      revision: CANCELLED_ITEM_DETAIL.revision,
      actions: [{ ...OPEN_ITEM_DETAIL.actions[0], id: 'action-cancelled', status: 'ready', generation: 2 }],
      currentActionId: 'action-cancelled',
    };
    const resumeResponses = (async () => {
      const operations = [];
      while (!operations.some(request => request.op === 'resume')
        || !operations.some(request => request.op === 'list')) {
        operations.push(await respondByOperation(mockAgent, {
          resume: resumedDetail,
          list: { items: [resumedDetail], watcher: { enabled: true } },
          get: resumedDetail,
        }));
      }
      return operations;
    })();
    await resume.click();
    const resumeOps = await resumeResponses;
    expect(resumeOps.some(request => request.op === 'list')).toBe(true);
    expect(resumeOps.find(request => request.op === 'resume').payload).toEqual({
      id: CANCELLED_ITEM.id,
      revision: CANCELLED_ITEM_DETAIL.revision,
    });
  });

  test('keeps done and cancelled Work Items read-only without sending message wire', async ({ chatPage, mockAgent }) => {
    const closedItems = [DONE_ITEM, CANCELLED_ITEM];
    const closedDetails = new Map([
      [DONE_ITEM.id, DONE_ITEM_DETAIL],
      [CANCELLED_ITEM.id, CANCELLED_ITEM_DETAIL],
    ]);
    await openWorkCenter(chatPage, mockAgent, closedItems);

    for (const item of closedItems) {
      const select = chatPage.locator('.work-center-card', { hasText: item.title })
        .locator('.work-center-card-open').click();
      await respondToWorkCenterOp(mockAgent, 'get', closedDetails.get(item.id), closedItems);
      await select;

      const conversation = chatPage.locator('.work-center-conversation');
      await expect(conversation).toContainText(item.status === 'done'
        ? 'Yeaft confirmed every acceptance criterion.'
        : 'Yeaft recorded the cancellation.');
      await expect(conversation.locator('article.role-assistant header strong')).toHaveText('Coordinator');
      await expect(conversation.locator('.work-center-conversation-readonly')).toBeVisible();
      await expect(conversation.locator('.work-center-item-message-input')).toHaveCount(0);
      await expect(conversation.locator('textarea')).toHaveCount(0);

      await chatPage.getByRole('button', { name: /^\d+ Actions$/ }).click();
      await chatPage.locator('.work-center-action-summary').click();
      const actionDetail = chatPage.locator('.work-center-action-detail-pane');
      await expect(actionDetail).toContainText(item.status === 'done'
        ? 'Verified and released the layout fix.'
        : 'Execution stopped without publishing changes.');
      await expect(actionDetail.locator('.work-center-action-message header strong')).toHaveText('Action 1');
      await expect(actionDetail.locator('.work-center-action-composer')).toHaveCount(0);
      await expect(actionDetail.locator('textarea')).toHaveCount(0);

      await actionDetail.getByRole('button', { name: 'Back to Actions' }).click();
      await chatPage.locator('.work-center-detail-close').click();
      await expect(chatPage.locator('.work-center-list')).toBeVisible();
    }

    const blockedOps = new Set(['post_work_item_message', 'retry_action', 'guide']);
    expect(workCenterRequestOps(mockAgent).filter(op => blockedOps.has(op))).toEqual([]);
  });

  test('loads retained tool evidence only when the Execution view is opened', async ({ chatPage, mockAgent }) => {
    await openWorkCenter(chatPage, mockAgent);
    const select = chatPage.locator('.work-center-card').click();
    await respondToWorkCenterOp(mockAgent, 'get', OPEN_ITEM_DETAIL);
    await select;

    await chatPage.getByRole('button', { name: /^\d+ Actions$/ }).click();
    await chatPage.locator('.work-center-action-summary').click();
    const actionDetail = chatPage.locator('.work-center-action-detail-pane');
    await expect(actionDetail.locator('.work-center-action-transcript')).toBeVisible();
    await expect(actionDetail.locator('.work-center-action-execution')).toBeHidden();

    const indexResponse = respondToWorkCenterOp(mockAgent, 'get_action_requests', ACTION_REQUEST_INDEX);
    await actionDetail.getByRole('tab', { name: 'Execution', exact: true }).click();
    const execution = actionDetail.locator('.work-center-action-execution');
    await expect(execution).toBeVisible();
    const indexRequest = await indexResponse;
    expect(indexRequest.payload).toEqual({ id: OPEN_ITEM.id, actionId: 'action-1', generation: 1 });

    const detailResponse = respondToWorkCenterOp(mockAgent, 'get_action_request', ACTION_REQUEST_DETAIL);
    const detailRequest = await detailResponse;
    expect(detailRequest.payload).toEqual({
      id: OPEN_ITEM.id, actionId: 'action-1', generation: 1,
      runId: 'run-1', requestId: 'request-1',
    });
    const card = execution.locator('.work-center-request-card');
    await expect(card).toHaveClass(/expanded/);
    await expect(card).toContainText('provider/primary');
    await expect(card).toContainText('1.5k tok');
    await expect(card.locator('.work-center-request-loop')).toContainText('1 tools');
    const tool = card.locator('.work-center-request-tool');
    await expect(tool).toContainText('FileRead');
    await expect(tool).toHaveAttribute('data-status', 'completed');
    await tool.locator('summary').click();
    await expect(tool).toContainText('Parameters');
    await expect(tool).toContainText('web/styles/work-center.css');
    await expect(tool).toContainText('Result');
    await expect(tool).toContainText('css');
    await expect(card).not.toContainText('System prompt');
    await expect(card).not.toContainText('Raw request');

    const generationTwoDetail = structuredClone(OPEN_ITEM_DETAIL);
    generationTwoDetail.revision = 2;
    generationTwoDetail.updatedAt = Number(OPEN_ITEM.updatedAt) + 10;
    generationTwoDetail.actions[0] = {
      ...generationTwoDetail.actions[0],
      generation: 2,
      attempt: 0,
      status: 'ready',
      progressRevision: 0,
      messages: [],
      response: '',
    };
    const generationTwoPage = {
      actionId: 'action-1', generation: 2, messages: [], nextCursor: null, total: 0,
    };
    mockAgent.send({
      type: 'work_center_event',
      event: {
        type: 'action.retried',
        workItem: {
          ...OPEN_ITEM,
          revision: 2,
          updatedAt: generationTwoDetail.updatedAt,
          currentActionId: 'action-1',
          currentAction: { id: 'action-1', generation: 2, status: 'ready' },
          actionStats: [{
            id: 'action-1', generation: 2, attempt: 0, status: 'ready', progressRevision: 0,
            executionStats: OPEN_ITEM_DETAIL.actions[0].executionStats,
          }],
        },
      },
    });
    const rolloverOps = [
      (await respondByOperation(mockAgent, { get: generationTwoDetail, get_action_messages: generationTwoPage })).op,
      (await respondByOperation(mockAgent, { get: generationTwoDetail, get_action_messages: generationTwoPage })).op,
    ];
    expect(rolloverOps.sort()).toEqual(['get', 'get_action_messages']);
    await expect(actionDetail.locator('.work-center-action-transcript')).toBeVisible();

    const generationTwoRequests = {
      actionId: 'action-1',
      generation: 2,
      requests: [
        { ...ACTION_REQUEST_INDEX.requests[0], id: 'request-g1-late', runId: 'run-g1-late', generation: 1, attempt: 9, model: 'model-g1', openedAt: Date.now() + 30 },
        { ...ACTION_REQUEST_INDEX.requests[0], id: 'request-g2-a1', runId: 'run-g2-a1', generation: 2, attempt: 1, model: 'model-g2-attempt-1', openedAt: Date.now() + 20 },
        { ...ACTION_REQUEST_INDEX.requests[0], id: 'request-g2-a2', runId: 'run-g2-a2', generation: 2, attempt: 2, model: 'model-g2-attempt-2', openedAt: Date.now() + 10 },
      ],
    };
    const requestCacheBeforeGenerationTwo = await chatPage.evaluate(() => {
      const store = window.Pinia.useChatStore();
      const agentId = store.workCenterAgentId;
      const oldKey = `${agentId}:work-item-open:action-1:1`;
      const currentKey = `${agentId}:work-item-open:action-1:2`;
      return {
        oldIds: (store.workCenterActionRequests[oldKey] || []).map(request => request.id),
        currentIds: (store.workCenterActionRequests[currentKey] || []).map(request => request.id),
      };
    });
    expect(requestCacheBeforeGenerationTwo).toEqual({ oldIds: ['request-1'], currentIds: [] });
    const generationTwoIndexResponse = respondToWorkCenterOp(
      mockAgent, 'get_action_requests', generationTwoRequests,
    );
    await actionDetail.getByRole('tab', { name: 'Execution', exact: true }).click();
    expect((await generationTwoIndexResponse).payload).toEqual({
      id: OPEN_ITEM.id, actionId: 'action-1', generation: 2,
    });
    const latestGenerationTwoDetail = {
      ...ACTION_REQUEST_DETAIL,
      generation: 2,
      request: {
        ...ACTION_REQUEST_DETAIL.request,
        ...generationTwoRequests.requests[2],
        loops: ACTION_REQUEST_DETAIL.request.loops,
      },
    };
    const latestDetailResponse = respondToWorkCenterOp(
      mockAgent, 'get_action_request', latestGenerationTwoDetail,
    );
    const latestDetailRequest = await latestDetailResponse;
    expect(latestDetailRequest.payload).toMatchObject({
      generation: 2, runId: 'run-g2-a2', requestId: 'request-g2-a2',
    });
    const generationTwoCards = execution.locator('.work-center-request-card');
    await expect(generationTwoCards).toHaveCount(3);
    await expect(generationTwoCards.filter({ hasText: 'model-g2-attempt-2' })).toHaveClass(/expanded/);
    await expect(generationTwoCards.filter({ hasText: 'model-g1' })).not.toHaveClass(/expanded/);

    const manualCard = generationTwoCards.filter({ hasText: 'model-g2-attempt-1' });
    const manualDetailResponse = respondToWorkCenterOp(mockAgent, 'get_action_request', {
      ...ACTION_REQUEST_DETAIL,
      generation: 2,
      request: {
        ...ACTION_REQUEST_DETAIL.request,
        ...generationTwoRequests.requests[1],
        loops: ACTION_REQUEST_DETAIL.request.loops,
      },
    });
    await manualCard.locator('.work-center-request-summary').click();
    expect((await manualDetailResponse).payload).toMatchObject({
      generation: 2, runId: 'run-g2-a1', requestId: 'request-g2-a1',
    });
    await expect(manualCard).toHaveClass(/expanded/);

    const refreshedRequests = {
      ...generationTwoRequests,
      requests: [
        { ...ACTION_REQUEST_INDEX.requests[0], id: 'request-g2-a3', runId: 'run-g2-a3', generation: 2, attempt: 3, model: 'model-g2-attempt-3', openedAt: Date.now() + 40 },
        ...generationTwoRequests.requests,
      ],
    };
    const refreshResponse = respondToWorkCenterOp(mockAgent, 'get_action_requests', refreshedRequests);
    await execution.getByRole('button', { name: 'Refresh' }).click();
    expect((await refreshResponse).payload.generation).toBe(2);
    await expect(execution.locator('.work-center-request-card')).toHaveCount(4);
    await expect(execution.locator('.work-center-request-card', { hasText: 'model-g2-attempt-1' })).toHaveClass(/expanded/);
    await expect(execution.locator('.work-center-request-card', { hasText: 'model-g2-attempt-3' })).not.toHaveClass(/expanded/);
  });

  test('renders read-only Action content in both themes and preserves the Conversation draft on mobile', async ({ chatPage, mockAgent }) => {
    const detail = structuredClone(ACTION_OVERFLOW_DETAIL);
    await openWorkCenter(chatPage, mockAgent);
    const select = chatPage.locator('.work-center-card').click();
    await respondToWorkCenterOp(mockAgent, 'get', detail);
    await select;

    const workItem = chatPage.locator('.work-center-detail');
    const conversation = workItem.locator('.work-center-conversation');
    const composer = conversation.locator('textarea');
    await composer.fill('Preserve this draft while reviewing the Action');
    await chatPage.getByRole('button', { name: /^\d+ Actions$/ }).click();
    await chatPage.locator('.work-center-action-summary').click();

    const pane = chatPage.locator('.work-center-action-detail-pane');
    await expect(pane.locator('textarea')).toHaveCount(0);
    await expect(workItem.locator('textarea')).toHaveCount(1);
    await expect(pane.locator('.work-center-action-message')).toHaveCount(2);
    await expect(pane.locator('.work-center-action-waiting')).toBeVisible();
    await expect(pane).toContainText('Action overflow probe');
    await expect(pane).toContainText('Keep the correction small.');
    await expect(pane.locator('.work-center-attachment-chip')).toHaveCount(1);

    for (const theme of ['light', 'dark']) {
      await chatPage.evaluate(value => {
        document.documentElement.setAttribute('data-theme', value);
        localStorage.setItem('theme', value);
      }, theme);
      await expect(chatPage.locator('html')).toHaveAttribute('data-theme', theme);
      for (const width of [1200, 760, 390]) {
        await chatPage.setViewportSize({ width, height: 720 });
        await chatPage.waitForTimeout(250);
        const layout = await pane.evaluate(root => {
          const rect = root.getBoundingClientRect();
          const assistant = root.querySelector('.role-assistant');
          const user = root.querySelector('.role-user');
          return {
            left: rect.left,
            right: rect.right,
            width: rect.width,
            scrollWidth: root.scrollWidth,
            assistantText: getComputedStyle(assistant).color,
            userText: getComputedStyle(user).color,
            userBackground: getComputedStyle(user).backgroundColor,
          };
        });
        expect(layout.left).toBeGreaterThanOrEqual(0);
        expect(layout.right).toBeLessThanOrEqual(width + 1);
        expect(layout.scrollWidth).toBeLessThanOrEqual(layout.width + 1);
        await expectNoHorizontalOverflow(pane, {
          pane: ':scope',
          transcript: '.work-center-action-transcript',
          column: '.work-center-action-conversation-column',
          waiting: '.work-center-action-waiting',
          waitingText: '.work-center-action-waiting p',
          messageList: '.work-center-action-message-list',
          message: '.work-center-action-message',
          messageHeader: '.work-center-action-message header',
          speaker: '.work-center-action-message header strong',
          attachmentList: '.work-center-attachment-list',
          attachmentChip: '.work-center-attachment-chip',
        });
        expect(layout.userText).not.toBe(layout.userBackground);
        expect(layout.userBackground).not.toBe('rgba(0, 0, 0, 0)');
        expect(layout.assistantText).not.toBe(layout.userBackground);
        expect(await chatPage.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
      }
    }

    await chatPage.setViewportSize({ width: 390, height: 720 });
    await workItem.getByRole('button', { name: 'Close Actions' }).click();
    await expect(composer).toHaveValue('Preserve this draft while reviewing the Action');
    await expect(workItem.getByTestId('work-center-composer-target')).toHaveValue('coordinator');
  });

  test('keeps Work Item card controls transparent in light and dark themes', async ({ chatPage, mockAgent }) => {
    await openWorkCenter(chatPage, mockAgent, [FAILED_ITEM]);
    const card = chatPage.locator('.work-center-card');
    await expect(card.locator('.work-center-card-open')).toBeVisible();
    await expect(card.locator('.work-center-card-delete')).toBeEnabled();

    const themeColors = {};
    for (const theme of ['light', 'dark']) {
      await chatPage.evaluate(value => {
        document.documentElement.setAttribute('data-theme', value);
        localStorage.setItem('theme', value);
      }, theme);
      await expect(chatPage.locator('html')).toHaveAttribute('data-theme', theme);
      themeColors[theme] = await card.evaluate(element => {
        const open = element.querySelector('.work-center-card-open');
        const remove = element.querySelector('.work-center-card-delete');
        const cardStyle = getComputedStyle(element);
        const openStyle = getComputedStyle(open);
        const removeStyle = getComputedStyle(remove);
        return {
          cardBackground: cardStyle.backgroundColor,
          cardText: cardStyle.color,
          openBackground: openStyle.backgroundColor,
          openBorderWidth: openStyle.borderTopWidth,
          openText: openStyle.color,
          deleteBackground: removeStyle.backgroundColor,
          deleteBorderWidth: removeStyle.borderTopWidth,
        };
      });

      expect(themeColors[theme].cardBackground).not.toBe('rgba(0, 0, 0, 0)');
      expect(themeColors[theme].cardText).not.toBe(themeColors[theme].cardBackground);
      expect(themeColors[theme].openBackground).toBe('rgba(0, 0, 0, 0)');
      expect(themeColors[theme].openBorderWidth).toBe('0px');
      expect(themeColors[theme].openText).toBe(themeColors[theme].cardText);
      expect(themeColors[theme].deleteBackground).toBe('rgba(0, 0, 0, 0)');
      expect(themeColors[theme].deleteBorderWidth).toBe('0px');
    }

    expect(themeColors.dark.cardBackground).not.toBe(themeColors.light.cardBackground);
    expect(themeColors.dark.cardText).not.toBe(themeColors.light.cardText);
  });

  test('keeps read-only Action content visible without overflow in dark theme', async ({ chatPage, mockAgent }) => {
    await openWorkCenter(chatPage, mockAgent);
    const select = chatPage.locator('.work-center-card').click();
    await respondToWorkCenterOp(mockAgent, 'get', OPEN_ITEM_DETAIL);
    await select;
    await chatPage.getByRole('button', { name: /^\d+ Actions$/ }).click();
    await chatPage.locator('.work-center-action-summary').click();

    await chatPage.evaluate(() => {
      document.documentElement.setAttribute('data-theme', 'dark');
      localStorage.setItem('theme', 'dark');
    });
    await expect(chatPage.locator('html')).toHaveAttribute('data-theme', 'dark');
    const actionDetail = chatPage.locator('.work-center-action-detail-pane');
    await expect(actionDetail).toBeVisible();
    await expect(actionDetail.locator('textarea')).toHaveCount(0);
    await expect(chatPage.locator('.work-center-detail textarea')).toHaveCount(1);

    const metrics = await layoutMetrics(chatPage);
    expect(metrics.documentScrollWidth).toBeLessThanOrEqual(metrics.viewportWidth);
    expect(metrics.bodyScrollWidth).toBeLessThanOrEqual(metrics.bodyClientWidth + 1);
    const colors = await actionDetail.locator('.work-center-action-transcript').evaluate(element => {
      const style = getComputedStyle(element);
      return { background: style.backgroundColor, text: style.color };
    });
    expect(colors.text).not.toBe(colors.background);
  });

  test('shows delayed directory defaults before sending the create request', async ({ chatPage, mockAgent }) => {
    await installWorkCenterTransport(chatPage).then(transport => { mockAgent.__workCenterTransport = transport; });
    const settingsRequest = (async () => {
      for (;;) {
        const request = mockAgent.__workCenterTransport
          ? await mockAgent.__workCenterTransport.next()
          : await mockAgent.waitForMessage('work_center_request');
        if (request.op === 'get_settings') return request;
        if (request.op !== 'list') throw new Error(`Expected Work Center list or get_settings, received ${request.op}`);
        if (mockAgent.__workCenterTransport) {
          await mockAgent.__workCenterTransport.resolve(request, { items: [OPEN_ITEM], watcher: { enabled: true } });
        } else {
          mockAgent.send({
            type: 'work_center_response', requestId: request.requestId, op: request.op, ok: true,
            data: { items: [OPEN_ITEM], watcher: { enabled: true } },
          });
        }
      }
    })();

    await chatPage.locator('.sidebar-work-center-header-btn').click();
    const pendingSettings = await settingsRequest;
    await expect(chatPage.locator('.work-center-main')).toBeVisible();
    await chatPage.locator('.work-center-header-create').click();
    const createModal = chatPage.locator('.work-center-modal');
    const workDir = createModal.getByRole('textbox', { name: /Working directory/ });
    await expect(workDir).toHaveValue('');
    await expect(createModal.getByRole('button', { name: 'Create', exact: true })).toBeDisabled();

    if (mockAgent.__workCenterTransport) {
      await mockAgent.__workCenterTransport.resolve(pendingSettings, WORK_CENTER_SETTINGS);
    } else {
      mockAgent.send({
        type: 'work_center_response', requestId: pendingSettings.requestId, op: pendingSettings.op, ok: true,
        data: WORK_CENTER_SETTINGS,
      });
    }
    await expect(workDir).toHaveValue('/tmp/test');
    await createModal.getByRole('textbox', { name: /Requirement/ })
      .fill('Use the directory shown in the form');
    const createRequest = respondToWorkCenterOp(mockAgent, 'create', OPEN_ITEM_DETAIL);
    await createModal.getByRole('button', { name: 'Create', exact: true }).click();
    const request = await createRequest;
    await respondToWorkCenterOp(mockAgent, 'list', { items: [OPEN_ITEM], watcher: { enabled: true } });
    expect(request.payload.workDir).toBe('/tmp/test');
    expect(request.payload.workItemType).toBe('auto');
  });

  test('uses the Work Center design system for directory selection', async ({ chatPage, mockAgent }) => {
    await openWorkCenter(chatPage, mockAgent);
    await chatPage.locator('.work-center-header-create').click();
    const createModal = chatPage.locator('.work-center-modal');

    const directoryRequestPromise = mockAgent.waitForMessage('list_directory');
    await createModal.getByRole('button', { name: 'Choose folder' }).click();
    const directoryRequest = await directoryRequestPromise;
    mockAgent.send({
      type: 'directory_listing',
      conversationId: directoryRequest.conversationId,
      requestId: directoryRequest.requestId,
      dirPath: '/tmp/test',
      entries: [
        { name: 'project-alpha', type: 'directory' },
        { name: 'project-beta', type: 'directory' },
      ],
    });

    const picker = chatPage.locator('.work-center-directory-dialog');
    await expect(picker).toBeVisible();
    await expect(picker.getByText('Choose the project folder this Work Item can read and modify.')).toBeVisible();
    await expect(picker.locator('.work-center-directory-current')).toHaveText('/tmp/test');
    await expect(picker.getByRole('option')).toHaveCount(2);
    await expect(picker.locator('.tree-item')).toHaveCount(0);

    const firstFolder = picker.getByRole('option', { name: 'project-alpha' });
    await firstFolder.click();
    await expect(firstFolder).toHaveAttribute('aria-selected', 'true');
    const colors = await firstFolder.evaluate(element => {
      const style = getComputedStyle(element);
      return { background: style.backgroundColor, color: style.color };
    });
    expect(colors.background).not.toBe('rgba(0, 0, 0, 0)');
    expect(colors.background).not.toBe('rgb(255, 255, 255)');

    await picker.getByRole('button', { name: 'OK' }).click();
    await expect(createModal.getByRole('textbox', { name: /Working directory/ }))
      .toHaveValue('/tmp/test/project-alpha');
  });

  test('keeps a create action available on mobile with existing work items', async ({ chatPage, mockAgent }) => {
    await openWorkCenter(chatPage, mockAgent);
    await chatPage.setViewportSize({ width: 720, height: 900 });
    await chatPage.waitForTimeout(350);

    await chatPage.locator('.work-center-sidebar-toggle').click();
    await expect(chatPage.locator('.session-sidebar-shell')).not.toHaveClass(/collapsed/);
    await chatPage.locator('.session-sidebar-shell .sidebar-icon-btn[title="Collapse sidebar"]').click();
    await expect(chatPage.locator('.session-sidebar-shell')).toHaveClass(/collapsed/);

    const create = chatPage.locator('.work-center-header-create');
    await expect(create).toBeVisible();
    await expect(create).toHaveAttribute('aria-label', 'New work item');
    await create.click();
    const createModal = chatPage.locator('.work-center-modal');
    await expect(createModal).toBeVisible();
    await expect(createModal.getByRole('textbox', { name: /Working directory/ })).toHaveValue('/tmp/test');
  });

  test('saves Coordinator model policy through the real settings wire contract', async ({ chatPage, mockAgent }) => {
    await openWorkCenter(chatPage, mockAgent);
    await chatPage.setViewportSize({ width: 1280, height: 900 });

    const settingsRequest = respondUntilOperation(mockAgent, 'get_settings', {
      list: { items: [OPEN_ITEM], watcher: { enabled: true } },
      get_settings: WORK_CENTER_SETTINGS,
    });
    await chatPage.locator('.work-center-header-actions .work-center-icon-button').first().click();
    await settingsRequest;
    const modal = chatPage.locator('.work-center-settings-card');
    await expect(modal).toBeVisible();
    const box = await modal.boundingBox();
    expect(box.width).toBeGreaterThan(850);
    expect(box.height).toBeGreaterThan(650);

    await expect(chatPage.locator('.work-center-policy-stage')).toHaveCount(expectedActionPolicyCount());
    await expect(chatPage.locator('.work-center-global-policy textarea')).toHaveValue('Follow the Agent release policy for every Action.');
    await expect(chatPage.locator('.work-center-policy-stage textarea').nth(1)).toHaveValue('Plan the task');
    await chatPage.getByRole('button', { name: 'Models', exact: true }).click();
    const modelStages = chatPage.locator('.work-center-model-stage');
    await expect(modelStages).toHaveCount(expectedModelPolicyCount());
    const coordinatorStage = modelStages.nth(1);
    const modelStage = modelStages.last();
    await expect(modelStage).toContainText('Fallback for all Actions');
    const effort = modelStage.locator('.work-center-model-effort');
    await expect(effort).toContainText('Reasoning effort');
    await expect(effort.locator('select')).toHaveValue('high');
    await expect(effort.locator('select')).toBeEnabled();
    await expect(effort).toContainText('Overrides the selected model');

    await modelStage.locator('select').first().selectOption('inherit');
    await expect(effort).toBeVisible();
    await expect(effort.locator('select')).toBeEnabled();
    await expect(effort.locator('option')).toContainText(['Model default', 'medium', 'high']);
    await expect(effort).toContainText('Select the Agent primary model');
    await expect(modal.getByRole('button', { name: 'General', exact: true })).toHaveCount(0);

    await coordinatorStage.locator('select').first().selectOption('specific');
    await expect(coordinatorStage.locator('select')).toHaveCount(3);
    await coordinatorStage.locator('select').nth(1).selectOption('provider/review');
    await coordinatorStage.locator('.work-center-model-effort select').selectOption('medium');
    await expect(coordinatorStage.locator('select').first()).toHaveValue('specific');
    await expect(coordinatorStage.locator('select').nth(1)).toHaveValue('provider/review');
    await expect(coordinatorStage.locator('.work-center-model-effort select')).toHaveValue('medium');

    const saveResponse = respondUntilOperation(mockAgent, 'update_settings', {
      list: { items: [OPEN_ITEM], watcher: { enabled: true } },
      get_settings: WORK_CENTER_SETTINGS,
      update_settings: request => ({
        settings: { ...request.payload.settings, revision: 8 },
        runtime: WORK_CENTER_SETTINGS.runtime,
      }),
    });
    await modal.getByRole('button', { name: 'Save', exact: true }).click();
    const saveRequest = await saveResponse;
    expect(saveRequest.payload.settings).toMatchObject({ revision: 7 });
    expect(saveRequest.payload.settings.coordinatorModelPolicy)
      .toEqual(WORK_CENTER_SETTINGS.settings.coordinatorModelPolicy);
    await respondToWorkCenterOp(
      mockAgent, 'list', { items: [OPEN_ITEM], watcher: { enabled: true } }, [OPEN_ITEM],
    );
    await expect(modal).toBeHidden();
    expect(saveRequest.op).toBe('update_settings');
    await expect.poll(() => chatPage.evaluate(agentId => {
      const settings = window.Pinia.useChatStore().workCenterSettingsByAgent[agentId];
      return {
        revision: settings?.revision,
        coordinatorModelPolicy: settings?.coordinatorModelPolicy,
      };
    }, mockAgent.agentId)).toEqual({
      revision: 8,
      coordinatorModelPolicy: WORK_CENTER_SETTINGS.settings.coordinatorModelPolicy,
    });
  });

  test('opens settings returned by an older Agent without dynamic fields', async ({ chatPage, mockAgent }) => {
    await openWorkCenter(chatPage, mockAgent);
    const legacySettings = structuredClone(WORK_CENTER_SETTINGS);
    delete legacySettings.settings.actionInstructions;
    delete legacySettings.settings.modelPolicy;
    delete legacySettings.settings.coordinatorModelPolicy;
    delete legacySettings.settings.actionModelPolicies;
    legacySettings.settings.workflows[0].stages[0].instruction = 'Legacy triage prompt.';
    legacySettings.settings.workflows[0].stages[0].modelPolicy = {
      mode: 'specific', model: 'provider/review', effort: 'high',
    };
    legacySettings.runtime.defaultStageInstructions = {
      implement: 'Implement the task.',
      custom: 'Complete the Action.',
    };
    const settingsRequest = respondUntilOperation(mockAgent, 'get_settings', {
      list: { items: [OPEN_ITEM], watcher: { enabled: true } },
      get_settings: legacySettings,
    });

    await chatPage.locator('.work-center-header-actions .work-center-icon-button').first().click();
    await settingsRequest;

    const modal = chatPage.locator('.work-center-settings-card');
    await expect(modal).toBeVisible();
    await expect(modal.locator('.work-center-policy-stage')).toHaveCount(expectedActionPolicyCount());
    const triagePrompt = modal.locator('.work-center-policy-stage textarea').nth(1);
    await expect(triagePrompt).toHaveValue('Legacy triage prompt.');
    await expect(triagePrompt).toBeDisabled();
    await expect(modal.getByText(/cannot save Work Center settings/)).toBeVisible();
    await expect(modal.locator('.work-center-settings-footer .btn-primary')).toBeDisabled();
    await modal.getByRole('button', { name: 'Models', exact: true }).click();
    const globalModelStage = modal.locator('.work-center-model-stage').last();
    await expect(globalModelStage.locator('select').first()).toHaveValue('specific');
    await expect(globalModelStage.locator('select').first()).toBeDisabled();
    await expect(globalModelStage.locator('select').last()).toHaveValue('high');
  });

  test('keeps settings usable in dark theme and mobile viewport', async ({ chatPage, mockAgent }) => {
    await openWorkCenter(chatPage, mockAgent);
    await chatPage.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
    await chatPage.setViewportSize({ width: 720, height: 780 });
    await chatPage.locator('.work-center-sidebar-toggle').click();
    await chatPage.locator('.session-sidebar-shell .sidebar-icon-btn[title="Collapse sidebar"]').click();
    await expect(chatPage.locator('.session-sidebar-shell')).toHaveClass(/collapsed/);
    const settingsRequest = respondUntilOperation(mockAgent, 'get_settings', {
      list: { items: [OPEN_ITEM], watcher: { enabled: true } },
      get_settings: WORK_CENTER_SETTINGS,
    });
    await chatPage.locator('.work-center-header-actions .work-center-icon-button').first().click();
    await settingsRequest;

    const modal = chatPage.locator('.work-center-settings-card');
    await expect(modal).toBeVisible();
    await expect(chatPage.locator('.work-center-policy-stage')).toHaveCount(expectedActionPolicyCount());
    const workflowMetrics = await modal.evaluate(element => {
      const rect = element.getBoundingClientRect();
      const pane = element.querySelector('.work-center-settings-pane');
      const textarea = element.querySelector('.work-center-stage-instruction textarea');
      const save = element.querySelector('.work-center-settings-footer .btn-primary');
      const textareaStyle = getComputedStyle(textarea);
      const saveStyle = getComputedStyle(save);
      return {
        left: rect.left,
        right: rect.right,
        top: rect.top,
        bottom: rect.bottom,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        paneScrollable: pane.scrollHeight >= pane.clientHeight,
        background: getComputedStyle(element).backgroundColor,
        textareaBackground: textareaStyle.backgroundColor,
        textareaColor: textareaStyle.color,
        saveBackground: saveStyle.backgroundColor,
        saveColor: saveStyle.color,
      };
    });
    expect(workflowMetrics.left).toBeGreaterThanOrEqual(0);
    expect(workflowMetrics.right).toBeLessThanOrEqual(workflowMetrics.viewportWidth);
    expect(workflowMetrics.top).toBeGreaterThanOrEqual(0);
    expect(workflowMetrics.bottom).toBeLessThanOrEqual(workflowMetrics.viewportHeight);
    expect(workflowMetrics.paneScrollable).toBe(true);
    expect(workflowMetrics.background).not.toBe('rgba(0, 0, 0, 0)');
    expect(workflowMetrics.textareaBackground).not.toBe('rgb(255, 255, 255)');
    expect(workflowMetrics.textareaColor).not.toBe(workflowMetrics.textareaBackground);
    expect(workflowMetrics.saveBackground).not.toBe(workflowMetrics.background);
    expect(workflowMetrics.saveColor).not.toBe(workflowMetrics.saveBackground);

    await modal.getByRole('button', { name: 'Models', exact: true }).click();
    const effort = modal.locator('.work-center-model-stage').last().locator('.work-center-model-effort');
    await expect(effort).toBeVisible();
    await expect(effort.locator('select')).toHaveValue('high');
    const effortStyle = await effort.locator('select').evaluate(element => {
      const style = getComputedStyle(element);
      return { background: style.backgroundColor, color: style.color };
    });
    expect(effortStyle.background).not.toBe('rgb(255, 255, 255)');
    expect(effortStyle.color).not.toBe(effortStyle.background);
    await expect(modal.getByRole('button', { name: 'General', exact: true })).toHaveCount(0);
  });

  test('creates from a goal contract and leaves planning to AI triage', async ({ chatPage, mockAgent }) => {
    await openWorkCenter(chatPage, mockAgent);
    await chatPage.locator('.work-center-header-create').click();
    await expect(chatPage.locator('.work-center-plan-preview')).toContainText('AI-planned execution');
    await expect(chatPage.locator('.work-center-plan-preview')).toContainText('Triage chooses the task type');
    await expect(chatPage.locator('.work-center-plan-stages')).toHaveCount(0);

    await chatPage.locator('.work-center-modal').getByRole('textbox', { name: /Requirement/ })
      .fill('Fix dynamic planning with the smallest safe flow');
    const createRequest = respondToWorkCenterOp(mockAgent, 'create', OPEN_ITEM_DETAIL);
    await chatPage.getByRole('button', { name: 'Create', exact: true }).click();
    const request = await createRequest;
    expect(request.payload.workItemType).toBe('auto');
    expect(request.payload).not.toHaveProperty('workflowTemplate');
    expect(request.payload).not.toHaveProperty('stageOverrides');
  });

  test('uploads files and binds their references to the Work Item create request', async ({ chatPage, mockAgent }) => {
    await openWorkCenter(chatPage, mockAgent);
    await chatPage.locator('.work-center-header-create').click();
    await chatPage.locator('.work-center-modal').getByRole('textbox', { name: /Requirement/ })
      .fill('Inspect the uploaded screenshot in every Action');

    const upload = chatPage.waitForResponse(response => response.url().includes('/api/upload') && response.request().method() === 'POST');
    await chatPage.locator('.work-center-attachment-picker input').setInputFiles({
      name: 'screen.png', mimeType: 'image/png', buffer: Buffer.from('fake-image'),
    });
    await upload;
    await expect(chatPage.locator('.work-center-attachment-chip')).toContainText('screen.png');

    const createRequest = respondToWorkCenterOp(mockAgent, 'create', {
      ...OPEN_ITEM_DETAIL,
      attachments: [{ id: 'attachment-1', name: 'screen.png', mimeType: 'image/png', size: 10, isImage: true }],
    });
    await chatPage.getByRole('button', { name: 'Create', exact: true }).click();
    const request = await createRequest;
    expect(request.payload.attachments).toEqual([expect.objectContaining({
      fileId: expect.any(String), name: 'screen.png', mimeType: 'image/png', size: 10,
    })]);
  });

  test('keeps long Work Item messages fully visible without horizontal clipping', async ({ chatPage, mockAgent }) => {
    await openWorkCenter(chatPage, mockAgent);
    await chatPage.setViewportSize({ width: 1400, height: 900 });
    const select = chatPage.locator('.work-center-card').click();
    const longMessage = `unbroken-${'x'.repeat(1200)}`;
    const longUserMessage = `回归执行发现一个必须在评审前修复的代码级门禁：${'Sandbox 测试文件必须纳入受审测试清单并保持预算策略明确。'.repeat(12)}`;
    const longAttachmentName = `attachment-${'x'.repeat(1800)}.txt`;
    await respondToWorkCenterOp(mockAgent, 'get', {
      ...OPEN_ITEM_DETAIL,
      messages: [
        ...(OPEN_ITEM_DETAIL.messages || []),
        {
          id: 'user-overflow-probe',
          role: 'user',
          text: longUserMessage,
          status: 'completed',
          createdAt: Date.now() - 1,
          updatedAt: Date.now() - 1,
        },
        {
          id: 'overflow-probe',
          role: 'assistant',
          text: longMessage,
          status: 'completed',
          attachments: [{ id: 'probe', name: longAttachmentName, size: 12 }],
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      ],
    });
    await select;

    const conversation = chatPage.locator('.work-center-conversation');
    const userMessage = conversation.locator('.work-center-item-message-list article.role-user');
    await expect(userMessage).toContainText(longUserMessage);
    await expect(userMessage.locator('p')).toHaveText(longUserMessage);
    const sharedComposer = conversation.locator('[data-message-composer]');
    await expect(sharedComposer).toHaveCount(1);
    await expect(sharedComposer.locator('textarea')).toHaveAttribute('rows', '2');
    await expect(sharedComposer.locator('.chat-composer-actions')).toBeVisible();
    const upload = chatPage.waitForResponse(response => (
      response.url().includes('/api/upload') && response.request().method() === 'POST'
    ));
    await conversation.locator('.work-center-attachment-picker input').setInputFiles({
      name: 'work-item-screen.png', mimeType: 'image/png', buffer: Buffer.from('work-item-image'),
    });
    await upload;
    await expect(conversation.locator('.work-center-message-draft-attachments')).toContainText('work-item-screen.png');
    await expect(conversation.locator('textarea')).toHaveValue('');

    const messageResponse = respondToWorkCenterOp(mockAgent, 'post_work_item_message', {
      accepted: true,
      turnId: 'attachment-only-turn',
    });
    await conversation.getByRole('button', { name: 'Send to Coordinator' }).click();
    const messageRequest = await messageResponse;
    expect(messageRequest.payload).toMatchObject({
      id: OPEN_ITEM.id,
      target: { kind: 'coordinator' },
      text: '',
      revision: 1,
      planRevision: 2,
      ledgerRevision: 4,
      coordinatorRevision: 0,
      attachments: [expect.objectContaining({
        fileId: expect.any(String),
        name: 'work-item-screen.png',
        mimeType: 'image/png',
        size: 15,
      })],
    });
    await expect(conversation.locator('.work-center-message-draft-attachments')).toHaveCount(0);

    await chatPage.getByRole('button', { name: /^\d+ Actions$/ }).click();
    for (const { width, theme } of [
      { width: 1400, theme: 'light' },
      { width: 1400, theme: 'dark' },
      // Keep the narrow desktop split-pane range above the mobile breakpoint covered.
      { width: 867, theme: 'light' },
      { width: 867, theme: 'dark' },
      { width: 430, theme: 'light' },
      { width: 430, theme: 'dark' },
    ]) {
      await chatPage.setViewportSize({ width, height: 900 });
      await chatPage.evaluate(value => {
        document.documentElement.setAttribute('data-theme', value);
        localStorage.setItem('theme', value);
      }, theme);
      if (width <= 867 && await chatPage.locator('.work-center-content-pane').count()) {
        await chatPage.getByRole('button', { name: 'Close Actions' }).click();
      } else if (width > 867 && await chatPage.locator('.work-center-content-pane').count() === 0) {
        await chatPage.getByRole('button', { name: /^\d+ Actions$/ }).click();
      }
      await conversation.locator('textarea').fill('First line\nSecond line\nThird line');
      await chatPage.waitForTimeout(250);

      const metrics = await chatPage.locator('.work-center-detail').evaluate(detail => {
        const layout = detail.querySelector('.work-center-detail-layout');
        const workflow = detail.querySelector('.work-center-workflow');
        const main = detail.querySelector('.work-center-detail-main');
        const conversation = detail.querySelector('.work-center-conversation');
        const messageList = detail.querySelector('.work-center-item-message-list');
        const userArticle = messageList.querySelector('.role-user');
        const userText = userArticle.querySelector('p');
        const overflowArticle = messageList.lastElementChild;
        const renderedAttachmentList = overflowArticle.querySelector('.work-center-message-attachments');
        const renderedAttachmentChip = renderedAttachmentList.querySelector('.work-center-attachment-chip');
        const composer = detail.querySelector('[data-message-composer]');
        const composerActions = composer.querySelector('.chat-composer-actions');
        const textarea = composer.querySelector('textarea');
        const close = detail.querySelector('.work-center-detail-close');
        const card = detail.querySelector('.work-center-action-card');
        const content = card?.querySelector('.work-center-action-content');
        const detailRect = detail.getBoundingClientRect();
        const mainRect = main.getBoundingClientRect();
        const mainVisibleRight = mainRect.left + main.clientLeft + main.clientWidth;
        const userArticleRect = userArticle.getBoundingClientRect();
        const userTextRange = document.createRange();
        userTextRange.selectNodeContents(userText);
        const userTextContentRect = userTextRange.getBoundingClientRect();
        const userLastCharacterRange = document.createRange();
        userLastCharacterRange.setStart(userText.firstChild, userText.firstChild.length - 1);
        userLastCharacterRange.setEnd(userText.firstChild, userText.firstChild.length);
        const userLastCharacterRect = userLastCharacterRange.getBoundingClientRect();
        const closeRect = close.getBoundingClientRect();
        const lineRects = [...(content?.children || [])].map(element => element.getBoundingClientRect());
        const themeProbe = document.createElement('div');
        themeProbe.style.background = 'var(--session-active)';
        document.body.append(themeProbe);
        const sessionActiveBackground = getComputedStyle(themeProbe).backgroundColor;
        themeProbe.remove();
        return {
          columnCount: getComputedStyle(layout).gridTemplateColumns.trim().split(/\s+/).length,
          workflowWidth: workflow?.getBoundingClientRect().width ?? 0,
          cardHeight: card?.getBoundingClientRect().height ?? 0,
          lineCount: lineRects.length,
          distinctLineTops: new Set(lineRects.map(rect => Math.round(rect.top))).size,
          closeTop: Math.round(closeRect.top - detailRect.top),
          closeRight: Math.round(detailRect.right - closeRect.right),
          detailScrollWidth: detail.scrollWidth,
          detailClientWidth: detail.clientWidth,
          mainScrollWidth: main.scrollWidth,
          mainClientWidth: main.clientWidth,
          mainVisibleLeft: mainRect.left + main.clientLeft,
          mainVisibleRight,
          conversationScrollWidth: conversation.scrollWidth,
          conversationClientWidth: conversation.clientWidth,
          messageListScrollWidth: messageList.scrollWidth,
          messageListClientWidth: messageList.clientWidth,
          userArticleLeft: userArticleRect.left,
          userArticleRight: userArticleRect.right,
          userTextContentLeft: userTextContentRect.left,
          userTextContentRight: userTextContentRect.right,
          userLastCharacterLeft: userLastCharacterRect.left,
          userLastCharacterRight: userLastCharacterRect.right,
          mainOverflowX: getComputedStyle(main).overflowX,
          articleScrollWidth: overflowArticle.scrollWidth,
          articleClientWidth: overflowArticle.clientWidth,
          attachmentListScrollWidth: renderedAttachmentList.scrollWidth,
          attachmentListClientWidth: renderedAttachmentList.clientWidth,
          attachmentChipScrollWidth: renderedAttachmentChip.scrollWidth,
          attachmentChipClientWidth: renderedAttachmentChip.clientWidth,
          composerScrollWidth: composer.scrollWidth,
          composerClientWidth: composer.clientWidth,
          composerActionBelowTextarea: composerActions.getBoundingClientRect().top >= textarea.getBoundingClientRect().bottom,
          composerTextareaHeight: textarea.getBoundingClientRect().height,
          composerTextareaLineHeight: Number.parseFloat(getComputedStyle(textarea).lineHeight),
          composerTextareaOverflowY: getComputedStyle(textarea).overflowY,
          composerTextareaRows: textarea.rows,
          composerTextareaClientHeight: textarea.clientHeight,
          composerTextareaScrollHeight: textarea.scrollHeight,
          documentScrollWidth: document.documentElement.scrollWidth,
          documentClientWidth: document.documentElement.clientWidth,
          workflowBackground: workflow ? getComputedStyle(workflow).backgroundColor : null,
          detailBackground: getComputedStyle(detail).backgroundColor,
          mainBackground: getComputedStyle(main).backgroundColor,
          cardBackground: card ? getComputedStyle(card).backgroundColor : null,
          sessionActiveBackground,
          cardActive: card?.classList.contains('active') ?? false,
        };
      });

      if (width > 867) {
        expect(metrics.lineCount).toBe(3);
        expect(metrics.distinctLineTops).toBeGreaterThanOrEqual(1);
        expect(metrics.cardHeight).toBeLessThanOrEqual(75);
      } else {
        expect(metrics.lineCount).toBe(0);
        expect(metrics.cardHeight).toBe(0);
      }
      expect(metrics.detailScrollWidth).toBeLessThanOrEqual(metrics.detailClientWidth + 1);
      expect(metrics.mainScrollWidth).toBeLessThanOrEqual(metrics.mainClientWidth + 1);
      expect(metrics.conversationScrollWidth).toBeLessThanOrEqual(metrics.conversationClientWidth + 1);
      expect(metrics.messageListScrollWidth).toBeLessThanOrEqual(metrics.messageListClientWidth + 1);
      expect(metrics.userArticleLeft).toBeGreaterThanOrEqual(metrics.mainVisibleLeft - 1);
      expect(metrics.userArticleRight).toBeLessThanOrEqual(metrics.mainVisibleRight + 1);
      expect(metrics.userTextContentLeft).toBeGreaterThanOrEqual(metrics.mainVisibleLeft - 1);
      expect(metrics.userTextContentRight).toBeLessThanOrEqual(metrics.mainVisibleRight + 1);
      expect(metrics.userLastCharacterLeft).toBeGreaterThanOrEqual(metrics.mainVisibleLeft - 1);
      expect(metrics.userLastCharacterRight).toBeLessThanOrEqual(metrics.mainVisibleRight + 1);
      expect(metrics.mainOverflowX).toBe('hidden');
      expect(metrics.articleScrollWidth).toBeLessThanOrEqual(metrics.articleClientWidth + 1);
      expect(metrics.attachmentListScrollWidth).toBeLessThanOrEqual(metrics.attachmentListClientWidth + 1);
      expect(metrics.attachmentChipScrollWidth).toBeLessThanOrEqual(metrics.attachmentChipClientWidth + 1);
      expect(metrics.composerScrollWidth).toBeLessThanOrEqual(metrics.composerClientWidth + 1);
      expect(metrics.composerActionBelowTextarea).toBe(true);
      expect(metrics.composerTextareaRows).toBe(2);
      expect(metrics.composerTextareaHeight).toBe(width === 430
        ? metrics.composerTextareaLineHeight * 2
        : metrics.composerTextareaLineHeight * 3);
      expect(metrics.composerTextareaOverflowY).toBe(width === 430 ? 'auto' : 'hidden');
      if (width === 430) {
        expect(metrics.composerTextareaScrollHeight).toBeGreaterThan(metrics.composerTextareaClientHeight);
      } else {
        expect(metrics.composerTextareaScrollHeight).toBe(metrics.composerTextareaClientHeight);
      }
      expect(metrics.documentScrollWidth).toBeLessThanOrEqual(metrics.documentClientWidth + 1);
      if (width > 867) {
        expect(metrics.workflowBackground).not.toBe(metrics.detailBackground);
        expect(metrics.cardActive).toBe(false);
        expect(metrics.cardBackground).not.toBe(metrics.sessionActiveBackground);
      } else {
        expect(metrics.workflowBackground).toBeNull();
      }
      expect(metrics.mainBackground).toBe('rgba(0, 0, 0, 0)');
      if (width === 1400) {
        expect(metrics.columnCount).toBe(2);
        expect(metrics.workflowWidth).toBeGreaterThanOrEqual(500);
        expect(metrics.workflowWidth).toBeLessThanOrEqual(600);
        expect(metrics.closeTop).toBe(4);
        expect(metrics.closeRight).toBeGreaterThan(metrics.workflowWidth);
      } else if (width === 867) {
        expect(metrics.columnCount).toBeGreaterThanOrEqual(1);
        expect(metrics.workflowWidth).toBe(0);
      } else if (width === 430) {
        expect(metrics.columnCount).toBeGreaterThanOrEqual(1);
      }
    }

    const responsiveDraft = Array.from({ length: 28 }, () => 'draft').join(' ');
    const responsiveTextarea = conversation.locator('textarea');
    await chatPage.setViewportSize({ width: 430, height: 900 });
    await responsiveTextarea.fill(responsiveDraft);
    await expect.poll(() => responsiveTextarea.evaluate(element => ({
      visibleHeight: element.getBoundingClientRect().height,
      inlineHeight: Number.parseFloat(element.style.height),
      lineHeight: Number.parseFloat(getComputedStyle(element).lineHeight),
      scrollHeight: element.scrollHeight,
      clientHeight: element.clientHeight,
      overflowY: getComputedStyle(element).overflowY,
    }))).toMatchObject({ visibleHeight: 48, overflowY: 'auto' });
    const mobileDraftMetrics = await responsiveTextarea.evaluate(element => ({
      inlineHeight: Number.parseFloat(element.style.height),
      scrollHeight: element.scrollHeight,
      clientHeight: element.clientHeight,
    }));
    expect(mobileDraftMetrics.inlineHeight).toBeGreaterThan(48);
    expect(mobileDraftMetrics.scrollHeight).toBeGreaterThan(mobileDraftMetrics.clientHeight);

    await chatPage.setViewportSize({ width: 1400, height: 900 });
    await expect(responsiveTextarea).toHaveValue(responsiveDraft);
    await expect.poll(() => responsiveTextarea.evaluate(element => element.getBoundingClientRect().height))
      .toBe(72);
    const desktopDraftMetrics = await responsiveTextarea.evaluate(element => ({
      inlineHeight: Number.parseFloat(element.style.height),
      lineHeight: Number.parseFloat(getComputedStyle(element).lineHeight),
      overflowY: getComputedStyle(element).overflowY,
    }));
    expect(desktopDraftMetrics.inlineHeight).toBe(desktopDraftMetrics.lineHeight * 3);
    expect(desktopDraftMetrics.overflowY).toBe('hidden');

    await chatPage.setViewportSize({ width: 430, height: 900 });
    await expect(responsiveTextarea).toHaveValue(responsiveDraft);
    await expect.poll(() => responsiveTextarea.evaluate(element => ({
      visibleHeight: element.getBoundingClientRect().height,
      overflowY: getComputedStyle(element).overflowY,
      scrolls: element.scrollHeight > element.clientHeight,
    }))).toEqual({ visibleHeight: 48, overflowY: 'auto', scrolls: true });

    for (const { width, theme } of [
      { width: 1920, theme: 'light' },
      { width: 1920, theme: 'dark' },
      { width: 1200, theme: 'light' },
      { width: 1200, theme: 'dark' },
    ]) {
      await chatPage.setViewportSize({ width, height: 900 });
      await chatPage.evaluate(value => {
        document.documentElement.setAttribute('data-theme', value);
        localStorage.setItem('theme', value);
      }, theme);
      await chatPage.waitForTimeout(250);
      await expectNoHorizontalOverflow(chatPage.locator('.work-center-detail'), {
        detail: ':scope',
        main: '.work-center-detail-main',
        conversation: '.work-center-conversation',
        messageList: '.work-center-item-message-list',
        article: '.work-center-item-message-list article:last-child',
        attachmentList: '.work-center-item-message-list article:last-child .work-center-message-attachments',
        attachmentChip: '.work-center-item-message-list article:last-child .work-center-attachment-chip',
        composer: '[data-message-composer]',
      });
    }
  });

  test('keeps the single Conversation attachment draft while viewing Content and sends it to the selected Action', async ({ chatPage, mockAgent }) => {
    await openWorkCenter(chatPage, mockAgent, [FAILED_ITEM]);
    const select = chatPage.locator('.work-center-card').click();
    await respondToWorkCenterOp(mockAgent, 'get', FAILED_ITEM_DETAIL, [FAILED_ITEM]);
    await select;
    await chatPage.setViewportSize({ width: 430, height: 900 });

    const conversation = chatPage.locator('.work-center-conversation');
    const composer = conversation.locator('textarea');
    await composer.fill('Retry with the attached evidence');
    const upload = chatPage.waitForResponse(response => response.url().includes('/api/upload') && response.request().method() === 'POST');
    await conversation.locator('.work-center-attachment-picker input').setInputFiles({
      name: 'follow-up.txt', mimeType: 'text/plain', buffer: Buffer.from('follow up'),
    });
    await upload;
    await expect(conversation.locator('.work-center-message-draft-attachments')).toContainText('follow-up.txt');

    await chatPage.getByRole('button', { name: /^\d+ Actions$/ }).click();
    await chatPage.locator('.work-center-action-summary').click();
    const actionDetail = chatPage.locator('.work-center-action-detail-pane');
    await expect(actionDetail.locator('textarea')).toHaveCount(0);
    await actionDetail.getByRole('button', { name: 'Send to this Action' }).click();

    await expect(composer).toBeVisible();
    await expect(composer).toHaveValue('Retry with the attached evidence');
    await expect(conversation.locator('.work-center-message-draft-attachments')).toContainText('follow-up.txt');
    await expect(chatPage.getByTestId('work-center-composer-target')).toHaveValue('action:action-1:1');

    const inputRequests = (async () => {
      const operations = [];
      while (!operations.some(request => request.op === 'post_work_item_message')
        || !operations.some(request => request.op === 'list')) {
        operations.push(await respondByOperation(mockAgent, {
          post_work_item_message: FAILED_ITEM_DETAIL,
          list: { items: [FAILED_ITEM], watcher: { enabled: true } },
          get: FAILED_ITEM_DETAIL,
        }));
      }
      return operations;
    })();
    await conversation.getByRole('button', { name: /Send to/ }).click();
    const requests = await inputRequests;
    const request = requests.find(candidate => candidate.op === 'post_work_item_message');
    expect(request.payload).toMatchObject({
      id: OPEN_ITEM.id,
      target: { kind: 'action', actionId: 'action-1', generation: 1 },
      revision: 1,
      text: 'Retry with the attached evidence',
      attachments: [expect.objectContaining({
        fileId: expect.any(String), name: 'follow-up.txt', mimeType: 'text/plain', size: 9,
      })],
    });
  });

  test('keeps the empty board aligned across desktop, mobile, light, and dark layouts', async ({ chatPage, mockAgent }) => {
    await openWorkCenter(chatPage, mockAgent, []);
    await chatPage.evaluate(agentId => {
      const store = window.Pinia.useChatStore();
      store.workCenterItemsByAgent[agentId] = [];
      store.workCenterLoadedByAgent[agentId] = true;
      store.workCenterLoadingByAgent[agentId] = false;
    }, mockAgent.agentId);

    for (const { width, theme } of [
      { width: 1400, theme: 'light' },
      { width: 1400, theme: 'dark' },
      { width: 430, theme: 'light' },
      { width: 430, theme: 'dark' },
    ]) {
      await chatPage.setViewportSize({ width, height: 900 });
      await chatPage.evaluate(value => {
        document.documentElement.setAttribute('data-theme', value);
        localStorage.setItem('theme', value);
      }, theme);

      const emptyState = chatPage.locator('.work-center-empty-state');
      await expect(emptyState).toBeVisible();
      await expect(chatPage.locator('.work-center-board-empty')).toHaveCount(0);
      const metrics = await chatPage.evaluate(() => {
        const rect = element => element.getBoundingClientRect();
        const board = document.querySelector('.work-center-board');
        const body = document.querySelector('.work-center-body');
        const empty = document.querySelector('.work-center-empty-state');
        const boardRect = rect(board);
        const emptyRect = rect(empty);
        const laneRects = [...document.querySelectorAll('.work-center-board-lane')]
          .map(rect)
          .filter(laneRect => laneRect.width > 0 && laneRect.height > 0);
        return {
          boardDisplay: getComputedStyle(board).display,
          bodyBorderWidth: getComputedStyle(body).borderTopWidth,
          bodyBorderRadius: getComputedStyle(body).borderTopLeftRadius,
          visibleLaneCount: laneRects.length,
          laneWidths: laneRects.map(laneRect => laneRect.width),
          firstLaneLeft: laneRects[0]?.left || 0,
          lastLaneRight: laneRects.at(-1)?.right || 0,
          boardLeft: boardRect.left,
          boardRight: boardRect.right,
          boardCenter: boardRect.left + boardRect.width / 2,
          emptyCenter: emptyRect.left + emptyRect.width / 2,
          documentScrollWidth: document.documentElement.scrollWidth,
          documentClientWidth: document.documentElement.clientWidth,
        };
      });

      expect(metrics.bodyBorderWidth).toBe('1px');
      expect(metrics.bodyBorderRadius).toBe('12px');
      expect(Math.abs(metrics.emptyCenter - metrics.boardCenter)).toBeLessThanOrEqual(1);
      expect(metrics.documentScrollWidth).toBeLessThanOrEqual(metrics.documentClientWidth + 1);
      if (width === 1400) {
        expect(metrics.boardDisplay).toBe('grid');
        expect(metrics.visibleLaneCount).toBe(3);
        expect(Math.max(...metrics.laneWidths) - Math.min(...metrics.laneWidths)).toBeLessThanOrEqual(1);
        expect(Math.min(...metrics.laneWidths)).toBeGreaterThan(200);
        expect(metrics.firstLaneLeft - metrics.boardLeft).toBeGreaterThanOrEqual(9);
        expect(metrics.boardRight - metrics.lastLaneRight).toBeGreaterThanOrEqual(9);
      } else {
        expect(metrics.boardDisplay).toBe('flex');
        expect(metrics.visibleLaneCount).toBe(1);
      }
    }

    await chatPage.getByRole('button', { name: 'Create first work item' }).click();
    await expect(chatPage.locator('.work-center-modal')).toBeVisible();
  });

  test('uses mobile board lane tabs and lane-specific empty states', async ({ chatPage, mockAgent }) => {
    await openWorkCenter(chatPage, mockAgent);
    await chatPage.setViewportSize({ width: 720, height: 780 });

    await chatPage.getByRole('tab', { name: /Closed/ }).click();
    const closedLane = chatPage.locator('.work-center-board-lane[data-lane="closed"]');
    await expect(closedLane).toBeVisible();
    await expect(closedLane.locator('.work-center-card')).toHaveCount(0);

    await chatPage.getByRole('tab', { name: /Active/ }).click();
    const activeLane = chatPage.locator('.work-center-board-lane[data-lane="active"]');
    await expect(activeLane).toBeVisible();
    await expect(activeLane.locator('.work-center-card')).toHaveCount(1);
  });
});
