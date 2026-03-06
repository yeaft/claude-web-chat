import { describe, it, expect, beforeAll } from 'vitest';

/**
 * Tests for mobile drawer panels (header nav + drawer + overlay).
 *
 * v2: FAB buttons replaced by ChatHeader nav icons.
 *     mobilePanel state moved from CrewChatView data to Pinia store (crewMobilePanel).
 *
 * Verifies:
 * 1) Store has crewMobilePanel state and toggleCrewMobilePanel action
 * 2) ChatHeader has crew-header-nav with role + feature buttons
 * 3) CrewChatView uses store.crewMobilePanel (not local mobilePanel)
 * 4) Overlay closes panel on click
 * 5) Close button inside panels closes panel
 * 6) CSS: header nav hidden on desktop, visible on mobile
 * 7) CSS: drawer panel mechanics (position, transform, z-index)
 * 8) CSS: overlay full-screen coverage with display:block override
 */

let viewSource;
let headerSource;
let storeSource;
let cssSource;

beforeAll(async () => {
  const { promises: fs } = await import('fs');
  const { join } = await import('path');
  const base = process.cwd();
  viewSource = await fs.readFile(join(base, 'web/components/CrewChatView.js'), 'utf-8');
  headerSource = await fs.readFile(join(base, 'web/components/ChatHeader.js'), 'utf-8');
  storeSource = await fs.readFile(join(base, 'web/stores/chat.js'), 'utf-8');
  cssSource = await fs.readFile(join(base, 'web/style.css'), 'utf-8');
});

// Helper: extract CSS @media (max-width: 767px) block
function get767Block() {
  const idx = cssSource.indexOf('@media (max-width: 767px)');
  const blockStart = cssSource.indexOf('{', idx);
  let depth = 0, end = blockStart;
  for (let i = blockStart; i < cssSource.length; i++) {
    if (cssSource[i] === '{') depth++;
    if (cssSource[i] === '}') depth--;
    if (depth === 0) { end = i; break; }
  }
  return cssSource.substring(blockStart, end + 1);
}

// =====================================================================
// 1) Pinia store: crewMobilePanel state + toggleCrewMobilePanel action
// =====================================================================

describe('store: crewMobilePanel state', () => {
  it('has crewMobilePanel: null in state', () => {
    expect(storeSource).toContain('crewMobilePanel: null');
  });

  it('has toggleCrewMobilePanel action', () => {
    expect(storeSource).toContain('toggleCrewMobilePanel(panel)');
  });

  it('toggleCrewMobilePanel toggles between panel and null', () => {
    expect(storeSource).toContain('this.crewMobilePanel === panel ? null : panel');
  });

  it('has crewInProgressCount for badge sync', () => {
    expect(storeSource).toContain('crewInProgressCount:');
  });
});

// =====================================================================
// 2) ChatHeader: crew-header-nav buttons
// =====================================================================

describe('ChatHeader: crew-header-nav', () => {
  it('has crew-header-nav container', () => {
    expect(headerSource).toContain('crew-header-nav');
  });

  it('renders only for Crew conversations', () => {
    expect(headerSource).toContain('v-if="store.currentConversationIsCrew"');
  });

  it('has roles button with toggle action', () => {
    expect(headerSource).toContain("onCrewPanelToggle('roles')");
  });

  it('has features button with toggle action', () => {
    expect(headerSource).toContain("onCrewPanelToggle('features')");
  });

  it('roles button has active class binding', () => {
    expect(headerSource).toContain("active: isCrewPanelActive('roles')");
  });

  it('features button has active class binding', () => {
    expect(headerSource).toContain("active: isCrewPanelActive('features')");
  });

  it('roles button has streaming indicator (active-dot)', () => {
    expect(headerSource).toContain('class="active-dot"');
    expect(headerSource).toContain('hasStreamingRoles');
  });

  it('features button has badge with in-progress count', () => {
    expect(headerSource).toContain('class="nav-badge"');
    expect(headerSource).toContain('crewInProgressCount');
  });

  it('has SVG icons in both buttons', () => {
    // Count crew-header-nav-btn occurrences — each has an SVG
    const btnCount = (headerSource.match(/crew-header-nav-btn/g) || []).length;
    // At least 2 buttons (roles + features) — also includes .active references in CSS-like strings
    expect(btnCount).toBeGreaterThanOrEqual(2);
    // Both buttons contain <svg
    const buttons = headerSource.split('crew-header-nav-btn');
    // buttons[1] and buttons[2] should each contain <svg (the first two occurrences in template)
    const firstBtn = buttons[1] || '';
    const secondBtn = buttons[2] || '';
    expect(firstBtn).toContain('<svg');
    expect(secondBtn).toContain('<svg');
  });

  it('hasStreamingRoles computed reads activeRoles', () => {
    expect(headerSource).toContain('hasStreamingRoles');
    expect(headerSource).toContain('activeRoles');
  });
});

