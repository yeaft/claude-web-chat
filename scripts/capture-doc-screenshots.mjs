#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { MockAgent } from '../e2e/fixtures/mock-agent.js';
import {
  projectWorkItemDetail,
  projectWorkItemSummary,
} from '../agent/yeaft/work-center/projection.js';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const port = Number(process.env.YEAFT_DOC_SCREENSHOT_PORT || 3469);
const serverUrl = `http://127.0.0.1:${port}`;
const outputRoot = process.env.YEAFT_DOC_SCREENSHOT_OUTPUT_DIR
  ? resolve(root, process.env.YEAFT_DOC_SCREENSHOT_OUTPUT_DIR)
  : resolve(root, 'docs/images');
const viewport = { width: 2560, height: 1440 };
const workCenterDefaultWorkDir = '/home/projects/yeaft-web-code-agent';
const baseNow = Date.UTC(2026, 7, 3, 9, 30, 0);
const failWorkCenterOp = String(process.env.YEAFT_DOC_SCREENSHOT_FAIL_WORK_CENTER_OP || '').trim();
const injectableWorkCenterOps = new Set(['', 'list', 'get', 'get_settings']);
if (!injectableWorkCenterOps.has(failWorkCenterOp)) {
  throw new Error(`Unsupported YEAFT_DOC_SCREENSHOT_FAIL_WORK_CENTER_OP: ${failWorkCenterOp}`);
}
const sleep = ms => new Promise(resolvePromise => setTimeout(resolvePromise, ms));

function action({ id, sequence, type, status, vpId, vpName, objective, approach, expectedOutcome, response, stats, dependsOnStageIds = [] }) {
  return {
    action: {
      id,
      generation: 1,
      sequence,
      type,
      stageId: type,
      status,
      requiredRole: '',
      assignmentPolicy: { mode: 'auto', capability: type, fixedVpId: null },
      dependsOnStageIds,
      workspaceMode: type === 'review' ? 'read' : 'shared',
      brief: { objective, approach, expectedOutcome },
      canonicalResult: status === 'completed'
        ? { status: 'completed', summary: response, evidence: [{ kind: 'summary', label: response }] }
        : null,
      progressRevision: sequence,
    },
    run: status === 'ready' ? null : {
      id: `run-${id}`,
      actionId: id,
      actionGeneration: 1,
      actionAttempt: 1,
      status,
      startedAt: baseNow - (7 - sequence) * 600_000,
      ...(status === 'completed' ? { endedAt: baseNow - (6 - sequence) * 600_000 } : {}),
      vpSnapshot: { id: vpId, name: vpName },
      response,
      progressRevision: sequence,
      ...stats,
    },
  };
}

