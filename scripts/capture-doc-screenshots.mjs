#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { MockAgent } from '../e2e/fixtures/mock-agent.js';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const port = Number(process.env.YEAFT_DOC_SCREENSHOT_PORT || 3469);
const serverUrl = `http://127.0.0.1:${port}`;
const outputRoot = resolve(root, 'docs/images');
const viewport = { width: 2560, height: 1440 };
const baseNow = Date.UTC(2026, 7, 3, 9, 30, 0);
const sleep = ms => new Promise(resolvePromise => setTimeout(resolvePromise, ms));

function action({ id, sequence, type, status, vpId, vpName, objective, approach, expectedOutcome, response, stats }) {
  return {
    id,
    generation: 1,
    sequence,
    type,
    status,
    requiredRole: type,
    assignedVp: { id: vpId, name: vpName },
    brief: { objective, approach, expectedOutcome },
    contentSummary: response,
    canonicalResult: status === 'completed'
      ? { summary: response, evidence: [{ type: 'summary', text: response }] }
      : null,
    response,
    progressRevision: sequence,
    executionStats: stats,
    loopCount: stats.loopCount,
    toolCount: stats.toolCount,
    messages: [{
      id: `${id}:assistant`,
      role: 'assistant',
      status,
      speaker: { id: vpId, name: vpName },
      text: response,
      createdAt: baseNow - (6 - sequence) * 600_000,
      updatedAt: baseNow - (6 - sequence) * 600_000,
    }],
  };
}

const workItem = {
  id: 'docs-current-product',
  title: 'Refresh bilingual product documentation',
  goal: 'Make the English and Chinese documentation describe the current Session, Project, provider, memory, and Work Center behavior with verified high-resolution screenshots.',
  status: 'running',
  boardLane: 'active',
  workItemType: 'software-change',
  createdAt: baseNow - 5_400_000,
  updatedAt: baseNow - 300_000,
  actionCount: 5,
  completedActionCount: 3,
  currentAction: {
    id: 'action-review',
    generation: 1,
    type: 'review',
    status: 'running',
    objective: 'Review feature claims and visual evidence independently',
    assignedVp: { id: 'martin', name: 'Martin' },
  },
  activeAction: {
    id: 'action-review',
    generation: 1,
    type: 'review',
    status: 'running',
    objective: 'Review feature claims and visual evidence independently',
    assignedVp: { id: 'martin', name: 'Martin' },
  },
  actionCounts: { completed: 3, running: 1, ready: 1, waiting: 0, failed: 0 },
  executors: [
    { id: 'omni', name: 'Omni' },
    { id: 'linus', name: 'Linus' },
    { id: 'martin', name: 'Martin' },
  ],
};

const actions = [
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
    objective: 'Audit current code and tests for feature evidence',
    approach: 'Trace each user-facing claim to the current implementation, protocol, or test suite.',
    expectedOutcome: 'An evidence map for Sessions, Projects, providers, memory, tools, and Work Center.',
    response: 'Verified native provider protocols, 33 built-in tools, scoped Project recall, and the current Work Center graph scheduler.',
    stats: { llmRequestCount: 4, loopCount: 7, toolCount: 19, totalTokens: 46_200 },
  }),
  action({
    id: 'action-write', sequence: 3, type: 'document', status: 'completed', vpId: 'linus', vpName: 'Linus',
    objective: 'Rewrite the bilingual entry documentation',
    approach: 'Keep English and Chinese information architecture aligned and replace legacy group-mode wording.',
    expectedOutcome: 'Accurate README and VitePress guides with current navigation.',
    response: 'Rebuilt the bilingual landing pages and added focused Session, Project, Work Center, and CLI guides.',
    stats: { llmRequestCount: 5, loopCount: 10, toolCount: 27, totalTokens: 72_800 },
  }),
  action({
    id: 'action-review', sequence: 4, type: 'review', status: 'running', vpId: 'martin', vpName: 'Martin',
    objective: 'Review feature claims and visual evidence independently',
    approach: 'Compare documentation claims with code, tests, generated screenshots, and compatibility boundaries.',
    expectedOutcome: 'Approval or concrete blockers before merge.',
    response: 'Reviewing Session/Project ownership, Work Center recovery semantics, and all screenshot captions.',
    stats: { llmRequestCount: 3, loopCount: 5, toolCount: 11, totalTokens: 34_600 },
  }),
  action({
    id: 'action-deliver', sequence: 5, type: 'deliver', status: 'ready', vpId: 'linus', vpName: 'Linus',
    objective: 'Publish the reviewed documentation release',
    approach: 'Merge only the approved commit, tag the merged main commit, and verify documentation deployment.',
    expectedOutcome: 'Traceable bilingual documentation and high-resolution light-theme assets.',
    response: 'Waiting for independent review.',
    stats: { llmRequestCount: 0, loopCount: 0, toolCount: 0, totalTokens: 0 },
  }),
];

