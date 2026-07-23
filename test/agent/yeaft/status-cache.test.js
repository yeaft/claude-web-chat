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
  it('keeps config refresh authoritative when Session hydration races it', async () => {
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
        model: 'github-copilot/gpt-stale',
        availableModels: [{ id: 'gpt-stale', provider: 'github-copilot' }],
      },
      status: {},
    });

    pendingLoad.resolve({
      primaryModel: 'github-copilot/gpt-current',
      availableModels: [{ id: 'gpt-current', provider: 'github-copilot' }],
    });
    await refresh;

    expect(cache.current()).toMatchObject({
      model: 'github-copilot/gpt-current',
      availableModels: [{ id: 'gpt-current', provider: 'github-copilot' }],
      refreshReason: 'interval',
    });
    expect(emit).toHaveBeenCalledTimes(2);
    expect(emit.mock.calls.at(-1)[0].availableModels).toEqual([
      expect.objectContaining({ id: 'gpt-current' }),
    ]);
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

  it('does not let Session hydration cancel a forced config refresh while an older read drains', async () => {
    const oldLoad = deferred();
    const freshLoad = deferred();
    const loadConfig = vi.fn()
      .mockReturnValueOnce(oldLoad.promise)
      .mockReturnValueOnce(freshLoad.promise);
    const emit = vi.fn();
    const cache = createYeaftStatusCache({ loadConfig, emit, now: () => 155 });

    const oldRefresh = cache.refresh({ reason: 'interval', emitRefreshing: false });
    await Promise.resolve();
    const forcedRefresh = cache.forceRefresh({ reason: 'llm_config_updated' });
    cache.hydrateFromSession({
      config: {
        model: 'github-copilot/gpt-default',
        availableModels: [{ id: 'gpt-default', provider: 'github-copilot' }],
      },
      status: {},
    });

    oldLoad.resolve({
      primaryModel: 'github-copilot/gpt-old',
      availableModels: [{ id: 'gpt-old', provider: 'github-copilot' }],
    });
    await oldRefresh;
    freshLoad.resolve({
      primaryModel: 'github-copilot/gpt-new',
      availableModels: [{ id: 'gpt-new', provider: 'github-copilot' }],
    });
    await forcedRefresh;

    expect(loadConfig).toHaveBeenCalledTimes(2);
    expect(cache.current()).toMatchObject({
      model: 'github-copilot/gpt-new',
      availableModels: [{ id: 'gpt-new', provider: 'github-copilot' }],
      refreshReason: 'llm_config_updated',
    });
  });

  it('does not let Session hydration cancel a forced config refresh', async () => {
    const freshLoad = deferred();
    const loadConfig = vi.fn(() => freshLoad.promise);
    const emit = vi.fn();
    const cache = createYeaftStatusCache({ loadConfig, emit, now: () => 160 });

    const forcedRefresh = cache.forceRefresh({ reason: 'llm_config_updated' });
    await Promise.resolve();

    cache.hydrateFromSession({
      config: {
        model: 'github-copilot/gpt-default',
        availableModels: [{ id: 'gpt-default', provider: 'github-copilot' }],
      },
      status: {},
    });

    freshLoad.resolve({
      primaryModel: 'github-copilot/gpt-new',
      availableModels: [{ id: 'gpt-new', provider: 'github-copilot' }],
    });
    await forcedRefresh;

    expect(cache.current()).toMatchObject({
      model: 'github-copilot/gpt-new',
      availableModels: [{ id: 'gpt-new', provider: 'github-copilot' }],
      refreshReason: 'llm_config_updated',
    });
    expect(emit.mock.calls.at(-1)[0].availableModels).toEqual([
      expect.objectContaining({ id: 'gpt-new' }),
    ]);
  });

  it('serializes overlapping forced refreshes without letting hydration cancel the newest read', async () => {
    const firstLoad = deferred();
    const secondLoad = deferred();
    const loadConfig = vi.fn()
      .mockReturnValueOnce(firstLoad.promise)
      .mockReturnValueOnce(secondLoad.promise);
    const cache = createYeaftStatusCache({ loadConfig, emit: vi.fn(), now: () => 170 });

    const firstForce = cache.forceRefresh({ reason: 'save-one' });
    const secondForce = cache.forceRefresh({ reason: 'save-two' });
    await Promise.resolve();
    firstLoad.resolve({
      primaryModel: 'github-copilot/gpt-one',
      availableModels: [{ id: 'gpt-one', provider: 'github-copilot' }],
    });
    await firstForce;
    cache.hydrateFromSession({
      config: {
        model: 'github-copilot/gpt-stale',
        availableModels: [{ id: 'gpt-stale', provider: 'github-copilot' }],
      },
      status: {},
    });
    await Promise.resolve();
    secondLoad.resolve({
      primaryModel: 'github-copilot/gpt-two',
      availableModels: [{ id: 'gpt-two', provider: 'github-copilot' }],
    });
    await secondForce;

    expect(loadConfig).toHaveBeenCalledTimes(2);
    expect(cache.current()).toMatchObject({
      model: 'github-copilot/gpt-two',
      availableModels: [{ id: 'gpt-two', provider: 'github-copilot' }],
      refreshReason: 'save-two',
      catalogRevision: 2,
    });
  });

  it('assigns monotonic revisions to changed catalogs even when the clock is fixed', async () => {
    const loadConfig = vi.fn()
      .mockResolvedValueOnce({
        primaryModel: 'github-copilot/gpt-one',
        availableModels: [{ id: 'gpt-one', provider: 'github-copilot' }],
      })
      .mockResolvedValueOnce({
        primaryModel: 'github-copilot/gpt-two',
        availableModels: [{ id: 'gpt-two', provider: 'github-copilot' }],
      })
      .mockResolvedValueOnce({
        primaryModel: 'github-copilot/gpt-two',
        availableModels: [{ id: 'gpt-two', provider: 'github-copilot' }],
      });
    const cache = createYeaftStatusCache({ loadConfig, emit: vi.fn(), now: () => 200 });

    const first = await cache.forceRefresh({ reason: 'one' });
    const second = await cache.forceRefresh({ reason: 'two' });
    const unchanged = await cache.forceRefresh({ reason: 'same' });

    expect(first.catalogRevision).toBe(1);
    expect(second.catalogRevision).toBe(2);
    expect(second.catalogDigest).not.toBe(first.catalogDigest);
    expect(unchanged.catalogRevision).toBe(2);
    expect(unchanged.catalogDigest).toBe(second.catalogDigest);
  });

  it('keeps the config catalog timestamp stable during Session hydration', async () => {
    let time = 200;
    const cache = createYeaftStatusCache({
      loadConfig: async () => ({
        primaryModel: 'github-copilot/gpt-current',
        availableModels: [{ id: 'gpt-current', provider: 'github-copilot' }],
      }),
      emit: vi.fn(),
      now: () => time,
    });
    await cache.refresh({ reason: 'startup', emitRefreshing: false });

    time = 300;
    const event = cache.hydrateFromSession({
      config: {
        model: 'github-copilot/gpt-current',
        availableModels: [{ id: 'gpt-current', provider: 'github-copilot' }],
      },
      status: {},
    });

    expect(event.refreshedAt).toBe(300);
    expect(event.catalogRefreshedAt).toBe(200);
    expect(event.refreshReason).toBe('session_ready');
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

  it('preserves the last refresh error during Session hydration and clears it after success', async () => {
    const loadConfig = vi.fn()
      .mockResolvedValueOnce({
        primaryModel: 'github-copilot/gpt-current',
        availableModels: [{ id: 'gpt-current', provider: 'github-copilot' }],
      })
      .mockRejectedValueOnce(new Error('disk read failed'))
      .mockResolvedValueOnce({
        primaryModel: 'github-copilot/gpt-current',
        availableModels: [{ id: 'gpt-current', provider: 'github-copilot' }],
      });
    const cache = createYeaftStatusCache({ loadConfig, emit: vi.fn(), now: () => 190 });
    await cache.forceRefresh({ reason: 'startup' });
    await cache.forceRefresh({ reason: 'failed-save' });

    const hydrated = cache.hydrateFromSession({ config: {}, status: {} });
    expect(hydrated.refreshError).toBe('disk read failed');
    expect(hydrated.availableModels).toEqual([expect.objectContaining({ id: 'gpt-current' })]);

    const recovered = await cache.forceRefresh({ reason: 'recovered' });
    expect(recovered.refreshError).toBeNull();
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
