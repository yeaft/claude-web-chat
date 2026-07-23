import { existsSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('stock VP avatar assets', () => {
  it('ships the Anders asset and keeps both avatar gates in sync', () => {
    const component = readFileSync(join(ROOT, 'web/components/VpAvatar.js'), 'utf-8');
    const generator = readFileSync(join(ROOT, 'scripts/generate-avatars.mjs'), 'utf-8');

    expect(component).toContain("'anders'");
    expect(generator).toContain("{ id: 'anders' }");
    expect(existsSync(join(ROOT, 'web/assets/avatars/anders.svg'))).toBe(true);
  });
});
