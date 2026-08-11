#!/usr/bin/env node
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { probeBrowserRuntime } from '../agent/browser-runtime/probe.js';
import { defaultBrowserCacheDir } from '../agent/browser-runtime/browser-install.js';

function option(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const executablePath = option('--executable');
if (!executablePath) throw new Error('--executable is required');
const runs = Number(option('--runs', '100'));
if (!Number.isInteger(runs) || runs < 1) throw new Error('--runs must be a positive integer');
const output = option('--output', join(process.cwd(), `browser-runtime-soak-${Date.now()}.jsonl`));
const cacheDir = option(
  '--cache-dir',
  defaultBrowserCacheDir(process.env.YEAFT_DIR || `${process.env.HOME}/.yeaft`),
);
const profileParent = `${cacheDir}-profiles`;
await mkdir(profileParent, { recursive: true, mode: 0o700 });
const profileCountBefore = (await readdir(profileParent)).length;
const chromeProcessCount = () => {
  if (process.platform !== 'linux') return null;
  try {
    return execFileSync('pgrep', ['-af', executablePath], { encoding: 'utf8' })
      .split('\n')
      .filter(line => line.trim()
        && !line.includes('pgrep -af')
        && !line.includes('soak-browser-runtime-probe.mjs')).length;
  } catch {
    return 0;
  }
};
const chromeProcessCountBefore = chromeProcessCount();
const durations = [];
let failures = 0;
for (let run = 1; run <= runs; run += 1) {
  const result = await probeBrowserRuntime({ executablePath, cacheDir, profileParent });
  durations.push(result.durationMs);
  if (!result.ok) failures += 1;
  const row = JSON.stringify({ run, ...result });
  await writeFile(output, `${row}\n`, { flag: 'a', mode: 0o600 });
  console.log(row);
  if (!result.ok) break;
}
const sorted = durations.slice().sort((left, right) => left - right);
const percentile = value => sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * value) - 1)] || 0;
const summary = {
  type: 'summary',
  requestedRuns: runs,
  completedRuns: durations.length,
  successes: durations.length - failures,
  failures,
  p50Ms: percentile(0.5),
  p95Ms: percentile(0.95),
  maxMs: sorted.at(-1) || 0,
  profileCountBefore,
  profileCountAfter: (await readdir(profileParent)).length,
  chromeProcessCountBefore,
  chromeProcessCountAfter: chromeProcessCount(),
};
await writeFile(output, `${JSON.stringify(summary)}\n`, { flag: 'a', mode: 0o600 });
console.log(JSON.stringify(summary));
if (failures > 0
  || durations.length !== runs
  || summary.profileCountAfter !== profileCountBefore
  || (chromeProcessCountBefore !== null && summary.chromeProcessCountAfter !== chromeProcessCountBefore)) {
  process.exitCode = 1;
}
