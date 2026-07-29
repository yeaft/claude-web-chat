import { describe, expect, it } from 'vitest';
import UnifiedSessionList from '../../web/components/UnifiedSessionList.js';

describe('UnifiedSessionList', () => {
  it('uses the stable catalog key for Vue identity and selection', () => {
    expect(UnifiedSessionList.template).toContain(':key="row.catalogKey"');
    expect(UnifiedSessionList.template).toContain("@click=\"$emit('select', row)\"");
    expect(UnifiedSessionList.template).toContain("@keydown.enter.prevent=\"$emit('select', row)\"");
    expect(UnifiedSessionList.template).toContain('row.catalogKey === activeCatalogKey');
  });

  it('labels all supported runtime providers', () => {
    const label = UnifiedSessionList.methods.providerLabel;
    expect(label({ runtimeProvider: 'yeaft' })).toBe('Yeaft');
    expect(label({ runtimeProvider: 'copilot' })).toBe('Copilot');
    expect(label({ runtimeProvider: 'claude-code' })).toBe('Claude Code');
  });
});
