import { createHash, sign, verify } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const ALLOWED_ACTIONS = new Set(['ACTIVATE_EPOCH', 'create', 'start', 'stop', 'retry', 'remove']);

function canonicalOperation(operation) {
  return JSON.stringify({
    protocolVersion: operation.protocolVersion,
    operationId: operation.operationId,
    hostId: operation.hostId,
    sandboxId: operation.sandboxId || null,
    action: operation.action,
    requestDigest: operation.requestDigest,
    generation: operation.generation || null,
    hostEpoch: operation.hostEpoch,
    instanceId: operation.instanceId,
    imageDigest: operation.imageDigest,
    desiredState: operation.desiredState,
    issuedAt: operation.issuedAt,
    expiresAt: operation.expiresAt,
    nonce: operation.nonce,
    bootstrap: operation.bootstrap || null,
    resources: operation.resources
  });
}

function digestOperation(operation) {
  return createHash('sha256').update(canonicalOperation(operation)).digest('hex');
}

function canonicalAttestation(attestation) {
  return JSON.stringify({
    protocolVersion: attestation.protocolVersion,
    operationId: attestation.operationId,
    hostId: attestation.hostId,
    sandboxId: attestation.sandboxId,
    action: attestation.action,
    requestDigest: attestation.requestDigest,
    generation: attestation.generation,
    hostEpoch: attestation.hostEpoch,
    requestNonce: attestation.requestNonce,
    issuedAt: attestation.issuedAt,
    imageDigest: attestation.imageDigest || null,
    readinessProof: attestation.readinessProof || null,
    absenceProof: attestation.absenceProof || null,
    resourceInspection: attestation.resourceInspection || null
  });
}

function assertProofShape(operation, result) {
  if (!result || typeof result !== 'object' || typeof result.success !== 'boolean') {
    throw new Error('Sandbox Helper executor returned an invalid result');
  }
  if (!result.success) return;
  if (operation.action === 'remove') {
    const proof = result.absenceProof;
    if (!proof || proof.container !== true || proof.storage !== true || proof.quota !== true
      || proof.network !== true || proof.credential !== true) {
      throw new Error('Sandbox Helper executor did not prove resource absence');
    }
    return;
  }
  const proof = result.readinessProof;
  const inspection = result.resourceInspection;
  const requiredProofs = ['image', 'cpu', 'memory', 'pid', 'io', 'quota', 'network', 'credential'];
  if (!proof || !requiredProofs.every(key => proof[key] === true)
    || !inspection || inspection.cpuMillis !== operation.resources.cpuMillis
    || inspection.memoryMiB !== operation.resources.memoryMiB
    || inspection.diskGiB !== operation.resources.diskGiB
    || !Number.isInteger(inspection.pidsLimit) || inspection.pidsLimit <= 0
    || !Number.isInteger(inspection.ioWeight) || inspection.ioWeight <= 0
    || inspection.quotaHard !== true
    || inspection.networkPolicy !== 'public-egress-isolated') {
    throw new Error('Sandbox Helper executor did not prove the requested resource policy');
  }
}

function buildAttestation(operation, result, config, issuedAt) {
  const attestation = {
    protocolVersion: 1,
    operationId: operation.operationId,
    hostId: operation.hostId,
    sandboxId: operation.sandboxId || null,
    action: operation.action,
    requestDigest: operation.requestDigest,
    generation: operation.generation || null,
    hostEpoch: operation.hostEpoch,
    requestNonce: operation.nonce,
    issuedAt,
    imageDigest: ['remove', 'ACTIVATE_EPOCH'].includes(operation.action) ? null : operation.imageDigest,
    readinessProof: result.success && !['remove', 'ACTIVATE_EPOCH'].includes(operation.action) ? result.readinessProof : null,
    absenceProof: result.success && operation.action === 'remove' ? result.absenceProof : null,
    resourceInspection: result.success && !['remove', 'ACTIVATE_EPOCH'].includes(operation.action) ? result.resourceInspection : null
  };
  attestation.signature = sign(
    null,
    Buffer.from(canonicalAttestation(attestation)),
    config.attestationSigningPrivateKey
  ).toString('base64url');
  return { ...result, helperAttestation: attestation };
}

