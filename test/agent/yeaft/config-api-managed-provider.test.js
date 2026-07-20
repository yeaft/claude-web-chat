import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

vi.mock('../../../agent/yeaft/llm/credentials/index.js', () => ({
  CREDENTIAL_PROVIDER_NAMES: { GITHUB_COPILOT: 'github-copilot' },
  getCredentialProvider: () => ({ getApiKey: async () => 'copilot-token' }),
}));

import { updateLlmConfig } from '../../../agent/yeaft/config-api.js';
import { loadConfig } from '../../../agent/yeaft/config.js';
import { AdapterRouter } from '../../../agent/yeaft/llm/router.js';

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'yeaft-config-api-managed-'));
}

describe('LLM config API managed providers', () => {
  it('persists the discovered GitHub Copilot model catalog', () => {
    const dir = tempDir();
    try {
      const result = updateLlmConfig({
        providers: [{
          name: 'github-copilot',
          baseUrl: 'https://api.githubcopilot.com',
          credentialProvider: 'github-copilot',
          protocol: 'openai-responses',
          models: [{ id: 'claude-opus-4.8', protocol: 'anthropic' }, { id: 'gpt-5', protocol: 'openai-responses' }],
        }],
        primaryModel: 'github-copilot/claude-opus-4.8',
      }, dir);

      expect(result.error).toBeUndefined();
      const saved = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'));
      expect(saved.providers).toEqual([{
        name: 'github-copilot',
        credentialProvider: 'github-copilot',
        managed: 'github-copilot',
        models: [
          { id: 'claude-opus-4.8', protocol: 'anthropic' },
          { id: 'gpt-5', protocol: 'openai-responses' },
        ],
      }]);
      expect(saved.primaryModel).toBe('github-copilot/claude-opus-4.8');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('replaces stale primary and fast defaults when the managed catalog changes', () => {
    const dir = tempDir();
    try {
      writeFileSync(join(dir, 'config.json'), JSON.stringify({
        providers: [{
          name: 'github-copilot',
          credentialProvider: 'github-copilot',
          models: ['gpt-old'],
        }],
        primaryModel: 'github-copilot/gpt-old',
        fastModel: 'github-copilot/gpt-old',
      }));

      const result = updateLlmConfig({
        providers: [{
          name: 'github-copilot',
          credentialProvider: 'github-copilot',
          models: ['gpt-new'],
        }],
        primaryModel: 'github-copilot/gpt-new',
      }, dir);

      expect(result).toMatchObject({
        primaryModel: 'github-copilot/gpt-new',
        fastModel: 'github-copilot/gpt-new',
      });
      const saved = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'));
      expect(saved.primaryModel).toBe('github-copilot/gpt-new');
      expect(saved.fastModel).toBe('github-copilot/gpt-new');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('replaces legacy bare defaults through save, disk, runtime, and stream', async () => {
    const dir = tempDir();
    const responsesCompletedBody = [
      'event: response.completed',
      'data: {"type":"response.completed","response":{"status":"completed","output":[],"usage":{"input_tokens":0,"output_tokens":0}}}',
      '',
    ].join('\n');
    const fetchFn = vi.fn(async () => ({
      ok: true,
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(responsesCompletedBody));
          controller.close();
        },
      }),
    }));
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchFn;
    try {
      writeFileSync(join(dir, 'config.json'), JSON.stringify({
        providers: [{
          name: 'github-copilot',
          credentialProvider: 'github-copilot',
          models: ['gpt-old'],
        }],
        primaryModel: 'gpt-old',
        fastModel: 'gpt-old',
      }));

      const result = updateLlmConfig({
        providers: [{
          name: 'github-copilot',
          credentialProvider: 'github-copilot',
          models: ['gpt-new'],
        }],
      }, dir);

      expect(result).toMatchObject({
        primaryModel: 'github-copilot/gpt-new',
        fastModel: 'github-copilot/gpt-new',
      });
      const saved = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'));
      expect(saved.primaryModel).toBe('github-copilot/gpt-new');
      expect(saved.fastModel).toBe('github-copilot/gpt-new');

      const runtime = loadConfig({ dir });
      expect(runtime.primaryModel).toBe('github-copilot/gpt-new');
      expect(runtime.fastModel).toBe('github-copilot/gpt-new');
      expect(runtime.fastModelId).toBe('gpt-new');

      const router = new AdapterRouter({ providers: runtime.providers });
      const stream = router.stream({ model: runtime.fastModel, messages: [] });
      for await (const _ of stream) {}
      expect(fetchFn).toHaveBeenCalledTimes(1);
      expect(JSON.parse(fetchFn.mock.calls[0][1].body).model).toBe('gpt-new');
    } finally {
      globalThis.fetch = originalFetch;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('falls back from an ambiguous bare default to the new managed primary', () => {
    const dir = tempDir();
    try {
      writeFileSync(join(dir, 'config.json'), JSON.stringify({
        providers: [{
          name: 'github-copilot',
          credentialProvider: 'github-copilot',
          models: ['gpt-old'],
        }],
        primaryModel: 'gpt-old',
        fastModel: 'shared-model',
      }));

      const result = updateLlmConfig({
        providers: [
          {
            name: 'github-copilot',
            credentialProvider: 'github-copilot',
            models: ['gpt-new', 'shared-model'],
          },
          {
            name: 'custom',
            baseUrl: 'https://custom.example/v1',
            apiKey: 'key',
            models: ['shared-model'],
          },
        ],
        primaryModel: 'github-copilot/gpt-new',
      }, dir);

      expect(result.fastModel).toBe('github-copilot/gpt-new');
      const saved = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'));
      expect(saved.fastModel).toBe('github-copilot/gpt-new');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps a bare default uniquely owned by a custom provider', () => {
    const dir = tempDir();
    try {
      writeFileSync(join(dir, 'config.json'), JSON.stringify({
        providers: [
          {
            name: 'github-copilot',
            credentialProvider: 'github-copilot',
            models: ['gpt-old'],
          },
          {
            name: 'custom',
            baseUrl: 'https://custom.example/v1',
            apiKey: 'key',
            models: ['custom-fast'],
          },
        ],
        primaryModel: 'github-copilot/gpt-old',
        fastModel: 'custom-fast',
      }));

      const result = updateLlmConfig({
        providers: [
          {
            name: 'github-copilot',
            credentialProvider: 'github-copilot',
            models: ['gpt-new'],
          },
          {
            name: 'custom',
            baseUrl: 'https://custom.example/v1',
            apiKey: 'key',
            models: ['custom-fast'],
          },
        ],
        primaryModel: 'github-copilot/gpt-new',
      }, dir);

      expect(result.fastModel).toBe('custom-fast');
      const saved = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'));
      expect(saved.fastModel).toBe('custom-fast');
      expect(loadConfig({ dir }).fastModelId).toBe('custom-fast');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('still requires baseUrl and models for custom providers', () => {
    const dir = tempDir();
    try {
      expect(updateLlmConfig({ providers: [{ name: 'custom' }] }, dir).error)
        .toBe('Provider "custom" must have a baseUrl');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
