#!/usr/bin/env node
import { probeBrowserRuntime } from '../agent/browser-runtime/probe.js';
import { defaultBrowserCacheDir } from '../agent/browser-runtime/browser-install.js';

const executableIndex = process.argv.indexOf('--executable');
const executablePath = executableIndex >= 0 ? process.argv[executableIndex + 1] : null;
const cacheIndex = process.argv.indexOf('--cache-dir');
const cacheDir = cacheIndex >= 0
  ? process.argv[cacheIndex + 1]
  : defaultBrowserCacheDir(process.env.YEAFT_DIR || `${process.env.HOME}/.yeaft`);
const result = await probeBrowserRuntime({
  executablePath,
  cacheDir,
  headless: !process.argv.includes('--headful'),
});
console.log(JSON.stringify(result, null, 2));
if (!result.ok) process.exitCode = 1;
