import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

/**
 * Tests for removal of processing-hint status bar from Chat mode.
 *
 * Verifies business logic:
 * 1) Sidebar processing indicators still work (isConversationProcessing)
 * 2) executionStatusMap preserved for sidebar
 * 3) AssistantTurn tool action list preserved
 */

let assistantTurnSource;
let chatPageSource;
let storeSource;

beforeAll(() => {
  assistantTurnSource = readFileSync(
    resolve(__dirname, '../../web/components/AssistantTurn.js'), 'utf-8'
  );
  chatPageSource = readFileSync(
    resolve(__dirname, '../../web/components/ChatPage.js'), 'utf-8'
  );
  storeSource = readFileSync(
    resolve(__dirname, '../../web/stores/chat.js'), 'utf-8'
  );
});

// =====================================================================
// 1. Sidebar processing indicators still work
// =====================================================================
describe('sidebar processing indicators preserved', () => {
  it('ChatPage uses isConversationProcessing for conversations', () => {
    expect(chatPageSource).toContain('store.isConversationProcessing(conv.id)');
  });

  it('store defines isConversationProcessing getter', () => {
    expect(storeSource).toContain('isConversationProcessing');
  });
});

// =====================================================================
// 2. executionStatusMap preserved for sidebar use
// =====================================================================
describe('executionStatusMap preserved', () => {
  it('store defines executionStatusMap state', () => {
    expect(storeSource).toContain('executionStatusMap');
  });

  it('ChatPage accesses executionStatusMap for conversation time', () => {
    expect(chatPageSource).toContain('executionStatusMap[conv.id]');
  });
});

// =====================================================================
// 3. AssistantTurn tool actions preserved
// =====================================================================
describe('AssistantTurn tool actions preserved', () => {
  it('has latestTool computed', () => {
    expect(assistantTurnSource).toContain('latestTool');
  });

  it('supports toggleExpand for tool list', () => {
    expect(assistantTurnSource).toContain('toggleExpand');
  });

  it('toolMsgs array used for tool actions', () => {
    expect(assistantTurnSource).toContain('turn.toolMsgs');
  });
});
