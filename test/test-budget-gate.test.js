import { describe, expect, it } from 'vitest';
import { pathToFileURL } from 'node:url';
import { CORE_TEST_FILES, REVIEWED_TEST_FILES, SANDBOX_TEST_FILES } from '../scripts/test-suite-manifest.mjs';
import {
  isMainModule,
  validateCoreTestFiles,
} from '../scripts/check-test-budget.mjs';

const firstCoreFile = 'test/agent/connection-plaintext.test.js';

describe('test budget gate', () => {
  it('enforces the manifest and platform-safe CLI entry point', () => {
    const missingResult = validateCoreTestFiles({ files: [] });
    expect(missingResult.missing).toContain(firstCoreFile);

    const unexpectedResult = validateCoreTestFiles({
      files: ['test/new-regression.test.js'],
    });
    expect(unexpectedResult.unexpected).toContain('test/new-regression.test.js');

    const windowsEntry = 'C:\\repo\\scripts\\check-test-budget.mjs';
    expect(isMainModule(pathToFileURL(windowsEntry).href, windowsEntry)).toBe(true);
    expect(isMainModule(import.meta.url, windowsEntry)).toBe(false);

    expect(SANDBOX_TEST_FILES).toHaveLength(9);
    expect(REVIEWED_TEST_FILES).toEqual([...CORE_TEST_FILES, ...SANDBOX_TEST_FILES]);
    for (const file of SANDBOX_TEST_FILES) {
      expect(CORE_TEST_FILES).not.toContain(file);
    }
  });
});
