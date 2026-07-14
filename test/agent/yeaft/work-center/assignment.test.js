import { describe, expect, it } from 'vitest';
import { resolveWorkItemModel, selectWorkItemVp } from '../../../../agent/yeaft/work-center/assignment.js';
import { previewWorkCenterPlan } from '../../../../agent/yeaft/work-center/planner.js';
import { defaultWorkCenterSettings } from '../../../../agent/yeaft/work-center/workflow.js';
import { Registry } from '../../../../agent/yeaft/vp/registry.js';

function vp(id, role, traits = [], modelHint = 'primary') {
  return { id, name: id, role, traits, area: 'engineering', modelHint };
}

const vps = [
  vp('linus', 'Systems Engineer', ['implementation', 'release']),
  vp('martin', 'Code Reviewer', ['review', 'readability']),
  vp('omni', 'Requirement and Flow Lead', ['triage', 'cross-domain']),
  vp('tester', 'Quality Engineer', ['testing', 'verification'], 'fast'),
];

const config = {
  primaryModel: 'provider/primary',
  fastModel: 'provider/fast',
  availableModels: [
    { id: 'primary', ref: 'provider/primary', provider: 'provider', effortOptions: [] },
    { id: 'fast', ref: 'provider/fast', provider: 'provider', effortOptions: ['low'] },
    { id: 'review', ref: 'provider/review', provider: 'provider', effortOptions: ['medium', 'high'] },
  ],
};

describe('Work Center assignment and model policy', () => {
  it('selects deterministically from all VPs by capability', () => {
    const selected = selectWorkItemVp({
      policy: { mode: 'auto', capability: 'review' }, stageType: 'review', vps,
    });
    expect(selected.vp.id).toBe('martin');
    expect(selected.reason).toMatch(/^auto:review/);
  });

  it('falls back from an over-specific AI capability to the Action type', () => {
    const selected = selectWorkItemVp({
      policy: { mode: 'auto', capability: 'kernel-regression-forensics' },
      stageType: 'implement', vps,
    });
    expect(selected.vp.id).toBe('linus');
    expect(selected.reason).toContain('fallback=implement');
  });

  it.each(['constructor', '__proto__'])(
    'treats the unknown capability %s as a literal search term',
    (capability) => {
      const selected = selectWorkItemVp({
        policy: { mode: 'auto', capability },
        stageType: 'custom',
        vps: [
          vp('domain-expert', 'Domain Expert', [capability]),
          vp('generalist', 'General Engineer'),
        ],
      });
      expect(selected.vp.id).toBe('domain-expert');
      expect(selected.reason).toContain(`auto:${capability}:score=6`);
    },
  );

  it('honors pool and fixed assignments and rejects unavailable members', () => {
    expect(selectWorkItemVp({
      policy: { mode: 'pool', capability: 'implement', candidateVpIds: ['martin', 'linus'] },
      stageType: 'implement', vps,
    }).vp.id).toBe('linus');
    expect(selectWorkItemVp({
      policy: { mode: 'fixed', fixedVpId: 'tester' }, stageType: 'test', vps,
    }).vp.id).toBe('tester');
    expect(() => selectWorkItemVp({
      policy: { mode: 'fixed', fixedVpId: 'missing' }, stageType: 'test', vps,
    })).toThrow(/unavailable/);
  });

  it('enforces reviewer separation from the actual implementation VP', () => {
    const selected = selectWorkItemVp({
      policy: { mode: 'auto', capability: 'review', separateFromStageTypes: ['implement'] },
      stageType: 'review',
      vps,
      priorRuns: [{ actionType: 'implement', vpSnapshot: { id: 'linus' } }],
    });
    expect(selected.vp.id).toBe('martin');
    expect(() => selectWorkItemVp({
      policy: { mode: 'fixed', fixedVpId: 'linus', separateFromStageTypes: ['implement'] },
      stageType: 'review',
      vps,
      priorRuns: [{ actionType: 'implement', vpSnapshot: { id: 'linus' } }],
    })).toThrow(/separation policy/);
  });

  it('resolves model precedence and never silently accepts a missing model', () => {
    expect(resolveWorkItemModel(config, vps[3], { mode: 'inherit' })).toMatchObject({
      model: 'provider/fast', source: 'vp-fast', provider: 'provider',
    });
    expect(resolveWorkItemModel(config, vps[0], {
      mode: 'specific', model: 'provider/review', effort: 'high',
    })).toMatchObject({ model: 'provider/review', effort: 'high', source: 'stage-specific' });
    expect(() => resolveWorkItemModel(config, vps[0], {
      mode: 'specific', model: 'missing/model',
    })).toThrow(/unavailable/);
    expect(resolveWorkItemModel(config, vps[0], {
      mode: 'specific', model: 'provider/fast', effort: 'high',
    }).effort).toBe('low');
  });

  it('previews the same full workflow policy used by execution', () => {
    const registry = new Registry();
    vps.forEach(item => registry.setVp(item));
    const preview = previewWorkCenterPlan({
      settings: defaultWorkCenterSettings(),
      workflowId: 'software-change',
      registry,
      config,
    });
    expect(preview.valid).toBe(true);
    expect(preview.stages.map(stage => [stage.type, stage.selectedVp.id])).toEqual([
      ['triage', 'omni'],
      ['implement', 'linus'],
      ['review', 'martin'],
      ['deliver', 'linus'],
    ]);
    expect(preview.stages.every(stage => stage.model.id === 'provider/primary')).toBe(true);
  });
});
