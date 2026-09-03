import { describe, expect, it, vi } from 'vitest';
import { useMockAgent, useTestServer } from '../e2e/fixtures/test-server.js';

describe('E2E fixture setup lifecycle', () => {
  it('stops a server when startup rejects after allocating its resource', async () => {
    const startupError = new Error('startup failed after spawn');
    const server = {
      start: vi.fn(async () => { throw startupError; }),
      stop: vi.fn(async () => {}),
    };
    const use = vi.fn();

    await expect(useTestServer(server, use)).rejects.toBe(startupError);

    expect(use).not.toHaveBeenCalled();
    expect(server.stop).toHaveBeenCalledOnce();
  });

  it('disconnects an agent when connect rejects after opening its socket', async () => {
    const connectError = new Error('connect failed after socket open');
    const agent = {
      connect: vi.fn(async () => { throw connectError; }),
      disconnect: vi.fn(async () => {}),
    };
    const use = vi.fn();

    await expect(useMockAgent(agent, use)).rejects.toBe(connectError);

    expect(use).not.toHaveBeenCalled();
    expect(agent.disconnect).toHaveBeenCalledOnce();
  });
});
