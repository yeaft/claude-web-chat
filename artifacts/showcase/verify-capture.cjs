#!/usr/bin/env node
// Focused integration check: capture errors must fail closed without publishing assets.
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { mkdtempSync, readdirSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');
for (const scenario of ['runtime', 'blank']) {
  const output = mkdtempSync(path.join(tmpdir(), `yeaft-capture-check-${scenario}-`));
  try {
    const result = spawnSync(process.execPath, [path.join(__dirname, 'capture-workbench.cjs')], {
      cwd: root, encoding: 'utf8', timeout: 60000,
      env: { ...process.env, YEAFT_SHOWCASE_FAILURE: scenario, YEAFT_SHOWCASE_OUTPUT_DIR: output },
    });
    assert.ifError(result.error);
    assert.equal(result.status, 1, `${scenario} must fail\n${result.stdout}\n${result.stderr}`);
    assert.match(result.stderr, scenario === 'runtime' ? /Injected capture runtime error/ : /Blank UI|toBeVisible/);
    assert.deepEqual(readdirSync(output), [], `${scenario} published invalid screenshots`);
    console.log(`PASS ${scenario}: exit 1; no assets published`);
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
}
