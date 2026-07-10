import { describe, expect, it, vi } from 'vitest';

globalThis.localStorage = globalThis.localStorage || {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
};
globalThis.Pinia = globalThis.Pinia || {};
globalThis.Pinia.defineStore = (_id, options) => () => ({
  ...(options.state ? options.state() : {}),
  ...(options.actions || {}),
});
globalThis.window = globalThis.window || globalThis;
globalThis.window.Pinia = globalThis.Pinia;

const { useChatStore } = await import('../../../web/stores/chat.js');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('Work Center settings request ordering', () => {
  it('ignores an older settings response that arrives after the latest request', async () => {
    const store = useChatStore();
    const older = deferred();
    const latest = deferred();
    store.workCenterRequest = vi.fn()
      .mockReturnValueOnce(older.promise)
      .mockReturnValueOnce(latest.promise);

    const olderLoad = store.loadWorkCenterSettings('agent-a');
    const latestLoad = store.loadWorkCenterSettings('agent-a');
    latest.resolve({ settings: { revision: 2, marker: 'latest' }, runtime: { marker: 'latest' } });
    await latestLoad;

    expect(store.workCenterSettingsByAgent['agent-a']).toMatchObject({ marker: 'latest' });
    expect(store.workCenterRuntimeByAgent['agent-a']).toMatchObject({ marker: 'latest' });
    expect(store.workCenterSettingsLoadingByAgent['agent-a']).toBe(false);

    older.resolve({ settings: { revision: 1, marker: 'older' }, runtime: { marker: 'older' } });
    await olderLoad;
    expect(store.workCenterSettingsByAgent['agent-a']).toMatchObject({ marker: 'latest' });
    expect(store.workCenterRuntimeByAgent['agent-a']).toMatchObject({ marker: 'latest' });
    expect(store.workCenterSettingsLoadingByAgent['agent-a']).toBe(false);
  });
});