function validateOperation(operation, config, now) {
  const activation = operation?.action === 'ACTIVATE_EPOCH';
  if (!operation || operation.protocolVersion !== 1
    || !operation.operationId || (!activation && (!operation.sandboxId || !operation.instanceId))
    || operation.hostId !== config.hostId
    || !ALLOWED_ACTIONS.has(operation.action)
    || (!activation && (!Number.isInteger(operation.generation) || operation.generation < 1))
    || !operation.requestDigest
    || !Number.isSafeInteger(operation.hostEpoch) || operation.hostEpoch <= 0
    || !operation.nonce
    || !Number.isFinite(operation.issuedAt) || !Number.isFinite(operation.expiresAt)
    || operation.issuedAt > now + config.maxClockSkewMs
    || operation.expiresAt < now
    || operation.expiresAt - operation.issuedAt > config.maxOperationTtlMs) {
    throw new Error('Sandbox Helper rejected an invalid operation envelope');
  }
  if (!activation && operation.action !== 'remove') {
    const resources = operation.resources;
    if (!resources || !Number.isInteger(resources.cpuMillis) || resources.cpuMillis <= 0
      || !Number.isInteger(resources.memoryMiB) || resources.memoryMiB <= 0
      || !Number.isInteger(resources.diskGiB) || resources.diskGiB <= 0
      || operation.imageDigest !== config.imageDigest) {
      throw new Error('Sandbox Helper rejected an invalid resource policy');
    }
  }
  let valid = false;
  try {
    valid = verify(
      null,
      Buffer.from(canonicalOperation(operation)),
      config.operationSigningPublicKey,
      Buffer.from(String(operation.signature || ''), 'base64url')
    );
  } catch {
    valid = false;
  }
  if (!valid) throw new Error('Sandbox Helper rejected an invalid operation signature');
}

/**
 * Root-only durable authorization boundary for a dedicated Sandbox Host.
 * The injected executor is the only component allowed to perform runtime actions.
 */
