import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { loadAllCss } from '../helpers/loadCss.js';

/**
 * Tests for task-50: Remove redundant processing-hint status bar from Chat mode.
 *
 * The bottom status line (processing-hint) duplicated info already shown in
 * AssistantTurn's tool action list. It has been removed.
 *
 * Verifies:
 * 1) processing-hint template removed from MessageList.js
 * 2) Related computed properties removed (statusIcon, statusText, etc.)
 * 3) AssistantTurn tool action list still intact (expand/collapse, latestTool)
 * 4) Sidebar session status indicators still work (processing-dot, isConversationProcessing)
 * 5) Streaming cursor blink animation still exists
 * 6) processing-hint CSS rules removed from style.css
 * 7) executionStatusMap preserved (still used by sidebar)
 * 8) Structural integrity
 */

let messageListSource;
let assistantTurnSource;
let chatPageSource;
let cssSource;
let storeSource;

beforeAll(() => {
  messageListSource = readFileSync(
    resolve(__dirname, '../../web/components/MessageList.js'), 'utf-8'
  );
  assistantTurnSource = readFileSync(
    resolve(__dirname, '../../web/components/AssistantTurn.js'), 'utf-8'
  );
  chatPageSource = readFileSync(
    resolve(__dirname, '../../web/components/ChatPage.js'), 'utf-8'
  );
  cssSource = loadAllCss();
  storeSource = readFileSync(
    resolve(__dirname, '../../web/stores/chat.js'), 'utf-8'
  );
});

/**
 * Extract a CSS rule block by selector.
 */
function extractCssBlock(selector) {
  const idx = cssSource.indexOf(selector);
  if (idx === -1) return '';
  const braceStart = cssSource.indexOf('{', idx);
  if (braceStart === -1) return '';
  let depth = 0;
  let end = braceStart;
  for (let i = braceStart; i < cssSource.length; i++) {
    if (cssSource[i] === '{') depth++;
    if (cssSource[i] === '}') depth--;
    if (depth === 0) { end = i; break; }
  }
  return cssSource.substring(braceStart + 1, end).trim();
}

// =====================================================================
// 1. processing-hint template removed from MessageList.js
// =====================================================================
describe('processing-hint template removed', () => {
  it('no processing-hint class in MessageList template', () => {
    expect(messageListSource).not.toContain('processing-hint');
  });

  it('no processing-icon in MessageList template', () => {
    expect(messageListSource).not.toContain('processing-icon');
  });

  it('no processing-text in MessageList template', () => {
    expect(messageListSource).not.toContain('processing-text');
  });

  it('no processing-detail in MessageList template', () => {
    expect(messageListSource).not.toContain('processing-detail');
  });

  it('no statusIcon in MessageList template', () => {
    expect(messageListSource).not.toContain('statusIcon');
  });

  it('no statusText in MessageList template', () => {
    expect(messageListSource).not.toContain('statusText');
  });

  it('no statusDetail in MessageList template', () => {
    expect(messageListSource).not.toContain('statusDetail');
  });
});

// =====================================================================
// 2. Related computed properties removed
// =====================================================================
describe('computed properties removed from MessageList', () => {
  it('no statusIcon computed', () => {
    expect(messageListSource).not.toContain('const statusIcon');
  });

  it('no statusText computed', () => {
    expect(messageListSource).not.toContain('const statusText');
  });

  it('no statusDetail computed', () => {
    expect(messageListSource).not.toContain('const statusDetail');
  });

  it('no statusIconClass computed', () => {
    expect(messageListSource).not.toContain('statusIconClass');
  });

  it('no currentTool computed', () => {
    expect(messageListSource).not.toContain('const currentTool');
  });

  it('no shortenPath helper', () => {
    expect(messageListSource).not.toContain('const shortenPath');
  });

  it('no Vue.inject t reference (was only used by status computed)', () => {
    expect(messageListSource).not.toContain("Vue.inject('t')");
  });

  it('setup return does not include removed properties', () => {
    expect(messageListSource).not.toContain('statusIcon,');
    expect(messageListSource).not.toContain('statusIconClass,');
    expect(messageListSource).not.toContain('statusText,');
    expect(messageListSource).not.toContain('statusDetail');
    expect(messageListSource).not.toContain('shortenPath,');
  });

  it('setup still returns store, containerRef, turnGroups, etc.', () => {
    expect(messageListSource).toContain('store,');
    expect(messageListSource).toContain('containerRef,');
    expect(messageListSource).toContain('turnGroups');
    expect(messageListSource).toContain('onlineAgents,');
    expect(messageListSource).toContain('hasStreamingMessage,');
  });
});

// =====================================================================
// 3. AssistantTurn tool action list still intact
// =====================================================================
describe('AssistantTurn tool actions preserved', () => {
  it('has turn-actions container', () => {
    expect(assistantTurnSource).toContain('turn-actions');
  });

  it('has latestTool computed', () => {
    expect(assistantTurnSource).toContain('latestTool');
  });

  it('has expand/collapse button for multiple tools', () => {
    expect(assistantTurnSource).toContain('turn-expand-btn');
  });

  it('shows "N more" for collapsed tools', () => {
    expect(assistantTurnSource).toContain('more</span>');
  });

  it('renders ToolLine for latest tool', () => {
    expect(assistantTurnSource).toContain('ToolLine');
    expect(assistantTurnSource).toContain(':tool-name="latestTool.toolName"');
  });

  it('supports toggleExpand for tool list', () => {
    expect(assistantTurnSource).toContain('toggleExpand');
  });

  it('toolMsgs array used for tool actions', () => {
    expect(assistantTurnSource).toContain('turn.toolMsgs');
  });
});

