import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

/**
 * Tests for task-40: Desktop Crew panel toggle via header nav buttons.
 *
 * Verifies:
 * 1) Store: crewPanelVisible state and toggleCrewPanel action
 * 2) ChatHeader: onCrewPanelToggle dispatches based on viewport width
 * 3) ChatHeader: isCrewPanelActive reads correct state per viewport
 * 4) CrewChatView: crew-workspace binds hide-roles / hide-features classes
 */

let headerSource;
let viewSource;
let storeSource;

beforeAll(() => {
  const base = resolve(__dirname, '../../web');
  headerSource = readFileSync(resolve(base, 'components/ChatHeader.js'), 'utf-8');
  viewSource = readFileSync(resolve(base, 'components/CrewChatView.js'), 'utf-8');
  storeSource = readFileSync(resolve(base, 'stores/chat.js'), 'utf-8');
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