const actionSpecs = [
  action({
    id: 'action-triage', sequence: 1, type: 'triage', status: 'completed', vpId: 'omni', vpName: 'Omni',
    objective: 'Define the public documentation contract',
    approach: 'Inventory the current runtime boundaries, user paths, and bilingual pages before editing.',
    expectedOutcome: 'A fact-checked scope with explicit unsupported claims.',
    response: 'Locked the product vocabulary to Agent, Session, VP, Project, WorkItem, Action, and Run.',
    stats: { llmRequestCount: 2, loopCount: 3, toolCount: 5, totalTokens: 18_400 },
  }),
  action({
    id: 'action-audit', sequence: 2, type: 'research', status: 'completed', vpId: 'ada', vpName: 'Ada',
    dependsOnStageIds: ['triage'],
    objective: 'Audit current code and tests for feature evidence',
    approach: 'Trace each user-facing claim to the current implementation, protocol, or test suite.',
    expectedOutcome: 'An evidence map for Sessions, Projects, providers, memory, tools, and Work Center.',
    response: 'Verified native provider protocols, 33 built-in tools, scoped Project recall, and the current Work Center graph scheduler.',
    stats: { llmRequestCount: 4, loopCount: 7, toolCount: 19, totalTokens: 46_200 },
  }),
  action({
    id: 'action-write', sequence: 3, type: 'document', status: 'completed', vpId: 'linus', vpName: 'Linus',
    dependsOnStageIds: ['research'],
    objective: 'Rewrite the bilingual entry documentation',
    approach: 'Keep English and Chinese information architecture aligned and replace legacy group-mode wording.',
    expectedOutcome: 'Accurate README and VitePress guides with current navigation.',
    response: 'Rebuilt the bilingual landing pages and added focused Session, Project, Work Center, and CLI guides.',
    stats: { llmRequestCount: 5, loopCount: 10, toolCount: 27, totalTokens: 72_800 },
  }),
  action({
    id: 'action-review', sequence: 4, type: 'review', status: 'running', vpId: 'martin', vpName: 'Martin',
    dependsOnStageIds: ['document'],
    objective: 'Review feature claims and visual evidence independently',
    approach: 'Compare documentation claims with code, tests, generated screenshots, and compatibility boundaries.',
    expectedOutcome: 'Approval or concrete blockers before merge.',
    response: 'Reviewing Session/Project ownership, Work Center recovery semantics, and all screenshot captions.',
    stats: { llmRequestCount: 3, loopCount: 5, toolCount: 11, totalTokens: 34_600 },
  }),
  action({
    id: 'action-deliver', sequence: 5, type: 'deliver', status: 'ready', vpId: 'linus', vpName: 'Linus',
    dependsOnStageIds: ['review'],
    objective: 'Publish the reviewed documentation release',
    approach: 'Merge only the approved commit, tag the merged main commit, and verify documentation deployment.',
    expectedOutcome: 'Traceable bilingual documentation and high-resolution light-theme assets.',
    response: 'Waiting for independent review.',
    stats: { llmRequestCount: 0, loopCount: 0, toolCount: 0, totalTokens: 0 },
  }),
];

const actions = actionSpecs.map(spec => spec.action);
const runs = actionSpecs.map(spec => spec.run).filter(Boolean);
const rawWorkItemDetail = {
  id: 'docs-current-product',
  revision: 4,
  planRevision: 2,
  ledgerRevision: 8,
  coordinatorRevision: 3,
  title: 'Refresh bilingual product documentation',
  goal: 'Make the English and Chinese documentation describe the current Session, Project, provider, memory, and Work Center behavior with verified high-resolution screenshots.',
  status: 'running',
  lifecycle: 'active',
  attentionState: 'none',
  workItemType: 'software-change',
  workDir: workCenterDefaultWorkDir,
  workflowTemplate: 'ai-planned',
  planningMode: 'ai',
  executionMode: 'graph',
  acceptanceCriteria: [
    'English and Chinese entry documentation describe the same current product model',
    'Every new feature claim is supported by current code, tests, or a runnable UI path',
    'Documentation screenshots use the current light theme at 2560 × 1440',
  ],
  activeActionIds: ['action-review', 'action-deliver'],
  attentionActionIds: [],
  currentActionId: 'action-review',
  actions,
  runs,
  events: [],
  messages: [
    {
      id: 'work-user', role: 'user', status: 'completed',
      text: 'Update the English and Chinese documentation from the latest code. Replace stale screenshots with high-resolution light-theme captures, and keep every feature definition accurate.',
      createdAt: baseNow - 5_400_000, updatedAt: baseNow - 5_400_000,
    },
    {
      id: 'work-coordinator', role: 'assistant', status: 'completed',
      speaker: { id: 'omni', name: 'Omni' },
      text: 'The documentation contract is frozen. Three Actions are complete; independent review is checking feature boundaries and visual evidence before delivery.',
      createdAt: baseNow - 420_000, updatedAt: baseNow - 420_000,
    },
  ],
  createdAt: baseNow - 5_400_000,
  updatedAt: baseNow - 300_000,
};
const workItemDetail = projectWorkItemDetail(rawWorkItemDetail);
const workItem = projectWorkItemSummary(rawWorkItemDetail);
if (Object.hasOwn(workItemDetail, 'workDir') || Object.hasOwn(workItem, 'workDir')) {
  throw new Error('Work Center screenshot projection leaked workDir');
}
const readyAction = workItemDetail.actions.find(item => item.id === 'action-deliver');
if (!readyAction || readyAction.status !== 'ready' || readyAction.assignedVp) {
  throw new Error('Ready screenshot Action must remain unassigned after projection');
}
const workCenterVps = [
  { id: 'omni', name: 'Omni' },
  { id: 'ada', name: 'Ada' },
  { id: 'linus', name: 'Linus' },
  { id: 'martin', name: 'Martin' },
];

