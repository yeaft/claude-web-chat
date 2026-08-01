import { defineConfig } from 'vitest/config';
import { CORE_TEST_FILES } from './scripts/test-suite-manifest.mjs';

export default defineConfig({
  test: {
    environment: 'node',
    testTimeout: 10000,
    hookTimeout: 10000,
    pool: 'forks',
    fileParallelism: false,
    // Keep the default suite intentionally bounded. New regression coverage
    // must replace or consolidate an existing case before joining this list.
    include: [...CORE_TEST_FILES],
    // Dot-dir worktrees may appear at different depths depending on who
    // created them. Use globstar forms so both full and focused runs exclude
    // `.claude/worktrees`, `.worktrees`, and `.yeaft/worktrees` clones.
    exclude: [
      '**/node_modules/**',
      '**/e2e/**',
      '**/.claude/worktrees/**',
      '**/.worktrees/**',
      '**/.yeaft/worktrees/**',
    ],
    coverage: {
      provider: 'v8',
      include: ['server/**/*.js', 'agent/**/*.js'],
      exclude: ['**/node_modules/**', 'agent/sdk/**', 'web/**']
    }
  }
});
