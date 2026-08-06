import { generateKeyPairSync, sign, verify } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { createSandboxReconciler, validateControllerConfig } from '../../server/sandbox-reconciler.js';
import { CONFIG, validateProductionConfig } from '../../server/config.js';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const operationKeys = generateKeyPairSync('ed25519');
const controllerResultKeys = generateKeyPairSync('ed25519');
const operationSigningPrivateKey = operationKeys.privateKey.export({ type: 'pkcs8', format: 'pem' });
const operationSigningPublicKey = operationKeys.publicKey.export({ type: 'spki', format: 'pem' });
const controllerResultPrivateKey = controllerResultKeys.privateKey.export({ type: 'pkcs8', format: 'pem' });
const controllerResultPublicKey = controllerResultKeys.publicKey.export({ type: 'spki', format: 'pem' });
const helperAttestationKeys = generateKeyPairSync('ed25519');
const helperAttestationPrivateKey = helperAttestationKeys.privateKey.export({ type: 'pkcs8', format: 'pem' });
const helperAttestationPublicKey = helperAttestationKeys.publicKey.export({ type: 'spki', format: 'pem' });

const operation = {
  id: 'op-1',
  sandbox_id: 'sandbox-1',
  host_id: 'dedicated-1',
  kind: 'create',
  request_digest: 'request-digest-1',
  generation: 1,
  host_epoch: 'epoch-1',
  instance_id: 'instance-1',
  image_digest: 'sha256:fixed',
  desired_state: 'running',
  cpu_millis: 500,
  memory_mib: 1024,
  disk_gib: 10
};

function config(overrides = {}) {
  return {
    enabled: true,
    controllerUrl: 'https://controller.example',
    controllerToken: 'controller-secret',
    controllerClientCert: 'test-client-cert',
    controllerClientKey: 'test-client-key',
    controllerCaCert: 'test-controller-ca',
    operationSigningPrivateKey,
    controllerResultPublicKey,
    controllerProtocolMaxSkewMs: 30_000,
    controllerHostId: 'dedicated-1',
    bootstrapSigningKey: 'test-bootstrap-signing-key',
    hostAttestationKey: 'test-host-attestation-key',
    controllerAttestationFingerprint: 'AA:BB:CC',
    helperAttestationPublicKey,
    imageDigest: 'sha256:fixed',
    hostMemoryReserveMiB: 512,
    ...overrides
  };
}

function signedHelperAttestation(request, overrides = {}) {
  const attestation = {
    protocolVersion: 1,
    operationId: request.operationId,
    hostId: request.hostId,
    sandboxId: request.sandboxId,
    action: request.action,
    requestDigest: request.requestDigest,
    generation: request.generation,
    hostEpoch: request.hostEpoch,
    requestNonce: request.nonce,
    issuedAt: Date.now(),
    imageDigest: request.imageDigest,
    readinessProof: null,
    absenceProof: null,
    resourceInspection: request.action === 'remove' ? null : {
      cpuMillis: request.resources.cpuMillis,
      memoryMiB: request.resources.memoryMiB,
      diskGiB: request.resources.diskGiB,
      pidsLimit: 256,
      ioWeight: 100,
      quotaHard: true,
      networkPolicy: 'public-egress-isolated'
    },
    ...overrides
  };
  attestation.signature = sign(null, Buffer.from(JSON.stringify({
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
  })), helperAttestationPrivateKey).toString('base64url');
  return attestation;
}

function signedResult(request, overrides = {}) {
  const helperOverrides = {
    readinessProof: overrides.readinessProof || null,
    absenceProof: overrides.absenceProof || null,
    ...(overrides.helperAttestationOverrides || {})
  };
  const helperAttestation = signedHelperAttestation(request, helperOverrides);
  if (overrides.invalidHelperSignature) helperAttestation.signature = 'invalid';
  const result = {
    operationId: request.operationId,
    action: request.action,
    hostId: request.hostId,
    sandboxId: request.sandboxId,
    requestDigest: request.requestDigest,
    generation: request.generation,
    hostEpoch: request.hostEpoch,
    requestNonce: request.nonce,
    issuedAt: Date.now(),
    success: true,
    imageDigest: request.imageDigest,
    helperAttestation,
    errorCode: null,
    ...overrides
  };
  delete result.readinessProof;
  delete result.absenceProof;
  delete result.helperAttestationOverrides;
  delete result.invalidHelperSignature;
  result.signature = sign(null, Buffer.from(JSON.stringify({
    operationId: result.operationId,
    action: result.action,
    hostId: result.hostId,
    sandboxId: result.sandboxId,
    requestDigest: result.requestDigest,
    generation: result.generation,
    hostEpoch: result.hostEpoch,
    requestNonce: result.requestNonce,
    issuedAt: result.issuedAt,
    success: result.success,
    imageDigest: result.imageDigest || null,
    helperAttestation: result.helperAttestation || null,
    errorCode: result.errorCode || null
  })), controllerResultPrivateKey).toString('base64url');
  return result;
}