const sessionRows = [
  {
    catalogKey: 'yeaft:agent:docs-session',
    runtimeProvider: 'yeaft',
    routeRef: { runtimeProvider: 'yeaft', agentId: 'agent', sessionId: 'docs-session' },
    title: 'Documentation accuracy review',
    workDir: '/home/projects/yeaft-web-code-agent',
    availability: 'online',
    createdAt: new Date(baseNow - 7_200_000).toISOString(),
    metadataUpdatedAt: new Date(baseNow - 300_000).toISOString(),
    sortRank: 0,
  },
  {
    catalogKey: 'yeaft:agent:provider-session',
    runtimeProvider: 'yeaft',
    routeRef: { runtimeProvider: 'yeaft', agentId: 'agent', sessionId: 'provider-session' },
    title: 'Provider compatibility audit',
    workDir: '/home/projects/yeaft-web-code-agent',
    availability: 'online',
    createdAt: new Date(baseNow - 86_400_000).toISOString(),
    metadataUpdatedAt: new Date(baseNow - 3_600_000).toISOString(),
    sortRank: 1,
  },
  {
    catalogKey: 'chat:agent:cli-session',
    runtimeProvider: 'claude-code',
    routeRef: { runtimeProvider: 'claude-code', agentId: 'agent', conversationId: 'cli-session' },
    title: 'CLI release checks',
    workDir: '/home/projects/yeaft-web-code-agent',
    availability: 'online',
    createdAt: new Date(baseNow - 172_800_000).toISOString(),
    metadataUpdatedAt: new Date(baseNow - 7_200_000).toISOString(),
    sortRank: 2,
  },
];

const sessionProjects = [{
  id: 'project-docs',
  name: 'Yeaft Documentation',
  instruction: 'Keep public claims aligned with current code and preserve English/Chinese parity.',
  sortOrder: 0,
  members: [
    { agentId: 'agent', sessionId: 'docs-session' },
    { agentId: 'agent', sessionId: 'provider-session' },
  ],
}];