const workItemDetail = {
  ...workItem,
  revision: 4,
  planRevision: 2,
  ledgerRevision: 8,
  coordinatorRevision: 3,
  workDir: '/home/projects/yeaft-web-code-agent',
  workflowTemplate: 'ai-planned',
  planningMode: 'ai',
  acceptanceCriteria: [
    'English and Chinese entry documentation describe the same current product model',
    'Every new feature claim is supported by current code, tests, or a runnable UI path',
    'Documentation screenshots use the current light theme at 2560 × 1440',
  ],
  executionStats: {
    llmRequestCount: 14,
    loopCount: 25,
    toolCount: 62,
    inputTokens: 138_000,
    outputTokens: 24_000,
    cacheReadTokens: 47_000,
    cacheWriteTokens: 3_000,
    totalTokens: 212_000,
  },
  actionSummary: '3 completed · 1 running · 1 ready',
  currentActionId: 'action-review',
  actions,
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
};

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

async function captureLocale(browser, agent, locale, prefix) {
  const context = await browser.newContext({
    viewport,
    deviceScaleFactor: 1,
    colorScheme: 'light',
    reducedMotion: 'reduce',
    locale: locale === 'zh-CN' ? 'zh-CN' : 'en-US',
  });
  const page = await context.newPage();
  page.on('console', message => console.error(`[browser:${message.type()}] ${message.text()}`));
  page.on('pageerror', error => console.error(`[browser:pageerror] ${error.stack || error.message}`));
  page.on('requestfailed', request => console.error(`[browser:requestfailed] ${request.url()} ${request.failure()?.errorText || ''}`));
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
  await page.screenshot({ path: sessionPath, type: 'png', fullPage: false });

  await page.evaluate(({ agentId, item, detail }) => {
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
    chat.workCenterAgentId = agentId;
    chat.workCenterItemsByAgent = { [agentId]: [localItem] };
    chat.workCenterDetailByAgent = { [agentId]: localDetail };
    chat.workCenterLoadedByAgent = { [agentId]: true };
    chat.workCenterLoadingByAgent = { [agentId]: false };
    chat.workCenterErrorByAgent = { [agentId]: null };
    chat.workCenterWatcherByAgent = { [agentId]: { enabled: true } };
    chat.workCenterSettingsByAgent = { [agentId]: { defaultWorkDir: detail.workDir, startImmediately: true } };
    chat.workCenterRuntimeByAgent = { [agentId]: {
      defaultWorkDir: detail.workDir,
      workItemAttachments: true,
      workItemTypes: [{ id: 'software-change', name: localized ? '软件变更' : 'Software change', actionCount: 5 }],
      vps: detail.executors,
      models: [{ id: 'review', ref: 'github-copilot/claude-sonnet-4.5', provider: 'github-copilot', label: 'Claude Sonnet 4.5', effortOptions: ['medium', 'high'] }],
      primaryModel: 'github-copilot/claude-sonnet-4.5',
    } };
    chat.workCenterRequest = (op, data, targetAgentId) => {
      if (op === 'get' && data?.id === localDetail.id && targetAgentId === agentId) {
        return Promise.resolve(localDetail);
      }
      return Promise.reject(new Error(`Unexpected screenshot Work Center request: ${op}`));
    };
    chat.workCenterOpen = true;
  }, { agentId: agent.agentId, item: workItem, detail: workItemDetail });

  await page.waitForSelector('.work-center-main');
  await page.evaluate(({ agentId, detail }) => {
    const chat = window.Pinia.useChatStore();
    chat.workCenterDetailByAgent = { [agentId]: detail };
  }, { agentId: agent.agentId, detail: workItemDetail });
  await page.locator('.work-center-card-open').first().click();
  await page.waitForSelector('.work-center-conversation-pane');
  await page.locator('.work-center-actions-button').click();
  await page.waitForSelector('.work-center-action-list');
  await page.waitForTimeout(500);
  const workCenterPath = resolve(outputRoot, prefix, 'work-center.png');
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
