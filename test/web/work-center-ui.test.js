import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const read = path => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');

describe('Work Center UI contract', () => {
  it('registers the Agent-level page and exposes it from both sidebars', () => {
    const app = read('web/app.js');
    const chat = read('web/components/ChatPage.js');
    const yeaft = read('web/components/YeaftSidebar.js');

    expect(app).toContain("currentView === 'work-center'");
    expect(app).toContain('WorkCenterPage');
    expect(chat).toContain('SidebarWorkCenter');
    expect(chat).toContain('@open="store.enterWorkCenter"');
    expect(yeaft).toContain('SidebarWorkCenter');
    expect(yeaft).toContain('@open="onOpenWorkCenter"');
  });

  it('keeps Agent-level Work Center state separate from Session background tasks', () => {
    const store = read('web/stores/chat.js');
    expect(store).toContain('workCenterItemsByAgent');
    expect(store).toContain('workCenterDetailByAgent');
    expect(store).toContain("type: 'work_center_request'");
    expect(store).toContain("workCenterReturnView: 'chat'");
    expect(store).toContain("this.workCenterReturnView = this.currentView === 'yeaft' ? 'yeaft' : 'chat'");
    expect(store).not.toContain('workCenterActiveTasksBySession');
  });

  it('offers Session-to-WorkItem creation and renders Run evidence', () => {
    const input = read('web/components/ChatInput.js');
    const page = read('web/components/YeaftPage.js');
    const workCenter = read('web/components/WorkCenterPage.js');
    const store = read('web/stores/chat.js');
    expect(input).toContain('workItemFn');
    expect(page).toContain(':work-item-fn="openWorkItemDraft"');
    expect(store).toContain('enterWorkCenterFromSession');
    expect(workCenter).toContain('class="work-center-action-card"');
    expect(workCenter).toContain('runsForAction(action.id)');
    expect(workCenter).toContain('run.waitingReason');
    expect(workCenter).toContain('run.evidence');
  });

  it('reuses Session sidebar primitives for the Work Center Agent list', () => {
    const chat = read('web/components/ChatPage.js');
    const page = read('web/components/WorkCenterPage.js');
    const sidebar = read('web/components/SidebarWorkCenter.js');
    const css = read('web/styles/work-center.css');

    expect(sidebar).toContain('session-tab-bar sidebar-work-center-tab-bar');
    expect(sidebar).toContain('session-tab session-tab-solo sidebar-work-center-trigger');
    expect(sidebar).toContain('session-panel-list sidebar-work-center-agent-list');
    expect(sidebar).toContain('session-item sidebar-work-center-agent');
    expect(sidebar).toContain('session-item-header');
    expect(css).toContain('Work Center uses the same tab and row primitives as the Session list');
    expect(page).toContain('sidebar-nav-item work-center-back-button');
    expect(page).toContain('<SidebarModeToggle :view="store.workCenterReturnView');
    expect(page).toContain('<WorkbenchPanel v-if="canUseWorkbench"');
    expect(page).toContain("'workbench-maximized': canUseWorkbench && store.workbenchMaximized && store.workbenchExpanded");
    expect(css).toContain('.work-center-main.workbench-maximized');
    expect(chat.indexOf('<SidebarWorkCenter')).toBeGreaterThan(chat.indexOf('<!-- Connection warning -->'));
  });

  it('uses collapsible Action cards and Action-level guidance instead of a tool-call feed', () => {
    const page = read('web/components/WorkCenterPage.js');
    const store = read('web/stores/chat.js');
    const css = read('web/styles/work-center.css');

    expect(page).toContain('class="work-center-action-card"');
    expect(page).toContain('@click="toggleAction(action)"');
    expect(page).toContain("['ready','running'].includes(selected.status)");
    expect(page).toContain('@click="guideSelectedAction"');
    expect(store).toContain("workCenterRequest('guide'");
    expect(css).toContain('.work-center-action-card');
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
      'workCenter.noMatchesTitle',
      'workCenter.loading',
      'workCenter.noTimestamp',
      'workCenter.updated',
      'workCenter.selectTitle',
      'workCenter.status.needs_attention',
      'workCenter.action.review',
      'workCenter.guidance',
      'workCenter.sendGuidance',
      'workCenter.reuseMemory',
    ];
    for (const key of keys) {
      expect(en).toContain(`'${key}'`);
      expect(zh).toContain(`'${key}'`);
    }
  });
});