const sessionMessages = [
  {
    id: 'session-user-1', messageId: 'session-user-1', type: 'user', sessionId: 'docs-session',
    turnId: 'session-user-1', timestamp: baseNow - 3_600_000, isStreaming: false,
    content: 'Audit the latest product surface, rewrite the bilingual documentation, and regenerate only high-resolution light-theme screenshots. Do not present roadmap work as shipped.',
  },
  {
    id: 'session-linus', messageId: 'session-linus', type: 'assistant', sessionId: 'docs-session',
    turnId: 'turn-linus', vpId: 'linus', speakerVpId: 'linus', timestamp: baseNow - 2_400_000,
    isStreaming: false,
    content: 'Updated the documentation from current code evidence.\n\n**Verified product model**\n- Agent-local execution and storage boundaries\n- One native Session model with 1..N VPs\n- Project instructions with scoped sibling-Session recall\n- 33 built-in native tools plus Skills and MCP\n- Work Center as WorkItem → Action → Run, separate from Session data\n\nEnglish and Chinese entry pages now share the same structure.',
  },
  {
    id: 'session-tool-summary-1', messageId: 'session-tool-summary-1', type: 'tool-summary',
    sessionId: 'docs-session', turnId: 'turn-linus', vpId: 'linus', speakerVpId: 'linus',
    timestamp: baseNow - 2_390_000, count: 18, omittedCount: 18, source: 'history', isStreaming: false,
  },
  {
    id: 'session-user-2', messageId: 'session-user-2', type: 'user', sessionId: 'docs-session',
    turnId: 'session-user-2', timestamp: baseNow - 1_200_000, isStreaming: false,
    content: '@Martin Review the feature definitions, both languages, and the regenerated screenshots against the current implementation. Report blockers instead of polishing unsupported claims.',
  },
  {
    id: 'session-martin', messageId: 'session-martin', type: 'assistant', sessionId: 'docs-session',
    turnId: 'turn-martin', vpId: 'martin', speakerVpId: 'martin', timestamp: baseNow - 600_000,
    isStreaming: false,
    content: '**Independent review in progress**\n\nThe new structure correctly separates vendor CLI conversations, native Sessions, Projects, and Agent-level Work Center. I am checking exact CLI flags, Project memory boundaries, Action concurrency, and every screenshot caption before approval. No roadmap capability is being treated as current behavior.',
  },
  {
    id: 'session-tool-summary-2', messageId: 'session-tool-summary-2', type: 'tool-summary',
    sessionId: 'docs-session', turnId: 'turn-martin', vpId: 'martin', speakerVpId: 'martin',
    timestamp: baseNow - 590_000, count: 9, omittedCount: 9, source: 'history', isStreaming: false,
  },
];

function startServer() {
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(port),
      SERVER_HOST: '127.0.0.1',
      SKIP_AUTH: 'true',
      NODE_ENV: 'test',
      TEST_DB_DIR: `/tmp/yeaft-doc-screenshots-${process.pid}`,
      WEB_DIR: resolve(root, 'web'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error('Documentation screenshot server start timeout')), 20_000);
    const onData = data => {
      const text = data.toString();
      if (text.includes('Server running on')) {
        clearTimeout(timer);
        resolvePromise(child);
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', data => {
      const text = data.toString();
      if (text.includes('EADDRINUSE')) {
        clearTimeout(timer);
        reject(new Error(`Port ${port} is already in use`));
      }
    });
    child.once('error', reject);
    child.once('exit', code => {
      clearTimeout(timer);
      reject(new Error(`Documentation screenshot server exited early (${code})`));
    });
  });
}

async function stopChild(child) {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([
    new Promise(resolvePromise => child.once('exit', resolvePromise)),
    sleep(3_000).then(() => { if (child.exitCode === null) child.kill('SIGKILL'); }),
  ]);
}

