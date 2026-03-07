import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

/**
 * Tests for PR #115: Dashboard dual-theme styling fix.
 *
 * Problem: Dashboard cards/sections were nearly invisible in light theme
 * because --bg-user-msg (#eeeee9) is too close to --bg-main (#fafaf8).
 *
 * Fix: Use separate backgrounds per theme via [data-theme="dark"] selector:
 * - Light theme: --bg-sidebar (#f3f3f0) — good contrast vs --bg-main (#fafaf8)
 * - Dark theme: --bg-user-msg (#2a2a28) — good contrast vs --bg-main (#1a1a1a)
 * - Both: --border-color + box-shadow for visual depth
 *
 * Verifies:
 * 1) Light theme: stat cards and sections use --bg-sidebar background
 * 2) Dark theme override: [data-theme="dark"] switches to --bg-user-msg
 * 3) box-shadow present on cards and sections for visual depth
 * 4) Mobile responsive: section has reduced padding, 2x2 grid for stats
 * 5) Table row separators visible with --border-color in both themes
 * 6) CSS braces balanced and count tracked
 */

let dashboardCss;
let variablesCss;

beforeAll(() => {
  const base = resolve(__dirname, '../../web/styles');
  dashboardCss = readFileSync(resolve(base, 'dashboard.css'), 'utf-8');
  variablesCss = readFileSync(resolve(base, 'variables.css'), 'utf-8');
});

// =====================================================================
// 1. Light theme: stat cards use --bg-sidebar (default)
// =====================================================================
describe('light theme stat card styling', () => {
  it('stat card default background is --bg-sidebar', () => {
    // The base .db-stat-card rule (not inside dark override)
    const cardBlock = dashboardCss.split('.db-stat-card')[1]?.split('}')[0] || '';
    expect(cardBlock).toContain('background: var(--bg-sidebar)');
  });

  it('stat card has border using --border-color', () => {
    const cardBlock = dashboardCss.split('.db-stat-card')[1]?.split('}')[0] || '';
    expect(cardBlock).toContain('border: 1px solid var(--border-color)');
  });

  it('stat card has border-radius for card appearance', () => {
    const cardBlock = dashboardCss.split('.db-stat-card')[1]?.split('}')[0] || '';
    expect(cardBlock).toContain('border-radius: 10px');
  });

  it('stat card has box-shadow for visual depth', () => {
    const cardBlock = dashboardCss.split('.db-stat-card')[1]?.split('}')[0] || '';
    expect(cardBlock).toContain('box-shadow');
  });
});

// =====================================================================
// 2. Dark theme override: stat cards switch to --bg-user-msg
// =====================================================================
describe('dark theme stat card override', () => {
  it('has [data-theme="dark"] .db-stat-card override rule', () => {
    expect(dashboardCss).toContain('[data-theme="dark"] .db-stat-card');
  });

  it('dark theme stat card uses --bg-user-msg background', () => {
    const darkCardBlock = dashboardCss.split('[data-theme="dark"] .db-stat-card')[1]?.split('}')[0] || '';
    expect(darkCardBlock).toContain('background: var(--bg-user-msg)');
  });
});

// =====================================================================
// 3. Light theme: section containers use --bg-sidebar (default)
// =====================================================================
describe('light theme section styling', () => {
  it('section default background is --bg-sidebar', () => {
    const sectionBlock = dashboardCss.split('.db-section {')[1]?.split('}')[0] || '';
    expect(sectionBlock).toContain('background: var(--bg-sidebar)');
  });

  it('section has border using --border-color', () => {
    const sectionBlock = dashboardCss.split('.db-section {')[1]?.split('}')[0] || '';
    expect(sectionBlock).toContain('border: 1px solid var(--border-color)');
  });

  it('section has border-radius for card appearance', () => {
    const sectionBlock = dashboardCss.split('.db-section {')[1]?.split('}')[0] || '';
    expect(sectionBlock).toContain('border-radius: 10px');
  });

  it('section has box-shadow for visual depth', () => {
    const sectionBlock = dashboardCss.split('.db-section {')[1]?.split('}')[0] || '';
    expect(sectionBlock).toContain('box-shadow');
  });
});

// =====================================================================
// 4. Dark theme override: section switches to --bg-user-msg
// =====================================================================
describe('dark theme section override', () => {
  it('has [data-theme="dark"] .db-section override rule', () => {
    expect(dashboardCss).toContain('[data-theme="dark"] .db-section');
  });

  it('dark theme section uses --bg-user-msg background', () => {
    const darkSectionBlock = dashboardCss.split('[data-theme="dark"] .db-section')[1]?.split('}')[0] || '';
    expect(darkSectionBlock).toContain('background: var(--bg-user-msg)');
  });
});

