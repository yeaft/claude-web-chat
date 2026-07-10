import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { WorkItemStore } from './store.js';
import { WorkflowController } from './controller.js';
import { WorkItemWatcher } from './watcher.js';
import { projectWorkItemSummary } from './projection.js';
import { readWorkCenterSettings, writeWorkCenterSettings } from './settings.js';
import { resolveWorkflowSnapshot } from './workflow.js';

function requiredString(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required`);
  return value.trim();
}

export class WorkCenterService {
  constructor(options) {
    const yeaftDir = requiredString(options?.yeaftDir, 'yeaftDir');
    this.yeaftDir = yeaftDir;
    this.settingsReader = options.settingsReader || readWorkCenterSettings;
    this.settingsWriter = options.settingsWriter || writeWorkCenterSettings;
    this.runtimeInfoProvider = typeof options.runtimeInfoProvider === 'function'
      ? options.runtimeInfoProvider
      : async () => ({ vps: [], models: [], primaryModel: null, fastModel: null });
    this.ownerBootId = options.ownerBootId || randomUUID();
    this.store = options.store || new WorkItemStore(join(yeaftDir, 'work-center', 'work-center.db'));
    this.controller = options.controller || new WorkflowController(this.store);
    this.onEvent = typeof options.onEvent === 'function' ? options.onEvent : () => {};
    this.watcher = new WorkItemWatcher({
      store: this.store,
      controller: this.controller,
      runner: options.runner,
      ownerBootId: this.ownerBootId,
      onEvent: event => this.#emit(event),
      pollIntervalMs: options.pollIntervalMs,
      leaseMs: options.leaseMs,
    });
    this.store.recoverInterruptedRuns(this.ownerBootId);
  }

  async handle(op, payload = {}) {
    switch (op) {
      case 'list':
        return {
          items: this.store.listWorkItems(payload).map(projectWorkItemSummary),
          watcher: this.watcher.status(),
        };
      case 'get':
        return this.#requiredItem(payload.id);
      case 'get_settings': {
        const settings = this.settingsReader(this.yeaftDir);
        return { settings, runtime: await this.runtimeInfoProvider() };
      }
      case 'update_settings': {
        const settings = this.settingsWriter(this.yeaftDir, payload.settings);
        return { settings, runtime: await this.runtimeInfoProvider() };
      }
      case 'create': {
        const settings = this.settingsReader(this.yeaftDir);
        const workflowTemplate = typeof payload.workflowTemplate === 'string' && payload.workflowTemplate.trim()
          ? payload.workflowTemplate.trim()
          : settings.defaultWorkflowId;
        const workflowSnapshot = resolveWorkflowSnapshot(settings, workflowTemplate, payload.stageOverrides);
        const item = this.controller.create({
          title: requiredString(payload.title, 'title'),
          goal: requiredString(payload.goal, 'goal'),
          acceptanceCriteria: Array.isArray(payload.acceptanceCriteria)
            ? payload.acceptanceCriteria.map(value => String(value).trim()).filter(Boolean)
            : [],
          workflowTemplate,
          workflowSnapshot,
          workDir: typeof payload.workDir === 'string' && payload.workDir.trim()
            ? payload.workDir.trim()
            : settings.defaultWorkDir,
          reuseMemory: payload.reuseMemory !== false,
          origin: payload.origin && typeof payload.origin === 'object'
            ? {
                sessionId: typeof payload.origin.sessionId === 'string' ? payload.origin.sessionId : null,
                messageId: typeof payload.origin.messageId === 'string' ? payload.origin.messageId : null,
                createdBy: typeof payload.origin.createdBy === 'string' ? payload.origin.createdBy : null,
              }
            : null,
          linkedSessionIds: Array.isArray(payload.linkedSessionIds)
            ? [...new Set(payload.linkedSessionIds.map(value => String(value).trim()).filter(Boolean))]
            : [],
          start: payload.start === undefined ? settings.startImmediately : payload.start !== false,
        });
        const detail = this.#requiredItem(item.id);
        this.#emit({ type: 'work_item.created', workItem: detail });
        return detail;
      }
      case 'update': {
        const id = requiredString(payload.id, 'id');
        const detail = this.controller.update(id, payload.patch || {});
        this.watcher.abortInvalidWorkItemRuns(id);
        this.#emit({ type: 'work_item.updated', workItem: detail });
        return detail;
      }
      case 'start': {
        const detail = this.controller.start(requiredString(payload.id, 'id'));
        this.#emit({ type: 'work_item.started', workItem: detail });
        return detail;
      }
      case 'cancel': {
        const id = requiredString(payload.id, 'id');
        const detail = this.controller.cancel(id);
        this.watcher.abortInvalidWorkItemRuns(id);
        this.#emit({ type: 'work_item.cancelled', workItem: detail });
        return detail;
      }
      case 'guide': {
        const id = requiredString(payload.id, 'id');
        const detail = this.controller.guide(id, {
          guidance: typeof payload.guidance === 'string' ? payload.guidance : '',
          actionId: typeof payload.actionId === 'string' ? payload.actionId : '',
          revision: payload.revision,
        });
        this.watcher.abortInvalidWorkItemRuns(id);
        this.#emit({ type: 'action.guidance_added', workItem: detail });
        return detail;
      }
      case 'retry': {
        const detail = this.controller.retry(requiredString(payload.id, 'id'), {
          answer: typeof payload.answer === 'string' ? payload.answer : '',
        });
        this.#emit({ type: 'work_item.retried', workItem: detail });
        return detail;
      }
      case 'set_watcher':
        if (payload.enabled === false) await this.watcher.stop();
        else this.watcher.start();
        return this.watcher.status();
      default:
        throw new Error(`Unsupported Work Center operation: ${op || '(missing)'}`);
    }
  }

  #requiredItem(id) {
    const item = this.store.getWorkItemDetail(requiredString(id, 'id'));
    if (!item) throw new Error(`WorkItem not found: ${id}`);
    return item;
  }

  #emit(event) {
    try { this.onEvent(event); } catch {}
  }

  start() {
    this.watcher.start();
  }

  async shutdown() {
    await this.watcher.stop();
    this.store.close();
  }
}
