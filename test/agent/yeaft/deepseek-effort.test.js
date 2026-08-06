import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { loadConfig } from '../../../agent/yeaft/config.js';
import {
  getModelEffortOptions,
  getThinkingCapability,
  mapEffortToOpenAIReasoning,
} from '../../../agent/yeaft/models.js';
import { filterEffortForModel, AdapterRouter } from '../../../agent/yeaft/llm/router.js';
import { OpenAIResponsesAdapter } from '../../../agent/yeaft/llm/openai-responses.js';
import { AnthropicAdapter } from '../../../agent/yeaft/llm/anthropic.js';

function jsonResponse(body) {
  return {
    ok: true,
    status: 200,
    headers: { get: () => 'application/json' },
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

describe('DeepSeek model effort levels', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.YEAFT_THINKING_V1;
  });

  it('exposes the full effort scale including xhigh and max on both wire protocols', () => {
    // OpenAI-Responses-compatible surface (default inference path).
    expect(getModelEffortOptions('deepseek-reasoner')).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    expect(getModelEffortOptions('deepseek-v4-pro')).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    expect(getModelEffortOptions('deepseek-v4-pro[1m]')).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    expect(getModelEffortOptions('deepseek-chat')).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    expect(getModelEffortOptions('my-proxy/deepseek-reasoner')).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    expect(getModelEffortOptions('deepseek-reasoner', { protocol: 'openai-responses' }))
      .toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    expect(getThinkingCapability('deepseek-reasoner').thinkingProtocol).toBe('openai-reasoning');

    // Anthropic-compatible surface (DeepSeek's /anthropic endpoint) maps to
    // adaptive output_config.effort and keeps the same full scale.
    expect(getModelEffortOptions('deepseek-v4-pro', { protocol: 'anthropic' }))
      .toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    expect(getThinkingCapability('deepseek-v4-pro', { protocol: 'anthropic' }).thinkingProtocol)
      .toBe('anthropic-adaptive');
  });

  it('maps the full DeepSeek scale through the OpenAI reasoning wire enum', () => {
    expect(mapEffortToOpenAIReasoning('minimal')).toBe('minimal');
    expect(mapEffortToOpenAIReasoning('low')).toBe('low');
    expect(mapEffortToOpenAIReasoning('medium')).toBe('medium');
    expect(mapEffortToOpenAIReasoning('high')).toBe('high');
    expect(mapEffortToOpenAIReasoning('xhigh')).toBe('xhigh');
    expect(mapEffortToOpenAIReasoning('max')).toBe('max');
  });

  it('lets explicit xhigh/max through the router effort filter for DeepSeek models', () => {
    expect(filterEffortForModel({ model: 'deepseek-reasoner', effort: 'high', effortSource: 'user' }))
      .toMatchObject({ effort: 'high', effortSource: 'user' });
    expect(filterEffortForModel({ model: 'deepseek/deepseek-v4-pro', effort: 'xhigh', effortSource: 'user' }))
      .toMatchObject({ effort: 'xhigh', effortSource: 'user' });
    expect(filterEffortForModel({ model: 'deepseek/deepseek-v4-pro', effort: 'max', effortSource: 'user' }))
      .toMatchObject({ effort: 'max', effortSource: 'user' });
    // Anthropic-compatible provider entry, same acceptance.
    expect(filterEffortForModel(
      { model: 'deepseek/deepseek-v4-pro', effort: 'max', effortSource: 'user' },
      { protocol: 'anthropic', entry: { id: 'deepseek-v4-pro' } },
    )).toMatchObject({ effort: 'max', effortSource: 'user' });
    // minimal is not part of the DeepSeek scale.
    expect(filterEffortForModel({ model: 'deepseek-reasoner', effort: 'minimal', effortSource: 'user' }).effort)
      .toBeUndefined();
  });

  it('sends xhigh/max over the OpenAI Responses wire for DeepSeek models', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ output_text: 'ok', usage: {} }));
    const adapter = new OpenAIResponsesAdapter({ apiKey: 'test', baseUrl: 'https://api.deepseek.test/v1' });

    await adapter.call({
      model: 'deepseek-reasoner',
      system: 's',
      messages: [{ role: 'user', content: 'hi' }],
      effort: 'max',
      effortSource: 'user',
    });
    let body = JSON.parse(fetchMock.mock.calls.at(-1)[1].body);
    expect(body.reasoning).toEqual({ effort: 'max' });

    await adapter.call({
      model: 'deepseek-reasoner',
      system: 's',
      messages: [{ role: 'user', content: 'hi' }],
      effort: 'xhigh',
      effortSource: 'user',
    });
    body = JSON.parse(fetchMock.mock.calls.at(-1)[1].body);
    expect(body.reasoning).toEqual({ effort: 'xhigh' });
  });

  it('sends max over the Anthropic output_config wire for DeepSeek models', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({
      content: [{ type: 'text', text: 'ok' }],
      usage: {},
    }));
    const adapter = new AnthropicAdapter({ apiKey: 'test', baseUrl: 'https://api.deepseek.test' });

    await adapter.call({
      model: 'deepseek-v4-pro',
      system: 's',
      messages: [{ role: 'user', content: 'hi' }],
      maxTokens: 1000,
      effort: 'max',
      effortSource: 'user',
      // Router threads the effective provider protocol into effortContext.
      effortContext: { protocol: 'anthropic' },
    });

    const body = JSON.parse(fetchMock.mock.calls.at(-1)[1].body);
    expect(body.thinking).toEqual({ type: 'adaptive' });
    expect(body.output_config).toEqual({ effort: 'max' });
    expect(body.max_tokens).toBe(1000);
  });

  it('routes DeepSeek max effort through an Anthropic-compatible provider end-to-end', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({
      content: [{ type: 'text', text: 'ok' }],
      usage: {},
    }));
    const router = new AdapterRouter({
      providers: [{
        name: 'deepseek',
        baseUrl: 'https://api.deepseek.test',
        apiKey: 'test',
        protocol: 'anthropic',
        models: ['deepseek-v4-pro'],
      }],
    });

    await router.call({
      model: 'deepseek/deepseek-v4-pro',
      system: 's',
      messages: [{ role: 'user', content: 'hi' }],
      maxTokens: 1000,
      effort: 'max',
      effortSource: 'user',
    });

    const body = JSON.parse(fetchMock.mock.calls.at(-1)[1].body);
    expect(body.model).toBe('deepseek-v4-pro');
    expect(body.thinking).toEqual({ type: 'adaptive' });
    expect(body.output_config).toEqual({ effort: 'max' });
  });

  it('derives full effort metadata for DeepSeek providers in availableModels', () => {
    const dir = mkdtempSync(join(tmpdir(), 'yeaft-deepseek-effort-'));
    writeFileSync(join(dir, 'config.json'), JSON.stringify({
      providers: [
        { name: 'deepseek-anthropic', protocol: 'anthropic', apiKey: 'x', models: ['deepseek-v4-pro', 'deepseek-v4-pro[1m]'] },
        { name: 'deepseek-responses', protocol: 'openai-responses', apiKey: 'x', models: ['deepseek-reasoner'] },
      ],
      primaryModel: 'deepseek-anthropic/deepseek-v4-pro',
    }));
    try {
      const config = loadConfig({ dir });
      const byRef = Object.fromEntries(config.availableModels.map((m) => [m.ref, m]));
      expect(byRef['deepseek-anthropic/deepseek-v4-pro']).toMatchObject({
        supportsEffort: true,
        effortOptions: ['low', 'medium', 'high', 'xhigh', 'max'],
        effortProtocol: 'anthropic-adaptive',
      });
      expect(byRef['deepseek-anthropic/deepseek-v4-pro[1m]']).toMatchObject({
        supportsEffort: true,
        effortOptions: ['low', 'medium', 'high', 'xhigh', 'max'],
        effortProtocol: 'anthropic-adaptive',
      });
      expect(byRef['deepseek-responses/deepseek-reasoner']).toMatchObject({
        supportsEffort: true,
        effortOptions: ['low', 'medium', 'high', 'xhigh', 'max'],
        effortProtocol: 'openai-reasoning',
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
