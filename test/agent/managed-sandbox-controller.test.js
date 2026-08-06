import { generateKeyPairSync, verify } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  canonicalControllerResult,
  createSandboxController
} from '../../agent/managed-sandbox/controller.js';

const resultKeys = generateKeyPairSync('ed25519');
const resultPrivateKey = resultKeys.privateKey.export({ type: 'pkcs8', format: 'pem' });
const resultPublicKey = resultKeys.publicKey.export({ type: 'spki', format: 'pem' });

function operation(overrides = {}) {
  return {
    operationId: 'op-1',
    hostId: 'dedicated-1',
    sandboxId: 'sandbox-1',
    action: 'create',
    requestDigest: 'request-digest-1',
    generation: 2,
    hostEpoch: 'epoch-1',
    nonce: 'request-nonce',
    ...overrides
  };
}

function controller(helper) {
  const server = {
    listen: vi.fn(),
    close: vi.fn(callback => callback())
  };
  return createSandboxController({
    config: {
      hostId: 'dedicated-1',
      token: 'controller-token',
      tlsCert: 'test-cert',
      tlsKey: 'test-key',
      clientCa: 'test-ca',
      resultSigningPrivateKey: resultPrivateKey
    },
    helper,
    now: () => 1234,
    createServer: vi.fn(() => server)
  });
}

describe('managed Sandbox Controller', () => {
  it('returns a signed result bound to the Helper attestation and request identity', async () => {
    const helperAttestation = { operationId: 'op-1', imageDigest: 'sha256:fixed', signature: 'helper-signature' };
    const helper = { execute: vi.fn(async () => ({ success: true, helperAttestation })) };
    const instance = controller(helper);

    const result = await instance.execute(operation());
    const unsigned = { ...result };
    delete unsigned.signature;

    expect(result).toMatchObject({
      operationId: 'op-1',
      generation: 2,
      hostEpoch: 'epoch-1',
      requestNonce: 'request-nonce',
      issuedAt: 1234,
      success: true,
      imageDigest: 'sha256:fixed',
      helperAttestation
    });
    expect(verify(
      null,
      Buffer.from(canonicalControllerResult(unsigned)),
      resultPublicKey,
      Buffer.from(result.signature, 'base64url')
    )).toBe(true);
    expect(helper.execute).toHaveBeenCalledOnce();
  });

  it('rejects operations for another Host before invoking the privileged Helper', async () => {
    const helper = { execute: vi.fn() };
    const instance = controller(helper);

    await expect(instance.execute(operation({ hostId: 'mixed-use' })))
      .rejects.toThrow('another Host');
    expect(helper.execute).not.toHaveBeenCalled();
  });

  it('fails closed when dedicated Host identity material is incomplete', () => {
    expect(() => createSandboxController({
      config: { hostId: 'dedicated-1', token: 'token' },
      helper: { execute: vi.fn() }
    })).toThrow('complete dedicated Host configuration');
  });
});
