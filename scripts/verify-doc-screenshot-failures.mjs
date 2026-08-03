#!/usr/bin/env node
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const captureScript = resolve(root, 'scripts/capture-doc-screenshots.mjs');
const failureOps = ['list', 'get', 'get_settings'];
const outputRoot = mkdtempSync(join(tmpdir(), 'yeaft-doc-screenshot-failures-'));

function reserveFreePort() {
  return new Promise((resolvePromise, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(error => {
        if (error) reject(error);
        else resolvePromise(address.port);
      });
    });
  });
}

try {
  for (const op of failureOps) {
    const port = await reserveFreePort();
    const result = spawnSync(process.execPath, [captureScript], {
      cwd: root,
      env: {
        ...process.env,
        YEAFT_DOC_SCREENSHOT_PORT: String(port),
        YEAFT_DOC_SCREENSHOT_OUTPUT_DIR: join(outputRoot, op),
        YEAFT_DOC_SCREENSHOT_FAIL_WORK_CENTER_OP: op,
      },
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
    });
    const output = `${result.stdout || ''}${result.stderr || ''}`;
    const marker = `Injected screenshot ${op} failure`;
    if (result.error || result.signal || result.status === 0 || !output.includes(marker)) {
      process.stderr.write(output);
      throw new Error([
        `Screenshot failure gate did not fail closed for ${op}`,
        `status=${result.status} signal=${result.signal || 'none'}`,
        `expected=${marker}`,
        result.error?.message || '',
      ].filter(Boolean).join('\n'));
    }
    console.log(`${op}: rejected with exit ${result.status}`);
  }
} finally {
  rmSync(outputRoot, { recursive: true, force: true });
}
