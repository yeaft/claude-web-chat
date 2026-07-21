import { describe, expect, it } from 'vitest';
import {
  MAINLINE_CONTEXT_HARD_LIMIT_BYTES,
  buildMainlineContextSnapshot,
  buildMainlineProjection,
  hashMainlineSnapshot,
  validateMainlineContextBudget,
} from '../../../../agent/yeaft/work-center/mainline-projection.js';

function detail(overrides = {}) {
  return {
    id: 'work-1',
    revision: 3,
    planRevision: 2,
    executionSchemaVersion: 2,
    ledgerRevision: 7,
    title: 'Ship deterministic execution',
    goal: 'Derive the mainline without mutating scheduler state',
    acceptanceCriteria: ['Projection is deterministic'],
    actions: [],
    runs: [],
    planConflicts: [],
    ...overrides,
  };
}

describe('Mainline projection', () => {
  it('derives a stable contract, graph frontier, and canonical Action results', () => {
    const input = detail({
      actions: [
        {
          id: 'review', sequence: 3, stageId: 'review', type: 'review', status: 'ready',
          generation: 2, specHash: 'review-v2', dependsOnStageIds: ['implement'], resultRunId: null,
        },
        {
          id: 'implement', sequence: 2, stageId: 'implement', type: 'implement', status: 'completed',
          generation: 1, specHash: 'implement-v1', dependsOnStageIds: ['triage'], resultRunId: 'run-selected',
        },
        {
          id: 'triage', sequence: 1, stageId: 'triage', type: 'triage', status: 'completed',
          generation: 1, specHash: 'triage-v1', dependsOnStageIds: [], resultRunId: null,
        },
        {
          id: 'old-review', sequence: 4, stageId: 'review', type: 'review', status: 'superseded',
          generation: 1, specHash: 'review-v1', dependsOnStageIds: ['implement'], resultRunId: 'old-review-run',
        },
      ],
      runs: [
        { id: 'run-newer', actionId: 'implement', status: 'failed', summary: 'newer fallback', endedAt: 30 },
        { id: 'run-selected', actionId: 'implement', status: 'completed', summary: 'canonical', evidence: ['ok'], endedAt: 20 },
        { id: 'triage-run', actionId: 'triage', status: 'completed', summary: 'triaged', endedAt: 10 },
        { id: 'running-review', actionId: 'review', status: 'running', summary: 'not canonical', startedAt: 40 },
      ],
      planConflicts: [
        { id: 'conflict-b', createdAt: 20, status: 'open' },
        { id: 'conflict-a', createdAt: 10, status: 'resolved' },
      ],
    });

    const before = structuredClone(input);
    const projection = buildMainlineProjection(input);

    expect(input).toEqual(before);
    expect(projection.contract).toEqual({
      revision: 3,
      title: 'Ship deterministic execution',
      goal: 'Derive the mainline without mutating scheduler state',
      acceptanceCriteria: ['Projection is deterministic'],
    });
    expect(projection.graph.nodes.map(node => node.id)).toEqual(['triage', 'implement', 'review']);
    expect(projection.graph.frontier).toEqual(['review']);
    expect(projection.canonicalActionResults.implement).toMatchObject({
      runId: 'run-selected', status: 'completed', summary: 'canonical', evidence: ['ok'],
    });
    expect(projection.canonicalActionResults.triage.runId).toBe('triage-run');
    expect(projection.canonicalActionResults.review).toBeUndefined();
    expect(projection.canonicalActionResults['old-review']).toBeUndefined();
    expect(projection.planConflicts.map(conflict => conflict.id)).toEqual(['conflict-a', 'conflict-b']);
    expect(buildMainlineProjection(structuredClone(input))).toEqual(projection);
  });

  it('selects the latest terminal Run deterministically when resultRunId is absent', () => {
    const projection = buildMainlineProjection(detail({
      actions: [{ id: 'action', sequence: 1, stageId: 'action', type: 'test', status: 'completed' }],
      runs: [
        { id: 'run-a', actionId: 'action', status: 'failed', endedAt: 20 },
        { id: 'run-z', actionId: 'action', status: 'completed', endedAt: 20 },
        { id: 'run-running', actionId: 'action', status: 'running', startedAt: 30 },
      ],
    }));

    expect(projection.canonicalActionResults.action.runId).toBe('run-z');
  });

  it('enforces the fixed context budget model', () => {
    expect(validateMainlineContextBudget()).toEqual({
      hardLimitBytes: 64 * 1024,
      targetMinBytes: 16 * 1024,
      targetMaxBytes: 32 * 1024,
      dynamicMinBytes: 4 * 1024,
      dynamicMaxBytes: 16 * 1024,
    });
    expect(MAINLINE_CONTEXT_HARD_LIMIT_BYTES).toBe(64 * 1024);
    expect(() => validateMainlineContextBudget({ hardLimitBytes: 65 * 1024 })).toThrow(/64 KiB/);
    expect(() => validateMainlineContextBudget({ targetMinBytes: 8 * 1024 })).toThrow(/16-32 KiB/);
    expect(() => validateMainlineContextBudget({ dynamicMaxBytes: 20 * 1024 })).toThrow(/4-16 KiB/);
  });

  it('counts UTF-8 bytes, pins dependencies, and does not mutate source facts', () => {
    const dependency = {
      id: 'dependency', sequence: 1, stageId: 'dependency', type: 'implement', status: 'completed',
      generation: 1, specHash: 'dep-hash', dependsOnStageIds: [], resultRunId: 'dep-run',
    };
    const action = {
      id: 'current', sequence: 2, stageId: 'current', type: 'review', status: 'running',
      generation: 3, specHash: 'current-hash', dependsOnStageIds: ['dependency'],
      instruction: '审查实现', brief: { objective: '验证多字节上下文' }, context: [],
    };
    const input = detail({
      sessionContext: [{ role: 'user', content: '你好'.repeat(1_000) }],
      actions: [dependency, action],
      runs: [{
        id: 'dep-run', actionId: 'dependency', status: 'completed',
        summary: '完成'.repeat(100), response: '证据'.repeat(200), endedAt: 10,
      }],
    });
    const before = structuredClone(input);

    const built = buildMainlineContextSnapshot(input, action);
    const encodedBytes = new TextEncoder().encode(JSON.stringify(built.contextSnapshot)).byteLength;

    expect(input).toEqual(before);
    expect(built.budget.bytes).toBe(encodedBytes);
    expect(built.budget.bytes).toBeLessThanOrEqual(MAINLINE_CONTEXT_HARD_LIMIT_BYTES);
    expect(built.budget.dynamicBudgetBytes).toBeGreaterThanOrEqual(4 * 1024);
    expect(built.budget.dynamicBudgetBytes).toBeLessThanOrEqual(16 * 1024);
    expect(built.contextSnapshot.directDependencies[0].result).toMatchObject({ runId: 'dep-run' });
    expect(hashMainlineSnapshot(structuredClone(built.contextSnapshot))).toBe(hashMainlineSnapshot(built.contextSnapshot));
  });

  it('fails explicitly instead of trimming pinned contract or Action data', () => {
    const action = {
      id: 'current', sequence: 1, stageId: 'current', type: 'implement', status: 'running',
      generation: 1, specHash: 'hash', dependsOnStageIds: [],
      brief: { objective: 'x'.repeat(70 * 1024), approach: 'Implement safely', expectedOutcome: 'Verified result' },
    };
    expect(() => buildMainlineContextSnapshot(detail({ actions: [action] }), action))
      .toThrow(/pinned context exceeds 64 KiB/);
  });

  it('degrades non-critical sibling results within the selected dynamic budget', () => {
    const action = {
      id: 'current', sequence: 20, stageId: 'current', type: 'review', status: 'running',
      generation: 1, specHash: 'current', dependsOnStageIds: [], instruction: 'Review',
    };
    const siblings = Array.from({ length: 12 }, (_, index) => ({
      id: `sibling-${index}`, sequence: index, stageId: `sibling-${index}`,
      type: 'implement', status: 'completed', dependsOnStageIds: [], resultRunId: `run-${index}`,
    }));
    const built = buildMainlineContextSnapshot(detail({
      actions: [...siblings, action],
      runs: siblings.map((sibling, index) => ({
        id: `run-${index}`, actionId: sibling.id, status: 'completed', endedAt: index,
        summary: 'summary'.repeat(500), response: 'response'.repeat(1_000),
      })),
    }), action);

    expect(built.budget.bytes).toBeLessThanOrEqual(built.budget.pinnedBytes + built.budget.dynamicBudgetBytes);
    expect(built.budget.selectionReason).toMatch(/siblings:(summary|index)/);
    expect(Object.values(built.contextSnapshot.siblingResults).some(result => !result.response)).toBe(true);
  });
});
