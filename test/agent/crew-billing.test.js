import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Tests for Crew billing/token tracking bug fixes (task-24).
 *
 * Bug 1: abort/error loses token usage — role-output.js
 * Bug 2: resume double-counts cost — role-query.js
 * Bug 3: clearSession doesn't reset cost counters — control.js
 *
 * We replicate the core logic from the source files to avoid SDK side effects.
 */

// =====================================================================
// Replicate settleLastSeenUsage from role-output.js
// =====================================================================

function createSettleLastSeenUsage(session, roleState) {
  return function settleLastSeenUsage() {
    if (!roleState.lastSeenUsage) return;
    const { totalCostUsd, inputTokens, outputTokens } = roleState.lastSeenUsage;
    if (totalCostUsd != null) {
      const costDelta = totalCostUsd - roleState.lastCostUsd;
      if (costDelta > 0) session.costUsd += costDelta;
      roleState.lastCostUsd = totalCostUsd;
    }
    if (inputTokens != null || outputTokens != null) {
      const inputDelta = (inputTokens || 0) - (roleState.lastInputTokens || 0);
      const outputDelta = (outputTokens || 0) - (roleState.lastOutputTokens || 0);
      if (inputDelta > 0) session.totalInputTokens += inputDelta;
      if (outputDelta > 0) session.totalOutputTokens += outputDelta;
      roleState.lastInputTokens = inputTokens || 0;
      roleState.lastOutputTokens = outputTokens || 0;
    }
    roleState.lastSeenUsage = null;
  };
}

// =====================================================================
// Helpers
// =====================================================================

function createTestSession(overrides = {}) {
  return {
    id: 'crew_billing_test',
    costUsd: overrides.costUsd || 0,
    totalInputTokens: overrides.totalInputTokens || 0,
    totalOutputTokens: overrides.totalOutputTokens || 0,
    status: overrides.status || 'running',
    round: 0,
    roleStates: new Map(),
    roles: new Map([
      ['pm', { name: 'pm', displayName: 'PM', icon: '📋', description: '需求分析', isDecisionMaker: true }],
      ['dev', { name: 'dev', displayName: '开发者', icon: '💻', description: '代码编写', isDecisionMaker: false }]
    ]),
    messageHistory: [],
    uiMessages: [],
    humanMessageQueue: [],
    waitingHumanContext: null,
    pendingRoutes: [],
    features: new Map(),
    _completedTaskIds: new Set(),
    sharedDir: '/tmp/test-crew',
    decisionMaker: 'pm',
    ...overrides
  };
}

function createTestRoleState(overrides = {}) {
  return {
    query: {},
    inputStream: {},
    abortController: new AbortController(),
    accumulatedText: '',
    turnActive: false,
    claudeSessionId: null,
    lastCostUsd: overrides.lastCostUsd || 0,
    lastInputTokens: overrides.lastInputTokens || 0,
    lastOutputTokens: overrides.lastOutputTokens || 0,
    lastSeenUsage: overrides.lastSeenUsage || null,
    consecutiveErrors: 0,
    lastDispatchContent: null,
    lastDispatchFrom: null,
    lastDispatchTaskId: null,
    lastDispatchTaskTitle: null,
    ...overrides
  };
}

// =====================================================================
// Bug 1: abort/error loses token usage
// =====================================================================

