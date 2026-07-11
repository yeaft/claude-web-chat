import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

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

  it('uses the shared collapse action to close the mobile Chat drawer', () => {
    expect(chatPage).toContain('@click="onSidebarCollapse"');
    expect(chatPage).toMatch(/onSidebarCollapse\(\)\s*\{[\s\S]*?if \(this\.showMobileSidebar\) \{[\s\S]*?this\.showMobileSidebar = false;[\s\S]*?return;[\s\S]*?\}[\s\S]*?this\.store\.toggleSidebar\(\);/);
  });

  it('removes the obsolete mobile-only title and close button styles', () => {
    expect(chatModalCss).not.toContain('.sidebar-header-mobile');
    expect(chatModalCss).not.toContain('.sidebar-close-btn');
  });
});
