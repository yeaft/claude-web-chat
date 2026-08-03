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
const failureScenario = String(process.env.YEAFT_DOC_SCREENSHOT_FAILURE_SCENARIO || '').trim();
const injectableWorkCenterOps = new Set(['', 'list', 'get', 'get_settings']);
const injectableFailureScenarios = new Set([
  '',
  'post-screenshot-console',
  'post-screenshot-pageerror',
  'post-screenshot-requestfailed',
  'visible-typing-error',
  'server-exit',
]);
if (!injectableWorkCenterOps.has(failWorkCenterOp)) {
  throw new Error(`Unsupported YEAFT_DOC_SCREENSHOT_FAIL_WORK_CENTER_OP: ${failWorkCenterOp}`);
}
if (!injectableFailureScenarios.has(failureScenario)) {
  throw new Error(`Unsupported YEAFT_DOC_SCREENSHOT_FAILURE_SCENARIO: ${failureScenario}`);
}
if (failWorkCenterOp && failureScenario) {
  throw new Error('Only one documentation screenshot failure injection may be active');
}
const sleep = ms => new Promise(resolvePromise => setTimeout(resolvePromise, ms));

function createFatalLatch() {
  const failures = [];
  const seen = new Set();
  let resolveFailure;
  const failureSignal = new Promise(resolvePromise => { resolveFailure = resolvePromise; });
  return {
    record(value) {
      const message = String(value || '').trim();
      if (!message || seen.has(message)) return;
      seen.add(message);
      failures.push(message);
      resolveFailure(message);
    },
    async waitForFailure(timeoutMs = 5_000) {
      return Promise.race([
        failureSignal,
        sleep(timeoutMs).then(() => { throw new Error('Timed out waiting for injected screenshot failure'); }),
      ]);
    },
    assert(label) {
      if (failures.length === 0) return;
      throw new Error([`${label} contains fatal screenshot lifecycle errors.`, ...failures].join('\n'));
    },
  };
}

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
      ...(status === 'completed' ? {
        summary: response,
        evidence: [{ kind: 'summary', label: response }],
      } : {}),
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
  executionSchemaVersion: 2,
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
if (!workItemDetail.mainline) {
  throw new Error('Work Center screenshot detail must include schema-v2 mainline projection');
}
if (workItemDetail.mainline.progress.frontierActionIds.join(',') !== 'action-review') {
  throw new Error('Work Center screenshot mainline frontier must contain only the running review Action');
}
const dependentStageIds = new Set(workItemDetail.mainline.actions.flatMap(item => item.dependencies));
const sinkActions = workItemDetail.mainline.actions.filter(item => !dependentStageIds.has(item.stageId));
if (sinkActions.length !== 1 || sinkActions[0].id !== 'action-deliver') {
  throw new Error('Work Center screenshot mainline must end at the deliver Action');
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

function startServer(fatalLatch) {
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
  const handle = {
    child,
    ready: false,
    shutdownRequested: false,
    injectedExitMarker: '',
  };
  return new Promise((resolvePromise, reject) => {
    let settled = false;
    const failStartup = error => {
      if (settled) {
        if (!handle.shutdownRequested) fatalLatch.record(`[server:error] ${error.message}`);
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (child.exitCode === null && !child.signalCode) {
        handle.shutdownRequested = child.kill('SIGTERM');
      }
      reject(error);
    };
    const timer = setTimeout(() => failStartup(new Error('Documentation screenshot server start timeout')), 20_000);
    child.stdout.on('data', data => {
      const text = data.toString();
      if (!settled && text.includes('Server running on')) {
        settled = true;
        handle.ready = true;
        clearTimeout(timer);
        resolvePromise(handle);
      }
    });
    child.stderr.on('data', data => {
      const text = data.toString();
      if (text.includes('EADDRINUSE')) failStartup(new Error(`Port ${port} is already in use`));
    });
    child.on('error', error => failStartup(new Error(`Documentation screenshot server error: ${error.message}`)));
    child.on('exit', (code, signal) => {
      const detail = `code=${code ?? 'null'} signal=${signal || 'none'}`;
      if (!handle.ready) {
        failStartup(new Error(`Documentation screenshot server exited early (${detail})`));
      } else if (!handle.shutdownRequested) {
        fatalLatch.record(handle.injectedExitMarker || `[server:exit] Documentation screenshot server exited unexpectedly (${detail})`);
      }
    });
  });
}

async function stopChild(handle) {
  if (!handle) return;
  const { child } = handle;
  if (child.exitCode !== null || child.signalCode) return;
  const signaled = child.kill('SIGTERM');
  if (signaled) handle.shutdownRequested = true;
  await Promise.race([
    new Promise(resolvePromise => child.once('exit', resolvePromise)),
    sleep(3_000).then(() => {
      if (child.exitCode === null && !child.signalCode) {
        const killed = child.kill('SIGKILL');
        if (killed) handle.shutdownRequested = true;
      }
    }),
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

const visibleErrorSelectors = [
  '.work-center-error',
  '.work-center-detail-error',
  '.work-center-settings-error',
  '.typing-status-error',
  '.typing-status-banner-disconnected',
  '.typing-status-banner-agent-offline',
  '[role="alert"]',
  '.sp-toast.error',
];

function browserFailureMessage(locale, kind, value) {
  return `[browser:${locale}:${kind}] ${String(value || '').trim()}`;
}

async function installVisibleErrorObserver(page, fatalLatch, locale) {
  await page.exposeFunction('__yeaftRecordScreenshotFailure', value => fatalLatch.record(value));
  await page.evaluate(({ selectors, locale: pageLocale }) => {
    const reported = new Set();
    const isVisible = element => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) !== 0
        && rect.width > 0 && rect.height > 0;
    };
    const scan = () => {
      for (const element of document.querySelectorAll(selectors.join(', '))) {
        if (!isVisible(element)) continue;
        const text = element.textContent?.trim() || element.className || element.getAttribute('role') || 'unknown UI error';
        const message = `[visible-error:${pageLocale}] ${text}`;
        if (reported.has(message)) continue;
        reported.add(message);
        window.__yeaftRecordScreenshotFailure(message);
      }
    };
    const observer = new MutationObserver(scan);
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'style', 'hidden'],
      characterData: true,
    });
    window.__yeaftScreenshotErrorObserver = observer;
    scan();
  }, { selectors: visibleErrorSelectors, locale });
}

