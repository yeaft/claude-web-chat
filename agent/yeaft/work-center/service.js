import { realpathSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { WorkItemStore } from './store.js';
import { WorkflowController } from './controller.js';
import { WorkItemWatcher } from './watcher.js';
import {
  appendWorkItemAttachments,
  persistWorkItemAttachments,
  readWorkItemAttachment,
  removeWorkItemAttachmentFiles,
  removeWorkItemAttachments,
} from './attachments.js';
import { normalizeSessionContextSnapshot } from './session-context.js';
import { projectWorkItemDetail, projectWorkItemSummary } from './projection.js';
import { readWorkCenterSettings, writeWorkCenterSettings } from './settings.js';
import {
  defaultWorkCenterStageInstructions,
  listWorkItemTypeTemplates,
  resolvePlanningWorkflowSnapshot,
  resolveWorkflowSnapshot,
} from './workflow.js';

function requiredString(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required`);
  return value.trim();
}

function requiredWorkDir(value) {
  const workDir = requiredString(value, 'workDir');
  let canonical;
  try {
    canonical = realpathSync(resolve(workDir));
    if (!statSync(canonical).isDirectory()) throw new Error('not a directory');
  } catch {
    throw new Error('workDir must be an existing directory');
  }
  return canonical;
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
    this.runtimeInfo = async () => {
      const settings = this.settingsReader(this.yeaftDir);
      return {
        ...(await this.runtimeInfoProvider()),
        defaultStageInstructions: defaultWorkCenterStageInstructions(),
        workItemTypes: listWorkItemTypeTemplates(settings),
      };
    };
    this.ownerBootId = options.ownerBootId || randomUUID();
    this.attachmentRoot = options.attachmentRoot || join(yeaftDir, 'work-center', 'attachments');
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
      concurrencyProvider: options.watcherOptions?.concurrencyProvider,
    });
    this.store.recoverInterruptedRuns(this.ownerBootId);
  }

  async handle(op, payload = {}, requestContext = {}) {
    switch (op) {
      case 'list':
        return {
          items: this.store.listWorkItems(payload).map(projectWorkItemSummary),
          watcher: this.watcher.status(),
        };
      case 'get':
        return projectWorkItemDetail(this.#requiredItem(payload.id));
      case 'get_settings': {
        const settings = this.settingsReader(this.yeaftDir);
        return { settings, runtime: await this.runtimeInfo() };
      }
      case 'update_settings': {
        const settings = this.settingsWriter(this.yeaftDir, payload.settings);
        return { settings, runtime: await this.runtimeInfo() };
      }
      case 'create': {
        const settings = this.settingsReader(this.yeaftDir);
        const explicitWorkflow = requestContext.trustedProducer === true
          && typeof payload.workflowTemplate === 'string' && payload.workflowTemplate.trim()
          ? payload.workflowTemplate.trim()
          : null;
        const workflowTemplate = explicitWorkflow || 'ai-planned';
        const workflowSnapshot = explicitWorkflow
          ? resolveWorkflowSnapshot(settings, explicitWorkflow, payload.stageOverrides)
          : resolvePlanningWorkflowSnapshot(settings, payload.workItemType);
        const runtime = !Object.hasOwn(payload, 'workDir') && !settings.defaultWorkDir
          ? await this.runtimeInfo()
          : null;
        const workDir = requiredWorkDir(Object.hasOwn(payload, 'workDir')
          ? payload.workDir
          : settings.defaultWorkDir || runtime?.defaultWorkDir);
        const workItemId = randomUUID();
        let attachments = [];
        try {
          attachments = persistWorkItemAttachments(payload.files, {
            root: this.attachmentRoot,
            workItemId,
          });
          this.controller.create({
            id: workItemId,
            title: requiredString(payload.title, 'title'),
            goal: requiredString(payload.goal, 'goal'),
            acceptanceCriteria: Array.isArray(payload.acceptanceCriteria)
              ? payload.acceptanceCriteria.map(value => String(value).trim()).filter(Boolean)
              : [],
            workflowTemplate,
            workflowSnapshot,
            workDir,
            reuseMemory: payload.reuseMemory !== false,
            origin: payload.origin && typeof payload.origin === 'object'
              ? {
                  sessionId: typeof payload.origin.sessionId === 'string' ? payload.origin.sessionId : null,
                  messageId: typeof payload.origin.messageId === 'string' ? payload.origin.messageId : null,
                  createdBy: typeof payload.origin.createdBy === 'string' ? payload.origin.createdBy : null,
                  trustedSession: requestContext.trustedProducer === true,
                }
              : null,
            linkedSessionIds: Array.isArray(payload.linkedSessionIds)
              ? [...new Set(payload.linkedSessionIds.map(value => String(value).trim()).filter(Boolean))]
              : [],
            sessionContext: requestContext.trustedProducer === true
              ? normalizeSessionContextSnapshot(payload.sessionContext)
              : [],
            attachments,
            start: payload.start === undefined ? settings.startImmediately : payload.start !== false,
          });
          const detail = this.#requiredItem(workItemId);
          this.#emit({ type: 'work_item.created', workItem: detail });
          return detail;
        } catch (error) {
          removeWorkItemAttachments(this.attachmentRoot, workItemId);
          throw error;
        }
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
        const workItem = this.#requiredItem(id);
        let addedAttachments = [];
        let detail;
        try {
          addedAttachments = appendWorkItemAttachments(workItem.attachments, payload.files, {
            root: this.attachmentRoot,
            workItemId: id,
          });
          detail = this.controller.guide(id, {
            guidance: typeof payload.guidance === 'string' ? payload.guidance : '',
            actionId: typeof payload.actionId === 'string' ? payload.actionId : '',
            revision: payload.revision,
            addedAttachmentCount: addedAttachments.length,
            attachments: [...(workItem.attachments || []), ...addedAttachments],
          });
        } catch (error) {
          try {
            if ((workItem.attachments || []).length === 0 && addedAttachments.length > 0) {
              removeWorkItemAttachments(this.attachmentRoot, id);
            } else {
              removeWorkItemAttachmentFiles(this.attachmentRoot, id, addedAttachments);
            }
          } catch {}
          throw error;
        }
        this.watcher.abortInvalidWorkItemRuns(id);
        this.#emit({ type: 'action.guidance_added', workItem: detail });
        return detail;
      }
      case 'preview_attachment': {
        const id = requiredString(payload.id, 'id');
        const attachment = readWorkItemAttachment(
          this.#requiredItem(id),
          requiredString(payload.attachmentId, 'attachmentId'),
          { root: this.attachmentRoot },
        );
        return {
          attachment: {
            id: attachment.id,
            name: attachment.name,
            mimeType: attachment.mimeType,
            size: attachment.size,
            isImage: attachment.isImage,
          },
          previewData: {
            data: attachment.data,
            mimeType: attachment.mimeType,
            filename: attachment.name,
          },
        };
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
