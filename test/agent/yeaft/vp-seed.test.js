import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createVp } from '../../../agent/yeaft/vp/vp-crud.js';
import { seedDefaultVps, DEFAULT_VPS } from '../../../agent/yeaft/vp/seed-defaults.js';
import { topUpDefaultVps } from '../../../agent/yeaft/vp/seed-topup.js';
import { STOCK_VP_IDS } from '../../../agent/yeaft/vp/stock-ids.js';
import { parseRoleMd } from '../../../agent/yeaft/vp/vp-store.js';

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

describe('all-purpose assistant stock seed', () => {
  const omni = DEFAULT_VPS.find(vp => vp.vpId === 'omni');

  function createPreviousOmni(libDir, overrides = {}) {
    createVp({
      ...omni,
      displayNameZh: omni.legacyMetadata.nameZh,
      role: omni.legacyMetadata.role,
      roleZh: omni.legacyMetadata.roleZh,
      description: omni.legacyMetadata.description,
      descriptionZh: omni.legacyMetadata.descriptionZh,
      persona: omni.legacyPersonas[1],
      ...overrides,
    }, { libDir });
    return join(libDir, 'omni', 'role.md');
  }

  it('seeds a bilingual generalist with stable identity and a Chinese name', () => {
    const libDir = tempRoot();
    expect(seedDefaultVps(libDir).errors).toEqual([]);
    const { meta, body } = parseRoleMd(readFileSync(join(libDir, 'omni', 'role.md'), 'utf8'));
    expect(meta).toMatchObject({ id: 'omni', name: 'Omni', nameZh: '全能助手', roleZh: '全能助手' });
    expect(meta.aliases).toEqual(expect.arrayContaining(['omni', 'quannengzhushou', '全能助手']));
    expect(body).toBe(omni.persona.trim());
    expect(omni.personaZh).toContain('你是全能助手');
    expect(omni.personaZh).toContain('编程调试和自动化');
    expect(omni.personaZh).toContain('尊重项目规则和明确的职责归属');
    expect(omni.personaEn).toContain('deliver the artifact');
    expect(omni.personaEn).toContain('never invent citations');
  });

  const historicalSouls = [...omni.legacyPersonas, omni.legacyPersonaEn, omni.legacyPersona];
  it.each(historicalSouls.map((persona, index) => ({ persona, index })))(
    'upgrades exact historical soul $index and stock metadata, then becomes idempotent', ({ persona }) => {
      const libDir = tempRoot();
      const path = createPreviousOmni(libDir, { persona });
      const result = topUpDefaultVps(libDir);
      expect(result.errors).toEqual([]);
      expect(result.personaBackfilled).toContain('omni');
      const updated = readFileSync(path, 'utf8');
      expect(parseRoleMd(updated)).toMatchObject({
        meta: {
          id: 'omni', nameZh: '全能助手', role: omni.role, roleZh: omni.roleZh,
          description: omni.description, descriptionZh: omni.descriptionZh,
        },
        body: omni.persona.trim(),
      });
      expect(topUpDefaultVps(libDir).personaBackfilled).not.toContain('omni');
      expect(readFileSync(path, 'utf8')).toBe(updated);
    },
  );

  it('preserves custom metadata while upgrading an exact stock soul', () => {
    const libDir = tempRoot();
    const path = createPreviousOmni(libDir, { displayNameZh: '我的助手', role: 'Custom', descriptionZh: '我的描述' });
    expect(topUpDefaultVps(libDir).personaBackfilled).toContain('omni');
    expect(parseRoleMd(readFileSync(path, 'utf8'))).toMatchObject({
      meta: { nameZh: '我的助手', role: 'Custom', descriptionZh: '我的描述', roleZh: '全能助手' },
      body: omni.persona.trim(),
    });
  });

  it.each([
    `${omni.legacyPersonas[1]}\nUser-specific instructions.`,
    'You are Omni Assistant / 全能助手, my custom assistant.\nLanguage policy / 语言策略:\nCore capabilities / 核心能力:\nPreserve my edits.',
  ])('does not overwrite customized soul or existing metadata', (persona) => {
    const libDir = tempRoot();
    const path = createPreviousOmni(libDir, { persona });
    const before = readFileSync(path, 'utf8');
    const result = topUpDefaultVps(libDir);
    expect(result.errors).toEqual([]);
    expect(result.personaBackfilled).not.toContain('omni');
    expect(readFileSync(path, 'utf8')).toBe(before);
  });
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
