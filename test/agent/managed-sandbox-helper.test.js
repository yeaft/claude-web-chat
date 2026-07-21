import { generateKeyPairSync, sign, verify } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { canonicalOperation, createSandboxHelper } from '../../agent/managed-sandbox/helper.js';

const keys = generateKeyPairSync('ed25519');
const privateKey = keys.privateKey.export({ type: 'pkcs8', format: 'pem' });
const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' });
const attestationKeys = generateKeyPairSync('ed25519');
const attestationPrivateKey = attestationKeys.privateKey.export({ type: 'pkcs8', format: 'pem' });
const attestationPublicKey = attestationKeys.publicKey.export({ type: 'spki', format: 'pem' });
const roots = [];

function signedOperation(overrides = {}) {
  const issuedAt = Date.now();
  const operation = {
    protocolVersion: 1,
    operationId: 'op-1',
    hostId: 'dedicated-1',
    sandboxId: 'sandbox-1',
    action: 'create',
    generation: 1,
    hostEpoch: 'epoch-1',
    instanceId: 'instance-1',
    imageDigest: 'sha256:fixed',
    desiredState: 'running',
    issuedAt,
    expiresAt: issuedAt + 10_000,
    nonce: 'nonce-1',
    bootstrap: null,
    resources: { cpuMillis: 500, memoryMiB: 1024, diskGiB: 10 },
    ...overrides
  };
  operation.signature = sign(null, Buffer.from(canonicalOperation(operation)), privateKey).toString('base64url');
  return operation;
}

function successfulRuntimeResult() {
  return {
    success: true,
    readinessProof: {
      image: true,
      cpu: true,
      memory: true,
      pid: true,
      io: true,
      quota: true,
      network: true,
      credential: true
    },
    resourceInspection: {
      cpuMillis: 500,
      memoryMiB: 1024,
      diskGiB: 10,
      pidsLimit: 128,
      ioWeight: 100,
      quotaHard: true,
      networkPolicy: 'public-egress-isolated'
    }
  };
}

function helper(executor = { execute: vi.fn(async () => successfulRuntimeResult()) }) {
  const root = mkdtempSync(join(tmpdir(), 'yeaft-sandbox-helper-'));
  roots.push(root);
  return {
    executor,
    instance: createSandboxHelper({
      config: {
        hostId: 'dedicated-1',
        hostEpoch: 'epoch-1',
        imageDigest: 'sha256:fixed',
        operationSigningPublicKey: publicKey,
        attestationSigningPrivateKey: attestationPrivateKey,
        journalPath: join(root, 'helper.db')
      },
      executor
    }),
    root
  };
}

afterEach(() => {
  while (roots.length) rmSync(roots.pop(), { recursive: true, force: true });
});

