import { mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { createVp, readVp, updateVp } from '../../../agent/yeaft/vp/vp-crud.js';
import { loadVpFromDir } from '../../../agent/yeaft/vp/vp-store.js';

function tempLibrary() {
  return join(mkdtempSync(join(tmpdir(), 'yeaft-vp-localized-')), 'virtual-persons');
}

describe('VP localized metadata persistence', () => {
  it('round-trips quotes, colons, and backslashes across repeated updates', () => {
    const libDir = tempLibrary();
    const initialDescription = String.raw`Review "v1:beta" contracts in C:\services\api`;
    const updatedDescription = String.raw`Review "v2:stable" contracts in D:\rollout\api`;
    const initial = {
      vpId: 'api-architect',
      displayName: 'API Architect',
      displayNameZh: 'API 架构师',
      aliases: ['api:review', String.raw`C:\api\review`, "'quoted-alias'"],
      description: initialDescription,
      descriptionZh: String.raw`评审 "v1:beta" 契约与 C:\服务\api`,
      role: 'Architect',
      roleZh: '架构师',
      area: 'platform:api',
      traits: ['compatibility', String.raw`path:C:\services`],
      modelHint: 'primary',
      persona: 'Design contracts that can evolve safely.',
      planInstruction: String.raw`Plan "safe:rollout" under C:\ops`,
    };

    createVp(initial, { libDir });

    expect(loadVpFromDir(join(libDir, initial.vpId))).toMatchObject({
      id: initial.vpId,
      name: initial.displayName,
      nameZh: initial.displayNameZh,
      aliases: initial.aliases,
      description: initial.description,
      descriptionZh: initial.descriptionZh,
      role: initial.role,
      roleZh: initial.roleZh,
      area: initial.area,
      traits: initial.traits,
      planInstruction: initial.planInstruction,
    });
    expect(readVp(initial.vpId, { libDir })).toMatchObject(initial);

    updateVp({ vpId: initial.vpId, description: updatedDescription }, { libDir });
    expect(readVp(initial.vpId, { libDir })?.description).toBe(updatedDescription);

    for (let iteration = 0; iteration < 4; iteration += 1) {
      updateVp({ vpId: initial.vpId, role: `Architect ${iteration}` }, { libDir });
      expect(readVp(initial.vpId, { libDir })).toMatchObject({
        displayNameZh: initial.displayNameZh,
        aliases: initial.aliases,
        description: updatedDescription,
        descriptionZh: initial.descriptionZh,
        roleZh: initial.roleZh,
        area: initial.area,
        traits: initial.traits,
        modelHint: initial.modelHint,
        persona: initial.persona,
        planInstruction: initial.planInstruction,
      });
    }
  });

  it('preserves omitted metadata from old clients and clears explicit empty values', () => {
    const libDir = tempLibrary();
    const initial = {
      vpId: 'compat-reviewer',
      displayName: 'Compatibility Reviewer',
      displayNameZh: '兼容性审阅者',
      aliases: ['compat', 'api-review'],
      description: 'Reviews API contracts and migrations',
      descriptionZh: '评审 API 契约与迁移',
      role: 'Reviewer',
      roleZh: '审阅者',
      area: 'engineering',
      traits: ['careful', 'compatible'],
      modelHint: 'primary',
      persona: 'Protect long-lived contracts.',
      planInstruction: 'Plan an incremental migration.',
    };
    createVp(initial, { libDir });

    // Shape sent by a pre-localization Web client. Missing keys are not an
    // instruction to delete metadata the older client cannot represent.
    updateVp({
      vpId: initial.vpId,
      displayName: 'Principal Compatibility Reviewer',
      role: 'Principal Reviewer',
      traits: ['careful'],
      modelHint: 'fast',
      persona: 'Protect contracts and ship incrementally.',
    }, { libDir });

    expect(readVp(initial.vpId, { libDir })).toMatchObject({
      displayName: 'Principal Compatibility Reviewer',
      displayNameZh: initial.displayNameZh,
      aliases: initial.aliases,
      description: initial.description,
      descriptionZh: initial.descriptionZh,
      role: 'Principal Reviewer',
      roleZh: initial.roleZh,
      area: initial.area,
      traits: ['careful'],
      modelHint: 'fast',
      persona: 'Protect contracts and ship incrementally.',
      planInstruction: initial.planInstruction,
    });

    updateVp({
      vpId: initial.vpId,
      displayNameZh: '',
      aliases: [],
      description: '',
      descriptionZh: '',
      roleZh: '',
      area: '',
      traits: [],
      modelHint: null,
      persona: null,
      planInstruction: '',
    }, { libDir });

    expect(readVp(initial.vpId, { libDir })).toMatchObject({
      displayNameZh: '',
      aliases: [],
      description: '',
      descriptionZh: '',
      roleZh: '',
      area: '',
      planInstruction: '',
      displayName: 'Principal Compatibility Reviewer',
      role: 'Principal Reviewer',
      traits: [],
      modelHint: null,
      persona: '',
    });
  });

  it('reads legacy double-quoted values without corrupting Windows paths', () => {
    const libDir = tempLibrary();
    const vpId = 'legacy-reviewer';
    mkdirSync(join(libDir, vpId), { recursive: true });
    writeFileSync(join(libDir, vpId, 'role.md'), String.raw`---
id: legacy-reviewer
name: Legacy Reviewer
description: "Review \"v1:beta\" contracts in C:\services\api"
role: Reviewer
---

Protect compatibility.
`, 'utf-8');

    const expected = String.raw`Review "v1:beta" contracts in C:\services\api`;
    expect(readVp(vpId, { libDir })?.description).toBe(expected);

    for (let iteration = 0; iteration < 3; iteration += 1) {
      updateVp({ vpId, role: `Reviewer ${iteration}` }, { libDir });
      expect(readVp(vpId, { libDir })?.description).toBe(expected);
    }
  });
});
