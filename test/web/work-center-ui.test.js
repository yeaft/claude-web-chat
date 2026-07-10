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
    expect(workCenter).toContain("tr('workCenter.runs'");
    expect(workCenter).toContain('run.waitingReason');
    expect(workCenter).toContain('run.evidence');
  });

  it('uses inline SVG icons and a bounded list-detail workspace', () => {
    const page = read('web/components/WorkCenterPage.js');
    const sidebar = read('web/components/SidebarWorkCenter.js');
    const css = read('web/styles/work-center.css');

    expect(page).toContain('class="work-center-shell"');
    expect(page).toContain('class="work-center-filter"');
    expect(page).toContain("'is-empty': !loading && visibleItems.length === 0");
    expect(sidebar).toContain('<svg class="sidebar-work-center-icon"');
    expect(sidebar).not.toContain('Symbols Nerd Font');
    expect(sidebar).not.toContain('󰄲');
    expect(css).toContain('width: min(100%, 1320px)');
    expect(css).toContain('grid-template-columns: minmax(300px, 390px)');
    expect(css).toContain('.work-center-body.is-empty .work-center-detail');
    expect(css).toContain('.work-center-body.is-empty .work-center-list');
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

  it('provides matching English and Chinese Work Center strings', () => {
    const en = read('web/i18n/en.js');
    const zh = read('web/i18n/zh-CN.js');
    const keys = [
      'workCenter.title',
      'workCenter.newWorkItem',
      'workCenter.activeItems',
      'workCenter.noMatchesTitle',
      'workCenter.selectTitle',
      'workCenter.status.needs_attention',
      'workCenter.action.review',
    ];
    for (const key of keys) {
      expect(en).toContain(`'${key}'`);
      expect(zh).toContain(`'${key}'`);
    }
  });
});
