#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';

const outputPath = process.argv[2];
if (!outputPath) {
  console.error('Usage: node scripts/qualify-sandbox-host.mjs <report.json>');
  process.exit(2);
}

function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 30_000 });
  return {
    command: [command, ...args].join(' '),
    ok: result.status === 0,
    status: result.status,
    stdout: String(result.stdout || '').trim().slice(0, 16_384),
    stderr: String(result.stderr || '').trim().slice(0, 16_384)
  };
}

const required = [
  ['/usr/bin/podman', ['info', '--format', 'json']],
  ['/usr/bin/podman', ['info', '--format', '{{.Host.OCIRuntime.Name}}']],
  ['/usr/sbin/xfs_quota', ['-x', '-c', 'state', process.env.SANDBOX_DATA_ROOT || '/var/lib/yeaft-sandbox']],
  ['/usr/sbin/nft', ['--check', 'list', 'ruleset']],
  ['/usr/bin/systemctl', ['is-active', 'yeaft-sandbox-controller.service']],
  ['/usr/bin/systemctl', ['is-active', 'yeaft-sandbox-helper.socket']]
];
const observations = required.map(([command, args]) => {
  if (!existsSync(command)) return { command, ok: false, status: null, stdout: '', stderr: 'missing binary' };
  return run(command, args);
});
const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  hostEpoch: process.env.SANDBOX_HOST_EPOCH || null,
  imageDigest: process.env.SANDBOX_IMAGE_DIGEST || null,
  dedicatedHost: process.env.SANDBOX_DEDICATED_HOST === 'true',
  observations,
  passed: process.env.SANDBOX_DEDICATED_HOST === 'true'
    && Boolean(process.env.SANDBOX_HOST_EPOCH)
    && /^sha256:[a-f0-9]{64}$/.test(process.env.SANDBOX_IMAGE_DIGEST || '')
    && observations.every(item => item.ok)
};
writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
console.log(report.passed ? 'Sandbox Host static qualification passed.' : 'Sandbox Host static qualification failed.');
process.exit(report.passed ? 0 : 1);
