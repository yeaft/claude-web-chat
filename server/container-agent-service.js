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
    this.assertEnabled();
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

  async action(userId, action) {
    const name = this.nameForUser(userId);
    if (action === 'start') await this.runtime.start(name);
    else if (action === 'retry') {
      const current = await this.runtime.inspect(name);
      if (current.exists) await this.runtime.start(name);
      else throw Object.assign(new Error('SANDBOX_NOT_FOUND'), { code: 'SANDBOX_NOT_FOUND' });
    }
    else if (action === 'stop') await this.runtime.stop(name);
    else if (action === 'remove') await this.runtime.remove(name);
    else throw Object.assign(new Error('SANDBOX_ACTION_NOT_ALLOWED'), { code: 'SANDBOX_ACTION_NOT_ALLOWED' });
    return { snapshot: await this.snapshot(userId), replayed: false };
  }
}

export const containerAgentService = new ContainerAgentService();
