import { defineConfig } from 'vitest/config';
import baseConfig from './vitest.config.js';
import { SANDBOX_TEST_FILES } from './scripts/test-suite-manifest.mjs';

export default defineConfig({
  ...baseConfig,
  test: {
    ...baseConfig.test,
    // Keep Sandbox coverage explicit without expanding the bounded core suite.
    include: [...SANDBOX_TEST_FILES],
  },
});
