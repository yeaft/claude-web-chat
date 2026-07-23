import { readFileSync } from 'node:fs';
import { computed, reactive } from 'vue';
import { describe, expect, it } from 'vitest';
import {
  annotateMessageBlocksForResponseCollapse,
  collapsedResponsePreviewForMessageBlock,
  estimateCollapsedMessageBlockHeight,
  visibleItemsForMessageBlock,
} from '../../web/utils/message-turn-collapse.js';

function user(id) {
  return { type: 'user', id, message: { id, content: id } };
}

function assistant(id, extra = {}) {
  return { type: 'assistant-turn', id, textContent: id, ...extra };
}

const readWebFile = (path) => readFileSync(new URL(`../../web/${path}`, import.meta.url), 'utf8');

describe('message turn response visibility', () => {
  it('keeps the newest two user turns expanded and collapses older responses by default', () => {
    const blocks = annotateMessageBlocksForResponseCollapse([
      { type: 'message-block', id: 'turn-1', messageId: 'u1', items: [user('u1'), assistant('a1')] },
      { type: 'message-block', id: 'turn-2', messageId: 'u2', items: [user('u2'), assistant('a2')] },
      { type: 'message-block', id: 'turn-3', messageId: 'u3', items: [user('u3'), assistant('a3')] },
      { type: 'message-block', id: 'turn-4', messageId: 'u4', items: [user('u4'), assistant('a4')] },
    ]);

    expect(blocks.map(block => block.responseCollapsed)).toEqual([true, true, false, false]);
    expect(visibleItemsForMessageBlock(blocks[0])).toEqual([blocks[0].items[0]]);
    expect(visibleItemsForMessageBlock(blocks[3])).toEqual(blocks[3].items);
  });

  it('lets explicit user expansion override the default collapsed state', () => {
    const blocks = annotateMessageBlocksForResponseCollapse([
      { type: 'message-block', id: 'turn-1', messageId: 'u1', items: [user('u1'), assistant('a1')] },
      { type: 'message-block', id: 'turn-2', messageId: 'u2', items: [user('u2'), assistant('a2')] },
      { type: 'message-block', id: 'turn-3', messageId: 'u3', items: [user('u3'), assistant('a3')] },
    ], { u1: false });

    expect(blocks[0].responseCollapseKey).toBe('u1');
    expect(blocks[0].responseCollapsed).toBe(false);
  });

  it('does not collapse streaming responses', () => {
    const blocks = annotateMessageBlocksForResponseCollapse([
      { type: 'message-block', id: 'turn-1', messageId: 'u1', items: [user('u1'), assistant('a1')] },
      { type: 'message-block', id: 'turn-2', messageId: 'u2', items: [user('u2'), assistant('a2')] },
      { type: 'message-block', id: 'turn-3', messageId: 'u3', items: [user('u3'), assistant('a3', { isStreaming: true })] },
    ], {}, { expandedRecentUserTurns: 0 });

    expect(blocks[0].responseCollapsible).toBe(true);
    expect(blocks[0].responseCollapsed).toBe(true);
    expect(blocks[2].responseCollapsible).toBe(false);
    expect(blocks[2].responseCollapsed).toBe(false);
  });

  it('reacts when an explicit collapse state is added for a previously missing key', () => {
    const collapseStates = reactive({});
    const sourceBlocks = [
      { type: 'message-block', id: 'turn-1', messageId: 'u1', items: [user('u1'), assistant('a1')] },
    ];
    const annotated = computed(() => annotateMessageBlocksForResponseCollapse(
      sourceBlocks,
      collapseStates,
      { expandedRecentUserTurns: 0 }
    ));

    expect(annotated.value[0].responseCollapsed).toBe(true);
    collapseStates.u1 = false;
    expect(annotated.value[0].responseCollapsed).toBe(false);
  });

  it('keeps the first two response lines when a block is collapsed', () => {
    const [block] = annotateMessageBlocksForResponseCollapse([
      {
        type: 'message-block',
        id: 'turn-1',
        messageId: 'u1',
        items: [user('u1'), assistant('a1', { textContent: '\n\n# First visible line\nSecond line\nThird line' })],
      },
    ], {}, { expandedRecentUserTurns: 0 });

    expect(block.responseCollapsed).toBe(true);
    expect(block.collapsedResponsePreview).toEqual(['First visible line', 'Second line']);
    expect(collapsedResponsePreviewForMessageBlock(block)).toEqual(['First visible line', 'Second line']);
  });

  it('uses compact height estimates for collapsed response blocks with a preview row', () => {
    const [block] = annotateMessageBlocksForResponseCollapse([
      { type: 'message-block', id: 'turn-1', messageId: 'u1', items: [user('u1'), assistant('a1')] },
    ], {}, { expandedRecentUserTurns: 0 });

    expect(estimateCollapsedMessageBlockHeight(block, () => 100)).toBe(192);
  });

  it('keeps every AI response visible in the active transcript path', () => {
    const messageListSource = readWebFile('components/MessageList.js');

    expect(messageListSource).toContain('return blocks;');
    expect(messageListSource).not.toContain('return annotateMessageBlocksForResponseCollapse(blocks, messageTurnCollapseStates);');
    expect(messageListSource).toContain('VirtualTranscript\n          :key="virtualTranscriptIdentity"');
  });

  it('keeps collapsed response preview typography aligned with normal turn text', () => {
    const cssSource = readWebFile('styles/chat-messages.css');
    const messageListSource = readWebFile('components/MessageList.js');
    const markdownBodyRule = cssSource.match(/\.markdown-body\s*\{[\s\S]*?\n\}/)?.[0] || '';
    const collapsedBodyRule = cssSource.match(/\.message-block-collapsed-preview-body\s*\{[\s\S]*?\n\}/)?.[0] || '';
    expect(markdownBodyRule).toContain('font-size: 14px;');
    expect(markdownBodyRule).toContain('line-height: 1.65;');
    expect(messageListSource).toContain('class="message-block-collapsed-preview-body markdown-body"');
    expect(collapsedBodyRule).toContain('font-family: inherit;');
    expect(collapsedBodyRule).toContain('color: var(--text-primary);');
    expect(collapsedBodyRule).not.toContain('font: inherit;');
    expect(cssSource).toContain('.message-block-collapsed-preview-line {\n  display: block;');
    expect(cssSource).toContain('color: inherit;');
    expect(cssSource).not.toContain('.message-block-collapsed-preview-line {\n  color: var(--text-secondary);\n}');
  });
});
