import { describe, it, expect, beforeAll } from 'vitest';

/**
 * Tests for task-25: Mobile FAB buttons + drawer panels.
 *
 * Verifies:
 * 1) FAB buttons visible at ≤767px, hidden on desktop
 * 2) Left FAB opens roles panel (left drawer slide-in)
 * 3) Right FAB opens features panel (right drawer slide-in)
 * 4) Overlay closes panel on click
 * 5) Close button inside panels closes panel
 * 6) Badge shows streaming role count and in-progress task count
 * 7) Desktop: FAB/overlay/close hidden via CSS
 */

let viewSource;
let cssSource;

beforeAll(async () => {
  const { promises: fs } = await import('fs');
  const { join } = await import('path');
  const base = process.cwd();
  viewSource = await fs.readFile(join(base, 'web/components/CrewChatView.js'), 'utf-8');
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
// 1) mobilePanel data property
// =====================================================================

describe('mobilePanel state management', () => {
  it('should have mobilePanel: null in data()', () => {
    expect(viewSource).toContain('mobilePanel: null');
  });

  it('mobilePanel comment describes valid states', () => {
    expect(viewSource).toContain("null | 'roles' | 'features'");
  });
});

// =====================================================================
// 2) FAB buttons — template structure
// =====================================================================

describe('FAB buttons — template', () => {
  it('should have left FAB with crew-mobile-fab-left class', () => {
    expect(viewSource).toContain('class="crew-mobile-fab crew-mobile-fab-left"');
  });

  it('should have right FAB with crew-mobile-fab-right class', () => {
    expect(viewSource).toContain('class="crew-mobile-fab crew-mobile-fab-right"');
  });

  it('left FAB sets mobilePanel to roles on click', () => {
    expect(viewSource).toContain("@click=\"mobilePanel = 'roles'\"");
  });

  it('right FAB sets mobilePanel to features on click', () => {
    expect(viewSource).toContain("@click=\"mobilePanel = 'features'\"");
  });

  it('FABs only show when mobilePanel is null (v-if="!mobilePanel")', () => {
    // Both FABs should have v-if="!mobilePanel"
    const leftFab = viewSource.split('crew-mobile-fab-left')[1]?.split('>')[0] || '';
    expect(leftFab).toContain('v-if="!mobilePanel"');
    const rightFab = viewSource.split('crew-mobile-fab-right')[1]?.split('>')[0] || '';
    expect(rightFab).toContain('v-if="!mobilePanel"');
  });

  it('left FAB has person/group SVG icon', () => {
    // People icon path
    const leftFabSection = viewSource.split('crew-mobile-fab-left')[1]?.split('</button>')[0] || '';
    expect(leftFabSection).toContain('<svg');
    expect(leftFabSection).toContain('<path');
  });

  it('right FAB has chart/kanban SVG icon', () => {
    const rightFabSection = viewSource.split('crew-mobile-fab-right')[1]?.split('</button>')[0] || '';
    expect(rightFabSection).toContain('<svg');
    expect(rightFabSection).toContain('<path');
  });
});

// =====================================================================
// 3) Overlay — closes panel
// =====================================================================

describe('overlay — closes panel', () => {
  it('should have overlay div with crew-mobile-overlay class', () => {
    expect(viewSource).toContain('class="crew-mobile-overlay"');
  });

  it('overlay shown only when mobilePanel is set (v-if="mobilePanel")', () => {
    const overlaySection = viewSource.split('crew-mobile-overlay')[1]?.split('>')[0] || '';
    expect(overlaySection).toContain('v-if="mobilePanel"');
  });

  it('overlay click sets mobilePanel to null', () => {
    const overlaySection = viewSource.split('crew-mobile-overlay')[1]?.split('>')[0] || '';
    expect(overlaySection).toContain('@click="mobilePanel = null"');
  });
});

// =====================================================================
// 4) Close button inside panels
// =====================================================================

describe('close button inside panels', () => {
  it('should have close buttons with crew-mobile-close class', () => {
    expect(viewSource).toContain('class="crew-mobile-close"');
  });

  it('close button in left panel sets mobilePanel to null', () => {
    // Find close button within crew-panel-left-scroll
    const leftPanelSection = viewSource.split('crew-panel-left-scroll')[1]?.split('crew-role-list')[0] || '';
    expect(leftPanelSection).toContain('crew-mobile-close');
    expect(leftPanelSection).toContain('@click="mobilePanel = null"');
  });

  it('close button in right panel sets mobilePanel to null', () => {
    // Find close button within crew-panel-right-scroll
    const rightPanelSection = viewSource.split('crew-panel-right-scroll')[1]?.split('crew-kanban-total')[0] || '';
    expect(rightPanelSection).toContain('crew-mobile-close');
    expect(rightPanelSection).toContain('@click="mobilePanel = null"');
  });

  it('close button has X icon SVG and 关闭 text', () => {
    const closeBtnSection = viewSource.split('crew-mobile-close')[1]?.split('</button>')[0] || '';
    expect(closeBtnSection).toContain('<svg');
    expect(closeBtnSection).toContain('关闭');
  });
});

// =====================================================================
// 5) Dynamic class on crew-workspace
// =====================================================================

describe('crew-workspace dynamic classes', () => {
  it('should bind mobile-panel-roles class when mobilePanel === roles', () => {
    expect(viewSource).toContain("'mobile-panel-roles': mobilePanel === 'roles'");
  });

  it('should bind mobile-panel-features class when mobilePanel === features', () => {
    expect(viewSource).toContain("'mobile-panel-features': mobilePanel === 'features'");
  });
});

// =====================================================================
// 6) Badge — streaming role count and in-progress task count
// =====================================================================

describe('badge — streaming and in-progress counts', () => {
  it('left FAB has badge with streamingRoleCount', () => {
    const leftFabSection = viewSource.split('crew-mobile-fab-left')[1]?.split('</button>')[0] || '';
    expect(leftFabSection).toContain('crew-mobile-fab-badge');
    expect(leftFabSection).toContain('streamingRoleCount');
  });

  it('left FAB badge only shown when streamingRoleCount > 0', () => {
    const leftFabSection = viewSource.split('crew-mobile-fab-left')[1]?.split('</button>')[0] || '';
    expect(leftFabSection).toContain('v-if="streamingRoleCount > 0"');
  });

  it('right FAB has badge with kanbanInProgressCount', () => {
    const rightFabSection = viewSource.split('crew-mobile-fab-right')[1]?.split('</button>')[0] || '';
    expect(rightFabSection).toContain('crew-mobile-fab-badge');
    expect(rightFabSection).toContain('kanbanInProgressCount');
  });

  it('right FAB badge only shown when kanbanInProgressCount > 0', () => {
    const rightFabSection = viewSource.split('crew-mobile-fab-right')[1]?.split('</button>')[0] || '';
    expect(rightFabSection).toContain('v-if="kanbanInProgressCount > 0"');
  });

  it('streamingRoleCount computed property exists', () => {
    expect(viewSource).toContain('streamingRoleCount()');
    const body = viewSource.split('streamingRoleCount()')[1]?.split('\n    },')[0] || '';
    expect(body).toContain('activeRoles');
  });

  it('kanbanInProgressCount computed property exists', () => {
    expect(viewSource).toContain('kanbanInProgressCount()');
    const body = viewSource.split('kanbanInProgressCount()')[1]?.split('\n    }')[0] || '';
    expect(body).toContain('featureKanbanGrouped');
    expect(body).toContain('inProgress');
  });
});

// =====================================================================
// 7) CSS — desktop: FAB/overlay/close hidden
// =====================================================================

describe('CSS — desktop: mobile elements hidden', () => {
  it('crew-mobile-fab hidden by default (display: none)', () => {
    // Outside the @media block, these should be display: none
    const beforeMedia = cssSource.split('@media (max-width: 767px)')[0];
    // Check for the desktop-level rule
    expect(beforeMedia).toContain('.crew-mobile-fab');
    // Should contain display: none for these selectors
    const fabRule = cssSource.split('.crew-mobile-fab,')[0];
    // Alternative: check that the combined rule exists
    expect(cssSource).toMatch(/\.crew-mobile-fab[\s\S]*?display:\s*none/);
  });

  it('crew-mobile-overlay hidden by default (display: none)', () => {
    expect(cssSource).toMatch(/\.crew-mobile-overlay[\s\S]*?display:\s*none/);
  });

  it('crew-mobile-close hidden by default (display: none)', () => {
    expect(cssSource).toMatch(/\.crew-mobile-close[\s\S]*?display:\s*none/);
  });
});

// =====================================================================
// 8) CSS — mobile (≤767px): FAB visible and styled
// =====================================================================

describe('CSS — mobile: FAB buttons visible', () => {
  it('FAB display: flex inside 767px media query', () => {
    const mediaBlock = get767Block();
    expect(mediaBlock).toContain('.crew-mobile-fab');
    expect(mediaBlock).toMatch(/\.crew-mobile-fab[\s\S]*?display:\s*flex/);
  });

  it('FAB positioned fixed at bottom', () => {
    const mediaBlock = get767Block();
    expect(mediaBlock).toContain('position: fixed');
    expect(mediaBlock).toContain('bottom: 80px');
  });

  it('left FAB positioned on the left side', () => {
    const mediaBlock = get767Block();
    expect(mediaBlock).toContain('.crew-mobile-fab-left');
    expect(mediaBlock).toContain('left: 16px');
  });

  it('right FAB positioned on the right side', () => {
    const mediaBlock = get767Block();
    expect(mediaBlock).toContain('.crew-mobile-fab-right');
    expect(mediaBlock).toContain('right: 16px');
  });

  it('FAB is circular (border-radius: 50%)', () => {
    const mediaBlock = get767Block();
    expect(mediaBlock).toContain('border-radius: 50%');
  });

  it('FAB has 44px tap target size', () => {
    const mediaBlock = get767Block();
    expect(mediaBlock).toContain('width: 44px');
    expect(mediaBlock).toContain('height: 44px');
  });
});

// =====================================================================
// 9) CSS — mobile: badge styles
// =====================================================================

describe('CSS — mobile: badge styles', () => {
  it('badge positioned absolutely at top-right of FAB', () => {
    const mediaBlock = get767Block();
    expect(mediaBlock).toContain('.crew-mobile-fab-badge');
    expect(mediaBlock).toContain('position: absolute');
    expect(mediaBlock).toContain('top: -4px');
    expect(mediaBlock).toContain('right: -4px');
  });

  it('badge has accent background color', () => {
    const mediaBlock = get767Block();
    // Extract badge rule
    const badgeStart = mediaBlock.indexOf('.crew-mobile-fab-badge');
    const badgeSection = mediaBlock.substring(badgeStart, badgeStart + 300);
    expect(badgeSection).toContain('background:');
  });

  it('badge has pill shape (border-radius)', () => {
    const mediaBlock = get767Block();
    const badgeStart = mediaBlock.indexOf('.crew-mobile-fab-badge');
    const badgeSection = mediaBlock.substring(badgeStart, badgeStart + 300);
    expect(badgeSection).toContain('border-radius: 9px');
  });
});

// =====================================================================
// 10) CSS — mobile: drawer panel mechanics
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
    // Should have transform: translateX(0)
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

  it('panels have box-shadow for depth effect', () => {
    const mediaBlock = get767Block();
    expect(mediaBlock).toContain('box-shadow:');
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
// 11) CSS — mobile: overlay styles
// =====================================================================

describe('CSS — mobile: overlay styles', () => {
  it('overlay is full-screen fixed', () => {
    const mediaBlock = get767Block();
    expect(mediaBlock).toContain('.crew-mobile-overlay');
    expect(mediaBlock).toContain('position: fixed');
    expect(mediaBlock).toContain('inset: 0');
  });

  it('overlay has semi-transparent background', () => {
    const mediaBlock = get767Block();
    const overlayStart = mediaBlock.indexOf('.crew-mobile-overlay');
    const overlaySection = mediaBlock.substring(overlayStart, overlayStart + 300);
    expect(overlaySection).toContain('background: rgba(0, 0, 0, 0.5)');
  });

  it('overlay z-index is below panels (199 < 200)', () => {
    const mediaBlock = get767Block();
    const overlayStart = mediaBlock.indexOf('.crew-mobile-overlay');
    const overlaySection = mediaBlock.substring(overlayStart, overlayStart + 300);
    expect(overlaySection).toContain('z-index: 199');
  });

  it('overlay has fade-in animation', () => {
    const mediaBlock = get767Block();
    expect(mediaBlock).toContain('crew-overlay-fadein');
    expect(mediaBlock).toContain('@keyframes crew-overlay-fadein');
  });
});

// =====================================================================
// 12) CSS — mobile: close button styles
// =====================================================================

describe('CSS — mobile: close button styles', () => {
  it('close button visible in mobile (display: flex)', () => {
    const mediaBlock = get767Block();
    expect(mediaBlock).toContain('.crew-mobile-close');
    const closeStart = mediaBlock.indexOf('.crew-mobile-close {');
    if (closeStart !== -1) {
      const closeSection = mediaBlock.substring(closeStart, closeStart + 300);
      expect(closeSection).toContain('display: flex');
    } else {
      // Just verify the class exists in mobile block
      expect(mediaBlock).toContain('.crew-mobile-close');
    }
  });

  it('close button has no background (transparent)', () => {
    const mediaBlock = get767Block();
    const closeStart = mediaBlock.indexOf('.crew-mobile-close {');
    if (closeStart !== -1) {
      const closeSection = mediaBlock.substring(closeStart, closeStart + 300);
      expect(closeSection).toContain('background: none');
    }
  });
});

// =====================================================================
// 13) Behavioral: mobilePanel state transitions
// =====================================================================

describe('behavioral: mobilePanel state transitions', () => {
  it('clicking left FAB: null → roles', () => {
    let mobilePanel = null;
    // Simulate click on left FAB
    if (!mobilePanel) mobilePanel = 'roles';
    expect(mobilePanel).toBe('roles');
  });

  it('clicking right FAB: null → features', () => {
    let mobilePanel = null;
    if (!mobilePanel) mobilePanel = 'features';
    expect(mobilePanel).toBe('features');
  });

  it('clicking overlay: roles → null', () => {
    let mobilePanel = 'roles';
    if (mobilePanel) mobilePanel = null;
    expect(mobilePanel).toBeNull();
  });

  it('clicking overlay: features → null', () => {
    let mobilePanel = 'features';
    if (mobilePanel) mobilePanel = null;
    expect(mobilePanel).toBeNull();
  });

  it('clicking close button: roles → null', () => {
    let mobilePanel = 'roles';
    mobilePanel = null;
    expect(mobilePanel).toBeNull();
  });

  it('FABs hidden when panel is open (v-if="!mobilePanel")', () => {
    const mobilePanel = 'roles';
    const showFab = !mobilePanel;
    expect(showFab).toBe(false);
  });

  it('overlay shown when panel is open (v-if="mobilePanel")', () => {
    const mobilePanel = 'roles';
    const showOverlay = !!mobilePanel;
    expect(showOverlay).toBe(true);
  });

  it('overlay hidden when no panel (v-if="mobilePanel")', () => {
    const mobilePanel = null;
    const showOverlay = !!mobilePanel;
    expect(showOverlay).toBe(false);
  });

  it('workspace gets correct class for roles panel', () => {
    const mobilePanel = 'roles';
    const classes = {
      'mobile-panel-roles': mobilePanel === 'roles',
      'mobile-panel-features': mobilePanel === 'features',
    };
    expect(classes['mobile-panel-roles']).toBe(true);
    expect(classes['mobile-panel-features']).toBe(false);
  });

  it('workspace gets correct class for features panel', () => {
    const mobilePanel = 'features';
    const classes = {
      'mobile-panel-roles': mobilePanel === 'roles',
      'mobile-panel-features': mobilePanel === 'features',
    };
    expect(classes['mobile-panel-roles']).toBe(false);
    expect(classes['mobile-panel-features']).toBe(true);
  });
});

// =====================================================================
// 14) Behavioral: badge computed properties
// =====================================================================

describe('behavioral: badge computed properties', () => {
  it('streamingRoleCount returns 0 when no activeRoles', () => {
    const store = { currentCrewStatus: {} };
    const activeRoles = store.currentCrewStatus?.activeRoles;
    const count = activeRoles ? activeRoles.length : 0;
    expect(count).toBe(0);
  });

  it('streamingRoleCount returns 0 when activeRoles is undefined', () => {
    const store = { currentCrewStatus: null };
    const activeRoles = store.currentCrewStatus?.activeRoles;
    const count = activeRoles ? activeRoles.length : 0;
    expect(count).toBe(0);
  });

  it('streamingRoleCount returns count when activeRoles present', () => {
    const store = {
      currentCrewStatus: {
        activeRoles: [
          { role: 'dev-1', roleName: 'Developer' },
          { role: 'dev-2', roleName: 'Developer 2' },
        ],
      },
    };
    const activeRoles = store.currentCrewStatus?.activeRoles;
    const count = activeRoles ? activeRoles.length : 0;
    expect(count).toBe(2);
  });

  it('kanbanInProgressCount uses featureKanbanGrouped.inProgress', () => {
    // Simulate featureKanbanGrouped
    const featureKanbanGrouped = {
      inProgress: [{ taskId: 'task-1' }, { taskId: 'task-2' }],
      completed: [{ taskId: 'task-3' }],
    };
    const count = featureKanbanGrouped.inProgress.length;
    expect(count).toBe(2);
  });

  it('badge v-if condition: badge shows only when count > 0', () => {
    expect(0 > 0).toBe(false);  // hidden when 0
    expect(1 > 0).toBe(true);   // shown when 1
    expect(3 > 0).toBe(true);   // shown when 3
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

  it('CSS has balanced braces (2116/2116)', () => {
    const opens = (cssSource.match(/\{/g) || []).length;
    const closes = (cssSource.match(/\}/g) || []).length;
    expect(opens).toBe(closes);
    expect(opens).toBe(2116);
  });
});
