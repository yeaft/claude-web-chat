import { describe, expect, it } from 'vitest';
import { selectWorkItemVp } from '../../../../agent/yeaft/work-center/assignment.js';

const vps = [
  { id: 'zeta', role: 'Systems Engineer', area: 'engineering' },
  { id: 'alpha', role: 'Quality Analyst', area: 'testing' },
];

function select(policy, stageType = 'custom', priorRuns = []) {
  return selectWorkItemVp({ policy, stageType, vps, priorRuns });
}

describe('Work Center VP assignment', () => {
  it('uses capability scoring before deterministic tie-breaking', () => {
    const result = select({ mode: 'auto', capability: 'test' });

    expect(result.vp.id).toBe('alpha');
    expect(result.reason).toMatch(/^auto:test:score=/);
  });

  it('falls back from an unknown capability to the Action type', () => {
    const result = select({ mode: 'auto', capability: 'protocol-forensics' }, 'diagnose');

    expect(result.vp.id).toBe('zeta');
    expect(result.reason).toMatch(/fallback=diagnose:score=/);
  });

  it('uses the lowest eligible VP id when capability and Action type scores are zero', () => {
    const result = select({ mode: 'auto', capability: 'protocol-forensics' });

    expect(result.vp.id).toBe('alpha');
    expect(result.reason).toBe('auto:protocol-forensics:fallback=custom:eligible-id:score=0');
  });

  it('preserves fixed, planned, pool, availability, and separation semantics', () => {
    expect(select({ mode: 'fixed', fixedVpId: 'zeta' }).vp.id).toBe('zeta');
    expect(select({
      mode: 'planned', candidateVpIds: ['zeta', 'alpha'], assignmentReason: 'plan',
    }).vp.id).toBe('zeta');
    expect(select({
      mode: 'planned', candidateVpIds: ['zeta', 'alpha'], assignmentReason: 'plan',
      separateFromStageTypes: ['review'],
    }, 'custom', [{ actionType: 'review', vpSnapshot: { id: 'zeta' } }]).vp.id).toBe('alpha');
    expect(select({
      mode: 'pool', candidateVpIds: ['missing', 'zeta', 'alpha'], capability: 'unknown',
    }).vp.id).toBe('alpha');
  });

  it('fails when separation removes every candidate and includes sanitized context', () => {
    const priorRuns = [
      { actionType: 'review', vpSnapshot: { id: 'alpha' } },
      { actionType: 'review', vpSnapshot: { id: 'zeta' } },
    ];

    expect(() => select({
      mode: 'auto', capability: 'protocol forensics/value', separateFromStageTypes: ['review'],
    }, 'custom', priorRuns)).toThrowError(expect.objectContaining({
      retryable: false,
      message: expect.stringMatching(
        /mode=auto; capability=protocol-forensics-value; fallback=not-attempted; candidates=alpha,zeta; excluded=alpha,zeta/,
      ),
    }));
  });

  it('fails deterministically when no VP is available', () => {
    expect(() => selectWorkItemVp({
      policy: { mode: 'auto', capability: 'unsafe capability/value' },
      stageType: 'custom',
      vps: [],
    })).toThrowError(expect.objectContaining({
      retryable: false,
      message: expect.stringMatching(
        /capability=unsafe-capability-value; fallback=not-attempted; candidates=none; excluded=none/,
      ),
    }));
  });

  it('reports unavailable fixed and planned candidates without changing policy modes', () => {
    expect(() => select({ mode: 'fixed', fixedVpId: 'missing/value' }))
      .toThrow(/Fixed Work Center VP is unavailable: missing-value.*mode=fixed.*candidates=missing-value/);
    expect(() => select({
      mode: 'planned', candidateVpIds: ['missing/value'], assignmentReason: 'plan',
    })).toThrow(/No configured Work Center VP candidates are available.*mode=planned.*candidates=missing-value/);
  });
});
