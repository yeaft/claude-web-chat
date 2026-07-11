import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { collapseSidebar } from '../../web/utils/sidebar-collapse.js';

const readComponent = (name) => readFileSync(new URL(`../../web/components/${name}`, import.meta.url), 'utf8');
const readStyle = (name) => readFileSync(new URL(`../../web/styles/${name}`, import.meta.url), 'utf8');

describe('mobile sidebar header parity', () => {
  const chatPage = readComponent('ChatPage.js');
  const yeaftSidebar = readComponent('YeaftSidebar.js');
  const chatModalCss = readStyle('chat-modals.css');

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

  it('removes the obsolete mobile-only title and close button styles', () => {
    expect(chatModalCss).not.toContain('.sidebar-header-mobile');
    expect(chatModalCss).not.toContain('.sidebar-close-btn');
  });
});
