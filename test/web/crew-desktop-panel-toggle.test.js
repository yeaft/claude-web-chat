import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { loadAllCss } from '../helpers/loadCss.js';

/**
 * Tests for task-40: Desktop Crew panel toggle via header nav buttons.
 *
 * Verifies:
 * 1) Store: crewPanelVisible state and toggleCrewPanel action
 * 2) ChatHeader: onCrewPanelToggle dispatches based on viewport width
 * 3) ChatHeader: isCrewPanelActive reads correct state per viewport
 * 4) CrewChatView: crew-workspace binds hide-roles / hide-features classes
 * 5) CSS: .hide-roles .crew-panel-left width → 0 with transition
 * 6) CSS: .hide-features .crew-panel-right width → 0 with transition
 * 7) CSS: mobile (<768px) overrides — hide-* classes do NOT collapse drawers
 * 8) CSS: header nav visible on all viewports (display: flex in base rule)
 */

let headerSource;
let viewSource;
let storeSource;
let cssSource;

beforeAll(() => {
  const base = resolve(__dirname, '../../web');
  headerSource = readFileSync(resolve(base, 'components/ChatHeader.js'), 'utf-8');
  viewSource = readFileSync(resolve(base, 'components/CrewChatView.js'), 'utf-8');
  storeSource = readFileSync(resolve(base, 'stores/chat.js'), 'utf-8');
  cssSource = loadAllCss();
});

// =====================================================================
// 1. Store — crewPanelVisible state
// =====================================================================
describe('store — crewPanelVisible state', () => {
  it('has crewPanelVisible with roles: true default', () => {
    expect(storeSource).toContain('crewPanelVisible');
    expect(storeSource).toMatch(/crewPanelVisible:\s*\{[^}]*roles:\s*true/);
  });

  it('has crewPanelVisible with features: true default', () => {
    expect(storeSource).toMatch(/crewPanelVisible:\s*\{[^}]*features:\s*true/);
  });

  it('has toggleCrewPanel action', () => {
    expect(storeSource).toContain('toggleCrewPanel(panel)');
  });

  it('toggleCrewPanel toggles crewPanelVisible[panel]', () => {
    const methodSection = storeSource.split('toggleCrewPanel(panel)')[1]?.split('}')[0] || '';
    expect(methodSection).toContain('crewPanelVisible[panel]');
    expect(methodSection).toContain('!this.crewPanelVisible[panel]');
  });
});

// =====================================================================
// 2. ChatHeader — onCrewPanelToggle function
// =====================================================================
describe('ChatHeader — onCrewPanelToggle', () => {
  it('defines onCrewPanelToggle function', () => {
    expect(headerSource).toContain('onCrewPanelToggle');
  });

  it('checks window.innerWidth < 768 for viewport detection', () => {
    expect(headerSource).toContain('window.innerWidth < 768');
  });

  it('calls toggleCrewMobilePanel for mobile (<768)', () => {
    // Find the function definition in setup(), not in template
    const setupSection = headerSource.split('setup()')[1] || '';
    const fnSection = setupSection.split('onCrewPanelToggle')[1]?.split('};')[0] || '';
    expect(fnSection).toContain('toggleCrewMobilePanel(panel)');
  });

  it('calls toggleCrewPanel for desktop (>=768)', () => {
    const setupSection = headerSource.split('setup()')[1] || '';
    const fnSection = setupSection.split('onCrewPanelToggle')[1]?.split('};')[0] || '';
    expect(fnSection).toContain('toggleCrewPanel(panel)');
  });

  it('roles button uses onCrewPanelToggle', () => {
    expect(headerSource).toContain("onCrewPanelToggle('roles')");
  });

  it('features button uses onCrewPanelToggle', () => {
    expect(headerSource).toContain("onCrewPanelToggle('features')");
  });
});

// =====================================================================
// 3. ChatHeader — isCrewPanelActive function
// =====================================================================
describe('ChatHeader — isCrewPanelActive', () => {
  it('defines isCrewPanelActive function', () => {
    expect(headerSource).toContain('isCrewPanelActive');
  });

  it('returns crewMobilePanel match for mobile', () => {
    const setupSection = headerSource.split('setup()')[1] || '';
    const fnSection = setupSection.split('isCrewPanelActive')[1]?.split('};')[0] || '';
    expect(fnSection).toContain('crewMobilePanel === panel');
  });

  it('returns crewPanelVisible[panel] for desktop', () => {
    const setupSection = headerSource.split('setup()')[1] || '';
    const fnSection = setupSection.split('isCrewPanelActive')[1]?.split('};')[0] || '';
    expect(fnSection).toContain('crewPanelVisible[panel]');
  });

  it('roles button uses isCrewPanelActive for active class', () => {
    expect(headerSource).toContain("isCrewPanelActive('roles')");
  });

  it('features button uses isCrewPanelActive for active class', () => {
    expect(headerSource).toContain("isCrewPanelActive('features')");
  });
});

