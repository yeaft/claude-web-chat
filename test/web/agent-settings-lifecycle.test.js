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
  beforeEach(() => vi.useFakeTimers());

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

  it('keeps restart and upgrade lifecycle in shared Agent-scoped state and fences duplicates', () => {
    const store = freshStore();
    expect(store.restartAgent('agent-a')).toBe(true);
    expect(store.restartAgent('agent-a')).toBe(false);
    expect(store.sendWsMessage).toHaveBeenCalledTimes(1);
    expect(store.agentOperations['agent-a'].restart.pending).toBe(true);

    const restartRequestId = store.agentOperations['agent-a'].restart.requestId;
    handleMessage(store, { type: 'restart_agent_ack', agentId: 'agent-a', requestId: 'stale-restart' });
    expect(store.agentOperations['agent-a'].restart.acknowledged).toBe(false);
    handleMessage(store, { type: 'restart_agent_ack', agentId: 'agent-a', requestId: restartRequestId });
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
    handleMessage(store, { type: 'upgrade_agent_ack', agentId: 'agent-a', requestId: upgradeRequestId, success: false, error: 'nope' });
    expect(store.agentOperations['agent-a'].upgrade).toMatchObject({ pending: false, error: 'nope' });
  });

  it('uses authoritative Dream state on failure and rejects rapid toggles', () => {
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
    const successRequestId = store.agentDreamState['agent-a'].requestId;
    handleMessage(store, { type: 'dream_enabled_changed', agentId: 'agent-a', requestId: successRequestId, enabled: false });
    expect(store.agentDreamState['agent-a']).toMatchObject({ pending: false, error: null });
    expect(store.agents[0].dreamEnabled).toBe(false);
  });
});
