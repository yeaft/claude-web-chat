import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { parseArgs } from '../../../agent/yeaft/cli.js';
import { validateSessionId } from '../../../agent/yeaft/sessions/ids.js';

const cli = resolve('agent/yeaft/cli.js');
const dirs = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempYeaftDir() {
  const dir = mkdtempSync(join(tmpdir(), 'yeaft-cli-jsonl-'));
  dirs.push(dir);
  writeFileSync(join(dir, 'config.json'), `${JSON.stringify({
    providers: [{
      name: 'test',
      baseUrl: 'http://127.0.0.1:1/v1',
      apiKey: 'test',
      protocol: 'openai-responses',
      models: ['gpt-test'],
    }],
    primaryModel: 'test/gpt-test',
    language: 'en',
    llmRetry: { maxRetries: 0 },
  })}\n`);
  return dir;
}

function runCli(args, { input = '' } = {}) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, [cli, ...args], {
      cwd: process.cwd(),
      env: { ...process.env, YEAFT_DIR: tempYeaftDir(), YEAFT_SKIP_MODELS_DEV_FETCH: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => resolveRun({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}

describe('Yeaft stream-json CLI', () => {
  it('treats -p/--print as boolean and preserves following options', () => {
    expect(parseArgs(['node', 'cli', '-p', '--output-format', 'stream-json', 'hello'])).toMatchObject({
      print: true,
      outputFormat: 'stream-json',
      prompt: 'hello',
    });
    expect(parseArgs(['node', 'cli', '--output-format', 'stream-json', '--print', 'hello'])).toMatchObject({
      print: true,
      outputFormat: 'stream-json',
      prompt: 'hello',
    });
  });

  it('accepts generated Session IDs and rejects traversal or separators', () => {
    expect(validateSessionId('session_cli_1234')).toEqual({ ok: true });
    for (const id of ['..', '.', 'session_../config', 'session_x/y', 'session_x\\y', 'other']) {
      expect(validateSessionId(id).ok).toBe(false);
    }
  });

  it('keeps stdout as parseable JSONL and rejects an unsafe Session ID before loading it', async () => {
    const result = await runCli(['-p', '--output-format', 'stream-json', '--session-id', '..', 'hello']);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('Invalid --session-id');
  });

  it('runs the real CLI and emits only JSONL on stdout', async () => {
    const result = await runCli(['-p', '--output-format', 'stream-json', '--session-id', 'session_cli_smoke', '--skip-mcp', '--skip-skills', 'hello']);
    const lines = result.stdout.trim().split('\n').filter(Boolean);
    expect(lines.length).toBeGreaterThan(0);
    const events = lines.map(line => JSON.parse(line));
    expect(events[0]).toMatchObject({ type: 'system', subtype: 'init', session_id: 'session_cli_smoke' });
    expect(events.at(-1)).toMatchObject({ type: 'result', session_id: 'session_cli_smoke', is_error: true });
    expect(result.stderr).not.toContain('"type":"system"');
  });
});
