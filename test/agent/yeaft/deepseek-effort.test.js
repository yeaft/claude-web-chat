import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { loadConfig } from '../../../agent/yeaft/config.js';
import {
  getModelEffortOptions,
  getThinkingCapability,
  mapEffortToOpenAIReasoning,
  normalizeEffort,
} from '../../../agent/yeaft/models.js';
import { filterEffortForModel, AdapterRouter } from '../../../agent/yeaft/llm/router.js';
import { OpenAIResponsesAdapter } from '../../../agent/yeaft/llm/openai-responses.js';
import { AnthropicAdapter } from '../../../agent/yeaft/llm/anthropic.js';
import { parseEffortPrefix } from '../../../agent/yeaft/effort.js';
import { resolveWorkItemModel } from '../../../agent/yeaft/work-center/assignment.js';
import { normalizeModelPolicy } from '../../../agent/yeaft/work-center/workflow.js';

function jsonResponse(body) {
  return {
    ok: true,
    status: 200,
    headers: { get: () => 'application/json' },
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

describe('GPT-5.5+ ultra effort', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('advertises ultra only for GPT-5.5 and later base models and variants', () => {
    const ultraOptions = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
    expect(getModelEffortOptions('gpt-5.4')).not.toContain('ultra');
    expect(getModelEffortOptions('gpt-5.5')).toEqual(ultraOptions);
    expect(getModelEffortOptions('gpt-5.5[1m]')).toEqual(ultraOptions);
    expect(getModelEffortOptions('github-copilot/gpt-5.5-codex')).toEqual(ultraOptions);
    expect(getModelEffortOptions('gpt-5.6')).toEqual(ultraOptions);
    expect(getModelEffortOptions('gpt-5.10-pro')).toEqual(ultraOptions);
    expect(getModelEffortOptions('gpt-6')).toEqual(ultraOptions);
    expect(getModelEffortOptions('gpt-5-mini')).not.toContain('ultra');
    expect(getModelEffortOptions('o4-mini')).not.toContain('ultra');
  });

  it('normalizes and maps ultra through the OpenAI reasoning wire enum', () => {
    expect(normalizeEffort('ultra')).toBe('ultra');
    expect(mapEffortToOpenAIReasoning('ultra')).toBe('ultra');
    expect(parseEffortPrefix('/ultra inspect this')).toEqual({ effort: 'ultra', cleanedPrompt: 'inspect this' });
  });

  it('passes ultra through the router only for GPT-5.5 and later', () => {
    expect(filterEffortForModel({ model: 'gpt-5.5', effort: 'ultra', effortSource: 'user' }))
      .toMatchObject({ effort: 'ultra', effortSource: 'user' });
    expect(filterEffortForModel({ model: 'openai/gpt-6', effort: 'ultra', effortSource: 'user' }))
      .toMatchObject({ effort: 'ultra', effortSource: 'user' });
    expect(filterEffortForModel({ model: 'gpt-5.4', effort: 'ultra', effortSource: 'user' }).effort)
      .toBeUndefined();
  });

  it('keeps ultra valid through Work Center policy and model assignment', () => {
    expect(normalizeModelPolicy({ mode: 'specific', model: 'openai/gpt-5.5', effort: 'ultra' }))
      .toEqual({ mode: 'specific', model: 'openai/gpt-5.5', effort: 'ultra' });
    expect(resolveWorkItemModel({
      primaryModel: 'openai/gpt-5.5',
      availableModels: [{
        ref: 'openai/gpt-5.5',
        id: 'gpt-5.5',
        provider: 'openai',
        effortOptions: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
      }],
    }, {}, { mode: 'specific', model: 'openai/gpt-5.5', effort: 'ultra' })).toMatchObject({
      model: 'openai/gpt-5.5',
      effort: 'ultra',
    });
  });

  it('sends ultra over the OpenAI Responses wire for GPT-5.5', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ output_text: 'ok', usage: {} }));
    const adapter = new OpenAIResponsesAdapter({ apiKey: 'test', baseUrl: 'https://api.openai.test/v1' });

    await adapter.call({
      model: 'gpt-5.5',
      system: 's',
      messages: [{ role: 'user', content: 'hi' }],
      effort: 'ultra',
      effortSource: 'user',
    });

    const body = JSON.parse(fetchMock.mock.calls.at(-1)[1].body);
    expect(body.reasoning).toEqual({ effort: 'ultra' });
  });

  it('derives ultra effort metadata for GPT-5.5 provider entries', () => {
    const dir = mkdtempSync(join(tmpdir(), 'yeaft-gpt-ultra-effort-'));
    writeFileSync(join(dir, 'config.json'), JSON.stringify({
      providers: [{ name: 'openai', protocol: 'openai-responses', apiKey: 'x', models: ['gpt-5.4', 'gpt-5.5', 'gpt-6'] }],
      primaryModel: 'openai/gpt-5.5',
    }));
    try {
      const config = loadConfig({ dir });
      const byRef = Object.fromEntries(config.availableModels.map((m) => [m.ref, m]));
      expect(byRef['openai/gpt-5.4'].effortOptions).not.toContain('ultra');
      expect(byRef['openai/gpt-5.5'].effortOptions).toEqual(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
      expect(byRef['openai/gpt-6'].effortOptions).toEqual(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

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
