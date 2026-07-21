import { describe, expect, it, vi } from 'vitest';
import {
  authenticateSandboxAgent,
  canForceReadyAfterSyncTimeout,
  isSandboxAgentReady
} from '../../server/sandbox-agent-auth.js';

const claims = {
  sandboxId: 'sandbox-1',
  instanceId: 'instance-1',
  generation: 3,
  imageDigest: 'sha256:fixed'
};

function message(overrides = {}) {
  return {
    authKind: 'sandbox',
    credentialId: 'credential-1',
    secret: 'managed-secret',
    sandboxClaims: claims,
    ...overrides
  };
}

const pending = { agentId: 'sandbox-1', instanceId: 'instance-1' };

describe('managed Sandbox Agent authentication', () => {
  it('authenticates a credential only when URL identity and scoped claims match', () => {
    const store = {
      authenticateCredential: vi.fn(() => ({ sandboxId: 'sandbox-1', userId: 'user-1' }))
    };

    expect(authenticateSandboxAgent(message(), pending, store)).toEqual({
      sandboxId: 'sandbox-1',
      userId: 'user-1',
      instanceId: 'instance-1',
      generation: 3,
      imageDigest: 'sha256:fixed',
      sessionKey: 'managed-secret'
    });
    expect(store.authenticateCredential).toHaveBeenCalledWith(
      'credential-1', 'managed-secret', claims
    );
  });

  it('fails closed before credential lookup when Sandbox or instance identity differs', () => {
    const store = { authenticateCredential: vi.fn() };

    expect(authenticateSandboxAgent(message(), { ...pending, agentId: 'sandbox-2' }, store)).toBeNull();
    expect(authenticateSandboxAgent(message(), { ...pending, instanceId: 'instance-2' }, store)).toBeNull();
    expect(store.authenticateCredential).not.toHaveBeenCalled();
  });

  it('does not treat malformed, revoked, or scope-mismatched credentials as authenticated', () => {
    const store = { authenticateCredential: vi.fn(() => { throw new Error('revoked'); }) };

    expect(authenticateSandboxAgent(message({ sandboxClaims: { ...claims, generation: '3' } }), pending, store))
      .toBeNull();
    expect(authenticateSandboxAgent(message(), pending, store)).toBeNull();
  });

  it('does not force a managed Agent ready when sync times out', () => {
    expect(canForceReadyAfterSyncTimeout({ status: 'syncing' })).toBe(true);
    expect(canForceReadyAfterSyncTimeout({
      status: 'syncing',
      sandboxIdentity: {
        sandboxId: claims.sandboxId,
        generation: claims.generation,
        imageDigest: claims.imageDigest
      }
    })).toBe(false);
  });

  it('reports ready only for the exact live managed identity after sync completes', () => {
    const identity = { ...claims };
    const agent = {
      status: 'ready',
      isAlive: true,
      instanceId: claims.instanceId,
      capabilities: ['managed-sandbox'],
      sandboxIdentity: {
        sandboxId: claims.sandboxId,
        generation: claims.generation,
        imageDigest: claims.imageDigest
      }
    };

    expect(isSandboxAgentReady(identity, new Map([['agent', agent]]))).toBe(true);
    expect(isSandboxAgentReady(identity, new Map([['agent', { ...agent, status: 'syncing' }]]))).toBe(false);
    expect(isSandboxAgentReady(identity, new Map([['agent', {
      ...agent,
      sandboxIdentity: { ...agent.sandboxIdentity, generation: claims.generation - 1 }
    }]]))).toBe(false);
  });
});
