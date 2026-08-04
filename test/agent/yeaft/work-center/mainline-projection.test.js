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














  it('keeps Coordinator conversation out of executor prompts while isolating Action-scoped input', () => {
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
      messages: [
        { id: 'legacy', role: 'legacy_instruction', text: 'Already consumed legacy direction', createdAt: 9 },
        { id: 'message-1', role: 'user', text: 'Apply this to every unfinished Action', createdAt: 10 },
        { id: 'message-2', role: 'assistant', text: 'Coordinator internal reply', createdAt: 11 },
      ],
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

    expect(snapshotA.userContext.workItemMessages).toEqual([]);
    expect(snapshotB.userContext.workItemMessages).toEqual([]);
    expect(JSON.stringify(snapshotA)).not.toContain('Already consumed legacy direction');
    expect(JSON.stringify(snapshotA)).not.toContain('Apply this to every unfinished Action');
    expect(JSON.stringify(snapshotB)).not.toContain('Coordinator internal reply');
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
      context: [
        {
          type: 'input', role: 'user', inputId: 'current-input-a',
          summary: 'Current canonical duplicate', attachments: [], evidence: [],
        },
        {
          type: 'input', role: 'user', inputId: 'current-input-b',
          summary: 'Current canonical duplicate', attachments: [], evidence: [],
        },
      ],
    };
    const snapshot = buildMainlineContextSnapshot(detail({
      actions: [action],
      events: [
        {
          id: 1, type: 'action.input_added', actionId: action.id, actionGeneration: 1,
          data: { text: 'Input for the superseded generation' },
        },
        {
          id: 2, type: 'action.input_added', actionId: action.id,
          data: { text: 'Legacy input without a generation' },
        },
        {
          id: 3, type: 'action.input_added', actionId: action.id, actionGeneration: 2,
          data: { text: 'Input for the current generation' },
        },
        {
          id: 4, type: 'action.input_added', actionId: action.id, actionGeneration: 1,
          data: { inputId: 'current-input-a', text: 'Current canonical duplicate' },
        },
        {
          id: 5, type: 'action.input_added', actionId: action.id, actionGeneration: 2,
          data: { inputId: 'current-input-b', text: 'Current canonical duplicate' },
        },
        {
          id: 6, type: 'action.input_added', actionId: action.id, actionGeneration: 1,
          data: { inputId: 'rebound-only-input', text: 'Rebound event-only input' },
        },
        {
          id: 7, type: 'action.input_rebound', actionId: action.id, actionGeneration: 2,
          data: { sourceEventIds: [6] },
        },
      ],
    }), action).contextSnapshot;

    expect(snapshot.userContext.guidance).toEqual([
      expect.objectContaining({ eventId: 4, inputId: 'current-input-a', text: 'Current canonical duplicate' }),
      expect.objectContaining({ eventId: 5, inputId: 'current-input-b', text: 'Current canonical duplicate' }),
      expect.objectContaining({ eventId: 3, text: 'Input for the current generation' }),
      expect.objectContaining({ eventId: 6, inputId: 'rebound-only-input', text: 'Rebound event-only input' }),
    ]);
    expect(JSON.stringify(snapshot)).not.toContain('Input for the superseded generation');
    expect(JSON.stringify(snapshot)).not.toContain('Legacy input without a generation');

    const newestFirst = buildMainlineContextSnapshot(detail({
      actions: [action],
      events: [
        {
          id: 8, type: 'action.input_added', actionId: action.id, actionGeneration: 2,
          data: { inputId: 'older-large', text: '旧'.repeat(8_000) },
        },
        {
          id: 9, type: 'action.input_added', actionId: action.id, actionGeneration: 2,
          data: { inputId: 'latest-correction', text: 'LATEST UTF8 CORRECTION' },
        },
      ],
    }), { ...action, context: [] }).contextSnapshot;
    expect(JSON.stringify(newestFirst)).toContain('LATEST UTF8 CORRECTION');
    expect(JSON.stringify(newestFirst)).not.toContain('旧旧旧');
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




});