async function assertScreenshotLifecycleClean(page, fatalLatch, label) {
  const visibleErrors = await page.locator(visibleErrorSelectors.map(selector => `${selector}:visible`).join(', '))
    .allTextContents();
  for (const text of visibleErrors.map(value => value.trim()).filter(Boolean)) {
    fatalLatch.record(`[visible-error] ${text}`);
  }
  const storeState = await page.evaluate(() => {
    const chat = window.Pinia?.useChatStore?.();
    return chat ? {
      connectionState: chat.connectionState,
      currentAgentOnline: chat.currentAgentInfo?.online === true,
      workCenterError: chat.currentAgent ? chat.workCenterErrorByAgent?.[chat.currentAgent] || '' : '',
      settingsError: chat.currentAgent ? chat.workCenterSettingsErrorByAgent?.[chat.currentAgent] || '' : '',
      sessionHydrateError: chat.yeaftSessionHydrateError || '',
    } : null;
  });
  if (!storeState) fatalLatch.record('[store-error] Pinia chat store is unavailable');
  else {
    if (storeState.connectionState !== 'connected') {
      fatalLatch.record(`[store-error] WebSocket connection state is ${storeState.connectionState}`);
    }
    if (!storeState.currentAgentOnline) fatalLatch.record('[store-error] Current Agent is offline');
    for (const error of [storeState.workCenterError, storeState.settingsError, storeState.sessionHydrateError]) {
      if (error) fatalLatch.record(`[store-error] ${error}`);
    }
  }
  fatalLatch.assert(label);
}

async function injectPostScreenshotFailure(page, serverHandle, fatalLatch, locale, agentId) {
  if (locale !== 'en' || !failureScenario) return;
  if (failureScenario === 'post-screenshot-console') {
    await page.evaluate(() => console.error('Injected post-screenshot console failure'));
  } else if (failureScenario === 'post-screenshot-pageerror') {
    await page.evaluate(() => setTimeout(() => { throw new Error('Injected post-screenshot pageerror failure'); }, 0));
  } else if (failureScenario === 'post-screenshot-requestfailed') {
    await page.route('**/__yeaft-doc-injected-request-failure', route => route.abort('failed'));
    await page.evaluate(() => fetch('/__yeaft-doc-injected-request-failure').catch(() => {}));
  } else if (failureScenario === 'visible-typing-error') {
    await page.evaluate(activeAgentId => {
      const chat = window.Pinia.useChatStore();
      chat.workCenterOpen = false;
      chat.yeaftProcessingSessions = {
        ...chat.yeaftProcessingSessions,
        [`${activeAgentId}\u001fdocs-session`]: true,
      };
      chat.connectionState = 'disconnected';
    }, agentId);
    await page.waitForSelector('.typing-status-error', { state: 'visible' });
    await page.evaluate(() => console.log('Injected visible typing error failure'));
  } else if (failureScenario === 'server-exit') {
    return;
  }
  await fatalLatch.waitForFailure();
  fatalLatch.assert(`Injected ${failureScenario} screenshot failure`);
}

