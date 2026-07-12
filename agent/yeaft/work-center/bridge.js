import ctx from '../../context.js';
import { sendToServer } from '../../connection/buffer.js';
import { ensureSessionLoaded, resetYeaftSession } from '../web-bridge.js';
import { defaultRegistry } from '../vp/registry.js';
import { scanVpLibrary } from '../vp/vp-store.js';
import { WorkCenterService } from './service.js';
import { WorkItemRunner } from './runner.js';
import { projectWorkCenterEvent, projectWorkItemDetail } from './projection.js';
import { previewWorkCenterPlan } from './planner.js';
import { readWorkCenterSettings, writeWorkCenterSettings } from './settings.js';
import { defaultWorkCenterStageInstructions } from './workflow.js';
import { join } from 'node:path';

let service = null;
let initPromise = null;
let shuttingDown = false;
let shutdownPromise = null;
let serviceFactory = null;

const BROWSER_DETAIL_OPS = new Set(['get', 'create', 'update', 'start', 'cancel', 'guide', 'retry']);
const BROWSER_CREATE_FIELDS = Object.freeze([
  'title',
  'goal',
  'acceptanceCriteria',
  'workDir',
  'reuseMemory',
  'origin',
  'linkedSessionIds',
  'files',
  'start',
]);

function browserCreatePayload(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return Object.fromEntries(BROWSER_CREATE_FIELDS
    .filter(field => Object.prototype.hasOwnProperty.call(source, field))
    .map(field => [field, source[field]]));
}

function send(msg) {
  sendToServer(msg);
}

async function getRuntime() {
  return ensureSessionLoaded();
}

function requireYeaftDir() {
  const yeaftDir = ctx.CONFIG?.yeaftDir;
  if (!yeaftDir) throw new Error('Work Center requires a configured Yeaft directory');
  return yeaftDir;
}

async function getSettingsRuntime() {
  const runtime = await getRuntime();
  const yeaftDir = requireYeaftDir();
  if (defaultRegistry.vpCount() === 0) {
    for (const vp of scanVpLibrary({ dir: join(yeaftDir, 'virtual-persons') })) defaultRegistry.setVp(vp);
  }
  return {
    vps: defaultRegistry.listVps().map(vp => ({
      id: vp.id,
      name: vp.name || vp.id,
      nameZh: vp.nameZh || '',
      role: vp.role || '',
      roleZh: vp.roleZh || '',
      area: vp.area || '',
      traits: Array.isArray(vp.traits) ? vp.traits : [],
      modelHint: vp.modelHint || null,
    })),
    models: Array.isArray(runtime.config.availableModels) ? runtime.config.availableModels : [],
    primaryModel: runtime.config.primaryModel || runtime.config.model || null,
    fastModel: runtime.config.fastModel || null,
    defaultWorkDir: ctx.CONFIG?.workDir || process.cwd(),
    defaultStageInstructions: defaultWorkCenterStageInstructions(),
  };
}

async function readSettingsResponse() {
  const yeaftDir = requireYeaftDir();
  return {
    settings: readWorkCenterSettings(yeaftDir),
    runtime: await getSettingsRuntime(),
  };
}

async function createDefaultService() {
  const yeaftDir = requireYeaftDir();
  const runner = new WorkItemRunner({
    runtimeProvider: async () => {
      const runtime = await getRuntime();
      if (defaultRegistry.vpCount() === 0) {
        for (const vp of scanVpLibrary({ dir: join(yeaftDir, 'virtual-persons') })) defaultRegistry.setVp(vp);
      }
      return {
        ...runtime,
        defaultWorkDir: ctx.CONFIG?.workDir || process.cwd(),
      };
    },
    policyProvider: async () => readWorkCenterSettings(yeaftDir),
    attachmentRoot: join(yeaftDir, 'work-center', 'attachments'),
    registry: defaultRegistry,
    store: null,
  });
  const created = new WorkCenterService({
    yeaftDir,
    runner,
    runtimeInfoProvider: getSettingsRuntime,
    onEvent(event) {
      send({ type: 'work_center_event', event: projectWorkCenterEvent(event) });
    },
  });
  runner.store = created.store;
  return created;
}

async function ensureWorkCenter() {
  if (service) return service;
  if (shuttingDown) throw new Error('Work Center is shutting down');
  if (initPromise) return initPromise;
  initPromise = (async () => {
    const created = serviceFactory ? await serviceFactory() : await createDefaultService();
    if (shuttingDown) {
      await created.shutdown();
      throw new Error('Work Center shut down during initialization');
    }
    created.start();
    service = created;
    return created;
  })();
  try {
    return await initPromise;
  } finally {
    initPromise = null;
  }
}

export async function bootWorkCenter() {
  return ensureWorkCenter();
}

export async function createWorkItemFromProducer(payload) {
  const workCenter = await ensureWorkCenter();
  return workCenter.handle('create', payload, { trustedProducer: true });
}

export async function handleWorkCenterRequest(msg) {
  const requestId = typeof msg.requestId === 'string' ? msg.requestId : null;
  const op = typeof msg.op === 'string' ? msg.op : '';
  try {
    let data;
    if (op === 'get_settings') {
      data = await readSettingsResponse();
    } else if (op === 'update_settings') {
      const settings = writeWorkCenterSettings(requireYeaftDir(), msg.payload?.settings);
      data = { settings, runtime: await getSettingsRuntime() };
    } else if (op === 'preview') {
      const runtime = await getRuntime();
      const yeaftDir = requireYeaftDir();
      if (defaultRegistry.vpCount() === 0) {
        for (const vp of scanVpLibrary({ dir: join(yeaftDir, 'virtual-persons') })) defaultRegistry.setVp(vp);
      }
      data = previewWorkCenterPlan({
        settings: readWorkCenterSettings(yeaftDir),
        workflowId: msg.payload?.workflowTemplate,
        stageOverrides: msg.payload?.stageOverrides,
        registry: defaultRegistry,
        config: runtime.config,
      });
    } else if (op === 'refresh_runtime') {
      await resetYeaftSession();
      data = await readSettingsResponse();
    } else {
      const workCenter = await ensureWorkCenter();
      data = await workCenter.handle(
        op,
        op === 'create' ? browserCreatePayload(msg.payload) : (msg.payload || {}),
      );
    }
    if (BROWSER_DETAIL_OPS.has(op)) data = projectWorkItemDetail(data);
    send({
      type: 'work_center_response',
      requestId,
      op,
      ok: true,
      data,
      _requestUserId: msg._requestUserId || null,
    });
  } catch (err) {
    send({
      type: 'work_center_response',
      requestId,
      op,
      ok: false,
      error: err?.message || String(err),
      _requestUserId: msg._requestUserId || null,
    });
  }
}

export async function shutdownWorkCenter() {
  if (shutdownPromise) return shutdownPromise;
  shuttingDown = true;
  const pendingInit = initPromise;
  shutdownPromise = (async () => {
    let current = service;
    if (!current && pendingInit) {
      try { current = await pendingInit; } catch {}
    }
    service = null;
    if (current) await current.shutdown();
  })();
  try {
    await shutdownPromise;
  } finally {
    initPromise = null;
    shutdownPromise = null;
  }
}

export function __testSetWorkCenterService(next) {
  service = next || null;
  initPromise = null;
  shuttingDown = false;
  shutdownPromise = null;
}

export function __testSetWorkCenterFactory(factory) {
  serviceFactory = factory || null;
  service = null;
  initPromise = null;
  shuttingDown = false;
  shutdownPromise = null;
}
