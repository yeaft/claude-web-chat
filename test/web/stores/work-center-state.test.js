import { describe, expect, it } from 'vitest';
import {
  applyWorkItemSummary,
  isWorkItemSummaryStale,
  mergeWorkItemSummary,
} from '../../../web/stores/helpers/work-center.js';

describe('Work Center summary state', () => {
  const detail = {
    id: 'wi-1',
    revision: 3,
    title: 'Current title',
    goal: 'Current goal',
    status: 'running',
    updatedAt: 30,
    workDir: '/local/project',
    actions: [{ id: 'action-1' }],
    runs: [{ id: 'run-1', evidence: [{ kind: 'test', label: 'passed' }] }],
    events: [{ id: 1 }],
  };

  it('merges a redacted summary without dropping loaded detail data', () => {
    const merged = mergeWorkItemSummary(detail, {
      id: 'wi-1', revision: 3, title: 'Updated title', status: 'waiting', updatedAt: 31,
    });
    expect(merged).toMatchObject({ title: 'Updated title', status: 'waiting', updatedAt: 31 });
    expect(merged.actions).toEqual(detail.actions);
    expect(merged.runs).toEqual(detail.runs);
    expect(merged.events).toEqual(detail.events);
    expect(merged.workDir).toBe('/local/project');
  });

  it('rejects an older revision even when its timestamp is newer', () => {
    const stale = { id: 'wi-1', revision: 2, status: 'done', updatedAt: 99 };
    expect(isWorkItemSummaryStale(stale, detail)).toBe(true);
    expect(mergeWorkItemSummary(detail, stale)).toBe(detail);
    expect(applyWorkItemSummary([detail], stale)[0]).toBe(detail);
  });

  it('rejects an older event within the same revision', () => {
    const stale = { id: 'wi-1', revision: 3, status: 'ready', updatedAt: 29 };
    expect(isWorkItemSummaryStale(stale, detail)).toBe(true);
    expect(mergeWorkItemSummary(detail, stale)).toBe(detail);
  });

  it('accepts a newer revision even if clocks move backwards', () => {
    const next = { id: 'wi-1', revision: 4, status: 'ready', updatedAt: 20 };
    expect(isWorkItemSummaryStale(next, detail)).toBe(false);
    expect(mergeWorkItemSummary(detail, next)).toMatchObject({ revision: 4, status: 'ready' });
  });
});