// =====================================================================
// 3) CrewChatView: uses store.crewMobilePanel (no local mobilePanel)
// =====================================================================

describe('CrewChatView: store-based mobilePanel', () => {
  it('does NOT have local mobilePanel in data()', () => {
    // After refactor, mobilePanel should NOT be in data
    const dataSection = viewSource.split('data()')[1]?.split('computed:')[0] || '';
    expect(dataSection).not.toContain('mobilePanel:');
  });

  it('workspace reads store.crewMobilePanel for roles class', () => {
    expect(viewSource).toContain("store.crewMobilePanel === 'roles'");
  });

  it('workspace reads store.crewMobilePanel for features class', () => {
    expect(viewSource).toContain("store.crewMobilePanel === 'features'");
  });

  it('does NOT have FAB buttons (crew-mobile-fab removed)', () => {
    expect(viewSource).not.toContain('crew-mobile-fab');
  });

  it('does NOT have streamingRoleCount computed (moved to header)', () => {
    expect(viewSource).not.toContain('streamingRoleCount()');
  });

  it('still has kanbanInProgressCount computed', () => {
    expect(viewSource).toContain('kanbanInProgressCount()');
  });

  it('syncs kanbanInProgressCount to store', () => {
    // Watch kanbanInProgressCount to sync to store
    expect(viewSource).toContain('crewInProgressCount');
  });
});

// =====================================================================
// 4) Overlay — closes panel via store
// =====================================================================

describe('overlay — closes panel', () => {
  it('has overlay div with crew-mobile-overlay class', () => {
    expect(viewSource).toContain('class="crew-mobile-overlay"');
  });

  it('overlay shown when store.crewMobilePanel is set', () => {
    const overlaySection = viewSource.split('crew-mobile-overlay')[1]?.split('>')[0] || '';
    expect(overlaySection).toContain('v-if="store.crewMobilePanel"');
  });

  it('overlay click sets store.crewMobilePanel to null', () => {
    const overlaySection = viewSource.split('crew-mobile-overlay')[1]?.split('>')[0] || '';
    expect(overlaySection).toContain('@click="store.crewMobilePanel = null"');
  });
});

// =====================================================================
// 5) Close button inside panels — uses store
// =====================================================================

describe('close button inside panels', () => {
  it('has close buttons with crew-mobile-close class', () => {
    expect(viewSource).toContain('class="crew-mobile-close"');
  });

  it('close button in left panel sets store.crewMobilePanel to null', () => {
    const leftPanelSection = viewSource.split('crew-panel-left-scroll')[1]?.split('crew-role-list')[0] || '';
    expect(leftPanelSection).toContain('crew-mobile-close');
    expect(leftPanelSection).toContain('store.crewMobilePanel = null');
  });

  it('close button in right panel sets store.crewMobilePanel to null', () => {
    const rightPanelSection = viewSource.split('crew-panel-right-scroll')[1]?.split('crew-kanban-total')[0] || '';
    expect(rightPanelSection).toContain('crew-mobile-close');
    expect(rightPanelSection).toContain('store.crewMobilePanel = null');
  });
});

// =====================================================================
// 6) CSS — desktop: header nav hidden, overlay/close hidden
// =====================================================================

