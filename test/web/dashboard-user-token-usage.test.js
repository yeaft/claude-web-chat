import { describe, expect, it } from 'vitest';

globalThis.Pinia = globalThis.Pinia || { defineStore: () => () => ({ token: null }) };
const { default: DashboardTab } = await import('../../web/components/DashboardTab.js');

describe('dashboard user token usage', () => {
  it('shows and sorts persisted token totals in the user table', () => {
    expect(DashboardTab.template).toContain("toggleSort('user', 'totalTokens')");
    expect(DashboardTab.template).toContain('formatCompactNumber(user.totalTokens)');
    expect(DashboardTab.template).toContain('userTokenTitle(user)');

    const rows = [
      { username: 'small', totalTokens: 10 },
      { username: 'large', totalTokens: 100 },
    ];
    const sorted = DashboardTab.methods.sortArray.call({}, rows, 'totalTokens', 'desc', 'user');
    expect(sorted.map(row => row.username)).toEqual(['large', 'small']);
  });

  it('uses persisted dashboard totals instead of online agent totals', () => {
    expect(DashboardTab.template).toContain('formatCompactNumber(overview.totalTokens)');
    expect(DashboardTab.template).not.toContain('formatCompactNumber(agentMetricTotals.totalTokens)');
  });
});
