import { describe, expect, it, vi } from 'vitest';
import { applyLlmConfigUpdate } from '../../agent/connection/message-router.js';

function dependencies(overrides = {}) {
  return {
    updateLlmConfig: vi.fn(() => ({ primaryModel: 'github-copilot/gpt-new', language: 'en' })),
    broadcastLanguageChange: vi.fn(),
    forceRefreshYeaftStatus: vi.fn(async () => ({ refreshError: null })),
    refreshLiveSessionConfig: vi.fn(async () => ({ model: 'github-copilot/gpt-new' })),
    sendToServer: vi.fn(),
    yeaftDir: '/tmp/yeaft-test',
    ...overrides,
  };
}

describe('LLM config update', () => {
  it('writes once, refreshes the model cache once, and sends one acknowledgement without resetting runtime', async () => {
    const deps = dependencies();

    const response = await applyLlmConfigUpdate({
      type: 'update_llm_config',
      config: { primaryModel: 'github-copilot/gpt-new' },
    }, deps);

    expect(deps.updateLlmConfig).toHaveBeenCalledTimes(1);
    expect(deps.refreshLiveSessionConfig).toHaveBeenCalledTimes(1);
    expect(deps.forceRefreshYeaftStatus).toHaveBeenCalledTimes(1);
    expect(deps.sendToServer).toHaveBeenCalledTimes(1);
    expect(response).toMatchObject({
      type: 'llm_config_updated',
      primaryModel: 'github-copilot/gpt-new',
      statusRefreshError: null,
    });
  });

  it('waits for the live runtime refresh before publishing status and acknowledging', async () => {
    let releaseRuntime;
    const runtimeRefresh = new Promise(resolve => { releaseRuntime = resolve; });
    const order = [];
    const deps = dependencies({
      refreshLiveSessionConfig: vi.fn(async () => {
        order.push('runtime-start');
        await runtimeRefresh;
        order.push('runtime-done');
        return { model: 'github-copilot/gpt-new' };
      }),
      forceRefreshYeaftStatus: vi.fn(async () => {
        order.push('status');
        return { refreshError: null };
      }),
      sendToServer: vi.fn(() => order.push('ack')),
    });

    const pending = applyLlmConfigUpdate({ config: { primaryModel: 'github-copilot/gpt-new' } }, deps);
    await Promise.resolve();
    expect(order).toEqual(['runtime-start']);
    releaseRuntime();
    await pending;

    expect(order).toEqual(['runtime-start', 'runtime-done', 'status', 'ack']);
  });

  it('still acknowledges the saved config when the forced status refresh fails', async () => {
    const deps = dependencies({
      forceRefreshYeaftStatus: vi.fn(async () => { throw new Error('disk read failed'); }),
    });

    const response = await applyLlmConfigUpdate({
      type: 'update_llm_config',
      config: { primaryModel: 'github-copilot/gpt-new' },
    }, deps);

    expect(response.statusRefreshError).toBe('disk read failed');
    expect(response.error).toBeUndefined();
    expect(deps.sendToServer).toHaveBeenCalledWith(response);
  });
});
