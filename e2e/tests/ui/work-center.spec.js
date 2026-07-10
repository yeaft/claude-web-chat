import { expect } from '@playwright/test';
import { test } from '../../fixtures/test-server.js';

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

async function openWorkCenter(chatPage, mockAgent, items = [OPEN_ITEM]) {
  await chatPage.locator('.sidebar-work-center-trigger').click();

  const responses = (async () => {
    const data = { items, watcher: { enabled: true } };
    await respondToWorkCenterRequest(mockAgent, data);
    await respondToWorkCenterRequest(mockAgent, data);
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
