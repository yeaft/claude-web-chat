import { access, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { CONFIG } from './config.js';
import {
  checkContainerAgentRuntime,
  createContainerAgent,
  inspectContainerAgent,
  removeContainerAgent,
  startContainerAgent,
  stopContainerAgent,
  writeAgentSecretFile,
} from '../agent/container-manager.js';

const DEFAULT_RUNTIME = Object.freeze({
  check: checkContainerAgentRuntime,
  create: createContainerAgent,
  inspect: inspectContainerAgent,
  remove: removeContainerAgent,
  start: startContainerAgent,
  stop: stopContainerAgent,
  writeSecret: writeAgentSecretFile,
});

function managedName(userId) {
  return `sandbox-${String(userId).replace(/[^a-zA-Z0-9_.-]/g, '-').slice(0, 48)}`;
}

export class ContainerAgentService {
  constructor(config = CONFIG.sandbox, runtime = DEFAULT_RUNTIME) {
    this.config = config;
    this.runtime = runtime;
  }

  async capability() {
    if (!this.config.enabled) {
      return { available: false, reasonCode: 'SANDBOX_DISABLED', catalog: [] };
    }
    try {
      await this.runtime.check();
      return { available: true, reasonCode: null, catalog: [{ id: 'standard' }] };
    } catch {
      return { available: false, reasonCode: 'SANDBOX_DOCKER_UNAVAILABLE', catalog: [] };
    }
  }

  assertEnabled() {
    if (!this.config.enabled) {
      throw Object.assign(new Error('SANDBOX_DISABLED'), { code: 'SANDBOX_DISABLED' });
    }
  }

  nameForUser(userId) {
    return managedName(userId);
  }

  async snapshot(userId) {
    if (!this.config.enabled) return null;
    const name = this.nameForUser(userId);
    const state = await this.runtime.inspect(name);
    if (!state.exists) return null;
    return {
      id: name,
      agentName: name,
      sizeId: 'standard',
      desiredState: state.running ? 'running' : 'stopped',
      observedState: state.running ? 'running' : state.status,
      reservationHeld: true,
      operation: null,
      lastErrorCode: state.error || null,
    };
  }

  async create(user, { agentName } = {}) {
    await this.assertAvailable();
    const name = this.nameForUser(user.id);
    const secretFile = join(this.config.stateDir, name, 'agent-secret');
    await this.runtime.writeSecret(secretFile, user.agent_secret);
    await this.runtime.create({
      name,
      serverUrl: this.config.serverUrl,
      secretFile,
      image: this.config.image,
    });
    return { snapshot: await this.snapshot(user.id), replayed: false };
  }

  async assertAvailable() {
    this.assertEnabled();
    try {
      await this.runtime.check();
    } catch {
      throw Object.assign(new Error('SANDBOX_DOCKER_UNAVAILABLE'), {
        code: 'SANDBOX_DOCKER_UNAVAILABLE',
      });
    }
  }

  // User-visible lifecycle operations are admitted on every request. The
  // feature flag and Docker reachability can change while a browser is open.
  async action(userId, action) {
    await this.assertAvailable();
    const name = this.nameForUser(userId);
    if (action === 'start') await this.runtime.start(name);
    else if (action === 'retry') {
      const current = await this.runtime.inspect(name);
      if (current.exists) await this.runtime.start(name);
      else throw Object.assign(new Error('SANDBOX_NOT_FOUND'), { code: 'SANDBOX_NOT_FOUND' });
    }
    else if (action === 'stop') await this.runtime.stop(name);
    else if (action === 'remove') {
      await this.runtime.remove(name);
      await rm(join(this.config.stateDir, name), { recursive: true, force: true });
    }
    else throw Object.assign(new Error('SANDBOX_ACTION_NOT_ALLOWED'), { code: 'SANDBOX_ACTION_NOT_ALLOWED' });
    return { snapshot: await this.snapshot(userId), replayed: false };
  }

  // Account deletion bypasses public admission only for durable Server-owned
  // resources. No marker means this owner never reached a managed create
  // attempt, so a default deployment without Docker must not probe the daemon.
  async cleanupManagedContainer(userId) {
    const name = this.nameForUser(userId);
    const ownerDir = join(this.config.stateDir, name);
    const marker = join(ownerDir, 'agent-secret');
    try {
      await access(marker);
    } catch (error) {
      if (error?.code === 'ENOENT') return { cleaned: false };
      throw error;
    }
    await this.runtime.remove(name);
    await rm(ownerDir, { recursive: true, force: true });
    return { cleaned: true };
  }
}

export const containerAgentService = new ContainerAgentService();