async function seedPage(page, { locale, agentId }) {
  await page.evaluate(({ locale: nextLocale, agentId: nextAgentId, now, rows, projects, messages }) => {
    const chat = window.Pinia.useChatStore();
    const sessions = window.Pinia.useSessionsStore();
    const vp = window.Pinia.useVpStore();
    const sessionId = 'docs-session';
    const conversationId = 'yeaft-docs-current';
    const localized = nextLocale === 'zh-CN';

    chat.changeLocale(nextLocale);
    chat.agents = [{
      id: nextAgentId,
      name: localized ? 'Yeaft 文档工作站' : 'Yeaft Docs Workstation',
      online: true,
      status: 'ready',
      workDir: '/home/projects/yeaft-web-code-agent',
      capabilities: ['yeaft', 'work_center', 'work_center_message_v2', 'work_item_attachments', 'terminal', 'file_editor'],
    }];
    chat.currentAgent = nextAgentId;
    chat.currentAgentInfo = chat.agents[0];
    chat.currentView = 'yeaft';
    chat.workCenterOpen = false;
    chat.yeaftConversationId = conversationId;
    chat.yeaftConversationIdsByAgent = { [nextAgentId]: conversationId };
    chat.yeaftSessionAgentById = { [sessionId]: nextAgentId, 'provider-session': nextAgentId };
    chat.yeaftSessionReady = true;
    chat.yeaftModel = 'github-copilot/claude-sonnet-4.5';
    chat.yeaftModelEffort = 'high';
    chat.yeaftAvailableModels = [{
      id: 'claude-sonnet-4.5',
      ref: 'github-copilot/claude-sonnet-4.5',
      provider: 'github-copilot',
      label: 'Claude Sonnet 4.5',
      contextWindow: 200000,
      effortOptions: ['medium', 'high'],
    }];
    chat.yeaftStatus = { skills: 8, mcpServers: [], tools: 33 };
    chat.messagesMap[conversationId] = messages;
    chat.applySessionCatalogSnapshot(
      rows.map(row => ({
        ...row,
        catalogKey: row.catalogKey.replaceAll(':agent:', `:${nextAgentId}:`),
        routeRef: { ...row.routeRef, agentId: nextAgentId },
      })),
      projects.map(project => ({
        ...project,
        name: localized ? 'Yeaft 文档' : project.name,
        members: project.members.map(member => ({ ...member, agentId: nextAgentId })),
      })),
    );
    sessions.applySnapshot([{
      id: sessionId,
      name: localized ? '文档准确性审查' : 'Documentation accuracy review',
      title: localized ? '文档准确性审查' : 'Documentation accuracy review',
      roster: ['linus', 'martin'],
      defaultVpId: 'linus',
      announcement: localized
        ? '公开文档必须由当前代码和测试证明；规划能力不得写成已发布功能。'
        : 'Public documentation must be proven by current code and tests; roadmap work is not a shipped feature.',
      workDir: '/home/projects/yeaft-web-code-agent',
      updatedAt: now,
      config: { model: 'github-copilot/claude-sonnet-4.5', modelEffort: 'high' },
    }, {
      id: 'provider-session',
      name: localized ? 'Provider 兼容审计' : 'Provider compatibility audit',
      roster: ['ada'], defaultVpId: 'ada', workDir: '/home/projects/yeaft-web-code-agent', updatedAt: now - 3_600_000,
    }], nextAgentId);
    sessions.setActive(sessionId, nextAgentId);
    chat.yeaftActiveSessionFilter = sessionId;
    vp.applySnapshot({ vps: [
      { vpId: 'linus', displayName: 'Linus', displayNameZh: 'Linus', role: 'Systems Engineer', roleZh: '系统工程师', description: 'Implements small, verified changes and owns delivery.', descriptionZh: '负责最小、可验证的实现与交付。' },
      { vpId: 'martin', displayName: 'Martin', displayNameZh: 'Martin', role: 'Independent Reviewer', roleZh: '独立审查者', description: 'Reviews correctness, boundaries, regressions, and release evidence.', descriptionZh: '审查正确性、边界、回归和发布证据。' },
      { vpId: 'ada', displayName: 'Ada', displayNameZh: 'Ada', role: 'Research and Test', roleZh: '调研与测试', description: 'Builds evidence maps and verifies behavior.', descriptionZh: '建立事实证据并验证行为。' },
      { vpId: 'omni', displayName: 'Omni', displayNameZh: 'Omni', role: 'Coordinator', roleZh: '协调者', description: 'Turns goals into explicit contracts and handoffs.', descriptionZh: '把目标转成明确合同与交接。' },
    ] }, nextAgentId);
  }, {
    locale,
    agentId,
    now: baseNow,
    rows: sessionRows,
    projects: sessionProjects,
    messages: sessionMessages,
  });

  await page.waitForSelector('.yeaft-page');
  await page.waitForSelector('.vp-turn-block');
  await page.evaluate(() => {
    document.documentElement.setAttribute('data-theme', 'light');
    localStorage.setItem('theme', 'light');
    const list = document.querySelector('.message-list, .yeaft-message-list');
    if (list) list.scrollTop = list.scrollHeight;
  });
  await page.waitForFunction(() => document.documentElement.getAttribute('data-theme') === 'light');
  await page.waitForTimeout(500);
}

