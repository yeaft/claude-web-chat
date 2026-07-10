import { expect } from '@playwright/test';
import { test } from '../../fixtures/test-server.js';

const WORK_CENTER_SETTINGS = {
  settings: {
    version: 1,
    defaultWorkflowId: 'software-change',
    startImmediately: true,
    defaultWorkDir: '/tmp/test',
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
      { id: 'review', ref: 'provider/review', provider: 'provider', label: 'review' },
    ],
    primaryModel: 'provider/primary',
    fastModel: null,
  },
};

const PLAN_PREVIEW = {
  valid: true,
  stages: [
    { id: 'triage', name: 'Triage', selectedVp: { id: 'omni', name: 'Omni' }, model: { provider: 'provider', id: 'provider/primary' }, error: null },
    { id: 'implement', name: 'Implement', selectedVp: { id: 'linus', name: 'Linus' }, model: { provider: 'provider', id: 'provider/primary' }, error: null },
    { id: 'review', name: 'Review', selectedVp: { id: 'martin', name: 'Martin' }, model: { provider: 'provider', id: 'provider/review', effort: 'high' }, error: null },
  ],
};

const OPEN_ITEM = {
  id: 'work-item-open',
  title: 'Fix Work Center layout',
  goal: 'Keep the Work Center usable at every supported viewport width.',
  status: 'running',
  updatedAt: Date.now(),
  currentAction: { id: 'action-1', type: 'implement', requiredRole: 'developer' },
};

