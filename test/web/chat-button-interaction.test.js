import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { loadAllCss } from '../helpers/loadCss.js';

/**
 * Tests for PR #85: Chat mode button interaction improvements.
 *
 * Verifies:
 * 1) Refresh button replaces Resume — clears messages, sends sync_messages with turns:5
 * 2) Compact button loading state — btn-loading class, spinner replaces icon
 * 3) Clear button loading state — btn-loading class, spinner, clearStatus state management
 * 4) Unified status banner — supports both compact and clear status display
 * 5) New compact icon — converging arrows (polyline 8 4 12 8 16 4)
 * 6) Store additions — clearStatus, refreshingSession state fields
 * 7) conversationHandler — turn_completed detects /clear completion, 3s auto-dismiss
 * 8) i18n — new keys: chatHeader.refresh, chatHeader.clearing, chatHeader.clearDone
 * 9) CSS — .btn-loading rules: pointer-events:none, svg hidden, spinner ::after
 */

let headerSource;
let cssSource;
let storeSource;
let handlerSource;
let zhSource;
let enSource;

beforeAll(() => {
  const base = resolve(__dirname, '../../web');
  headerSource = readFileSync(resolve(base, 'components/ChatHeader.js'), 'utf-8');
  cssSource = loadAllCss();
  storeSource = readFileSync(resolve(base, 'stores/chat.js'), 'utf-8');
  handlerSource = readFileSync(resolve(base, 'stores/helpers/handlers/conversationHandler.js'), 'utf-8');
  zhSource = readFileSync(resolve(base, 'i18n/zh-CN.js'), 'utf-8');
  enSource = readFileSync(resolve(base, 'i18n/en.js'), 'utf-8');
});

// =====================================================================
// 1. Refresh button — replaces Resume
// =====================================================================
describe('refresh button — replaces resume', () => {
  it('template has refreshSession click handler', () => {
    expect(headerSource).toContain('@click="refreshSession"');
  });

  it('template does NOT have old resumeSession handler', () => {
    expect(headerSource).not.toContain('@click="resumeSession"');
  });

  it('template uses chatHeader.refresh i18n title', () => {
    expect(headerSource).toContain("$t('chatHeader.refresh')");
  });

  it('template does NOT use chatHeader.resume i18n title', () => {
    expect(headerSource).not.toContain("$t('chatHeader.resume')");
  });

  it('refresh button has btn-loading class binding for refreshingSession', () => {
    expect(headerSource).toContain("'btn-loading': store.refreshingSession");
  });

  it('refresh button is disabled when refreshingSession', () => {
    // The template has :disabled="!canRefresh || store.refreshingSession"
    expect(headerSource).toContain('store.refreshingSession');
    expect(headerSource).toContain(':disabled="!canRefresh');
  });

  it('refresh button uses v-if="canRefresh" for visibility', () => {
    expect(headerSource).toContain('v-if="canRefresh"');
  });

  it('refresh button does NOT use v-if="canResume"', () => {
    expect(headerSource).not.toContain('v-if="canResume"');
  });

  it('refreshSession clears messages before sending', () => {
    const setupSection = headerSource.split('setup()')[1] || '';
    const fnStart = setupSection.indexOf('refreshSession');
    const fnBody = setupSection.substring(fnStart, fnStart + 300);
    expect(fnBody).toContain('store.messages = []');
  });

  it('refreshSession sets refreshingSession to true', () => {
    const setupSection = headerSource.split('setup()')[1] || '';
    const fnStart = setupSection.indexOf('refreshSession');
    const fnBody = setupSection.substring(fnStart, fnStart + 300);
    expect(fnBody).toContain('store.refreshingSession = true');
  });

  it('refreshSession sends sync_messages with turns: 5', () => {
    const setupSection = headerSource.split('setup()')[1] || '';
    const fnStart = setupSection.indexOf('refreshSession');
    const fnBody = setupSection.substring(fnStart, fnStart + 400);
    expect(fnBody).toContain("type: 'sync_messages'");
    expect(fnBody).toContain('turns: 5');
  });

  it('refreshSession sends conversationId in sync_messages', () => {
    const setupSection = headerSource.split('setup()')[1] || '';
    const fnStart = setupSection.indexOf('refreshSession');
    const fnBody = setupSection.substring(fnStart, fnStart + 400);
    expect(fnBody).toContain('conversationId: store.currentConversation');
  });

  it('refreshSession guards against double-refresh and missing conversation', () => {
    const setupSection = headerSource.split('setup()')[1] || '';
    const fnStart = setupSection.indexOf('refreshSession');
    const fnBody = setupSection.substring(fnStart, fnStart + 300);
    expect(fnBody).toContain('refreshingSession');
    expect(fnBody).toContain('currentConversation');
  });
});

