import { createHmac } from 'crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const dataDir = mkdtempSync(join(tmpdir(), 'yeaft-sandbox-host-'));
process.env.SERVER_DATA_DIR = dataDir;

let db;
let registerSandboxHostAttestation;

beforeAll(async () => {
  ({ default: db } = await import('../../server/db/connection.js'));
  ({ registerSandboxHostAttestation } = await import('../../server/sandbox-host-attestation.js'));
});

afterAll(() => {
  try { db.close(); } catch {}
  rmSync(dataDir, { recursive: true, force: true });
});

function config(overrides = {}) {
  return {
    controllerHostId: 'dedicated-1',
    imageDigest: 'sha256:fixed',
    hostAttestationKey: 'host-attestation-secret',
    hostAttestationMaxSkewMs: 30_000,
    ...overrides
  };
}

function signedAttestation(overrides = {}, key = 'host-attestation-secret') {
  const attestation = {
    hostId: 'dedicated-1',
    epoch: 'epoch-1',
    nonce: 'nonce-1',
    observedAt: 100_000,
    imageDigest: 'sha256:fixed',
    resources: { cpuMillis: 2000, memoryMiB: 4096, memoryAvailableMiB: 3072, diskGiB: 40 },
    checks: {
      controllerHealthy: true,
      helperHealthy: true,
      runtimeHealthy: true,
      quotaHealthy: true,
      networkHealthy: true
    },
    ...overrides
  };
  const payload = JSON.stringify({
    hostId: attestation.hostId,
    epoch: attestation.epoch,
    nonce: attestation.nonce,
    observedAt: attestation.observedAt,
    imageDigest: attestation.imageDigest,
    resources: attestation.resources,
    checks: attestation.checks
  });
  attestation.signature = createHmac('sha256', key).update(payload).digest('base64url');
  return attestation;
}

describe('sandbox Host qualification attestation', () => {
  it('registers only a correctly scoped, signed, fully healthy dedicated Host', () => {
    const result = registerSandboxHostAttestation(signedAttestation(), config(), 100_500);

    expect(result).toEqual({ accepted: true, qualified: true, epoch: 1 });
    expect(db.prepare(`
      SELECT id, epoch, qualified, helper_healthy, image_digest, cpu_millis_total,
        memory_mib_available
      FROM sandbox_hosts WHERE id = 'dedicated-1'
    `).get()).toEqual({
      id: 'dedicated-1', epoch: 1, qualified: 1, helper_healthy: 1,
      image_digest: 'sha256:fixed', cpu_millis_total: 2000, memory_mib_available: 3072
    });
    expect(db.prepare(`
      SELECT event_type, outcome, error_code FROM sandbox_host_audit_events
      ORDER BY id DESC LIMIT 1
    `).get()).toEqual({
      event_type: 'qualification_attested', outcome: 'accepted', error_code: null
    });
  });

  it('immediately dequalifies a Host when a newer signed observation reports a failed check', () => {
    registerSandboxHostAttestation(signedAttestation({
      nonce: 'healthy-before-failure', epoch: 'epoch-healthy', observedAt: 105_000
    }), config(), 105_500);

    const result = registerSandboxHostAttestation(signedAttestation({
      nonce: 'new-unhealthy', epoch: 'epoch-unhealthy', observedAt: 106_000,
      checks: {
        controllerHealthy: true, helperHealthy: false, runtimeHealthy: true,
        quotaHealthy: true, networkHealthy: true
      }
    }), config(), 106_500);

    expect(result).toEqual({ accepted: true, qualified: false, epoch: 3 });
    expect(db.prepare(`
      SELECT epoch, qualified, helper_healthy, updated_at
      FROM sandbox_hosts WHERE id = 'dedicated-1'
    `).get()).toEqual({
      epoch: 3, qualified: 0, helper_healthy: 0, updated_at: 106_500
    });
    expect(db.prepare(`
      SELECT outcome, error_code FROM sandbox_host_audit_events
      ORDER BY id DESC LIMIT 1
    `).get()).toEqual({
      outcome: 'rejected', error_code: 'SANDBOX_HOST_NOT_QUALIFIED'
    });
  });

  it('rejects an attestation older than the latest accepted Host observation', () => {
    registerSandboxHostAttestation(signedAttestation({
      nonce: 'ordered-new', epoch: 'epoch-2', observedAt: 110_000
    }), config(), 110_500);

    expect(() => registerSandboxHostAttestation(signedAttestation({
      nonce: 'ordered-old', epoch: 'epoch-1', observedAt: 109_000,
      resources: { cpuMillis: 1000, memoryMiB: 2048, memoryAvailableMiB: 1024, diskGiB: 20 }
    }), config(), 110_500)).toThrowError(
      expect.objectContaining({ code: 'SANDBOX_HOST_ATTESTATION_OUT_OF_ORDER' })
    );
    expect(db.prepare(`
      SELECT epoch, cpu_millis_total, updated_at FROM sandbox_hosts WHERE id = 'dedicated-1'
    `).get()).toEqual({ epoch: 4, cpu_millis_total: 2000, updated_at: 110_500 });
  });

  it('rejects missing or impossible available-memory samples', () => {
    expect(() => registerSandboxHostAttestation(signedAttestation({
      nonce: 'missing-available-memory', observedAt: 120_000,
      resources: { cpuMillis: 2000, memoryMiB: 4096, diskGiB: 40 }
    }), config(), 120_500)).toThrowError(
      expect.objectContaining({ code: 'SANDBOX_HOST_ATTESTATION_INVALID' })
    );
    expect(() => registerSandboxHostAttestation(signedAttestation({
      nonce: 'impossible-available-memory', observedAt: 121_000,
      resources: { cpuMillis: 2000, memoryMiB: 4096, memoryAvailableMiB: 4097, diskGiB: 40 }
    }), config(), 121_500)).toThrowError(
      expect.objectContaining({ code: 'SANDBOX_HOST_ATTESTATION_INVALID' })
    );
  });

  it('rejects stale, wrong-image, invalid-signature, and replayed attestations', () => {
    const cases = [
      signedAttestation({ nonce: 'stale', observedAt: 1 }),
      signedAttestation({ nonce: 'wrong-image', imageDigest: 'sha256:other' }),
      signedAttestation({ nonce: 'bad-signature' }, 'wrong-key')
    ];

    for (const attestation of cases) {
      expect(() => registerSandboxHostAttestation(attestation, config(), 100_500)).toThrow();
    }
    expect(() => registerSandboxHostAttestation(signedAttestation(), config(), 100_500)).toThrowError(
      expect.objectContaining({ code: 'SANDBOX_HOST_ATTESTATION_REPLAYED' })
    );
    expect(db.prepare(`
      SELECT COUNT(*) AS count FROM sandbox_hosts WHERE id != 'dedicated-1'
    `).get().count).toBe(0);
    expect(db.prepare(`
      SELECT COUNT(*) AS count FROM sandbox_host_audit_events WHERE outcome = 'rejected'
    `).get().count).toBe(8);
  });
});
