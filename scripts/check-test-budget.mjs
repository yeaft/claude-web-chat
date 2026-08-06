import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, relative, resolve } from 'node:path';
import process from 'node:process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { CORE_TEST_FILES, REVIEWED_TEST_FILES, isTestFile, normalizeTestPath } from './test-suite-manifest.mjs';

function walkFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = resolve(directory, entry.name);
    return entry.isDirectory() ? walkFiles(path) : [path];
  });
}

export function validateCoreTestFiles({ rootDir = process.cwd(), files = null } = {}) {
  const testDir = resolve(rootDir, 'test');
  const discovered = new Set((files || walkFiles(testDir))
    .map(file => normalizeTestPath(relative(rootDir, file)))
    .filter(isTestFile));
  const expected = new Set(REVIEWED_TEST_FILES);
  const missing = REVIEWED_TEST_FILES.filter(file => !discovered.has(file));
  const unexpected = [...discovered].filter(file => !expected.has(file)).sort();
  return { missing, unexpected, count: discovered.size };
}

export function collectTestCaseCount({ rootDir = process.cwd() } = {}) {
  const require = createRequire(import.meta.url);
  const vitestCli = resolve(dirname(require.resolve('vitest/package.json')), 'vitest.mjs');
  const outputDir = mkdtempSync(resolve(tmpdir(), 'yeaft-test-budget-'));
  const outputFile = resolve(outputDir, 'tests.json');
  try {
    execFileSync(process.execPath, [vitestCli, 'list', `--root=${rootDir}`, `--json=${outputFile}`], {
      cwd: rootDir,
      stdio: 'pipe',
    });
    return JSON.parse(readFileSync(outputFile, 'utf8')).length;
  } finally {
    rmSync(outputDir, { recursive: true, force: true });
  }
}

export function isMainModule(moduleUrl, entryPath = process.argv[1]) {
  return Boolean(entryPath) && moduleUrl === pathToFileURL(resolve(entryPath)).href;
}

function main() {
  const result = validateCoreTestFiles();
  if (result.missing.length) console.error(`Missing reviewed test files:\n- ${result.missing.join('\n- ')}`);
  if (result.unexpected.length) console.error(`Unreviewed test files:\n- ${result.unexpected.join('\n- ')}`);
  if (result.missing.length || result.unexpected.length) {
    process.exitCode = 1;
    return;
  }

  const caseCount = collectTestCaseCount();
  console.log(`Core suite: ${CORE_TEST_FILES.length} core files, ${caseCount} test cases; ${result.count} reviewed files`);
}

if (isMainModule(import.meta.url)) main();
