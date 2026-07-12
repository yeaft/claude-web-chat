import { expect } from '@playwright/test';
import { test } from '../../fixtures/test-server.js';

const WORK_CENTER_SETTINGS = {
  settings: {
    version: 1,
    defaultWorkflowId: 'software-change',
    startImmediately: true,
    defaultWorkDir: '/tmp/test',
    globalInstructions: 'Follow the Agent release policy for every Action.',
    modelPolicy: { mode: 'specific', model: 'provider/review', effort: 'high' },
    actionInstructions: {
      triage: 'Plan the task', research: 'Research the problem', design: 'Design the solution',
      diagnose: 'Diagnose the root cause', implement: 'Implement the change', migrate: 'Migrate safely',
      test: 'Test the change', review: 'Review independently', document: 'Document the result',
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
  },
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
    loopCount: 3, toolCount: 8, progressRevision: 4,
    response: 'Implemented the layout fix and verified the responsive breakpoints.',
  }],
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

    const action = chatPage.locator('.work-center-action-card');
    await expect(action).toHaveCount(1);
    await expect(action).toContainText('Implement');
    await expect(action).toContainText('3 loops');
    await expect(action).toContainText('8 tools');
    await expect(action.locator('.work-center-action-body')).toHaveCount(0);
    await action.locator('.work-center-action-summary').click();
    await expect(action.locator('.work-center-action-response')).toContainText('Implemented the layout fix');
    await expect(action.locator('.work-center-run')).toHaveCount(0);

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
    const workDir = createModal.locator('input[placeholder="Project directory"]');
    await expect(workDir).toHaveValue('');
    await expect(createModal.getByRole('button', { name: 'Create', exact: true })).toBeDisabled();

    mockAgent.send({
      type: 'work_center_response', requestId: pendingSettings.requestId, op: pendingSettings.op, ok: true,
      data: WORK_CENTER_SETTINGS,
    });
    await expect(workDir).toHaveValue('/tmp/test');
    await createModal.locator('input').first().fill('Visible directory');
    await createModal.locator('textarea').first().fill('Use the directory shown in the form');
    const createRequest = respondToWorkCenterOp(mockAgent, 'create', OPEN_ITEM_DETAIL);
    await createModal.getByRole('button', { name: 'Create', exact: true }).click();
    const request = await createRequest;
    await respondToWorkCenterOp(mockAgent, 'list', { items: [OPEN_ITEM], watcher: { enabled: true } });
    expect(request.payload.workDir).toBe('/tmp/test');
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
    await expect(createModal.locator('input[placeholder="Project directory"]')).toHaveValue('/tmp/test');
  });

  test('opens a fixed settings shell for Action prompts and Work Center model policy', async ({ chatPage, mockAgent }) => {
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

    await expect(chatPage.locator('.work-center-policy-stage')).toHaveCount(14);
    await expect(chatPage.locator('.work-center-global-policy textarea')).toHaveValue('Follow the Agent release policy for every Action.');
    await expect(chatPage.locator('.work-center-policy-stage textarea').nth(1)).toHaveValue('Plan the task');
    await chatPage.getByRole('button', { name: 'Models', exact: true }).click();
    const modelStage = chatPage.locator('.work-center-model-stage');
    await expect(modelStage).toHaveCount(1);
    await expect(modelStage).toContainText('All Work Center Actions');
    const effort = modelStage.locator('.work-center-model-effort');
    await expect(effort).toContainText('Reasoning effort');
    await expect(effort.locator('select')).toHaveValue('high');
    await expect(effort.locator('select')).toBeEnabled();
    await expect(effort).toContainText('Overrides the selected model');

    await modelStage.locator('select').first().selectOption('inherit');
    await expect(effort).toBeVisible();
    await expect(effort.locator('select')).toBeDisabled();
    await expect(effort).toContainText('Select the Agent primary model');
    await expect(modal.getByRole('button', { name: 'General', exact: true })).toHaveCount(0);
  });

  test('opens settings returned by an older Agent without dynamic fields', async ({ chatPage, mockAgent }) => {
    await openWorkCenter(chatPage, mockAgent);
    const legacySettings = structuredClone(WORK_CENTER_SETTINGS);
    delete legacySettings.settings.actionInstructions;
    delete legacySettings.settings.modelPolicy;
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
    await expect(modal.locator('.work-center-policy-stage')).toHaveCount(14);
    const triagePrompt = modal.locator('.work-center-policy-stage textarea').nth(1);
    await expect(triagePrompt).toHaveValue('Legacy triage prompt.');
    await expect(triagePrompt).toBeDisabled();
    await expect(modal.getByText(/cannot save Work Center settings/)).toBeVisible();
    await expect(modal.locator('.work-center-settings-footer .btn-primary')).toBeDisabled();
    await modal.getByRole('button', { name: 'Models', exact: true }).click();
    await expect(modal.locator('.work-center-model-stage select').first()).toHaveValue('specific');
    await expect(modal.locator('.work-center-model-stage select').first()).toBeDisabled();
    await expect(modal.locator('.work-center-model-stage select').last()).toHaveValue('high');
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
    await expect(chatPage.locator('.work-center-policy-stage')).toHaveCount(14);
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
    const effort = modal.locator('.work-center-model-effort');
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

    await chatPage.locator('.work-center-modal input').first().fill('Fix dynamic planning');
    await chatPage.locator('.work-center-modal textarea').first().fill('Let AI choose the smallest safe flow');
    const createRequest = respondToWorkCenterOp(mockAgent, 'create', OPEN_ITEM_DETAIL);
    await chatPage.getByRole('button', { name: 'Create', exact: true }).click();
    const request = await createRequest;
    expect(request.payload).not.toHaveProperty('workflowTemplate');
    expect(request.payload).not.toHaveProperty('stageOverrides');
  });

  test('uploads files and binds their references to the Work Item create request', async ({ chatPage, mockAgent }) => {
    await openWorkCenter(chatPage, mockAgent);
    await chatPage.locator('.work-center-header-create').click();
    await chatPage.locator('.work-center-modal input').first().fill('Inspect uploaded screenshot');
    await chatPage.locator('.work-center-modal textarea').first().fill('Use the screenshot in every Action');

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
