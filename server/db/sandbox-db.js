import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'crypto';
import db, { transaction } from './connection.js';

export const SANDBOX_SIZES = Object.freeze({
  small: Object.freeze({ id: 'small', cpuMillis: 500, memoryMiB: 1024, diskGiB: 10 }),
  normal: Object.freeze({ id: 'normal', cpuMillis: 1000, memoryMiB: 2048, diskGiB: 20 })
});


const ACTIONS = Object.freeze({
  start: { desiredState: 'running', allowed: ['stopped', 'failed'], stage: 'starting' },
  stop: { desiredState: 'stopped', allowed: ['running', 'failed'], stage: 'stopping' },
  retry: { desiredState: null, allowed: ['failed', 'remove_failed'], stage: 'retrying' },
  remove: { desiredState: 'removed', allowed: ['reserving', 'provisioning', 'starting', 'waiting_for_agent', 'running', 'stopping', 'stopped', 'failed', 'remove_failed', 'recovery_required'], stage: 'removing' }
});

export class SandboxConflictError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

const getEntitlement = db.prepare('SELECT enabled FROM sandbox_entitlements WHERE user_id = ?');
const getSandbox = db.prepare('SELECT * FROM sandboxes WHERE user_id = ? AND reservation_held = 1');
const getSandboxById = db.prepare('SELECT * FROM sandboxes WHERE id = ?');
const getOperation = db.prepare('SELECT * FROM sandbox_operations WHERE user_id = ? AND idempotency_key = ?');
const getLatestOperation = db.prepare('SELECT * FROM sandbox_operations WHERE sandbox_id = ? ORDER BY created_at DESC LIMIT 1');
const getActiveOperation = db.prepare(`
  SELECT * FROM sandbox_operations
  WHERE sandbox_id = ? AND status IN ('pending', 'running')
  LIMIT 1
`);
const reservedCount = db.prepare('SELECT COUNT(*) AS slots FROM sandboxes WHERE reservation_held = 1');
const reservedTotals = db.prepare(`
  SELECT COALESCE(SUM(cpu_millis), 0) AS cpu,
    COALESCE(SUM(memory_mib), 0) AS memory, COALESCE(SUM(disk_gib), 0) AS disk
  FROM sandboxes WHERE host_id = ? AND reservation_held = 1
`);
const activeStartupMemory = db.prepare(`
  SELECT COALESCE(SUM(s.memory_mib), 0) AS memory
  FROM sandbox_operations o JOIN sandboxes s ON s.id = o.sandbox_id
  WHERE s.host_id = ? AND s.reservation_held = 1
    AND o.kind IN ('create', 'start', 'retry')
    AND o.status = 'running'
`);
const insertSandbox = db.prepare(`
  INSERT INTO sandboxes (
    id, user_id, host_id, host_epoch, agent_name, size_id, cpu_millis, memory_mib, disk_gib,
    desired_state, observed_state, generation, instance_id, image_digest,
    reservation_held, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', 'reserving', 1, ?, ?, 1, ?, ?)
`);
const insertOperation = db.prepare(`
  INSERT INTO sandbox_operations (
    id, sandbox_id, user_id, idempotency_key, request_digest, kind, status,
    stage, generation, host_epoch, deadline_at, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?)
`);

