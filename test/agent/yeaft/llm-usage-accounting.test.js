import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  normalizeTokenUsage,
  withUsageAccounting,
} from '../../../agent/yeaft/llm/usage-accounting.js';
import { AnthropicAdapter } from '../../../agent/yeaft/llm/anthropic.js';
import { OpenAIResponsesAdapter } from '../../../agent/yeaft/llm/openai-responses.js';
import { AdapterRouter } from '../../../agent/yeaft/llm/router.js';
import { startSubAgent } from '../../../agent/yeaft/sub-agent/runner.js';
import { NullTrace } from '../../../agent/yeaft/debug-trace.js';

function streamAdapter(events) {
  return {
    async *stream() {
      for (const event of events) yield event;
    },
    async call() {
      return { text: 'side result', usage: {} };
    },
  };
}

async function consume(generator) {
  const events = [];
  for await (const event of generator) events.push(event);
  return events;
}

function anthropicSse(events) {
  return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

describe('LLM usage accounting', () => {
  it('counts a top-level stream once using Anthropic cache semantics', async () => {
    const onUsage = vi.fn();
    const adapter = withUsageAccounting(streamAdapter([
      {
        type: 'usage',
        inputTokens: 100,
        outputTokens: 0,
        cacheReadTokens: 20,
        cacheWriteTokens: 10,
      },
      { type: 'usage', inputTokens: 0, outputTokens: 40 },
      { type: 'stop', stopReason: 'end_turn' },
    ]), onUsage);

    const received = [];
    for await (const event of adapter.stream({})) received.push(event);

    expect(received).toHaveLength(3);
    expect(onUsage).toHaveBeenCalledTimes(1);
    expect(onUsage).toHaveBeenCalledWith({
      inputTokens: 100,
      outputTokens: 40,
      cacheReadTokens: 20,
      cacheWriteTokens: 10,
      totalTokens: 170,
    });
  });

  it('converts cumulative Anthropic message_delta usage before accounting', async () => {
    const originalFetch = globalThis.fetch;
    const onUsage = vi.fn();
    try {
      globalThis.fetch = vi.fn(async () => anthropicSse([
        { type: 'message_start', message: { usage: {
          input_tokens: 100, output_tokens: 0,
        } } },
        { type: 'message_delta', delta: {}, usage: { output_tokens: 10 } },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 20 } },
        { type: 'message_stop' },
      ]));
      const adapter = withUsageAccounting(
        new AnthropicAdapter({ baseUrl: 'https://anthropic.test', apiKey: 'k' }),
        onUsage,
      );

      await consume(adapter.stream({
        model: 'claude-test', system: '', messages: [{ role: 'user', content: 'hi' }],
      }));

      expect(onUsage).toHaveBeenCalledOnce();
      expect(onUsage).toHaveBeenCalledWith({
        inputTokens: 100, outputTokens: 20,
        cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 120,
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('counts an actual sub-agent engine through the shared adapter', async () => {
    const onUsage = vi.fn();
    const sharedAdapter = withUsageAccounting(streamAdapter([
      { type: 'text_delta', text: 'child result' },
      {
        type: 'usage',
        inputTokens: 100,
        outputTokens: 25,
        cacheReadTokens: 30,
        cacheWriteTokens: 0,
        cacheTokensAreIncludedInInput: true,
      },
      { type: 'stop', stopReason: 'end_turn' },
    ]), onUsage);
    const logDir = mkdtempSync(join(tmpdir(), 'yeaft-token-sub-agent-'));
    const agent = {
      id: 'child-1',
      name: 'child',
      mission: 'do the work',
      status: 'created',
      usage: { tokens: 0, turns: 0, startedAt: Date.now() },
      abortController: new AbortController(),
      pendingPrompts: [],
      diagnostics: [],
    };

    try {
      startSubAgent(agent, {
        adapter: sharedAdapter,
        trace: new NullTrace(),
        config: { model: 'test-model', maxOutputTokens: 256, language: 'en' },
        parentVpId: 'vp-parent',
        parentSessionId: 'session-1',
        subAgentLogDir: logDir,
        idleAbandonMs: 1,
      });
      for (let i = 0; i < 100 && agent.__driverStarted; i += 1) {
        await new Promise(resolve => setTimeout(resolve, 5));
      }

      expect(agent.result).toBe('child result');
      expect(onUsage).toHaveBeenCalledTimes(1);
      expect(onUsage).toHaveBeenCalledWith(expect.objectContaining({ totalTokens: 125 }));
    } finally {
      agent.abortController.abort();
      rmSync(logDir, { recursive: true, force: true });
    }
  });

  it('preserves router runtime controls and delegates provider refreshes', () => {
    const initialProviders = [{
      name: 'initial',
      baseUrl: 'https://initial.test/v1',
      apiKey: 'initial-key',
      protocol: 'openai-responses',
      models: ['gpt-initial'],
    }];
    const refreshedProviders = [{
      name: 'refreshed',
      baseUrl: 'https://refreshed.test/v1',
      apiKey: 'refreshed-key',
      protocol: 'openai-responses',
      models: ['gpt-refreshed'],
    }];
    const router = new AdapterRouter({ providers: initialProviders });
    const refreshSpy = vi.spyOn(router, 'refreshProviders');
    const adapter = withUsageAccounting(router, vi.fn());

    expect(typeof adapter.stream).toBe('function');
    expect(typeof adapter.call).toBe('function');
    expect(typeof adapter.refreshProviders).toBe('function');
    expect(typeof adapter.getProviderForModel).toBe('function');
    expect(typeof adapter.listAvailableModels).toBe('function');
    expect(adapter.listAvailableModels()).toEqual(router.listAvailableModels());

    adapter.refreshProviders(refreshedProviders);

    expect(refreshSpy).toHaveBeenCalledOnce();
    expect(refreshSpy).toHaveBeenCalledWith(refreshedProviders);
    expect(adapter.getProviderForModel('gpt-initial')).toBeNull();
    expect(adapter.getProviderForModel('gpt-refreshed')).toMatchObject({
      name: 'refreshed',
      baseUrl: 'https://refreshed.test/v1',
    });
    expect(adapter.listAvailableModels()).toEqual([
      { modelId: 'gpt-refreshed', providerName: 'refreshed' },
    ]);
  });

  it('does not count Router failures that occur before a provider request', async () => {
    const onRequest = vi.fn();
    const unknownModel = withUsageAccounting(
      new AdapterRouter({ providers: [] }),
      vi.fn(),
      onRequest,
    );
    await expect(consume(unknownModel.stream({
      model: 'missing/model', system: '', messages: [],
    }))).rejects.toThrow('not found in any provider');

    const invalidCredential = withUsageAccounting(new AdapterRouter({ providers: [{
      name: 'managed', baseUrl: 'https://provider.test/v1',
      credentialProvider: 'missing-provider', protocol: 'openai-responses', models: ['gpt-test'],
    }] }), vi.fn(), onRequest);
    await expect(invalidCredential.call({
      model: 'managed/gpt-test', system: '', messages: [],
    })).rejects.toThrow('Unknown credentialProvider');

    expect(onRequest).not.toHaveBeenCalled();
  });

  it('counts provider HTTP failures for both stream and call requests', async () => {
    const originalFetch = globalThis.fetch;
    const onRequest = vi.fn();
    try {
      globalThis.fetch = vi.fn(async () => new Response('unavailable', { status: 503 }));
      const adapter = withUsageAccounting(new AdapterRouter({ providers: [{
        name: 'provider', baseUrl: 'https://provider.test/v1', apiKey: 'k',
        protocol: 'openai-responses', models: ['gpt-test'],
      }] }), vi.fn(), onRequest);

      await expect(consume(adapter.stream({
        model: 'provider/gpt-test', system: '', messages: [],
      }))).rejects.toThrow();
      await expect(adapter.call({
        model: 'provider/gpt-test', system: '', messages: [],
      })).rejects.toThrow();

      expect(globalThis.fetch).toHaveBeenCalledTimes(2);
      expect(onRequest).toHaveBeenCalledTimes(2);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('counts a failed request when the provider hook confirms it started', async () => {
    const onUsage = vi.fn();
    const onRequest = vi.fn();
    const base = streamAdapter([]);
    base.call = vi.fn(async params => {
      params.onRequestStart?.();
      throw new Error('provider failed');
    });
    const adapter = withUsageAccounting(base, onUsage, onRequest);

    await expect(adapter.call({ scenario: 'compact' })).rejects.toThrow('provider failed');
    expect(onRequest).toHaveBeenCalledOnce();
    expect(onUsage).toHaveBeenCalledOnce();
    expect(onUsage).toHaveBeenCalledWith({
      inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0,
    });
  });

  it('counts one non-streaming side call', async () => {
    const onUsage = vi.fn();
    const base = streamAdapter([]);
    base.call = vi.fn(async () => ({
      text: 'summary',
      usage: {
        inputTokens: 50,
        outputTokens: 10,
        cacheReadTokens: 5,
        cacheWriteTokens: 2,
      },
    }));
    const adapter = withUsageAccounting(base, onUsage);

    await expect(adapter.call({ scenario: 'compact' })).resolves.toMatchObject({ text: 'summary' });
    expect(onUsage).toHaveBeenCalledTimes(1);
    expect(onUsage).toHaveBeenCalledWith(expect.objectContaining({ totalTokens: 67 }));
  });

  it('preserves cache conventions from real non-streaming adapters', async () => {
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = vi.fn()
        .mockResolvedValueOnce(new Response(JSON.stringify({
          content: [{ type: 'text', text: 'anthropic' }],
          usage: {
            input_tokens: 100,
            output_tokens: 20,
            cache_read_input_tokens: 30,
            cache_creation_input_tokens: 5,
          },
        }), { status: 200, headers: { 'content-type': 'application/json' } }))
        .mockResolvedValueOnce(new Response(JSON.stringify({
          output_text: 'openai',
          usage: {
            input_tokens: 100,
            output_tokens: 20,
            input_tokens_details: { cached_tokens: 30 },
          },
        }), { status: 200, headers: { 'content-type': 'application/json' } }));

      const anthropic = await new AnthropicAdapter({ baseUrl: 'https://anthropic.test', apiKey: 'k' })
        .call({ model: 'claude-test', system: '', messages: [] });
      const openai = await new OpenAIResponsesAdapter({ baseUrl: 'https://openai.test/v1', apiKey: 'k' })
        .call({ model: 'gpt-test', system: '', messages: [] });

      expect(normalizeTokenUsage(anthropic.usage)).toMatchObject({
        cacheReadTokens: 30,
        cacheWriteTokens: 5,
        totalTokens: 155,
      });
      expect(openai.usage).toMatchObject({
        cacheReadTokens: 30,
        cacheTokensAreIncludedInInput: true,
      });
      expect(normalizeTokenUsage(openai.usage).totalTokens).toBe(120);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('keeps provider cache conventions explicit', () => {
    expect(normalizeTokenUsage({
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 30,
      cacheTokensAreIncludedInInput: true,
    }).totalTokens).toBe(120);

    expect(normalizeTokenUsage({
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 30,
    }).totalTokens).toBe(150);
  });
});
