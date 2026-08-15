import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

async function waitForFile(path, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return;
    await new Promise(resolvePromise => setTimeout(resolvePromise, 20));
  }
  throw new Error(`Timed out waiting for ${path}`);
}

function stopChild(child) {
  return new Promise(resolvePromise => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolvePromise();
      return;
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
    }, 1000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolvePromise();
    });
    child.kill('SIGTERM');
  });
}

describe('container Agent startup initialization', () => {
  it('creates the default Yeaft provider and model config before connecting', async () => {
    const root = mkdtempSync(join(tmpdir(), 'yeaft-container-init-'));
    const workDir = join(root, 'work');
    const child = spawn(process.execPath, [resolve(process.cwd(), 'agent/index.js')], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        YEAFT_DIR: root,
        WORK_DIR: workDir,
        SERVER_URL: 'ws://127.0.0.1:1',
        AGENT_SECRET: 'container-test-secret',
        YEAFT_SKIP_STARTUP_INSTALLS: 'true',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    try {
      const configPath = join(root, 'config.json');
      await waitForFile(configPath);
      const config = JSON.parse(readFileSync(configPath, 'utf8'));
      expect(config.providers).toEqual(expect.arrayContaining([
        expect.objectContaining({
          name: 'my-proxy',
          models: expect.arrayContaining(['claude-sonnet-4-20250514']),
        }),
      ]));
      expect(config.primaryModel).toBe('my-proxy/claude-sonnet-4-20250514');
      expect(config.fastModel).toBe('my-proxy/claude-sonnet-4-20250514');
    } catch (error) {
      throw new Error(`${error.message}; child stderr: ${stderr}`);
    } finally {
      await stopChild(child);
      rmSync(root, { recursive: true, force: true });
    }
  });
});
