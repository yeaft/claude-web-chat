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
        mocks: { $t: key => ({ 'message.progress': '过程', 'message.result': '结果' }[key] || key) },
        provide: { t: key => key },
        stubs: { ToolLine: true, AskCard: true, VpSpeakerHeader: true },
      },
    });
    await Vue.nextTick();
    expect(globalThis.marked.parse).toHaveBeenNthCalledWith(1, 'Inspecting files.');
    expect(globalThis.marked.parse).toHaveBeenNthCalledWith(2, '## 改动');
    expect(wrapper.get('.turn-progress-group').attributes()).not.toHaveProperty('open');
    expect(wrapper.get('.turn-response-result h2').text()).toBe('改动');
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

  });

  it('uses concise localized edit labels', () => {
    expect(readFileSync(resolve(process.cwd(), 'web/i18n/en.js'), 'utf8')).toContain("'message.editAsNew': 'Edit'");
    expect(readFileSync(resolve(process.cwd(), 'web/i18n/zh-CN.js'), 'utf8')).toContain("'message.editAsNew': '编辑'");
  });
});
