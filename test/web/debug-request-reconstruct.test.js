import { describe, expect, it, vi } from 'vitest';

const { applyDebugRawRequestDelta, reconstructDebugRawRequest } = await import('../../web/components/yeaft-debug-helpers.js');
const { default: YeaftDebugPanel } = await import('../../web/components/YeaftDebugPanel.js');

describe('debug raw request reconstruction', () => {
  it('reconstructs full request bodies from append-only message deltas', () => {
    const first = reconstructDebugRawRequest(null, {
      rawRequestDelta: {
        set: {
          method: 'POST',
          url: 'https://llm.example/v1/responses',
        },
        body: {
          model: 'm',
          stream: true,
          messagesKey: 'input',
          messagesFrom: 0,
          messagesAppend: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] }],
        },
      },
    });

    const secondDelta = {
      rawRequestDelta: {
        body: {
          messagesKey: 'input',
          messagesFrom: 1,
          messagesAppend: [
            { type: 'function_call', call_id: 'call_1', name: 'Bash', arguments: '{"command":"pwd"}' },
            { type: 'function_call_output', call_id: 'call_1', output: '/tmp/project' },
          ],
        },
      },
    };
    const second = reconstructDebugRawRequest(first, secondDelta);
    const secondFromUiLoopShape = reconstructDebugRawRequest(first, secondDelta);

    expect(second).toMatchObject({ method: 'POST', url: 'https://llm.example/v1/responses' });
    expect(second.body.model).toBe('m');
    expect(second.body.stream).toBe(true);
    expect(second.body.input).toHaveLength(3);
    expect(second.body.input[2]).toMatchObject({ type: 'function_call_output', call_id: 'call_1' });
    expect(secondFromUiLoopShape).toEqual(second);
  });

  it('applies appended messages to Responses input arrays', () => {
    const base = {
      body: {
        input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] }],
      },
    };

    const next = applyDebugRawRequestDelta(base, {
      body: {
        messagesKey: 'input',
        messagesFrom: 1,
        messagesAppend: [{ type: 'function_call_output', call_id: 'call_1', output: 'ok' }],
      },
    });

    expect(next.body.input).toHaveLength(2);
    expect(next.body.input[1]).toMatchObject({ type: 'function_call_output', call_id: 'call_1' });
  });

  it('uses the exact live per-loop request before trying history reconstruction', () => {
    const liveRequest = {
      method: 'POST',
      url: 'https://llm.example/v1/responses',
      headers: { authorization: '***' },
      body: { model: 'live-model', input: [{ role: 'user', content: 'actual wire input' }] },
    };
    const loop = {
      rawRequest: liveRequest,
      rawRequestBase: { body: { model: 'stale-base' } },
      requestDelta: { rawRequestDelta: { body: { model: 'stale-delta' } } },
    };

    expect(YeaftDebugPanel.methods.rawRequestForLoop(loop)).toBe(liveRequest);
  });

  it('copies the live request for each loop as formatted JSON', () => {
    const rawRequest = {
      method: 'POST',
      url: 'https://llm.example/v1/messages',
      body: { model: 'claude', messages: [{ role: 'user', content: 'hello' }] },
    };
    const ctx = {
      ...YeaftDebugPanel.methods,
      copyText: vi.fn(),
    };

    YeaftDebugPanel.methods.copyRawRequest.call(ctx, { rawRequest });

    expect(ctx.copyText).toHaveBeenCalledWith(rawRequest, 'raw request');
  });
});
