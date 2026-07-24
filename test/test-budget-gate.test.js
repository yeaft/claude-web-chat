import { describe, expect, it } from 'vitest';
import { pathToFileURL } from 'node:url';
import {
  TEST_CASE_LIMIT,
  isMainModule,
  validateCoreTestFiles,
} from '../scripts/check-test-budget.mjs';

const firstCoreFile = 'test/agent/connection-plaintext.test.js';

describe('test budget gate', () => {
  it('rejects missing and unreviewed test files', () => {
    const missingResult = validateCoreTestFiles({ files: [] });
    expect(missingResult.missing).toContain(firstCoreFile);

    const unexpectedResult = validateCoreTestFiles({
      files: ['test/new-regression.test.js'],
    });
    expect(unexpectedResult.unexpected).toContain('test/new-regression.test.js');
  });

  it('uses a strict sub-500 case limit', () => {
    expect(TEST_CASE_LIMIT).toBe(500);
  });

  it('detects the CLI entry point with platform-safe file URLs', () => {
    const windowsEntry = 'C:\\repo\\scripts\\check-test-budget.mjs';
    expect(isMainModule(pathToFileURL(windowsEntry).href, windowsEntry)).toBe(true);
    expect(isMainModule(import.meta.url, windowsEntry)).toBe(false);
  });
});