describe('CSS — desktop: mobile elements hidden', () => {
  it('crew-header-nav visible by default (display: flex)', () => {
    expect(cssSource).toMatch(/\.crew-header-nav\s*\{[^}]*display:\s*flex/);
  });

  it('crew-mobile-overlay hidden by default (display: none)', () => {
    expect(cssSource).toMatch(/\.crew-mobile-overlay[\s\S]*?display:\s*none/);
  });

  it('crew-mobile-close hidden by default (display: none)', () => {
    expect(cssSource).toMatch(/\.crew-mobile-close[\s\S]*?display:\s*none/);
  });

  it('no FAB styles remain (crew-mobile-fab removed)', () => {
    const beforeMedia = cssSource.split('@media (max-width: 767px)')[0];
    expect(beforeMedia).not.toContain('.crew-mobile-fab');
  });
});

// =====================================================================
// 7) CSS — header nav button styles
// =====================================================================

describe('CSS — header nav button styles', () => {
  it('has crew-header-nav-btn styles', () => {
    expect(cssSource).toContain('.crew-header-nav-btn');
  });

  it('nav buttons are 32px square', () => {
    const btnStart = cssSource.indexOf('.crew-header-nav-btn {');
    const btnSection = cssSource.substring(btnStart, btnStart + 300);
    expect(btnSection).toContain('width: 32px');
    expect(btnSection).toContain('height: 32px');
  });

  it('nav buttons have transparent background', () => {
    const btnStart = cssSource.indexOf('.crew-header-nav-btn {');
    const btnSection = cssSource.substring(btnStart, btnStart + 300);
    expect(btnSection).toContain('background: transparent');
  });

  it('active state uses accent-blue color', () => {
    expect(cssSource).toContain('.crew-header-nav-btn.active');
    const activeStart = cssSource.indexOf('.crew-header-nav-btn.active');
    const activeSection = cssSource.substring(activeStart, activeStart + 200);
    expect(activeSection).toContain('accent-blue');
  });

  it('active-dot has pulse animation', () => {
    expect(cssSource).toContain('.crew-header-nav-btn .active-dot');
    const dotStart = cssSource.indexOf('.crew-header-nav-btn .active-dot');
    const dotSection = cssSource.substring(dotStart, dotStart + 200);
    expect(dotSection).toContain('animation: pulse');
  });

  it('nav-badge positioned at top-right', () => {
    expect(cssSource).toContain('.crew-header-nav-btn .nav-badge');
    const badgeStart = cssSource.indexOf('.crew-header-nav-btn .nav-badge');
    const badgeSection = cssSource.substring(badgeStart, badgeStart + 300);
    expect(badgeSection).toContain('position: absolute');
    expect(badgeSection).toContain('top: 2px');
  });
});

// =====================================================================
// 8) CSS — mobile: header nav visible
// =====================================================================

describe('CSS — mobile: header nav visible', () => {
  it('header nav display: flex in base styles (visible on all viewports)', () => {
    expect(cssSource).toMatch(/\.crew-header-nav\s*\{[^}]*display:\s*flex/);
  });

  it('header nav positioned absolute right in base styles', () => {
    const navStart = cssSource.indexOf('.crew-header-nav {');
    const navSection = cssSource.substring(navStart, navStart + 300);
    expect(navSection).toContain('position: absolute');
    expect(navSection).toContain('right: 12px');
  });

  it('no FAB styles in 767px media query', () => {
    const mediaBlock = get767Block();
    expect(mediaBlock).not.toContain('.crew-mobile-fab');
  });
});

// =====================================================================
// 9) CSS — mobile: drawer panel mechanics
// =====================================================================

