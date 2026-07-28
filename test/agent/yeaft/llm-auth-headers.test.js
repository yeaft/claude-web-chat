import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { archiveOne } from '../../../agent/yeaft/archive/tool-results.js';
import { AnthropicAdapter } from '../../../agent/yeaft/llm/anthropic.js';
import { OpenAIResponsesAdapter } from '../../../agent/yeaft/llm/openai-responses.js';
import {
  AdapterRouter,
  anthropicAuthHeaderModeForProvider,
} from '../../../agent/yeaft/llm/router.js';

const originalFetch = global.fetch;
const cleanup = [];

function jsonResponse(body) {
  return {
    ok: true,
    status: 200,
    headers: new Headers(),
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

function anthropicResponse() {
  return jsonResponse({
    content: [{ type: 'text', text: 'ok' }],
    usage: { input_tokens: 1, output_tokens: 1 },
  });
}

describe('LLM adapter auth headers', () => {
  afterEach(async () => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
    await Promise.all(cleanup.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
  });

  it('selects native and bearer Anthropic authentication headers', async () => {
    const calls = [];
    global.fetch = vi.fn(async (url, init) => {
      calls.push({ url, init });
      return anthropicResponse();
    });

    const native = new AnthropicAdapter({
      apiKey: 'anthropic-key',
      baseUrl: 'https://api.anthropic.com',
    });
    await native.call({ model: 'claude-sonnet-4.5', system: '', messages: [] });
    expect(calls[0].url).toBe('https://api.anthropic.com/v1/messages');
    expect(calls[0].init.headers['x-api-key']).toBe('anthropic-key');
    expect(calls[0].init.headers.Authorization).toBeUndefined();
    expect(calls[0].init.headers['anthropic-version']).toBe('2023-06-01');

    const bearer = new AnthropicAdapter({
      apiKey: 'copilot-token',
      baseUrl: 'https://api.githubcopilot.com',
      authHeaderMode: 'bearer',
    });
    await bearer.call({ model: 'claude-opus-4.8', system: '', messages: [] });
    expect(calls[1].url).toBe('https://api.githubcopilot.com/v1/messages');
    expect(calls[1].init.headers.Authorization).toBe('Bearer copilot-token');
    expect(calls[1].init.headers['x-api-key']).toBeUndefined();
    expect(calls[1].init.headers['anthropic-version']).toBe('2023-06-01');
  });

  it('selects bearer auth for Copilot and credential-backed Anthropic providers', () => {
    expect(anthropicAuthHeaderModeForProvider({
      name: 'github-copilot',
      baseUrl: 'https://api.githubcopilot.com',
    })).toBe('bearer');
    expect(anthropicAuthHeaderModeForProvider({
      name: 'custom-token-provider',
      baseUrl: 'https://llm.example.test',
      credentialProvider: 'custom-token-provider',
    })).toBe('bearer');
    expect(anthropicAuthHeaderModeForProvider({
      name: 'custom-token-provider',
      baseUrl: 'https://llm.example.test',
      credentialProvider: 'custom-token-provider',
      anthropicAuthHeaderMode: 'x-api-key',
    })).toBe('x-api-key');
    expect(anthropicAuthHeaderModeForProvider({
      name: 'anthropic',
      baseUrl: 'https://api.anthropic.com',
      apiKey: 'static-key',
    })).toBe('x-api-key');
  });

  it('routes Anthropic providers configured for bearer auth through the router', async () => {
    const calls = [];
    global.fetch = vi.fn(async (url, init) => {
      calls.push({ url, init });
      return anthropicResponse();
    });

    const router = new AdapterRouter({ providers: [{
      name: 'copilot-static-test',
      baseUrl: 'https://api.githubcopilot.com',
      apiKey: 'copilot-token',
      anthropicAuthHeaderMode: 'bearer',
      models: [{ id: 'claude-opus-4.8', protocol: 'anthropic' }],
    }] });
    await router.call({ model: 'copilot-static-test/claude-opus-4.8', system: '', messages: [] });

    expect(calls[0].url).toBe('https://api.githubcopilot.com/v1/messages');
    expect(calls[0].init.headers.Authorization).toBe('Bearer copilot-token');
    expect(calls[0].init.headers['x-api-key']).toBeUndefined();
  });

  it('keeps OpenAI Responses requests on bearer Authorization', async () => {
    const calls = [];
    global.fetch = vi.fn(async (url, init) => {
      calls.push({ url, init });
      return jsonResponse({ output_text: 'ok', usage: { input_tokens: 1, output_tokens: 1 } });
    });

    const adapter = new OpenAIResponsesAdapter({
      apiKey: 'copilot-token',
      baseUrl: 'https://api.githubcopilot.com/v1',
    });
    await adapter.call({ model: 'gpt-5.5', system: '', messages: [] });

    expect(calls[0].url).toBe('https://api.githubcopilot.com/v1/responses');
    expect(calls[0].init.headers.Authorization).toBe('Bearer copilot-token');
    expect(calls[0].init.headers['x-api-key']).toBeUndefined();
  });

  it('translates PDF document blocks to Responses input_file content', async () => {
    const calls = [];
    global.fetch = vi.fn(async (url, init) => {
      calls.push({ url, body: JSON.parse(init.body) });
      return jsonResponse({ output_text: 'ok', usage: { input_tokens: 1, output_tokens: 1 } });
    });

    const adapter = new OpenAIResponsesAdapter({ apiKey: 'key', baseUrl: 'https://openai.test/v1' });
    await adapter.call({
      model: 'gpt-5.5',
      system: '',
      messages: [{
        type: 'message',
        role: 'user',
        content: [{
          type: 'document',
          source: { type: 'base64', media_type: 'application/pdf', data: 'cGRm' },
          title: 'requirements.pdf',
        }],
      }],
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].body.input).toEqual([{
      type: 'message',
      role: 'user',
      content: [{
        type: 'input_file',
        filename: 'requirements.pdf',
        file_data: 'data:application/pdf;base64,cGRm',
      }],
    }]);
  });

  it('keeps provider request bodies and archive previews valid when strings contain lone surrogates', async () => {
    const calls = [];
    global.fetch = vi.fn(async (url, init) => {
      const body = JSON.parse(init.body);
      calls.push({ url, body, serializedBody: init.body });
      if (body.stream) {
        const event = JSON.stringify({
          type: 'response.completed',
          response: { status: 'completed', usage: { input_tokens: 1, output_tokens: 1 } },
        });
        return new Response(`data: ${event}\n\n`, { status: 200, headers: { 'content-type': 'text/event-stream' } });
      }
      return url.includes('anthropic')
        ? anthropicResponse()
        : jsonResponse({ output_text: 'ok', usage: { input_tokens: 1, output_tokens: 1 } });
    });

    const ownProto = JSON.parse('{"__proto__":{"polluted":"yes"}}');
    const crossRealmText = runInNewContext(`new String('cross\\uD800')`);
    const spoofedText = { value: 'keep-me', [Symbol.toStringTag]: 'String' };
    const throwingTag = { value: 'still-here' };
    Object.defineProperty(throwingTag, Symbol.toStringTag, {
      get() { throw new Error('must not inspect Symbol.toStringTag'); },
    });
    const responses = new OpenAIResponsesAdapter({ apiKey: 'key', baseUrl: 'https://openai.test/v1' });
    await responses.call({
      model: 'gpt-5.5',
      system: `system \uDFFF`,
      messages: [
        { role: 'user', content: `valid 😀 user \uD800` },
        { role: 'assistant', content: '', toolCalls: [{ id: 'call-1', name: 'tool', input: { value: `arg \uD800` } }] },
        { role: 'tool', toolCallId: 'call-1', content: `output \uD83D` },
      ],
      extraBody: {
        metadata: {
          label: `meta \uDFFF`,
          at: new Date('2026-01-02T03:04:05Z'),
          bytes: Buffer.from([1, 2]),
          boxed: new Number(7),
          boxedText: { nested: new String(`boxed \uD800`), crossRealmText },
          spoofedText,
          throwingTag,
          custom: { toJSON(key) { return { key, text: `custom \uD800` }; } },
          customText: { toJSON() { return new String(`custom boxed \uDFFF`); } },
          ownProto,
        },
      },
    });
    expect(calls[0].body).toMatchObject({
      instructions: 'system �',
      metadata: {
        label: 'meta �',
        at: '2026-01-02T03:04:05.000Z',
        bytes: { type: 'Buffer', data: [1, 2] },
        boxed: 7,
        boxedText: { nested: 'boxed �', crossRealmText: 'cross�' },
        spoofedText: { value: 'keep-me' },
        throwingTag: { value: 'still-here' },
        custom: { key: 'custom', text: 'custom �' },
        customText: 'custom boxed �',
        ownProto: { __proto__: { polluted: 'yes' } },
      },
      input: [
        { content: [{ text: 'valid 😀 user �' }] },
        { arguments: '{"value":"arg �"}' },
        { output: 'output �' },
      ],
    });
    expect(calls[0].body.metadata.boxedText.nested.isWellFormed()).toBe(true);
    expect(calls[0].body.metadata.boxedText.crossRealmText.isWellFormed()).toBe(true);
    expect(calls[0].body.metadata.spoofedText).toEqual({ value: 'keep-me' });
    expect(calls[0].body.metadata.throwingTag).toEqual({ value: 'still-here' });
    expect(calls[0].body.metadata.customText.isWellFormed()).toBe(true);
    expect(Object.hasOwn(calls[0].body.metadata.ownProto, '__proto__')).toBe(true);
    expect(calls[0].body.metadata.ownProto.polluted).toBeUndefined();

    const anthropic = new AnthropicAdapter({ apiKey: 'key', baseUrl: 'https://anthropic.test' });
    await anthropic.call({
      model: 'claude-sonnet-4.5',
      system: `system \uD800`,
      messages: [{ role: 'user', content: `valid 😀 user \uDFFF` }],
    });
    expect(calls[1].body.system).toBe(`system ${String.fromCodePoint(0xFFFD)}`);
    expect(calls[1].body.messages[0].content).toBe(`valid 😀 user ${String.fromCodePoint(0xFFFD)}`);

    let rawExchange;
    for await (const _event of responses.stream({
      model: 'gpt-5.5',
      system: `stream \uD800`,
      messages: [{ role: 'user', content: 'hi' }],
      onRawExchange(exchange) { rawExchange = exchange; },
    })) { /* consume */ }
    expect(JSON.stringify(rawExchange.rawRequest.body)).toBe(calls[2].serializedBody);
    expect(rawExchange.rawRequest.body.instructions).toBe('stream �');

    const root = await mkdtemp(join(tmpdir(), 'yeaft-archive-preview-'));
    cleanup.push(root);
    const archived = await archiveOne({
      root,
      scopeDir: 'session/test',
      message: { role: 'tool', toolCallId: 'call-1', content: `${'a'.repeat(199)}😀tail` },
    });
    expect(archived.stub.content).toContain(`${'a'.repeat(199)}${String.fromCodePoint(0xFFFD)}`);
    expect(archived.stub.content.isWellFormed()).toBe(true);
  });
});
