import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const dataDir = mkdtempSync(join(tmpdir(), 'yeaft-sandbox-'));
process.env.SERVER_DATA_DIR = dataDir;

let db;
let sandboxDb;
let userDb;
let authenticateSandboxController;
let registerSandboxRoutes;

beforeAll(async () => {
  ({ default: db } = await import('../../server/db/connection.js'));
  ({ sandboxDb } = await import('../../server/db/sandbox-db.js'));
  ({ userDb } = await import('../../server/db/user-db.js'));
  ({ authenticateSandboxController, registerSandboxRoutes }
    = await import('../../server/routes/sandbox-routes.js'));
});

afterAll(() => {
  try { db.close(); } catch {}
  rmSync(dataDir, { recursive: true, force: true });
});

function addQualifiedHost(overrides = {}) {
  db.prepare(`
    INSERT INTO sandbox_hosts (
      id, epoch, qualified, controller_healthy, helper_healthy, runtime_healthy,
      quota_healthy, network_healthy, image_digest, cpu_millis_total,
      memory_mib_total, memory_mib_available, disk_gib_total, updated_at
    ) VALUES (?, ?, ?, 1, 1, 1, 1, 1, ?, ?, ?, ?, ?, ?)
  `).run(
    overrides.id || 'host-1', overrides.epoch || 1, overrides.qualified ?? 1,
    overrides.imageDigest || 'sha256:fixed', overrides.cpu ?? 2000, overrides.memory ?? 4096,
    overrides.memoryAvailable ?? overrides.memory ?? 4096, overrides.disk ?? 40,
    overrides.updatedAt ?? Date.now()
  );
}

function sandboxConfig(overrides = {}) {
  return { enabled: true, imageDigest: 'sha256:fixed', hostMemoryReserveMiB: 512, ...overrides };
}

function entitle(userId) {
  db.prepare('INSERT INTO sandbox_entitlements (user_id, enabled, updated_at) VALUES (?, 1, ?)')
    .run(userId, Date.now());
}

function applyControllerResult(result, config) {
  const operation = db.prepare(`
    SELECT o.*, s.host_id FROM sandbox_operations o
    JOIN sandboxes s ON s.id = o.sandbox_id WHERE o.id = ?
  `).get(result.operationId);
  return sandboxDb.applyControllerResult({
    action: operation?.kind,
    hostId: operation?.host_id,
    sandboxId: operation?.sandbox_id,
    requestDigest: operation?.request_digest,
    ...result
  }, config, { isAgentReady: () => true });
}