function digestRequest(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function hashSecret(secret) {
  return createHash('sha256').update(secret).digest();
}

function deriveBootstrapSecret(operationId, seed) {
  return createHmac('sha256', seed).update(operationId).digest('base64url');
}

function secretMatches(secret, expectedHex) {
  const actual = hashSecret(secret);
  const expected = Buffer.from(expectedHex, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function assertBoundClaims(record, claims) {
  if (!record || claims.sandboxId !== record.sandbox_id || claims.instanceId !== record.instance_id
    || claims.generation !== record.generation || claims.imageDigest !== record.image_digest) {
    throw new SandboxConflictError('SANDBOX_CREDENTIAL_SCOPE_MISMATCH');
  }
}

function credentialMatchesSandbox(credential, sandbox) {
  return sandbox && credential.sandbox_id === sandbox.id
    && credential.instance_id === sandbox.instance_id
    && credential.generation === sandbox.generation
    && credential.image_digest === sandbox.image_digest;
}

function publicSnapshot(sandbox) {
  if (!sandbox) return null;
  const operation = getLatestOperation.get(sandbox.id) || null;
  return {
    id: sandbox.id,
    agentName: sandbox.agent_name,
    sizeId: sandbox.size_id,
    desiredState: sandbox.desired_state,
    observedState: sandbox.observed_state,
    generation: sandbox.generation,
    reservationHeld: !!sandbox.reservation_held,
    lastErrorCode: sandbox.last_error_code,
    operation: operation && {
      id: operation.id,
      kind: operation.kind,
      status: operation.status,
      stage: operation.stage,
      errorCode: operation.error_code,
      updatedAt: operation.updated_at
    }
  };
}

function candidateHosts(config, now = Date.now()) {
  const freshnessMs = config.hostFreshnessMs || 30_000;
  if (!config.imageDigest) return [];
  return db.prepare(`
    SELECT * FROM sandbox_hosts
    WHERE qualified = 1 AND controller_healthy = 1 AND helper_healthy = 1
      AND runtime_healthy = 1 AND quota_healthy = 1 AND network_healthy = 1
      AND image_digest = ? AND updated_at >= ?
    ORDER BY id
  `).all(config.imageDigest, now - freshnessMs);
}

function memoryReserveMiB(config) {
  const reserve = Number(config.hostMemoryReserveMiB);
  return Number.isSafeInteger(reserve) && reserve > 0 ? reserve : null;
}

function hostCanFit(host, size, config) {
  const reserve = memoryReserveMiB(config);
  if (reserve === null || !Number.isSafeInteger(host.memory_mib_available)) return false;
  const used = reservedTotals.get(host.id);
  const startingMemory = activeStartupMemory.get(host.id).memory;
  return reservedCount.get().slots < config.maxReservedSandboxes
    && used.cpu + size.cpuMillis <= host.cpu_millis_total
    && used.memory + size.memoryMiB <= host.memory_mib_total
    && host.memory_mib_available - reserve - startingMemory >= size.memoryMiB
    && used.disk + size.diskGiB <= host.disk_gib_total;
}

function assertIdempotency(userId, key, requestDigest) {
  if (!key) throw new SandboxConflictError('SANDBOX_IDEMPOTENCY_KEY_REQUIRED');
  const prior = getOperation.get(userId, key);
  if (!prior) return null;
  if (prior.request_digest !== requestDigest) throw new SandboxConflictError('SANDBOX_IDEMPOTENCY_CONFLICT');
  return { snapshot: publicSnapshot(getSandboxById.get(prior.sandbox_id)), replayed: true };
}

function operationDeadline(config, now) {
  return now + (config.operationTimeoutMs || 10 * 60_000);
}

function appendAuditEvent({ sandbox, operationId = null, eventType, actorKind, outcome, errorCode = null, now = Date.now() }) {
  db.prepare(`
    INSERT INTO sandbox_audit_events (
      sandbox_id, user_id, operation_id, event_type, actor_kind,
      generation, host_epoch, outcome, error_code, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    sandbox.id, sandbox.user_id, operationId, eventType, actorKind,
    sandbox.generation, sandbox.host_epoch, outcome, errorCode, now
  );
}

export const sandboxDb = {
  isEpochActivated(hostId, epoch) {
    return Boolean(db.prepare(`
      SELECT 1 FROM sandbox_host_audit_events
      WHERE host_id = ? AND epoch = ? AND event_type = 'epoch_activation'
        AND outcome = 'succeeded'
      ORDER BY id DESC LIMIT 1
    `).get(hostId, epoch));
  },

  recordEpochActivation(hostId, epoch, activationDigest, now = Date.now()) {
    return transaction(() => {
      const host = db.prepare('SELECT epoch FROM sandbox_hosts WHERE id = ?').get(hostId);
      if (!host || host.epoch !== epoch) throw new SandboxConflictError('SANDBOX_STALE_RESULT');
      db.prepare(`
        INSERT INTO sandbox_host_audit_events
          (host_id, epoch, event_type, outcome, error_code, created_at)
        VALUES (?, ?, 'epoch_activation', 'succeeded', ?, ?)
      `).run(hostId, epoch, activationDigest, now);
      return true;
    })();
  },

  capability(userId, config) {
    if (!config.enabled) return { available: false, reasonCode: 'SANDBOX_DISABLED', catalog: [] };
    if (!getEntitlement.get(userId)?.enabled) {
      return { available: false, reasonCode: 'SANDBOX_NOT_ENTITLED', catalog: [] };
    }
    const hosts = candidateHosts(config);
    const availableSizes = Object.values(SANDBOX_SIZES).filter(size =>
      hosts.some(host => hostCanFit(host, size, config))
    );
    if (availableSizes.length === 0) {
      return { available: false, reasonCode: 'SANDBOX_CAPACITY_UNAVAILABLE', catalog: [] };
    }
    return { available: true, reasonCode: null, catalog: availableSizes };
  },

  snapshot(userId) {
    return publicSnapshot(getSandbox.get(userId));
  },

  entitlement(userId) {
    return { enabled: Boolean(getEntitlement.get(userId)?.enabled) };
  },

  setEntitlement(userId, enabled, actorUsername, now = Date.now()) {
    return transaction(() => {
      const user = db.prepare('SELECT id FROM users WHERE id = ?').get(userId);
      if (!user) throw new SandboxConflictError('SANDBOX_USER_NOT_FOUND');
      const normalizedEnabled = enabled === true ? 1 : enabled === false ? 0 : null;
      if (normalizedEnabled === null) {
        throw new SandboxConflictError('SANDBOX_ENTITLEMENT_INVALID');
      }
      db.prepare(`
        INSERT INTO sandbox_entitlements (user_id, enabled, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(user_id) DO UPDATE SET
          enabled = excluded.enabled,
          updated_at = excluded.updated_at
      `).run(userId, normalizedEnabled, now);
      db.prepare(`
        INSERT INTO sandbox_entitlement_audit_events (
          user_id, actor_username, enabled, created_at
        ) VALUES (?, ?, ?, ?)
      `).run(userId, String(actorUsername || 'unknown'), normalizedEnabled, now);
      return { enabled: Boolean(normalizedEnabled), updatedAt: now };
    })();
  },

  create(userId, request, config) {
    const agentName = String(request.agentName || '').trim();
    const size = SANDBOX_SIZES[request.sizeId];
    if (!agentName || agentName.length > 64 || !/^[a-zA-Z0-9 ._-]+$/.test(agentName)) {
      throw new SandboxConflictError('SANDBOX_INVALID_AGENT_NAME');
    }
    if (!size) throw new SandboxConflictError('SANDBOX_INVALID_SIZE');
    const requestDigest = digestRequest({ kind: 'create', agentName, sizeId: size.id });

    return transaction(() => {
      const replay = assertIdempotency(userId, request.idempotencyKey, requestDigest);
      if (replay) return replay;
      if (getSandbox.get(userId)) throw new SandboxConflictError('SANDBOX_ALREADY_EXISTS');
      const capability = this.capability(userId, config);
      if (!capability.available) throw new SandboxConflictError(capability.reasonCode);
      const host = candidateHosts(config).find(candidate => hostCanFit(candidate, size, config));
      if (!host) throw new SandboxConflictError('SANDBOX_CAPACITY_UNAVAILABLE');

      const now = Date.now();
      const sandboxId = `sandbox_${randomUUID()}`;
      insertSandbox.run(
        sandboxId, userId, host.id, host.epoch, agentName, size.id, size.cpuMillis,
        size.memoryMiB, size.diskGiB, `sandbox_instance_${randomUUID()}`,
        host.image_digest, now, now
      );
      const operationId = `sandbox_op_${randomUUID()}`;
      insertOperation.run(
        operationId, sandboxId, userId, request.idempotencyKey,
        requestDigest, 'create', 'reserving_capacity', 1, host.epoch,
        operationDeadline(config, now), now, now
      );
      appendAuditEvent({
        sandbox: getSandboxById.get(sandboxId), operationId,
        eventType: 'operation_requested', actorKind: 'user', outcome: 'accepted', now
      });
      return { snapshot: publicSnapshot(getSandbox.get(userId)), replayed: false };
    })();
  },

  requestAction(userId, kind, idempotencyKey, config) {
    const action = ACTIONS[kind];
    if (!action) throw new SandboxConflictError('SANDBOX_INVALID_ACTION');
    const requestDigest = digestRequest({ kind });
    return transaction(() => {
      const replay = assertIdempotency(userId, idempotencyKey, requestDigest);
      if (replay) return replay;
      const sandbox = getSandbox.get(userId);
      if (!sandbox) throw new SandboxConflictError('SANDBOX_NOT_FOUND');
      if (!action.allowed.includes(sandbox.observed_state)) {
        throw new SandboxConflictError('SANDBOX_ACTION_NOT_ALLOWED');
      }
      if (getActiveOperation.get(sandbox.id)) {
        throw new SandboxConflictError('SANDBOX_OPERATION_IN_PROGRESS');
      }
      const retryingRemove = kind === 'retry' && sandbox.observed_state === 'remove_failed';
      const operationKind = retryingRemove ? 'remove' : kind;
      const generation = ['retry', 'remove'].includes(kind)
        ? sandbox.generation + 1
        : sandbox.generation;
      const desiredState = retryingRemove
        ? 'removed'
        : kind === 'retry' ? 'running' : action.desiredState;
      const operationStage = retryingRemove ? ACTIONS.remove.stage : action.stage;
      const now = Date.now();
      let hostEpoch = sandbox.host_epoch;
      if (kind === 'remove' && sandbox.observed_state === 'recovery_required') {
        const host = db.prepare('SELECT epoch FROM sandbox_hosts WHERE id = ?').get(sandbox.host_id);
        // Removal must remain reachable after a Host record is lost. Preserve the
        // last fenced epoch unless the same Host has reported a newer one.
        if (host) hostEpoch = host.epoch;
      }
      if (operationKind === 'remove') {
        const revoked = db.prepare(`
          UPDATE sandbox_credentials SET revoked_at = ?
          WHERE sandbox_id = ? AND revoked_at IS NULL
        `).run(now, sandbox.id);
        if (revoked.changes > 0) {
          appendAuditEvent({
            sandbox, eventType: 'credential_revoked', actorKind: 'server',
            outcome: 'succeeded', now
          });
        }
      }
      db.prepare(`
        UPDATE sandboxes SET desired_state = ?, generation = ?, host_epoch = ?,
          last_error_code = NULL, updated_at = ?
        WHERE id = ? AND generation = ? AND reservation_held = 1
      `).run(desiredState, generation, hostEpoch, now, sandbox.id, sandbox.generation);
      const operationId = `sandbox_op_${randomUUID()}`;
      insertOperation.run(
        operationId, sandbox.id, userId, idempotencyKey,
        requestDigest, operationKind, operationStage, generation, hostEpoch,
        operationDeadline(config, now), now, now
      );
      appendAuditEvent({
        sandbox: getSandboxById.get(sandbox.id), operationId,
        eventType: 'operation_requested', actorKind: 'user', outcome: 'accepted', now
      });
      return { snapshot: publicSnapshot(getSandbox.get(userId)), replayed: false };
    })();
  },

  admitPendingOperation(operationId, config, now = Date.now()) {
    return transaction(() => {
      const operation = db.prepare(`
        SELECT o.*, s.host_id, s.instance_id, s.image_digest, s.desired_state,
          s.cpu_millis, s.memory_mib, s.disk_gib
        FROM sandbox_operations o JOIN sandboxes s ON s.id = o.sandbox_id
        WHERE o.id = ? AND o.status = 'pending' AND s.reservation_held = 1
      `).get(operationId);
      if (!operation || !['create', 'start', 'retry'].includes(operation.kind)) return operation || null;
      const host = candidateHosts(config, now).find(candidate => candidate.id === operation.host_id);
      const reserve = memoryReserveMiB(config);
      const startingMemory = host ? activeStartupMemory.get(host.id).memory : 0;
      if (!host || reserve === null
        || host.memory_mib_available - reserve - startingMemory < operation.memory_mib) {
        db.prepare(`
          UPDATE sandbox_operations SET status = 'failed', stage = 'capacity_rejected',
            error_code = 'SANDBOX_CAPACITY_UNAVAILABLE', updated_at = ?
          WHERE id = ? AND status = 'pending'
        `).run(now, operation.id);
        db.prepare(`
          UPDATE sandboxes SET observed_state = 'failed',
            last_error_code = 'SANDBOX_CAPACITY_UNAVAILABLE', updated_at = ?
          WHERE id = ? AND generation = ? AND reservation_held = 1
        `).run(now, operation.sandbox_id, operation.generation);
        appendAuditEvent({
          sandbox: getSandboxById.get(operation.sandbox_id), operationId: operation.id,
          eventType: 'runtime_admission', actorKind: 'server', outcome: 'rejected',
          errorCode: 'SANDBOX_CAPACITY_UNAVAILABLE', now
        });
        return null;
      }
      const admitted = db.prepare(`
        UPDATE sandbox_operations SET status = 'running', stage = 'dispatching', updated_at = ?
        WHERE id = ? AND status = 'pending'
      `).run(now, operation.id);
      return admitted.changes === 1 ? { ...operation, status: 'running', stage: 'dispatching' } : null;
    })();
  },

  listPendingOperations(now = Date.now()) {
    db.prepare(`
      UPDATE sandbox_operations SET status = 'failed', error_code = 'SANDBOX_OPERATION_TIMEOUT', updated_at = ?
      WHERE status IN ('pending', 'running') AND deadline_at < ?
    `).run(now, now);
    db.prepare(`
      UPDATE sandboxes SET observed_state = CASE WHEN desired_state = 'removed' THEN 'remove_failed' ELSE 'failed' END,
        last_error_code = 'SANDBOX_OPERATION_TIMEOUT', updated_at = ?
      WHERE id IN (SELECT sandbox_id FROM sandbox_operations WHERE error_code = 'SANDBOX_OPERATION_TIMEOUT' AND updated_at = ?)
    `).run(now, now);
    return db.prepare(`
      SELECT o.*, s.host_id, s.instance_id, s.image_digest, s.desired_state,
        s.cpu_millis, s.memory_mib, s.disk_gib
      FROM sandbox_operations o JOIN sandboxes s ON s.id = o.sandbox_id
      WHERE o.status = 'pending' AND s.reservation_held = 1
      ORDER BY o.created_at
    `).all();
  },

  reconcileRuntimeState(now = Date.now(), config = {}, runtime = {}) {
    return transaction(() => {
      const freshnessMs = config.hostFreshnessMs || 30_000;
      const agentGraceMs = config.agentRecoveryGraceMs || 60_000;
      const sandboxes = db.prepare(`
        SELECT s.*, h.epoch AS current_host_epoch, h.qualified, h.controller_healthy,
          h.helper_healthy, h.runtime_healthy, h.quota_healthy, h.network_healthy,
          h.updated_at AS host_updated_at
        FROM sandboxes s LEFT JOIN sandbox_hosts h ON h.id = s.host_id
        WHERE s.reservation_held = 1 AND s.observed_state != 'recovery_required'
      `).all();
      let recovered = 0;

      for (const sandbox of sandboxes) {
        let errorCode = null;
        if (!sandbox.current_host_epoch || sandbox.current_host_epoch !== sandbox.host_epoch) {
          errorCode = 'SANDBOX_HOST_EPOCH_CHANGED';
        } else if (!sandbox.qualified || !sandbox.controller_healthy || !sandbox.helper_healthy
          || !sandbox.runtime_healthy || !sandbox.quota_healthy || !sandbox.network_healthy
          || sandbox.host_updated_at < now - freshnessMs) {
          errorCode = 'SANDBOX_HOST_UNAVAILABLE';
        } else if (sandbox.observed_state === 'running' && sandbox.updated_at < now - agentGraceMs
          && !runtime.isAgentReady?.({
            sandboxId: sandbox.id,
            instanceId: sandbox.instance_id,
            generation: sandbox.generation,
            imageDigest: sandbox.image_digest
          })) {
          errorCode = 'SANDBOX_AGENT_NOT_READY';
        }
        if (!errorCode) continue;

        db.prepare(`
          UPDATE sandboxes SET observed_state = 'recovery_required', last_error_code = ?, updated_at = ?
          WHERE id = ? AND generation = ? AND reservation_held = 1
        `).run(errorCode, now, sandbox.id, sandbox.generation);
        db.prepare(`
          UPDATE sandbox_operations SET status = 'failed', error_code = ?, updated_at = ?
          WHERE sandbox_id = ? AND status IN ('pending', 'running')
        `).run(errorCode, now, sandbox.id);
        const revoked = db.prepare(`
          UPDATE sandbox_credentials SET revoked_at = ?
          WHERE sandbox_id = ? AND revoked_at IS NULL
        `).run(now, sandbox.id);
        appendAuditEvent({
          sandbox: getSandboxById.get(sandbox.id), eventType: 'runtime_reconcile',
          actorKind: 'server', outcome: 'recovery_required', errorCode, now
        });
        if (revoked.changes > 0) {
          appendAuditEvent({
            sandbox: getSandboxById.get(sandbox.id), eventType: 'credential_revoked',
            actorKind: 'server', outcome: 'succeeded', errorCode, now
          });
        }
        recovered++;
      }
      return recovered;
    })();
  },

  applyControllerResult(result, config = {}, runtime = {}) {
    return transaction(() => {
      const operation = db.prepare('SELECT * FROM sandbox_operations WHERE id = ?').get(result.operationId);
      if (!operation) throw new SandboxConflictError('SANDBOX_OPERATION_NOT_FOUND');
      const sandbox = getSandboxById.get(operation.sandbox_id);
      if (!sandbox || result.action !== operation.kind || result.hostId !== sandbox.host_id
        || result.sandboxId !== operation.sandbox_id || result.requestDigest !== operation.request_digest
        || operation.generation !== result.generation || sandbox.generation !== result.generation
        || operation.host_epoch !== result.hostEpoch || sandbox.host_epoch !== result.hostEpoch) {
        throw new SandboxConflictError('SANDBOX_STALE_RESULT');
      }
      const host = db.prepare('SELECT * FROM sandbox_hosts WHERE id = ?').get(sandbox.host_id);
      const freshnessMs = config.hostFreshnessMs || 30_000;
      const isRemove = operation.kind === 'remove';
      if (!isRemove && (!host || host.epoch !== sandbox.host_epoch)) {
        const now = Date.now();
        db.prepare(`
          UPDATE sandboxes SET observed_state = 'recovery_required',
            last_error_code = 'SANDBOX_HOST_EPOCH_CHANGED', updated_at = ?
          WHERE id = ? AND generation = ? AND reservation_held = 1
        `).run(now, sandbox.id, sandbox.generation);
        db.prepare(`
          UPDATE sandbox_operations SET status = 'failed',
            error_code = 'SANDBOX_HOST_EPOCH_CHANGED', updated_at = ?
          WHERE id = ? AND status IN ('pending', 'running')
        `).run(now, operation.id);
        db.prepare(`
          UPDATE sandbox_credentials SET revoked_at = ?
          WHERE sandbox_id = ? AND revoked_at IS NULL
        `).run(now, sandbox.id);
        appendAuditEvent({
          sandbox, operationId: operation.id, eventType: 'controller_result',
          actorKind: 'controller', outcome: 'recovery_required',
          errorCode: 'SANDBOX_HOST_EPOCH_CHANGED', now
        });
        return { snapshot: publicSnapshot(getSandboxById.get(sandbox.id)), replayed: false };
      }
      if (!isRemove && (!host.qualified || !host.controller_healthy || !host.helper_healthy
        || !host.runtime_healthy || !host.quota_healthy || !host.network_healthy
        || host.updated_at < Date.now() - freshnessMs)) {
        throw new SandboxConflictError('SANDBOX_HOST_UNAVAILABLE');
      }
      if (operation.status !== 'pending' && operation.status !== 'running') {
        return { snapshot: publicSnapshot(sandbox), replayed: true };
      }
      const now = Date.now();
      if (!result.success) {
        const observed = operation.kind === 'remove' ? 'remove_failed' : 'failed';
        const errorCode = result.errorCode || 'SANDBOX_RUNTIME_FAILED';
        db.prepare('UPDATE sandboxes SET observed_state = ?, last_error_code = ?, updated_at = ? WHERE id = ?')
          .run(observed, errorCode, now, sandbox.id);
        db.prepare("UPDATE sandbox_operations SET status = 'failed', error_code = ?, updated_at = ? WHERE id = ?")
          .run(errorCode, now, operation.id);
        appendAuditEvent({
          sandbox, operationId: operation.id, eventType: 'controller_result',
          actorKind: 'controller', outcome: 'failed', errorCode, now
        });
        return { snapshot: publicSnapshot(getSandboxById.get(sandbox.id)), replayed: false };
      }
      if (operation.kind === 'remove') {
        const proof = result.absenceProof || {};
        const required = ['container', 'storage', 'quota', 'network', 'credential'];
        if (!required.every(key => proof[key] === true)) {
          throw new SandboxConflictError('SANDBOX_REMOVE_PROOF_REQUIRED');
        }
        db.prepare(`
          UPDATE sandboxes SET observed_state = 'removed', reservation_held = 0,
            removed_at = ?, updated_at = ? WHERE id = ? AND reservation_held = 1
        `).run(now, now, sandbox.id);
      } else {
        if (operation.kind !== 'stop') {
          const proof = result.readinessProof || {};
          const required = ['image', 'cpu', 'memory', 'pid', 'io', 'quota', 'network', 'credential'];
          if (!required.every(key => proof[key] === true)) {
            throw new SandboxConflictError('SANDBOX_READINESS_PROOF_REQUIRED');
          }
          if (result.imageDigest !== sandbox.image_digest) {
            throw new SandboxConflictError('SANDBOX_IMAGE_MISMATCH');
          }
          if (!runtime.isAgentReady?.({
            sandboxId: sandbox.id,
            instanceId: sandbox.instance_id,
            generation: sandbox.generation,
            imageDigest: sandbox.image_digest
          })) {
            throw new SandboxConflictError('SANDBOX_AGENT_NOT_READY');
          }
        }
        const observed = operation.kind === 'stop' ? 'stopped' : 'running';
        db.prepare('UPDATE sandboxes SET observed_state = ?, last_error_code = NULL, updated_at = ? WHERE id = ?')
          .run(observed, now, sandbox.id);
      }
      db.prepare("UPDATE sandbox_operations SET status = 'succeeded', stage = 'complete', updated_at = ? WHERE id = ?")
        .run(now, operation.id);
      appendAuditEvent({
        sandbox: getSandboxById.get(sandbox.id), operationId: operation.id,
        eventType: 'controller_result', actorKind: 'controller', outcome: 'succeeded', now
      });
      return { snapshot: publicSnapshot(getSandboxById.get(sandbox.id)), replayed: false };
    })();
  },

  issueBootstrap(operationId, ttlMs = 5 * 60_000, signingKey) {
    return transaction(() => {
      const operation = db.prepare('SELECT * FROM sandbox_operations WHERE id = ?').get(operationId);
      if (!operation || !['create', 'start', 'retry'].includes(operation.kind)
        || !['pending', 'running'].includes(operation.status)) {
        throw new SandboxConflictError('SANDBOX_OPERATION_NOT_FOUND');
      }
      const sandbox = getSandboxById.get(operation.sandbox_id);
      if (!sandbox || sandbox.generation !== operation.generation
        || sandbox.host_epoch !== operation.host_epoch || !sandbox.reservation_held) {
        throw new SandboxConflictError('SANDBOX_STALE_RESULT');
      }
      if (!signingKey) throw new SandboxConflictError('SANDBOX_BOOTSTRAP_SIGNING_KEY_REQUIRED');
      const now = Date.now();
      const credentialPrefix = `sandbox_bootstrap_${operation.id}`;
      const existing = db.prepare(`
        SELECT * FROM sandbox_credentials
        WHERE id LIKE ? AND sandbox_id = ? AND generation = ? AND kind = 'bootstrap'
          AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at >= ?
        ORDER BY created_at DESC LIMIT 1
      `).get(`${credentialPrefix}%`, sandbox.id, sandbox.generation, now);
      if (existing) {
        return {
          token: deriveBootstrapSecret(existing.id, signingKey),
          sandboxId: sandbox.id,
          instanceId: sandbox.instance_id,
          generation: sandbox.generation,
          imageDigest: sandbox.image_digest,
          expiresAt: existing.expires_at
        };
      }
      const credentialId = `${credentialPrefix}_${randomUUID()}`;
      const secret = deriveBootstrapSecret(credentialId, signingKey);
      db.prepare(`
        INSERT INTO sandbox_credentials (
          id, sandbox_id, instance_id, generation, image_digest, kind, secret_hash,
          expires_at, created_at
        ) VALUES (?, ?, ?, ?, ?, 'bootstrap', ?, ?, ?)
      `).run(credentialId, sandbox.id, sandbox.instance_id,
        sandbox.generation, sandbox.image_digest, hashSecret(secret).toString('hex'), now + ttlMs, now);
      return {
        token: secret,
        sandboxId: sandbox.id,
        instanceId: sandbox.instance_id,
        generation: sandbox.generation,
        imageDigest: sandbox.image_digest,
        expiresAt: now + ttlMs
      };
    })();
  },

  exchangeBootstrap(token, claims) {
    return transaction(() => {
      const now = Date.now();
      const candidates = db.prepare(`
        SELECT * FROM sandbox_credentials
        WHERE kind = 'bootstrap' AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at >= ?
      `).all(now);
      const bootstrap = candidates.find(row => secretMatches(token, row.secret_hash));
      if (!bootstrap) throw new SandboxConflictError('SANDBOX_BOOTSTRAP_INVALID');
      assertBoundClaims(bootstrap, claims);
      const sandbox = getSandboxById.get(bootstrap.sandbox_id);
      if (!credentialMatchesSandbox(bootstrap, sandbox) || !sandbox.reservation_held) {
        throw new SandboxConflictError('SANDBOX_BOOTSTRAP_INVALID');
      }
      const consumed = db.prepare(`
        UPDATE sandbox_credentials SET consumed_at = ?
        WHERE id = ? AND consumed_at IS NULL AND revoked_at IS NULL
      `).run(now, bootstrap.id);
      if (consumed.changes !== 1) throw new SandboxConflictError('SANDBOX_BOOTSTRAP_INVALID');
      db.prepare(`
        UPDATE sandbox_credentials SET revoked_at = ?
        WHERE sandbox_id = ? AND kind = 'agent' AND revoked_at IS NULL
      `).run(now, sandbox.id);
      const secret = randomBytes(32).toString('base64url');
      const credentialId = `sandbox_credential_${randomUUID()}`;
      db.prepare(`
        INSERT INTO sandbox_credentials (
          id, sandbox_id, instance_id, generation, image_digest, kind, secret_hash, created_at
        ) VALUES (?, ?, ?, ?, ?, 'agent', ?, ?)
      `).run(credentialId, sandbox.id, sandbox.instance_id, sandbox.generation,
        sandbox.image_digest, hashSecret(secret).toString('hex'), now);
      appendAuditEvent({
        sandbox, eventType: 'credential_issued', actorKind: 'managed_agent',
        outcome: 'succeeded', now
      });
      return { credentialId, secret };
    })();
  },

  authenticateCredential(credentialId, secret, claims) {
    const credential = db.prepare(`
      SELECT * FROM sandbox_credentials
      WHERE id = ? AND kind = 'agent' AND revoked_at IS NULL
    `).get(credentialId);
    if (!credential || !secretMatches(secret, credential.secret_hash)) {
      throw new SandboxConflictError('SANDBOX_CREDENTIAL_INVALID');
    }
    assertBoundClaims(credential, claims);
    const sandbox = getSandboxById.get(credential.sandbox_id);
    if (!credentialMatchesSandbox(credential, sandbox) || !sandbox.reservation_held) {
      throw new SandboxConflictError('SANDBOX_CREDENTIAL_INVALID');
    }
    return { sandboxId: sandbox.id, userId: sandbox.user_id };
  }
};