describe('Bug 1: abort/error should settle accumulated usage', () => {
  let session;
  let roleState;
  let settleLastSeenUsage;

  beforeEach(() => {
    session = createTestSession();
    roleState = createTestRoleState();
    session.roleStates.set('dev', roleState);
    settleLastSeenUsage = createSettleLastSeenUsage(session, roleState);
  });

  it('should settle usage on abort when lastSeenUsage exists', () => {
    // Simulate messages received before abort
    roleState.lastSeenUsage = {
      totalCostUsd: 0.05,
      inputTokens: 5000,
      outputTokens: 1000
    };

    // Simulate abort handler calling settleLastSeenUsage
    settleLastSeenUsage();

    expect(session.costUsd).toBe(0.05);
    expect(session.totalInputTokens).toBe(5000);
    expect(session.totalOutputTokens).toBe(1000);
    expect(roleState.lastCostUsd).toBe(0.05);
    expect(roleState.lastInputTokens).toBe(5000);
    expect(roleState.lastOutputTokens).toBe(1000);
    expect(roleState.lastSeenUsage).toBeNull();
  });

  it('should settle usage on error when lastSeenUsage exists', () => {
    roleState.lastSeenUsage = {
      totalCostUsd: 0.12,
      inputTokens: 10000,
      outputTokens: 3000
    };

    settleLastSeenUsage();

    expect(session.costUsd).toBe(0.12);
    expect(session.totalInputTokens).toBe(10000);
    expect(session.totalOutputTokens).toBe(3000);
  });

  it('should be a no-op when lastSeenUsage is null', () => {
    roleState.lastSeenUsage = null;

    settleLastSeenUsage();

    expect(session.costUsd).toBe(0);
    expect(session.totalInputTokens).toBe(0);
    expect(session.totalOutputTokens).toBe(0);
  });

  it('should correctly compute deltas from baseline', () => {
    // First result settled normally
    roleState.lastCostUsd = 0.05;
    roleState.lastInputTokens = 5000;
    roleState.lastOutputTokens = 1000;
    session.costUsd = 0.05;
    session.totalInputTokens = 5000;
    session.totalOutputTokens = 1000;

    // Second turn aborted with partial usage
    roleState.lastSeenUsage = {
      totalCostUsd: 0.08,
      inputTokens: 8000,
      outputTokens: 2000
    };

    settleLastSeenUsage();

    expect(session.costUsd).toBe(0.08);  // 0.05 + 0.03
    expect(session.totalInputTokens).toBe(8000);  // 5000 + 3000
    expect(session.totalOutputTokens).toBe(2000);  // 1000 + 1000
  });

  it('should handle zero-delta gracefully (no double count)', () => {
    roleState.lastCostUsd = 0.05;
    roleState.lastInputTokens = 5000;
    roleState.lastOutputTokens = 1000;

    // Usage same as baseline — no delta
    roleState.lastSeenUsage = {
      totalCostUsd: 0.05,
      inputTokens: 5000,
      outputTokens: 1000
    };

    settleLastSeenUsage();

    // Session should not change
    expect(session.costUsd).toBe(0);
    expect(session.totalInputTokens).toBe(0);
    expect(session.totalOutputTokens).toBe(0);
  });

  it('should handle partial usage (only cost, no tokens)', () => {
    roleState.lastSeenUsage = {
      totalCostUsd: 0.02,
      inputTokens: undefined,
      outputTokens: undefined
    };

    settleLastSeenUsage();

    expect(session.costUsd).toBe(0.02);
    expect(session.totalInputTokens).toBe(0);
    expect(session.totalOutputTokens).toBe(0);
  });

  it('should handle partial usage (only tokens, no cost)', () => {
    roleState.lastSeenUsage = {
      totalCostUsd: undefined,
      inputTokens: 3000,
      outputTokens: 500
    };

    settleLastSeenUsage();

    expect(session.costUsd).toBe(0);
    expect(session.totalInputTokens).toBe(3000);
    expect(session.totalOutputTokens).toBe(500);
  });

  it('should not double-settle if called twice', () => {
    roleState.lastSeenUsage = {
      totalCostUsd: 0.10,
      inputTokens: 8000,
      outputTokens: 2000
    };

    settleLastSeenUsage();
    settleLastSeenUsage(); // second call should be no-op

    expect(session.costUsd).toBe(0.10);
    expect(session.totalInputTokens).toBe(8000);
    expect(session.totalOutputTokens).toBe(2000);
  });

  it('should accumulate across multiple roles', () => {
    const roleState2 = createTestRoleState();
    session.roleStates.set('pm', roleState2);
    const settle2 = createSettleLastSeenUsage(session, roleState2);

    roleState.lastSeenUsage = {
      totalCostUsd: 0.05,
      inputTokens: 5000,
      outputTokens: 1000
    };
    settleLastSeenUsage();

    roleState2.lastSeenUsage = {
      totalCostUsd: 0.03,
      inputTokens: 3000,
      outputTokens: 500
    };
    settle2();

    expect(session.costUsd).toBe(0.08);
    expect(session.totalInputTokens).toBe(8000);
    expect(session.totalOutputTokens).toBe(1500);
  });
});

// =====================================================================
// Bug 2: resume double-counts cost
// =====================================================================