export function createSandboxHelper({ config, executor, now = Date.now }) {
  if (!config?.hostId || !config.imageDigest || !config.operationSigningPublicKey
    || !config.attestationSigningPrivateKey || !config.journalPath || !executor?.execute) {
    throw new Error('Sandbox Helper requires a complete dedicated Host configuration');
  }
  const effectiveConfig = {
    maxClockSkewMs: 30_000,
    maxOperationTtlMs: 30_000,
    ...config
  };
  mkdirSync(dirname(effectiveConfig.journalPath), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(effectiveConfig.journalPath);
  const epochLockDb = new DatabaseSync(`${effectiveConfig.journalPath}.epoch-lock`);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;
    CREATE TABLE IF NOT EXISTS helper_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS helper_operations (
      operation_id TEXT PRIMARY KEY,
      sandbox_id TEXT,
      action TEXT,
      request_digest TEXT NOT NULL,
      host_epoch TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('in_progress', 'succeeded', 'failed', 'recovery_required')),
      result_json TEXT,
      updated_at INTEGER NOT NULL
    );
  `);
  epochLockDb.exec(`
    PRAGMA journal_mode = DELETE;
    PRAGMA synchronous = FULL;
    PRAGMA busy_timeout = 0;
    CREATE TABLE IF NOT EXISTS helper_epoch_lock (
      id INTEGER PRIMARY KEY CHECK(id = 1),
      holder TEXT
    );
    INSERT OR IGNORE INTO helper_epoch_lock(id, holder) VALUES (1, NULL);
  `);
  const operationColumns = db.prepare('PRAGMA table_info(helper_operations)').all();
  if (!operationColumns.some(column => column.name === 'sandbox_id')) {
    db.exec('ALTER TABLE helper_operations ADD COLUMN sandbox_id TEXT');
  }
  if (!operationColumns.some(column => column.name === 'action')) {
    db.exec('ALTER TABLE helper_operations ADD COLUMN action TEXT');
  }

  let executing = 0;
  let executionWaiter = null;
  let queuedActivations = 0;
  let activationTail = Promise.resolve();

  async function acquireEpochLock() {
    while (true) {
      try {
        epochLockDb.exec('BEGIN IMMEDIATE');
        return;
      } catch (error) {
        if (!String(error?.message || '').includes('database is locked')) throw error;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    }
  }

  function releaseEpochLock() {
    epochLockDb.exec('COMMIT');
  }

  function activeEpoch() {
    const storedEpoch = db.prepare("SELECT value FROM helper_state WHERE key = 'active_epoch'").get()?.value;
    const digest = db.prepare("SELECT value FROM helper_state WHERE key = 'active_epoch_digest'").get()?.value;
    if (!storedEpoch && !digest) return null;
    const epoch = Number(storedEpoch);
    if (!Number.isSafeInteger(epoch) || epoch <= 0 || !digest) {
      throw new Error('Sandbox Helper found invalid durable Host epoch state');
    }
    return { epoch, digest };
  }

  function writeActiveEpoch(epoch, digest) {
    const write = db.prepare(`INSERT INTO helper_state(key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value`);
    write.run('active_epoch', epoch);
    write.run('active_epoch_digest', digest);
    write.run(`epoch:${epoch}`, digest);
  }

  function activateEpoch(operation) {
    validateOperation(operation, effectiveConfig, now());
    if (operation.action !== 'ACTIVATE_EPOCH') {
      throw new Error('Sandbox Helper rejected an invalid epoch activation');
    }
    const epoch = operation.hostEpoch;
    // The durable epoch identity is the Server-authorized immutable activation
    // digest. Per-request nonce/timestamps remain covered by the signature but
    // must not make an idempotent activation look like a conflicting epoch.
    const digest = operation.requestDigest;
    queuedActivations++;
    const activation = activationTail.then(async () => {
      try {
        if (executing > 0) await new Promise(resolve => { executionWaiter = resolve; });
        await acquireEpochLock();
        try {
          const current = activeEpoch();
          if (current?.epoch === epoch) {
            if (current.digest !== digest) throw new Error('Sandbox Helper rejected conflicting epoch activation');
            return buildAttestation(operation, { success: true, activated: false }, effectiveConfig, now());
          }
          if (current && epoch < current.epoch) {
            throw new Error('Sandbox Helper rejected epoch rollback');
          }
          db.exec('BEGIN IMMEDIATE');
          try {
            writeActiveEpoch(epoch, digest);
            db.exec('COMMIT');
          } catch (error) {
            db.exec('ROLLBACK');
            throw error;
          }
          return buildAttestation(operation, { success: true, activated: true }, effectiveConfig, now());
        } finally {
          releaseEpochLock();
        }
      } finally {
        queuedActivations--;
      }
    });
    activationTail = activation.catch(() => {});
    return activation;
  }

  const interrupted = db.prepare("SELECT operation_id, sandbox_id FROM helper_operations WHERE status = 'in_progress'").all();
  if (interrupted.length > 0) {
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare("UPDATE helper_operations SET status = 'recovery_required', updated_at = ? WHERE status = 'in_progress'")
        .run(now());
      const recordRecovery = db.prepare("INSERT INTO helper_state(key, value) VALUES (?, '1') ON CONFLICT(key) DO UPDATE SET value = excluded.value");
      for (const operation of interrupted) {
        recordRecovery.run(operation.sandbox_id ? `recovery:${operation.sandbox_id}` : 'recovery_required');
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  function assertAvailable(operation) {
    const legacyRecovery = db.prepare("SELECT value FROM helper_state WHERE key = 'recovery_required'").get();
    const sandboxRecovery = db.prepare('SELECT value FROM helper_state WHERE key = ?')
      .get(`recovery:${operation.sandboxId}`);
    if (legacyRecovery?.value === '1' || (sandboxRecovery?.value === '1' && operation.action !== 'remove')) {
      throw new Error('Sandbox Helper requires operator recovery');
    }
  }

  async function execute(operation) {
    if (operation?.action === 'ACTIVATE_EPOCH') return activateEpoch(operation);
    validateOperation(operation, effectiveConfig, now());
    while (queuedActivations > 0) await activationTail;
    await acquireEpochLock();
    const epoch = activeEpoch();
    if (!epoch || operation.hostEpoch !== epoch.epoch) {
      releaseEpochLock();
      throw new Error('Sandbox Helper rejected an inactive Host epoch');
    }
    try {
      assertAvailable(operation);
    } catch (error) {
      releaseEpochLock();
      throw error;
    }
    const requestDigest = digestOperation(operation);
    const existing = db.prepare('SELECT * FROM helper_operations WHERE operation_id = ?').get(operation.operationId);
    if (existing) {
      releaseEpochLock();
      if (existing.request_digest !== requestDigest) {
        throw new Error('Sandbox Helper rejected operation ID reuse with a different request');
      }
      if (existing.status === 'succeeded' || existing.status === 'failed') {
        return JSON.parse(existing.result_json);
      }
      throw new Error('Sandbox Helper operation is not safely replayable');
    }

    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare(`INSERT INTO helper_operations
        (operation_id, sandbox_id, action, request_digest, host_epoch, status, updated_at)
        VALUES (?, ?, ?, ?, ?, 'in_progress', ?)`)
        .run(operation.operationId, operation.sandboxId, operation.action,
          requestDigest, operation.hostEpoch, now());
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      releaseEpochLock();
      throw error;
    }

    executing++;
    let result;
    let status;
    try {
      try {
        const executorResult = await executor.execute(operation);
        assertProofShape(operation, executorResult);
        result = buildAttestation(operation, executorResult, effectiveConfig, now());
        status = executorResult.success ? 'succeeded' : 'failed';
      } catch (error) {
        result = buildAttestation(operation, {
          success: false,
          errorCode: 'SANDBOX_HELPER_EXECUTION_FAILED'
        }, effectiveConfig, now());
        status = 'failed';
      }
      db.prepare('UPDATE helper_operations SET status = ?, result_json = ?, updated_at = ? WHERE operation_id = ?')
        .run(status, JSON.stringify(result), now(), operation.operationId);
      return result;
    } finally {
      releaseEpochLock();
      executing--;
      if (executing === 0 && executionWaiter) {
        const resolve = executionWaiter;
        executionWaiter = null;
        resolve();
      }
    }
  }

  return { execute, activateEpoch, activeEpoch, close: () => {
    db.close();
    epochLockDb.close();
  } };
}

export { canonicalOperation };
