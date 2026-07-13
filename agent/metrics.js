import ctx from './context.js';

function finiteNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function ensureMetrics() {
  if (!ctx.agentMetrics || typeof ctx.agentMetrics !== 'object') {
    ctx.agentMetrics = {};
  }
  const metrics = ctx.agentMetrics;
  if (typeof metrics.metricEpoch !== 'string' || !metrics.metricEpoch) {
    metrics.metricEpoch = `legacy-${process.pid}-${Date.now()}`;
  }
  metrics.chatTurns = finiteNumber(metrics.chatTurns);
  metrics.yeaftTurns = finiteNumber(metrics.yeaftTurns);
  metrics.sessionsCreated = finiteNumber(metrics.sessionsCreated);
  metrics.inputTokens = finiteNumber(metrics.inputTokens);
  metrics.outputTokens = finiteNumber(metrics.outputTokens);
  metrics.cacheReadTokens = finiteNumber(metrics.cacheReadTokens);
  metrics.cacheWriteTokens = finiteNumber(metrics.cacheWriteTokens);
  metrics.totalTokens = finiteNumber(metrics.totalTokens);
  metrics.lastUpdatedAt = finiteNumber(metrics.lastUpdatedAt);
  return metrics;
}

export const AGENT_METRICS_EMIT_INTERVAL_MS = 2000;

let pendingMetricsEmit = null;
let lastMetricsEmitAt = 0;

function touch(metrics) {
  metrics.lastUpdatedAt = Date.now();
  scheduleAgentMetricsSnapshot();
  return metrics;
}

function scheduleAgentMetricsSnapshot() {
  if (pendingMetricsEmit) return;
  const now = Date.now();
  const delay = lastMetricsEmitAt > 0
    ? Math.max(AGENT_METRICS_EMIT_INTERVAL_MS - (now - lastMetricsEmitAt), 0)
    : AGENT_METRICS_EMIT_INTERVAL_MS;
  pendingMetricsEmit = setTimeout(() => {
    pendingMetricsEmit = null;
    emitAgentMetricsSnapshot();
  }, delay);
}

export function recordAgentTurn(kind = 'chat') {
  const metrics = ensureMetrics();
  if (kind === 'yeaft') metrics.yeaftTurns += 1;
  else metrics.chatTurns += 1;
  touch(metrics);
}

export function recordAgentSessionCreated() {
  const metrics = ensureMetrics();
  metrics.sessionsCreated += 1;
  touch(metrics);
}

export function recordAgentTokenUsage(usage = {}) {
  const metrics = ensureMetrics();
  const inputTokens = finiteNumber(usage.inputTokens ?? usage.input_tokens ?? usage.promptTokens ?? usage.prompt_tokens);
  const outputTokens = finiteNumber(usage.outputTokens ?? usage.output_tokens ?? usage.completionTokens ?? usage.completion_tokens);
  const cacheReadTokens = finiteNumber(usage.cacheReadTokens ?? usage.cache_read_tokens ?? usage.cache_read_input_tokens);
  const cacheWriteTokens = finiteNumber(usage.cacheWriteTokens ?? usage.cacheWriteInputTokens ?? usage.cache_creation_input_tokens);
  const explicitTotal = finiteNumber(usage.totalTokens ?? usage.total_tokens);
  const totalTokens = explicitTotal || inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens;

  if (inputTokens > 0) metrics.inputTokens += inputTokens;
  if (outputTokens > 0) metrics.outputTokens += outputTokens;
  if (cacheReadTokens > 0) metrics.cacheReadTokens += cacheReadTokens;
  if (cacheWriteTokens > 0) metrics.cacheWriteTokens += cacheWriteTokens;
  if (totalTokens > 0) metrics.totalTokens += totalTokens;
  if (inputTokens || outputTokens || cacheReadTokens || cacheWriteTokens || totalTokens) touch(metrics);
}

export function snapshotAgentMetrics() {
  const metrics = ensureMetrics();
  return {
    metricEpoch: metrics.metricEpoch,
    chatTurns: metrics.chatTurns,
    yeaftTurns: metrics.yeaftTurns,
    totalTurns: metrics.chatTurns + metrics.yeaftTurns,
    sessionsCreated: metrics.sessionsCreated,
    inputTokens: metrics.inputTokens,
    outputTokens: metrics.outputTokens,
    cacheReadTokens: metrics.cacheReadTokens,
    cacheWriteTokens: metrics.cacheWriteTokens,
    totalTokens: metrics.totalTokens,
    lastUpdatedAt: metrics.lastUpdatedAt || null,
  };
}

function emitAgentMetricsSnapshot() {
  lastMetricsEmitAt = Date.now();
  if (typeof ctx.sendToServer !== 'function') return;
  ctx.sendToServer({
    type: 'agent_metrics',
    metrics: snapshotAgentMetrics(),
  });
}

export function sendAgentMetricsSnapshot() {
  if (pendingMetricsEmit) {
    clearTimeout(pendingMetricsEmit);
    pendingMetricsEmit = null;
  }
  emitAgentMetricsSnapshot();
}