function browserFailureMessage(kind, value) {
  return `[browser:${kind}] ${String(value || '').trim()}`;
}

async function assertScreenshotPageClean(page, browserFailures, label) {
  const visibleErrors = await page.locator([
    '.work-center-error:visible',
    '.work-center-detail-error:visible',
    '.work-center-settings-error:visible',
    '[role="alert"]:visible',
    '.sp-toast.error:visible',
  ].join(', ')).allTextContents();
  const normalizedErrors = visibleErrors.map(text => text.trim()).filter(Boolean);
  if (browserFailures.length || normalizedErrors.length) {
    throw new Error([
      `${label} contains unexpected browser/UI errors.`,
      ...browserFailures,
      ...normalizedErrors.map(text => `[visible-error] ${text}`),
    ].join('\n'));
  }
}

async function captureLocale(browser, agent, locale, prefix) {
  const context = await browser.newContext({
    viewport,
    deviceScaleFactor: 1,
    colorScheme: 'light',
    reducedMotion: 'reduce',
    locale: locale === 'zh-CN' ? 'zh-CN' : 'en-US',
  });
  const page = await context.newPage();
  const browserFailures = [];
  page.on('console', message => {
    const entry = browserFailureMessage(`console:${message.type()}`, message.text());
    console.error(entry);
    if (message.type() === 'error') browserFailures.push(entry);
  });
  page.on('pageerror', error => {
    const entry = browserFailureMessage('pageerror', error.stack || error.message);
    browserFailures.push(entry);
    console.error(entry);
  });
  page.on('requestfailed', request => {
    const entry = browserFailureMessage('requestfailed', `${request.url()} ${request.failure()?.errorText || ''}`);
    browserFailures.push(entry);
    console.error(entry);
  });
  await page.addInitScript(({ locale: nextLocale }) => {
    localStorage.setItem('theme', 'light');
    localStorage.setItem('theme-follow-system', 'false');
    localStorage.setItem('locale', nextLocale);
    localStorage.setItem('yeaft-preferred-conversation-view', 'yeaft');
    localStorage.setItem('preferred-conversation-view', 'yeaft');
  }, { locale });
  await page.goto(serverUrl, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => window.Pinia?.useChatStore && window.Pinia?.useSessionsStore && window.Pinia?.useVpStore);
  await seedPage(page, { locale, agentId: agent.agentId });

  const sessionPath = resolve(outputRoot, prefix, 'session.png');
  await assertScreenshotPageClean(page, browserFailures, `${locale} Session screenshot`);
  await page.screenshot({ path: sessionPath, type: 'png', fullPage: false });

  await page.evaluate(({ agentId, item, detail, vps, injectedFailureOp, defaultWorkDir }) => {
    const chat = window.Pinia.useChatStore();
    const localized = chat.locale === 'zh-CN';
    const localItem = {
      ...item,
      title: localized ? '刷新双语产品文档' : item.title,
      goal: localized
        ? '让中英文文档准确描述当前 Session、Project、provider、memory 和 Work Center 行为，并提供已验证的高清截图。'
        : item.goal,
    };
    const localDetail = {
      ...detail,
      ...localItem,
      messages: detail.messages.map(message => message.role === 'user' && localized
        ? { ...message, text: '基于最新代码更新中英文文档与高清 light theme 截图；所有 feature 定义必须准确。' }
        : message),
    };
    const runtime = {
      defaultWorkDir,
      workItemAttachments: true,
      workItemTypes: [{ id: 'software-change', name: localized ? '软件变更' : 'Software change', actionCount: 5 }],
      vps,
      models: [{ id: 'review', ref: 'github-copilot/claude-sonnet-4.5', provider: 'github-copilot', label: 'Claude Sonnet 4.5', effortOptions: ['medium', 'high'] }],
      primaryModel: 'github-copilot/claude-sonnet-4.5',
    };
    const settings = { defaultWorkDir, startImmediately: true };
    chat.workCenterAgentId = agentId;
    chat.workCenterItemsByAgent = { [agentId]: [] };
    chat.workCenterDetailByAgent = { [agentId]: null };
    chat.workCenterLoadedByAgent = { [agentId]: false };
    chat.workCenterLoadingByAgent = { [agentId]: false };
    chat.workCenterErrorByAgent = { [agentId]: null };
    chat.workCenterWatcherByAgent = { [agentId]: null };
    chat.workCenterSettingsByAgent = { [agentId]: null };
    chat.workCenterRuntimeByAgent = { [agentId]: null };
    chat.workCenterSettingsLoadingByAgent = { [agentId]: false };
    chat.workCenterSettingsErrorByAgent = { [agentId]: null };
    window.__yeaftScreenshotWorkCenterRequests = {};
    chat.workCenterRequest = async (op, data, targetAgentId) => {
      if (targetAgentId !== agentId) {
        throw new Error(`Unexpected screenshot Work Center Agent: ${targetAgentId}`);
      }
      const requestState = window.__yeaftScreenshotWorkCenterRequests;
      requestState[op] = { requested: true, completed: false, failed: false };
      try {
        if (op === injectedFailureOp) throw new Error(`Injected screenshot ${op} failure`);
        let result;
        if (op === 'list') result = { items: [localItem], nextCursor: null, watcher: { enabled: true } };
        else if (op === 'get' && data?.id === localDetail.id) result = localDetail;
        else if (op === 'get_settings') result = { settings, runtime };
        else throw new Error(`Unexpected screenshot Work Center request: ${op}`);
        requestState[op].completed = true;
        return result;
      } catch (error) {
        requestState[op].failed = true;
        requestState[op].error = error?.message || String(error);
        throw error;
      }
    };
    chat.workCenterOpen = true;
  }, {
    agentId: agent.agentId,
    item: workItem,
    detail: workItemDetail,
    vps: workCenterVps,
    injectedFailureOp: failWorkCenterOp,
    defaultWorkDir: workCenterDefaultWorkDir,
  });

  await page.waitForSelector('.work-center-main');
  await page.waitForFunction(({ agentId }) => {
    const chat = window.Pinia.useChatStore();
    const requests = window.__yeaftScreenshotWorkCenterRequests || {};
    const listTerminal = requests.list?.completed || requests.list?.failed;
    const settingsTerminal = requests.get_settings?.completed || requests.get_settings?.failed;
    return listTerminal
      && settingsTerminal
      && !chat.workCenterLoadingByAgent[agentId]
      && !chat.workCenterSettingsLoadingByAgent[agentId];
  }, { agentId: agent.agentId });
  const initialization = await page.evaluate(({ agentId, id }) => {
    const chat = window.Pinia.useChatStore();
    const requests = window.__yeaftScreenshotWorkCenterRequests || {};
    return {
      requests,
      listError: chat.workCenterErrorByAgent[agentId] || '',
      settingsError: chat.workCenterSettingsErrorByAgent[agentId] || '',
      listLoading: Boolean(chat.workCenterLoadingByAgent[agentId]),
      settingsLoading: Boolean(chat.workCenterSettingsLoadingByAgent[agentId]),
      hasItem: chat.workCenterItemsByAgent[agentId]?.some(item => item.id === id) === true,
      settingsDefaultWorkDir: chat.workCenterSettingsByAgent[agentId]?.defaultWorkDir || '',
      settingsStartImmediately: chat.workCenterSettingsByAgent[agentId]?.startImmediately,
      runtimeDefaultWorkDir: chat.workCenterRuntimeByAgent[agentId]?.defaultWorkDir || '',
      runtimePrimaryModel: chat.workCenterRuntimeByAgent[agentId]?.primaryModel || '',
    };
  }, { agentId: agent.agentId, id: workItem.id });
  const initializationFailures = [...new Set([
    initialization.requests.list?.error,
    initialization.requests.get_settings?.error,
    initialization.listError,
    initialization.settingsError,
    initialization.listLoading ? 'Work Center list request is still loading' : '',
    initialization.settingsLoading ? 'Work Center settings request is still loading' : '',
    !initialization.requests.list?.completed ? 'Work Center list request did not complete' : '',
    !initialization.requests.get_settings?.completed ? 'Work Center get_settings request did not complete' : '',
    !initialization.hasItem ? 'Work Center list response did not populate the item' : '',
    initialization.settingsDefaultWorkDir !== workCenterDefaultWorkDir
      ? 'Work Center settings response did not populate defaultWorkDir' : '',
    initialization.settingsStartImmediately !== true
      ? 'Work Center settings response did not populate startImmediately' : '',
    initialization.runtimeDefaultWorkDir !== workCenterDefaultWorkDir
      ? 'Work Center settings response did not populate runtime defaultWorkDir' : '',
    initialization.runtimePrimaryModel !== 'github-copilot/claude-sonnet-4.5'
      ? 'Work Center settings response did not populate runtime primaryModel' : '',
  ].filter(Boolean))];
  if (initializationFailures.length) {
    throw new Error(`${locale} Work Center initialization failed:\n${initializationFailures.join('\n')}`);
  }
  await assertScreenshotPageClean(page, browserFailures, `${locale} Work Center initialization`);
  await page.locator('.work-center-card-open').first().click();
  await page.waitForFunction(({ agentId, id }) => {
    const chat = window.Pinia.useChatStore();
    const request = window.__yeaftScreenshotWorkCenterRequests?.get;
    return request?.failed || (request?.completed && chat.workCenterDetailByAgent[agentId]?.id === id);
  }, { agentId: agent.agentId, id: workItem.id });
  const detailInitialization = await page.evaluate(({ agentId, id }) => {
    const chat = window.Pinia.useChatStore();
    const request = window.__yeaftScreenshotWorkCenterRequests?.get;
    return {
      failed: Boolean(request?.failed),
      completed: Boolean(request?.completed),
      error: request?.error || '',
      hasDetail: chat.workCenterDetailByAgent[agentId]?.id === id,
    };
  }, { agentId: agent.agentId, id: workItem.id });
  if (detailInitialization.failed || !detailInitialization.completed || !detailInitialization.hasDetail) {
    throw new Error(detailInitialization.error || `${locale} Work Center get request failed or did not populate detail`);
  }
  await page.waitForSelector('.work-center-conversation-pane');
  await page.locator('.work-center-actions-button').click();
  await page.waitForSelector('.work-center-action-list');
  await page.waitForTimeout(500);
  const workCenterPath = resolve(outputRoot, prefix, 'work-center.png');
  await assertScreenshotPageClean(page, browserFailures, `${locale} Work Center screenshot`);
  await page.screenshot({ path: workCenterPath, type: 'png', fullPage: false });

  const theme = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
  if (theme !== 'light') throw new Error(`Expected light theme, received ${theme}`);
  for (const selector of ['.work-center-main', '.work-center-body', '.work-center-detail-layout']) {
    const overflow = await page.locator(selector).evaluate(element => element.scrollWidth > element.clientWidth + 1);
    if (overflow) throw new Error(`Horizontal overflow in ${selector}`);
  }

  await context.close();
  return [sessionPath, workCenterPath];
}

await mkdir(outputRoot, { recursive: true });
await mkdir(resolve(outputRoot, 'zh-CN'), { recursive: true });
let server;
let agent;
let browser;
try {
  server = await startServer();
  agent = new MockAgent(serverUrl, 'Yeaft Docs Workstation');
  await agent.connect();
  browser = await chromium.launch({ headless: true });
  const english = await captureLocale(browser, agent, 'en', '.');
  const chinese = await captureLocale(browser, agent, 'zh-CN', 'zh-CN');
  for (const path of [...english, ...chinese]) console.log(path);
} finally {
  if (browser) await browser.close();
  if (agent) await agent.disconnect();
  await stopChild(server);
}