describe('managed Sandbox Helper authorization boundary', () => {
  it('executes an allowlisted signed operation once and durably replays its result', async () => {
    const { instance, executor } = helper();
    const operation = signedOperation();

    const first = await instance.execute(operation);
    const replay = await instance.execute(operation);

    expect(first.success).toBe(true);
    expect(replay).toEqual(first);
    expect(first.helperAttestation).toMatchObject({
      operationId: operation.operationId,
      sandboxId: operation.sandboxId,
      requestNonce: operation.nonce,
      imageDigest: operation.imageDigest
    });
    const unsigned = { ...first.helperAttestation };
    delete unsigned.signature;
    expect(verify(
      null,
      Buffer.from(JSON.stringify(unsigned)),
      attestationPublicKey,
      Buffer.from(first.helperAttestation.signature, 'base64url')
    )).toBe(true);
    expect(executor.execute).toHaveBeenCalledOnce();
    instance.close();
  });

  it('rejects tampering, wrong Host identity, expired requests, and operation ID reuse', async () => {
    const { instance, executor } = helper();
    const valid = signedOperation();
    await instance.execute(valid);

    await expect(instance.execute({ ...valid, memoryMiB: 2048, resources: { ...valid.resources, memoryMiB: 2048 } }))
      .rejects.toThrow('signature');
    await expect(instance.execute(signedOperation({ operationId: 'op-2', hostId: 'mixed-use' })))
      .rejects.toThrow('invalid operation envelope');
    await expect(instance.execute(signedOperation({ operationId: 'op-3', expiresAt: Date.now() - 1 })))
      .rejects.toThrow('invalid operation envelope');
    await expect(instance.execute(signedOperation({ desiredState: 'stopped' })))
      .rejects.toThrow('operation ID reuse');

    expect(executor.execute).toHaveBeenCalledOnce();
    instance.close();
  });

  it('accepts signed Retry operations and fences operations from another Host epoch', async () => {
    const { instance, executor } = helper();

    await expect(instance.execute(signedOperation({ action: 'retry' })))
      .resolves.toMatchObject({ success: true, helperAttestation: { action: 'retry' } });
    await expect(instance.execute(signedOperation({
      operationId: 'op-2',
      hostEpoch: 'epoch-2',
      nonce: 'nonce-2'
    }))).rejects.toThrow('invalid operation envelope');

    expect(executor.execute).toHaveBeenCalledOnce();
    instance.close();
  });

  it('fails closed when the executor cannot prove the requested resource policy', async () => {
    const executor = { execute: vi.fn(async () => ({
      ...successfulRuntimeResult(),
      resourceInspection: { ...successfulRuntimeResult().resourceInspection, quotaHard: false }
    })) };
    const { instance } = helper(executor);

    const result = await instance.execute(signedOperation());

    expect(result).toMatchObject({
      success: false,
      errorCode: 'SANDBOX_HELPER_EXECUTION_FAILED',
      helperAttestation: { readinessProof: null, resourceInspection: null }
    });
    instance.close();
  });

  it('emits the control-plane readiness proof schema and rejects missing proof fields', async () => {
    const accepted = helper();
    const result = await accepted.instance.execute(signedOperation());

    expect(result.helperAttestation.readinessProof).toEqual({
      image: true,
      cpu: true,
      memory: true,
      pid: true,
      io: true,
      quota: true,
      network: true,
      credential: true
    });
    accepted.instance.close();

    const rejected = helper({ execute: vi.fn(async () => {
      const runtimeResult = successfulRuntimeResult();
      delete runtimeResult.readinessProof.credential;
      return runtimeResult;
    }) });
    await expect(rejected.instance.execute(signedOperation())).resolves.toMatchObject({
      success: false,
      errorCode: 'SANDBOX_HELPER_EXECUTION_FAILED',
      helperAttestation: { readinessProof: null }
    });
    rejected.instance.close();
  });

  it('only signs Remove success after complete absence proof', async () => {
    const incomplete = helper({ execute: vi.fn(async () => ({
      success: true,
      absenceProof: { container: true, storage: true, quota: true, network: true }
    })) });
    const rejected = await incomplete.instance.execute(signedOperation({
      action: 'remove', imageDigest: null, resources: null
    }));
    expect(rejected.success).toBe(false);
    incomplete.instance.close();

    const complete = helper({ execute: vi.fn(async () => ({
      success: true,
      absenceProof: { container: true, storage: true, quota: true, network: true, credential: true }
    })) });
    const accepted = await complete.instance.execute(signedOperation({
      operationId: 'op-remove', action: 'remove', imageDigest: null, resources: null, nonce: 'remove-nonce'
    }));
    expect(accepted).toMatchObject({
      success: true,
      helperAttestation: {
        action: 'remove',
        readinessProof: null,
        absenceProof: { credential: true }
      }
    });
    complete.instance.close();
  });

  it('retains the configured Host epoch fence across Helper restarts', async () => {
    const { instance, executor, root } = helper();
    await instance.execute(signedOperation());
    instance.close();

    const restartedExecutor = { execute: vi.fn(async () => ({ success: true })) };
    const restarted = createSandboxHelper({
      config: {
        hostId: 'dedicated-1', hostEpoch: 'epoch-1', imageDigest: 'sha256:fixed',
        operationSigningPublicKey: publicKey, attestationSigningPrivateKey: attestationPrivateKey,
        journalPath: join(root, 'helper.db')
      },
      executor: restartedExecutor
    });

    await expect(restarted.execute(signedOperation({
      operationId: 'op-2',
      hostEpoch: 'epoch-2',
      nonce: 'nonce-2'
    }))).rejects.toThrow('invalid operation envelope');
    expect(restartedExecutor.execute).not.toHaveBeenCalled();
    expect(executor.execute).toHaveBeenCalledOnce();
    restarted.close();
  });

  it('fails closed after restart finds an interrupted privileged operation', async () => {
    const { instance, root } = helper();
    instance.close();
    const journalPath = join(root, 'helper.db');
    const db = new DatabaseSync(journalPath);
    db.prepare(`INSERT INTO helper_operations
      (operation_id, request_digest, host_epoch, status, updated_at)
      VALUES ('interrupted', 'digest', 'epoch-1', 'in_progress', 1)`).run();
    db.close();

    const restarted = createSandboxHelper({
      config: {
        hostId: 'dedicated-1', hostEpoch: 'epoch-1', imageDigest: 'sha256:fixed',
        operationSigningPublicKey: publicKey, attestationSigningPrivateKey: attestationPrivateKey,
        journalPath
      },
      executor: { execute: vi.fn() }
    });

    await expect(restarted.execute(signedOperation({ operationId: 'op-new' })))
      .rejects.toThrow('operator recovery');
    restarted.close();
  });

  it('allows a signed Remove to recover only the Sandbox with an interrupted operation', async () => {
    const { instance, root } = helper();
    instance.close();
    const journalPath = join(root, 'helper.db');
    const db = new DatabaseSync(journalPath);
    db.prepare(`INSERT INTO helper_operations
      (operation_id, sandbox_id, request_digest, host_epoch, status, updated_at)
      VALUES ('interrupted', 'sandbox-1', 'digest', 'epoch-1', 'in_progress', 1)`).run();
    db.close();

    const executor = { execute: vi.fn(async () => ({
      success: true,
      absenceProof: { container: true, storage: true, quota: true, network: true, credential: true }
    })) };
    const restarted = createSandboxHelper({
      config: {
        hostId: 'dedicated-1', hostEpoch: 'epoch-1', imageDigest: 'sha256:fixed',
        operationSigningPublicKey: publicKey, attestationSigningPrivateKey: attestationPrivateKey,
        journalPath
      },
      executor
    });

    await expect(restarted.execute(signedOperation({ operationId: 'op-start' })))
      .rejects.toThrow('operator recovery');
    await expect(restarted.execute(signedOperation({
      operationId: 'op-remove', action: 'remove', imageDigest: null, resources: null, nonce: 'remove-nonce'
    }))).resolves.toMatchObject({ success: true, helperAttestation: { action: 'remove' } });
    expect(executor.execute).toHaveBeenCalledOnce();
    restarted.close();
  });
});
