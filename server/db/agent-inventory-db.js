import { stmts } from './connection.js';

function jsonArray(value) {
  return JSON.stringify(Array.isArray(value) ? value : []);
}

function jsonObject(value) {
  return JSON.stringify(value && typeof value === 'object' && !Array.isArray(value) ? value : {});
}

function parseJson(value, fallback) {
  if (typeof value !== 'string' || !value) return fallback;
  try {
    const parsed = JSON.parse(value);
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
}

function parseCapabilities(value) {
  const parsed = parseJson(value, []);
  return Array.isArray(parsed) ? parsed : [];
}

function parseMetrics(value) {
  const parsed = parseJson(value, {});
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
}

function mapRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    instanceId: row.instance_id || null,
    ownerId: row.owner_id || null,
    name: row.name,
    workDir: row.work_dir || '',
    version: row.version || null,
    platform: row.platform || null,
    capabilities: parseCapabilities(row.capabilities_json),
    capabilityMetadataProvided: row.capability_metadata_provided === 1,
    metrics: parseMetrics(row.metrics_json),
    metricsUpdatedAt: row.metrics_updated_at || null,
    lastSeenAt: row.last_seen_at || null,
    lastConnectedAt: row.last_connected_at || null,
    updatedAt: row.updated_at || null,
  };
}

function validTimestamp(value, fallback = Date.now()) {
  const timestamp = Number(value);
  return Number.isFinite(timestamp) && timestamp > 0 ? timestamp : fallback;
}

/**
 * Durable, admin-only last-known Agent inventory.
 *
 * The inventory never decides whether an Agent is online. That remains a
 * property of the current owner-scoped WebSocket in `context.agents`; these
 * rows only preserve identity and last-seen metadata across disconnects and
 * Server restarts.
 */
export const agentInventoryDb = {
  /**
   * Insert or replace the durable metadata for one Agent connection.
   * @param {{id:string, instanceId?:string|null, ownerId?:string|null, name:string,
   *   workDir?:string, version?:string|null, platform?:string|null,
   *   capabilities?:string[], capabilityMetadataProvided?:boolean,
   *   metrics?:object, metricsUpdatedAt?:number|null, lastSeenAt?:number,
   *   lastConnectedAt?:number, updatedAt?:number}} agent
   */
  upsert(agent) {
    if (!agent?.id || !agent?.name) return false;
    const now = validTimestamp(agent.updatedAt);
    const lastSeenAt = validTimestamp(agent.lastSeenAt, now);
    const lastConnectedAt = validTimestamp(agent.lastConnectedAt, now);
    stmts.upsertAgentInventory.run(
      agent.id,
      agent.instanceId || null,
      agent.ownerId || null,
      agent.name,
      agent.workDir || '',
      agent.version || null,
      agent.platform || null,
      jsonArray(agent.capabilities),
      agent.capabilityMetadataProvided ? 1 : 0,
      agent.metrics == null ? null : jsonObject(agent.metrics),
      agent.metricsUpdatedAt ? validTimestamp(agent.metricsUpdatedAt, now) : null,
      lastSeenAt,
      lastConnectedAt,
      now,
    );
    return true;
  },

  /** Persist only a new last-seen timestamp for a live inventory row. */
  touch(id, lastSeenAt = Date.now()) {
    if (!id) return false;
    const timestamp = validTimestamp(lastSeenAt);
    const result = stmts.touchAgentInventory.run(timestamp, timestamp, id);
    return result.changes > 0;
  },

  /** Persist a cumulative metrics snapshot without changing connection metadata. */
  updateMetrics(id, metrics = {}, metricsUpdatedAt = Date.now()) {
    if (!id) return false;
    const timestamp = validTimestamp(metricsUpdatedAt);
    const result = stmts.updateAgentInventoryMetrics.run(
      jsonObject(metrics),
      timestamp,
      timestamp,
      id,
    );
    return result.changes > 0;
  },

  /** Return all historical Agent records, newest last-seen first. */
  getAll() {
    return stmts.getAllAgentInventory.all().map(mapRow);
  },
};