describe('Bug 2: resume should preserve baseline to avoid double-counting', () => {
  it('should initialize to 0 for fresh query (no savedSessionId)', () => {
    const savedSessionId = null;
    const existingState = null;
    const isResume = !!savedSessionId;

    const lastCostUsd = (isResume && existingState?.lastCostUsd) || 0;
    const lastInputTokens = (isResume && existingState?.lastInputTokens) || 0;
    const lastOutputTokens = (isResume && existingState?.lastOutputTokens) || 0;

    expect(lastCostUsd).toBe(0);
    expect(lastInputTokens).toBe(0);
    expect(lastOutputTokens).toBe(0);
  });

  it('should preserve existing baseline on resume', () => {
    const savedSessionId = 'session_abc123';
    const existingState = {
      lastCostUsd: 0.15,
      lastInputTokens: 20000,
      lastOutputTokens: 5000
    };
    const isResume = !!savedSessionId;

    const lastCostUsd = (isResume && existingState?.lastCostUsd) || 0;
    const lastInputTokens = (isResume && existingState?.lastInputTokens) || 0;
    const lastOutputTokens = (isResume && existingState?.lastOutputTokens) || 0;

    expect(lastCostUsd).toBe(0.15);
    expect(lastInputTokens).toBe(20000);
    expect(lastOutputTokens).toBe(5000);
  });

  it('should use 0 on resume when existingState has no last* values', () => {
    const savedSessionId = 'session_abc123';
    const existingState = null; // no existing state
    const isResume = !!savedSessionId;

    const lastCostUsd = (isResume && existingState?.lastCostUsd) || 0;
    const lastInputTokens = (isResume && existingState?.lastInputTokens) || 0;
    const lastOutputTokens = (isResume && existingState?.lastOutputTokens) || 0;

    expect(lastCostUsd).toBe(0);
    expect(lastInputTokens).toBe(0);
    expect(lastOutputTokens).toBe(0);
  });

  it('should correctly compute delta after resume with preserved baseline', () => {
    const session = createTestSession({ costUsd: 0.15, totalInputTokens: 20000, totalOutputTokens: 5000 });

    // Simulate resume: existing roleState has baseline from before pause
    const roleState = createTestRoleState({
      lastCostUsd: 0.15,
      lastInputTokens: 20000,
      lastOutputTokens: 5000
    });

    const settleLastSeenUsage = createSettleLastSeenUsage(session, roleState);

    // Claude returns cumulative value that includes history
    roleState.lastSeenUsage = {
      totalCostUsd: 0.20,  // cumulative: 0.15 old + 0.05 new
      inputTokens: 25000,   // cumulative: 20000 old + 5000 new
      outputTokens: 6000    // cumulative: 5000 old + 1000 new
    };

    settleLastSeenUsage();

    // Should only add the delta (0.05), not the full 0.20
    expect(session.costUsd).toBe(0.20);   // 0.15 + 0.05
    expect(session.totalInputTokens).toBe(25000); // 20000 + 5000
    expect(session.totalOutputTokens).toBe(6000); // 5000 + 1000
  });

  it('BUG SCENARIO: without fix, resume from 0 baseline would double-count', () => {
    const session = createTestSession({ costUsd: 0.15, totalInputTokens: 20000, totalOutputTokens: 5000 });

    // Simulate the OLD bug: baseline is 0 despite resume
    const roleStateBuggy = createTestRoleState({
      lastCostUsd: 0,       // BUG: should be 0.15
      lastInputTokens: 0,   // BUG: should be 20000
      lastOutputTokens: 0   // BUG: should be 5000
    });

    const settleBuggy = createSettleLastSeenUsage(session, roleStateBuggy);

    roleStateBuggy.lastSeenUsage = {
      totalCostUsd: 0.20,
      inputTokens: 25000,
      outputTokens: 6000
    };

    settleBuggy();

    // BUG: session.costUsd = 0.15 + 0.20 = 0.35 (should be 0.20)
    expect(session.costUsd).toBe(0.35); // demonstrates the double-count bug
    expect(session.totalInputTokens).toBe(45000); // 20000 + 25000 (buggy)
    expect(session.totalOutputTokens).toBe(11000); // 5000 + 6000 (buggy)
  });

  it('should handle clearRoleSessionId then fresh query (no double count)', () => {
    // After clearRoleSessionId, savedSessionId is null → fresh query → baseline = 0
    // This is correct: error recovery / compact creates new conversation
    const savedSessionId = null;
    const existingState = {
      lastCostUsd: 0.15,
      lastInputTokens: 20000,
      lastOutputTokens: 5000
    };
    const isResume = !!savedSessionId;

    const lastCostUsd = (isResume && existingState?.lastCostUsd) || 0;

    // Fresh query starts from 0, which is correct since Claude also starts from 0
    expect(lastCostUsd).toBe(0);
  });

  it('should preserve baseline when existingState has zero values on resume', () => {
    // Edge case: resuming a session that had 0 cost (first turn was paused before any result)
    const savedSessionId = 'session_abc123';
    const existingState = {
      lastCostUsd: 0,
      lastInputTokens: 0,
      lastOutputTokens: 0
    };
    const isResume = !!savedSessionId;

    // (isResume && 0) is falsy → falls through to || 0
    // This is fine because 0 || 0 = 0, which is the correct baseline
    const lastCostUsd = (isResume && existingState?.lastCostUsd) || 0;
    expect(lastCostUsd).toBe(0);
  });
});

