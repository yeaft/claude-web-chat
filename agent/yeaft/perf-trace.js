import { appendFileSync, mkdirSync, readdirSync, rmSync } from 'fs';
import { join } from 'path';
import { normalizeUtf8ByteBudget, toWellFormedText, utf8PrefixWithinBytes } from './utf8.js';

const MAX_DETAIL_STRING = 512;
const DEFAULT_RETENTION_DAYS = 3;
const DEFAULT_FLUSH_INTERVAL_MS = 1_000;
const DEFAULT_MAX_QUEUE_SIZE = 5_000;
const DEFAULT_RAW_EXCHANGE_MAX_BYTES = 512 * 1024;
const lastCleanupDays = new Map();
const queues = new Map();
const flushTimers = new Map();

function telemetryConfig(config) {
  const value = config?.telemetry && typeof config.telemetry === 'object' ? config.telemetry : {};
  const number = (candidate, fallback, min, max) => {
    const parsed = Number(candidate);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(max, Math.max(min, Math.floor(parsed)));
  };
  return {
    enabled: value.enabled !== false,
    retentionDays: number(value.retentionDays, DEFAULT_RETENTION_DAYS, 1, 3650),
    flushIntervalMs: number(value.flushIntervalMs, DEFAULT_FLUSH_INTERVAL_MS, 0, 60_000),
    maxQueueSize: number(value.maxQueueSize, DEFAULT_MAX_QUEUE_SIZE, 100, 50_000),
    rawExchangeMaxBytes: number(value.rawExchangeMaxBytes, DEFAULT_RAW_EXCHANGE_MAX_BYTES, 0, 4 * 1024 * 1024),
    traceTextMaxBytes: number(value.traceTextMaxBytes, 256 * 1024, 0, 4 * 1024 * 1024),
  };
}

export function resolveAgentLocalRoot(config) {
  for (const candidate of [config?.yeaftDir, config?.dir]) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  }
  return null;
}

function queueKey(config) {
  return resolveAgentLocalRoot(config);
}

export function truncateUtf8Text(value, maxBytes = DEFAULT_RAW_EXCHANGE_MAX_BYTES) {
  const limit = normalizeUtf8ByteBudget(maxBytes, DEFAULT_RAW_EXCHANGE_MAX_BYTES);
  const text = toWellFormedText(value);
  const originalBytes = Buffer.byteLength(text, 'utf8');
  if (originalBytes <= limit) return { value: text, truncated: false, originalBytes };

  // One code-point pass avoids the old repeated slice + Buffer.byteLength()
  // backtracking loop, which could stall the event loop on a large raw
  // request or response. The shared helper also refuses to split surrogate
  // pairs and normalizes lone surrogates before producing a preview.
  const prefix = utf8PrefixWithinBytes(text, limit);
  return { value: prefix.text, truncated: true, originalBytes };
}

export function boundRawExchange(value, maxBytes = DEFAULT_RAW_EXCHANGE_MAX_BYTES) {
  const limit = normalizeUtf8ByteBudget(maxBytes, DEFAULT_RAW_EXCHANGE_MAX_BYTES);
  if (value == null || limit <= 0) return limit <= 0 && value != null ? { __truncated: true, maxBytes: limit } : value;
  if (typeof value === 'string') {
    const result = truncateUtf8Text(value, limit);
    return result.truncated ? { __truncated: true, maxBytes: limit, originalBytes: result.originalBytes, preview: result.value } : result.value;
  }
  try {
    const json = JSON.stringify(value);
    const result = truncateUtf8Text(json, limit);
    if (!result.truncated) return JSON.parse(json);
    return { __truncated: true, maxBytes: limit, originalBytes: result.originalBytes, preview: result.value };
  } catch {
    return { __truncated: true, maxBytes: limit };
  }
}

function retentionDays(config) {
  const configured = Number(telemetryConfig(config).retentionDays);
  const env = Number(process.env.PERF_TRACE_RETENTION_DAYS || process.env.YEAFT_PERF_TRACE_RETENTION_DAYS);
  if (Number.isFinite(env) && env > 0) return Math.floor(env);
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_RETENTION_DAYS;
}

function cleanupOldTraceFiles(root, config = null) {
  const day = new Date().toISOString().slice(0, 10);
  const key = root;
  if (lastCleanupDays.get(key) === day) return;
  lastCleanupDays.set(key, day);
  const keepMs = retentionDays(config) * 24 * 60 * 60 * 1000;
  const cutoff = Date.now() - keepMs;
  try {
    for (const file of readdirSync(root)) {
      const match = file.match(/^(\d{4}-\d{2}-\d{2})\.jsonl$/);
      if (!match) continue;
      const ts = Date.parse(`${match[1]}T00:00:00.000Z`);
      if (Number.isFinite(ts) && ts < cutoff) rmSync(join(root, file), { force: true });
    }
  } catch {
    // best-effort; trace writes must never break the agent
  }
}

