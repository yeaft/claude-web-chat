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

let pendingMetricsEmit = null;

function touch(metrics) {
  metrics.lastUpdatedAt = Date.now();
  scheduleAgentMetricsSnapshot();
  return metrics;
}

function scheduleAgentMetricsSnapshot() {
  if (pendingMetricsEmit) return;
  pendingMetricsEmit = setTimeout(() => {
    pendingMetricsEmit = null;
    sendAgentMetricsSnapshot();
  }, 0);
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

export function sendAgentMetricsSnapshot() {
  if (typeof ctx.sendToServer !== 'function') return;
  ctx.sendToServer({
    type: 'agent_metrics',
    metrics: snapshotAgentMetrics(),
  });
}
