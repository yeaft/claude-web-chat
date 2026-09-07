#!/usr/bin/env node
// Current Vue UI only. No synthetic HTML, production services, or model calls.
const { spawn, spawnSync } = require('node:child_process');
const { mkdtemp, mkdir, readFile, writeFile, rm, rename } = require('node:fs/promises');
const { readFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { pathToFileURL } = require('node:url');
const { chromium, expect } = require('@playwright/test');
const root = path.resolve(__dirname, '../..');
const output = path.resolve(process.env.YEAFT_SHOWCASE_OUTPUT_DIR || path.join(__dirname, 'assets'));
const viewport = { width: 1440, height: 900 };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
async function main() {
  const fixture = await import(pathToFileURL(path.join(__dirname, 'capture-fixture.mjs')));
  const { MockAgent } = await import(pathToFileURL(path.join(root, 'e2e/fixtures/mock-agent.js')));
  const failures = [];
  let server, agent, browser, shuttingDown = false, browserClosing = false;
  const check = () => { if (failures.length) throw new Error(failures.join('\n')); };
  const sourceCommit = spawnSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
  if (!/^[a-f0-9]{40}$/.test(sourceCommit)) throw new Error('Cannot resolve source commit');
  const sources = ['agent/yeaft/session.js'];
  const checks = sources.map(file => {
    const result = spawnSync(process.execPath, ['--check', file], { cwd: root, encoding: 'utf8' });
    if (result.error || result.status !== 0) throw new Error(`Syntax check failed: ${file}\n${result.stderr || result.error}`);
    return { command: `node --check ${file}`, exitCode: result.status, stdout: result.stdout, stderr: result.stderr };
  });
  const terminalText = [
    'STAGED INSPECTION DEMO · read-only',
    'Real command result; replayed via demo transport.',
    `Source commit: ${sourceCommit.slice(0, 12)}`, `Node ${process.version}`, '',
    ...checks.flatMap(result => [`$ ${result.command}`, result.stdout.trim(), result.stderr.trim(), `[capture runner] exit code: ${result.exitCode}`, ''].filter((line, i) => line || i === 4)),
    'Scope: JavaScript syntax only. No regression suite or release claimed.', '', '$ ',
  ].join('\r\n');
  const temp = await mkdtemp(path.join(tmpdir(), 'yeaft-showcase-'));
  const stage = path.join(temp, 'assets');
  const onSignal = signal => {
    failures.push(`Capture interrupted: ${signal}`);
    if (server && server.exitCode === null && !server.signalCode) server.kill('SIGTERM');
    if (browser) void browser.close();
  };
  const onTerm = () => onSignal('SIGTERM'), onInt = () => onSignal('SIGINT');
  process.once('SIGTERM', onTerm); process.once('SIGINT', onInt);
  try {
    await mkdir(stage);
    const port = await freePort();
    const url = `http://127.0.0.1:${port}`;
    let serverLog = '';
    server = spawn(process.execPath, ['server/index.js'], { cwd: root, env: {
      ...process.env, PORT: String(port), SERVER_HOST: '127.0.0.1', SKIP_AUTH: 'true',
      NODE_ENV: 'test', TEST_DB_DIR: path.join(temp, 'db'), YEAFT_DIR: path.join(temp, 'yeaft'), WEB_DIR: path.join(root, 'web'),
    }, stdio: ['ignore', 'pipe', 'pipe'] });
    server.stdout.on('data', data => { serverLog += data; });
    server.stderr.on('data', data => { serverLog += data; });
    server.on('error', error => failures.push(`server: ${error.message}`));
    server.on('exit', (code, signal) => { if (!shuttingDown) failures.push(`server exited: ${code}/${signal}\n${serverLog.slice(-3000)}`); });
    for (let i = 0; !serverLog.includes('Server running on'); i++) {
      check();
      if (i > 200) throw new Error(`Server startup timeout\n${serverLog}`);
      await sleep(100);
    }
    agent = new MockAgent(url, 'Demo · isolated workstation');
    await agent.connect();
    const wireRequests = [];
    // Read only explicit repository paths; never follow arbitrary browser-supplied filesystem paths.
    const fileMap = new Map(await Promise.all(sources.map(async file => [
      `${fixture.demoWorkDir}/${file}`, await readFile(path.join(root, file), 'utf8'),
    ])));
    agent._messageHandlers.push(msg => {
      const reply = payload => agent.send({ ...msg, ...payload, agentId: agent.agentId });
      if (['list_directory', 'read_file', 'terminal_create'].includes(msg.type)) wireRequests.push(msg.type);
      if (msg.type === 'list_directory') {
        const dir = msg.dirPath.replace(/\/$/, '');
        const entries = new Map();
        for (const file of fileMap.keys()) {
          if (!file.startsWith(`${dir}/`)) continue;
          const rest = file.slice(dir.length + 1), name = rest.split('/')[0];
          entries.set(name, { name, path: `${dir}/${name}`, type: rest.includes('/') ? 'directory' : 'file' });
        }
        reply({ type: 'directory_listing', dirPath: dir, entries: [...entries.values()] });
      } else if (msg.type === 'read_file') {
        if (!fileMap.has(msg.filePath)) { failures.push(`Unexpected file read: ${msg.filePath}`); return; }
        reply({ type: 'file_content', filePath: msg.filePath, content: fileMap.get(msg.filePath), encoding: 'utf8' });
      } else if (msg.type === 'terminal_create') {
        reply({ type: 'terminal_created', success: true });
        reply({ type: 'terminal_output', data: terminalText });
      } else if (msg.type === 'yeaft_session_list') {
        reply({ type: 'session_list_updated', sessions: [fixture.session] });
      }
    });
    browser = await chromium.launch({ headless: true });
    browser.on('disconnected', () => { if (!shuttingDown && !browserClosing) failures.push('Browser disconnected unexpectedly'); });
    const page = await browser.newPage({ viewport, deviceScaleFactor: 1 });
    page.setDefaultTimeout(15000);
    page.on('pageerror', error => failures.push(`pageerror: ${error.message}`));
    page.on('console', msg => { if (msg.type() === 'error') failures.push(`console: ${msg.text()}`); });
    page.on('requestfailed', request => failures.push(`requestfailed: ${request.url()} ${request.failure()?.errorText}`));
    page.on('response', response => { if (response.status() >= 400) failures.push(`HTTP ${response.status()}: ${response.url()}`); });
    await page.addInitScript(() => {
      localStorage.setItem('theme', 'light'); localStorage.setItem('theme-follow-system', 'false');
      localStorage.setItem('locale', 'en'); localStorage.setItem('preferred-conversation-view', 'yeaft');
      localStorage.setItem('yeaft-preferred-conversation-view', 'yeaft');
    });
    await page.goto(url, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => window.Pinia?.useChatStore && window.Pinia?.useSessionsStore);
    const screenshots = [];
    const capture = async (name, selector, components, cropSelector = selector) => {
      await expect(page.locator(selector).first()).toBeVisible();
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(350);
      check();
      const error = await page.locator('[role="alert"], .terminal-error, .work-center-error, .work-center-detail-error, .yeaft-history-load-error').filter({ visible: true }).allTextContents();
      if (error.some(text => text.trim())) throw new Error(`Visible UI error: ${error.join('; ')}`);
      if ((await page.locator('body').innerText()).trim().length < 80) throw new Error('Blank UI');
      const crop = page.locator(cropSelector).first();
      const bounds = await crop.boundingBox();
      if (!bounds || bounds.width < 250 || bounds.height < 100) throw new Error(`Invalid crop: ${name}`);
      await crop.screenshot({ path: path.join(stage, name) });
      await page.waitForTimeout(100); check();
      const bytes = await readFile(path.join(stage, name));
      const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
      if (bytes.length < 10000) throw new Error(`Blank/invalid screenshot ${name}`);
      screenshots.push({ file: name, width, height, viewport: page.viewportSize(), cssCrop: bounds, deviceScaleFactor: 1,
        bytes: bytes.length, components, sourceCommit, provenance: 'Real Vue component crop; isolated server; staged data and transport only.', cropSelector });
      console.log(`Captured ${name} (${width}x${height})`);
    };
    await capture('01-home.png', '.yeaft-onboarding', ['web/components/YeaftPage.js', 'web/components/SessionSidebar.js'], '.yeaft-page');
    await page.evaluate(({ agentId, fixture }) => {
      const chat = window.Pinia.useChatStore(), sessions = window.Pinia.useSessionsStore(), vp = window.Pinia.useVpStore();
      const conversationId = 'yeaft-showcase-demo';
      const agentInfo = { id: agentId, name: 'Demo · isolated workstation', online: true, status: 'ready', workDir: fixture.demoWorkDir,
        capabilities: ['yeaft', 'terminal', 'file_editor', 'workbench_session_routes', 'work_center', 'work_center_message_v2'] };
      chat.agents = [agentInfo]; chat.currentAgent = agentId; chat.currentAgentInfo = agentInfo;
      chat._hasHandledAgentList = true; chat._hasHandledYeaftSessionHydrate = true;
      chat.yeaftSessionHydrateError = null; chat.yeaftHistoryLoadError = null;
      chat.yeaftConversationId = conversationId; chat.yeaftConversationIdsByAgent = { [agentId]: conversationId };
      chat.yeaftSessionAgentById = { [fixture.sessionId]: agentId };
      chat.yeaftSessionReady = true; chat.yeaftModel = '';
      chat.messagesMap[conversationId] = fixture.conversation;
      sessions.applySnapshot([fixture.session], agentId); sessions.setActive(fixture.sessionId, agentId);
      chat.yeaftActiveSessionFilter = fixture.sessionId; chat.currentView = 'yeaft';
      vp.applySnapshot({ vps: fixture.vps }, agentId);
      chat.applySessionCatalogSnapshot([{ catalogKey: `yeaft:${agentId}:${fixture.sessionId}`, runtimeProvider: 'yeaft',
        routeRef: { runtimeProvider: 'yeaft', agentId, sessionId: fixture.sessionId }, title: fixture.session.name,
        workDir: fixture.demoWorkDir, availability: 'online', sortRank: 0 }], []);
    }, { agentId: agent.agentId, fixture: { session: fixture.session, sessionId: fixture.sessionId, demoWorkDir: fixture.demoWorkDir, conversation: fixture.conversation, vps: fixture.vps } });
    agent.send({ type: 'session_list_updated', sessions: [fixture.session] });
    await expect(page.locator('.vp-turn-block').first()).toBeVisible();
    const statusToggle = page.locator('.yeaft-session-actions .yeaft-topbar-vp-toggle').first();
    if (await statusToggle.getAttribute('aria-expanded') === 'true') await statusToggle.click();
    await capture('04-session-conversation.png', '.vp-turn-block', ['web/components/YeaftPage.js', 'web/components/MessageList.js', 'web/components/AssistantTurn.js'], '.yeaft-main');
    await page.setViewportSize({ width: 1050, height: 780 });
    await page.evaluate(messages => { const chat = window.Pinia.useChatStore(); chat.closeSessionSidebar(); chat.messagesMap[chat.yeaftConversationId] = messages; }, fixture.teamConversation);
    await statusToggle.click();
    await expect(page.locator('.yeaft-vp-timeline')).toBeVisible();
    await expect(page.locator('.yeaft-vp-timeline-row')).toHaveCount(2);
    for (const name of ['Linus', 'Martin']) {
      await expect(page.locator('.yeaft-vp-timeline-row-name').filter({ hasText: name })).toBeVisible();
      await expect(page.locator('.vp-turn-block').filter({ hasText: name }).first()).toBeVisible();
    }
    await capture('05-session-roster.png', '.yeaft-vp-timeline', ['web/components/VpTimelinePane.js', 'web/components/AssistantTurn.js'], '.yeaft-page');
    await statusToggle.click();
    await page.setViewportSize({ width: 850, height: 600 });
    await page.locator('.yeaft-session-actions [aria-label="Workbench"]').click();
    const panel = page.locator('.workbench-panel');
    await expect(panel).toHaveClass(/expanded/);
    await panel.locator('.workbench-maximize-btn').click();
    await panel.locator('[data-workbench-capability="files"]').click();
    for (const name of ['agent', 'yeaft', 'session.js']) await panel.locator('.tree-item').filter({ hasText: new RegExp(`^.*${name.replace('.', '\\.')}.*$`) }).first().click();
    await expect(panel.locator('.CodeMirror')).toBeVisible();
    await page.evaluate(() => {
      const cm = document.querySelector('.CodeMirror').CodeMirror;
      cm.setCursor({ line: 145, ch: 0 }); cm.scrollTo(0, cm.heightAtLine(145, 'local'));
    });
    await expect(panel.locator('.CodeMirror-code')).toContainText('Determine config');
    await capture('08-workbench-files-correct.png', '.CodeMirror', ['web/components/WorkbenchPanel.js', 'web/components/FilesTab.js', 'web/components/files/fileTree.js'], '.workbench-panel');
    await page.setViewportSize({ width: 690, height: 520 });
    await panel.locator('.workbench-add-btn').click();
    await panel.locator('[data-workbench-capability="terminal"]').click();
    await expect(panel.locator('.xterm-screen')).toBeVisible();
    await page.waitForFunction(() => document.querySelector('.xterm-rows')?.textContent.includes('No regression suite'));
    await capture('08-workbench-terminal-correct.png', '.xterm-screen', ['web/components/WorkbenchPanel.js', 'web/components/TerminalTab.js'], '.workbench-panel');
    await panel.locator('.workbench-panel-close').click();
    await page.setViewportSize(viewport);
    await page.evaluate(({ agentId, item, detail, demoWorkDir }) => {
      const chat = window.Pinia.useChatStore();
      chat.workCenterAgentId = agentId;
      chat.workCenterRequest = async (op, data, target) => {
        if (target !== agentId) throw new Error('Demo Work Center Agent mismatch');
        if (op === 'list') return { items: [item], nextCursor: null, watcher: { enabled: true } };
        if (op === 'get' && data.id === detail.id) return detail;
        if (op === 'get_settings') return { settings: { defaultWorkDir: demoWorkDir, startImmediately: true }, runtime: {
          defaultWorkDir: demoWorkDir, workItemTypes: [{ id: 'software-change', name: 'Software change', actionCount: 4 }],
          vps: [{ id: 'linus', name: 'Linus' }, { id: 'martin', name: 'Martin' }], models: [],
        } };
        throw new Error(`Unexpected Demo Work Center operation: ${op}`);
      };
      chat.workCenterOpen = true;
    }, { agentId: agent.agentId, item: fixture.workItem, detail: fixture.workItemDetail, demoWorkDir: fixture.demoWorkDir });
    await page.locator('.work-center-card-open').first().click();
    await page.locator('.work-center-actions-button').click();
    await capture('09-work-center-structure.png', '.work-center-action-list', ['web/components/WorkCenterPage.js', 'web/components/WorkCenterActionDetail.js', 'agent/yeaft/work-center/projection.js'], '.work-center-main');
    if (process.env.YEAFT_SHOWCASE_FAILURE === 'runtime') await page.evaluate(() => { setTimeout(() => { throw new Error('Injected capture runtime error'); }, 0); });
    else if (process.env.YEAFT_SHOWCASE_FAILURE === 'blank') { await page.evaluate(() => { document.body.replaceChildren(); }); await capture('invalid.png', 'body', []); }
    else if (process.env.YEAFT_SHOWCASE_FAILURE) throw new Error('Unknown YEAFT_SHOWCASE_FAILURE');
    await page.waitForTimeout(300); check();
    for (const type of ['read_file', 'list_directory', 'terminal_create']) if (!wireRequests.includes(type)) throw new Error(`Missing real wire request: ${type}`);
    const manifest = { capturedAt: new Date().toISOString(), sourceCommit: spawnSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim(),
      source: 'Current worktree web/ modules, real isolated server and MockAgent. No synthetic HTML.',
      fixture: 'artifacts/showcase/capture-fixture.mjs; clearly marked demo messages and WorkItem, no LLM calls or test results claimed.',
      terminal: { checks, text: terminalText, scope: 'Actual node --check output; no test suite executed.' }, files: sources, wireRequests, screenshots };
    browserClosing = true;
    await browser.close(); browser = null;
    // Only publish the complete validated six-image set.
    check();
    await mkdir(output, { recursive: true });
    for (const screenshot of screenshots) await rename(path.join(stage, screenshot.file), path.join(output, screenshot.file));
    await writeFile(path.join(output, 'capture-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  } finally {
    shuttingDown = true;
    if (browser) await browser.close();
    if (agent?.ws) agent.ws.terminate();
    if (server && server.exitCode === null && !server.signalCode) {
      server.kill('SIGTERM');
      await Promise.race([new Promise(resolve => server.once('exit', resolve)), sleep(3000)]);
      if (server.exitCode === null && !server.signalCode) { server.kill('SIGKILL'); await new Promise(resolve => server.once('exit', resolve)); }
    }
    await rm(temp, { recursive: true, force: true });
    process.removeListener('SIGTERM', onTerm); process.removeListener('SIGINT', onInt);
  }
}
main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
