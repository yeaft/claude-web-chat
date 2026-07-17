import { describe, expect, it } from 'vitest';
import { Registry } from '../../../agent/yeaft/vp/registry.js';

describe('VP registry localized metadata updates', () => {
  it('updates localized identity fields in place for hot reload', () => {
    const registry = new Registry();
    const original = {
      id: 'reviewer',
      name: 'Reviewer',
      nameZh: '审阅者',
      aliases: ['review'],
      description: 'Reviews code',
      descriptionZh: '评审代码',
      role: 'Reviewer',
      roleZh: '审阅者',
      area: 'engineering',
      traits: ['careful'],
      modelHint: 'fast',
      persona: 'Review carefully.',
      personaHash: 'old',
      planInstruction: '',
      mtimeMs: 1,
    };
    registry.setVp(original);

    const result = registry.updateVpInPlace({
      ...original,
      name: 'Senior Reviewer',
      nameZh: '高级审阅者',
      aliases: ['review', 'audit'],
      description: 'Reviews APIs and compatibility',
      descriptionZh: '评审 API 与兼容性',
      role: 'Senior Reviewer',
      roleZh: '高级审阅者',
      traits: ['careful', 'compatible'],
      personaHash: 'new',
      planInstruction: 'Plan migrations.',
      mtimeMs: 2,
    });

    expect(result).toBe(original);
    expect(registry.getVp('reviewer')).toMatchObject({
      name: 'Senior Reviewer',
      nameZh: '高级审阅者',
      aliases: ['review', 'audit'],
      description: 'Reviews APIs and compatibility',
      descriptionZh: '评审 API 与兼容性',
      role: 'Senior Reviewer',
      roleZh: '高级审阅者',
      traits: ['careful', 'compatible'],
      personaHash: 'new',
      planInstruction: 'Plan migrations.',
      mtimeMs: 2,
    });
  });
});
