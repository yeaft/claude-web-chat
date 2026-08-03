#!/usr/bin/env node
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const captureScript = resolve(root, 'scripts/capture-doc-screenshots.mjs');
const scenarios = [
  {
    id: 'list',
    env: { YEAFT_DOC_SCREENSHOT_FAIL_WORK_CENTER_OP: 'list' },
    markers: ['Injected screenshot list failure'],
    forbiddenArtifacts: ['work-center.png'],
  },
  {
    id: 'get',
    env: { YEAFT_DOC_SCREENSHOT_FAIL_WORK_CENTER_OP: 'get' },
    markers: ['Injected screenshot get failure'],
    forbiddenArtifacts: ['work-center.png'],
  },
  {
    id: 'get_settings',
    env: { YEAFT_DOC_SCREENSHOT_FAIL_WORK_CENTER_OP: 'get_settings' },
    markers: ['Injected screenshot get_settings failure'],
    forbiddenArtifacts: ['work-center.png'],
  },
  {
    id: 'post-screenshot-console',
    env: { YEAFT_DOC_SCREENSHOT_FAILURE_SCENARIO: 'post-screenshot-console' },
    markers: ['Injected post-screenshot console failure', 'fatal screenshot lifecycle errors'],
    requiredArtifacts: ['work-center.png'],
    forbiddenArtifacts: ['zh-CN/work-center.png'],
  },
  {
    id: 'post-screenshot-pageerror',
    env: { YEAFT_DOC_SCREENSHOT_FAILURE_SCENARIO: 'post-screenshot-pageerror' },
    markers: ['Injected post-screenshot pageerror failure', 'fatal screenshot lifecycle errors'],
    requiredArtifacts: ['work-center.png'],
    forbiddenArtifacts: ['zh-CN/work-center.png'],
  },
  {
    id: 'post-screenshot-requestfailed',
    env: { YEAFT_DOC_SCREENSHOT_FAILURE_SCENARIO: 'post-screenshot-requestfailed' },
    markers: ['__yeaft-doc-injected-request-failure', 'fatal screenshot lifecycle errors'],
    requiredArtifacts: ['work-center.png'],
    forbiddenArtifacts: ['zh-CN/work-center.png'],
  },
  {
    id: 'visible-typing-error',
    env: { YEAFT_DOC_SCREENSHOT_FAILURE_SCENARIO: 'visible-typing-error' },
    markers: ['Injected visible typing error failure', '[visible-error:en]'],
    requiredArtifacts: ['work-center.png'],
    forbiddenArtifacts: ['zh-CN/work-center.png'],
  },
  {
    id: 'server-exit',
    env: { YEAFT_DOC_SCREENSHOT_FAILURE_SCENARIO: 'server-exit' },
    markers: ['Injected screenshot server exit failure', 'fatal screenshot lifecycle errors'],
    requiredArtifacts: ['work-center.png', 'zh-CN/work-center.png'],
  },
];
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
  for (const scenario of scenarios) {
    const port = await reserveFreePort();
    const scenarioOutput = join(outputRoot, scenario.id);
    const result = spawnSync(process.execPath, [captureScript], {
      cwd: root,
      env: {
        ...process.env,
        YEAFT_DOC_SCREENSHOT_PORT: String(port),
        YEAFT_DOC_SCREENSHOT_OUTPUT_DIR: scenarioOutput,
        ...scenario.env,
      },
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
    });
    const output = `${result.stdout || ''}${result.stderr || ''}`;
    const missingMarkers = scenario.markers.filter(marker => !output.includes(marker));
    const missingArtifacts = (scenario.requiredArtifacts || []).filter(path => !existsSync(join(scenarioOutput, path)));
    const unexpectedArtifacts = (scenario.forbiddenArtifacts || []).filter(path => existsSync(join(scenarioOutput, path)));
    if (result.error || result.signal || result.status === 0
        || missingMarkers.length || missingArtifacts.length || unexpectedArtifacts.length) {
      process.stderr.write(output);
      throw new Error([
        `Screenshot failure gate did not fail closed for ${scenario.id}`,
        `status=${result.status} signal=${result.signal || 'none'}`,
        missingMarkers.length ? `missing markers=${missingMarkers.join(', ')}` : '',
        missingArtifacts.length ? `missing artifacts=${missingArtifacts.join(', ')}` : '',
        unexpectedArtifacts.length ? `unexpected artifacts=${unexpectedArtifacts.join(', ')}` : '',
        result.error?.message || '',
      ].filter(Boolean).join('\n'));
    }
    console.log(`${scenario.id}: rejected with exit ${result.status}`);
  }
} finally {
  rmSync(outputRoot, { recursive: true, force: true });
}