// =====================================================================
// 2. canRefresh computed — replaces canResume
// =====================================================================
describe('canRefresh computed — replaces canResume', () => {
  it('canRefresh is defined in setup', () => {
    const setupSection = headerSource.split('setup()')[1] || '';
    expect(setupSection).toContain('canRefresh');
  });

  it('canResume is NOT defined', () => {
    const setupSection = headerSource.split('setup()')[1] || '';
    expect(setupSection).not.toContain('canResume');
  });

  it('canRefresh checks currentConversation', () => {
    const setupSection = headerSource.split('setup()')[1] || '';
    const fnStart = setupSection.indexOf('canRefresh');
    const fnBody = setupSection.substring(fnStart, fnStart + 300);
    expect(fnBody).toContain('currentConversation');
  });

  it('canRefresh checks processingConversations', () => {
    const setupSection = headerSource.split('setup()')[1] || '';
    const fnStart = setupSection.indexOf('canRefresh');
    const fnBody = setupSection.substring(fnStart, fnStart + 300);
    expect(fnBody).toContain('processingConversations');
  });

  it('canRefresh checks refreshingSession', () => {
    const setupSection = headerSource.split('setup()')[1] || '';
    const fnStart = setupSection.indexOf('canRefresh');
    const fnBody = setupSection.substring(fnStart, fnStart + 300);
    expect(fnBody).toContain('refreshingSession');
  });

  it('canRefresh does NOT require claudeSessionId (unlike canResume)', () => {
    const setupSection = headerSource.split('setup()')[1] || '';
    const fnStart = setupSection.indexOf('canRefresh');
    const fnBody = setupSection.substring(fnStart, fnStart + 300);
    expect(fnBody).not.toContain('claudeSessionId');
  });

  it('canRefresh is returned from setup', () => {
    const returnSection = headerSource.split('return {')[1]?.split('}')[0] || '';
    expect(returnSection).toContain('canRefresh');
  });
});

// =====================================================================
// 3. Compact button — loading state (btn-loading)
// =====================================================================
describe('compact button — loading state', () => {
  it('compact button has btn-loading class binding for isCompacting', () => {
    // Find the compact button line
    expect(headerSource).toContain("'btn-loading': isCompacting");
  });

  it('compact button disabled binding uses isCompacting', () => {
    expect(headerSource).toContain(':disabled="isCompacting"');
  });
});

// =====================================================================
// 4. Clear button — loading state and clearStatus
// =====================================================================
describe('clear button — loading state and clearStatus', () => {
  it('clear button has btn-loading class binding for isClearing', () => {
    expect(headerSource).toContain("'btn-loading': isClearing");
  });

  it('clear button has disabled binding for isClearing', () => {
    expect(headerSource).toContain(':disabled="isClearing"');
  });

  it('isClearing computed checks clearStatus.status === clearing', () => {
    const setupSection = headerSource.split('setup()')[1] || '';
    expect(setupSection).toContain("clearStatus?.status === 'clearing'");
  });

  it('isClearing checks conversationId matches currentConversation', () => {
    const setupSection = headerSource.split('setup()')[1] || '';
    const fnStart = setupSection.indexOf('isClearing');
    const fnBody = setupSection.substring(fnStart, fnStart + 200);
    expect(fnBody).toContain('clearStatus?.conversationId');
    expect(fnBody).toContain('currentConversation');
  });

  it('isClearing is returned from setup', () => {
    const returnSection = headerSource.split('return {')[1]?.split('}')[0] || '';
    expect(returnSection).toContain('isClearing');
  });

  it('clearMessages sets clearStatus before sending /clear', () => {
    const setupSection = headerSource.split('setup()')[1] || '';
    const clearStart = setupSection.indexOf('clearMessages');
    const clearBody = setupSection.substring(clearStart, clearStart + 500);
    expect(clearBody).toContain('store.clearStatus');
    expect(clearBody).toContain("status: 'clearing'");
  });

  it('clearMessages checks isClearing before proceeding', () => {
    const setupSection = headerSource.split('setup()')[1] || '';
    const clearStart = setupSection.indexOf('clearMessages');
    const clearBody = setupSection.substring(clearStart, clearStart + 300);
    expect(clearBody).toContain('isClearing');
  });
});