const OPEN_ITEM_DETAIL = {
  ...OPEN_ITEM,
  revision: 1,
  currentActionId: 'action-1',
  workDir: '/tmp/project',
  workflowTemplate: 'software-change',
  acceptanceCriteria: ['The Action flow remains readable'],
  actions: [{
    id: 'action-1', sequence: 1, type: 'implement', requiredRole: 'developer', status: 'running',
  }],
  runs: [{
    id: 'run-1',
    actionId: 'action-1',
    status: 'running',
    startedAt: Date.now(),
    roleSnapshot: { id: 'developer' },
    modelSnapshot: { id: 'provider/model' },
    summary: 'Implementing the compact Action view.',
    evidence: [{ kind: 'test', label: 'Focused UI test', status: 'passed' }],
  }],
  events: [{ id: 1, type: 'run.started', createdAt: Date.now() }],
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

async function openWorkCenter(chatPage, mockAgent, items = [OPEN_ITEM]) {
  await chatPage.locator('.sidebar-work-center-trigger').click();

  const responses = (async () => {
    const data = { items, watcher: { enabled: true } };
    const responses = { list: data, get_settings: WORK_CENTER_SETTINGS };
    await respondByOperation(mockAgent, responses);
    await respondByOperation(mockAgent, responses);
    await respondByOperation(mockAgent, responses);
  })();

  await chatPage.locator('.sidebar-work-center-agent').first().click();
  await responses;
  await expect(chatPage.locator('.work-center-page')).toBeVisible();
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
      sidebar: rect('.work-center-sidebar'),
      main: rect('.work-center-main'),
      detail: rect('.work-center-detail'),
      mainClientWidth: main?.clientWidth || 0,
      mainScrollWidth: main?.scrollWidth || 0,
      bodyClientWidth: body?.clientWidth || 0,
      bodyScrollWidth: body?.scrollWidth || 0,
    };
  });
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

  test('maximizes and restores the Workbench without leaving the main area in the layout', async ({ chatPage, mockAgent }) => {
    await openWorkCenter(chatPage, mockAgent);
    await chatPage.setViewportSize({ width: 1440, height: 900 });

    await chatPage.locator('.work-center-sidebar .sidebar-icon-btn[title="Workbench"]').click();
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

    const action = chatPage.locator('.work-center-action-card');
    await expect(action).toHaveCount(1);
    await expect(action.locator('.work-center-action-body')).toBeVisible();
    await expect(action).toContainText('Implement');
    await expect(action).toContainText('Focused UI test');

    await chatPage.locator('.work-center-guidance textarea').fill('Keep the public API unchanged');
    const guide = respondToWorkCenterOp(mockAgent, 'guide', OPEN_ITEM_DETAIL);
    await chatPage.getByRole('button', { name: 'Send guidance' }).click();
    const request = await guide;
    await respondToWorkCenterOp(mockAgent, 'list', { items: [OPEN_ITEM], watcher: { enabled: true } });
    expect(request.op).toBe('guide');
    expect(request.payload).toMatchObject({
      id: OPEN_ITEM.id,
      guidance: 'Keep the public API unchanged',
      actionId: 'action-1',
      revision: 1,
    });
  });

  test('keeps Action guidance and cards visible without overflow in dark theme', async ({ chatPage, mockAgent }) => {
    await openWorkCenter(chatPage, mockAgent);
    const select = chatPage.locator('.work-center-card').click();
    await respondToWorkCenterOp(mockAgent, 'get', OPEN_ITEM_DETAIL);
    await select;

    await chatPage.evaluate(() => {
      document.documentElement.setAttribute('data-theme', 'dark');
      localStorage.setItem('theme', 'dark');
    });
    await expect(chatPage.locator('html')).toHaveAttribute('data-theme', 'dark');
    await expect(chatPage.locator('.work-center-action-card')).toBeVisible();
    await expect(chatPage.locator('.work-center-guidance textarea')).toBeVisible();

    const metrics = await layoutMetrics(chatPage);
    expect(metrics.documentScrollWidth).toBeLessThanOrEqual(metrics.viewportWidth);
    expect(metrics.bodyScrollWidth).toBeLessThanOrEqual(metrics.bodyClientWidth + 1);
    const colors = await chatPage.locator('.work-center-action-card').evaluate(element => {
      const style = getComputedStyle(element);
      return { background: style.backgroundColor, text: style.color, border: style.borderColor };
    });
    expect(colors.background).not.toBe('rgba(0, 0, 0, 0)');
    expect(colors.text).not.toBe(colors.background);
    expect(colors.border).not.toBe(colors.background);
  });

  test('keeps a create action available on mobile with existing work items', async ({ chatPage, mockAgent }) => {
    await openWorkCenter(chatPage, mockAgent);
    await chatPage.setViewportSize({ width: 720, height: 900 });
    await chatPage.waitForTimeout(350);

    await chatPage.locator('.sidebar-header-actions .sidebar-icon-btn[title="Collapse sidebar"]').click();
    await expect(chatPage.locator('.work-center-sidebar')).toHaveClass(/collapsed/);

    const create = chatPage.locator('.work-center-header-create');
    await expect(create).toBeVisible();
    await expect(create).toHaveAttribute('aria-label', 'New work item');
    await create.click();
    await expect(chatPage.locator('.work-center-modal')).toBeVisible();
  });

  test('opens a fixed settings shell and edits workflow assignment and models', async ({ chatPage, mockAgent }) => {
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

    await expect(chatPage.locator('.work-center-policy-stage')).toHaveCount(3);
    await chatPage.getByRole('button', { name: 'Models', exact: true }).click();
    await expect(chatPage.locator('.work-center-model-stage')).toHaveCount(3);
    await chatPage.getByRole('button', { name: 'Workflow', exact: true }).click();
    await chatPage.getByRole('button', { name: 'Add stage', exact: true }).click();
    await expect(chatPage.locator('.work-center-policy-stage')).toHaveCount(4);
  });

  test('keeps settings usable in dark theme and mobile viewport', async ({ chatPage, mockAgent }) => {
    await openWorkCenter(chatPage, mockAgent);
    await chatPage.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
    await chatPage.setViewportSize({ width: 720, height: 780 });
    await chatPage.locator('.work-center-sidebar .sidebar-icon-btn[title="Collapse sidebar"]').click();
    const settingsRequest = respondUntilOperation(mockAgent, 'get_settings', {
      list: { items: [OPEN_ITEM], watcher: { enabled: true } },
      get_settings: WORK_CENTER_SETTINGS,
    });
    await chatPage.locator('.work-center-header-actions .work-center-icon-button').first().click();
    await settingsRequest;

    const modal = chatPage.locator('.work-center-settings-card');
    await expect(modal).toBeVisible();
    await expect(chatPage.locator('.work-center-policy-stage')).toHaveCount(3);
    const metrics = await modal.evaluate(element => {
      const rect = element.getBoundingClientRect();
      const pane = element.querySelector('.work-center-settings-pane');
      return {
        left: rect.left,
        right: rect.right,
        top: rect.top,
        bottom: rect.bottom,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        paneScrollable: pane.scrollHeight >= pane.clientHeight,
        background: getComputedStyle(element).backgroundColor,
      };
    });
    expect(metrics.left).toBeGreaterThanOrEqual(0);
    expect(metrics.right).toBeLessThanOrEqual(metrics.viewportWidth);
    expect(metrics.top).toBeGreaterThanOrEqual(0);
    expect(metrics.bottom).toBeLessThanOrEqual(metrics.viewportHeight);
    expect(metrics.paneScrollable).toBe(true);
    expect(metrics.background).not.toBe('rgba(0, 0, 0, 0)');
  });

  test('previews the actual VP, Provider, and model before creating work', async ({ chatPage, mockAgent }) => {
    await openWorkCenter(chatPage, mockAgent);
    const previewRequest = respondUntilOperation(mockAgent, 'preview', {
      list: { items: [OPEN_ITEM], watcher: { enabled: true } },
      get_settings: WORK_CENTER_SETTINGS,
      preview: PLAN_PREVIEW,
    });
    await chatPage.locator('.work-center-header-create').click();
    await previewRequest;
    await expect(chatPage.locator('.work-center-plan-stages article')).toHaveCount(3);
    await expect(chatPage.locator('.work-center-plan-stages')).toContainText('Omni');
    await expect(chatPage.locator('.work-center-plan-stages')).toContainText('Martin');
    await expect(chatPage.locator('.work-center-plan-stages')).toContainText('provider/review');
  });

  test('uses filter-specific headings and empty states', async ({ chatPage, mockAgent }) => {
    await openWorkCenter(chatPage, mockAgent);

    await chatPage.getByRole('button', { name: 'Done', exact: true }).click();
    await expect(chatPage.getByRole('heading', { name: 'No completed work items' })).toBeVisible();
    await expect(chatPage.locator('.work-center-empty-state button')).toHaveCount(0);

    await chatPage.getByRole('button', { name: 'All', exact: true }).click();
    await expect(chatPage.locator('.work-center-list-heading')).toContainText('All work items');
    await expect(chatPage.locator('.work-center-card')).toHaveCount(1);
  });
});
