import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { getLlmConfig, updateLlmConfig } from '../../../agent/yeaft/config-api.js';

const roots = [];

function tempRoot() {
  const root = mkdtempSync(join(tmpdir(), 'yeaft-config-api-debug-'));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('updateLlmConfig debug flag', () => {
  it('defaults to false when config.json has no debug field', () => {
    const root = tempRoot();
    writeFileSync(join(root, 'config.json'), JSON.stringify({
      providers: [{ name: 'p', baseUrl: 'http://x', models: ['m'] }],
      primaryModel: 'p/m',
    }), 'utf8');
    const read = getLlmConfig(root);
    expect(read.agentConfig.debug).toBe(false);
    expect(read.debug).toBe(false);
  });

  it('persists debug=true and returns it on read-back', () => {
    const root = tempRoot();
    writeFileSync(join(root, 'config.json'), JSON.stringify({
      providers: [{ name: 'p', baseUrl: 'http://x', models: ['m'] }],
      primaryModel: 'p/m',
      debug: false,
    }), 'utf8');
    const result = updateLlmConfig({ debug: true, providers: [{ name: 'p', baseUrl: 'http://x', models: ['m'] }], primaryModel: 'p/m' }, root);
    expect(result.error).toBeUndefined();
    expect(result.agentConfig.debug).toBe(true);

    const raw = JSON.parse(readFileSync(join(root, 'config.json'), 'utf8'));
    expect(raw.debug).toBe(true);
    expect(getLlmConfig(root).agentConfig.debug).toBe(true);
  });

  it('preserves debug when an LLM update does not touch it', () => {
    const root = tempRoot();
    writeFileSync(join(root, 'config.json'), JSON.stringify({
      providers: [{ name: 'p', baseUrl: 'http://x', models: ['m'] }],
      primaryModel: 'p/m',
      debug: true,
      maxContextTokens: 200000,
    }), 'utf8');
    const result = updateLlmConfig({ providers: [{ name: 'p', baseUrl: 'http://x', models: ['m'] }], primaryModel: 'p/m' }, root);
    expect(result.agentConfig.debug).toBe(true);
    const raw = JSON.parse(readFileSync(join(root, 'config.json'), 'utf8'));
    expect(raw.debug).toBe(true);
    expect(raw.maxContextTokens).toBe(200000);
  });

  it('normalizes non-boolean debug payloads to a real boolean', () => {
    const root = tempRoot();
    writeFileSync(join(root, 'config.json'), JSON.stringify({
      providers: [{ name: 'p', baseUrl: 'http://x', models: ['m'] }],
      primaryModel: 'p/m',
    }), 'utf8');
    const result = updateLlmConfig({ debug: 'yes' }, root);
    expect(result.agentConfig.debug).toBe(false);
    const raw = JSON.parse(readFileSync(join(root, 'config.json'), 'utf8'));
    expect(raw.debug).toBe(false);
  });

  it('creates config.json when absent and writes debug=false explicitly', () => {
    const root = tempRoot();
    const result = updateLlmConfig({ debug: false }, root);
    expect(result.error).toBeUndefined();
    expect(existsSync(join(root, 'config.json'))).toBe(true);
    expect(getLlmConfig(root).agentConfig.debug).toBe(false);
  });
});