// =====================================================================
// 5. Unified status banner — compact + clear
// =====================================================================
describe('unified status banner', () => {
  it('template uses showStatusBanner (not showCompactStatus)', () => {
    expect(headerSource).toContain('showStatusBanner');
    expect(headerSource).not.toContain('showCompactStatus');
  });

  it('template uses statusBannerClass (not compactStatusClass)', () => {
    expect(headerSource).toContain('statusBannerClass');
    expect(headerSource).not.toContain('compactStatusClass');
  });

  it('template uses statusBannerMessage (not compactMessage)', () => {
    expect(headerSource).toContain('statusBannerMessage');
    expect(headerSource).not.toContain('compactMessage');
  });

  it('template uses statusBannerSpinner computed', () => {
    expect(headerSource).toContain('statusBannerSpinner');
  });

  it('showStatusBanner checks clearStatus first', () => {
    const setupSection = headerSource.split('setup()')[1] || '';
    const fnStart = setupSection.indexOf('showStatusBanner');
    const fnBody = setupSection.substring(fnStart, fnStart + 300);
    expect(fnBody).toContain('clearStatus');
  });

  it('showStatusBanner also checks compactStatus', () => {
    const setupSection = headerSource.split('setup()')[1] || '';
    const fnStart = setupSection.indexOf('showStatusBanner');
    const fnBody = setupSection.substring(fnStart, fnStart + 300);
    expect(fnBody).toContain('compactStatus');
  });

  it('statusBannerClass returns compacting for clearing status', () => {
    const setupSection = headerSource.split('setup()')[1] || '';
    const fnStart = setupSection.indexOf('statusBannerClass');
    const fnBody = setupSection.substring(fnStart, fnStart + 400);
    expect(fnBody).toContain("'clearing'");
    expect(fnBody).toContain("'compacting'");
  });

  it('statusBannerMessage uses chatHeader.clearing for clearing state', () => {
    const setupSection = headerSource.split('setup()')[1] || '';
    const fnStart = setupSection.indexOf('statusBannerMessage');
    const fnBody = setupSection.substring(fnStart, fnStart + 500);
    expect(fnBody).toContain("'chatHeader.clearing'");
  });

  it('statusBannerMessage uses chatHeader.clearDone for completed state', () => {
    const setupSection = headerSource.split('setup()')[1] || '';
    const fnStart = setupSection.indexOf('statusBannerMessage');
    const fnBody = setupSection.substring(fnStart, fnStart + 500);
    expect(fnBody).toContain("'chatHeader.clearDone'");
  });

  it('all new banner computeds are returned from setup', () => {
    const returnSection = headerSource.split('return {')[1]?.split('}')[0] || '';
    expect(returnSection).toContain('showStatusBanner');
    expect(returnSection).toContain('statusBannerClass');
    expect(returnSection).toContain('statusBannerSpinner');
    expect(returnSection).toContain('statusBannerMessage');
  });
});

// =====================================================================
// 6. New compact icon — converging arrows
// =====================================================================
describe('compact icon — converging arrows', () => {
  it('compact button uses new converging arrow polyline (top)', () => {
    // New icon: <polyline points="8 4 12 8 16 4"/>
    expect(headerSource).toContain('points="8 4 12 8 16 4"');
  });

  it('compact button uses new converging arrow polyline (bottom)', () => {
    // New icon: <polyline points="8 20 12 16 16 20"/>
    expect(headerSource).toContain('points="8 20 12 16 16 20"');
  });

  it('compact button has center line', () => {
    // New icon: <line x1="4" y1="12" x2="20" y2="12"/>
    expect(headerSource).toContain('x1="4" y1="12" x2="20" y2="12"');
  });

  it('old shrink/expand icon arrows are NOT present', () => {
    // Old icon used: <polyline points="4 14 10 14 10 20"/>
    expect(headerSource).not.toContain('points="4 14 10 14 10 20"');
    // Old icon used: <polyline points="20 10 14 10 14 4"/>
    expect(headerSource).not.toContain('points="20 10 14 10 14 4"');
  });
});