describe('sandbox control-plane reservation', () => {
  it('fails closed until flag, entitlement, and a qualified Host with capacity all pass', () => {
    const user = userDb.getOrCreate('sandbox-capability');
    expect(sandboxDb.capability(user.id, sandboxConfig({ enabled: false, maxReservedSandboxes: 2 }))).toEqual({
      available: false, reasonCode: 'SANDBOX_DISABLED', catalog: []
    });
    expect(sandboxDb.capability(user.id, sandboxConfig({ maxReservedSandboxes: 2 })).reasonCode)
      .toBe('SANDBOX_NOT_ENTITLED');
    entitle(user.id);
    addQualifiedHost({ qualified: 0 });
    expect(sandboxDb.capability(user.id, sandboxConfig({ maxReservedSandboxes: 2 })).reasonCode)
      .toBe('SANDBOX_CAPACITY_UNAVAILABLE');
  });

  it('requires a pinned authorized mTLS identity for Host attestation', () => {
    const socket = (authorized, fingerprint256) => ({
      authorized,
      getPeerCertificate: () => ({ fingerprint256 })
    });
    const expected = 'AA:BB:CC';

    expect(authenticateSandboxController({ socket: socket(true, expected) }, expected)).toBe(true);
    expect(authenticateSandboxController({ socket: socket(false, expected) }, expected)).toBe(false);
    expect(authenticateSandboxController({ socket: socket(true, 'AA:BB:CD') }, expected)).toBe(false);
    expect(authenticateSandboxController({ socket: socket(true, expected) }, '')).toBe(false);
  });

  it('protects the entitlement write route with both authentication and admin authorization', () => {
    const routes = [];
    const app = {
      post() {},
      get() {},
      put(path, ...handlers) { routes.push({ path, handlers }); }
    };
    const requireAuth = () => {};
    const requireAdmin = () => {};

    registerSandboxRoutes(app, { requireAuth, requireAdmin });

    const route = routes.find(candidate =>
      candidate.path === '/api/admin/sandbox/entitlements/:userId'
    );
    expect(route?.handlers.slice(0, 2)).toEqual([requireAuth, requireAdmin]);
  });

  it('manages entitlement with validation and a durable admin audit record', () => {
    const user = userDb.getOrCreate('sandbox-entitlement-management');

    expect(sandboxDb.entitlement(user.id)).toEqual({ enabled: false });
    expect(sandboxDb.setEntitlement(user.id, true, 'admin-user', 123_456)).toEqual({
      enabled: true,
      updatedAt: 123_456
    });
    expect(sandboxDb.entitlement(user.id)).toEqual({ enabled: true });
    expect(db.prepare(`
      SELECT user_id, actor_username, enabled, created_at
      FROM sandbox_entitlement_audit_events WHERE user_id = ?
    `).get(user.id)).toEqual({
      user_id: user.id,
      actor_username: 'admin-user',
      enabled: 1,
      created_at: 123_456
    });
    expect(() => sandboxDb.setEntitlement(user.id, 'yes', 'admin-user'))
      .toThrowError(expect.objectContaining({ code: 'SANDBOX_ENTITLEMENT_INVALID' }));
    expect(() => sandboxDb.setEntitlement('missing-user', true, 'admin-user'))
      .toThrowError(expect.objectContaining({ code: 'SANDBOX_USER_NOT_FOUND' }));
  });

  it('atomically reserves catalog resources and replays an identical idempotency key', () => {
    db.exec('DELETE FROM sandbox_hosts');
    addQualifiedHost();
    const user = userDb.getOrCreate('sandbox-create');
    entitle(user.id);
    const config = sandboxConfig({ maxReservedSandboxes: 2 });
    const request = { agentName: 'My Sandbox', sizeId: 'normal', idempotencyKey: 'create-1' };

    const created = sandboxDb.create(user.id, request, config);
    const replayed = sandboxDb.create(user.id, request, config);

    expect(created.replayed).toBe(false);
    expect(created.snapshot.observedState).toBe('reserving');
    expect(created.snapshot.operation.stage).toBe('reserving_capacity');
    expect(replayed.replayed).toBe(true);
    expect(replayed.snapshot.id).toBe(created.snapshot.id);
    expect(db.prepare('SELECT COUNT(*) AS count FROM sandboxes').get().count).toBe(1);
    expect(db.prepare(`
      SELECT event_type, actor_kind, outcome, operation_id
      FROM sandbox_audit_events WHERE sandbox_id = ?
    `).all(created.snapshot.id)).toEqual([{
      event_type: 'operation_requested',
      actor_kind: 'user',
      outcome: 'accepted',
      operation_id: created.snapshot.operation.id
    }]);
  });

  it('does not oversell slots or release reservation for stopped and failed states', () => {
    const first = userDb.getOrCreate('sandbox-capacity-1');
    const second = userDb.getOrCreate('sandbox-capacity-2');
    const third = userDb.getOrCreate('sandbox-capacity-3');
    for (const user of [first, second, third]) entitle(user.id);
    const config = sandboxConfig({ maxReservedSandboxes: 2 });

    // One reservation already exists from the previous test.
    sandboxDb.create(first.id, { agentName: 'First', sizeId: 'normal', idempotencyKey: 'first' }, config);
    const reserved = db.prepare('SELECT id FROM sandboxes WHERE user_id = ?').get(first.id);
    db.prepare("UPDATE sandboxes SET observed_state = 'stopped' WHERE id = ?").run(reserved.id);

    expect(() => sandboxDb.create(second.id, {
      agentName: 'Second', sizeId: 'small', idempotencyKey: 'second'
    }, config)).toThrowError(expect.objectContaining({ code: 'SANDBOX_CAPACITY_UNAVAILABLE' }));
    expect(sandboxDb.snapshot(first.id).reservationHeld).toBe(true);
    expect(sandboxDb.snapshot(third.id)).toBeNull();
  });

  it('rejects Create and dispatch when trusted available memory cannot preserve the Host reserve', () => {
    addQualifiedHost({ id: '000-host-low-memory', memory: 8192, memoryAvailable: 1535 });
    const user = userDb.getOrCreate('sandbox-low-memory-create');
    entitle(user.id);
    const config = sandboxConfig({ maxReservedSandboxes: 20, hostMemoryReserveMiB: 512 });

    expect(() => sandboxDb.create(user.id, {
      agentName: 'Low Memory', sizeId: 'small', idempotencyKey: 'low-memory-create'
    }, config)).toThrowError(expect.objectContaining({ code: 'SANDBOX_CAPACITY_UNAVAILABLE' }));

    db.prepare('UPDATE sandbox_hosts SET memory_mib_available = 4096 WHERE id = ?').run('000-host-low-memory');
    const created = sandboxDb.create(user.id, {
      agentName: 'Admission Race', sizeId: 'small', idempotencyKey: 'admission-race-create'
    }, config);
    db.prepare('UPDATE sandbox_hosts SET memory_mib_available = 1535 WHERE id = ?').run('000-host-low-memory');

    expect(sandboxDb.admitPendingOperation(created.snapshot.operation.id, config)).toBeNull();
    expect(sandboxDb.snapshot(user.id)).toMatchObject({
      observedState: 'failed',
      lastErrorCode: 'SANDBOX_CAPACITY_UNAVAILABLE',
      reservationHeld: true,
      operation: { status: 'failed', stage: 'capacity_rejected', errorCode: 'SANDBOX_CAPACITY_UNAVAILABLE' }
    });
    db.prepare('DELETE FROM sandbox_audit_events WHERE sandbox_id = ?').run(created.snapshot.id);
    db.prepare('DELETE FROM sandboxes WHERE id = ?').run(created.snapshot.id);
    db.prepare('UPDATE sandbox_hosts SET qualified = 0 WHERE id = ?').run('000-host-low-memory');
  });

  it('atomically claims a pending startup operation once', () => {
    addQualifiedHost({ id: 'host-start-lease', memory: 8192, memoryAvailable: 4096 });
    const user = userDb.getOrCreate('sandbox-start-lease');
    entitle(user.id);
    const config = sandboxConfig({ maxReservedSandboxes: 20 });
    const created = sandboxDb.create(user.id, {
      agentName: 'Start Lease', sizeId: 'small', idempotencyKey: 'start-lease-create'
    }, config);

    expect(sandboxDb.admitPendingOperation(created.snapshot.operation.id, config)).toMatchObject({
      id: created.snapshot.operation.id,
      status: 'running',
      stage: 'dispatching'
    });
    expect(sandboxDb.admitPendingOperation(created.snapshot.operation.id, config)).toBeNull();
    db.prepare('DELETE FROM sandbox_audit_events WHERE sandbox_id = ?').run(created.snapshot.id);
    db.prepare('DELETE FROM sandboxes WHERE id = ?').run(created.snapshot.id);
    db.prepare('UPDATE sandbox_hosts SET qualified = 0 WHERE id = ?').run('host-start-lease');
  });

  it('rejects changed idempotent requests and invalid names with stable codes', () => {
    const user = userDb.getOrCreate('sandbox-validation');
    entitle(user.id);
    const config = sandboxConfig({ maxReservedSandboxes: 5 });
    expect(() => sandboxDb.create(user.id, {
      agentName: '../escape', sizeId: 'small', idempotencyKey: 'bad-name'
    }, config)).toThrowError(expect.objectContaining({ code: 'SANDBOX_INVALID_AGENT_NAME' }));
  });

  it('fails closed for stale Host qualification', () => {
    const user = userDb.getOrCreate('sandbox-stale-host');
    entitle(user.id);
    addQualifiedHost({ id: 'host-stale', updatedAt: Date.now() - 60_000 });
    expect(sandboxDb.capability(user.id, sandboxConfig({ maxReservedSandboxes: 5, hostFreshnessMs: 30_000 })).reasonCode).toBe('SANDBOX_CAPACITY_UNAVAILABLE');
  });

  it('admits only qualified Hosts attesting the configured image digest', () => {
    const user = userDb.getOrCreate('sandbox-image-fence');
    entitle(user.id);
    addQualifiedHost({ id: 'host-wrong-image', imageDigest: 'sha256:other' });

    expect(sandboxDb.capability(user.id, {
      enabled: true, maxReservedSandboxes: 20
    }).reasonCode).toBe('SANDBOX_CAPACITY_UNAVAILABLE');
    expect(sandboxDb.capability(user.id, sandboxConfig({
      imageDigest: 'sha256:expected', maxReservedSandboxes: 20
    })).reasonCode).toBe('SANDBOX_CAPACITY_UNAVAILABLE');

    addQualifiedHost({ id: 'host-expected-image', imageDigest: 'sha256:expected' });
    expect(sandboxDb.capability(user.id, sandboxConfig({
      imageDigest: 'sha256:expected', maxReservedSandboxes: 20
    })).available).toBe(true);
  });

  it('durably disables account access, enqueues idempotent Remove, and finalizes after settlement', () => {
    addQualifiedHost({ id: 'host-account-delete', epoch: 1, cpu: 10000, memory: 20000, disk: 200 });
    const user = userDb.getOrCreate('sandbox-account-delete');
    db.prepare("UPDATE users SET agent_secret = 'deletion-secret' WHERE id = ?").run(user.id);
    entitle(user.id);
    const created = sandboxDb.create(user.id, {
      agentName: 'Account Delete', sizeId: 'small', idempotencyKey: 'account-delete-create'
    }, sandboxConfig({ maxReservedSandboxes: 20 }));

    const first = userDb.beginDeletion(user.id, 5000);
    const replay = userDb.beginDeletion(user.id, 6000);
    expect(replay).toEqual(first);
    expect(userDb.get(user.id)).toMatchObject({
      deletion_state: 'pending', deletion_id: first.deletionId,
      password_hash: null, agent_secret: null, totp_secret: null
    });
    expect(userDb.getUserByAgentSecret('deletion-secret')).toBeNull();
    const removal = db.prepare(`
      SELECT * FROM sandbox_operations WHERE user_id = ? AND idempotency_key = ?
    `).get(user.id, `account-delete:${first.deletionId}`);
    expect(removal).toMatchObject({ kind: 'remove', status: 'pending', stage: 'removing' });
    expect(db.prepare(`
      SELECT COUNT(*) AS count FROM sandbox_operations
      WHERE user_id = ? AND idempotency_key LIKE 'account-delete:%'
    `).get(user.id).count).toBe(1);
    expect(userDb.reconcilePendingDeletions(7000)).toBe(0);
    expect(userDb.get(user.id)).toBeTruthy();

    db.prepare("UPDATE sandbox_operations SET status = 'succeeded', stage = 'complete' WHERE id = ?")
      .run(removal.id);
    db.prepare(`
      UPDATE sandboxes
      SET reservation_held = 0, observed_state = 'removed', desired_state = 'removed', removed_at = ?
      WHERE id = ?
    `).run(8000, created.snapshot.id);

    expect(userDb.reconcilePendingDeletions(9000)).toBe(1);
    expect(userDb.get(user.id)).toBeUndefined();
    expect(db.prepare('SELECT id FROM sandboxes WHERE id = ?').get(created.snapshot.id)).toBeUndefined();
  });

  it('does not enter Running without per-Sandbox network isolation proof', () => {
    addQualifiedHost({ id: 'host-network-proof', cpu: 10000, memory: 20000, disk: 200 });
    const user = userDb.getOrCreate('sandbox-network-proof');
    entitle(user.id);
    const created = sandboxDb.create(user.id, {
      agentName: 'Network Proof', sizeId: 'small', idempotencyKey: 'network-proof-create'
    }, sandboxConfig({ maxReservedSandboxes: 20 }));
    const operation = db.prepare('SELECT * FROM sandbox_operations WHERE sandbox_id = ?')
      .get(created.snapshot.id);

    expect(() => applyControllerResult({
      operationId: operation.id,
      generation: operation.generation,
      hostEpoch: operation.host_epoch,
      imageDigest: 'sha256:fixed',
      success: true,
      readinessProof: {
        image: true, cpu: true, memory: true, pid: true, io: true,
        quota: true, credential: true
      }
    })).toThrowError(expect.objectContaining({ code: 'SANDBOX_READINESS_PROOF_REQUIRED' }));
    expect(sandboxDb.snapshot(user.id)).toEqual(expect.objectContaining({
      observedState: 'reserving',
      reservationHeld: true,
      operation: expect.objectContaining({ status: 'pending' })
    }));
  });

  it('persists lifecycle operations and releases only after complete absence proof', () => {
    addQualifiedHost({ id: 'host-lifecycle' });
    const user = userDb.getOrCreate('sandbox-lifecycle');
    entitle(user.id);
    const config = sandboxConfig({ maxReservedSandboxes: 5 });
    const created = sandboxDb.create(user.id, {
      agentName: 'Lifecycle', sizeId: 'small', idempotencyKey: 'lifecycle-create'
    }, config);
    const createOperation = db.prepare('SELECT * FROM sandbox_operations WHERE sandbox_id = ?').get(created.snapshot.id);
    const runningCredential = sandboxDb.issueBootstrap(createOperation.id, undefined, 'test-bootstrap-signing-key');
    const sandboxRow = db.prepare('SELECT * FROM sandboxes WHERE id = ?').get(created.snapshot.id);
    const claims = {
      sandboxId: sandboxRow.id,
      instanceId: sandboxRow.instance_id,
      generation: sandboxRow.generation,
      imageDigest: sandboxRow.image_digest
    };
    const agentCredential = sandboxDb.exchangeBootstrap(runningCredential.token, claims);
    applyControllerResult({
      operationId: createOperation.id,
      generation: 1,
      hostEpoch: 1,
      imageDigest: 'sha256:fixed',
      success: true,
      readinessProof: {
        image: true,
        cpu: true,
        memory: true,
        pid: true,
        io: true,
        quota: true,
        network: true,
        credential: true,
        agentHeartbeat: true,
        endToEnd: true
      }
    });
    const stopped = sandboxDb.requestAction(user.id, 'stop', 'lifecycle-stop', config);
    expect(stopped.snapshot.desiredState).toBe('stopped');
    expect(stopped.snapshot.reservationHeld).toBe(true);
    expect(db.prepare(`
      SELECT event_type, actor_kind, outcome FROM sandbox_audit_events
      WHERE sandbox_id = ? ORDER BY id DESC LIMIT 1
    `).get(created.snapshot.id)).toEqual({
      event_type: 'operation_requested', actor_kind: 'user', outcome: 'accepted'
    });
    const stopOperation = db.prepare("SELECT * FROM sandbox_operations WHERE sandbox_id = ? AND kind = 'stop'").get(created.snapshot.id);
    expect(stopOperation.generation).toBe(1);
    applyControllerResult({ operationId: stopOperation.id, generation: 1, hostEpoch: 1, success: true });
    expect(sandboxDb.snapshot(user.id).observedState).toBe('stopped');
    expect(sandboxDb.authenticateCredential(agentCredential.credentialId, agentCredential.secret, claims))
      .toEqual({ sandboxId: created.snapshot.id, userId: user.id });

    sandboxDb.requestAction(user.id, 'remove', 'lifecycle-remove', config);
    const removeOperation = db.prepare("SELECT * FROM sandbox_operations WHERE sandbox_id = ? AND kind = 'remove'").get(created.snapshot.id);
    expect(() => applyControllerResult({
      operationId: removeOperation.id, generation: 2, hostEpoch: 1, success: true,
      absenceProof: { container: true }
    })).toThrowError(expect.objectContaining({ code: 'SANDBOX_REMOVE_PROOF_REQUIRED' }));
    expect(sandboxDb.snapshot(user.id).reservationHeld).toBe(true);

    applyControllerResult({
      operationId: removeOperation.id, generation: 2, hostEpoch: 1, success: true,
      absenceProof: { container: true, storage: true, quota: true, network: true, credential: true }
    });
    expect(sandboxDb.snapshot(user.id)).toBeNull();
    expect(db.prepare(`
      SELECT outcome FROM sandbox_audit_events
      WHERE operation_id = ? ORDER BY id DESC LIMIT 1
    `).get(removeOperation.id)).toEqual({ outcome: 'succeeded' });
  });

  it('retries a failed Remove as Remove and releases only after absence proof', () => {
    addQualifiedHost({ id: 'host-remove-retry', cpu: 10000, memory: 20000, disk: 200 });
    const user = userDb.getOrCreate('sandbox-remove-retry');
    entitle(user.id);
    const config = sandboxConfig({ maxReservedSandboxes: 20 });
    const created = sandboxDb.create(user.id, {
      agentName: 'Remove Retry', sizeId: 'small', idempotencyKey: 'remove-retry-create'
    }, config);
    const createOperation = db.prepare('SELECT * FROM sandbox_operations WHERE sandbox_id = ?')
      .get(created.snapshot.id);
    applyControllerResult({
      operationId: createOperation.id,
      generation: 1,
      hostEpoch: createOperation.host_epoch,
      imageDigest: 'sha256:fixed',
      success: true,
      readinessProof: {
        image: true, cpu: true, memory: true, pid: true, io: true,
        quota: true, network: true, credential: true, agentHeartbeat: true, endToEnd: true
      }
    });

    sandboxDb.requestAction(user.id, 'remove', 'remove-retry-first', config);
    const failedRemove = db.prepare(`
      SELECT * FROM sandbox_operations WHERE sandbox_id = ? AND kind = 'remove'
      ORDER BY created_at DESC LIMIT 1
    `).get(created.snapshot.id);
    applyControllerResult({
      operationId: failedRemove.id,
      generation: failedRemove.generation,
      hostEpoch: failedRemove.host_epoch,
      success: false,
      errorCode: 'SANDBOX_RUNTIME_FAILED'
    });
    expect(sandboxDb.snapshot(user.id).observedState).toBe('remove_failed');

    const retry = sandboxDb.requestAction(user.id, 'retry', 'remove-retry-second', config);
    expect(retry.snapshot.desiredState).toBe('removed');
    const retriedRemove = db.prepare(`
      SELECT * FROM sandbox_operations WHERE sandbox_id = ? AND idempotency_key = ?
    `).get(created.snapshot.id, 'remove-retry-second');
    expect(retriedRemove.kind).toBe('remove');
    expect(retriedRemove.stage).toBe('removing');

    expect(() => applyControllerResult({
      operationId: retriedRemove.id,
      generation: retriedRemove.generation,
      hostEpoch: retriedRemove.host_epoch,
      success: true,
      readinessProof: {
        image: true, cpu: true, memory: true, pid: true, io: true,
        quota: true, network: true, credential: true, agentHeartbeat: true, endToEnd: true
      }
    })).toThrowError(expect.objectContaining({ code: 'SANDBOX_REMOVE_PROOF_REQUIRED' }));
    expect(sandboxDb.snapshot(user.id).reservationHeld).toBe(true);

    applyControllerResult({
      operationId: retriedRemove.id,
      generation: retriedRemove.generation,
      hostEpoch: retriedRemove.host_epoch,
      success: true,
      absenceProof: { container: true, storage: true, quota: true, network: true, credential: true }
    });
    expect(sandboxDb.snapshot(user.id)).toBeNull();
  });

  it('serializes lifecycle operations and preserves generation across Stop and Start', () => {
    addQualifiedHost({ id: 'host-serialized', cpu: 10000, memory: 20000, disk: 200 });
    const user = userDb.getOrCreate('sandbox-serialized');
    entitle(user.id);
    const config = sandboxConfig({ maxReservedSandboxes: 20 });
    const created = sandboxDb.create(user.id, {
      agentName: 'Serialized', sizeId: 'small', idempotencyKey: 'serialized-create'
    }, config);

    expect(() => sandboxDb.requestAction(user.id, 'remove', 'remove-while-create', config))
      .toThrowError(expect.objectContaining({ code: 'SANDBOX_OPERATION_IN_PROGRESS' }));

    const createOperation = db.prepare('SELECT * FROM sandbox_operations WHERE sandbox_id = ?').get(created.snapshot.id);
    applyControllerResult({
      operationId: createOperation.id,
      generation: 1,
      hostEpoch: createOperation.host_epoch,
      imageDigest: 'sha256:fixed',
      success: true,
      readinessProof: {
        image: true, cpu: true, memory: true, pid: true, io: true,
        quota: true, network: true, credential: true, agentHeartbeat: true, endToEnd: true
      }
    });

    sandboxDb.requestAction(user.id, 'stop', 'serialized-stop', config);
    const stopOperation = db.prepare("SELECT * FROM sandbox_operations WHERE sandbox_id = ? AND kind = 'stop'")
      .get(created.snapshot.id);
    expect(stopOperation.generation).toBe(1);
    expect(() => sandboxDb.requestAction(user.id, 'remove', 'remove-while-stop', config))
      .toThrowError(expect.objectContaining({ code: 'SANDBOX_OPERATION_IN_PROGRESS' }));
    applyControllerResult({
      operationId: stopOperation.id, generation: 1, hostEpoch: stopOperation.host_epoch, success: true
    });

    sandboxDb.requestAction(user.id, 'start', 'serialized-start', config);
    const startOperation = db.prepare("SELECT * FROM sandbox_operations WHERE sandbox_id = ? AND kind = 'start'")
      .get(created.snapshot.id);
    expect(startOperation.generation).toBe(1);
    expect(sandboxDb.snapshot(user.id).generation).toBe(1);
  });

  it('moves unsafe persisted runtime state to recovery_required without releasing capacity', () => {
    addQualifiedHost({ id: 'host-runtime-reconcile', cpu: 10000, memory: 20000, disk: 200 });
    const user = userDb.getOrCreate('sandbox-runtime-reconcile');
    entitle(user.id);
    const config = sandboxConfig({
      maxReservedSandboxes: 20,
      hostFreshnessMs: 30_000,
      agentRecoveryGraceMs: 1_000
    });
    const created = sandboxDb.create(user.id, {
      agentName: 'Runtime Reconcile', sizeId: 'small', idempotencyKey: 'runtime-reconcile-create'
    }, config);
    const operation = db.prepare('SELECT * FROM sandbox_operations WHERE sandbox_id = ?')
      .get(created.snapshot.id);
    applyControllerResult({
      operationId: operation.id,
      generation: operation.generation,
      hostEpoch: operation.host_epoch,
      imageDigest: 'sha256:fixed',
      success: true,
      readinessProof: {
        image: true, cpu: true, memory: true, pid: true, io: true,
        quota: true, network: true, credential: true, agentHeartbeat: true, endToEnd: true
      }
    }, config);
    db.prepare('UPDATE sandboxes SET updated_at = ? WHERE id = ?')
      .run(Date.now() - 2_000, created.snapshot.id);

    expect(sandboxDb.reconcileRuntimeState(Date.now(), config, { isAgentReady: () => false }))
      .toBe(1);
    expect(sandboxDb.snapshot(user.id)).toMatchObject({
      observedState: 'recovery_required',
      reservationHeld: true,
      lastErrorCode: 'SANDBOX_AGENT_NOT_READY'
    });

    db.prepare("UPDATE sandbox_hosts SET epoch = 2 WHERE id = 'host-runtime-reconcile'").run();
    expect(sandboxDb.reconcileRuntimeState(Date.now(), config, { isAgentReady: () => true }))
      .toBe(0);
    expect(sandboxDb.snapshot(user.id).lastErrorCode).toBe('SANDBOX_AGENT_NOT_READY');
    db.prepare('DELETE FROM sandboxes WHERE id = ?').run(created.snapshot.id);
  });

  it('detects Host epoch changes without waiting for a Controller result', () => {
    addQualifiedHost({ id: '000-host-epoch-reconcile', cpu: 100000, memory: 200000, disk: 2000 });
    const user = userDb.getOrCreate('sandbox-epoch-reconcile');
    entitle(user.id);
    const config = sandboxConfig({ maxReservedSandboxes: 100, hostFreshnessMs: 30_000 });
    const created = sandboxDb.create(user.id, {
      agentName: 'Epoch Reconcile', sizeId: 'small', idempotencyKey: 'epoch-reconcile-create'
    }, config);
    const assignedHost = db.prepare('SELECT host_id FROM sandboxes WHERE id = ?')
      .get(created.snapshot.id).host_id;
    db.prepare("UPDATE sandbox_hosts SET epoch = 2 WHERE id = ?").run(assignedHost);

    expect(sandboxDb.reconcileRuntimeState(Date.now(), config, { isAgentReady: () => true }))
      .toBeGreaterThanOrEqual(1);
    expect(sandboxDb.snapshot(user.id)).toMatchObject({
      observedState: 'recovery_required',
      reservationHeld: true,
      lastErrorCode: 'SANDBOX_HOST_EPOCH_CHANGED'
    });
    db.prepare('DELETE FROM sandboxes WHERE id = ?').run(created.snapshot.id);
    db.prepare("DELETE FROM sandbox_hosts WHERE id = '000-host-epoch-reconcile'").run();
  });

  it('rejects late generation and epoch results without mutating current state', () => {
    addQualifiedHost({ id: 'host-stale-result' });
    const user = userDb.getOrCreate('sandbox-stale-result');
    entitle(user.id);
    const created = sandboxDb.create(user.id, {
      agentName: 'Stale Result', sizeId: 'small', idempotencyKey: 'stale-create'
    }, sandboxConfig({ maxReservedSandboxes: 5 }));
    const operation = db.prepare('SELECT * FROM sandbox_operations WHERE sandbox_id = ?').get(created.snapshot.id);
    expect(() => applyControllerResult({
      operationId: operation.id, generation: 0, hostEpoch: 1, success: true
    })).toThrowError(expect.objectContaining({ code: 'SANDBOX_STALE_RESULT' }));
    expect(sandboxDb.snapshot(user.id).observedState).toBe('reserving');
  });

  it('rejects results after Host qualification, health, freshness, or epoch is lost', () => {
    addQualifiedHost({ id: 'host-result-fence' });
    const user = userDb.getOrCreate('sandbox-result-fence');
    entitle(user.id);
    const config = sandboxConfig({ maxReservedSandboxes: 20, hostFreshnessMs: 30_000 });
    const created = sandboxDb.create(user.id, {
      agentName: 'Result Fence', sizeId: 'small', idempotencyKey: 'result-fence-create'
    }, config);
    const operation = db.prepare('SELECT * FROM sandbox_operations WHERE sandbox_id = ?').get(created.snapshot.id);
    const assignedHost = db.prepare('SELECT host_id FROM sandboxes WHERE id = ?').get(created.snapshot.id).host_id;
    const completeResult = {
      operationId: operation.id,
      generation: 1,
      hostEpoch: 1,
      imageDigest: 'sha256:fixed',
      success: true,
      readinessProof: {
        image: true, cpu: true, memory: true, pid: true, io: true,
        quota: true, network: true, credential: true, agentHeartbeat: true, endToEnd: true
      }
    };

    for (const update of [
      'qualified = 0',
      'controller_healthy = 0',
      'helper_healthy = 0',
      'runtime_healthy = 0',
      'quota_healthy = 0',
      'network_healthy = 0',
      `updated_at = ${Date.now() - 60_000}`
    ]) {
      db.prepare(`UPDATE sandbox_hosts SET ${update} WHERE id = ?`).run(assignedHost);
      expect(() => applyControllerResult(completeResult, config))
        .toThrowError(expect.objectContaining({ code: 'SANDBOX_HOST_UNAVAILABLE' }));
      expect(sandboxDb.snapshot(user.id).observedState).toBe('reserving');
      db.prepare(`
        UPDATE sandbox_hosts SET qualified = 1, controller_healthy = 1, helper_healthy = 1,
          runtime_healthy = 1, quota_healthy = 1, network_healthy = 1, updated_at = ?
        WHERE id = ?
      `).run(Date.now(), assignedHost);
    }

    db.prepare("UPDATE sandbox_hosts SET epoch = 2 WHERE id = ?").run(assignedHost);
    const recovery = applyControllerResult(completeResult, config);
    expect(recovery.snapshot.observedState).toBe('recovery_required');
    expect(recovery.snapshot.lastErrorCode).toBe('SANDBOX_HOST_EPOCH_CHANGED');
    expect(recovery.snapshot.reservationHeld).toBe(true);

    const remove = sandboxDb.requestAction(user.id, 'remove', 'result-fence-remove', config);
    expect(remove.snapshot.desiredState).toBe('removed');
    const removeOperation = db.prepare(`
      SELECT * FROM sandbox_operations WHERE sandbox_id = ? AND kind = 'remove'
    `).get(created.snapshot.id);
    expect(removeOperation.host_epoch).toBe(2);
    expect(db.prepare('SELECT host_epoch FROM sandboxes WHERE id = ?').get(created.snapshot.id).host_epoch)
      .toBe(2);
  });

  it('keeps Remove reachable after an epoch change when Host qualification is unavailable', () => {
    addQualifiedHost({ id: 'host-recovery-remove', cpu: 10000, memory: 20000, disk: 200 });
    const user = userDb.getOrCreate('sandbox-recovery-remove');
    entitle(user.id);
    const config = sandboxConfig({ maxReservedSandboxes: 20, hostFreshnessMs: 30_000 });
    const created = sandboxDb.create(user.id, {
      agentName: 'Recovery Remove', sizeId: 'small', idempotencyKey: 'recovery-remove-create'
    }, config);
    const operation = db.prepare('SELECT * FROM sandbox_operations WHERE sandbox_id = ?').get(created.snapshot.id);
    const assignedHost = db.prepare('SELECT host_id FROM sandboxes WHERE id = ?').get(created.snapshot.id).host_id;

    db.prepare(`
      UPDATE sandbox_hosts SET epoch = 'epoch-recovery', qualified = 0,
        controller_healthy = 0, updated_at = ? WHERE id = ?
    `).run(Date.now() - 60_000, assignedHost);
    const recovery = applyControllerResult({
      operationId: operation.id,
      generation: 1,
      hostEpoch: operation.host_epoch,
      imageDigest: 'sha256:fixed',
      success: true,
      readinessProof: {
        image: true, cpu: true, memory: true, pid: true, io: true,
        quota: true, network: true, credential: true, agentHeartbeat: true, endToEnd: true
      }
    }, config);
    expect(recovery.snapshot.observedState).toBe('recovery_required');

    const remove = sandboxDb.requestAction(user.id, 'remove', 'recovery-remove-action', config);
    expect(remove.snapshot.desiredState).toBe('removed');
    expect(remove.snapshot.reservationHeld).toBe(true);
    const removeOperation = db.prepare(`
      SELECT * FROM sandbox_operations WHERE sandbox_id = ? AND kind = 'remove'
    `).get(created.snapshot.id);
    expect(removeOperation.host_epoch).toBe('epoch-recovery');
  });

  it('settles recovery Remove after Host qualification is lost when absence proof is complete', () => {
    addQualifiedHost({ id: 'host-unqualified-remove', cpu: 10000, memory: 20000, disk: 200 });
    const user = userDb.getOrCreate('sandbox-unqualified-host-remove');
    entitle(user.id);
    const config = sandboxConfig({ maxReservedSandboxes: 20, hostFreshnessMs: 30_000 });
    const created = sandboxDb.create(user.id, {
      agentName: 'Unqualified Host Remove', sizeId: 'small', idempotencyKey: 'unqualified-host-create'
    }, config);
    const sandbox = db.prepare('SELECT * FROM sandboxes WHERE id = ?').get(created.snapshot.id);
    db.prepare(`
      UPDATE sandbox_operations SET status = 'failed', error_code = 'SANDBOX_HOST_UNAVAILABLE'
      WHERE sandbox_id = ?
    `).run(sandbox.id);
    db.prepare(`
      UPDATE sandboxes SET observed_state = 'recovery_required',
        last_error_code = 'SANDBOX_HOST_UNAVAILABLE' WHERE id = ?
    `).run(sandbox.id);
    db.prepare(`
      UPDATE sandbox_hosts SET qualified = 0, controller_healthy = 0,
        helper_healthy = 0, runtime_healthy = 0, quota_healthy = 0,
        network_healthy = 0, updated_at = ? WHERE id = ?
    `).run(Date.now() - 60_000, sandbox.host_id);

    const remove = sandboxDb.requestAction(user.id, 'remove', 'unqualified-host-remove', config);
    expect(remove.snapshot).toMatchObject({
      desiredState: 'removed', observedState: 'recovery_required', reservationHeld: true
    });
    const operation = db.prepare(`
      SELECT * FROM sandbox_operations WHERE sandbox_id = ? AND kind = 'remove'
    `).get(sandbox.id);

    applyControllerResult({
      operationId: operation.id,
      generation: operation.generation,
      hostEpoch: operation.host_epoch,
      success: true,
      absenceProof: { container: true, storage: true, quota: true, network: true, credential: true }
    }, config);
    expect(sandboxDb.snapshot(user.id)).toBeNull();
    expect(db.prepare('SELECT reservation_held, observed_state FROM sandboxes WHERE id = ?').get(sandbox.id))
      .toEqual({ reservation_held: 0, observed_state: 'removed' });
  });

  it('does not report Running without complete inspected readiness proof', () => {
    addQualifiedHost({ id: 'host-readiness', cpu: 10000, memory: 20000, disk: 200 });
    const user = userDb.getOrCreate('sandbox-readiness');
    entitle(user.id);
    const created = sandboxDb.create(user.id, {
      agentName: 'Readiness', sizeId: 'small', idempotencyKey: 'readiness-create'
    }, sandboxConfig({ maxReservedSandboxes: 50 }));
    const operation = db.prepare('SELECT * FROM sandbox_operations WHERE sandbox_id = ?').get(created.snapshot.id);

    expect(() => applyControllerResult({
      operationId: operation.id,
      generation: 1,
      hostEpoch: operation.host_epoch,
      imageDigest: 'sha256:fixed',
      success: true,
      readinessProof: { image: true, cpu: true }
    })).toThrowError(expect.objectContaining({ code: 'SANDBOX_READINESS_PROOF_REQUIRED' }));
    expect(sandboxDb.snapshot(user.id).observedState).toBe('reserving');
  });

  it('does not accept Controller readiness without the authenticated managed Agent', () => {
    addQualifiedHost({ id: 'host-agent-ready', cpu: 10000, memory: 20000, disk: 200 });
    const user = userDb.getOrCreate('sandbox-agent-ready');
    entitle(user.id);
    const created = sandboxDb.create(user.id, {
      agentName: 'Agent Ready', sizeId: 'small', idempotencyKey: 'agent-ready-create'
    }, sandboxConfig({ maxReservedSandboxes: 50 }));
    const operation = db.prepare('SELECT * FROM sandbox_operations WHERE sandbox_id = ?').get(created.snapshot.id);
    const result = {
      operationId: operation.id,
      action: operation.kind,
      hostId: db.prepare('SELECT host_id FROM sandboxes WHERE id = ?').get(operation.sandbox_id).host_id,
      sandboxId: operation.sandbox_id,
      requestDigest: operation.request_digest,
      generation: operation.generation,
      hostEpoch: operation.host_epoch,
      imageDigest: 'sha256:fixed',
      success: true,
      readinessProof: {
        image: true, cpu: true, memory: true, pid: true, io: true,
        quota: true, network: true, credential: true
      }
    };

    expect(() => sandboxDb.applyControllerResult(result, {}, { isAgentReady: () => false }))
      .toThrowError(expect.objectContaining({ code: 'SANDBOX_AGENT_NOT_READY' }));
    expect(sandboxDb.snapshot(user.id).observedState).toBe('reserving');
    expect(sandboxDb.applyControllerResult(result, {}, { isAgentReady: () => true }).snapshot.observedState)
      .toBe('running');
  });

  it('uses one-time scoped bootstrap tokens and independently revocable Agent credentials', () => {
    addQualifiedHost({ id: 'host-credential', cpu: 10000, memory: 20000, disk: 200 });
    const user = userDb.getOrCreate('sandbox-credential');
    entitle(user.id);
    const created = sandboxDb.create(user.id, {
      agentName: 'Credential', sizeId: 'small', idempotencyKey: 'credential-create'
    }, sandboxConfig({ maxReservedSandboxes: 20 }));
    const operation = db.prepare('SELECT * FROM sandbox_operations WHERE sandbox_id = ?').get(created.snapshot.id);
    expect(() => sandboxDb.issueBootstrap(operation.id))
      .toThrowError(expect.objectContaining({ code: 'SANDBOX_BOOTSTRAP_SIGNING_KEY_REQUIRED' }));
    const bootstrap = sandboxDb.issueBootstrap(operation.id, undefined, 'test-bootstrap-signing-key');
    const replayedBootstrap = sandboxDb.issueBootstrap(
      operation.id, undefined, 'test-bootstrap-signing-key'
    );
    expect(replayedBootstrap).toEqual(bootstrap);
    expect(db.prepare(`
      SELECT COUNT(*) AS count FROM sandbox_credentials
      WHERE sandbox_id = ? AND kind = 'bootstrap' AND revoked_at IS NULL
    `).get(created.snapshot.id).count).toBe(1);
    const sandboxRow = db.prepare('SELECT * FROM sandboxes WHERE id = ?').get(created.snapshot.id);
    const claims = {
      sandboxId: created.snapshot.id,
      instanceId: sandboxRow.instance_id,
      generation: 1,
      imageDigest: sandboxRow.image_digest
    };
    const agentCredential = sandboxDb.exchangeBootstrap(bootstrap.token, claims);
    expect(db.prepare(`
      SELECT event_type, actor_kind, outcome FROM sandbox_audit_events
      WHERE sandbox_id = ? AND event_type = 'credential_issued'
    `).get(created.snapshot.id)).toEqual({
      event_type: 'credential_issued', actor_kind: 'managed_agent', outcome: 'succeeded'
    });
    expect(sandboxDb.authenticateCredential(agentCredential.credentialId, agentCredential.secret, claims))
      .toEqual({ sandboxId: created.snapshot.id, userId: user.id });
    expect(() => sandboxDb.exchangeBootstrap(bootstrap.token, claims))
      .toThrowError(expect.objectContaining({ code: 'SANDBOX_BOOTSTRAP_INVALID' }));

    db.prepare('UPDATE sandboxes SET generation = generation + 1 WHERE id = ?').run(created.snapshot.id);
    const advancedClaims = { ...claims, generation: 2 };
    expect(() => sandboxDb.authenticateCredential(
      agentCredential.credentialId, agentCredential.secret, advancedClaims
    )).toThrowError(expect.objectContaining({ code: 'SANDBOX_CREDENTIAL_SCOPE_MISMATCH' }));
    db.prepare('UPDATE sandboxes SET generation = generation - 1 WHERE id = ?').run(created.snapshot.id);

    db.prepare('UPDATE sandbox_credentials SET revoked_at = ? WHERE id = ?')
      .run(Date.now(), agentCredential.credentialId);
    expect(() => sandboxDb.authenticateCredential(agentCredential.credentialId, agentCredential.secret, claims))
      .toThrowError(expect.objectContaining({ code: 'SANDBOX_CREDENTIAL_INVALID' }));
  });

  it('audits runtime recovery and automatic credential revocation', () => {
    addQualifiedHost({ id: 'host-reconcile-audit', cpu: 10000, memory: 20000, disk: 200 });
    const user = userDb.getOrCreate('sandbox-reconcile-audit');
    entitle(user.id);
    const created = sandboxDb.create(user.id, {
      agentName: 'Reconcile audit', sizeId: 'small', idempotencyKey: 'reconcile-audit-create'
    }, sandboxConfig({ maxReservedSandboxes: 20 }));
    const operation = db.prepare('SELECT * FROM sandbox_operations WHERE sandbox_id = ?')
      .get(created.snapshot.id);
    const bootstrap = sandboxDb.issueBootstrap(operation.id, undefined, 'test-bootstrap-signing-key');
    const sandbox = db.prepare('SELECT * FROM sandboxes WHERE id = ?').get(created.snapshot.id);
    const claims = {
      sandboxId: sandbox.id,
      instanceId: sandbox.instance_id,
      generation: sandbox.generation,
      imageDigest: sandbox.image_digest
    };
    const credential = sandboxDb.exchangeBootstrap(bootstrap.token, claims);
    db.prepare("UPDATE sandboxes SET observed_state = 'running', updated_at = ? WHERE id = ?")
      .run(Date.now() - 120_000, sandbox.id);

    sandboxDb.reconcileRuntimeState(Date.now(), {
      hostFreshnessMs: 30_000,
      agentRecoveryGraceMs: 60_000
    }, { isAgentReady: () => false });
    expect(sandboxDb.snapshot(user.id).observedState).toBe('recovery_required');
    expect(db.prepare(`
      SELECT event_type, actor_kind, outcome, error_code FROM sandbox_audit_events
      WHERE sandbox_id = ? AND event_type IN ('runtime_reconcile', 'credential_revoked')
      ORDER BY id
    `).all(sandbox.id)).toEqual([
      {
        event_type: 'runtime_reconcile', actor_kind: 'server',
        outcome: 'recovery_required', error_code: 'SANDBOX_AGENT_NOT_READY'
      },
      {
        event_type: 'credential_revoked', actor_kind: 'server',
        outcome: 'succeeded', error_code: 'SANDBOX_AGENT_NOT_READY'
      }
    ]);
    expect(() => sandboxDb.authenticateCredential(credential.credentialId, credential.secret, claims))
      .toThrowError(expect.objectContaining({ code: 'SANDBOX_CREDENTIAL_INVALID' }));
  });

  it('rotates an expired bootstrap without colliding with its persisted history', () => {
    addQualifiedHost({ id: 'host-bootstrap-renewal', cpu: 10000, memory: 20000, disk: 200 });
    const user = userDb.getOrCreate('sandbox-bootstrap-renewal');
    entitle(user.id);
    const created = sandboxDb.create(user.id, {
      agentName: 'Bootstrap renewal', sizeId: 'small', idempotencyKey: 'bootstrap-renewal'
    }, sandboxConfig({ maxReservedSandboxes: 20 }));
    const operation = db.prepare('SELECT * FROM sandbox_operations WHERE sandbox_id = ?')
      .get(created.snapshot.id);
    const first = sandboxDb.issueBootstrap(operation.id, undefined, 'test-bootstrap-signing-key');
    db.prepare(`
      UPDATE sandbox_credentials SET expires_at = ?
      WHERE sandbox_id = ? AND kind = 'bootstrap'
    `).run(Date.now() - 1, created.snapshot.id);

    const renewed = sandboxDb.issueBootstrap(operation.id, undefined, 'test-bootstrap-signing-key');

    expect(renewed.token).not.toBe(first.token);
    expect(db.prepare(`
      SELECT COUNT(*) AS count FROM sandbox_credentials
      WHERE sandbox_id = ? AND kind = 'bootstrap'
    `).get(created.snapshot.id).count).toBe(2);
    const sandboxRow = db.prepare('SELECT * FROM sandboxes WHERE id = ?').get(created.snapshot.id);
    const claims = {
      sandboxId: created.snapshot.id,
      instanceId: sandboxRow.instance_id,
      generation: sandboxRow.generation,
      imageDigest: sandboxRow.image_digest
    };
    expect(() => sandboxDb.exchangeBootstrap(first.token, claims))
      .toThrowError(expect.objectContaining({ code: 'SANDBOX_BOOTSTRAP_INVALID' }));
    expect(sandboxDb.exchangeBootstrap(renewed.token, claims)).toEqual({
      credentialId: expect.any(String), secret: expect.any(String)
    });
  });
});