async function captureLocale(browser, agent, serverHandle, fatalLatch, locale, prefix) {
  const context = await browser.newContext({
    viewport,
    deviceScaleFactor: 1,
    colorScheme: 'light',
    reducedMotion: 'reduce',
    locale: locale === 'zh-CN' ? 'zh-CN' : 'en-US',
  });
  const page = await context.newPage();
  page.on('console', message => {
    const entry = browserFailureMessage(locale, `console:${message.type()}`, message.text());
    console.error(entry);
    if (message.type() === 'error') fatalLatch.record(entry);
  });
  page.on('pageerror', error => {
    const entry = browserFailureMessage(locale, 'pageerror', error.stack || error.message);
    fatalLatch.record(entry);
    console.error(entry);
  });
  page.on('requestfailed', request => {
    const entry = browserFailureMessage(locale, 'requestfailed', `${request.url()} ${request.failure()?.errorText || ''}`);
    fatalLatch.record(entry);
    console.error(entry);
  });
  page.on('crash', () => {
    const entry = browserFailureMessage(locale, 'crash', 'Page crashed');
    fatalLatch.record(entry);
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
  await installVisibleErrorObserver(page, fatalLatch, locale);
  await seedPage(page, { locale, agentId: agent.agentId });

  const sessionPath = resolve(outputRoot, prefix, 'session.png');
  await assertScreenshotLifecycleClean(page, fatalLatch, `${locale} Session screenshot`);
  await page.screenshot({ path: sessionPath, type: 'png', fullPage: false });
  await assertScreenshotLifecycleClean(page, fatalLatch, `${locale} Session screenshot completion`);

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
  await assertScreenshotLifecycleClean(page, fatalLatch, `${locale} Work Center initialization`);
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
  await assertScreenshotLifecycleClean(page, fatalLatch, `${locale} Work Center screenshot`);
  await page.screenshot({ path: workCenterPath, type: 'png', fullPage: false });
  await injectPostScreenshotFailure(page, serverHandle, fatalLatch, locale, agent.agentId);

  const theme = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
  if (theme !== 'light') throw new Error(`Expected light theme, received ${theme}`);
  for (const selector of ['.work-center-main', '.work-center-body', '.work-center-detail-layout']) {
    const overflow = await page.locator(selector).evaluate(element => element.scrollWidth > element.clientWidth + 1);
    if (overflow) throw new Error(`Horizontal overflow in ${selector}`);
  }
  await assertScreenshotLifecycleClean(page, fatalLatch, `${locale} Work Center screenshot completion`);
  await context.close();
  fatalLatch.assert(`${locale} browser context close`);
  return [sessionPath, workCenterPath];
}

await mkdir(outputRoot, { recursive: true });
await mkdir(resolve(outputRoot, 'zh-CN'), { recursive: true });
const fatalLatch = createFatalLatch();
let server;
let agent;
let browser;
let browserShutdownRequested = false;
let captureError = null;
try {
  server = await startServer(fatalLatch);
  agent = new MockAgent(serverUrl, 'Yeaft Docs Workstation');
  await agent.connect();
  browser = await chromium.launch({ headless: true });
  browser.on('disconnected', () => {
    if (!browserShutdownRequested) fatalLatch.record('[browser:disconnected] Chromium disconnected unexpectedly');
  });
  const english = await captureLocale(browser, agent, server, fatalLatch, 'en', '.');
  fatalLatch.assert('English documentation screenshot capture');
  const chinese = await captureLocale(browser, agent, server, fatalLatch, 'zh-CN', 'zh-CN');
  fatalLatch.assert('All documentation screenshot captures');
  if (failureScenario === 'server-exit') {
    server.injectedExitMarker = 'Injected screenshot server exit failure';
    server.child.kill('SIGKILL');
    await fatalLatch.waitForFailure();
    fatalLatch.assert('Injected server-exit screenshot failure');
  }
  for (const path of [...english, ...chinese]) console.log(path);
} catch (error) {
  try {
    fatalLatch.assert('Documentation screenshot capture');
  } catch (fatalError) {
    captureError = fatalError;
  }
  captureError ||= error;
} finally {
  try {
    if (browser) {
      browserShutdownRequested = true;
      await browser.close();
    }
  } catch (error) { captureError ||= error; }
  try { if (agent) await agent.disconnect(); } catch (error) { captureError ||= error; }
  try { await stopChild(server); } catch (error) { captureError ||= error; }
}
let finalFatalError = null;
try {
  fatalLatch.assert('Documentation screenshot capture after shutdown');
} catch (error) {
  finalFatalError = error;
}
if (finalFatalError) throw finalFatalError;
if (captureError) throw captureError;
