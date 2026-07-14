import { describe, expect, it, vi } from 'vitest';
import {
  navigateToPersistedMessage,
  persistedMessageIdsForRenderedItem,
  resolvePersistedMessageTarget,
} from '../../web/utils/message-search-navigation.js';

function assistantRow(id = 'turn_1', messageIds = ['m101', 'm102']) {
  return {
    type: 'assistant-turn',
    id,
    atMessageId: messageIds.at(-1),
    messages: messageIds.map(messageId => ({ id: messageId, type: 'assistant' })),
  };
}

function messageBlock({ collapsed = false } = {}) {
  return {
    type: 'message-block',
    id: 'turn_m100_0',
    messageId: 'm100',
    responseCollapseKey: 'm100',
    responseCollapsed: collapsed,
    items: [
      { type: 'user', id: 'm100', message: { id: 'm100', content: 'question' } },
      assistantRow(),
    ],
  };
}

function navigationHarness(block, overrides = {}) {
  const collapseStates = {};
  const row = { scrollIntoView: vi.fn() };
  const scrollToBlock = vi.fn().mockResolvedValue(true);
  const findRow = vi.fn().mockReturnValue(row);
  const flashRow = vi.fn();
  const nextTick = vi.fn().mockResolvedValue(undefined);
  return {
    args: {
      blocks: [block],
      messageId: 'm101',
      collapseStates,
      scrollToBlock,
      findRow,
      flashRow,
      nextTick,
      ...overrides,
    },
    collapseStates,
    row,
    scrollToBlock,
    findRow,
    flashRow,
    nextTick,
  };
}

describe('persisted message search navigation', () => {
  it('maps every persisted assistant message to its rendered row', () => {
    const row = assistantRow();

    expect(persistedMessageIdsForRenderedItem(row)).toEqual(['m101', 'm102']);
    expect(resolvePersistedMessageTarget([messageBlock()], 'm101')).toMatchObject({
      blockId: 'turn_m100_0',
      rowId: 'turn_1',
      collapseKey: 'm100',
      requiresExpansion: false,
    });
  });

  it('scrolls an off-screen block before locating and flashing its assistant row', async () => {
    let mounted = false;
    const block = messageBlock();
    const harness = navigationHarness(block, {
      scrollToBlock: vi.fn(async (blockId) => {
        expect(blockId).toBe(block.id);
        mounted = true;
        return true;
      }),
      findRow: vi.fn(rowId => mounted && rowId === 'turn_1'
        ? { scrollIntoView: vi.fn() }
        : null),
    });

    await expect(navigateToPersistedMessage(harness.args)).resolves.toBe(true);
    expect(harness.args.findRow).toHaveBeenCalledWith('turn_1');
    expect(harness.flashRow).toHaveBeenCalledWith('turn_1');
  });

  it('expands a collapsed old response before virtual scrolling and row lookup', async () => {
    const block = messageBlock({ collapsed: true });
    const order = [];
    const harness = navigationHarness(block, {
      nextTick: vi.fn(async () => { order.push('tick'); }),
      scrollToBlock: vi.fn(async () => {
        order.push('scroll');
        expect(harness.collapseStates.m100).toBe(false);
        return true;
      }),
      findRow: vi.fn(() => {
        order.push('find');
        return { scrollIntoView: vi.fn() };
      }),
      flashRow: vi.fn(() => { order.push('flash'); }),
    });

    await expect(navigateToPersistedMessage(harness.args)).resolves.toBe(true);
    expect(harness.collapseStates).toEqual({ m100: false });
    expect(order).toEqual(['tick', 'scroll', 'tick', 'find', 'flash']);
  });

  it('fails closed when the rendered row is still absent after scrolling', async () => {
    const harness = navigationHarness(messageBlock(), {
      findRow: vi.fn().mockReturnValue(null),
    });

    await expect(navigateToPersistedMessage(harness.args)).resolves.toBe(false);
    expect(harness.flashRow).not.toHaveBeenCalled();
  });
});
