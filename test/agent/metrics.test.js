import { beforeEach, describe, expect, it, vi } from 'vitest';

let ctx;
let metrics;

beforeEach(async () => {
  vi.useFakeTimers();
  vi.resetModules();
  ctx = (await import('../../agent/context.js')).default;
  metrics = await import('../../agent/metrics.js');
  ctx.sendToServer = vi.fn();
  ctx.agentMetrics = {
    chatTurns: 0,
    yeaftTurns: 0,
    sessionsCreated: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
    lastUpdatedAt: 0,
  };
});

describe('agent metrics', () => {
  it('records turns, sessions, and token usage', () => {
    metrics.recordAgentTurn('chat');
    metrics.recordAgentTurn('yeaft');
    metrics.recordAgentSessionCreated();
    metrics.recordAgentTokenUsage({
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 2,
      cacheWriteTokens: 1,
    });

    expect(metrics.snapshotAgentMetrics()).toMatchObject({
      chatTurns: 1,
      yeaftTurns: 1,
      totalTurns: 2,
      sessionsCreated: 1,
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 2,
      cacheWriteTokens: 1,
      totalTokens: 18,
    });
  });

  it('emits a throttled coalesced snapshot after updates', () => {
    metrics.recordAgentTurn('yeaft');
    metrics.recordAgentTokenUsage({ totalTokens: 42 });

    expect(ctx.sendToServer).not.toHaveBeenCalled();
    vi.advanceTimersByTime(metrics.AGENT_METRICS_EMIT_INTERVAL_MS - 1);
    expect(ctx.sendToServer).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(ctx.sendToServer).toHaveBeenCalledTimes(1);
    expect(ctx.sendToServer).toHaveBeenCalledWith({
      type: 'agent_metrics',
      metrics: expect.objectContaining({ yeaftTurns: 1, totalTokens: 42 }),
    });
  });

  it('flushes a snapshot immediately when explicitly requested', () => {
    metrics.recordAgentTokenUsage({ totalTokens: 7 });

    metrics.sendAgentMetricsSnapshot();

    expect(ctx.sendToServer).toHaveBeenCalledTimes(1);
    expect(ctx.sendToServer).toHaveBeenCalledWith({
      type: 'agent_metrics',
      metrics: expect.objectContaining({ totalTokens: 7 }),
    });
    vi.runOnlyPendingTimers();
    expect(ctx.sendToServer).toHaveBeenCalledTimes(1);
  });
});
