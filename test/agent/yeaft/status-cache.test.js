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

  it('keeps config refresh authoritative when Session hydration races it', async () => {
    const pendingLoad = deferred();
    const cache = createYeaftStatusCache({
      loadConfig: () => pendingLoad.promise,
      emit: vi.fn(),
      now: () => 125,
    });

    const refresh = cache.forceRefresh({ reason: 'llm_config_updated' });
    cache.hydrateFromSession({
      config: {
        model: 'github-copilot/gpt-old',
        availableModels: [{ id: 'gpt-old', provider: 'github-copilot' }],
      },
      status: {},
    });
    pendingLoad.resolve({
      primaryModel: 'github-copilot/gpt-new',
      availableModels: [{ id: 'gpt-new', provider: 'github-copilot' }],
    });
    await refresh;

    expect(cache.current()).toMatchObject({
      model: 'github-copilot/gpt-new',
      availableModels: [{ id: 'gpt-new', provider: 'github-copilot' }],
      refreshReason: 'llm_config_updated',
    });
  });

  it('forces a fresh disk read after an older refresh drains', async () => {
    const oldLoad = deferred();
    const loadConfig = vi.fn()
      .mockReturnValueOnce(oldLoad.promise)
      .mockResolvedValueOnce({
        primaryModel: 'github-copilot/gpt-new',
        availableModels: [{ id: 'gpt-new', provider: 'github-copilot' }],
      });
    const emit = vi.fn();
    const cache = createYeaftStatusCache({ loadConfig, emit, now: () => 150 });

    const oldRefresh = cache.refresh({ reason: 'interval', emitRefreshing: false });
    await Promise.resolve();
    const forcedRefresh = cache.forceRefresh({ reason: 'llm_config_updated' });

    oldLoad.resolve({
      primaryModel: 'github-copilot/gpt-old',
      availableModels: [{ id: 'gpt-old', provider: 'github-copilot' }],
    });
    await Promise.all([oldRefresh, forcedRefresh]);

    expect(loadConfig).toHaveBeenCalledTimes(2);
    expect(cache.current()).toMatchObject({
      model: 'github-copilot/gpt-new',
      availableModels: [{ id: 'gpt-new', provider: 'github-copilot' }],
      refreshReason: 'llm_config_updated',
    });
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it('serializes concurrent forced refreshes instead of collapsing the newer save', async () => {
    const firstLoad = deferred();
    const loadConfig = vi.fn()
      .mockReturnValueOnce(firstLoad.promise)
      .mockResolvedValueOnce({
        primaryModel: 'github-copilot/gpt-second',
        availableModels: [{ id: 'gpt-second', provider: 'github-copilot' }],
      });
    const cache = createYeaftStatusCache({ loadConfig, emit: vi.fn(), now: () => 160 });

    const first = cache.forceRefresh({ reason: 'llm_config_updated' });
    const second = cache.forceRefresh({ reason: 'llm_config_updated' });
    firstLoad.resolve({
      primaryModel: 'github-copilot/gpt-first',
      availableModels: [{ id: 'gpt-first', provider: 'github-copilot' }],
    });
    await Promise.all([first, second]);

    expect(loadConfig).toHaveBeenCalledTimes(2);
    expect(cache.current()).toMatchObject({
      model: 'github-copilot/gpt-second',
      availableModels: [{ id: 'gpt-second', provider: 'github-copilot' }],
    });
  });

  it('returns an error event from a forced refresh without discarding the last good snapshot', async () => {
    const loadConfig = vi.fn()
      .mockResolvedValueOnce({
        primaryModel: 'github-copilot/gpt-current',
        availableModels: [{ id: 'gpt-current', provider: 'github-copilot' }],
      })
      .mockRejectedValueOnce(new Error('disk read failed'));
    const cache = createYeaftStatusCache({ loadConfig, emit: vi.fn(), now: () => 175 });
    await cache.refresh({ reason: 'startup', emitRefreshing: false });

    const event = await cache.forceRefresh({ reason: 'llm_config_updated' });

    expect(event.refreshError).toBe('disk read failed');
    expect(cache.current().availableModels).toEqual([
      expect.objectContaining({ id: 'gpt-current' }),
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
