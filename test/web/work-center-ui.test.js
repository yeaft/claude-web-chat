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

  it('uses existing design tokens and adds no hard-coded colors', () => {
    const css = read('web/styles/work-center.css');
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(css).not.toMatch(/rgba?\(/i);
    expect(css).toContain('var(--bg-main)');
    expect(css).toContain('var(--text-primary)');
    expect(css).toContain('var(--bg-sidebar)');
    expect(css).toContain('var(--sidebar-hover)');
    expect(css).toContain('var(--session-active)');
    expect(css).not.toContain('border-bottom');
    expect(css).not.toContain('border-top');
  });

  it('provides matching English and Chinese Work Center strings', () => {
    const en = read('web/i18n/en.js');
    const zh = read('web/i18n/zh-CN.js');
    const keys = [
      'workCenter.title',
      'workCenter.newWorkItem',
      'workCenter.noOnlineAgents',
      'workCenter.workItem',
      'workCenter.noTimestamp',
      'workCenter.loading',
      'workCenter.updated',
      'workCenter.status.needs_attention',
      'workCenter.action.review',
      'workCenter.retry',
    ];
    for (const key of keys) {
      expect(en).toContain(`'${key}'`);
      expect(zh).toContain(`'${key}'`);
    }
  });
});
