import { sandboxDb } from './database.js';
import { agents } from './context.js';

function readClaims(message) {
  const claims = message?.sandboxClaims;
  if (!claims || typeof claims !== 'object') return null;
  if (typeof claims.sandboxId !== 'string' || typeof claims.instanceId !== 'string'
    || !Number.isInteger(claims.generation) || typeof claims.imageDigest !== 'string') {
    return null;
  }
  return claims;
}

/**
 * Authenticate a managed Sandbox Agent without accepting the user's general
 * Agent secret. URL identity and credential scope must describe the same
 * immutable Sandbox instance.
 */
export function authenticateSandboxAgent(message, pending, store = sandboxDb) {
  if (message?.authKind !== 'sandbox' || typeof message.credentialId !== 'string'
    || typeof message.secret !== 'string') {
    return null;
  }
  const claims = readClaims(message);
  if (!claims || pending.instanceId !== claims.instanceId || pending.agentId !== claims.sandboxId) {
    return null;
  }
  try {
    const authenticated = store.authenticateCredential(message.credentialId, message.secret, claims);
    if (authenticated.sandboxId !== claims.sandboxId) return null;
    return {
      ...authenticated,
      instanceId: claims.instanceId,
      generation: claims.generation,
      imageDigest: claims.imageDigest,
      sessionKey: message.secret
    };
  } catch {
    return null;
  }
}

/**
 * Resolve readiness from the authenticated managed Agent connection. Controller
 * booleans are inspection evidence, but cannot prove that the scoped Agent has
 * completed its end-to-end Server sync.
 */
export function canForceReadyAfterSyncTimeout(agent) {
  return !agent?.sandboxIdentity;
}

export function isSandboxAgentReady(identity, connectedAgents = agents) {
  if (!identity) return false;
  for (const agent of connectedAgents.values()) {
    const current = agent.sandboxIdentity;
    if (agent.status === 'ready' && agent.isAlive && current
      && current.sandboxId === identity.sandboxId
      && agent.instanceId === identity.instanceId
      && current.generation === identity.generation
      && current.imageDigest === identity.imageDigest
      && agent.capabilities?.includes('managed-sandbox')) {
      return true;
    }
  }
  return false;
}
