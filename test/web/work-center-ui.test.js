import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const read = path => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');

describe('Work Center UI contract', () => {
  it('renders Work Center inside both provider shells and keeps both Session lists mounted', () => {
    const app = read('web/app.js');
    const chat = read('web/components/ChatPage.js');
    const yeaftPage = read('web/components/YeaftPage.js');
    const yeaftSidebar = read('web/components/YeaftSidebar.js');

    expect(app).not.toContain("currentView === 'work-center'");
    expect(app).not.toContain('WorkCenterPage');
    expect(chat).toContain('<WorkCenterPage v-if="store.workCenterOpen"');
    expect(chat).toContain('v-else-if="!store.isSplitMode"');
    expect(chat).toContain(':active="store.workCenterOpen"');
    expect(chat.indexOf('<WorkCenterPage')).toBeGreaterThan(chat.indexOf('</SessionSidebarShell>'));
    expect(yeaftPage).toContain('<WorkCenterPage v-if="store.workCenterOpen"');
    expect(yeaftPage).toContain('<div v-else class="yeaft-main"');
    expect(yeaftPage).toContain('v-if="!store.workCenterOpen && showVpTimeline"');
    expect(yeaftPage).toContain('v-if="!store.workCenterOpen && debugMode"');
    expect(yeaftSidebar).toContain(':active="chatStore ? chatStore.workCenterOpen : false"');
    expect(yeaftSidebar).toContain('leaveWorkCenter');
  });

  it('keeps Yeaft global Settings mounted outside the Work Center content branch', () => {
    const page = read('web/components/YeaftPage.js');
    const workCenterStart = page.indexOf('<WorkCenterPage v-if="store.workCenterOpen"');
    const conversationStart = page.indexOf('<div v-else class="yeaft-main"');
    const conversationEnd = page.indexOf('<!-- Keep global Settings outside the conversation/Work Center branch');
    const settingsStart = page.indexOf('<SettingsPanel', conversationEnd);

    expect(workCenterStart).toBeGreaterThan(-1);
    expect(conversationStart).toBeGreaterThan(workCenterStart);
    expect(conversationEnd).toBeGreaterThan(conversationStart);
    expect(settingsStart).toBeGreaterThan(conversationEnd);
    expect(page).toContain('@open-settings="toggleSettings"');
  });

  it('uses the shared Chat settings row styles without Yeaft overrides', () => {
    const chat = read('web/components/ChatPage.js');
    const yeaftSidebar = read('web/components/YeaftSidebar.js');
    const sidebarCss = read('web/styles/sidebar.css');
    const yeaftSidebarCss = read('web/styles/yeaft-sidebar.css');

    expect(chat).toContain('<div class="sidebar-bottom">');
    expect(yeaftSidebar).toContain('<div class="sidebar-bottom">');
    expect(chat).toContain('<button class="sidebar-nav-item" @click="showSettingsPanel = true">');
    expect(yeaftSidebar).toContain('<button class="sidebar-nav-item" @click="$emit(\'open-settings\')">');
    expect(sidebarCss).toContain('.sidebar-bottom .sidebar-nav-item');
    expect(yeaftSidebarCss).not.toContain('.yeaft-sidebar .sidebar-bottom');
    expect(yeaftSidebarCss).not.toContain('.yeaft-sidebar .sidebar-bottom .sidebar-nav-item');
  });

  it('keeps Agent-level Work Center state separate from Session background tasks', () => {
    const store = read('web/stores/chat.js');
    expect(store).toContain('workCenterItemsByAgent');
    expect(store).toContain('workCenterLoadedByAgent');
    expect(store).toContain('workCenterDetailByAgent');
    expect(store).toContain("type: 'work_center_request'");
    expect(store).toContain('[target]: true');
    expect(store).toContain('workCenterOpen: false');
    expect(store).toContain('this.workCenterOpen = true');
    expect(store).toContain('this.workCenterOpen = false');
    expect(store).not.toContain("currentView = 'work-center'");
    expect(store).not.toContain('workCenterActiveTasksBySession');
  });

  it('offers Session-to-WorkItem creation and keeps execution counts out of the Action list', () => {
    const input = read('web/components/ChatInput.js');
    const page = read('web/components/YeaftPage.js');
    const workCenter = read('web/components/WorkCenterPage.js');
    const store = read('web/stores/chat.js');
    expect(input).toContain('workItemFn');
    expect(page).toContain(':work-item-fn="openWorkItemDraft"');
    expect(store).toContain('enterWorkCenterFromSession');
    expect(workCenter).toContain('class="work-center-action-card"');
    expect(workCenter).toContain('{{ actionExecutor(action) }}');
    expect(workCenter).toContain('{{ actionContentSummary(action) }}');
    expect(workCenter).not.toContain("formatCount(executionStats(action).llmRequestCount)");
    expect(workCenter).not.toContain("formatCount(executionStats(action).loopCount)");
    expect(workCenter).not.toContain("formatCount(executionStats(action).toolCount)");
    expect(workCenter).not.toContain("formatTokens(executionStats(action).totalTokens)");
    expect(workCenter).not.toContain('runsForAction(action.id)');
    expect(workCenter).not.toContain('run.evidence');
    expect(workCenter).not.toContain('selected.events');
  });

  it('uses the shared provider sidebar and a content-only Work Center surface', () => {
    const chat = read('web/components/ChatPage.js');
    const page = read('web/components/WorkCenterPage.js');
    const sidebar = read('web/components/SidebarWorkCenter.js');
    const css = read('web/styles/work-center.css');

    expect(sidebar).toContain('session-tab-bar sidebar-work-center-tab-bar');
    expect(sidebar).toContain('session-item sidebar-work-center-agent');
    expect(sidebar).toContain("agent.capabilities.includes('work_center')");
    expect(page).toContain("agent.capabilities.includes('work_center')");
    expect(page).toContain("'is-empty': loaded && !loading");
    expect(page).toContain('v-if="loaded && !loading && items.length === 0"');
    expect(css).toMatch(/\.sidebar-work-center-trigger:hover\s*\{[^}]*color: var\(--text-secondary\)/s);
    expect(css).toMatch(/\.sidebar-work-center-agent:hover\s*\{[^}]*color: var\(--text-secondary\)/s);
    expect(page).toContain('<main class="work-center-main"');

    expect(page).toContain('work-center-sidebar-toggle');
    expect(page).not.toContain('<aside');
    expect(page).not.toContain('SidebarModeToggle');
    expect(page).not.toContain('SidebarWorkCenter');
    expect(page).not.toContain('WorkbenchPanel');
    expect(css).not.toMatch(/\.work-center-sidebar(?:[\s.{:#]|$)/);
    expect(css).not.toContain('padding-left: 48px');
    expect(css).toContain('.work-center-main.workbench-maximized');
    expect(chat).toContain('<WorkbenchPanel v-if="canUseWorkbench && (!store.isSplitMode || store.workCenterOpen)"');
  });

  it('uses progressive Work Item and Action workspaces with messages, lazy request detail, and input', () => {
    const page = read('web/components/WorkCenterPage.js');
    const detail = read('web/components/WorkCenterActionDetail.js');
    const store = read('web/stores/chat.js');
    const css = read('web/styles/work-center.css');


    expect(page).toContain('WorkCenterActionDetail');
    expect(page).toContain('@click="selectAction(action)"');
    expect(page).toContain(':data-pane="narrowPane"');
    expect(page).toContain('v-if="narrowPane === \'items\'" class="work-center-toolbar"');
    expect(detail).toContain('class="work-center-action-detail-pane"');
    expect(detail).toContain("activeTab === 'messages'");
    expect(detail).toContain("activeTab === 'requests'");
    expect(detail).toContain('v-for="message in messages"');
    expect(detail).toContain("$emit('load-earlier-messages')");
    expect(store).toContain("workCenterRequest('get_action_messages'");
    expect(page).toContain(':messages-next-cursor="actionMessagesNextCursor"');
    expect(detail).toContain('v-for="loop in requestDetail(request)?.loops || []"');
    expect(detail).toContain('requestDetailsError[requestKey(request)]');
    expect(detail).toContain('requestDetailsLoading[requestKey(request)]');
    expect(detail).toContain('class="work-center-action-failure"');
    expect(detail).toContain('action.failure.error');
    expect(detail).toContain('role="tabpanel"');
    expect(detail).toContain('aria-controls="work-center-action-messages-panel"');
    expect(detail).toContain('@keydown="onTabKeydown"');
    expect(detail).toContain("event.key === 'Home'");
    expect(detail).toContain("event.key === 'End'");
    expect(detail).toContain('v-if="composerError"');
    expect(detail).toContain("tr('workCenter.requestDetailUnavailable'");
    expect(detail).toContain("tr('workCenter.actionInputContinueHint'");
    expect(detail).not.toContain('actionInputRestartHint');
    expect(page).toContain('workCenterRequestKey(request)');
    expect(detail).toContain(':key="requestKey(request)"');
    expect(detail).toContain("tr('workCenter.rawRequest'");
    expect(detail).toContain('class="work-center-action-composer"');
    expect(detail).toContain("tr('workCenter.retryAction'");
    expect(detail).toContain("['ready', 'running', 'waiting', 'failed']");
    expect(page).toContain('work-center-item-messages');
    expect(page).toContain("tr('workCenter.workItemMessageScope'");
    expect(page).toContain('@retry="retrySelectedAction"');
    expect(store).toContain("workCenterRequest('work_item_message'");
    expect(store).toContain("workCenterRequest('retry_action'");
    expect(detail).toContain('input-wrapper work-center-action-input-wrapper');
    expect(detail).toContain('class="attach-btn work-center-attachment-picker"');
    expect(detail).toContain('class="send-btn"');
    expect(detail).toContain('@keydown="onComposerKeydown"');
    expect(detail).toContain("$emit('attachment-input', $event)");
    expect(store).toContain("workCenterRequest('action_input'");
    expect(store).toContain("workCenterRequest('get_action_requests'");
    expect(store).toContain("workCenterRequest('get_action_request'");
    expect(css).toContain('.work-center-action-detail-pane');
    expect(css).toContain('.work-center-action-transcript');
    expect(css).toContain('.work-center-request-card');
    expect(css).toContain('.work-center-action-composer');
    expect(css).toContain('grid-template-columns: minmax(0, 1fr)');
    expect(css).not.toContain('clamp(230px, 17cqw, 290px) clamp(330px, 25cqw, 430px) minmax(480px, 1fr)');
    expect(css).toContain('.work-center-body[data-pane="items"] .work-center-detail');
    expect(page).toContain('class="work-center-status" :data-status="action.status"');
    expect(css).toContain('.work-center-action-input-wrapper');

    expect(page).toContain('class="work-center-list work-center-board"');
    expect(page).toContain('class="work-center-board-lane"');
    expect(page).toContain('class="work-center-card-meta"');
    expect(page).toContain('class="work-center-card-current-action"');
    expect(page).toContain('boardActionCountLabel(item)');
    expect(page).toContain('class="work-center-action-card"');
    expect(page).toContain('class="work-center-action-content"');
    expect(page).toContain('class="work-center-action-primary"');
    expect(page).toContain('class="work-center-action-secondary"');
    expect(page).toContain('class="work-center-action-vp"');
    expect(page).toContain('class="work-center-action-content-summary"');
    expect(page).not.toContain('class="work-center-action-stats"');
    expect(page).toContain('this.loadLatestActionMessages(action)');
    expect(css).toMatch(/\.work-center-action-summary\s*\{[^}]*grid-template-columns: 26px minmax\(0, 1fr\) 14px/s);
    expect(page).toContain('v-if="detailLoading"');
    expect(page).toContain('v-else-if="detailError"');
    expect(page).toContain("if (this.selectedId === item.id) this.detailError = error?.message || String(error)");
    expect(page).toContain('v-if="selected.failureReason"');
    expect(page).not.toContain('v-model="resumeAnswer"');
    expect(page).toContain('retrySelectedAction');
    expect(page).not.toContain("selected.status === 'cancelled'\" class=\"btn-primary");
    expect(page).toContain("tr('workCenter.answerInActionDetail'");
    expect(page).toContain('this.selectedActionId = detail?.currentActionId || detail?.actions?.[0]?.id || null');
    expect(page).not.toContain('class="work-center-run"');
    expect(page).not.toContain('class="work-center-activity-toggle"');
    expect(page).not.toContain('v-for="tool');

  });

  it('creates Work Items with Auto or a task category and keeps Action creation out of the UI', () => {
    const page = read('web/components/WorkCenterPage.js');
    expect(page).toContain('v-model="form.workItemType"');
    expect(page).toContain('<option value="auto">');
    expect(page).toContain('v-for="type in workItemTypes"');
    expect(page).toContain("workItemType: this.form.workItemType || 'auto'");
    expect(page).toContain('<option v-for="type in workItemTypes" :key="type.id" :value="type.id">{{ type.name }}</option>');
    expect(page).not.toContain("type.name }} · {{ $t('workCenter.actionCount'");
    expect(page).toContain('class="work-center-action-list"');
    expect(page).toContain('@click="selectAction(action)"');
    expect(page).not.toContain('addAction');
    expect(page).not.toContain('createAction');
  });

  it('uses a compact header and flat empty state instead of a dashboard hero', () => {
    const page = read('web/components/WorkCenterPage.js');
    const css = read('web/styles/work-center.css');

    expect(page).toContain('class="work-center-heading"');
    expect(page).toContain('class="work-center-agent-context"');
    expect(page).not.toContain('class="work-center-eyebrow"');
    expect(page).not.toContain('class="work-center-empty-icon"');
    expect(page).not.toContain('class="work-center-detail-empty-icon"');
    expect(page).toContain("tr('workCenter.createFirst'");
    expect(css).toContain('width: 100%');
    expect(css).toContain('grid-template-columns: minmax(0, 1fr)');
    expect(css).toContain('.work-center-body.is-empty .work-center-detail');
    expect(css).toContain('.work-center-body.is-empty .work-center-list');
    expect(css).not.toContain('.work-center-empty-icon');
  });

  it('uses existing design tokens and adds no hard-coded colors', () => {
    const css = read('web/styles/work-center.css');
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(css).not.toMatch(/rgba?\(/i);
    expect(css).toContain('var(--bg-main)');
    expect(css).toContain('var(--text-primary)');
    expect(css).toContain('var(--modal-overlay-bg)');
    expect(css).not.toContain('border-bottom');
    expect(css).not.toContain('border-top');
  });

  it('aligns responsive breakpoints and keeps the mobile create action', () => {
    const page = read('web/components/WorkCenterPage.js');
    const css = read('web/styles/work-center.css');

    expect(css).toContain('@container work-center (max-width: 1250px)');
    expect(css).toContain('@media (max-width: 960px)');
    expect(css).toContain('@media (max-width: 768px)');
    expect(css).not.toContain('@media (max-width: 760px)');
    expect(css).toContain('.work-center-header-create span');
    expect(css).toContain('grid-template-columns: 1fr 1fr');
    expect(css).toContain('grid-template-columns: repeat(3, minmax(250px, 1fr))');
    expect(css).toContain('.work-center-board-lane-tabs');
    expect(css).toMatch(/@media \(max-width: 768px\)[\s\S]*?\.work-center-board\s*\{[^}]*display: flex;[^}]*overflow-x: hidden/s);
    expect(css).toMatch(/\.work-center-board-lane\.mobile-active\s*\{[^}]*display: flex/s);
    expect(page).toContain('role="tablist"');
    expect(page).toContain('mobileBoardLane === lane.id');
    expect(page).toContain(':disabled="boardLoadingMore"');
    expect(page).toContain(':aria-label="tr(\'workCenter.newWorkItem\'');
  });

  it('uses shared controls and a fixed shell for the create dialog', () => {
    const page = read('web/components/WorkCenterPage.js');
    const css = read('web/styles/work-center.css');

    expect(page).toContain('role="dialog" aria-modal="true"');
    expect(page).toContain('class="work-center-modal-header"');
    expect(page).toContain('class="modal-close"');
    expect(page).toContain('class="work-center-modal-footer"');
    expect(page).toContain('class="work-center-create-options"');
    expect(page).toContain("tr('workCenter.titleHint'");
    expect(page).toContain("tr('workCenter.startImmediatelyHint'");
    expect(page).toContain("mixins: [folderPickerMixin]");
    expect(page).toContain('class="work-center-workdir-picker"');
    expect(page).toContain('v-model="form.workDir" type="text" required @input="onCreateWorkDirInput"');
    expect(page).not.toContain('v-model="form.workDir" type="text" required readonly');
    expect(page).toContain('@click="openFolderPicker"');
    expect(page).toContain('class="work-center-directory-dialog"');
    expect(page).toContain('class="work-center-directory-item"');
    expect(page).not.toContain('class="tree-item tree-dir folder-picker-item"');
    expect(page).toContain('chat() { return this.store; }');
    expect(page).toContain('folderPickerSetWorkDir(path)');
    expect(page).toContain('onCreateWorkDirInput()');
    expect(css).toMatch(/\.work-center-modal\s*\{[^}]*height: min\(660px, 86vh\)[^}]*overflow: hidden/s);
    expect(css).toMatch(/\.work-center-modal-body\s*\{[^}]*overflow-y: auto/s);
    expect(css).toContain('.work-center-modal .btn-primary');
    expect(css).toContain('.work-center-modal .btn-secondary');
    expect(css).toContain('.work-center-directory-dialog');
    expect(css).toContain('.work-center-directory-item.selected');
    expect(css).toContain('background: var(--modal-overlay-bg)');
    expect(css).toContain('background: var(--session-active)');
    expect(css).toContain('width: calc(100vw - 16px)');
    expect(css).toContain('height: calc(100dvh - 16px)');
  });

  it('uses backend-projected Board lanes and query filters', () => {
    const page = read('web/components/WorkCenterPage.js');
    const store = read('web/stores/chat.js');

    expect(page).toContain("{ id: 'active'");
    expect(page).toContain("{ id: 'needs_attention'");
    expect(page).toContain("{ id: 'closed'");
    expect(page).toContain('item.boardLane === lane.id');
    expect(page).toContain('v-model="boardVpId"');
    expect(page).toContain('v-model="boardWorkItemType"');
    expect(page).toContain('v-model="boardUpdatedRange"');
    expect(page).toContain('<h2>{{ emptyState.title }}</h2>');
    expect(page).toContain('v-if="emptyState.canCreate"');
    expect(store).toContain('_workCenterListGenerationByAgent');
    expect(store).toContain('_workCenterListQueryByAgent');
  });

  it('lets AI plan WorkItems while settings define reusable prompts, model, and effort', () => {
    const page = read('web/components/WorkCenterPage.js');
    const modal = read('web/components/WorkCenterSettingsModal.js');
    const store = read('web/stores/chat.js');
    const css = read('web/styles/work-center.css');

    expect(page).toContain('WorkCenterSettingsModal');
    expect(page).toContain("tr('workCenter.aiPlan'");
    expect(page).not.toContain('planPreview');
    expect(page).not.toContain('stageOverrides');
    expect(page).not.toContain('workflowTemplate: this.form');
    expect(page).not.toContain('run.modelSnapshot');
    expect(modal).toContain("section: 'workflow'");
    expect(modal).toContain('draft.globalInstructions');
    expect(modal).toContain('draft.actionInstructions[type]');
    expect(modal).toContain("$t('workCenter.action.' + type)");
    expect(modal).toContain('v-for="type in actionTypes"');
    expect(modal).toContain('draft.modelPolicy.effort');
    expect(modal).toContain('work-center-model-effort');
    expect(modal).toContain('effortChooseModelHelp');
    expect(modal).not.toContain("{ id: 'general'");
    expect(modal).not.toContain('v-model="draft.defaultWorkDir"');
    expect(page).toContain("this.settings?.defaultWorkDir || this.runtime?.defaultWorkDir || ''");
    expect(page).toContain('createDefaultWorkDir()');
    expect(page).toContain('folderPickerInitialDir()');
    expect(page).toContain('folderPickerAgentId()');
    expect(modal).toContain("mode === 'specific'");
    expect(modal).toContain("$emit('open-agent-models')");
    expect(page).toContain('<LlmTab context="yeaft"');
    expect(store).toContain("workCenterRequest('get_settings'");
    expect(store).toContain("workCenterRequest('update_settings'");
    expect(store).toContain("workCenterRequest('refresh_runtime'");
    expect(page).toContain('refreshWorkCenterRuntime(agentId)');
    expect(css).toContain('width: min(960px, 92vw)');
    expect(css).toContain('height: min(720px, 86vh)');
    expect(css).toContain('.work-center-settings-pane');
    expect(css).toContain('.work-center-settings-card .btn-ghost');
    expect(css).toContain('overflow-y: auto');
    expect(css).toContain('.work-center-settings-card input[type="text"]');
    expect(css).toContain('.work-center-settings-card input[type="number"]');
    expect(css).toContain('background: var(--bg-input)');
    expect(css).toContain('.work-center-settings-card .btn-primary');
    expect(css).toContain('color: var(--accent-fg)');
  });

  it('gates Work Item attachment controls on the Agent runtime capability', () => {
    const page = read('web/components/WorkCenterPage.js');
    expect(page).toContain('workItemAttachmentsSupported()');
    expect(page).toContain("this.runtime?.workItemAttachments === true");
    expect(page).toContain('v-if="workItemAttachmentsSupported" class="btn-secondary work-center-attachment-picker"');
    expect(read('web/components/WorkCenterActionDetail.js')).toContain('v-if="attachmentsSupported" class="attach-btn work-center-attachment-picker"');
    expect(page).toContain('@attachment-input="onGuidanceAttachmentInput"');
    expect(page).toContain('guidanceAttachments.map(attachment => ({');
    expect(page).toContain('@click="previewAttachment(attachment, $event.currentTarget)"');
    expect(page).toContain('previewWorkItemAttachment(workItemId, attachment.id, agentId)');
    expect(page).toContain("const scope = `${agentId}:${workItemId}:${actionId}`");
    expect(page).toContain("alt: attachment.name || this.tr('workCenter.previewAttachment', 'Open attachment')");
    expect(page).toContain("closeLabel: this.tr('common.close', 'Close')");
    expect(page).toContain("tr('workCenter.attachmentsUnsupported'");
    expect(page).toContain('attachments: this.workItemAttachmentsSupported');
  });

  it('animates only running status dots and honors reduced motion', () => {
    const css = read('web/styles/work-center.css');
    expect(css).toContain('.work-center-status[data-status="running"] > span');
    expect(css).toContain('animation: work-center-running-pulse');
    expect(css).toContain('@keyframes work-center-running-pulse');
    expect(css).toContain('@media (prefers-reduced-motion: reduce)');
    expect(css).not.toMatch(/\.work-center-status\[data-status="ready"\][^{]*\{[^}]*animation:/s);
  });

  it('provides matching English and Chinese Work Center strings', () => {
    const en = read('web/i18n/en.js');
    const zh = read('web/i18n/zh-CN.js');
    const keys = [
      'workCenter.title',
      'workCenter.new',
      'workCenter.newWorkItem',
      'workCenter.workItem',
      'workCenter.createFirst',
      'workCenter.attentionItems',
      'workCenter.activeItems',
      'workCenter.allItems',
      'workCenter.noAttentionTitle',
      'workCenter.noActiveTitle',
      'workCenter.noCompletedTitle',
      'workCenter.actionProgress',
      'workCenter.currentAction',
      'workCenter.settings.instructionHelp',
      'workCenter.settings.instructionReset',
      'workCenter.chooseFolder',
      'workCenter.workDirPickerHelp',
      'workCenter.noMatchesTitle',
      'workCenter.loading',
      'workCenter.noTimestamp',
      'workCenter.updated',
      'workCenter.selectTitle',
      'workCenter.status.needs_attention',
      'workCenter.action.review',
      'workCenter.action.design',
      'workCenter.action.diagnose',
      'workCenter.action.migrate',
      'workCenter.action.document',
      'workCenter.action.operate',
      'workCenter.action.custom',
      'workCenter.guidance',
      'workCenter.sendGuidance',
      'workCenter.llmRequestCount',
      'workCenter.loopCount',
      'workCenter.toolCount',
      'workCenter.tokenCount',
      'workCenter.tokenBreakdown',
      'workCenter.reuseMemory',
      'workCenter.reuseMemoryHelp',
      'workCenter.settings.title',
      'workCenter.settings.globalInstructions',
      'workCenter.settings.globalInstructionsHelp',
      'workCenter.settings.actionPolicies',
      'workCenter.settings.assignment.auto',
      'workCenter.settings.model.specific',
      'workCenter.settings.effortHelp',
      'workCenter.settings.effortChooseModelHelp',
      'workCenter.settings.effortUnsupportedHelp',
      'workCenter.settings.addStage',
      'workCenter.settings.upgradeRequired',
      'workCenter.planPreview',
      'workCenter.attachmentsUnsupported',
      'workCenter.addAttachments',
      'workCenter.previewAttachment',
    ];
    for (const key of keys) {
      expect(en).toContain(`'${key}'`);
      expect(zh).toContain(`'${key}'`);
    }
  });
});