// =====================================================================
// 4. CrewChatView — hide-roles / hide-features class bindings
// =====================================================================
describe('CrewChatView — hide class bindings', () => {
  it('crew-workspace binds hide-roles class', () => {
    expect(viewSource).toContain("'hide-roles': !store.crewPanelVisible.roles");
  });

  it('crew-workspace binds hide-features class', () => {
    expect(viewSource).toContain("'hide-features': !store.crewPanelVisible.features");
  });

  it('still binds mobile-panel-roles class', () => {
    expect(viewSource).toContain("'mobile-panel-roles': store.crewMobilePanel === 'roles'");
  });

  it('still binds mobile-panel-features class', () => {
    expect(viewSource).toContain("'mobile-panel-features': store.crewMobilePanel === 'features'");
  });
});

// =====================================================================
// 5. CSS — desktop panel width transition
// =====================================================================
describe('CSS — desktop panel width transition', () => {
  it('crew-panel-left and crew-panel-right have transition on width', () => {
    // Combined transition rule for both panels
    const panelTransition = cssSource.indexOf('.crew-panel-left,');
    expect(panelTransition).toBeGreaterThan(-1);
    const section = cssSource.substring(panelTransition, panelTransition + 200);
    expect(section).toContain('transition: width');
    expect(section).toContain('cubic-bezier');
  });

  it('transition duration is 0.25s', () => {
    const panelTransition = cssSource.indexOf('.crew-panel-left,');
    const section = cssSource.substring(panelTransition, panelTransition + 200);
    expect(section).toContain('0.25s');
  });
});

// =====================================================================
// 6. CSS — hide-roles collapses left panel
// =====================================================================
describe('CSS — hide-roles collapses left panel', () => {
  it('hide-roles .crew-panel-left has width: 0 !important', () => {
    expect(cssSource).toContain('.crew-workspace.hide-roles .crew-panel-left');
    const idx = cssSource.indexOf('.crew-workspace.hide-roles .crew-panel-left');
    const block = cssSource.substring(idx, cssSource.indexOf('}', idx) + 1);
    expect(block).toContain('width: 0 !important');
  });

  it('hide-roles .crew-panel-left has min-width: 0', () => {
    const idx = cssSource.indexOf('.crew-workspace.hide-roles .crew-panel-left');
    const block = cssSource.substring(idx, cssSource.indexOf('}', idx) + 1);
    expect(block).toContain('min-width: 0');
  });

  it('hide-roles .crew-panel-left has padding: 0', () => {
    const idx = cssSource.indexOf('.crew-workspace.hide-roles .crew-panel-left');
    const block = cssSource.substring(idx, cssSource.indexOf('}', idx) + 1);
    expect(block).toContain('padding: 0');
  });

  it('hide-roles .crew-panel-left has border: none', () => {
    const idx = cssSource.indexOf('.crew-workspace.hide-roles .crew-panel-left');
    const block = cssSource.substring(idx, cssSource.indexOf('}', idx) + 1);
    expect(block).toContain('border: none');
  });
});

// =====================================================================
// 7. CSS — hide-features collapses right panel
// =====================================================================
describe('CSS — hide-features collapses right panel', () => {
  it('hide-features .crew-panel-right has width: 0 !important', () => {
    expect(cssSource).toContain('.crew-workspace.hide-features .crew-panel-right');
    const idx = cssSource.indexOf('.crew-workspace.hide-features .crew-panel-right');
    const block = cssSource.substring(idx, cssSource.indexOf('}', idx) + 1);
    expect(block).toContain('width: 0 !important');
  });

  it('hide-features .crew-panel-right has min-width: 0', () => {
    const idx = cssSource.indexOf('.crew-workspace.hide-features .crew-panel-right');
    const block = cssSource.substring(idx, cssSource.indexOf('}', idx) + 1);
    expect(block).toContain('min-width: 0');
  });

  it('hide-features .crew-panel-right has padding: 0', () => {
    const idx = cssSource.indexOf('.crew-workspace.hide-features .crew-panel-right');
    const block = cssSource.substring(idx, cssSource.indexOf('}', idx) + 1);
    expect(block).toContain('padding: 0');
  });

  it('hide-features .crew-panel-right has border: none', () => {
    const idx = cssSource.indexOf('.crew-workspace.hide-features .crew-panel-right');
    const block = cssSource.substring(idx, cssSource.indexOf('}', idx) + 1);
    expect(block).toContain('border: none');
  });
});

