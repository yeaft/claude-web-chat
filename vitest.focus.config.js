import { defineConfig, mergeConfig } from 'vitest/config';
import baseConfig from './vitest.config.js';

export default mergeConfig(baseConfig, defineConfig({
  test: {
    // Focused development runs may target tests before they join the reviewed
    // default manifest. The committed suite remains bounded by `npm test`.
    include: ['test/**/*.{test,spec}.?(c|m)[jt]s?(x)'],
  },
}));
