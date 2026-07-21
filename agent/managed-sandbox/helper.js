import { createHash, sign, verify } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const ALLOWED_ACTIONS = new Set(['create', 'start', 'stop', 'retry', 'remove']);

function canonicalOperation(operation) {
  return JSON.stringify({
    protocolVersion: operation.protocolVersion,
    operationId: operation.operationId,
    hostId: operation.hostId,
    sandboxId: operation.sandboxId,
    action: operation.action,
    generation: operation.generation,
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
    sandboxId: attestation.sandboxId,
    action: attestation.action,
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
    sandboxId: operation.sandboxId,
    action: operation.action,
    generation: operation.generation,
    hostEpoch: operation.hostEpoch,
    requestNonce: operation.nonce,
    issuedAt,
    imageDigest: operation.action === 'remove' ? null : operation.imageDigest,
    readinessProof: result.success && operation.action !== 'remove' ? result.readinessProof : null,
    absenceProof: result.success && operation.action === 'remove' ? result.absenceProof : null,
    resourceInspection: result.success && operation.action !== 'remove' ? result.resourceInspection : null
  };
  attestation.signature = sign(
    null,
    Buffer.from(canonicalAttestation(attestation)),
    config.attestationSigningPrivateKey
  ).toString('base64url');
  return { ...result, helperAttestation: attestation };
}

function validateOperation(operation, config, now) {
  if (!operation || operation.protocolVersion !== 1
    || !operation.operationId || !operation.sandboxId || !operation.instanceId
    || operation.hostId !== config.hostId
    || operation.hostEpoch !== config.hostEpoch
    || !ALLOWED_ACTIONS.has(operation.action)
    || !Number.isInteger(operation.generation) || operation.generation < 1
    || !operation.hostEpoch || !operation.nonce
    || !Number.isFinite(operation.issuedAt) || !Number.isFinite(operation.expiresAt)
    || operation.issuedAt > now + config.maxClockSkewMs
    || operation.expiresAt < now
    || operation.expiresAt - operation.issuedAt > config.maxOperationTtlMs) {
    throw new Error('Sandbox Helper rejected an invalid operation envelope');
  }
  if (operation.action !== 'remove') {
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
  if (!config?.hostId || !config.hostEpoch || !config.imageDigest || !config.operationSigningPublicKey
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
      request_digest TEXT NOT NULL,
      host_epoch TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('in_progress', 'succeeded', 'failed', 'recovery_required')),
      result_json TEXT,
      updated_at INTEGER NOT NULL
    );
  `);
  const operationColumns = db.prepare('PRAGMA table_info(helper_operations)').all();
  if (!operationColumns.some(column => column.name === 'sandbox_id')) {
    db.exec('ALTER TABLE helper_operations ADD COLUMN sandbox_id TEXT');
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
    validateOperation(operation, effectiveConfig, now());
    assertAvailable(operation);
    const requestDigest = digestOperation(operation);
    const existing = db.prepare('SELECT * FROM helper_operations WHERE operation_id = ?').get(operation.operationId);
    if (existing) {
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
        (operation_id, sandbox_id, request_digest, host_epoch, status, updated_at)
        VALUES (?, ?, ?, ?, 'in_progress', ?)`)
        .run(operation.operationId, operation.sandboxId, requestDigest, operation.hostEpoch, now());
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }

    let result;
    let status;
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
  }

  return { execute, close: () => db.close() };
}

export { canonicalOperation };
