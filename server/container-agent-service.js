import { join } from 'node:path';
import { CONFIG } from './config.js';
import {
  createContainerAgent,
  inspectContainerAgent,
  removeContainerAgent,
  startContainerAgent,
  stopContainerAgent,
  writeAgentSecretFile,
} from '../agent/container-manager.js';

function managedName(userId) {
  return `sandbox-${String(userId).replace(/[^a-zA-Z0-9_.-]/g, '-').slice(0, 48)}`;
}

export class ContainerAgentService {
  constructor(config = CONFIG.sandbox) {
    this.config = config;
  }

  capability() {
    return {
      available: this.config.enabled,
      reasonCode: this.config.enabled ? null : 'SANDBOX_DISABLED',
      catalog: this.config.enabled ? [{ id: 'standard' }] : [],
    };
  }

  nameForUser(userId) {
    return managedName(userId);
  }

  async snapshot(userId) {
    const name = this.nameForUser(userId);
    const state = await inspectContainerAgent(name);
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
    if (!this.config.enabled) throw Object.assign(new Error('SANDBOX_DISABLED'), { code: 'SANDBOX_DISABLED' });
    const name = this.nameForUser(user.id);
    const secretFile = join(this.config.stateDir, name, 'agent-secret');
    await writeAgentSecretFile(secretFile, user.agent_secret);
    await createContainerAgent({
      name,
      serverUrl: this.config.serverUrl,
      secretFile,
      image: this.config.image,
    });
    return { snapshot: await this.snapshot(user.id), replayed: false };
  }

  async action(userId, action) {
    const name = this.nameForUser(userId);
    if (action === 'start') await startContainerAgent(name);
    else if (action === 'retry') {
      const current = await inspectContainerAgent(name);
      if (current.exists) await startContainerAgent(name);
      else throw Object.assign(new Error('SANDBOX_NOT_FOUND'), { code: 'SANDBOX_NOT_FOUND' });
    }
    else if (action === 'stop') await stopContainerAgent(name);
    else if (action === 'remove') await removeContainerAgent(name);
    else throw Object.assign(new Error('SANDBOX_ACTION_NOT_ALLOWED'), { code: 'SANDBOX_ACTION_NOT_ALLOWED' });
    return { snapshot: await this.snapshot(userId), replayed: false };
  }
}

export const containerAgentService = new ContainerAgentService();