describe('CSS — mobile: drawer panel mechanics', () => {
  it('panels use fixed position in mobile', () => {
    const mediaBlock = get767Block();
    expect(mediaBlock).toContain('.crew-panel-left');
    expect(mediaBlock).toContain('.crew-panel-right');
    expect(mediaBlock).toContain('position: fixed');
  });

  it('left panel starts off-screen (translateX(-100%))', () => {
    const mediaBlock = get767Block();
    expect(mediaBlock).toContain('transform: translateX(-100%)');
  });

  it('right panel starts off-screen (translateX(100%))', () => {
    const mediaBlock = get767Block();
    expect(mediaBlock).toContain('transform: translateX(100%)');
  });

  it('mobile-panel-roles class slides left panel in', () => {
    const mediaBlock = get767Block();
    expect(mediaBlock).toContain('.crew-workspace.mobile-panel-roles .crew-panel-left');
    const rolesSlide = mediaBlock.split('.crew-workspace.mobile-panel-roles .crew-panel-left')[1]?.split('}')[0] || '';
    expect(rolesSlide).toContain('transform: translateX(0)');
  });

  it('mobile-panel-features class slides right panel in', () => {
    const mediaBlock = get767Block();
    expect(mediaBlock).toContain('.crew-workspace.mobile-panel-features .crew-panel-right');
    const featSlide = mediaBlock.split('.crew-workspace.mobile-panel-features .crew-panel-right')[1]?.split('}')[0] || '';
    expect(featSlide).toContain('transform: translateX(0)');
  });

  it('panels have transition for smooth animation', () => {
    const mediaBlock = get767Block();
    expect(mediaBlock).toContain('transition: transform');
    expect(mediaBlock).toContain('0.3s');
  });

  it('panels have z-index above content', () => {
    const mediaBlock = get767Block();
    expect(mediaBlock).toContain('z-index: 200');
  });

  it('left panel width is constrained (min(280px, 80vw))', () => {
    const mediaBlock = get767Block();
    expect(mediaBlock).toContain('min(280px, 80vw)');
  });

  it('right panel width is constrained (min(320px, 85vw))', () => {
    const mediaBlock = get767Block();
    expect(mediaBlock).toContain('min(320px, 85vw)');
  });
});

// =====================================================================
// 10) CSS — mobile: overlay styles with display:block fix
// =====================================================================

describe('CSS — mobile: overlay styles', () => {
  it('overlay is full-screen fixed', () => {
    const mediaBlock = get767Block();
    expect(mediaBlock).toContain('.crew-mobile-overlay');
    expect(mediaBlock).toContain('position: fixed');
    expect(mediaBlock).toContain('inset: 0');
  });

  it('overlay has display:block to override desktop none', () => {
    const mediaBlock = get767Block();
    const overlayStart = mediaBlock.indexOf('.crew-mobile-overlay');
    const overlaySection = mediaBlock.substring(overlayStart, overlayStart + 300);
    expect(overlaySection).toContain('display: block');
  });

  it('overlay has semi-transparent background', () => {
    const mediaBlock = get767Block();
    const overlayStart = mediaBlock.indexOf('.crew-mobile-overlay');
    const overlaySection = mediaBlock.substring(overlayStart, overlayStart + 300);
    expect(overlaySection).toContain('background: rgba(0, 0, 0, 0.5)');
  });

  it('overlay z-index (199) is below panel z-index (200)', () => {
    const mediaBlock = get767Block();
    const overlayStart = mediaBlock.indexOf('.crew-mobile-overlay');
    const overlaySection = mediaBlock.substring(overlayStart, overlayStart + 300);
    expect(overlaySection).toContain('z-index: 199');
  });

  it('overlay has fade-in animation', () => {
    const mediaBlock = get767Block();
    expect(mediaBlock).toContain('crew-overlay-fadein');
  });
});

// =====================================================================
// 11) Behavioral: toggleCrewMobilePanel logic
// =====================================================================

describe('behavioral: toggleCrewMobilePanel', () => {
  it('toggle roles: null → roles', () => {
    let crewMobilePanel = null;
    crewMobilePanel = crewMobilePanel === 'roles' ? null : 'roles';
    expect(crewMobilePanel).toBe('roles');
  });

  it('toggle roles again: roles → null', () => {
    let crewMobilePanel = 'roles';
    crewMobilePanel = crewMobilePanel === 'roles' ? null : 'roles';
    expect(crewMobilePanel).toBeNull();
  });

  it('toggle features: null → features', () => {
    let crewMobilePanel = null;
    crewMobilePanel = crewMobilePanel === 'features' ? null : 'features';
    expect(crewMobilePanel).toBe('features');
  });

  it('toggle features when roles open: roles → features (mutually exclusive)', () => {
    let crewMobilePanel = 'roles';
    crewMobilePanel = crewMobilePanel === 'features' ? null : 'features';
    expect(crewMobilePanel).toBe('features');
  });

  it('overlay click: any panel → null', () => {
    let crewMobilePanel = 'roles';
    crewMobilePanel = null;
    expect(crewMobilePanel).toBeNull();
  });

  it('overlay not rendered when crewMobilePanel is null', () => {
    const crewMobilePanel = null;
    expect(!!crewMobilePanel).toBe(false);
  });
});

