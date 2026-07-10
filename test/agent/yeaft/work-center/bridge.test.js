import { beforeEach, describe, expect, it, vi } from 'vitest';

const sendToServer = vi.fn();
const ensureSessionLoaded = vi.fn();
const resetYeaftSession = vi.fn();
vi.mock('../../../../agent/connection/buffer.js', () => ({ sendToServer }));
vi.mock('../../../../agent/yeaft/web-bridge.js', () => ({
  ensureSessionLoaded,
  resetYeaftSession,
}));

const {
  bootWorkCenter,
  handleWorkCenterRequest,
  shutdownWorkCenter,
  __testSetWorkCenterFactory,
  __testSetWorkCenterService,
} = await import('../../../../agent/yeaft/work-center/bridge.js');

function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}

describe('Work Center lifecycle bridge', () => {
  beforeEach(() => {
    sendToServer.mockClear();
    ensureSessionLoaded.mockReset();
    resetYeaftSession.mockReset();
    resetYeaftSession.mockResolvedValue(undefined);
    __testSetWorkCenterService(null);
    __testSetWorkCenterFactory(null);
  });

  it('boots the autonomous watcher exactly once', async () => {
    const service = { start: vi.fn(), shutdown: vi.fn() };
    const factory = vi.fn().mockResolvedValue(service);
    __testSetWorkCenterFactory(factory);
    const [first, second] = await Promise.all([bootWorkCenter(), bootWorkCenter()]);
    expect(first).toBe(service);
    expect(second).toBe(service);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(service.start).toHaveBeenCalledTimes(1);
    await shutdownWorkCenter();
    expect(service.shutdown).toHaveBeenCalledTimes(1);
  });

  it('routes settings operations through the existing response envelope', async () => {
    const service = {
      start: vi.fn(),
      shutdown: vi.fn(),
      handle: vi.fn().mockResolvedValue({ settings: { defaultWorkflowId: 'software-change' } }),
    };
    __testSetWorkCenterService(service);
    await handleWorkCenterRequest({
      requestId: 'settings-1', op: 'get_settings', payload: {}, _requestUserId: 'user-1',
    });
    expect(service.handle).toHaveBeenCalledWith('get_settings', {});
    expect(sendToServer).toHaveBeenCalledWith(expect.objectContaining({
      type: 'work_center_response', requestId: 'settings-1', op: 'get_settings', ok: true,
      data: { settings: { defaultWorkflowId: 'software-change' } }, _requestUserId: 'user-1',
    }));
  });

  it('waits for runtime reset before returning refreshed settings', async () => {
    const gate = deferred();
    resetYeaftSession.mockReturnValue(gate.promise);
    const fresh = {
      settings: { defaultWorkflowId: 'software-change' },
      runtime: { primaryModel: 'new-provider/new-model' },
    };
    const service = {
      start: vi.fn(),
      shutdown: vi.fn(),
      handle: vi.fn().mockResolvedValue(fresh),
    };
    __testSetWorkCenterService(service);

    const request = handleWorkCenterRequest({
      requestId: 'refresh-1', op: 'refresh_runtime', payload: {}, _requestUserId: 'user-1',
    });
    await Promise.resolve();
    expect(resetYeaftSession).toHaveBeenCalledTimes(1);
    expect(service.handle).not.toHaveBeenCalled();
    expect(sendToServer).not.toHaveBeenCalled();

    gate.resolve();
    await request;
    expect(service.handle).toHaveBeenCalledWith('get_settings', {});
    expect(sendToServer).toHaveBeenCalledWith(expect.objectContaining({
      type: 'work_center_response', requestId: 'refresh-1', op: 'refresh_runtime', ok: true,
      data: fresh, _requestUserId: 'user-1',
    }));
  });

  it('does not leave a watcher alive when shutdown races initialization', async () => {
    const gate = deferred();
    const service = { start: vi.fn(), shutdown: vi.fn() };
    __testSetWorkCenterFactory(() => gate.promise);
    const boot = bootWorkCenter();
    const shutdown = shutdownWorkCenter();
    gate.resolve(service);
    await expect(boot).rejects.toThrow(/shut down/i);
    await shutdown;
    expect(service.start).not.toHaveBeenCalled();
    expect(service.shutdown).toHaveBeenCalledTimes(1);
  });
});
