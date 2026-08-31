// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as Vue from 'vue';

const stores = new Map();
function defineStore(id, options) {
  return () => {
    if (stores.has(id)) return stores.get(id);
    const store = Vue.reactive({ ...(options.state?.() || {}) });
    for (const [name, action] of Object.entries(options.actions || {})) store[name] = action.bind(store);
    stores.set(id, store);
    return store;
  };
}
globalThis.Pinia = { ...(globalThis.Pinia || {}), defineStore, useSessionsStore: () => ({}) };

const { useChatStore } = await import('../../web/stores/chat.js');
const { handleMessage } = await import('../../web/stores/helpers/messageHandler.js');

function freshStore() {
  stores.clear();
  const store = useChatStore();
  store.agents = [
    { id: 'agent-a', online: true, version: '1.0.0', dreamEnabled: true },
    { id: 'agent-b', online: true, version: '1.0.0', dreamEnabled: false },
  ];
  store.currentAgent = 'agent-a';
  store.sendWsMessage = vi.fn();
  return store;
}

describe('Agent-scoped settings lifecycle', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
  });

  it('correlates telemetry calls, times them out, and ignores stale replies', async () => {
    const store = freshStore();
    const first = store.loadTelemetrySettings('agent-a');
    const firstRequest = store.sendWsMessage.mock.calls[0][0];
    const second = store.loadTelemetrySettings('agent-a');
    const secondRequest = store.sendWsMessage.mock.calls[1][0];
    expect(firstRequest.requestId).toBeTruthy();
    expect(secondRequest.requestId).not.toBe(firstRequest.requestId);

    handleMessage(store, { type: 'telemetry_settings', agentId: 'agent-a', requestId: secondRequest.requestId, enabled: false });
    await expect(second).resolves.toMatchObject({ enabled: false });
    expect(store.telemetrySettingsByAgent['agent-a']).toMatchObject({ enabled: false });

    handleMessage(store, { type: 'telemetry_settings', agentId: 'agent-a', requestId: firstRequest.requestId, enabled: true });
    await expect(first).resolves.toMatchObject({ enabled: true });
    expect(store.telemetrySettingsByAgent['agent-a']).toMatchObject({ enabled: false });

    const timedOut = store.updateTelemetrySettings({ enabled: true }, 'agent-b');
    const timeoutExpectation = expect(timedOut).rejects.toThrow(/timed out/i);
    await vi.advanceTimersByTimeAsync(15001);
    await timeoutExpectation;
    expect(Object.keys(store._telemetryPending)).toHaveLength(0);
  });

  it('does not settle concurrent browser mutations from identity-less legacy replies', async () => {
    const firstBrowser = freshStore();
    const firstUpdate = firstBrowser.updateTelemetrySettings({ enabled: false }, 'agent-a');
    const firstRequestId = firstBrowser.sendWsMessage.mock.calls.at(-1)[0].requestId;

    const secondBrowser = freshStore();
    const secondUpdate = secondBrowser.updateTelemetrySettings({ enabled: true }, 'agent-a');
    const secondRequestId = secondBrowser.sendWsMessage.mock.calls.at(-1)[0].requestId;

    const legacyReply = { type: 'telemetry_settings_updated', agentId: 'agent-a', enabled: false };
    handleMessage(firstBrowser, legacyReply);
    handleMessage(secondBrowser, legacyReply);
    expect(Object.keys(firstBrowser._telemetryPending)).toEqual([firstRequestId]);
    expect(Object.keys(secondBrowser._telemetryPending)).toEqual([secondRequestId]);

    handleMessage(firstBrowser, { ...legacyReply, requestId: firstRequestId });
    handleMessage(secondBrowser, { ...legacyReply, requestId: secondRequestId, enabled: true });
    await expect(firstUpdate).resolves.toMatchObject({ enabled: false });
    await expect(secondUpdate).resolves.toMatchObject({ enabled: true });
  });

  it('settles a sole legacy telemetry request while fencing concurrent browser requests', async () => {
    const soleBrowser = freshStore();
    const soleUpdate = soleBrowser.updateTelemetrySettings({ enabled: false }, 'agent-a');
    handleMessage(soleBrowser, { type: 'telemetry_settings_updated', agentId: 'agent-a', enabled: false });
    await expect(soleUpdate).resolves.toMatchObject({ enabled: false });

    const firstBrowser = freshStore();
    const firstUpdate = firstBrowser.updateTelemetrySettings({ enabled: false }, 'agent-a');
    const secondBrowser = freshStore();
    const secondUpdate = secondBrowser.updateTelemetrySettings({ enabled: true }, 'agent-a');
    const legacyReply = { type: 'telemetry_settings_updated', agentId: 'agent-a', enabled: false };
    handleMessage(firstBrowser, legacyReply);
    handleMessage(secondBrowser, legacyReply);
    expect(Object.keys(firstBrowser._telemetryPending)).toHaveLength(1);
    expect(Object.keys(secondBrowser._telemetryPending)).toHaveLength(1);

    const firstTimeout = expect(firstUpdate).rejects.toThrow(/timed out/i);
    const secondTimeout = expect(secondUpdate).rejects.toThrow(/timed out/i);
    await vi.advanceTimersByTimeAsync(15001);
    await firstTimeout;
    await secondTimeout;
  });

  it('keeps restart and upgrade lifecycle in shared Agent-scoped state and fences duplicates', () => {
    const store = freshStore();
    expect(store.restartAgent('agent-a')).toBe(true);
    expect(store.restartAgent('agent-a')).toBe(false);
    expect(store.sendWsMessage).toHaveBeenCalledTimes(1);
    expect(store.agentOperations['agent-a'].restart.pending).toBe(true);

    const restartRequestId = store.agentOperations['agent-a'].restart.requestId;
    handleMessage(store, { type: 'restart_agent_ack', agentId: 'agent-a', requestId: 'stale-restart' });
    expect(store.agentOperations['agent-a'].restart.acknowledged).toBe(false);
    handleMessage(store, { type: 'restart_agent_ack', agentId: 'agent-a' });
    expect(store.agentOperations['agent-a'].restart.acknowledged).toBe(true);
    handleMessage(store, { type: 'agent_list', agents: [{ id: 'agent-a', online: true, version: '1.0.0' }] });
    expect(store.agentOperations['agent-a'].restart.pending).toBe(true);
    handleMessage(store, { type: 'agent_list', agents: [{ id: 'agent-a', online: false, version: '1.0.0' }] });
    expect(store.agentOperations['agent-a'].restart.pending).toBe(true);
    handleMessage(store, { type: 'agent_list', agents: [{ id: 'agent-a', online: true, version: '1.0.0' }] });
    expect(store.agentOperations['agent-a'].restart.pending).toBe(false);

    expect(store.upgradeAgent('agent-a')).toBe(true);
    expect(store.upgradeAgent('agent-a')).toBe(false);
    const upgradeRequestId = store.agentOperations['agent-a'].upgrade.requestId;
    handleMessage(store, { type: 'upgrade_agent_ack', agentId: 'agent-a', requestId: 'stale-upgrade', success: false, error: 'stale' });
    expect(store.agentOperations['agent-a'].upgrade).toMatchObject({ pending: true, error: null });
    handleMessage(store, { type: 'upgrade_agent_ack', agentId: 'agent-a', success: false, error: 'nope' });
    expect(store.agentOperations['agent-a'].upgrade).toMatchObject({ pending: false, error: 'nope' });
  });

  it('uses authoritative Dream state on failure and rejects rapid toggles', async () => {
    const store = freshStore();
    expect(store.setDreamEnabled('agent-a', false)).toBe(true);
    expect(store.setDreamEnabled('agent-a', true)).toBe(false);
    expect(store.agentDreamState['agent-a']).toMatchObject({ pending: true, requested: false });
    expect(store.agents[0].dreamEnabled).toBe(true);
    const failedRequestId = store.agentDreamState['agent-a'].requestId;

    handleMessage(store, { type: 'dream_enabled_changed', agentId: 'agent-a', requestId: 'stale-dream', enabled: false });
    expect(store.agentDreamState['agent-a']).toMatchObject({ pending: true, error: null });
    handleMessage(store, { type: 'dream_enabled_changed', agentId: 'agent-a', requestId: failedRequestId, enabled: true, error: 'write failed' });
    expect(store.agentDreamState['agent-a']).toMatchObject({ pending: false, error: 'write failed' });
    expect(store.agents[0].dreamEnabled).toBe(true);

    expect(store.setDreamEnabled('agent-a', false)).toBe(true);
    handleMessage(store, { type: 'dream_enabled_changed', agentId: 'agent-a', requestId: 'stale-dream-2', enabled: false });
    expect(store.agentDreamState['agent-a']).toMatchObject({ pending: true, requested: false });
    expect(store.agents[0].dreamEnabled).toBe(true);
    handleMessage(store, { type: 'dream_enabled_changed', agentId: 'agent-a', enabled: false });
    expect(store.agentDreamState['agent-a']).toMatchObject({ pending: false, error: null });
    expect(store.agents[0].dreamEnabled).toBe(false);

    expect(store.setDreamEnabled('agent-a', true)).toBe(true);
    await vi.advanceTimersByTimeAsync(15001);
    expect(store.agentDreamState['agent-a']).toMatchObject({ pending: false, error: 'timeout' });
    handleMessage(store, { type: 'dream_enabled_changed', agentId: 'agent-a', enabled: true });
    expect(store.agents[0].dreamEnabled).toBe(false);
  });
});
