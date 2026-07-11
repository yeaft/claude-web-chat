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
    expect(yeaftSidebar).toContain(':active="chatStore ? chatStore.workCenterOpen : false"');
    expect(yeaftSidebar).toContain('leaveWorkCenter');
  });

  it('keeps Agent-level Work Center state separate from Session background tasks', () => {
    const store = read('web/stores/chat.js');
    expect(store).toContain('workCenterItemsByAgent');
    expect(store).toContain('workCenterDetailByAgent');
    expect(store).toContain("type: 'work_center_request'");
    expect(store).toContain('workCenterOpen: false');
    expect(store).toContain('this.workCenterOpen = true');
    expect(store).toContain('this.workCenterOpen = false');
    expect(store).not.toContain("currentView = 'work-center'");
    expect(store).not.toContain('workCenterActiveTasksBySession');
  });

  it('offers Session-to-WorkItem creation and renders aggregate Action execution counts', () => {
    const input = read('web/components/ChatInput.js');
    const page = read('web/components/YeaftPage.js');
    const workCenter = read('web/components/WorkCenterPage.js');
    const store = read('web/stores/chat.js');
    expect(input).toContain('workItemFn');
    expect(page).toContain(':work-item-fn="openWorkItemDraft"');
    expect(store).toContain('enterWorkCenterFromSession');
    expect(workCenter).toContain('class="work-center-action-card"');
    expect(workCenter).toContain("$t('workCenter.loopCount', { count: action.loopCount || 0 })");
    expect(workCenter).toContain("$t('workCenter.toolCount', { count: action.toolCount || 0 })");
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

  it('uses expandable user-facing Action responses without raw execution detail', () => {
    const page = read('web/components/WorkCenterPage.js');
    const store = read('web/stores/chat.js');
    const css = read('web/styles/work-center.css');

    expect(page).toContain('class="work-center-action-card"');
    expect(page).toContain('class="work-center-action-stats"');
    expect(page).toContain('@click="toggleAction(action)"');
    expect(page).toContain('class="work-center-action-body"');
    expect(page).toContain('class="work-center-action-response"');
    expect(page).not.toContain('class="work-center-run"');
    expect(page).not.toContain('class="work-center-activity-toggle"');
    expect(page).toContain("['ready','running'].includes(selected.status)");
    expect(page).toContain('@click="guideSelectedAction"');
    expect(store).toContain("workCenterRequest('guide'");
    expect(css).toContain('.work-center-action-card');
    expect(css).toContain('.work-center-action-stats');
    expect(css).toContain('.work-center-action-response');
    expect(page).not.toContain('v-for="tool');
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
    expect(css).toContain('width: min(100%, 1080px)');
    expect(css).toContain('grid-template-columns: minmax(280px, 340px)');
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

    expect(css).toContain('@media (max-width: 960px)');
    expect(css).toContain('@media (max-width: 768px)');
    expect(css).not.toContain('@media (max-width: 760px)');
    expect(css).toContain('.work-center-header-create span');
    expect(css).toContain('flex-direction: column-reverse');
    expect(page).toContain(':aria-label="tr(\'workCenter.newWorkItem\'');
  });

  it('uses filter-specific list headings and empty states', () => {
    const page = read('web/components/WorkCenterPage.js');

    expect(page).toContain("this.filter === 'all'");
    expect(page).toContain("tr('workCenter.allItems'");
    expect(page).toContain("tr('workCenter.noOpenTitle'");
    expect(page).toContain("tr('workCenter.noCompletedTitle'");
    expect(page).toContain('<span>{{ listHeading }}</span>');
    expect(page).toContain('<h2>{{ emptyState.title }}</h2>');
    expect(page).toContain('v-if="emptyState.canCreate"');
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
    expect(modal).toContain('draft.actionInstructions[type]');
    expect(modal).toContain("$t('workCenter.action.' + type)");
    expect(modal).toContain('draft.modelPolicy.effort');
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

  it('provides matching English and Chinese Work Center strings', () => {
    const en = read('web/i18n/en.js');
    const zh = read('web/i18n/zh-CN.js');
    const keys = [
      'workCenter.title',
      'workCenter.new',
      'workCenter.newWorkItem',
      'workCenter.workItem',
      'workCenter.createFirst',
      'workCenter.activeItems',
      'workCenter.allItems',
      'workCenter.noOpenTitle',
      'workCenter.noCompletedTitle',
      'workCenter.settings.instructionHelp',
      'workCenter.settings.instructionReset',
      'workCenter.noMatchesTitle',
      'workCenter.loading',
      'workCenter.noTimestamp',
      'workCenter.updated',
      'workCenter.selectTitle',
      'workCenter.status.needs_attention',
      'workCenter.action.review',
      'workCenter.action.custom',
      'workCenter.guidance',
      'workCenter.sendGuidance',
      'workCenter.loopCount',
      'workCenter.toolCount',
      'workCenter.reuseMemory',
      'workCenter.settings.title',
      'workCenter.settings.assignment.auto',
      'workCenter.settings.model.specific',
      'workCenter.settings.addStage',
      'workCenter.settings.upgradeRequired',
      'workCenter.planPreview',
    ];
    for (const key of keys) {
      expect(en).toContain(`'${key}'`);
      expect(zh).toContain(`'${key}'`);
    }
  });
});
