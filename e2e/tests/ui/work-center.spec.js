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
  messages: [],
  actions: [{
    ...OPEN_ITEM_DETAIL.actions[0],
    status: 'waiting',
    canonicalResult: {
      waitingReason: 'Choose PostgreSQL or SQLite before the migration continues.',
    },
  }],
};

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

async function respondToWorkCenterRequest(mockAgent, data) {
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
  await chatPage.locator('.sidebar-work-center-trigger').click();

  const responses = (async () => {
    const data = { items, watcher: { enabled: true } };
    const responseMap = { list: data, get_settings: WORK_CENTER_SETTINGS };
    for (let index = 0; index < 8; index++) {
      await respondByOperation(mockAgent, responseMap);
      await chatPage.waitForTimeout(25);
      const ready = await chatPage.evaluate(expectedCount => {
        const store = window.Pinia.useChatStore();
        const agentId = store.workCenterAgentId;
        return store.workCenterLoadedByAgent[agentId] === true
          && store.workCenterLoadingByAgent[agentId] !== true
          && (store.workCenterItemsByAgent[agentId] || []).length === expectedCount
          && !!store.workCenterSettingsByAgent[agentId]
          && !Object.values(store.workCenterPending)
            .some(entry => ['list', 'get_settings'].includes(entry.op));
      }, items.length);
      if (ready) return;
    }
    throw new Error('Work Center board did not settle after fixture responses');
  })();

  await chatPage.locator('.sidebar-work-center-agent').first().click();
  await responses;
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

test.describe('Work Center responsive UI', () => {
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

  test('uses single-pane drilldown at wide and constrained widths', async ({ chatPage, mockAgent }) => {
    await openWorkCenter(chatPage, mockAgent);
    await chatPage.setViewportSize({ width: 1600, height: 900 });
    const select = chatPage.locator('.work-center-card').click();
    await respondToWorkCenterOp(mockAgent, 'get', OPEN_ITEM_DETAIL);
    await select;

    await expect(chatPage.locator('.work-center-list')).toBeHidden();
    await expect(chatPage.locator('.work-center-detail')).toBeVisible();
    await expect(chatPage.locator('.work-center-action-detail-pane')).toBeHidden();
    await chatPage.locator('.work-center-action-summary').click();
    await expect(chatPage.locator('.work-center-detail')).toBeHidden();
    await expect(chatPage.locator('.work-center-action-detail-pane')).toBeVisible();

    await chatPage.setViewportSize({ width: 1024, height: 900 });
    await chatPage.waitForTimeout(250);
    await expect(chatPage.locator('.work-center-list')).toBeHidden();
    await expect(chatPage.locator('.work-center-detail')).toBeHidden();
    await expect(chatPage.locator('.work-center-action-detail-pane')).toBeVisible();
    const metrics = await layoutMetrics(chatPage);
    expect(metrics.mainScrollWidth).toBeLessThanOrEqual(metrics.mainClientWidth + 1);
    expect(metrics.bodyScrollWidth).toBeLessThanOrEqual(metrics.bodyClientWidth + 1);
    await chatPage.locator('.work-center-action-detail-pane > .work-center-action-detail-header .work-center-icon-button').click();
    await expect(chatPage.locator('.work-center-detail')).toBeVisible();
    await chatPage.locator('.work-center-breadcrumbs button').first().click();
    await expect(chatPage.locator('.work-center-list')).toBeVisible();
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
    await respondToWorkCenterOp(mockAgent, 'get', OPEN_ITEM_DETAIL);
    await select;

    await chatPage.locator('.work-center-action-summary').click();
    await expect(chatPage.locator('.work-center-action-detail-pane')).toBeVisible();
    await chatPage.locator('.session-sidebar-shell .sidebar-icon-btn[title="Workbench"]').click();
    await expect(chatPage.locator('.workbench-panel')).toHaveClass(/expanded/);

    await resizeWorkbenchForMainWidth(chatPage, 1280);
    let metrics = await layoutMetrics(chatPage);
    expect(metrics.main.width).toBeGreaterThan(1250);
    await expect(chatPage.locator('.work-center-list')).toBeHidden();
    await expect(chatPage.locator('.work-center-detail')).toBeHidden();
    await expect(chatPage.locator('.work-center-action-detail-pane')).toBeVisible();
    expect(metrics.mainScrollWidth).toBeLessThanOrEqual(metrics.mainClientWidth + 1);
    expect(metrics.bodyScrollWidth).toBeLessThanOrEqual(metrics.bodyClientWidth + 1);

    await resizeWorkbenchForMainWidth(chatPage, 1200);
    metrics = await layoutMetrics(chatPage);
    expect(metrics.main.width).toBeGreaterThan(1160);
    expect(metrics.main.width).toBeLessThanOrEqual(1250);
    await expect(chatPage.locator('.work-center-list')).toBeHidden();
    await expect(chatPage.locator('.work-center-detail')).toBeHidden();
    await expect(chatPage.locator('.work-center-action-detail-pane')).toBeVisible();
    expect(metrics.mainScrollWidth).toBeLessThanOrEqual(metrics.mainClientWidth + 1);
    expect(metrics.bodyScrollWidth).toBeLessThanOrEqual(metrics.bodyClientWidth + 1);
  });

  test('keeps a long Action list reachable in a short workspace', async ({ chatPage, mockAgent }) => {
    const detail = detailWithActions(24);
    await openWorkCenter(chatPage, mockAgent);
    await chatPage.setViewportSize({ width: 1440, height: 520 });
    const select = chatPage.locator('.work-center-card').click();
    await respondToWorkCenterOp(mockAgent, 'get', detail);
    await select;

    const actionList = chatPage.locator('.work-center-action-list');
    const cards = actionList.locator('.work-center-action-card');
    const workflow = chatPage.locator('.work-center-workflow');
    await expect(cards).toHaveCount(24);
    const columns = await chatPage.locator('.work-center-detail-layout').evaluate(element => getComputedStyle(element).gridTemplateColumns);
    expect(columns.trim().split(/\s+/)).toHaveLength(2);
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

    await chatPage.setViewportSize({ width: 900, height: 760 });
    await chatPage.waitForTimeout(350);
    const compactColumns = await chatPage.locator('.work-center-detail-layout').evaluate(element => getComputedStyle(element).gridTemplateColumns);
    expect(compactColumns.trim().split(/\s+/)).toHaveLength(1);
    await expect(workflow).toBeVisible();
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

  test('shows the current Action as a focused card and sends guidance through the Action operation', async ({ chatPage, mockAgent }) => {
    await openWorkCenter(chatPage, mockAgent);
    const select = chatPage.locator('.work-center-card').click();
    const getRequest = await respondToWorkCenterOp(mockAgent, 'get', OPEN_ITEM_DETAIL);
    await select;
    expect(getRequest.op).toBe('get');

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
    const conversation = chatPage.locator('.work-center-conversation');
    await expect(conversation).toContainText('Conversation');
    await expect(conversation).not.toContainText('Coordinator');
    await expect(conversation.locator('.work-center-coordinator-empty')).toHaveCount(0);
    const workItemComposer = conversation.locator('textarea');
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
    const conversationResponse = respondToWorkCenterOp(mockAgent, 'work_item_message', {
      accepted: true,
      turnId: 'turn-1',
    });
    await conversation.getByRole('button', { name: 'Send message' }).click();
    const conversationRequest = await conversationResponse;
    expect(conversationRequest.payload).toMatchObject({
      id: OPEN_ITEM.id,
      text: 'Change the goal\nand replan the remaining Actions',
      revision: 1,
      planRevision: 2,
      ledgerRevision: 4,
      coordinatorRevision: 0,
    });
    await expect(workItemComposer).toHaveValue('');

    await action.locator('.work-center-action-summary').click();
    const actionDetail = chatPage.locator('.work-center-action-detail-pane');
    await expect(actionDetail.locator('.work-center-action-message')).toContainText('Updated the existing layout styles');
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

    const actionComposer = actionDetail.locator('.work-center-action-composer');
    await expect(actionComposer).toBeVisible();
    const actionInput = actionComposer.locator('textarea');
    await actionInput.fill('Keep the current implementation\nand verify the narrow layout');
    const actionComposerMetrics = await actionInput.evaluate(element => ({
      clientHeight: element.clientHeight,
      lineHeight: Number.parseFloat(getComputedStyle(element).lineHeight),
      overflowY: getComputedStyle(element).overflowY,
    }));
    expect(actionComposerMetrics.clientHeight).toBeGreaterThan(actionComposerMetrics.lineHeight * 1.5);
    expect(actionComposerMetrics.overflowY).toBe('hidden');
    const actionInputResponse = (async () => {
      const operations = [];
      while (!operations.some(request => request.op === 'action_input')
        || !operations.some(request => request.op === 'list')) {
        operations.push(await respondByOperation(mockAgent, {
          action_input: {
            ...OPEN_ITEM_DETAIL,
            actions: [{ ...OPEN_ITEM_DETAIL.actions[0], status: 'running' }],
          },
          list: { items: [OPEN_ITEM], watcher: { enabled: true } },
          get: OPEN_ITEM_DETAIL,
        }));
      }
      return operations;
    })();
    await actionComposer.getByRole('button', { name: 'Send to Action' }).click();
    const actionInputOps = await actionInputResponse;
    const actionInputRequest = actionInputOps.find(request => request.op === 'action_input');
    expect(actionInputRequest.payload).toMatchObject({
      id: OPEN_ITEM.id,
      actionId: 'action-1',
      generation: 1,
      revision: 1,
      text: 'Keep the current implementation\nand verify the narrow layout',
    });
    await expect(actionInput).toHaveValue('');
    await expect(actionComposer).toBeVisible();
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
        list: { items: [terminalDetail], watcher: { enabled: true } },
      })).op,
      (await respondByOperation(mockAgent, {
        get: terminalDetail,
        get_action_messages: terminalPage,
        list: { items: [terminalDetail], watcher: { enabled: true } },
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
    await chatPage.locator('.work-center-action-summary').click();

    let actionDetail = chatPage.locator('.work-center-action-detail-pane');
    await expect(actionDetail.locator('.work-center-action-failure')).toContainText('Why this Action failed');
    await expect(actionDetail.locator('.work-center-action-failure')).toContainText('unsafe patch');
    await expect(actionDetail.locator('.work-center-action-failure')).toContainText('All unverified changes were reverted');
    await expect(actionDetail.locator('.work-center-action-failure')).toContainText('Add corrected instructions or files below');
    await expect(actionDetail.locator('.work-center-action-composer')).toContainText('rerun this Action');

    await actionDetail.locator('.work-center-action-detail-header .work-center-icon-button').click();
    await chatPage.locator('.work-center-detail-close').click();
    const selectWaiting = chatPage.locator('.work-center-card', { hasText: WAITING_ITEM.title }).click();
    await respondToWorkCenterOp(mockAgent, 'get', WAITING_ITEM_DETAIL, items);
    await selectWaiting;
    await chatPage.locator('.work-center-action-summary').click();

    actionDetail = chatPage.locator('.work-center-action-detail-pane');
    const waitingQuestion = actionDetail.locator('#work-center-action-waiting-question');
    await expect(waitingQuestion).toContainText('Input required');
    await expect(waitingQuestion).toContainText('Choose PostgreSQL or SQLite before the migration continues.');
    const composer = actionDetail.locator('.work-center-action-composer textarea');
    await expect(composer).toBeVisible();
    await expect(composer).toHaveAttribute('aria-describedby', /work-center-action-waiting-question/);
    await expect(composer).toHaveAttribute('aria-describedby', /work-center-action-composer-hint/);
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
      const detail = element.closest('.work-center-detail').getBoundingClientRect();
      return {
        height: button.height,
        rightGap: detail.right - button.right,
        bottomGap: detail.bottom - button.bottom,
      };
    });
    expect(stopBounds.height).toBeLessThanOrEqual(36);
    expect(stopBounds.rightGap).toBeGreaterThanOrEqual(16);
    expect(stopBounds.bottomGap).toBeGreaterThanOrEqual(12);
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
      await expect(conversation.locator('.work-center-conversation-readonly')).toBeVisible();
      await expect(conversation.locator('.work-center-item-message-input')).toHaveCount(0);
      await expect(conversation.locator('textarea')).toHaveCount(0);

      await chatPage.locator('.work-center-action-summary').click();
      const actionDetail = chatPage.locator('.work-center-action-detail-pane');
      await expect(actionDetail).toContainText(item.status === 'done'
        ? 'Verified and released the layout fix.'
        : 'Execution stopped without publishing changes.');
      await expect(actionDetail.locator('.work-center-action-composer')).toHaveCount(0);
      await expect(actionDetail.locator('textarea')).toHaveCount(0);

      await actionDetail.locator('.work-center-action-detail-header .work-center-icon-button').click();
      await chatPage.locator('.work-center-detail-close').click();
      await expect(chatPage.locator('.work-center-list')).toBeVisible();
    }

    const blockedOps = new Set(['work_item_message', 'action_input', 'retry_action', 'guide']);
    expect(workCenterRequestOps(mockAgent).filter(op => blockedOps.has(op))).toEqual([]);
  });

  test('loads retained tool evidence only when the Execution view is opened', async ({ chatPage, mockAgent }) => {
    await openWorkCenter(chatPage, mockAgent);
    const select = chatPage.locator('.work-center-card').click();
    await respondToWorkCenterOp(mockAgent, 'get', OPEN_ITEM_DETAIL);
    await select;

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

  test('renders one readable Action conversation column in both themes and on mobile', async ({ chatPage, mockAgent }) => {
    const detail = structuredClone(FAILED_ITEM_DETAIL);
    detail.actions[0].messages = [
      {
        id: 'action-1:assistant', role: 'assistant', status: 'completed',
        text: 'Verified the responsive layout.', createdAt: Date.now() - 1, updatedAt: Date.now() - 1,
      },
      {
        id: 'action-1:user', role: 'user', status: 'completed',
        text: 'Keep the correction small.', createdAt: Date.now(), updatedAt: Date.now(),
      },
    ];
    await openWorkCenter(chatPage, mockAgent, [FAILED_ITEM]);
    const select = chatPage.locator('.work-center-card').click();
    await respondToWorkCenterOp(mockAgent, 'get', detail, [FAILED_ITEM]);
    await select;
    await chatPage.locator('.work-center-action-summary').click();

    const pane = chatPage.locator('.work-center-action-detail-pane');
    await expect(pane.locator('.work-center-action-composer')).toBeVisible();
    await expect(pane.locator('.work-center-action-message')).toHaveCount(2);
    await expect(pane).toContainText('Verified the responsive layout.');
    await expect(pane).toContainText('Keep the correction small.');

    for (const theme of ['light', 'dark']) {
      await chatPage.evaluate(value => {
        document.documentElement.setAttribute('data-theme', value);
        localStorage.setItem('theme', value);
      }, theme);
      await expect(chatPage.locator('html')).toHaveAttribute('data-theme', theme);
      const colors = await pane.evaluate(root => {
        const assistant = getComputedStyle(root.querySelector('.role-assistant'));
        const user = getComputedStyle(root.querySelector('.role-user'));
        const composer = getComputedStyle(root.querySelector('.work-center-action-input-wrapper'));
        return {
          assistantText: assistant.color,
          userText: user.color,
          userBackground: user.backgroundColor,
          composerBackground: composer.backgroundColor,
        };
      });
      expect(colors.assistantText).not.toBe(colors.composerBackground);
      expect(colors.userText).not.toBe(colors.userBackground);
      expect(colors.userBackground).not.toBe('rgba(0, 0, 0, 0)');
      expect(colors.composerBackground).not.toBe('rgba(0, 0, 0, 0)');
    }

    for (const width of [1200, 760, 390]) {
      await chatPage.setViewportSize({ width, height: 720 });
      await chatPage.waitForTimeout(250);
      const layout = await pane.evaluate(root => {
        const detailRect = root.getBoundingClientRect();
        const transcript = root.querySelector('.work-center-action-transcript').getBoundingClientRect();
        const composer = root.querySelector('.work-center-action-composer').getBoundingClientRect();
        return {
          detailLeft: detailRect.left,
          detailRight: detailRect.right,
          detailWidth: detailRect.width,
          transcriptWidth: transcript.width,
          composerWidth: composer.width,
          scrollWidth: root.scrollWidth,
        };
      });
      expect(layout.detailLeft).toBeGreaterThanOrEqual(0);
      expect(layout.detailRight).toBeLessThanOrEqual(width + 1);
      expect(layout.transcriptWidth).toBeLessThanOrEqual(layout.detailWidth + 1);
      expect(layout.composerWidth).toBeLessThanOrEqual(layout.detailWidth + 1);
      expect(layout.scrollWidth).toBeLessThanOrEqual(layout.detailWidth + 1);
      expect(await chatPage.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    }
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

  test('keeps Action guidance visible without overflow in dark theme', async ({ chatPage, mockAgent }) => {
    await openWorkCenter(chatPage, mockAgent);
    const select = chatPage.locator('.work-center-card').click();
    await respondToWorkCenterOp(mockAgent, 'get', OPEN_ITEM_DETAIL);
    await select;
    await chatPage.locator('.work-center-action-summary').click();

    await chatPage.evaluate(() => {
      document.documentElement.setAttribute('data-theme', 'dark');
      localStorage.setItem('theme', 'dark');
    });
    await expect(chatPage.locator('html')).toHaveAttribute('data-theme', 'dark');
    await expect(chatPage.locator('.work-center-action-detail-pane')).toBeVisible();
    await expect(chatPage.locator('.work-center-action-composer')).toBeVisible();

    const metrics = await layoutMetrics(chatPage);
    expect(metrics.documentScrollWidth).toBeLessThanOrEqual(metrics.viewportWidth);
    expect(metrics.bodyScrollWidth).toBeLessThanOrEqual(metrics.bodyClientWidth + 1);
    const colors = await chatPage.locator('.work-center-action-transcript').evaluate(element => {
      const style = getComputedStyle(element);
      return { background: style.backgroundColor, text: style.color };
    });
    expect(colors.text).not.toBe(colors.background);
  });

  test('shows delayed directory defaults before sending the create request', async ({ chatPage, mockAgent }) => {
    await chatPage.locator('.sidebar-work-center-trigger').click();
    const settingsRequest = (async () => {
      for (;;) {
        const request = await mockAgent.waitForMessage('work_center_request');
        if (request.op === 'get_settings') return request;
        if (request.op !== 'list') throw new Error(`Expected Work Center list or get_settings, received ${request.op}`);
        mockAgent.send({
          type: 'work_center_response', requestId: request.requestId, op: request.op, ok: true,
          data: { items: [OPEN_ITEM], watcher: { enabled: true } },
        });
      }
    })();

    await chatPage.locator('.sidebar-work-center-agent').first().click();
    const pendingSettings = await settingsRequest;
    await expect(chatPage.locator('.work-center-main')).toBeVisible();
    await chatPage.locator('.work-center-header-create').click();
    const createModal = chatPage.locator('.work-center-modal');
    const workDir = createModal.getByRole('textbox', { name: /Working directory/ });
    await expect(workDir).toHaveValue('');
    await expect(createModal.getByRole('button', { name: 'Create', exact: true })).toBeDisabled();

    mockAgent.send({
      type: 'work_center_response', requestId: pendingSettings.requestId, op: pendingSettings.op, ok: true,
      data: WORK_CENTER_SETTINGS,
    });
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
    const coordinatorStage = modelStages.filter({ hasText: 'Coordinator' });
    await expect(coordinatorStage).toHaveCount(1);
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
    await coordinatorStage.locator('select').nth(1).selectOption('provider/review');
    await coordinatorStage.locator('.work-center-model-effort select').selectOption('medium');

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
    expect(saveRequest.payload.settings).toMatchObject({
      revision: 7,
      coordinatorModelPolicy: {
        mode: 'specific', model: 'provider/review', effort: 'medium',
      },
    });
    await respondToWorkCenterOp(
      mockAgent, 'list', { items: [OPEN_ITEM], watcher: { enabled: true } }, [OPEN_ITEM],
    );
    await expect(modal).toBeHidden();
    await expect.poll(() => workCenterRequestOps(mockAgent).filter(op => op === 'update_settings').length)
      .toBe(1);
    await expect.poll(() => chatPage.evaluate(agentId => {
      const settings = window.Pinia.useChatStore().workCenterSettingsByAgent[agentId];
      return {
        revision: settings?.revision,
        coordinatorModelPolicy: settings?.coordinatorModelPolicy,
      };
    }, mockAgent.agentId)).toEqual({
      revision: 8,
      coordinatorModelPolicy: {
        mode: 'specific', model: 'provider/review', effort: 'medium',
      },
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

  test('sends an attachment-only Work Item message and keeps the detail layout compact', async ({ chatPage, mockAgent }) => {
    await openWorkCenter(chatPage, mockAgent);
    await chatPage.setViewportSize({ width: 1400, height: 900 });
    const select = chatPage.locator('.work-center-card').click();
    await respondToWorkCenterOp(mockAgent, 'get', OPEN_ITEM_DETAIL);
    await select;

    const conversation = chatPage.locator('.work-center-conversation');
    const upload = chatPage.waitForResponse(response => (
      response.url().includes('/api/upload') && response.request().method() === 'POST'
    ));
    await conversation.locator('.work-center-attachment-picker input').setInputFiles({
      name: 'work-item-screen.png', mimeType: 'image/png', buffer: Buffer.from('work-item-image'),
    });
    await upload;
    await expect(conversation.locator('.work-center-message-draft-attachments')).toContainText('work-item-screen.png');
    await expect(conversation.locator('textarea')).toHaveValue('');

    const messageResponse = respondToWorkCenterOp(mockAgent, 'work_item_message', {
      accepted: true,
      turnId: 'attachment-only-turn',
    });
    await conversation.getByRole('button', { name: 'Send message' }).click();
    const messageRequest = await messageResponse;
    expect(messageRequest.payload).toMatchObject({
      id: OPEN_ITEM.id,
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
      await chatPage.waitForTimeout(250);

      const metrics = await chatPage.locator('.work-center-detail').evaluate(detail => {
        const layout = detail.querySelector('.work-center-detail-layout');
        const workflow = detail.querySelector('.work-center-workflow');
        const main = detail.querySelector('.work-center-detail-main');
        const close = detail.querySelector('.work-center-detail-close');
        const card = detail.querySelector('.work-center-action-card');
        const content = card.querySelector('.work-center-action-content');
        const detailRect = detail.getBoundingClientRect();
        const closeRect = close.getBoundingClientRect();
        const lineRects = [...content.children].map(element => element.getBoundingClientRect());
        const themeProbe = document.createElement('div');
        themeProbe.style.background = 'var(--session-active)';
        document.body.append(themeProbe);
        const sessionActiveBackground = getComputedStyle(themeProbe).backgroundColor;
        themeProbe.remove();
        return {
          columnCount: getComputedStyle(layout).gridTemplateColumns.trim().split(/\s+/).length,
          workflowWidth: workflow.getBoundingClientRect().width,
          cardHeight: card.getBoundingClientRect().height,
          lineCount: lineRects.length,
          distinctLineTops: new Set(lineRects.map(rect => Math.round(rect.top))).size,
          closeTop: Math.round(closeRect.top - detailRect.top),
          closeRight: Math.round(detailRect.right - closeRect.right),
          detailScrollWidth: detail.scrollWidth,
          detailClientWidth: detail.clientWidth,
          documentScrollWidth: document.documentElement.scrollWidth,
          documentClientWidth: document.documentElement.clientWidth,
          workflowBackground: getComputedStyle(workflow).backgroundColor,
          detailBackground: getComputedStyle(detail).backgroundColor,
          mainBackground: getComputedStyle(main).backgroundColor,
          cardBackground: getComputedStyle(card).backgroundColor,
          sessionActiveBackground,
          cardActive: card.classList.contains('active'),
        };
      });

      expect(metrics.lineCount).toBe(3);
      expect(metrics.distinctLineTops).toBe(3);
      expect(metrics.cardHeight).toBeLessThanOrEqual(75);
      expect(metrics.detailScrollWidth).toBeLessThanOrEqual(metrics.detailClientWidth + 1);
      expect(metrics.documentScrollWidth).toBeLessThanOrEqual(metrics.documentClientWidth + 1);
      expect(metrics.workflowBackground).toBe(metrics.detailBackground);
      expect(metrics.mainBackground).toBe('rgba(0, 0, 0, 0)');
      expect(metrics.cardActive).toBe(true);
      expect(metrics.cardBackground).toBe(metrics.sessionActiveBackground);
      if (width === 1400) {
        expect(metrics.columnCount).toBe(2);
        expect(metrics.workflowWidth).toBeGreaterThanOrEqual(439);
        expect(metrics.workflowWidth).toBeLessThanOrEqual(441);
        expect(metrics.closeTop).toBe(16);
        expect(metrics.closeRight).toBe(16);
      } else {
        expect(metrics.columnCount).toBe(1);
        expect(metrics.closeTop).toBe(12);
        expect(metrics.closeRight).toBe(12);
      }
    }
  });

  test('uploads files with Action recovery input and forwards owned references', async ({ chatPage, mockAgent }) => {
    await openWorkCenter(chatPage, mockAgent, [FAILED_ITEM]);
    const select = chatPage.locator('.work-center-card').click();
    await respondToWorkCenterOp(mockAgent, 'get', FAILED_ITEM_DETAIL, [FAILED_ITEM]);
    await select;
    await chatPage.locator('.work-center-action-summary').click();

    const composer = chatPage.locator('.work-center-action-composer');
    const upload = chatPage.waitForResponse(response => response.url().includes('/api/upload') && response.request().method() === 'POST');
    await composer.locator('.work-center-attachment-picker input').setInputFiles({
      name: 'follow-up.txt', mimeType: 'text/plain', buffer: Buffer.from('follow up'),
    });
    await upload;
    await expect(composer.locator('.work-center-attachment-chip')).toContainText('follow-up.txt');

    const inputRequest = respondToWorkCenterOp(mockAgent, 'action_input', FAILED_ITEM_DETAIL, [FAILED_ITEM]);
    await composer.getByRole('button', { name: 'Send and retry Action' }).click();
    const request = await inputRequest;
    await respondToWorkCenterOp(
      mockAgent, 'list', { items: [FAILED_ITEM], watcher: { enabled: true } }, [FAILED_ITEM],
    );
    expect(request.payload).toMatchObject({
      id: OPEN_ITEM.id, actionId: 'action-1', revision: 1,
      attachments: [expect.objectContaining({
        fileId: expect.any(String), name: 'follow-up.txt', mimeType: 'text/plain', size: 9,
      })],
    });
  });

  test('uses mobile board lane tabs and lane-specific empty states', async ({ chatPage, mockAgent }) => {
    await openWorkCenter(chatPage, mockAgent);
    await chatPage.setViewportSize({ width: 720, height: 780 });

    await chatPage.getByRole('tab', { name: /Closed/ }).click();
    const closedLane = chatPage.locator('.work-center-board-lane[data-lane="closed"]');
    await expect(closedLane).toBeVisible();
    await expect(closedLane.locator('.work-center-board-empty')).toHaveText('No work items');
    await expect(closedLane.locator('.work-center-card')).toHaveCount(0);

    await chatPage.getByRole('tab', { name: /Active/ }).click();
    const activeLane = chatPage.locator('.work-center-board-lane[data-lane="active"]');
    await expect(activeLane).toBeVisible();
    await expect(activeLane.locator('.work-center-card')).toHaveCount(1);
  });
});
