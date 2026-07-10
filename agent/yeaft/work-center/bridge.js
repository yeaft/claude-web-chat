import ctx from '../../context.js';
import { sendToServer } from '../../connection/buffer.js';
import { ensureSessionLoaded } from '../web-bridge.js';
import { defaultRegistry } from '../vp/registry.js';
import { scanVpLibrary } from '../vp/vp-store.js';
import { WorkCenterService } from './service.js';
import { WorkItemRunner } from './runner.js';
import { join } from 'node:path';

let service = null;
let initPromise = null;

function send(msg) {
  sendToServer(msg);
}

async function getRuntime() {
  return ensureSessionLoaded();
}

async function ensureWorkCenter() {
  if (service) return service;
  if (initPromise) return initPromise;
  initPromise = (async () => {
    const yeaftDir = ctx.CONFIG?.yeaftDir;
    if (!yeaftDir) throw new Error('Work Center requires a configured Yeaft directory');
    // Boot the shared Yeaft runtime first. Besides adapters/config it seeds the
    // default VP library on a fresh install, so role resolution below sees the
    // same profiles as normal Session execution.
    const runtime = await ensureSessionLoaded();
    if (defaultRegistry.vpCount() === 0) {
      for (const vp of scanVpLibrary({ dir: join(runtime.yeaftDir, 'virtual-persons') })) defaultRegistry.setVp(vp);
    }
    const runner = new WorkItemRunner({
      runtimeProvider: async () => ({
        ...(await getRuntime()),
        defaultWorkDir: ctx.CONFIG?.workDir || process.cwd(),
      }),
      registry: defaultRegistry,
      store: null,
    });
    const created = new WorkCenterService({
      yeaftDir,
      runner,
      onEvent(event) {
        send({ type: 'work_center_event', event });
      },
    });
    // The runner needs the service store for lease fencing. Assign after the
    // service has completed its synchronous construction.
    runner.store = created.store;
    created.start();
    service = created;
    return service;
  })();
  try {
    return await initPromise;
  } finally {
    initPromise = null;
  }
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
  const current = service;
  service = null;
  if (current) await current.shutdown();
}

export function __testSetWorkCenterService(next) {
  service = next || null;
  initPromise = null;
}
