import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { updateLlmConfig } from '../../../agent/yeaft/config-api.js';

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
