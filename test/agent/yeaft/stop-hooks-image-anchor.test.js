import { describe, expect, it, vi } from 'vitest';
import { runStopHooks } from '../../../agent/yeaft/stop-hooks.js';

function makeContext(messages, overrides = {}) {
  const append = vi.fn(record => record);
  return {
    context: {
      mode: 'unified',
      conversationStore: { append },
      config: { model: 'test-model' },
      primaryModel: 'test-model',
      messages,
      turnStartIdx: 0,
      sessionId: 'session-1',
      threadId: 'main',
      turnId: 'turn-1',
      vpId: 'vp-1',
      hasDisplayImageAnchor: true,
      ...overrides,
    },
    append,
  };
}

describe('stop hook image asset anchor', () => {
  it('anchors only the final persistable assistant row in a tool turn', async () => {
    const { context, append } = makeContext([
      { role: 'user', content: 'generate an image' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'call-1', name: 'ImageGeneration', input: {} }] },
      { role: 'tool', toolCallId: 'call-1', content: '{"success":true}' },
      { role: 'assistant', content: 'Here is the image.' },
    ]);

    await runStopHooks(context);

    const records = append.mock.calls.map(([record]) => record);
    expect(records).toHaveLength(4);
    expect(records.filter(record => record.imageAssetAnchor)).toEqual([
      expect.objectContaining({ role: 'assistant', content: 'Here is the image.', turnId: 'turn-1' }),
    ]);
    expect(records[1]).toMatchObject({ role: 'assistant', toolCalls: [{ id: 'call-1' }] });
    expect(records[1]).not.toHaveProperty('imageAssetAnchor');
  });

  it('falls back to the last persistable assistant tool-call row when no final reply exists', async () => {
    const { context, append } = makeContext([
      { role: 'user', content: 'generate an image' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'call-1', name: 'ImageGeneration', input: {} }] },
      { role: 'tool', toolCallId: 'call-1', content: '{"success":true}' },
    ]);

    await runStopHooks(context);

    const records = append.mock.calls.map(([record]) => record);
    expect(records.filter(record => record.imageAssetAnchor)).toEqual([
      expect.objectContaining({
        role: 'assistant',
        toolCalls: [expect.objectContaining({ id: 'call-1' })],
        turnId: 'turn-1',
      }),
    ]);
  });

  it('does not write an anchor when durable image enqueue was not confirmed locally', async () => {
    const { context, append } = makeContext([
      { role: 'user', content: 'generate an image' },
      { role: 'assistant', content: 'No durable asset.' },
    ], { hasDisplayImageAnchor: false });

    await runStopHooks(context);

    expect(append.mock.calls.map(([record]) => record).some(record => record.imageAssetAnchor)).toBe(false);
  });
});
