import { beforeEach, describe, expect, it, vi } from 'vitest';

const { upsert, touch, updateMetrics, getAll } = vi.hoisted(() => ({
  upsert: vi.fn(),
  touch: vi.fn(),
  updateMetrics: vi.fn(),
  getAll: vi.fn(),
}));

const stmts = {
  upsertAgentInventory: { run: upsert },
  touchAgentInventory: { run: touch },
  updateAgentInventoryMetrics: { run: updateMetrics },
  getAllAgentInventory: { all: getAll },
};

vi.mock('../../server/db/connection.js', () => ({ stmts }));

const { agentInventoryDb } = await import('../../server/db/agent-inventory-db.js');

describe('durable Agent inventory', () => {
  beforeEach(() => {
    upsert.mockReset();
    touch.mockReset();
    touch.mockReturnValue({ changes: 1 });
    updateMetrics.mockReset();
    updateMetrics.mockReturnValue({ changes: 1 });
    getAll.mockReset();
  });

  it('serializes connection metadata without persisting liveness', () => {
    expect(agentInventoryDb.upsert({
      id: 'owner-1:agent-1',
      instanceId: 'agent-1',
      ownerId: 'owner-1',
      name: 'Agent One',
      workDir: '/workspace',
      version: '1.0.446',
      platform: 'linux',
      capabilities: ['terminal', 'browser_runtime'],
      capabilityMetadataProvided: true,
      metrics: { totalTurns: 3 },
      metricsUpdatedAt: 120,
      lastSeenAt: 100,
      lastConnectedAt: 90,
      updatedAt: 110,
    })).toBe(true);

    expect(upsert).toHaveBeenCalledWith(
      'owner-1:agent-1',
      'agent-1',
      'owner-1',
      'Agent One',
      '/workspace',
      '1.0.446',
      'linux',
      '["terminal","browser_runtime"]',
      1,
      '{"totalTurns":3}',
      120,
      100,
      90,
      110,
    );
  });

  it('does not overwrite durable metrics when a reconnect has no metric snapshot', () => {
    expect(agentInventoryDb.upsert({
      id: 'agent-1',
      name: 'Agent',
      capabilities: ['terminal'],
    })).toBe(true);
    expect(upsert).toHaveBeenCalledWith(
      'agent-1', null, null, 'Agent', '', null, null, '["terminal"]', 0,
      null, null, expect.any(Number), expect.any(Number), expect.any(Number),
    );
  });

  it('maps malformed persisted JSON to safe defaults', () => {
    getAll.mockReturnValue([{
      id: 'agent-1',
      instance_id: null,
      owner_id: null,
      name: 'Agent',
      work_dir: '',
      version: null,
      platform: null,
      capabilities_json: '{bad',
      capability_metadata_provided: 0,
      metrics_json: '[]',
      metrics_updated_at: null,
      last_seen_at: 100,
      last_connected_at: 90,
      updated_at: 100,
    }]);

    expect(agentInventoryDb.getAll()).toEqual([expect.objectContaining({
      id: 'agent-1',
      capabilities: [],
      metrics: {},
      lastSeenAt: 100,
    })]);
  });

  it('touches only the durable last-seen timestamp', () => {
    expect(agentInventoryDb.touch('agent-1', 250)).toBe(true);
    expect(touch).toHaveBeenCalledWith(250, 250, 'agent-1');
  });

  it('persists metrics without changing the durable connection identity', () => {
    expect(agentInventoryDb.updateMetrics('agent-1', { totalTurns: 7 }, 300)).toBe(true);
    expect(updateMetrics).toHaveBeenCalledWith('{"totalTurns":7}', 300, 300, 'agent-1');
  });
});
