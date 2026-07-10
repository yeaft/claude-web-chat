import { describe, expect, it, vi } from 'vitest';
import { createYeaftStatusCache } from '../../../agent/yeaft/status-cache.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe('Yeaft status cache', () => {
  it('does not let an older config refresh overwrite a newer Session hydration', async () => {
    const pendingLoad = deferred();
    const emit = vi.fn();
    const cache = createYeaftStatusCache({
      loadConfig: () => pendingLoad.promise,
      emit,
      now: () => 100,
    });

    const refresh = cache.refresh({ reason: 'interval', emitRefreshing: false });
    await Promise.resolve();

    cache.hydrateFromSession({
      config: {
        model: 'github-copilot/gpt-new',
        availableModels: [{ id: 'gpt-new', provider: 'github-copilot' }],
      },
      status: {},
    });

    pendingLoad.resolve({
      primaryModel: 'github-copilot/gpt-old',
      availableModels: [{ id: 'gpt-old', provider: 'github-copilot' }],
    });
    await refresh;

    expect(cache.current()).toMatchObject({
      model: 'github-copilot/gpt-new',
      availableModels: [{ id: 'gpt-new', provider: 'github-copilot' }],
      refreshReason: 'session_ready',
    });
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit.mock.calls[0][0].availableModels).toEqual([
      expect.objectContaining({ id: 'gpt-new' }),
    ]);
  });

  it('still publishes a normal config refresh when no newer hydration occurs', async () => {
    const emit = vi.fn();
    const cache = createYeaftStatusCache({
      loadConfig: async () => ({
        primaryModel: 'github-copilot/gpt-current',
        availableModels: [{ id: 'gpt-current', provider: 'github-copilot' }],
      }),
      emit,
      now: () => 200,
    });

    await cache.refresh({ reason: 'manual', emitRefreshing: false });

    expect(cache.current()).toMatchObject({
      model: 'github-copilot/gpt-current',
      availableModels: [{ id: 'gpt-current', provider: 'github-copilot' }],
      refreshReason: 'manual',
    });
    expect(emit).toHaveBeenCalledTimes(1);
  });
});
