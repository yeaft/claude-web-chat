/**
 * status-cache.js — agent-lifecycle Yeaft capability snapshot.
 *
 * Model candidates are an agent capability, not a page lifecycle side-effect.
 * Keep the last good snapshot in memory, refresh it in the background, and
 * never clear the model list just because a refresh failed.
 */

import { createHash } from 'node:crypto';
import ctx from '../context.js';
import { sendToServer } from '../connection/buffer.js';
import { loadConfig } from './config.js';

const DEFAULT_REFRESH_INTERVAL_MS = 5 * 60 * 1000;

function normalizeAvailableModels(models) {
  if (!Array.isArray(models)) return [];
  return models
    .map((m) => {
      if (typeof m === 'string') return { id: m, label: m };
      if (!m || typeof m !== 'object' || typeof m.id !== 'string' || !m.id) return null;
      return { ...m, label: m.label || m.id };
    })
    .filter(Boolean);
}

function catalogDigest(model, availableModels) {
  return createHash('sha256')
    .update(JSON.stringify({ model: model || null, availableModels: normalizeAvailableModels(availableModels) }))
    .digest('hex');
}

function createCatalogEpoch(now) {
  return `${process.pid}-${now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function buildEvent(snapshot) {
  return {
    type: 'yeaft_status',
    model: snapshot.model || null,
    availableModels: normalizeAvailableModels(snapshot.availableModels),
    skills: snapshot.skills,
    mcpServers: snapshot.mcpServers,
    tools: snapshot.tools,
    yeaftDir: snapshot.yeaftDir || null,
    refreshedAt: snapshot.refreshedAt || null,
    catalogRefreshedAt: snapshot.catalogRefreshedAt || null,
    catalogEpoch: snapshot.catalogEpoch || null,
    catalogRevision: snapshot.catalogRevision || null,
    catalogDigest: snapshot.catalogDigest || null,
    refreshStartedAt: snapshot.refreshStartedAt || null,
    refreshReason: snapshot.refreshReason || null,
    refreshError: snapshot.refreshError || null,
    refreshing: !!snapshot.refreshing,
  };
}

/**
 * Create a status cache. Tests inject clock/timer/config loading; production
 * uses the exported singleton wrappers below.
 */
export function createYeaftStatusCache(options = {}) {
  const load = options.loadConfig || loadConfig;
  const emit = options.emit || ((event) => sendToServer({ type: 'yeaft_output', event }));
  const now = options.now || (() => Date.now());
  const setTimer = options.setInterval || globalThis.setInterval.bind(globalThis);
  const clearTimer = options.clearInterval || globalThis.clearInterval.bind(globalThis);
  const intervalMs = options.intervalMs || DEFAULT_REFRESH_INTERVAL_MS;
  let snapshot = null;
  let timer = null;
  let inFlight = null;
  let generation = 0;
  let forceTail = Promise.resolve();
  let pendingForceRefreshes = 0;
  let hasConfigCatalog = false;
  let lastCatalogRefreshedAt = 0;
  let catalogEpoch = createCatalogEpoch(now);
  let catalogRevision = 0;
  let lastCatalogDigest = null;

  function current() {
    return snapshot ? { ...snapshot, availableModels: normalizeAvailableModels(snapshot.availableModels) } : null;
  }

  function emitSnapshot(extra = {}) {
    if (!snapshot) return null;
    const event = buildEvent({ ...snapshot, ...extra });
    emit(event);
    return event;
  }

  async function refresh({ reason = 'manual', emitRefreshing = true, sessionStatus = null } = {}) {
    if (inFlight) return inFlight;
    const startedAt = now();
    const refreshGeneration = generation;
    if (emitRefreshing && snapshot) {
      snapshot = { ...snapshot, refreshing: true, refreshStartedAt: startedAt, refreshReason: reason };
      emitSnapshot();
    }
    const refreshPromise = Promise.resolve()
      .then(async () => {
        const yeaftDir = options.getYeaftDir ? options.getYeaftDir() : ctx.CONFIG?.yeaftDir;
        const config = await load({ ...(yeaftDir && { dir: yeaftDir }) });
        if (refreshGeneration !== generation) return current();
        const previous = snapshot || {};
        const nextModel = config.primaryModel || config.model || previous.model || null;
        const nextModels = normalizeAvailableModels(config.availableModels);
        const nextDigest = catalogDigest(nextModel, nextModels);
        hasConfigCatalog = true;
        lastCatalogRefreshedAt = now();
        if (nextDigest !== lastCatalogDigest) catalogRevision += 1;
        lastCatalogDigest = nextDigest;
        snapshot = {
          ...previous,
          model: nextModel,
          availableModels: nextModels,
          yeaftDir: config.dir || yeaftDir || previous.yeaftDir || null,
          skills: sessionStatus?.skills ?? previous.skills,
          mcpServers: sessionStatus?.mcpServers ?? previous.mcpServers,
          tools: sessionStatus?.tools ?? previous.tools,
          refreshedAt: lastCatalogRefreshedAt,
          catalogRefreshedAt: lastCatalogRefreshedAt,
          catalogEpoch,
          catalogRevision,
          catalogDigest: lastCatalogDigest,
          refreshStartedAt: startedAt,
          refreshReason: reason,
          refreshError: null,
          refreshing: false,
        };
        return emitSnapshot();
      })
      .catch((err) => {
        if (refreshGeneration !== generation) return current();
        const message = err?.message || String(err);
        const previous = snapshot || {};
        snapshot = {
          ...previous,
          availableModels: normalizeAvailableModels(previous.availableModels),
          refreshedAt: previous.refreshedAt || null,
          catalogRefreshedAt: previous.catalogRefreshedAt || null,
          catalogEpoch: previous.catalogEpoch || null,
          catalogRevision: previous.catalogRevision || null,
          catalogDigest: previous.catalogDigest || null,
          refreshStartedAt: startedAt,
          refreshReason: reason,
          refreshError: message,
          refreshing: false,
        };
        return emitSnapshot();
      })
      .finally(() => {
        if (inFlight === refreshPromise) inFlight = null;
      });
    inFlight = refreshPromise;
    return refreshPromise;
  }

  function forceRefresh(options = {}) {
    // Serialize post-save reads. Every caller invalidates work that started
    // before its config write, then reads only after earlier forced refreshes
    // have drained. A counter keeps Session hydration from cancelling the
    // newest refresh when an older caller finishes first.
    generation += 1;
    pendingForceRefreshes += 1;
    const run = async () => {
      try {
        if (inFlight) await inFlight;
        return await refresh({ ...options, emitRefreshing: options.emitRefreshing ?? false });
      } finally {
        pendingForceRefreshes -= 1;
      }
    };
    const result = forceTail.then(run, run);
    forceTail = result.catch(() => null);
    return result;
  }

  function hydrateFromSession(sessionLike, { reason = 'session_ready', emitEvent = true } = {}) {
    if (!sessionLike) return null;
    // Session hydration fills runtime status only. The provider/model catalog
    // is owned by config.json, so hydration never invalidates a config read.
    // A config write invalidates stale reads through forceRefresh() instead.
    const previous = snapshot || {};
    const sessionModels = normalizeAvailableModels(sessionLike.config?.availableModels);
    snapshot = {
      ...previous,
      model: hasConfigCatalog
        ? (previous.model || sessionLike.config?.model || null)
        : (sessionLike.config?.model || previous.model || null),
      availableModels: hasConfigCatalog
        ? normalizeAvailableModels(previous.availableModels)
        : (sessionModels.length > 0 ? sessionModels : normalizeAvailableModels(previous.availableModels)),
      yeaftDir: sessionLike.yeaftDir || sessionLike.config?.dir || previous.yeaftDir || null,
      skills: sessionLike.status?.skills ?? previous.skills,
      mcpServers: sessionLike.status?.mcpServers ?? previous.mcpServers,
      tools: sessionLike.status?.tools ?? previous.tools,
      refreshedAt: now(),
      catalogRefreshedAt: hasConfigCatalog ? lastCatalogRefreshedAt : null,
      catalogEpoch: hasConfigCatalog ? catalogEpoch : null,
      catalogRevision: hasConfigCatalog ? catalogRevision : null,
      catalogDigest: hasConfigCatalog ? lastCatalogDigest : null,
      refreshStartedAt: previous.refreshStartedAt || null,
      refreshReason: reason,
      refreshError: previous.refreshError || null,
      refreshing: pendingForceRefreshes > 0 || !!previous.refreshing,
    };
    return emitEvent ? emitSnapshot() : buildEvent(snapshot);
  }

  function start() {
    if (timer) return timer;
    refresh({ reason: 'startup', emitRefreshing: false }).catch(() => {});
    timer = setTimer(() => { refresh({ reason: 'interval' }).catch(() => {}); }, intervalMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
    return timer;
  }

  function stop() {
    if (timer) clearTimer(timer);
    timer = null;
  }

  return { current, refresh, forceRefresh, hydrateFromSession, start, stop, emitSnapshot };
}

export const yeaftStatusCache = createYeaftStatusCache();

export function startYeaftStatusRefresh() {
  return yeaftStatusCache.start();
}

export function stopYeaftStatusRefresh() {
  return yeaftStatusCache.stop();
}

export function refreshYeaftStatus(options) {
  return yeaftStatusCache.refresh(options);
}

export function forceRefreshYeaftStatus(options) {
  return yeaftStatusCache.forceRefresh(options);
}

export function hydrateYeaftStatusFromSession(sessionLike, options) {
  return yeaftStatusCache.hydrateFromSession(sessionLike, options);
}

export function getCachedYeaftStatus() {
  return yeaftStatusCache.current();
}