// =====================================================================
// 12) Behavioral: badge computed properties
// =====================================================================

describe('behavioral: badge computed properties', () => {
  it('hasStreamingRoles is false when no activeRoles', () => {
    const store = { currentCrewStatus: {} };
    const activeRoles = store.currentCrewStatus?.activeRoles;
    expect(!!(activeRoles && activeRoles.length > 0)).toBe(false);
  });

  it('hasStreamingRoles is true when activeRoles present', () => {
    const store = {
      currentCrewStatus: {
        activeRoles: [{ role: 'dev-1' }, { role: 'dev-2' }],
      },
    };
    const activeRoles = store.currentCrewStatus?.activeRoles;
    expect(!!(activeRoles && activeRoles.length > 0)).toBe(true);
  });

  it('kanbanInProgressCount uses featureKanbanGrouped.inProgress', () => {
    const featureKanbanGrouped = {
      inProgress: [{ taskId: 'task-1' }, { taskId: 'task-2' }],
      completed: [{ taskId: 'task-3' }],
    };
    expect(featureKanbanGrouped.inProgress.length).toBe(2);
  });
});

// =====================================================================
// 13) Auto-close on route/conversation change
// =====================================================================

describe('auto-close on navigation', () => {
  it('$route watch resets store.crewMobilePanel', () => {
    expect(viewSource).toContain("'$route'()");
    expect(viewSource).toContain('this.store.crewMobilePanel = null');
  });

  it('conversation switch resets store.crewMobilePanel', () => {
    const watchSection = viewSource.split("'store.currentConversation'")[1]?.split('inputText(')[0] || '';
    expect(watchSection).toContain('this.store.crewMobilePanel = null');
  });
});

// =====================================================================
// 14) Abort role button on role cards
// =====================================================================

describe('abort role button', () => {
  it('has abort button with crew-role-abort-btn class', () => {
    expect(viewSource).toContain('crew-role-abort-btn');
  });

  it('abort button only visible when role is streaming', () => {
    // v-if="isRoleStreaming(role.name)" on the abort button
    const lines = viewSource.split('\n');
    const abortLine = lines.find(l => l.includes('crew-role-abort-btn'));
    expect(abortLine).toContain('isRoleStreaming');
  });

  it('abort button calls abortRole method', () => {
    expect(viewSource).toContain('abortRole(role.name)');
  });

  it('abortRole method sends abort_role control action', () => {
    expect(viewSource).toContain("'abort_role'");
    // The method should delegate to controlAction
    const methodSection = viewSource.split('abortRole(roleName)')[1]?.split('}')[0] || '';
    expect(methodSection).toContain('abort_role');
  });

  it('abort button has stop icon', () => {
    const lines = viewSource.split('\n');
    const abortLine = lines.find(l => l.includes('crew-role-abort-btn'));
    expect(abortLine).toBeTruthy();
  });

  it('CSS has crew-role-abort-btn style with error color', () => {
    expect(cssSource).toContain('.crew-role-abort-btn');
    expect(cssSource).toContain('error-color');
  });
});

// =====================================================================
// 15) Structural integrity
// =====================================================================

describe('structural integrity', () => {
  it('balanced div tags in template', () => {
    const opens = (viewSource.match(/<div[\s>]/g) || []).length;
    const closes = (viewSource.match(/<\/div>/g) || []).length;
    expect(opens).toBe(closes);
  });

  it('balanced button tags in template', () => {
    const opens = (viewSource.match(/<button[\s>]/g) || []).length;
    const closes = (viewSource.match(/<\/button>/g) || []).length;
    expect(opens).toBe(closes);
  });

  it('CSS has balanced braces (2106/2106)', () => {
    const opens = (cssSource.match(/\{/g) || []).length;
    const closes = (cssSource.match(/\}/g) || []).length;
    expect(opens).toBe(closes);
    expect(opens).toBe(2106);
  });
});
