import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { collapseSidebar } from '../../web/utils/sidebar-collapse.js';

const readComponent = (name) => readFileSync(new URL(`../../web/components/${name}`, import.meta.url), 'utf8');
const readStyle = (name) => readFileSync(new URL(`../../web/styles/${name}`, import.meta.url), 'utf8');

describe('mobile sidebar header parity', () => {
  const chatPage = readComponent('ChatPage.js');
  const yeaftPage = readComponent('YeaftPage.js');
  const yeaftSidebar = readComponent('YeaftSidebar.js');
  const sidebarShell = readComponent('SessionSidebarShell.js');
  const chatModalCss = readStyle('chat-modals.css');
  const sidebarCss = readStyle('sidebar.css');
  const variablesCss = readStyle('variables.css');

  it('starts both expanded sidebars with the shared agent header', () => {
    expect(chatPage).not.toContain('sidebar-header-mobile');
    expect(chatPage).not.toContain('sidebar-close-btn');
    expect(chatPage).not.toContain('<span class="sidebar-title">Yeaft</span>');
    expect(chatPage).toContain('<div class="sidebar-top">');
    expect(yeaftSidebar).toContain('<div class="sidebar-top">');
  });

  it('closes the mobile drawer without swallowing the first desktop collapse after resize', () => {
    expect(chatPage).toContain('@click="onSidebarCollapse"');
    expect(chatPage).toContain('return this.windowWidth <= 768;');

    const closeMobileSidebar = vi.fn();
    const mobileToggle = vi.fn();
    collapseSidebar({ isMobileView: true, showMobileSidebar: true, closeMobileSidebar, toggleSidebar: mobileToggle });
    expect(closeMobileSidebar).toHaveBeenCalledOnce();
    expect(mobileToggle).not.toHaveBeenCalled();

    const desktopClose = vi.fn();
    const desktopToggle = vi.fn();
    collapseSidebar({ isMobileView: false, showMobileSidebar: true, closeMobileSidebar: desktopClose, toggleSidebar: desktopToggle });
    expect(desktopClose).not.toHaveBeenCalled();
    expect(desktopToggle).toHaveBeenCalledOnce();
  });

  it('uses one sidebar shell and width token for Chat and Yeaft Session', () => {
    expect(sidebarShell).toContain('class="session-sidebar-shell"');
    expect(chatPage).toContain('<SessionSidebarShell class="sidebar"');
    expect(yeaftSidebar).toContain('<SessionSidebarShell class="yeaft-sidebar"');
    expect(variablesCss).toContain('--session-sidebar-width: 260px;');
    expect(sidebarCss).toContain('width: var(--session-sidebar-width);');
    expect(chatModalCss).toContain('width: var(--session-sidebar-width);');
    expect(chatModalCss).not.toContain('width: 300px;');
  });

  it('keeps the mobile sidebar open while switching between conversation views', () => {
    expect(chatPage).toContain("'show-sidebar': store.sessionSidebarOpen");
    expect(chatPage).toContain('@toggle-sidebar="store.toggleSessionSidebar()"');
    expect(yeaftPage).toContain('store.sessionSidebarOpen && isMobile');
    expect(yeaftPage).toContain('isMobile.value ? !store.sessionSidebarOpen : store.sidebarCollapsed');
  });

  it('removes the obsolete mobile-only title and close button styles', () => {
    expect(chatModalCss).not.toContain('.sidebar-header-mobile');
    expect(chatModalCss).not.toContain('.sidebar-close-btn');
  });
});