// =====================================================================
// 7. Store — clearStatus and refreshingSession fields
// =====================================================================
describe('store — new state fields', () => {
  it('store has clearStatus field', () => {
    expect(storeSource).toContain('clearStatus');
  });

  it('clearStatus initial value is null', () => {
    expect(storeSource).toContain('clearStatus: null');
  });

  it('store has refreshingSession field', () => {
    expect(storeSource).toContain('refreshingSession');
  });

  it('refreshingSession initial value is false', () => {
    expect(storeSource).toContain('refreshingSession: false');
  });

  it('clearStatus comment documents its shape', () => {
    expect(storeSource).toContain("{ conversationId, status: 'clearing'|'completed' }");
  });
});

// =====================================================================
// 8. conversationHandler — clear completion detection
// =====================================================================
describe('conversationHandler — clear completion detection', () => {
  it('handleTurnCompleted checks clearStatus for clearing state', () => {
    expect(handlerSource).toContain("clearStatus?.status === 'clearing'");
  });

  it('handleTurnCompleted sets clearStatus to completed', () => {
    expect(handlerSource).toContain("status: 'completed'");
  });

  it('handleTurnCompleted uses setTimeout for auto-dismiss', () => {
    // The 3-second timeout — need 1500 chars to cover full function body
    const fnStart = handlerSource.indexOf('handleTurnCompleted');
    const fnBody = handlerSource.substring(fnStart, fnStart + 1500);
    expect(fnBody).toContain('setTimeout');
    expect(fnBody).toContain('3000');
  });

  it('auto-dismiss sets clearStatus to null', () => {
    const fnStart = handlerSource.indexOf('handleTurnCompleted');
    const fnBody = handlerSource.substring(fnStart, fnStart + 1500);
    expect(fnBody).toContain('clearStatus = null');
  });

  it('auto-dismiss only clears if still completed for same conversation', () => {
    const fnStart = handlerSource.indexOf('handleTurnCompleted');
    const fnBody = handlerSource.substring(fnStart, fnStart + 1500);
    // Should check conversationId and status before clearing
    expect(fnBody).toContain("clearStatus?.conversationId === convId");
    expect(fnBody).toContain("status === 'completed'");
  });

  it('handleSyncMessagesResult resets refreshingSession', () => {
    expect(handlerSource).toContain('store.refreshingSession = false');
  });
});

// =====================================================================
// 9. i18n — new keys
// =====================================================================
describe('i18n — new keys for refresh and clear feedback', () => {
  it('en has chatHeader.refresh', () => {
    expect(enSource).toContain("'chatHeader.refresh'");
  });

  it('en has chatHeader.clearing', () => {
    expect(enSource).toContain("'chatHeader.clearing'");
  });

  it('en has chatHeader.clearDone', () => {
    expect(enSource).toContain("'chatHeader.clearDone'");
  });

  it('zh-CN has chatHeader.refresh', () => {
    expect(zhSource).toContain("'chatHeader.refresh'");
  });

  it('zh-CN has chatHeader.clearing', () => {
    expect(zhSource).toContain("'chatHeader.clearing'");
  });

  it('zh-CN has chatHeader.clearDone', () => {
    expect(zhSource).toContain("'chatHeader.clearDone'");
  });

  it('en chatHeader.refresh value is Refresh messages', () => {
    expect(enSource).toContain("'chatHeader.refresh': 'Refresh messages'");
  });

  it('zh-CN chatHeader.refresh value is correct', () => {
    expect(zhSource).toContain("'chatHeader.refresh':");
  });

  it('en chatHeader.clearing describes clearing in progress', () => {
    expect(enSource).toContain("'chatHeader.clearing': 'Clearing context...'");
  });

  it('en chatHeader.clearDone describes completion', () => {
    expect(enSource).toContain("'chatHeader.clearDone': 'Context cleared'");
  });
});

