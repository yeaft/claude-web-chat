import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { createVp, readVp, updateVp } from '../../../agent/yeaft/vp/vp-crud.js';
import { loadVpFromDir } from '../../../agent/yeaft/vp/vp-store.js';

describe('VP localized metadata persistence', () => {
  it('round-trips localized names and capability descriptions', () => {
    const libDir = join(mkdtempSync(join(tmpdir(), 'yeaft-vp-localized-')), 'virtual-persons');
    const initial = {
      vpId: 'api-architect',
      displayName: 'API Architect',
      displayNameZh: 'API 架构师',
      description: 'API contracts and compatibility',
      descriptionZh: 'API 契约与兼容性',
      role: 'Architect',
      roleZh: '架构师',
      persona: 'Design contracts that can evolve safely.',
    };

    createVp(initial, { libDir });

    expect(loadVpFromDir(join(libDir, initial.vpId))).toMatchObject({
      id: initial.vpId,
      name: initial.displayName,
      nameZh: initial.displayNameZh,
      description: initial.description,
      descriptionZh: initial.descriptionZh,
      role: initial.role,
      roleZh: initial.roleZh,
    });
    expect(readVp(initial.vpId, { libDir })).toMatchObject(initial);

    updateVp({
      ...initial,
      description: 'API contracts, migration paths, and compatibility',
      descriptionZh: 'API 契约、迁移路径与兼容性',
    }, { libDir });

    expect(readVp(initial.vpId, { libDir })).toMatchObject({
      description: 'API contracts, migration paths, and compatibility',
      descriptionZh: 'API 契约、迁移路径与兼容性',
    });
  });
});
