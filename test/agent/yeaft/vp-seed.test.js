import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createVp } from '../../../agent/yeaft/vp/vp-crud.js';
import { seedDefaultVps, DEFAULT_VPS } from '../../../agent/yeaft/vp/seed-defaults.js';
import { topUpDefaultVps } from '../../../agent/yeaft/vp/seed-topup.js';
import { STOCK_VP_IDS } from '../../../agent/yeaft/vp/stock-ids.js';

const WRITING_VP_IDS = ['haiyan', 'liufang', 'zhaona'];
const tempRoots = [];

function tempRoot() {
  const root = mkdtempSync(join(tmpdir(), 'yeaft-writing-vp-seed-'));
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('writing stock VP seeds', () => {
  it('keeps the three writing IDs synchronized and their bilingual prompts complete', () => {
    const byId = new Map(DEFAULT_VPS.map(vp => [vp.vpId, vp]));

    expect(WRITING_VP_IDS.every(vpId => STOCK_VP_IDS.has(vpId))).toBe(true);
    expect(WRITING_VP_IDS.every(vpId => byId.has(vpId))).toBe(true);

    for (const vpId of WRITING_VP_IDS) {
      const vp = byId.get(vpId);
      expect(vp).toMatchObject({
        vpId,
        displayNameZh: expect.any(String),
        roleZh: expect.any(String),
        area: 'writing',
        description: expect.any(String),
        descriptionZh: expect.any(String),
        personaEn: expect.any(String),
        personaZh: expect.any(String),
      });
      expect(vp.persona).toContain('<!-- lang:en -->');
      expect(vp.persona).toContain('<!-- lang:zh -->');
      expect(vp.personaEn.length).toBeGreaterThan(100);
      expect(vp.personaZh.length).toBeGreaterThan(100);
    }
  });

  it('seeds all three personas into an empty library', () => {
    const libDir = tempRoot();

    const result = seedDefaultVps(libDir);

    expect(result).toMatchObject({ seeded: DEFAULT_VPS.length, skipped: false, errors: [] });
    for (const vpId of WRITING_VP_IDS) {
      const role = readFileSync(join(libDir, vpId, 'role.md'), 'utf8');
      expect(role).toContain(`id: ${vpId}`);
      expect(role).toContain('area: writing');
      expect(role).toContain('<!-- lang:en -->');
      expect(role).toContain('<!-- lang:zh -->');
    }
  });

  it('tops up the three personas in an already initialized library', () => {
    const libDir = tempRoot();
    mkdirSync(libDir, { recursive: true });
    createVp({ vpId: 'user-writer', displayName: 'User Writer', role: 'Custom' }, { libDir });

    const result = topUpDefaultVps(libDir);

    expect(result.errors).toEqual([]);
    expect(result.added).toEqual(expect.arrayContaining(WRITING_VP_IDS));
    for (const vpId of WRITING_VP_IDS) {
      expect(readFileSync(join(libDir, vpId, 'role.md'), 'utf8')).toContain(`id: ${vpId}`);
    }
    expect(readFileSync(join(libDir, 'user-writer', 'role.md'), 'utf8')).toContain('id: user-writer');
  });
});
