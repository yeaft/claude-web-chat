import { describe, expect, it } from 'vitest';
import { DEFAULT_VPS } from '../../agent/yeaft/vp/seed-defaults.js';
import {
  VP_DOMAIN_DEFINITIONS,
  buildVpDomainSections,
  orderVpsByDomain,
  segmentVpsByDomain,
  vpDomainId,
} from '../../web/utils/vp-domains.js';
import {
  filterVpMentions,
  buildVpMentionSections,
} from '../../web/components/VpMentionAutocomplete.js';

function ids(list) {
  return list.map(vp => vp.vpId);
}

describe('VP domain sections', () => {
  it('classifies every shipped stock VP exactly once', () => {
    const classifiedIds = VP_DOMAIN_DEFINITIONS.flatMap(domain => domain.vpIds);
    const stockIds = DEFAULT_VPS.map(vp => vp.vpId);

    expect(new Set(classifiedIds).size).toBe(classifiedIds.length);
    expect([...classifiedIds].sort()).toEqual([...stockIds].sort());
    expect(buildVpDomainSections(DEFAULT_VPS).flatMap(domain => ids(domain.vps)).sort())
      .toEqual([...stockIds].sort());
  });

  it('keeps legacy stock ids classified and uses safe fallback domains', () => {
    expect(vpDomainId({ vpId: 'linus' })).toBe('softwareSystems');
    expect(vpDomainId({ vpId: 'future-stock', isStock: true })).toBe('other');
    expect(vpDomainId({ vpId: 'my-vp', isStock: false })).toBe('custom');
    expect(vpDomainId({ vpId: 'my-legacy-vp' })).toBe('custom');
  });

  it('uses stable domain order while preserving order inside each domain', () => {
    const input = [
      { vpId: 'my-vp' },
      { vpId: 'martin' },
      { vpId: 'omni' },
      { vpId: 'linus' },
      { vpId: 'steve' },
    ];

    expect(buildVpDomainSections(input).map(domain => domain.id)).toEqual([
      'general',
      'productDesign',
      'softwareSystems',
      'custom',
    ]);
    expect(ids(orderVpsByDomain(input))).toEqual(['omni', 'steve', 'martin', 'linus', 'my-vp']);
  });

  it('segments ranked results without changing relevance order or flat indices', () => {
    const ranked = [
      { vpId: 'linus' },
      { vpId: 'steve' },
      { vpId: 'martin' },
      { vpId: 'my-vp' },
    ];
    const segments = segmentVpsByDomain(ranked);

    expect(segments.map(domain => domain.key)).toEqual([
      'softwareSystems-1',
      'productDesign-1',
      'softwareSystems-2',
      'custom-1',
    ]);
    expect(segments.flatMap(domain => ids(domain.vps))).toEqual(ids(ranked));

    const mentionSections = buildVpMentionSections(ranked);
    expect(mentionSections.flatMap(domain => domain.items.map(item => item.flatIndex)))
      .toEqual([0, 1, 2, 3]);
    expect(mentionSections.flatMap(domain => domain.items.map(item => item.vp.vpId)))
      .toEqual(ids(ranked));
  });

  it('keeps id-prefix matches ahead of lower-priority description matches', () => {
    const descriptionHit = {
      vpId: 'steve',
      displayName: 'Steve Jobs',
      description: 'Linux product strategy',
    };
    const exactIdHit = {
      vpId: 'linus',
      displayName: 'Linus Torvalds',
      description: 'Systems engineering',
    };

    expect(ids(filterVpMentions([descriptionHit, exactIdHit], 'lin')))
      .toEqual(['linus', 'steve']);
  });
});
