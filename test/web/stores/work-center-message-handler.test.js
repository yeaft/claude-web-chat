import { describe, expect, it, vi } from 'vitest';

globalThis.Pinia = globalThis.Pinia || {};
globalThis.Pinia.defineStore = (_id, options) => () => ({ ...(options.state ? options.state() : {}), ...(options.actions || {}) });
globalThis.window = globalThis.window || globalThis;
globalThis.window.Pinia = globalThis.Pinia;
globalThis.localStorage = globalThis.localStorage || { getItem: () => null, setItem: () => {}, removeItem: () => {} };

const { handleMessage } = await import('../../../web/stores/helpers/messageHandler.js');

describe('Work Center web message handling', () => {
  it('resolves a pending request with response data', () => {
    const resolve = vi.fn();
    const timer = setTimeout(() => {}, 10_000);
    const store = {
      _lastPongAt: 0,
      workCenterPending: { req: { resolve, reject: vi.fn(), timer } },
      applyWorkCenterEvent: vi.fn(),
    };

    handleMessage(store, {
      type: 'work_center_response',
      requestId: 'req',
      ok: true,
      data: { items: [{ id: 'item-1' }] },
    });

    expect(resolve).toHaveBeenCalledWith({ items: [{ id: 'item-1' }] });
    expect(store.workCenterPending.req).toBeUndefined();
  });

  it('rejects failed responses and applies Agent-stamped events', () => {
    const reject = vi.fn();
    const timer = setTimeout(() => {}, 10_000);
    const applyWorkCenterEvent = vi.fn();
    const store = {
      _lastPongAt: 0,
      workCenterPending: { req: { resolve: vi.fn(), reject, timer } },
      applyWorkCenterEvent,
    };

    handleMessage(store, {
      type: 'work_center_response', requestId: 'req', ok: false, error: 'offline',
    });
    expect(reject.mock.calls[0][0]).toMatchObject({ message: 'offline' });

    handleMessage(store, {
      type: 'work_center_event', agentId: 'agent-a', event: { type: 'run.finished' },
    });
    expect(applyWorkCenterEvent).toHaveBeenCalledWith('agent-a', { type: 'run.finished' });
  });
});
