import { describe, it, expect, beforeAll } from 'vitest';
import { loadAllCss } from '../helpers/loadCss.js';

/**
 * Global CSS structural integrity check.
 * One place to verify all CSS files have balanced braces.
 * Individual feature tests should NOT duplicate this check.
 */

let cssSource;

beforeAll(() => {
  cssSource = loadAllCss();
});

describe('global CSS structural integrity', () => {
  it('all CSS files have balanced braces', () => {
    const opens = (cssSource.match(/\{/g) || []).length;
    const closes = (cssSource.match(/\}/g) || []).length;
    expect(opens).toBe(closes);
  });
});
