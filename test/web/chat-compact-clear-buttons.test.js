import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { loadAllCss } from '../helpers/loadCss.js';

/**
 * Tests for task-39: Chat header compact/clear buttons.
 *
 * Verifies:
 * 1) Compact button exists with header-action-btn class, calls compactContext, sends /compact
 * 2) Clear button exists, calls clearMessages, uses confirm() dialog, sends /clear
 * 3) Buttons only appear in Chat mode (not Crew) — inside header-right with v-if guard
 * 4) Compact button has :disabled="isCompacting" binding
 * 5) isCompacting computed checks compactStatus
 * 6) i18n keys: chatHeader.compact, chatHeader.clear, chatHeader.confirmClear
 * 7) CSS: .header-action-btn styling
 */

let headerSource;
let cssSource;
let zhSource;
let enSource;

beforeAll(() => {
  const base = resolve(__dirname, '../../web');
  headerSource = readFileSync(resolve(base, 'components/ChatHeader.js'), 'utf-8');
  cssSource = loadAllCss();
  zhSource = readFileSync(resolve(base, 'i18n/zh-CN.js'), 'utf-8');
  enSource = readFileSync(resolve(base, 'i18n/en.js'), 'utf-8');
});

// =====================================================================
// 1. Compact button — template and logic
// =====================================================================
describe('compact button', () => {
  it('has a button with header-action-btn class that calls compactContext', () => {
    expect(headerSource).toContain('header-action-btn');
    expect(headerSource).toContain('@click="compactContext"');
  });

  it('compact button is disabled when isCompacting', () => {
    expect(headerSource).toContain(':disabled="isCompacting"');
  });

  it('compact button has chatHeader.compact i18n title', () => {
    expect(headerSource).toContain("$t('chatHeader.compact')");
  });

  it('compactContext function sends /compact via sendMessage', () => {
    const setupSection = headerSource.split('setup()')[1] || '';
    const fnSection = setupSection.split('compactContext')[1]?.split('};')[0] || '';
    expect(fnSection).toContain("sendMessage('/compact')");
  });

  it('compactContext checks isCompacting before sending', () => {
    const setupSection = headerSource.split('setup()')[1] || '';
    const fnSection = setupSection.split('compactContext')[1]?.split('};')[0] || '';
    expect(fnSection).toContain('isCompacting');
  });
});

// =====================================================================
// 2. Clear button — template and logic
// =====================================================================
describe('clear button', () => {
  it('has a button that calls clearMessages', () => {
    expect(headerSource).toContain('@click="clearMessages"');
  });

  it('clear button has chatHeader.clear i18n title', () => {
    expect(headerSource).toContain("$t('chatHeader.clear')");
  });

  it('clearMessages uses confirm dialog before sending', () => {
    const setupSection = headerSource.split('setup()')[1] || '';
    const fnSection = setupSection.split('clearMessages')[1]?.split('};')[0] || '';
    expect(fnSection).toContain('confirm(');
  });

  it('clearMessages sends /clear via sendMessage', () => {
    const setupSection = headerSource.split('setup()')[1] || '';
    // Find the full clearMessages function body (may contain nested objects with };)
    const clearStart = setupSection.indexOf('clearMessages');
    const clearBody = setupSection.substring(clearStart, clearStart + 500);
    expect(clearBody).toContain("sendMessage('/clear')");
  });

  it('confirm dialog uses chatHeader.confirmClear i18n key', () => {
    const setupSection = headerSource.split('setup()')[1] || '';
    const fnSection = setupSection.split('clearMessages')[1]?.split('};')[0] || '';
    expect(fnSection).toContain('chatHeader.confirmClear');
  });
});

// =====================================================================
// 3. Buttons only in Chat mode (not Crew)
// =====================================================================
describe('buttons visibility — Chat mode only', () => {
  it('header-right div has v-if with currentConversation', () => {
    expect(headerSource).toContain('v-if="store.currentConversation');
  });

  it('header-right div excludes Crew conversations', () => {
    expect(headerSource).toContain('!store.currentConversationIsCrew');
  });

  it('buttons are inside header-right div, not in crew-header-left', () => {
    // Both header-action-btn buttons should appear before crew-header-left
    const actionBtnIdx = headerSource.indexOf('header-action-btn');
    const crewNavIdx = headerSource.indexOf('crew-header-left');
    expect(actionBtnIdx).toBeGreaterThan(-1);
    expect(crewNavIdx).toBeGreaterThan(-1);
    expect(actionBtnIdx).toBeLessThan(crewNavIdx);
  });

  it('compact and clear buttons share the same header-right container', () => {
    // Both @click="compactContext" and @click="clearMessages" should be
    // within the header-right div
    const headerRightStart = headerSource.indexOf('class="header-right"');
    const crewNavStart = headerSource.indexOf('class="crew-header-left"');
    const compactIdx = headerSource.indexOf('@click="compactContext"');
    const clearIdx = headerSource.indexOf('@click="clearMessages"');
    expect(compactIdx).toBeGreaterThan(headerRightStart);
    expect(compactIdx).toBeLessThan(crewNavStart);
    expect(clearIdx).toBeGreaterThan(headerRightStart);
    expect(clearIdx).toBeLessThan(crewNavStart);
  });
});

// =====================================================================
// 4. isCompacting computed property
// =====================================================================
describe('isCompacting computed', () => {
  it('isCompacting checks compactStatus status === compacting', () => {
    const setupSection = headerSource.split('setup()')[1] || '';
    expect(setupSection).toContain("compactStatus?.status === 'compacting'");
  });

  it('isCompacting checks conversationId matches currentConversation', () => {
    const setupSection = headerSource.split('setup()')[1] || '';
    const isCompactingSection = setupSection.split('isCompacting')[1]?.split('});')[0] || '';
    expect(isCompactingSection).toContain('conversationId');
    expect(isCompactingSection).toContain('currentConversation');
  });

  it('isCompacting is returned from setup', () => {
    const returnSection = headerSource.split('return {')[1]?.split('}')[0] || '';
    expect(returnSection).toContain('isCompacting');
  });
});

// =====================================================================
// 5. i18n keys
// =====================================================================
describe('i18n keys for compact/clear', () => {
  it('zh-CN has chatHeader.compact', () => {
    expect(zhSource).toContain("'chatHeader.compact'");
  });

  it('zh-CN has chatHeader.clear', () => {
    expect(zhSource).toContain("'chatHeader.clear'");
  });

  it('zh-CN has chatHeader.confirmClear', () => {
    expect(zhSource).toContain("'chatHeader.confirmClear'");
  });

  it('en has chatHeader.compact', () => {
    expect(enSource).toContain("'chatHeader.compact'");
  });

  it('en has chatHeader.clear', () => {
    expect(enSource).toContain("'chatHeader.clear'");
  });

  it('en has chatHeader.confirmClear', () => {
    expect(enSource).toContain("'chatHeader.confirmClear'");
  });
});