function sanitizeString(value, max = MAX_DETAIL_STRING) {
  if (typeof value !== 'string') return value;
  return value.length > max ? `${value.slice(0, max)}...[truncated]` : value;
}

function sanitizeValue(value, depth = 0) {
  if (value == null) return value;
  if (typeof value === 'string') return sanitizeString(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) {
    if (depth >= 4) return `[array:${value.length}]`;
    return value.slice(0, 50).map(v => sanitizeValue(v, depth + 1));
  }
  if (typeof value === 'object') {
    if (depth >= 4) return '[object]';
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      if (key === 'text' || key === 'prompt' || key === 'content' || key === 'data' || key === 'apiKey' || key === 'token') continue;
      out[key] = sanitizeValue(item, depth + 1);
    }
    return out;
  }
  return String(value);
}

export function perfNowMs() {
  return Number(process.hrtime.bigint()) / 1e6;
}

function flushQueue(key, config) {
  const queue = queues.get(key);
  if (!queue || queue.length === 0) return 0;
  const batch = queue.splice(0, queue.length);
  const root = join(key, 'perf-traces');
  const day = new Date().toISOString().slice(0, 10);
  try {
    mkdirSync(root, { recursive: true });
    cleanupOldTraceFiles(root, config);
    appendFileSync(join(root, `${day}.jsonl`), batch.map(row => JSON.stringify(row)).join('\n') + '\n');
    return batch.length;
  } catch (err) {
    // Put the batch back only when the queue has room. Losing diagnostics is
    // preferable to blocking the engine or growing memory without a bound.
    const limit = telemetryConfig(config).maxQueueSize;
    queues.set(key, [...batch.slice(-limit), ...(queues.get(key) || [])].slice(-limit));
    if (process.env.YEAFT_PERF_TRACE_DEBUG === '1') {
      console.warn('[Yeaft] perf trace write failed:', err?.message || err);
    }
    return 0;
  }
}

function scheduleFlush(key, config) {
  if (flushTimers.has(key)) return;
  const delay = telemetryConfig(config).flushIntervalMs;
  if (delay <= 0) {
    queueMicrotask(() => flushQueue(key, config));
    return;
  }
  const timer = setTimeout(() => {
    flushTimers.delete(key);
    flushQueue(key, config);
  }, delay);
  if (typeof timer.unref === 'function') timer.unref();
  flushTimers.set(key, timer);
}

export function flushAgentPerfTrace(config) {
  const key = queueKey(config);
  if (!key) return 0;
  const timer = flushTimers.get(key);
  if (timer) {
    clearTimeout(timer);
    flushTimers.delete(key);
  }
  return flushQueue(key, config);
}

export function flushAllAgentPerfTraces() {
  let count = 0;
  for (const [key, queue] of queues) {
    if (!queue.length) continue;
    const config = { yeaftDir: key };
    count += flushQueue(key, config);
  }
  for (const timer of flushTimers.values()) clearTimeout(timer);
  flushTimers.clear();
  return count;
}

export function recordAgentPerfTrace(config, event = {}) {
  const traceId = typeof event.traceId === 'string' && event.traceId.trim()
    ? event.traceId.trim()
    : (typeof event.perfTraceId === 'string' && event.perfTraceId.trim() ? event.perfTraceId.trim() : null);
  const key = queueKey(config);
  const settings = telemetryConfig(config);
  if (!traceId || !key || !settings.enabled) return false;
  const row = {
    traceId,
    source: 'agent',
    phase: event.phase || 'unknown',
    at: Date.now(),
    monotonicMs: Number.isFinite(event.monotonicMs) ? event.monotonicMs : perfNowMs(),
    durationMs: Number.isFinite(event.durationMs) ? event.durationMs : null,
    sessionId: event.sessionId || null,
    vpId: event.vpId || null,
    turnId: event.turnId || null,
    threadId: event.threadId || null,
    messageType: event.messageType || null,
    bytes: Number.isFinite(event.bytes) ? event.bytes : null,
    ok: typeof event.ok === 'boolean' ? event.ok : null,
    detail: sanitizeValue(event.detail || null),
  };
  const queue = queues.get(key) || [];
  if (queue.length >= settings.maxQueueSize) queue.shift();
  queue.push(row);
  queues.set(key, queue);
  // Never write synchronously from the engine phase hook. The timer batches
  // events across the turn; session shutdown calls flushAgentPerfTrace() as a
  // durability boundary for short-lived CLI runs.
  if (queue.length >= settings.maxQueueSize) flushQueue(key, config);
  else scheduleFlush(key, config);
  return true;
}

export const __perfTraceForTest = {
  sanitizeValue,
  cleanupOldTraceFiles,
  telemetryConfig,
  queues,
  flushTimers,
  boundRawExchange,
  truncateUtf8Text,
  flushAllAgentPerfTraces,
};