// =====================================================================
// 8. CSS — mobile override: hide-* classes do NOT collapse drawers
// =====================================================================
describe('CSS — mobile override for hide-* classes', () => {
  let mobileBlock;

  beforeAll(() => {
    // Find the 767px media block
    const marker = '@media (max-width: 767px)';
    const idx = cssSource.indexOf(marker);
    if (idx === -1) { mobileBlock = null; return; }
    const openBrace = cssSource.indexOf('{', idx);
    let depth = 0;
    let end = openBrace;
    for (let i = openBrace; i < cssSource.length; i++) {
      if (cssSource[i] === '{') depth++;
      if (cssSource[i] === '}') depth--;
      if (depth === 0) { end = i; break; }
    }
    mobileBlock = cssSource.substring(openBrace + 1, end);
  });

  it('767px media block exists', () => {
    expect(mobileBlock).not.toBeNull();
  });

  it('mobile hide-roles .crew-panel-left restores width', () => {
    expect(mobileBlock).toContain('.crew-workspace.hide-roles .crew-panel-left');
    const idx = mobileBlock.indexOf('.crew-workspace.hide-roles .crew-panel-left');
    const block = mobileBlock.substring(idx, mobileBlock.indexOf('}', idx) + 1);
    expect(block).toContain('width: min(320px, 85vw) !important');
  });

  it('mobile hide-roles .crew-panel-left has min-width: auto', () => {
    const idx = mobileBlock.indexOf('.crew-workspace.hide-roles .crew-panel-left');
    const block = mobileBlock.substring(idx, mobileBlock.indexOf('}', idx) + 1);
    expect(block).toContain('min-width: auto');
  });

  it('mobile hide-features .crew-panel-right restores width', () => {
    expect(mobileBlock).toContain('.crew-workspace.hide-features .crew-panel-right');
    const idx = mobileBlock.indexOf('.crew-workspace.hide-features .crew-panel-right');
    const block = mobileBlock.substring(idx, mobileBlock.indexOf('}', idx) + 1);
    expect(block).toContain('width: min(320px, 85vw) !important');
  });

  it('mobile hide-features .crew-panel-right has min-width: auto', () => {
    const idx = mobileBlock.indexOf('.crew-workspace.hide-features .crew-panel-right');
    const block = mobileBlock.substring(idx, mobileBlock.indexOf('}', idx) + 1);
    expect(block).toContain('min-width: auto');
  });
});

// =====================================================================
// 9. CSS — header nav visible on all viewports
// =====================================================================
describe('CSS — header nav visible on all viewports', () => {
  it('crew-header-left has display: flex in base rule', () => {
    expect(cssSource).toMatch(/\.crew-header-left[\s,][^}]*display:\s*flex/);
  });

  it('crew-header-left has position: absolute in base rule', () => {
    // position: absolute is in the shared rule: .crew-header-left, .crew-header-right { ... }
    const sharedStart = cssSource.indexOf('.crew-header-left,');
    const sharedSection = cssSource.substring(sharedStart, sharedStart + 300);
    expect(sharedSection).toContain('position: absolute');
  });

  it('crew-header-left has right: 12px in base rule', () => {
    const navStart = cssSource.indexOf('.crew-header-left {');
    const navSection = cssSource.substring(navStart, navStart + 300);
    expect(navSection).toContain('right: 12px');
  });

  it('no duplicate crew-header-left display:flex in 767px media query', () => {
    // The base rule already has display: flex, so it should NOT be repeated in mobile
    const marker = '@media (max-width: 767px)';
    const idx = cssSource.indexOf(marker);
    const openBrace = cssSource.indexOf('{', idx);
    let depth = 0;
    let end = openBrace;
    for (let i = openBrace; i < cssSource.length; i++) {
      if (cssSource[i] === '{') depth++;
      if (cssSource[i] === '}') depth--;
      if (depth === 0) { end = i; break; }
    }
    const mobileBlock = cssSource.substring(openBrace + 1, end);
    // The mobile block should NOT have a separate crew-header-left base rule
    // since the shared rule is in base styles
    expect(mobileBlock).not.toMatch(/\.crew-header-left,\s*\n\s*\.crew-header-right\s*\{/);
  });
});

// =====================================================================
// 10. Structural integrity
// =====================================================================
describe('structural integrity', () => {
  it('CSS has balanced braces (2092/2092)', () => {
    const opens = (cssSource.match(/\{/g) || []).length;
    const closes = (cssSource.match(/\}/g) || []).length;
    expect(opens).toBe(closes);
    expect(opens).toBe(2097);
  });
});