// =====================================================================
// Bug 3: clearSession doesn't reset cost counters
// =====================================================================

describe('Bug 3: clearSession should reset cost/token counters', () => {
  // Replicate clearSession logic (billing-relevant parts)
  function clearSessionBilling(session) {
    session.round = 0;
    // Fix: reset billing stats
    session.costUsd = 0;
    session.totalInputTokens = 0;
    session.totalOutputTokens = 0;
  }

  it('should reset all billing counters to zero', () => {
    const session = createTestSession({
      costUsd: 1.25,
      totalInputTokens: 150000,
      totalOutputTokens: 40000
    });
    session.round = 15;

    clearSessionBilling(session);

    expect(session.costUsd).toBe(0);
    expect(session.totalInputTokens).toBe(0);
    expect(session.totalOutputTokens).toBe(0);
    expect(session.round).toBe(0);
  });

  it('should be safe to call on already-zero counters', () => {
    const session = createTestSession();

    clearSessionBilling(session);

    expect(session.costUsd).toBe(0);
    expect(session.totalInputTokens).toBe(0);
    expect(session.totalOutputTokens).toBe(0);
  });

  it('should allow fresh accumulation after clear', () => {
    const session = createTestSession({
      costUsd: 1.25,
      totalInputTokens: 150000,
      totalOutputTokens: 40000
    });

    clearSessionBilling(session);

    // Simulate new query after clear
    const roleState = createTestRoleState();
    const settleLastSeenUsage = createSettleLastSeenUsage(session, roleState);

    roleState.lastSeenUsage = {
      totalCostUsd: 0.03,
      inputTokens: 2000,
      outputTokens: 500
    };
    settleLastSeenUsage();

    expect(session.costUsd).toBe(0.03);
    expect(session.totalInputTokens).toBe(2000);
    expect(session.totalOutputTokens).toBe(500);
  });

  it('BUG SCENARIO: without fix, old cost persists after clear', () => {
    const session = createTestSession({
      costUsd: 1.25,
      totalInputTokens: 150000,
      totalOutputTokens: 40000
    });

    // Old behavior: clearSession did NOT reset billing
    function clearSessionOld(s) {
      s.round = 0;
      // Missing: s.costUsd = 0; s.totalInputTokens = 0; s.totalOutputTokens = 0;
    }

    clearSessionOld(session);

    // Old cost still there — this is the bug
    expect(session.costUsd).toBe(1.25);
    expect(session.totalInputTokens).toBe(150000);
    expect(session.totalOutputTokens).toBe(40000);
  });
});

// =====================================================================
// Integration: full lifecycle scenarios
// =====================================================================

