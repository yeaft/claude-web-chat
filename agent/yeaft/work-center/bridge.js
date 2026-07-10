import ctx from '../../context.js';
import { sendToServer } from '../../connection/buffer.js';
import { ensureSessionLoaded } from '../web-bridge.js';
import { defaultRegistry } from '../vp/registry.js';
import { scanVpLibrary } from '../vp/vp-store.js';
import { WorkCenterService } from './service.js';
import { WorkItemRunner } from './runner.js';
import { projectWorkCenterEvent } from './projection.js';
import { join } from 'node:path';

let service = null;
let initPromise = null;
let shuttingDown = false;
let shutdownPromise = null;
let serviceFactory = null;

function send(msg) {
  sendToServer(msg);
}

async function getRuntime() {
  return ensureSessionLoaded();
}

async function createDefaultService() {
  const yeaftDir = ctx.CONFIG?.yeaftDir;
  if (!yeaftDir) throw new Error('Work Center requires a configured Yeaft directory');
  const runner = new WorkItemRunner({
    runtimeProvider: async () => {
      const runtime = await getRuntime();
      if (defaultRegistry.vpCount() === 0) {
        for (const vp of scanVpLibrary({ dir: join(runtime.yeaftDir, 'virtual-persons') })) defaultRegistry.setVp(vp);
      }
      return {
        ...runtime,
        defaultWorkDir: ctx.CONFIG?.workDir || process.cwd(),
      };
    },
    registry: defaultRegistry,
    store: null,
  });
  const created = new WorkCenterService({
    yeaftDir,
    runner,
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
  return workCenter.handle('create', payload);
}

export async function handleWorkCenterRequest(msg) {
  const requestId = typeof msg.requestId === 'string' ? msg.requestId : null;
  const op = typeof msg.op === 'string' ? msg.op : '';
  try {
    const workCenter = await ensureWorkCenter();
    const data = await workCenter.handle(op, msg.payload || {});
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