describe('sandbox reconciler', () => {
  it('loads production config in a fresh process without relying on CommonJS globals', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'yeaft-sandbox-config-'));
    try {
      const result = spawnSync(process.execPath, ['--input-type=module', '-e', "await import('./server/config.js'); process.exit(0)"], {
        cwd: repoRoot,
        env: {
          ...process.env,
          NODE_ENV: 'test',
          TEST_DB_DIR: dataDir,
          TEST_DB_PATH: join(dataDir, 'webchat.db')
        },
        encoding: 'utf8'
      });
      expect(result.status, result.stderr).toBe(0);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('stays disabled unless a complete HTTPS dedicated Controller config exists', () => {
    expect(validateControllerConfig(config({ enabled: false }))).toBe(false);
    expect(validateControllerConfig(config({ controllerUrl: 'http://controller.example' }))).toBe(false);
    expect(validateControllerConfig(config({ controllerToken: '' }))).toBe(false);
    expect(validateControllerConfig(config({ controllerClientCert: '' }))).toBe(false);
    expect(validateControllerConfig(config({ controllerClientKey: '' }))).toBe(false);
    expect(validateControllerConfig(config({ controllerCaCert: '' }))).toBe(false);
    expect(validateControllerConfig(config({ operationSigningPrivateKey: '' }))).toBe(false);
    expect(validateControllerConfig(config({ controllerResultPublicKey: '' }))).toBe(false);
    expect(validateControllerConfig(config({ bootstrapSigningKey: '' }))).toBe(false);
    expect(validateControllerConfig(config({ hostAttestationKey: '' }))).toBe(false);
    expect(validateControllerConfig(config({ controllerAttestationFingerprint: '' }))).toBe(false);
    expect(validateControllerConfig(config({ helperAttestationPublicKey: '' }))).toBe(false);
    expect(validateControllerConfig(config({ imageDigest: '' }))).toBe(false);
    expect(validateControllerConfig(config({ controllerHostId: '' }))).toBe(false);
    expect(validateControllerConfig(config({ hostMemoryReserveMiB: 0 }))).toBe(false);
    expect(validateControllerConfig(config())).toBe(true);
  });

  it('blocks production startup when Sandbox is enabled without its dedicated deployment gate', () => {
    const previous = {
      skipAuth: CONFIG.skipAuth,
      jwtSecret: CONFIG.jwtSecret,
      sandbox: CONFIG.sandbox
    };
    try {
      CONFIG.skipAuth = false;
      CONFIG.jwtSecret = 'test-production-jwt-secret';
      CONFIG.sandbox = config({ controllerHostId: '' });
      expect(validateProductionConfig()).toEqual(expect.objectContaining({
        valid: false,
        errors: expect.arrayContaining([expect.stringContaining('Sandbox requires')])
      }));
      CONFIG.sandbox = config();
      expect(validateProductionConfig().errors || []).not.toContainEqual(
        expect.stringContaining('Sandbox requires')
      );
    } finally {
      Object.assign(CONFIG, previous);
    }
  });

  it('expires persisted operations even when Controller configuration is unavailable', async () => {
    const store = {
      listPendingOperations: vi.fn(() => []),
      reconcileRuntimeState: vi.fn(),
      applyControllerResult: vi.fn()
    };
    await createSandboxReconciler({
      config: config({ controllerToken: '' }), store, fetchImpl: vi.fn()
    }).tick(4321);
    expect(store.listPendingOperations).toHaveBeenCalledWith(4321);
    expect(store.reconcileRuntimeState).toHaveBeenCalledWith(
      4321,
      expect.objectContaining({ enabled: true }),
      expect.objectContaining({ isAgentReady: expect.any(Function) })
    );
  });

  it('does not dispatch an operation invalidated by runtime reconciliation', async () => {
    let invalidated = false;
    const store = {
      reconcileRuntimeState: vi.fn(() => {
        invalidated = true;
      }),
      listPendingOperations: vi.fn(() => invalidated ? [] : [operation]),
      issueBootstrap: vi.fn(),
      applyControllerResult: vi.fn()
    };
    const fetchImpl = vi.fn();

    await createSandboxReconciler({ config: config(), store, fetchImpl }).tick(1234);

    expect(store.reconcileRuntimeState).toHaveBeenCalledWith(
      1234,
      expect.objectContaining({ enabled: true }),
      expect.objectContaining({ isAgentReady: expect.any(Function) })
    );
    expect(store.listPendingOperations).toHaveBeenCalledWith(1234);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(store.issueBootstrap).not.toHaveBeenCalled();
  });

  it('dispatches persisted operations and applies fenced Controller results', async () => {
    const store = {
      listPendingOperations: vi.fn(() => [operation]),
      issueBootstrap: vi.fn(() => ({
        token: 'one-time-token', sandboxId: 'sandbox-1', instanceId: 'instance-1',
        generation: 1, imageDigest: 'sha256:fixed', expiresAt: 9999
      })),
      applyControllerResult: vi.fn()
    };
    const fetchImpl = vi.fn(async (url, request) => {
      const body = JSON.parse(request.body);
      return {
        ok: true,
        json: async () => signedResult(body, {
          readinessProof: {
            image: true, cpu: true, memory: true, pid: true, io: true,
            quota: true, network: true, credential: true, agentHeartbeat: true, endToEnd: true
          }
        })
      };
    });

    const reconciler = createSandboxReconciler({ config: config(), store, fetchImpl });
    await reconciler.tick(1234);

    expect(store.listPendingOperations).toHaveBeenCalledWith(1234);
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(fetchImpl.mock.calls[0][0].toString()).toBe('https://controller.example/v1/operations');
    const request = fetchImpl.mock.calls[0][1];
    expect(request.headers.authorization).toBe('Bearer controller-secret');
    expect(request).toMatchObject({
      cert: 'test-client-cert',
      key: 'test-client-key',
      ca: 'test-controller-ca'
    });
    const dispatched = JSON.parse(request.body);
    expect(dispatched).toMatchObject({
      protocolVersion: 1,
      operationId: 'op-1', hostId: 'dedicated-1', sandboxId: 'sandbox-1', hostEpoch: 'epoch-1',
      bootstrap: { token: 'one-time-token', instanceId: 'instance-1' },
      resources: { cpuMillis: 500, memoryMiB: 1024, diskGiB: 10 },
      nonce: expect.any(String),
      signature: expect.any(String)
    });
    const { signature: operationSignature, ...unsignedEnvelope } = dispatched;
    expect(verify(
      null,
      Buffer.from(JSON.stringify({
        protocolVersion: unsignedEnvelope.protocolVersion,
        operationId: unsignedEnvelope.operationId,
        hostId: unsignedEnvelope.hostId,
        sandboxId: unsignedEnvelope.sandboxId,
        action: unsignedEnvelope.action,
        requestDigest: unsignedEnvelope.requestDigest,
        generation: unsignedEnvelope.generation,
        hostEpoch: unsignedEnvelope.hostEpoch,
        instanceId: unsignedEnvelope.instanceId,
        imageDigest: unsignedEnvelope.imageDigest,
        desiredState: unsignedEnvelope.desiredState,
        issuedAt: unsignedEnvelope.issuedAt,
        expiresAt: unsignedEnvelope.expiresAt,
        nonce: unsignedEnvelope.nonce,
        bootstrap: unsignedEnvelope.bootstrap || null,
        resources: unsignedEnvelope.resources
      })),
      operationSigningPublicKey,
      Buffer.from(operationSignature, 'base64url')
    )).toBe(true);
    expect(store.issueBootstrap).toHaveBeenCalledWith(
      'op-1', undefined, 'test-bootstrap-signing-key'
    );
    expect(store.applyControllerResult).toHaveBeenCalledWith(
      expect.objectContaining({ operationId: 'op-1', success: true }),
      expect.objectContaining({ enabled: true }),
      expect.objectContaining({ isAgentReady: expect.any(Function) })
    );
  });

  it('reuses the persisted bootstrap when Controller dispatch is retried', async () => {
    const store = {
      listPendingOperations: vi.fn(() => [operation]),
      issueBootstrap: vi.fn(() => ({ token: 'stable-one-time-token' })),
      applyControllerResult: vi.fn(() => {
        throw new Error('Agent has not connected yet');
      })
    };
    const fetchImpl = vi.fn(async (url, request) => ({
      ok: true,
      json: async () => signedResult(JSON.parse(request.body))
    }));
    const logger = { warn: vi.fn() };
    const reconciler = createSandboxReconciler({ config: config(), store, fetchImpl, logger });

    await reconciler.tick();
    await reconciler.tick();

    const requests = fetchImpl.mock.calls.map(([, request]) => JSON.parse(request.body));
    expect(requests).toHaveLength(2);
    expect(requests[0].bootstrap.token).toBe('stable-one-time-token');
    expect(requests[1].bootstrap.token).toBe('stable-one-time-token');
    expect(store.issueBootstrap).toHaveBeenCalledTimes(2);
  });

  it('rejects Controller claims that are not backed by a valid Helper attestation', async () => {
    const store = {
      listPendingOperations: vi.fn(() => [operation]),
      issueBootstrap: vi.fn(() => ({ token: 'one-time-token' })),
      applyControllerResult: vi.fn()
    };
    const fetchImpl = vi.fn(async (url, request) => {
      const body = JSON.parse(request.body);
      return {
        ok: true,
        json: async () => signedResult(body, {
          readinessProof: {
            image: true, cpu: true, memory: true, pid: true, io: true,
            quota: true, network: true, credential: true
          },
          invalidHelperSignature: true
        })
      };
    });
    const logger = { warn: vi.fn() };

    await createSandboxReconciler({ config: config(), store, fetchImpl, logger }).tick();

    expect(store.applyControllerResult).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Helper attestation signature'));
  });

  it('rejects signed Helper claims that do not match the reserved resource policy', async () => {
    const store = {
      listPendingOperations: vi.fn(() => [operation]),
      issueBootstrap: vi.fn(() => ({ token: 'one-time-token' })),
      applyControllerResult: vi.fn()
    };
    const fetchImpl = vi.fn(async (url, request) => {
      const body = JSON.parse(request.body);
      return {
        ok: true,
        json: async () => signedResult(body, {
          readinessProof: {
            image: true, cpu: true, memory: true, pid: true, io: true,
            quota: true, network: true, credential: true
          },
          helperAttestationOverrides: {
            resourceInspection: {
              cpuMillis: 250,
              memoryMiB: body.resources.memoryMiB,
              diskGiB: body.resources.diskGiB,
              pidsLimit: 256,
              ioWeight: 100,
              quotaHard: true,
              networkPolicy: 'public-egress-isolated'
            }
          }
        })
      };
    });
    const logger = { warn: vi.fn() };

    await createSandboxReconciler({ config: config(), store, fetchImpl, logger }).tick();

    expect(store.applyControllerResult).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('resource policy'));
  });

  it('rejects unsigned or replayed Controller results', async () => {
    const store = {
      listPendingOperations: vi.fn(() => [operation]),
      issueBootstrap: vi.fn(() => ({ token: 'one-time-token' })),
      applyControllerResult: vi.fn()
    };
    const fetchImpl = vi.fn(async (url, request) => {
      const body = JSON.parse(request.body);
      return {
        ok: true,
        json: async () => signedResult(body, {
          requestNonce: 'nonce-from-another-request',
          signature: 'invalid'
        })
      };
    });
    const logger = { warn: vi.fn() };

    await createSandboxReconciler({ config: config(), store, fetchImpl, logger }).tick();

    expect(store.applyControllerResult).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('mismatched operation result'));
  });

  it('does not settle another operation or dispatch work assigned to another Host', async () => {
    const logger = { warn: vi.fn() };
    const store = {
      listPendingOperations: vi.fn(() => [operation, { ...operation, id: 'op-2', host_id: 'dedicated-2' }]),
      issueBootstrap: vi.fn(() => ({ token: 'one-time-token' })),
      applyControllerResult: vi.fn()
    };
    const fetchImpl = vi.fn(async (url, request) => ({
      ok: true,
      json: async () => signedResult(JSON.parse(request.body), { operationId: 'wrong-operation' })
    }));

    await createSandboxReconciler({ config: config(), store, fetchImpl, logger }).tick();

    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(store.applyControllerResult).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('mismatched operation'));
  });
});