describe('Billing lifecycle integration', () => {
  it('should track cost across multiple turns, abort, and resume correctly', () => {
    const session = createTestSession();
    const roleState = createTestRoleState();
    session.roleStates.set('dev', roleState);
    const settle = createSettleLastSeenUsage(session, roleState);

    // Turn 1: normal result
    roleState.lastSeenUsage = {
      totalCostUsd: 0.05,
      inputTokens: 5000,
      outputTokens: 1000
    };
    settle();
    expect(session.costUsd).toBe(0.05);

    // Turn 2: aborted mid-turn
    roleState.lastSeenUsage = {
      totalCostUsd: 0.10,
      inputTokens: 10000,
      outputTokens: 2500
    };
    settle(); // abort handler settles
    expect(session.costUsd).toBe(0.10);
    expect(session.totalInputTokens).toBe(10000);

    // Turn 3: resumed with correct baseline
    // (no new lastSeenUsage set yet)
    expect(roleState.lastCostUsd).toBe(0.10);
    expect(roleState.lastInputTokens).toBe(10000);

    // Turn 3 result
    roleState.lastSeenUsage = {
      totalCostUsd: 0.15,
      inputTokens: 15000,
      outputTokens: 4000
    };
    settle();
    expect(session.costUsd).toBe(0.15);
    expect(session.totalInputTokens).toBe(15000);
    expect(session.totalOutputTokens).toBe(4000);
  });

  it('should handle clearSession followed by new activity', () => {
    const session = createTestSession({
      costUsd: 2.50,
      totalInputTokens: 300000,
      totalOutputTokens: 80000
    });

    // clearSession resets
    session.costUsd = 0;
    session.totalInputTokens = 0;
    session.totalOutputTokens = 0;

    // New role state (fresh query, no resume)
    const roleState = createTestRoleState();
    session.roleStates.set('dev', roleState);
    const settle = createSettleLastSeenUsage(session, roleState);

    // First turn of new session
    roleState.lastSeenUsage = {
      totalCostUsd: 0.02,
      inputTokens: 1500,
      outputTokens: 300
    };
    settle();

    expect(session.costUsd).toBe(0.02);
    expect(session.totalInputTokens).toBe(1500);
    expect(session.totalOutputTokens).toBe(300);
  });

  it('should not lose usage when error occurs after receiving partial results', () => {
    const session = createTestSession();
    const roleState = createTestRoleState();
    session.roleStates.set('dev', roleState);
    const settle = createSettleLastSeenUsage(session, roleState);

    // Streaming messages arrive with usage info
    roleState.lastSeenUsage = {
      totalCostUsd: 0.07,
      inputTokens: 7000,
      outputTokens: 1500
    };

    // Error occurs — settle before cleanup
    settle();

    expect(session.costUsd).toBe(0.07);
    expect(session.totalInputTokens).toBe(7000);
    expect(session.totalOutputTokens).toBe(1500);
  });
});

// =====================================================================
// Source code verification: ensure fixes are in the actual files
// =====================================================================

describe('Source code verification', () => {
  let roleOutputSource, roleQuerySource, controlSource;

  beforeEach(async () => {
    const { promises: fs } = await import('fs');
    const { join } = await import('path');
    const agentDir = join(process.cwd(), 'agent', 'crew');
    roleOutputSource = await fs.readFile(join(agentDir, 'role-output.js'), 'utf-8');
    roleQuerySource = await fs.readFile(join(agentDir, 'role-query.js'), 'utf-8');
    controlSource = await fs.readFile(join(agentDir, 'control.js'), 'utf-8');
  });

  describe('role-output.js', () => {
    it('should have settleLastSeenUsage function', () => {
      expect(roleOutputSource).toContain('function settleLastSeenUsage()');
    });

    it('should call settleLastSeenUsage in abort handler', () => {
      // After AbortError check, settle should be called
      expect(roleOutputSource).toContain("AbortError");
      expect(roleOutputSource).toContain('settleLastSeenUsage()');
    });

    it('should call settleLastSeenUsage in error handler', () => {
      const errorSection = roleOutputSource.split('AbortError')[1] || '';
      expect(errorSection).toContain('settleLastSeenUsage()');
    });

    it('should track lastSeenUsage from streaming messages', () => {
      expect(roleOutputSource).toContain('lastSeenUsage');
      expect(roleOutputSource).toContain('message.total_cost_usd');
      expect(roleOutputSource).toContain('message.usage');
    });

    it('should use settleLastSeenUsage for result block too (unified path)', () => {
      // The result block should also use settleLastSeenUsage instead of inline calculation
      expect(roleOutputSource).toContain('settleLastSeenUsage()');
      // Old inline cost calculation should be gone
      expect(roleOutputSource).not.toContain('costDelta = message.total_cost_usd - roleState.lastCostUsd');
    });
  });

  describe('role-query.js', () => {
    it('should check for existing roleState on resume', () => {
      expect(roleQuerySource).toContain('existingState');
      expect(roleQuerySource).toContain('isResume');
    });

    it('should preserve last* baseline values on resume', () => {
      expect(roleQuerySource).toContain('isResume && existingState?.lastCostUsd');
      expect(roleQuerySource).toContain('isResume && existingState?.lastInputTokens');
      expect(roleQuerySource).toContain('isResume && existingState?.lastOutputTokens');
    });

    it('should include lastSeenUsage: null in initial roleState', () => {
      expect(roleQuerySource).toContain('lastSeenUsage: null');
    });
  });

  describe('control.js', () => {
    it('should reset costUsd in clearSession', () => {
      expect(controlSource).toContain('session.costUsd = 0');
    });

    it('should reset totalInputTokens in clearSession', () => {
      expect(controlSource).toContain('session.totalInputTokens = 0');
    });

    it('should reset totalOutputTokens in clearSession', () => {
      expect(controlSource).toContain('session.totalOutputTokens = 0');
    });
  });
});
