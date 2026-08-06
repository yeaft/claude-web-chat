import { createHmac, timingSafeEqual } from 'crypto';
import db, { transaction } from './db/connection.js';

const HEALTH_FIELDS = Object.freeze([
  'controllerHealthy',
  'helperHealthy',
  'runtimeHealthy',
  'quotaHealthy',
  'networkHealthy'
]);

export class SandboxHostAttestationError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function canonicalPayload(attestation) {
  return JSON.stringify({
    hostId: attestation.hostId,
    epoch: attestation.epoch,
    nonce: attestation.nonce,
    observedAt: attestation.observedAt,
    imageDigest: attestation.imageDigest,
    resources: attestation.resources,
    checks: attestation.checks
  });
}

function validIdentifier(value, maxLength = 128) {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength
    && /^[a-zA-Z0-9._:-]+$/.test(value);
}

function verifySignature(payload, signature, key) {
  if (!key || typeof signature !== 'string') return false;
  const expected = createHmac('sha256', key).update(payload).digest();
  let actual;
  try {
    actual = Buffer.from(signature, 'base64url');
  } catch {
    return false;
  }
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function validateAttestation(attestation, config, now) {
  if (!attestation || !validIdentifier(attestation.hostId) || !validIdentifier(attestation.epoch)
    || !validIdentifier(attestation.nonce, 192) || !validIdentifier(attestation.imageDigest, 192)) {
    throw new SandboxHostAttestationError('SANDBOX_HOST_ATTESTATION_INVALID');
  }
  if (attestation.hostId !== config.controllerHostId
    || attestation.imageDigest !== config.imageDigest) {
    throw new SandboxHostAttestationError('SANDBOX_HOST_ATTESTATION_SCOPE_MISMATCH');
  }
  const observedAt = Number(attestation.observedAt);
  if (!Number.isSafeInteger(observedAt)
    || Math.abs(now - observedAt) > config.hostAttestationMaxSkewMs) {
    throw new SandboxHostAttestationError('SANDBOX_HOST_ATTESTATION_STALE');
  }
  const resources = attestation.resources || {};
  if (![resources.cpuMillis, resources.memoryMiB, resources.memoryAvailableMiB, resources.diskGiB]
    .every(value => Number.isSafeInteger(value) && value > 0)
    || resources.memoryAvailableMiB > resources.memoryMiB) {
    throw new SandboxHostAttestationError('SANDBOX_HOST_ATTESTATION_INVALID');
  }
  if (!verifySignature(canonicalPayload(attestation), attestation.signature, config.hostAttestationKey)) {
    throw new SandboxHostAttestationError('SANDBOX_HOST_ATTESTATION_INVALID');
  }
  return Boolean(attestation.checks)
    && HEALTH_FIELDS.every(field => attestation.checks[field] === true);
}

function appendAudit(attestation, outcome, errorCode, now) {
  db.prepare(`
    INSERT INTO sandbox_host_audit_events (
      host_id, epoch, event_type, outcome, error_code, created_at
    ) VALUES (?, ?, 'qualification_attested', ?, ?, ?)
  `).run(
    String(attestation?.hostId || 'invalid').slice(0, 128),
    String(attestation?.epoch || 'invalid').slice(0, 128),
    outcome,
    errorCode,
    now
  );
}

export function registerSandboxHostAttestation(attestation, config, now = Date.now()) {
  try {
    const qualified = validateAttestation(attestation, config, now);
    return transaction(() => {
      const prior = db.prepare('SELECT nonce FROM sandbox_host_attestations WHERE nonce = ?')
        .get(attestation.nonce);
      if (prior) throw new SandboxHostAttestationError('SANDBOX_HOST_ATTESTATION_REPLAYED');

      const latest = db.prepare(`
        SELECT observed_at FROM sandbox_host_attestations
        WHERE host_id = ? ORDER BY observed_at DESC LIMIT 1
      `).get(attestation.hostId);
      if (latest && Number(attestation.observedAt) <= latest.observed_at) {
        throw new SandboxHostAttestationError('SANDBOX_HOST_ATTESTATION_OUT_OF_ORDER');
      }

      const priorEpoch = db.prepare(`
        SELECT source_epoch, epoch FROM sandbox_host_epochs WHERE host_id = ?
      `).get(attestation.hostId);
      const allocatedEpoch = priorEpoch
        ? priorEpoch.epoch + Number(priorEpoch.source_epoch !== attestation.epoch)
        : 1;
      const { resources, checks } = attestation;
      db.prepare(`
        INSERT INTO sandbox_hosts (
          id, epoch, qualified, controller_healthy, helper_healthy, runtime_healthy,
          quota_healthy, network_healthy, image_digest, cpu_millis_total,
          memory_mib_total, memory_mib_available, disk_gib_total, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          epoch = excluded.epoch,
          qualified = excluded.qualified,
          controller_healthy = excluded.controller_healthy,
          helper_healthy = excluded.helper_healthy,
          runtime_healthy = excluded.runtime_healthy,
          quota_healthy = excluded.quota_healthy,
          network_healthy = excluded.network_healthy,
          image_digest = excluded.image_digest,
          cpu_millis_total = excluded.cpu_millis_total,
          memory_mib_total = excluded.memory_mib_total,
          memory_mib_available = excluded.memory_mib_available,
          disk_gib_total = excluded.disk_gib_total,
          updated_at = excluded.updated_at
      `).run(
        attestation.hostId, allocatedEpoch, Number(qualified),
        Number(checks.controllerHealthy), Number(checks.helperHealthy),
        Number(checks.runtimeHealthy), Number(checks.quotaHealthy), Number(checks.networkHealthy),
        attestation.imageDigest, resources.cpuMillis, resources.memoryMiB,
        resources.memoryAvailableMiB, resources.diskGiB, now
      );
      db.prepare(`
        INSERT INTO sandbox_host_epochs
          (host_id, source_epoch, epoch, activation_digest, activated_at, updated_at)
        VALUES (?, ?, ?, NULL, NULL, ?)
        ON CONFLICT(host_id) DO UPDATE SET
          source_epoch = excluded.source_epoch,
          epoch = excluded.epoch,
          activation_digest = CASE
            WHEN sandbox_host_epochs.epoch = excluded.epoch
              THEN sandbox_host_epochs.activation_digest ELSE NULL END,
          activated_at = CASE
            WHEN sandbox_host_epochs.epoch = excluded.epoch
              THEN sandbox_host_epochs.activated_at ELSE NULL END,
          updated_at = excluded.updated_at
      `).run(attestation.hostId, attestation.epoch, allocatedEpoch, now);
      db.prepare(`
        INSERT INTO sandbox_host_attestations (nonce, host_id, epoch, observed_at, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(attestation.nonce, attestation.hostId, allocatedEpoch, attestation.observedAt, now);
      appendAudit(
        { ...attestation, epoch: allocatedEpoch },
        qualified ? 'accepted' : 'rejected',
        qualified ? null : 'SANDBOX_HOST_NOT_QUALIFIED',
        now
      );
      return { accepted: true, qualified, epoch: allocatedEpoch };
    })();
  } catch (error) {
    const code = error instanceof SandboxHostAttestationError
      ? error.code
      : 'SANDBOX_HOST_ATTESTATION_INVALID';
    appendAudit(attestation, 'rejected', code, now);
    throw error instanceof SandboxHostAttestationError
      ? error
      : new SandboxHostAttestationError(code);
  }
}