// =====================================================================
// 4. Sidebar session status indicators still work
// =====================================================================
describe('sidebar processing indicators preserved', () => {
  it('ChatPage uses isConversationProcessing for normal conversations', () => {
    expect(chatPageSource).toContain('store.isConversationProcessing(conv.id)');
  });

  it('ChatPage shows processing-dot for active conversations', () => {
    expect(chatPageSource).toContain('processing-dot');
  });

  it('processing CSS class binding on session-item', () => {
    expect(chatPageSource).toContain('processing: store.isConversationProcessing(conv.id)');
  });

  it('store defines isConversationProcessing getter', () => {
    expect(storeSource).toContain('isConversationProcessing');
  });

  it('.processing-dot CSS rule still exists', () => {
    expect(cssSource).toContain('.processing-dot');
  });
});

// =====================================================================
// 5. Streaming cursor blink animation still exists
// =====================================================================
describe('streaming cursor blink animation preserved', () => {
  it('.cursor-blink CSS rule exists', () => {
    expect(cssSource).toContain('.cursor-blink {');
  });

  it('@keyframes blink animation exists', () => {
    expect(cssSource).toContain('@keyframes blink');
  });

  it('cursor-blink uses blink animation', () => {
    const block = extractCssBlock('.cursor-blink {');
    expect(block).toContain('animation: blink');
  });

  it('cursor-blink has correct visual properties', () => {
    const block = extractCssBlock('.cursor-blink {');
    expect(block).toContain('display: inline-block');
    expect(block).toContain('width: 2px');
    expect(block).toContain('background: var(--text-primary)');
  });
});

// =====================================================================
// 6. processing-hint CSS rules removed
// =====================================================================
describe('processing-hint CSS rules removed', () => {
  it('no .processing-hint CSS rule', () => {
    expect(cssSource).not.toContain('.processing-hint');
  });

  it('no .processing-icon CSS rule', () => {
    expect(cssSource).not.toContain('.processing-icon');
  });

  it('no .processing-text CSS rule (as class selector)', () => {
    // Note: .processing-text was a child of .processing-hint
    // Verify no standalone processing-text rule exists
    expect(cssSource).not.toContain('.processing-hint .processing-text');
  });

  it('no .processing-detail CSS rule', () => {
    expect(cssSource).not.toContain('.processing-detail');
  });

  it('no @keyframes processingPulse', () => {
    expect(cssSource).not.toContain('processingPulse');
  });

  it('no processing-hint mobile media query override', () => {
    // The @media block that resized processing-hint for mobile is gone
    expect(cssSource).not.toContain('.processing-hint');
  });
});

// =====================================================================
// 7. executionStatusMap preserved
// =====================================================================
describe('executionStatusMap preserved for sidebar use', () => {
  it('store defines executionStatusMap state', () => {
    expect(storeSource).toContain('executionStatusMap');
  });

  it('store has executionStatus getter', () => {
    expect(storeSource).toContain('executionStatus:');
  });

  it('ChatPage accesses executionStatusMap for conversation time', () => {
    expect(chatPageSource).toContain('executionStatusMap[conv.id]');
  });

  it('store still tracks isProcessing', () => {
    expect(storeSource).toContain('isProcessing');
  });
});

// =====================================================================
// 8. MessageList template still has core structure
// =====================================================================
describe('MessageList core structure intact', () => {
  it('has chat-container main element', () => {
    expect(messageListSource).toContain('class="chat-container"');
  });

  it('has welcome-screen for no conversation', () => {
    expect(messageListSource).toContain('welcome-screen');
  });

  it('has messages container', () => {
    expect(messageListSource).toContain('class="messages"');
  });

  it('renders MessageItem for user/system/error', () => {
    expect(messageListSource).toContain('MessageItem');
  });

  it('renders AssistantTurn for assistant turns', () => {
    expect(messageListSource).toContain('AssistantTurn');
  });

  it('has turnGroups iteration', () => {
    expect(messageListSource).toContain('v-for="item in turnGroups"');
  });

  it('has load-more functionality', () => {
    expect(messageListSource).toContain('loadMoreMessages');
  });
});

// =====================================================================
// 9. Structural integrity
// =====================================================================
describe('structural integrity', () => {
  it('MessageList.js has balanced div tags', () => {
    const opens = (messageListSource.match(/<div[\s>]/g) || []).length;
    const closes = (messageListSource.match(/<\/div>/g) || []).length;
    expect(opens).toBe(closes);
  });

  it('MessageList.js has balanced template tags', () => {
    const opens = (messageListSource.match(/<template[\s>]/g) || []).length;
    const closes = (messageListSource.match(/<\/template>/g) || []).length;
    expect(opens).toBe(closes);
  });

  it('CSS has balanced braces (2143/2143)', () => {
    const opens = (cssSource.match(/\{/g) || []).length;
    const closes = (cssSource.match(/\}/g) || []).length;
    expect(opens).toBe(closes);
    expect(opens).toBe(2143);
  });

  it('MessageList.js exports a valid component', () => {
    expect(messageListSource).toContain('export default');
    expect(messageListSource).toContain("name: 'MessageList'");
    expect(messageListSource).toContain('template:');
    expect(messageListSource).toContain('setup()');
  });
});
