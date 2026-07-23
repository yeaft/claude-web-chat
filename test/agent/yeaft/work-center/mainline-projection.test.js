import { describe, expect, it } from 'vitest';
import {
  MAINLINE_CONTEXT_HARD_LIMIT_BYTES,
  buildMainlineContextSnapshot,
  buildMainlineProjection,
  hashMainlineSnapshot,
  renderMainlineContextSnapshot,
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
        { id: 'run-newer', actionId: 'implement', status: 'failed', summary: 'newer fallback', endedAt: 30, executionManifest: { schemaVersion: 2, actionGeneration: 1, actionSpecHash: 'implement-v1' } },
        { id: 'run-selected', actionId: 'implement', status: 'completed', summary: 'canonical', evidence: ['ok'], endedAt: 20, executionManifest: { schemaVersion: 2, actionGeneration: 1, actionSpecHash: 'implement-v1' } },
        { id: 'triage-run', actionId: 'triage', status: 'completed', summary: 'triaged', endedAt: 10, executionManifest: { schemaVersion: 2, actionGeneration: 1, actionSpecHash: 'triage-v1' } },
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
      actions: [{ id: 'action', sequence: 1, stageId: 'action', type: 'test', status: 'completed', generation: 1, specHash: 'test-v1' }],
      runs: [
        { id: 'run-a', actionId: 'action', status: 'failed', endedAt: 20, executionManifest: { schemaVersion: 2, actionGeneration: 1, actionSpecHash: 'test-v1' } },
        { id: 'run-z', actionId: 'action', status: 'completed', endedAt: 20, executionManifest: { schemaVersion: 2, actionGeneration: 1, actionSpecHash: 'test-v1' } },
        { id: 'run-running', actionId: 'action', status: 'running', startedAt: 30 },
      ],
    }));

    expect(projection.canonicalActionResults.action.runId).toBe('run-z');
  });

  it('never reuses a terminal Run from an older Action generation or spec', () => {
    const projection = buildMainlineProjection(detail({
      actions: [{ id: 'action', sequence: 1, stageId: 'action', type: 'test', status: 'ready', generation: 2, specHash: 'test-v2', resultRunId: null }],
      runs: [
        { id: 'old-generation', actionId: 'action', status: 'completed', endedAt: 30, executionManifest: { schemaVersion: 2, actionGeneration: 1, actionSpecHash: 'test-v1' } },
        { id: 'wrong-spec', actionId: 'action', status: 'failed', endedAt: 40, executionManifest: { schemaVersion: 2, actionGeneration: 2, actionSpecHash: 'other' } },
      ],
    }));

    expect(projection.canonicalActionResults.action).toBeUndefined();
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
        executionManifest: { schemaVersion: 2, actionGeneration: 1, actionSpecHash: 'dep-hash' },
      }],
    });
    const before = structuredClone(input);

    const built = buildMainlineContextSnapshot(input, action);
    const encodedBytes = new TextEncoder().encode(renderMainlineContextSnapshot(built.contextSnapshot)).byteLength;

    expect(input).toEqual(before);
    expect(built.budget.bytes).toBe(encodedBytes);
    expect(built.budget.bytes).toBeLessThanOrEqual(MAINLINE_CONTEXT_HARD_LIMIT_BYTES);
    expect(built.budget.dynamicBudgetBytes).toBeGreaterThanOrEqual(4 * 1024);
    expect(built.budget.dynamicBudgetBytes).toBeLessThanOrEqual(16 * 1024);
    expect(built.contextSnapshot.directDependencies[0].result).toMatchObject({ runId: 'dep-run' });
    expect(hashMainlineSnapshot(structuredClone(built.contextSnapshot))).toBe(hashMainlineSnapshot(built.contextSnapshot));
  });

  it('keeps the newest WorkItem messages under budget and restores chronological order', () => {
    const action = {
      id: 'current', sequence: 1, stageId: 'current', type: 'implement', status: 'ready',
      generation: 1, specHash: 'current-v1', dependsOnStageIds: [],
    };
    const messages = Array.from({ length: 5 }, (_, index) => ({
      id: `message-${index + 1}`,
      text: `message-${index + 1}:`.padEnd(7_900, String(index + 1)),
      createdAt: index + 1,
    }));

    const built = buildMainlineContextSnapshot(detail({ actions: [action], messages }), action);
    const selectedIds = built.contextSnapshot.userContext.workItemMessages.map(message => message.messageId);

    expect(selectedIds).toContain('message-5');
    expect(selectedIds).not.toContain('message-1');
    expect(selectedIds).toEqual(selectedIds.slice().sort());
    expect(built.contextSnapshot.userContext.omittedCount).toBeGreaterThan(0);
    expect(built.budget.bytes).toBeLessThanOrEqual(MAINLINE_CONTEXT_HARD_LIMIT_BYTES);
  });

  it('fails explicitly when the latest WorkItem message cannot fit the prompt budget', () => {
    const action = {
      id: 'current', sequence: 1, stageId: 'current', type: 'implement', status: 'ready',
      generation: 1, specHash: 'current-v1', dependsOnStageIds: [],
    };
    let blocked;
    try {
      buildMainlineContextSnapshot(detail({
        actions: [action],
        messages: [{ id: 'latest', text: 'x'.repeat(8_000), createdAt: 1 }],
      }), action, { reservedBytes: 58 * 1024 });
    } catch (error) {
      blocked = error;
    }

    expect(blocked).toMatchObject({
      name: 'MainlineContextBlockedError',
      retryable: false,
      workItemFailureKind: 'system_blocked',
      workItemFailureCode: 'mainline_context_too_large',
    });
    expect(blocked.message).toMatch(/Latest WorkItem message exceeds/);
  });

  it('includes WorkItem messages in every Action while isolating Action-scoped input', () => {
    const actionA = {
      id: 'action-a', sequence: 1, stageId: 'action-a', type: 'research', status: 'ready',
      generation: 1, specHash: 'action-a-v1', dependsOnStageIds: [],
    };
    const actionB = {
      id: 'action-b', sequence: 2, stageId: 'action-b', type: 'design', status: 'ready',
      generation: 1, specHash: 'action-b-v1', dependsOnStageIds: [],
    };
    const input = detail({
      actions: [actionA, actionB],
      messages: [{ id: 'message-1', text: 'Apply this to every unfinished Action', createdAt: 10 }],
      events: [
        {
          id: 2, type: 'action.input_added', actionId: actionA.id, createdAt: 20,
          data: { text: 'Only Action A may use this' },
        },
        {
          id: 3, type: 'action.guidance_added', actionId: actionB.id, createdAt: 30,
          data: { guidance: 'Only Action B may use this' },
        },
      ],
    });

    const snapshotA = buildMainlineContextSnapshot(input, actionA).contextSnapshot;
    const snapshotB = buildMainlineContextSnapshot(input, actionB).contextSnapshot;

    expect(snapshotA.userContext.workItemMessages).toEqual([
      expect.objectContaining({ messageId: 'message-1', text: 'Apply this to every unfinished Action' }),
    ]);
    expect(snapshotB.userContext.workItemMessages).toEqual(snapshotA.userContext.workItemMessages);
    expect(snapshotA.userContext.guidance).toEqual([
      expect.objectContaining({ actionId: actionA.id, text: 'Only Action A may use this' }),
    ]);
    expect(snapshotB.userContext.guidance).toEqual([
      expect.objectContaining({ actionId: actionB.id, text: 'Only Action B may use this' }),
    ]);
    expect(JSON.stringify(snapshotB)).not.toContain('Only Action A may use this');
    expect(JSON.stringify(snapshotA)).not.toContain('Only Action B may use this');
  });

  it('does not carry Action-scoped input across generations', () => {
    const action = {
      id: 'action-a', sequence: 1, stageId: 'action-a', type: 'implement', status: 'ready',
      generation: 2, specHash: 'action-a-v2', dependsOnStageIds: [],
    };
    const snapshot = buildMainlineContextSnapshot(detail({
      actions: [action],
      events: [
        {
          id: 1, type: 'action.input_added', actionId: action.id, actionGeneration: 1,
          data: { text: 'Input for the superseded generation' },
        },
        {
          id: 2, type: 'action.input_added', actionId: action.id, actionGeneration: 2,
          data: { text: 'Input for the current generation' },
        },
      ],
    }), action).contextSnapshot;

    expect(snapshot.userContext.guidance).toEqual([
      expect.objectContaining({ eventId: 2, text: 'Input for the current generation' }),
    ]);
    expect(JSON.stringify(snapshot)).not.toContain('Input for the superseded generation');
  });

  it('reserves final prompt wrapper bytes inside the 64 KiB hard limit', () => {
    const action = { id: 'current', sequence: 1, stageId: 'implement', type: 'implement', status: 'running' };
    const reservedBytes = 12 * 1024;
    const built = buildMainlineContextSnapshot(detail({
      actions: [action],
      sessionContext: Array.from({ length: 20 }, (_, index) => ({ role: 'user', content: `路径\\${index}😀中文`.repeat(500) })),
    }), action, { reservedBytes });

    expect(built.budget.bytes + reservedBytes).toBeLessThanOrEqual(MAINLINE_CONTEXT_HARD_LIMIT_BYTES);
    expect(built.budget.reservedBytes).toBe(reservedBytes);
    expect(built.contextSnapshot.userContext.includedCount + built.contextSnapshot.userContext.omittedCount)
      .toBeLessThanOrEqual(20);
    expect(built.contextSnapshot.userContext.omittedCount).toBeGreaterThanOrEqual(0);
  });

  it('fails explicitly instead of trimming pinned contract or Action data', () => {
    const action = {
      id: 'current', sequence: 1, stageId: 'current', type: 'implement', status: 'running',
      generation: 1, specHash: 'hash', dependsOnStageIds: [],
      brief: { objective: 'x'.repeat(70 * 1024), approach: 'Implement safely', expectedOutcome: 'Verified result' },
    };
    let blocked;
    try {
      buildMainlineContextSnapshot(detail({ actions: [action] }), action);
    } catch (error) {
      blocked = error;
    }
    expect(blocked).toMatchObject({
      name: 'MainlineContextBlockedError',
      retryable: false,
      workItemFailureKind: 'system_blocked',
      workItemFailureCode: 'mainline_context_too_large',
    });
    expect(blocked.message).toMatch(/pinned context exceeds 64 KiB/);
  });

  it('degrades non-critical sibling results within the selected dynamic budget', () => {
    const action = {
      id: 'current', sequence: 20, stageId: 'current', type: 'review', status: 'running',
      generation: 1, specHash: 'current', dependsOnStageIds: [], instruction: 'Review',
    };
    const siblings = Array.from({ length: 12 }, (_, index) => ({
      id: `sibling-${index}`, sequence: index, stageId: `sibling-${index}`,
      type: 'implement', status: 'completed', generation: 1, specHash: `sibling-${index}`,
      dependsOnStageIds: [], resultRunId: `run-${index}`,
    }));
    const built = buildMainlineContextSnapshot(detail({
      actions: [...siblings, action],
      runs: siblings.map((sibling, index) => ({
        id: `run-${index}`, actionId: sibling.id, status: 'completed', endedAt: index,
        summary: 'summary'.repeat(500), response: 'response'.repeat(1_000),
        executionManifest: { schemaVersion: 2, actionGeneration: 1, actionSpecHash: `sibling-${index}` },
      })),
    }), action);

    expect(built.budget.bytes).toBeLessThanOrEqual(built.budget.pinnedBytes + built.budget.dynamicBudgetBytes);
    expect(built.budget.selectionReason).toMatch(/siblings:(summary|index)/);
    expect(Object.values(built.contextSnapshot.siblingResults).some(result => !result.response)).toBe(true);
  });
});