// =====================================================================
// 5. Color contrast verification: variables.css
// =====================================================================
describe('color contrast - light theme', () => {
  it('light --bg-sidebar differs from --bg-main for card visibility', () => {
    const rootSection = variablesCss.split(':root')[1]?.split('[data-theme')[0] || '';
    const bgMain = rootSection.match(/--bg-main:\s*(#[0-9a-fA-F]+)/)?.[1];
    const bgSidebar = rootSection.match(/--bg-sidebar:\s*(#[0-9a-fA-F]+)/)?.[1];
    expect(bgMain).toBeDefined();
    expect(bgSidebar).toBeDefined();
    expect(bgMain).not.toBe(bgSidebar);
  });

  it('light --bg-sidebar is darker than --bg-main (better contrast)', () => {
    const rootSection = variablesCss.split(':root')[1]?.split('[data-theme')[0] || '';
    const bgMain = rootSection.match(/--bg-main:\s*#([0-9a-fA-F]+)/)?.[1];
    const bgSidebar = rootSection.match(/--bg-sidebar:\s*#([0-9a-fA-F]+)/)?.[1];
    if (bgMain && bgSidebar) {
      // Parse RGB from 6-char hex, sum channels
      const mainSum = parseInt(bgMain.slice(0, 2), 16) + parseInt(bgMain.slice(2, 4), 16) + parseInt(bgMain.slice(4, 6), 16);
      const sidebarSum = parseInt(bgSidebar.slice(0, 2), 16) + parseInt(bgSidebar.slice(2, 4), 16) + parseInt(bgSidebar.slice(4, 6), 16);
      // Sidebar should be darker (lower RGB sum) than main
      expect(sidebarSum).toBeLessThan(mainSum);
    }
  });

  it('light --bg-user-msg is too close to --bg-main (the problem PR #115 fixes)', () => {
    // This test documents the problem: --bg-user-msg contrast is bad in light theme
    const rootSection = variablesCss.split(':root')[1]?.split('[data-theme')[0] || '';
    const bgMain = rootSection.match(/--bg-main:\s*#([0-9a-fA-F]+)/)?.[1];
    const bgUserMsg = rootSection.match(/--bg-user-msg:\s*#([0-9a-fA-F]+)/)?.[1];
    if (bgMain && bgUserMsg) {
      const mainR = parseInt(bgMain.slice(0, 2), 16);
      const userR = parseInt(bgUserMsg.slice(0, 2), 16);
      // The difference should be small (that's why it was invisible)
      expect(Math.abs(mainR - userR)).toBeLessThan(20);
    }
  });
});

describe('color contrast - dark theme', () => {
  it('dark --bg-user-msg differs significantly from --bg-main', () => {
    const darkSection = variablesCss.split('[data-theme="dark"]')[1] || '';
    const bgMain = darkSection.match(/--bg-main:\s*#([0-9a-fA-F]+)/)?.[1];
    const bgUserMsg = darkSection.match(/--bg-user-msg:\s*#([0-9a-fA-F]+)/)?.[1];
    if (bgMain && bgUserMsg) {
      expect(bgMain).not.toBe(bgUserMsg);
      // Dark --bg-user-msg should be brighter than --bg-main
      const mainR = parseInt(bgMain.slice(0, 2), 16);
      const userR = parseInt(bgUserMsg.slice(0, 2), 16);
      expect(userR).toBeGreaterThan(mainR);
    }
  });

  it('dark --bg-user-msg is brighter than --bg-sidebar (better contrast)', () => {
    const darkSection = variablesCss.split('[data-theme="dark"]')[1] || '';
    const bgSidebar = darkSection.match(/--bg-sidebar:\s*#([0-9a-fA-F]+)/)?.[1];
    const bgUserMsg = darkSection.match(/--bg-user-msg:\s*#([0-9a-fA-F]+)/)?.[1];
    if (bgSidebar && bgUserMsg) {
      const sidebarVal = parseInt(bgSidebar, 16);
      const userMsgVal = parseInt(bgUserMsg, 16);
      expect(userMsgVal).toBeGreaterThan(sidebarVal);
    }
  });
});

// =====================================================================
// 6. box-shadow provides visual depth in both themes
// =====================================================================
describe('box-shadow for visual depth', () => {
  it('stat card has rgba box-shadow', () => {
    const cardBlock = dashboardCss.split('.db-stat-card')[1]?.split('}')[0] || '';
    expect(cardBlock).toMatch(/box-shadow:\s*0\s+1px\s+3px\s+rgba/);
  });

  it('section has rgba box-shadow', () => {
    const sectionBlock = dashboardCss.split('.db-section {')[1]?.split('}')[0] || '';
    expect(sectionBlock).toMatch(/box-shadow:\s*0\s+1px\s+3px\s+rgba/);
  });
});

// =====================================================================
// 7. Table row separators visible in both themes
// =====================================================================
describe('table row separators', () => {
  it('table header has 2px solid --border-color bottom border', () => {
    const thBlock = dashboardCss.split('.db-table th')[1]?.split('}')[0] || '';
    expect(thBlock).toContain('border-bottom: 2px solid var(--border-color)');
  });

  it('table cell has 1px solid --border-color bottom border', () => {
    const tdBlock = dashboardCss.split('.db-table td')[1]?.split('}')[0] || '';
    expect(tdBlock).toContain('border-bottom: 1px solid var(--border-color)');
  });

  it('section header has bottom border separator', () => {
    const headerBlock = dashboardCss.split('.db-section-header')[1]?.split('}')[0] || '';
    expect(headerBlock).toContain('border-bottom: 1px solid var(--border-color)');
  });
});

// =====================================================================
// 8. Mobile responsive: 2x2 grid for stats, section padding
// =====================================================================
describe('mobile responsive layout', () => {
  let mobileSection;

  beforeAll(() => {
    mobileSection = dashboardCss.split('@media (max-width: 640px)')[1] || '';
  });

  it('stats row switches to 2x2 grid on mobile', () => {
    expect(mobileSection).toContain('.db-stats-row');
    expect(mobileSection).toContain('display: grid');
    expect(mobileSection).toContain('grid-template-columns: 1fr 1fr');
  });

  it('stat card has reduced padding on mobile', () => {
    expect(mobileSection).toContain('.db-stat-card');
    // Extract stat-card block in mobile
    const statCardMobile = mobileSection.split('.db-stat-card')[1]?.split('}')[0] || '';
    expect(statCardMobile).toContain('padding: 12px');
  });

  it('section has reduced padding on mobile', () => {
    expect(mobileSection).toContain('.db-section');
    // Extract section block in mobile section
    const sectionMobile = mobileSection.split('.db-section')[1]?.split('}')[0] || '';
    expect(sectionMobile).toContain('padding: 12px');
  });

  it('table is hidden on mobile, card list shown', () => {
    expect(mobileSection).toContain('.db-table-wrap');
    expect(mobileSection).toMatch(/\.db-table-wrap\s*\{\s*display:\s*none/);
    expect(mobileSection).toMatch(/\.db-card-list\s*\{[^}]*display:\s*flex/);
  });

  it('mobile card list uses column layout with gap: 0', () => {
    const cardListMobile = mobileSection.split('.db-card-list')[1]?.split('}')[0] || '';
    expect(cardListMobile).toContain('flex-direction: column');
    expect(cardListMobile).toContain('gap: 0');
  });

  it('mobile cards have border-bottom separators using --border-color', () => {
    expect(mobileSection).toContain('.db-user-card');
    expect(mobileSection).toContain('.db-agent-card');
    expect(mobileSection).toContain('.db-online-card');
    expect(mobileSection).toContain('border-bottom: 1px solid var(--border-color)');
  });

  it('last mobile card removes border-bottom', () => {
    expect(mobileSection).toContain(':last-child');
    expect(mobileSection).toContain('border-bottom: none');
  });
});

// =====================================================================
// 9. No --border-light usage (insufficient contrast in dark theme)
// =====================================================================
describe('no low-contrast border variable', () => {
  it('dashboard.css does NOT use --border-light anywhere', () => {
    expect(dashboardCss).not.toContain('var(--border-light)');
  });
});

// =====================================================================
// 10. Consistent dual-theme pattern: both overrides use same selector
// =====================================================================
describe('dual-theme pattern consistency', () => {
  it('dark theme overrides exist for both stat-card and section', () => {
    expect(dashboardCss).toContain('[data-theme="dark"] .db-stat-card');
    expect(dashboardCss).toContain('[data-theme="dark"] .db-section');
  });

  it('dark override rules only set background (minimal override)', () => {
    const darkCard = dashboardCss.split('[data-theme="dark"] .db-stat-card')[1]?.split('}')[0] || '';
    const darkSection = dashboardCss.split('[data-theme="dark"] .db-section')[1]?.split('}')[0] || '';
    // Should only contain background property
    expect(darkCard.trim()).toMatch(/^\s*\{\s*background:\s*var\(--bg-user-msg\);\s*$/);
    expect(darkSection.trim()).toMatch(/^\s*\{\s*background:\s*var\(--bg-user-msg\);\s*$/);
  });

  it('base rules set border, border-radius, box-shadow (shared across themes)', () => {
    const baseCard = dashboardCss.split('.db-stat-card')[1]?.split('}')[0] || '';
    expect(baseCard).toContain('border:');
    expect(baseCard).toContain('border-radius:');
    expect(baseCard).toContain('box-shadow:');
  });
});

// =====================================================================
// 11. CSS brace count and balance
// =====================================================================
describe('CSS structural integrity', () => {
  it('dashboard.css braces are balanced', () => {
    const opens = (dashboardCss.match(/\{/g) || []).length;
    const closes = (dashboardCss.match(/\}/g) || []).length;
    expect(opens).toBe(closes);
  });

  it('dashboard.css has 46 brace pairs (43 original + 3 new rules)', () => {
    // Original: 43 rules
    // Added: [data-theme="dark"] .db-stat-card, [data-theme="dark"] .db-section, .db-section padding mobile
    const opens = (dashboardCss.match(/\{/g) || []).length;
    expect(opens).toBe(46);
  });
});
