import { describe, expect, it } from 'vitest';
import { filterVpMentions } from '../../web/components/VpMentionAutocomplete.js';

const previousPinia = globalThis.Pinia;
globalThis.Pinia = { defineStore: () => () => ({}) };
const { localizedVpDescription } = await import('../../web/stores/vp.js');
globalThis.Pinia = previousPinia;

describe('localized VP list metadata', () => {
  const vp = {
    vpId: 'anders',
    displayName: 'Anders Hejlsberg',
    displayNameZh: '安德斯·海尔斯伯格',
    description: 'Language design, API compatibility, and reliable cloud-scale evolution',
    descriptionZh: '语言设计、API 兼容性与可靠的云规模演进',
    role: 'Language and Cloud Systems Architect',
    roleZh: '语言与云系统架构师',
  };

  it('selects the description for the active locale with stable fallbacks', () => {
    expect(localizedVpDescription(vp, 'en')).toBe(vp.description);
    expect(localizedVpDescription(vp, 'zh-CN')).toBe(vp.descriptionZh);
    expect(localizedVpDescription({ description: 'Review', role: 'Reviewer', roleZh: '审阅者' }, 'zh-CN')).toBe('审阅者');
    expect(localizedVpDescription({ role: 'Reviewer' }, 'zh-CN')).toBe('Reviewer');
  });

  it('finds VPs by localized capability descriptions', () => {
    expect(filterVpMentions([vp], 'compatibility')).toEqual([vp]);
    expect(filterVpMentions([vp], '云规模')).toEqual([vp]);
    expect(filterVpMentions([vp], 'missing')).toEqual([]);
  });
});