// =====================================================================
// 10. CSS — btn-loading rules
// =====================================================================
describe('CSS — btn-loading spinner styling', () => {
  it('has .header-action-btn.btn-loading base rule', () => {
    expect(cssSource).toContain('.header-action-btn.btn-loading {');
  });

  it('btn-loading disables pointer-events', () => {
    const idx = cssSource.indexOf('.header-action-btn.btn-loading {');
    const block = cssSource.substring(idx, cssSource.indexOf('}', idx) + 1);
    expect(block).toContain('pointer-events: none');
  });

  it('btn-loading reduces opacity', () => {
    const idx = cssSource.indexOf('.header-action-btn.btn-loading {');
    const block = cssSource.substring(idx, cssSource.indexOf('}', idx) + 1);
    expect(block).toContain('opacity: 0.7');
  });

  it('btn-loading hides svg icon', () => {
    expect(cssSource).toContain('.header-action-btn.btn-loading svg');
    const idx = cssSource.indexOf('.header-action-btn.btn-loading svg');
    const block = cssSource.substring(idx, cssSource.indexOf('}', idx) + 1);
    expect(block).toContain('display: none');
  });

  it('btn-loading ::after creates spinner', () => {
    expect(cssSource).toContain('.header-action-btn.btn-loading::after');
  });

  it('spinner has circular border (border-radius: 50%)', () => {
    const idx = cssSource.indexOf('.header-action-btn.btn-loading::after');
    const block = cssSource.substring(idx, cssSource.indexOf('}', idx) + 1);
    expect(block).toContain('border-radius: 50%');
  });

  it('spinner uses spin animation', () => {
    const idx = cssSource.indexOf('.header-action-btn.btn-loading::after');
    const block = cssSource.substring(idx, cssSource.indexOf('}', idx) + 1);
    expect(block).toContain('animation: spin');
  });

  it('spinner has 14px size', () => {
    const idx = cssSource.indexOf('.header-action-btn.btn-loading::after');
    const block = cssSource.substring(idx, cssSource.indexOf('}', idx) + 1);
    expect(block).toContain('width: 14px');
    expect(block).toContain('height: 14px');
  });

  it('spinner uses accent-blue for top border color', () => {
    const idx = cssSource.indexOf('.header-action-btn.btn-loading::after');
    const block = cssSource.substring(idx, cssSource.indexOf('}', idx) + 1);
    expect(block).toContain('--accent-blue');
  });
});

// =====================================================================
// 11. Refresh icon — reuses reload/refresh SVG
// =====================================================================
describe('refresh icon — reload arrow SVG', () => {
  it('refresh button uses polyline points="23 4 23 10 17 10"', () => {
    // The refresh/reload icon
    expect(headerSource).toContain('points="23 4 23 10 17 10"');
  });

  it('refresh button has the arc path for reload icon', () => {
    expect(headerSource).toContain('M20.49 15a9 9 0 1 1-2.12-9.36L23 10');
  });
});

// =====================================================================
// 12. Old resume logic is fully removed
// =====================================================================
describe('old resume logic removal', () => {
  it('no resumeSession function in setup', () => {
    // Look for function definition, not string reference
    const setupSection = headerSource.split('setup()')[1] || '';
    expect(setupSection).not.toContain('resumeSession');
  });

  it('no canResume computed in setup', () => {
    const setupSection = headerSource.split('setup()')[1] || '';
    expect(setupSection).not.toContain('canResume');
  });

  it('no resumeConversation call in ChatHeader', () => {
    const setupSection = headerSource.split('setup()')[1] || '';
    expect(setupSection).not.toContain('resumeConversation');
  });
});

// =====================================================================
// 13. Structural integrity
// =====================================================================
describe('structural integrity', () => {
  it('ChatHeader.js template has balanced div tags', () => {
    const template = headerSource.split('template:')[1]?.split('setup()')[0] || '';
    const opens = (template.match(/<div[\s>]/g) || []).length;
    const closes = (template.match(/<\/div>/g) || []).length;
    expect(opens).toBe(closes);
  });

  it('CSS has balanced braces', () => {
    const opens = (cssSource.match(/\{/g) || []).length;
    const closes = (cssSource.match(/\}/g) || []).length;
    expect(opens).toBe(closes);
  });

  it('all 4 buttons with btn-loading binding (3 chat + 1 crew refresh)', () => {
    // Count occurrences of btn-loading in template
    const template = headerSource.split('template:')[1]?.split('setup()')[0] || '';
    const matches = template.match(/btn-loading/g) || [];
    // chat: refresh, compact, clear + crew: refresh — 4 buttons each with btn-loading
    expect(matches.length).toBe(4);
  });
});
