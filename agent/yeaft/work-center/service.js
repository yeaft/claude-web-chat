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
import {
  projectActionMessagePage,
  projectActionRequestDetail,
  projectActionRequestIndex,
  projectWorkItemDetail,
  projectWorkItemSummary,
} from './projection.js';
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

function boardCursor(item) {
  return Buffer.from(JSON.stringify([Number(item.updatedAt) || 0, String(item.id || '')]), 'utf8')
    .toString('base64url');
}

function parseBoardCursor(value) {
  if (typeof value !== 'string' || !value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (!Array.isArray(parsed) || parsed.length !== 2 || !Number.isFinite(Number(parsed[0]))) return null;
    return [Number(parsed[0]), String(parsed[1] || '')];
  } catch {
    return null;
  }
}

function listBoardItems(store, payload) {
  const limit = Math.min(Math.max(Number(payload.limit) || 100, 1), 200);
  const cursor = parseBoardCursor(payload.cursor);
  const lane = ['needs_attention', 'active', 'closed'].includes(payload.lane) ? payload.lane : null;
  const vpId = typeof payload.vpId === 'string' ? payload.vpId.trim() : '';
  const workItemType = typeof payload.workItemType === 'string' ? payload.workItemType.trim() : '';
  const projected = store.listWorkItems({
    ...payload,
    lane,
    vpId,
    workItemType,
    cursorUpdatedAt: cursor?.[0],
    cursorId: cursor?.[1],
    limit: limit + 1,
  }).map(projectWorkItemSummary);
  const items = projected.slice(0, limit);
  return {
    items,
    nextCursor: projected.length > limit && items.length > 0 ? boardCursor(items.at(-1)) : null,
  };
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
    this.controller = options.controller || new WorkflowController(this.store, {
      listAvailableVpIds: options.listAvailableVpIds,
    });
    this.coordinator = options.coordinator || null;
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
      case 'list': {
        const page = listBoardItems(this.store, payload);
        return {
          ...page,
          watcher: this.watcher.status(),
        };
      }
      case 'get':
        return this.#requiredItem(payload.id);
      case 'get_action_messages': {
        const detail = this.#requiredItem(payload.id);
        const action = this.#requiredAction(detail, payload.actionId);
        const expectedGeneration = payload.generation == null
          ? Number(action.generation)
          : Number(payload.generation);
        if (!Number.isInteger(expectedGeneration) || expectedGeneration < 1) {
          throw new Error('generation must be a positive integer');
        }
        if (Number(action.generation) !== expectedGeneration) {
          throw new Error('Action generation changed before messages were loaded');
        }
        return projectActionMessagePage(action, detail.runs, this.store.listActionEvents(action.id), {
          cursor: payload.cursor,
          limit: payload.limit,
        });
      }
      case 'get_action_requests': {
        const detail = this.#requiredItem(payload.id);
        const action = this.#requiredAction(detail, payload.actionId);
        const entries = [];
        for (const run of detail.runs.filter(item => item.actionId === action.id)) {
          const history = await this.#debugHistory(run, { indexOnly: true });
          for (const turn of Array.isArray(history?.turns) ? history.turns : []) {
            entries.push({ run, turn });
          }
        }
        return projectActionRequestIndex(action, entries);
      }
      case 'get_action_request': {
        const detail = this.#requiredItem(payload.id);
        const action = this.#requiredAction(detail, payload.actionId);
        const requestId = requiredString(payload.requestId, 'requestId');
        const run = detail.runs.find(item => item.actionId === action.id && item.id === payload.runId);
        if (!run) throw new Error('Action request not found');
        const history = await this.#debugHistory(run, { detailTurnId: requestId });
        const projected = projectActionRequestDetail(action, run, history, detail.runs);
        if (!projected) throw new Error('Action request detail is no longer available');
        return projected;
      }
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
      case 'delete': {
        const id = requiredString(payload.id, 'id');
        const deleted = this.store.deleteWorkItemAtomic(id, Number(payload.revision));
        if (!deleted) throw new Error(`WorkItem not found: ${id}`);
        for (const action of deleted.actions || []) {
          try { this.watcher.runner?.cleanup?.(action); } catch {}
        }
        let cleanupWarning = null;
        try { removeWorkItemAttachments(this.attachmentRoot, id); } catch {
          cleanupWarning = 'WorkItem data was deleted, but attachment cleanup needs maintenance';
        }
        this.#emit({ type: 'work_item.deleted', workItem: { id, revision: deleted.revision } });
        return { id, deleted: true, cleanupWarning };
      }
      case 'work_item_message': {
        if (!this.coordinator) throw new Error('Work Center Coordinator is unavailable');
        const id = requiredString(payload.id, 'id');
        const turn = this.coordinator.message(id, {
          text: typeof payload.text === 'string' ? payload.text : '',
          revision: payload.revision,
          planRevision: payload.planRevision,
          ledgerRevision: payload.ledgerRevision,
          coordinatorRevision: payload.coordinatorRevision,
        }, {
          onUpdate: (type, workItem) => {
            this.watcher.abortInvalidWorkItemRuns(id);
            this.#emit({ type, workItem });
          },
        });
        turn.task.catch(() => {});
        return { accepted: true, turnId: turn.detail.messages?.at(-1)?.turnId || null };
      }
      case 'retry_action': {
        const id = requiredString(payload.id, 'id');
        const detail = this.controller.retry(id, {
          expected: {
            actionId: typeof payload.actionId === 'string' ? payload.actionId : '',
            revision: payload.revision,
            generation: payload.generation,
            statuses: ['failed'],
          },
        });
        this.watcher.abortInvalidWorkItemRuns(id);
        this.#emit({ type: 'action.retried', workItem: detail });
        return detail;
      }
      case 'action_input': {
        const id = requiredString(payload.id, 'id');
        const workItem = this.#requiredItem(id);
        let addedAttachments = [];
        let detail;
        try {
          addedAttachments = appendWorkItemAttachments(workItem.attachments, payload.files, {
            root: this.attachmentRoot,
            workItemId: id,
          });
          detail = this.controller.input(id, {
            text: typeof payload.text === 'string' ? payload.text : '',
            actionId: typeof payload.actionId === 'string' ? payload.actionId : '',
            revision: payload.revision,
            generation: payload.generation,
            addedAttachmentCount: addedAttachments.length,
            addedAttachments,
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
        this.watcher.notifyActionInput(id, payload.actionId);
        this.#emit({ type: 'action.input_added', workItem: detail });
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
            generation: payload.generation,
            addedAttachmentCount: addedAttachments.length,
            addedAttachments,
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

  #requiredAction(detail, actionId) {
    const id = requiredString(actionId, 'actionId');
    const action = detail.actions.find(item => item.id === id);
    if (!action) throw new Error(`Action not found: ${id}`);
    return action;
  }

  async #debugHistory(run, options = {}) {
    const trace = this.watcher.runner?.trace;
    if (!trace || typeof trace.fetchRecentDebugHistory !== 'function') {
      return { turns: [], loops: [] };
    }
    return trace.fetchRecentDebugHistory({
      limit: 10,
      dreamLimit: 0,
      sessionId: `work-item-${run.workItemId}`,
      threadId: run.id,
      indexOnly: options.indexOnly === true,
      detailTurnId: options.detailTurnId || null,
    });
  }

  #emit(event) {
    try { this.onEvent(event); } catch {}
  }

  start() {
    this.watcher.start();
  }

  async shutdown() {
    await this.coordinator?.shutdown?.();
    await this.watcher.stop();
    try { await this.watcher.runner?.shutdown?.(); } catch {}
    try { await this.watcher.runner?.trace?.close?.(); } catch {}
    this.store.close();
  }
}
