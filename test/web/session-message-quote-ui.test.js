// @vitest-environment happy-dom
import { mount } from '@vue/test-utils';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Vue from 'vue';
import {
  appendTurnResponseSegment,
  finalizeTurnResponseSegments,
  markTurnResponseKinds,
} from '../../web/utils/turn-response.js';

describe('Session message quote UI wiring', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    delete globalThis.marked;
    delete globalThis.hljs;
  });

  it('keeps the attachment badge last and separates turn progress from the final Markdown result', async () => {
    const user = readFileSync(resolve(process.cwd(), 'web/components/MessageItem.js'), 'utf8');
    const footerStart = user.indexOf('class="message-user-footer"');
    const footerEnd = user.indexOf('<!-- Expanded attachments preview -->');
    const footer = user.slice(footerStart, footerEnd);

    expect(footer).toContain('class="attachments-badge"');
    expect(footer.indexOf("$emit('edit-as-new')")).toBeLessThan(footer.indexOf('class="attachments-badge"'));
    expect(user).not.toContain('class="user-attachments-indicator"');

    globalThis.Vue = Vue;
    globalThis.Pinia = {
      defineStore: () => () => ({}),
      useChatStore: () => ({ answerUserQuestion: vi.fn(), cancelVpTurn: vi.fn() }),
    };
    globalThis.marked = {
      setOptions: vi.fn(),
      parse: vi.fn(text => text.startsWith('## ')
        ? `<h2>${text.slice(3)}</h2>`
        : `<p>${text}</p>`),
    };
    globalThis.hljs = undefined;
    const { default: AssistantTurn } = await import('../../web/components/AssistantTurn.js');

    const rows = [
      { id: 'a1', type: 'assistant', content: 'Inspecting files.', sessionId: 's1', speakerVpId: 'linus', turnId: 't1' },
      { id: 'a2', type: 'assistant', content: 'Sibling reply.', sessionId: 's1', speakerVpId: 'martin', turnId: 't2' },
      { id: 'a3', type: 'assistant', content: '## 改动', sessionId: 's1', speakerVpId: 'linus', turnId: 't1' },
    ];
    markTurnResponseKinds(rows, { sessionId: 's1', vpId: 'linus', turnId: 't1', reason: 'end_turn' });
    expect(rows.map(row => row.responseKind)).toEqual(['progress', undefined, 'result']);

    const aborted = [{ type: 'assistant', content: 'Partial', sessionId: 's1', speakerVpId: 'linus', turnId: 't3' }];
    markTurnResponseKinds(aborted, { sessionId: 's1', vpId: 'linus', turnId: 't3', reason: 'aborted' });
    expect(aborted[0].responseKind).toBe('progress');

    const errored = [{ type: 'assistant', content: 'Partial before error', sessionId: 's1', speakerVpId: 'linus', turnId: 't4' }];
    markTurnResponseKinds(errored, { sessionId: 's1', vpId: 'linus', turnId: 't4', reason: 'errored' });
    expect(errored[0].responseKind).toBe('progress');

    const turn = {
      id: 'turn-row', turnId: 't1', textContent: '', textSegments: [], toolMsgs: [], toolSummaryCount: 0,
      imageMsgs: [], todoMsg: null, askMsg: null, isStreaming: false, messages: [rows[0], rows[2]],
    };
    appendTurnResponseSegment(turn, rows[0]);
    appendTurnResponseSegment(turn, rows[2]);
    finalizeTurnResponseSegments(turn);
    const wrapper = mount(AssistantTurn, {
      props: { turn },
      global: {
        mocks: { $t: key => ({
          'message.showProgress': '展开过程',
          'message.hideProgress': '收起过程',
        }[key] || key) },
        provide: { t: key => key },
        stubs: { ToolLine: true, AskCard: true, VpSpeakerHeader: true },
      },
    });
    await Vue.nextTick();
    expect(globalThis.marked.parse).toHaveBeenNthCalledWith(1, 'Inspecting files.');
    expect(globalThis.marked.parse).toHaveBeenNthCalledWith(2, '## 改动');
    expect(wrapper.get('.turn-progress-group').attributes()).not.toHaveProperty('open');
    expect(wrapper.get('.turn-progress-toggle').attributes('aria-expanded')).toBe('false');
    expect(wrapper.get('.turn-progress-toggle').attributes('aria-label')).toBe('message.showProgress');
    expect(wrapper.find('.turn-progress-count').exists()).toBe(false);
    expect(wrapper.find('.turn-response-label').exists()).toBe(false);
    expect(wrapper.text()).not.toContain('过程');
    expect(wrapper.text()).not.toContain('结果');
    expect(wrapper.get('.turn-response-result h2').text()).toBe('改动');
    await wrapper.get('.turn-progress-toggle').trigger('click');
    expect(wrapper.get('.turn-progress-group').attributes()).toHaveProperty('open');
    expect(wrapper.get('.turn-progress-toggle').attributes('aria-expanded')).toBe('true');
    expect(wrapper.get('.turn-progress-toggle').attributes('aria-label')).toBe('message.hideProgress');
    wrapper.unmount();

    const streamingTurn = { ...turn, textContent: '', textSegments: [], messages: [], isStreaming: false, isActive: true };
    appendTurnResponseSegment(streamingTurn, {
      id: 'live', type: 'assistant', content: 'Still working', responseKind: 'progress', isStreaming: true,
    });
    const streamingWrapper = mount(AssistantTurn, {
      props: { turn: streamingTurn },
      global: {
        mocks: { $t: key => key },
        provide: { t: key => key },
        stubs: { ToolLine: true, AskCard: true, VpSpeakerHeader: true },
      },
    });
    await Vue.nextTick();
    expect(streamingWrapper.get('.turn-progress-group').attributes()).toHaveProperty('open');
    streamingWrapper.unmount();

    const legacy = { ...turn, textContent: '', textSegments: [], messages: [] };
    appendTurnResponseSegment(legacy, { id: 'legacy', type: 'assistant', content: 'Legacy answer', isStreaming: false });
    finalizeTurnResponseSegments(legacy);
    expect(legacy.textSegments[0].kind).toBe('result');

    const abortedHistory = { ...turn, textContent: '', textSegments: [], messages: [], isHistory: true };
    appendTurnResponseSegment(abortedHistory, {
      id: 'aborted', type: 'assistant', content: 'Partial output', responseKind: 'progress', isStreaming: false,
    });
    finalizeTurnResponseSegments(abortedHistory);
    expect(abortedHistory.textSegments[0].kind).toBe('progress');

    const pendingHistoryMessage = {
      id: 'pending-history', type: 'assistant', content: 'Still waiting for reviewers',
      responseKind: 'result', status: 'pending', isStreaming: false,
    };
    const pendingHistory = {
      ...turn,
      textContent: '',
      textSegments: [],
      messages: [pendingHistoryMessage],
      isHistory: true,
      isActive: false,
    };
    appendTurnResponseSegment(pendingHistory, pendingHistoryMessage);
    finalizeTurnResponseSegments(pendingHistory);
    expect(pendingHistory.textSegments[0].kind).toBe('progress');

    pendingHistoryMessage.status = 'completed';
    pendingHistoryMessage.turnEndReason = 'end_turn';
    pendingHistory.textSegments = [];
    appendTurnResponseSegment(pendingHistory, pendingHistoryMessage);
    finalizeTurnResponseSegments(pendingHistory);
    expect(pendingHistory.textSegments[0].kind).toBe('result');

    for (const failure of [
      { turnEndReason: 'cancelled' },
      { turnEndReason: 'error' },
      { incomplete: true, stopReason: 'error' },
    ]) {
      const contradictoryMessage = {
        id: `failed-${failure.turnEndReason || failure.stopReason}`,
        type: 'assistant', content: 'Partial failure', responseKind: 'result', isStreaming: false,
        ...failure,
      };
      const contradictoryTurn = {
        ...turn, textContent: '', textSegments: [], messages: [contradictoryMessage], isHistory: true,
      };
      appendTurnResponseSegment(contradictoryTurn, contradictoryMessage);
      finalizeTurnResponseSegments(contradictoryTurn);
      expect(contradictoryTurn.textSegments[0].kind).toBe('progress');
    }

    const splitStore = {
      activePanelId: 'pane-1',
      panels: [{ id: 'pane-1', conversationId: 'conversation-1' }],
      messagesMap: {
        'conversation-1': [
          { id: 'legacy-progress', type: 'assistant', content: 'Legacy progress', isHistory: true },
          { id: 'legacy-result', type: 'assistant', content: '## Legacy result', isHistory: true },
        ],
      },
      processingConversations: {},
      connectionState: 'connected',
      compactStatus: null,
      sessionHealth: {},
      getPaneRightPanel: () => null,
      setActivePanel: vi.fn(),
      removePanel: vi.fn(),
      sendMessageToConversation: vi.fn(),
      cancelExecutionForConversation: vi.fn(),
      setPaneRightPanel: vi.fn(),
      sendWsMessage: vi.fn(),
    };
    globalThis.Pinia.useChatStore = () => splitStore;
    const { default: SplitPane } = await import('../../web/components/SplitPane.js');
    const splitWrapper = mount(SplitPane, {
      props: { paneId: 'pane-1' },
      global: {
        mocks: { $t: key => key },
        stubs: {
          ChatHeader: true,
          MessageItem: true,
          ChatInput: true,
          ExpertPanel: true,
          SubAgentPanel: true,
          AssistantTurn: {
            props: ['turn'],
            template: `<div class="split-assistant-turn">
              <span v-for="segment in turn.textSegments" :class="'split-segment-' + segment.kind">{{ segment.content }}</span>
            </div>`,
          },
        },
      },
    });
    await Vue.nextTick();
    expect(splitWrapper.get('.split-segment-progress').text()).toBe('Legacy progress');
    expect(splitWrapper.get('.split-segment-result').text()).toBe('## Legacy result');
    splitWrapper.unmount();

  });

  it('uses concise localized labels and keeps user content inside one message block', async () => {
    const user = readFileSync(resolve(process.cwd(), 'web/components/MessageItem.js'), 'utf8');
    const sidebarCss = readFileSync(resolve(process.cwd(), 'web/styles/sidebar.css'), 'utf8');
    const messagesCss = readFileSync(resolve(process.cwd(), 'web/styles/chat-messages.css'), 'utf8');
    const blockStart = user.indexOf('class="message-user-block"');
    const blockEnd = user.indexOf('<!-- System message -->');
    const userBlock = user.slice(blockStart, blockEnd);

    expect(readFileSync(resolve(process.cwd(), 'web/i18n/en.js'), 'utf8')).toContain("'message.editAsNew': 'Edit'");
    expect(readFileSync(resolve(process.cwd(), 'web/i18n/zh-CN.js'), 'utf8')).toContain("'message.editAsNew': '编辑'");
    expect(user).toContain("<span class=\"message-user-author\">{{ $t('message.you') }}</span>");
    expect(user).toContain('class="message-user-meta-separator"');
    expect(user.indexOf('class="message-user-meta"')).toBeLessThan(blockStart);
    expect(userBlock).toContain('class="message-content"');
    expect(userBlock).toContain('class="message-user-footer"');
    expect(userBlock).toContain('class="user-attachments"');
    expect(sidebarCss).toMatch(/\.message-user-block\s*\{[\s\S]*?background: var\(--bg-user-msg-subtle\);/);
    expect(sidebarCss).toMatch(/\.message-user-meta\s*\{[\s\S]*?justify-content: flex-end;/);
    expect(messagesCss).toMatch(/\.message\.user\s*\{[\s\S]*?align-items: stretch;/);

    globalThis.Vue = Vue;
    globalThis.Pinia.useChatStore = () => ({ customExpertRoles: [] });
    const { default: MessageItem } = await import('../../web/components/MessageItem.js');
    const wrapper = mount(MessageItem, {
      props: {
        message: { type: 'user', content: 'Check this again', timestamp: Date.UTC(2026, 6, 28, 8, 15) },
        sessionActions: true,
      },
      global: {
        mocks: {
          $t: key => ({
            'message.you': 'You',
            'message.quote': 'Quote',
            'message.editAsNew': 'Edit',
          }[key] || key),
        },
        provide: { t: key => key },
      },
    });

    expect(wrapper.get('.message-user-author').text()).toBe('You');
    expect(wrapper.get('.message-user-meta-separator').text()).toBe('·');
    expect(wrapper.get('.message-user-meta .message-time').text()).not.toBe('');
    expect(wrapper.get('.message-user-block .message-content').text()).toBe('Check this again');
    expect(wrapper.findAll('.message-user-block .message-action-btn')).toHaveLength(2);
    expect(wrapper.get('.message-user-meta').element.compareDocumentPosition(
      wrapper.get('.message-user-block').element,
    ) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    wrapper.unmount();
  });
});
