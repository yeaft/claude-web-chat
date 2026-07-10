import { describe, expect, it, vi } from 'vitest';
import { applyLlmConfigUpdate } from '../../agent/connection/message-router.js';

function dependencies(overrides = {}) {
  return {
    updateLlmConfig: vi.fn(() => ({ primaryModel: 'github-copilot/gpt-new', language: 'en' })),
    broadcastLanguageChange: vi.fn(),
    forceRefreshYeaftStatus: vi.fn(async () => ({ refreshError: null })),
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
    expect(deps.forceRefreshYeaftStatus).toHaveBeenCalledTimes(1);
    expect(deps.sendToServer).toHaveBeenCalledTimes(1);
    expect(response).toMatchObject({
      type: 'llm_config_updated',
      primaryModel: 'github-copilot/gpt-new',
      statusRefreshError: null,
    });
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
