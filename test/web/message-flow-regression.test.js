import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  addMessageToConversation,
  appendToAssistantMessageForConversation,
} from '../../web/stores/helpers/messages.js';
import {
  buildYeaftMessageTurnSpans,
  hasHiddenYeaftMessageTurns,
  sliceYeaftMessagesByRecentTurns,
} from '../../web/stores/helpers/yeaft-message-window.js';

function makeStore() {
  return {
    yeaftConversationId: 'conv-1',
    _currentYeaftSessionId: 'session-1',
    _currentYeaftVpId: 'vp-1',
    _currentYeaftTurnId: 'turn-1',
    messagesMap: { 'conv-1': [] },
    yeaftSessionHistoryState: {},
  };
}

describe('message flow regressions', () => {
  it('keeps same-id streaming updates in one assistant message', () => {
    const store = makeStore();

    appendToAssistantMessageForConversation(store, 'conv-1', 'hello ', {
      id: 'msg-1',
      sessionId: 'session-1',
      vpId: 'vp-1',
      turnId: 'turn-1',
    });
    appendToAssistantMessageForConversation(store, 'conv-1', 'world', {
      id: 'msg-1',
      sessionId: 'session-1',
      vpId: 'vp-1',
      turnId: 'turn-1',
    });

    expect(store.messagesMap['conv-1']).toHaveLength(1);
    expect(store.messagesMap['conv-1'][0]).toMatchObject({
      type: 'assistant',
      content: 'hello world',
      isStreaming: true,
      speakerVpId: 'vp-1',
      turnId: 'turn-1',
    });

    appendToAssistantMessageForConversation(store, 'conv-1', 'hello world!', {
      id: 'msg-1',
      turnId: 'turn-1',
    });

    expect(store.messagesMap['conv-1']).toHaveLength(1);
    expect(store.messagesMap['conv-1'][0]).toMatchObject({
      type: 'assistant',
      content: 'hello world!',
      isStreaming: true,
      speakerVpId: 'vp-1',
      turnId: 'turn-1',
    });
  });

  it('keeps send available while the current turn is running', () => {
    const component = readFileSync(resolve(import.meta.dirname, '../../web/components/ChatInput.js'), 'utf8');
    const workCenter = readFileSync(resolve(import.meta.dirname, '../../web/components/WorkCenterPage.js'), 'utf8');
    const workCenterCss = readFileSync(resolve(import.meta.dirname, '../../web/styles/work-center.css'), 'utf8');

    expect(component).toContain('v-if="isStopVisible"');
    expect(component).not.toContain('v-else\n          type="button"\n          class="send-btn"');
    expect(component).toContain('if (isCompacting.value) return false;');
    expect(component).not.toContain('if (isCompacting.value || isStopVisible.value) return false;');
    expect(component).toContain('if (!canSend.value) return;');
    expect(component).not.toContain('if (isStopVisible.value || !canSend.value) return;');
    expect(workCenter).toContain('@change="onWorkItemMessageAttachmentInput"');
    expect(workCenter).toContain('workItemMessageAttachments.length === 0');
    expect(workCenter).toContain('work-center-detail-close');
    expect(workCenter).not.toContain('class="work-center-action-content-summary"');
    expect(workCenterCss).toContain('grid-template-columns: minmax(0, 1fr) minmax(400px, 440px);');
    expect(workCenterCss).toMatch(/\.work-center-detail-close\s*\{[\s\S]*?position: absolute;[\s\S]*?right: 16px;/);
    expect(workCenterCss).toMatch(/\.work-center-action-description\s*\{[\s\S]*?white-space: nowrap;/);
    expect(workCenter).toContain("[...(this.selected.messages || [])].reverse().some");
    expect(workCenter).toContain("message.recovery?.actionId === this.selectedAction.id");
  });

  it('uses the available Work Center detail space without breaking narrow fallbacks', () => {
    const workCenter = readFileSync(resolve(import.meta.dirname, '../../web/components/WorkCenterPage.js'), 'utf8');
    const workCenterCss = readFileSync(resolve(import.meta.dirname, '../../web/styles/work-center.css'), 'utf8');
    const variables = readFileSync(resolve(import.meta.dirname, '../../web/styles/variables.css'), 'utf8');

    expect(workCenter).toContain(":class=\"{ 'showing-detail': narrowPane !== 'items' }\"");
    expect(workCenterCss).toMatch(/\.work-center-shell\.showing-detail\s*\{[\s\S]*?padding-top: 10px;/);
    expect(workCenterCss).toMatch(/\.work-center-detail-heading\s*\{[\s\S]*?padding: 10px 56px 12px 24px;/);
    expect(workCenterCss).toMatch(/\.work-center-action-detail-header,[\s\S]*?\.work-center-action-composer\s*\{[\s\S]*?width: 100%;/);
    expect(workCenterCss).not.toContain('width: min(100%, 1120px);');
    expect(variables).toContain('--work-center-conversation-column-width: 1200px;');
    expect(variables).toContain('--work-center-conversation-gutter: clamp(20px, 3vw, 40px);');
    expect(workCenterCss).toMatch(/@container work-center \(max-width: 1120px\)\s*\{[\s\S]*?\.work-center-detail-layout\s*\{[\s\S]*?grid-template-columns: minmax\(0, 1fr\);/);
    expect(workCenterCss).toMatch(/@media \(max-width: 768px\)\s*\{[\s\S]*?\.work-center-action-detail-pane\s*\{[\s\S]*?--work-center-conversation-gutter: var\(--work-center-conversation-gutter-compact\);/);
  });

  it('stamps background agent messages without promoting that conversation', () => {
    const store = makeStore();
    store.yeaftConversationIdsByAgent = {
      'agent-1': 'conv-1',
      'agent-2': 'conv-2',
    };
    store.messagesMap['conv-2'] = [];
    store._currentYeaftSessionId = 'session-2';
    store._currentYeaftVpId = 'vp-2';
    store._currentYeaftTurnId = 'turn-2';

    addMessageToConversation(store, 'conv-2', {
      id: 'msg-2',
      type: 'assistant',
      content: 'background',
    });

    expect(store.yeaftConversationId).toBe('conv-1');
    expect(store.messagesMap['conv-2'][0]).toMatchObject({
      sessionId: 'session-2',
      vpId: 'vp-2',
      turnId: 'turn-2',
      speakerVpId: 'vp-2',
    });
  });

  it('counts hyphenated tool-use/tool-result events as part of Yeaft assistant turns', () => {
    const messages = [
      { type: 'user', content: 'u1' },
      { type: 'tool-use', toolName: 'Bash', turnId: 'a', speakerVpId: 'vp-1' },
      { type: 'tool-result', toolUseId: 't1', turnId: 'a', speakerVpId: 'vp-1' },
      { type: 'assistant', content: 'a1', turnId: 'a', speakerVpId: 'vp-1' },
      { type: 'user', content: 'u2' },
      { type: 'assistant', content: 'a2', turnId: 'b', speakerVpId: 'vp-1' },
    ];

    expect(buildYeaftMessageTurnSpans(messages).map(s => s.kind)).toEqual([
      'user',
      'user',
    ]);
    expect(hasHiddenYeaftMessageTurns(messages, 1)).toBe(true);
    expect(sliceYeaftMessagesByRecentTurns(messages, 1)).toEqual(messages.slice(4));
  });
});
