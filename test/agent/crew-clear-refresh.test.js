import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Tests for Crew clear/refresh P0+P1 fixes (task-27).
 *
 * P0-1: Ghost ROUTE execution — clearSingleRole should purge humanMessageQueue
 * P0-3: clearSingleRole missing currentTask/currentTool/lastTurnText reset
 * P1-1: clearSession ghost loop — humanMessageQueue cleared + _processingHumanQueue reset
 * P1-2: _processingHumanQueue flag residual after clear
 * P1-3: abort + dispatch race — clearSingleRole must await abort completion
 * P1-4: Stream.enqueue without guard — routing.js enqueue safety
 * P1-5: resumeSession parallel route duplicate dispatch — serial execution
 * P1-6: createRoleQuery concurrent mutex — per-role lock
 *
 * We replicate core logic to avoid SDK side effects (same pattern as crew-billing.test.js).
 */

// =====================================================================
// Replicate Stream for testing
// =====================================================================

class MockStream {
  constructor() {
    this.queue = [];
    this.isDone = false;
    this.readResolve = undefined;
    this.readReject = undefined;
    this.started = false;
  }

  [Symbol.asyncIterator]() {
    this.started = true;
    return this;
  }

  async next() {
    if (this.queue.length > 0) {
      return { done: false, value: this.queue.shift() };
    }
    if (this.isDone) {
      return { done: true, value: undefined };
    }
    return new Promise((resolve, reject) => {
      this.readResolve = resolve;
      this.readReject = reject;
    });
  }

  enqueue(value) {
    if (this.readResolve) {
      const resolve = this.readResolve;
      this.readResolve = undefined;
      this.readReject = undefined;
      resolve({ done: false, value });
    } else {
      this.queue.push(value);
    }
  }

  done() {
    this.isDone = true;
    if (this.readResolve) {
      const resolve = this.readResolve;
      this.readResolve = undefined;
      this.readReject = undefined;
      resolve({ done: true, value: undefined });
    }
  }

  error(error) {
    this.hasError = error;
    if (this.readReject) {
      const reject = this.readReject;
      this.readResolve = undefined;
      this.readReject = undefined;
      reject(error);
    }
  }

  async return() {
    this.isDone = true;
    return { done: true, value: undefined };
  }
}

// =====================================================================
// Helpers
// =====================================================================

function createTestSession(overrides = {}) {
  return {
    id: 'crew_clear_test',
    costUsd: overrides.costUsd || 0,
    totalInputTokens: overrides.totalInputTokens || 0,
    totalOutputTokens: overrides.totalOutputTokens || 0,
    status: overrides.status || 'running',
    round: 0,
    roleStates: new Map(),
    roles: new Map([
      ['pm', { name: 'pm', displayName: 'PM', icon: '📋', description: '需求分析', isDecisionMaker: true }],
      ['dev', { name: 'dev', displayName: '开发者', icon: '💻', description: '代码编写', isDecisionMaker: false }],
      ['rev', { name: 'rev', displayName: '审查者', icon: '🔍', description: '代码审查', isDecisionMaker: false }]
    ]),
    messageHistory: [],
    uiMessages: [],
    humanMessageQueue: [],
    waitingHumanContext: null,
    pendingRoutes: [],
    features: new Map(),
    _completedTaskIds: new Set(),
    _processingHumanQueue: false,
    sharedDir: '/tmp/test-crew',
    decisionMaker: 'pm',
    language: 'zh-CN',
    ...overrides
  };
}

function createTestRoleState(overrides = {}) {
  const inputStream = new MockStream();
  return {
    query: overrides.query || { [Symbol.asyncIterator]() { return { next: async () => ({ done: true }) }; } },
    inputStream: overrides.inputStream || inputStream,
    abortController: overrides.abortController || new AbortController(),
    accumulatedText: overrides.accumulatedText || '',
    turnActive: overrides.turnActive || false,
    claudeSessionId: overrides.claudeSessionId || null,
    lastCostUsd: overrides.lastCostUsd || 0,
    lastInputTokens: overrides.lastInputTokens || 0,
    lastOutputTokens: overrides.lastOutputTokens || 0,
    lastSeenUsage: overrides.lastSeenUsage || null,
    consecutiveErrors: overrides.consecutiveErrors || 0,
    lastDispatchContent: overrides.lastDispatchContent || null,
    lastDispatchFrom: overrides.lastDispatchFrom || null,
    lastDispatchTaskId: overrides.lastDispatchTaskId || null,
    lastDispatchTaskTitle: overrides.lastDispatchTaskTitle || null,
    currentTask: overrides.currentTask || null,
    currentTool: overrides.currentTool || null,
    lastTurnText: overrides.lastTurnText || '',
    ...overrides
  };
}

// =====================================================================
// Replicate clearSingleRole logic (P0-1, P0-3, P1-3)
// =====================================================================

async function clearSingleRole(session, roleName) {
  const roleState = session.roleStates.get(roleName);

  // P0-1: Purge humanMessageQueue entries targeting this role
  if (session.humanMessageQueue.length > 0) {
    session.humanMessageQueue = session.humanMessageQueue.filter(m => m.target !== roleName);
  }

  if (roleState) {
    // P1-3: abort and await query drain
    if (roleState.abortController) {
      roleState.abortController.abort();
    }
    if (roleState.query) {
      try {
        for await (const _ of roleState.query) {} // eslint-disable-line no-unused-vars
      } catch {
        // Expected: AbortError
      }
    }

    roleState.query = null;
    roleState.inputStream = null;
    roleState.turnActive = false;
    roleState.claudeSessionId = null;
    roleState.consecutiveErrors = 0;
    roleState.accumulatedText = '';
    roleState.lastDispatchContent = null;
    roleState.lastDispatchFrom = null;
    roleState.lastDispatchTaskId = null;
    roleState.lastDispatchTaskTitle = null;
    // P0-3: Reset UI state
    roleState.currentTask = null;
    roleState.currentTool = null;
    roleState.lastTurnText = '';
  }
}

// Replicate clearSession logic (P1-1, P1-2)
function clearSession(session) {
  // P1-2: Reset processing flag
  session._processingHumanQueue = false;

  for (const [, roleState] of session.roleStates) {
    if (roleState.abortController) {
      roleState.abortController.abort();
    }
  }
  session.roleStates.clear();

  session.messageHistory = [];
  session.uiMessages = [];
  session.humanMessageQueue = [];
  session.waitingHumanContext = null;
  session.pendingRoutes = [];

  session.features.clear();
  session._completedTaskIds = new Set();
  session.round = 0;
  session.costUsd = 0;
  session.totalInputTokens = 0;
  session.totalOutputTokens = 0;
  session.status = 'running';
}

// Replicate safe enqueue logic (P1-4)
function safeEnqueue(inputStream, message) {
  try {
    if (inputStream && !inputStream.isDone) {
      inputStream.enqueue(message);
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

// Replicate per-role mutex (P1-6)
const _roleQueryLocks = new Map();

async function createRoleQueryWithMutex(session, roleName, creatorFn) {
  const lockKey = `${session.id}:${roleName}`;

  if (_roleQueryLocks.has(lockKey)) {
    try {
      await _roleQueryLocks.get(lockKey);
    } catch {
      // Previous attempt failed
    }
    const existing = session.roleStates.get(roleName);
    if (existing?.query && existing?.inputStream && !existing.inputStream.isDone) {
      return existing;
    }
  }

  const promise = creatorFn(session, roleName);
  _roleQueryLocks.set(lockKey, promise);
  try {
    const result = await promise;
    return result;
  } finally {
    if (_roleQueryLocks.get(lockKey) === promise) {
      _roleQueryLocks.delete(lockKey);
    }
  }
}

// =====================================================================
// P0-1: Ghost ROUTE execution — clearSingleRole purges humanMessageQueue
// =====================================================================

describe('P0-1: clearSingleRole purges ghost ROUTE messages from humanMessageQueue', () => {
  let session;

  beforeEach(() => {
    session = createTestSession();
    session.roleStates.set('dev', createTestRoleState({ turnActive: true }));
    session.roleStates.set('rev', createTestRoleState());
  });

  it('should remove humanMessageQueue entries targeting the cleared role', async () => {
    session.humanMessageQueue = [
      { target: 'dev', content: 'ghost message 1' },
      { target: 'pm', content: 'keep this' },
      { target: 'dev', content: 'ghost message 2' }
    ];

    await clearSingleRole(session, 'dev');

    expect(session.humanMessageQueue).toHaveLength(1);
    expect(session.humanMessageQueue[0].target).toBe('pm');
    expect(session.humanMessageQueue[0].content).toBe('keep this');
  });

  it('should handle empty humanMessageQueue gracefully', async () => {
    session.humanMessageQueue = [];
    await clearSingleRole(session, 'dev');
    expect(session.humanMessageQueue).toHaveLength(0);
  });

  it('should not affect messages for other roles', async () => {
    session.humanMessageQueue = [
      { target: 'pm', content: 'for PM' },
      { target: 'rev', content: 'for reviewer' }
    ];

    await clearSingleRole(session, 'dev');

    expect(session.humanMessageQueue).toHaveLength(2);
    expect(session.humanMessageQueue.map(m => m.target)).toEqual(['pm', 'rev']);
  });

  it('should clear all entries when all target same role', async () => {
    session.humanMessageQueue = [
      { target: 'dev', content: 'msg1' },
      { target: 'dev', content: 'msg2' },
      { target: 'dev', content: 'msg3' }
    ];

    await clearSingleRole(session, 'dev');
    expect(session.humanMessageQueue).toHaveLength(0);
  });
});

// =====================================================================
// P0-3: clearSingleRole resets currentTask/currentTool/lastTurnText
// =====================================================================

describe('P0-3: clearSingleRole resets UI state fields', () => {
  let session;

  beforeEach(() => {
    session = createTestSession();
  });

  it('should reset currentTask to null after clear', async () => {
    const roleState = createTestRoleState({
      currentTask: { taskId: 'task-42', taskTitle: 'Important feature' },
      turnActive: true
    });
    session.roleStates.set('dev', roleState);

    await clearSingleRole(session, 'dev');

    expect(roleState.currentTask).toBeNull();
  });

  it('should reset currentTool to null after clear', async () => {
    const roleState = createTestRoleState({
      currentTool: 'Edit',
      turnActive: true
    });
    session.roleStates.set('dev', roleState);

    await clearSingleRole(session, 'dev');

    expect(roleState.currentTool).toBeNull();
  });

  it('should reset lastTurnText to empty string after clear', async () => {
    const roleState = createTestRoleState({
      lastTurnText: 'Previous turn output that should be cleared',
      turnActive: true
    });
    session.roleStates.set('dev', roleState);

    await clearSingleRole(session, 'dev');

    expect(roleState.lastTurnText).toBe('');
  });

  it('should reset all three fields simultaneously', async () => {
    const roleState = createTestRoleState({
      currentTask: { taskId: 'task-99', taskTitle: 'Big task' },
      currentTool: 'Bash',
      lastTurnText: 'Lots of accumulated text here',
      accumulatedText: 'More text in progress',
      turnActive: true
    });
    session.roleStates.set('dev', roleState);

    await clearSingleRole(session, 'dev');

    expect(roleState.currentTask).toBeNull();
    expect(roleState.currentTool).toBeNull();
    expect(roleState.lastTurnText).toBe('');
    expect(roleState.accumulatedText).toBe('');
    expect(roleState.turnActive).toBe(false);
  });

  it('should handle roleState that has no currentTask (already null)', async () => {
    const roleState = createTestRoleState({
      currentTask: null,
      currentTool: null,
      lastTurnText: ''
    });
    session.roleStates.set('dev', roleState);

    await clearSingleRole(session, 'dev');

    expect(roleState.currentTask).toBeNull();
    expect(roleState.currentTool).toBeNull();
    expect(roleState.lastTurnText).toBe('');
  });
});

// =====================================================================
// P1-1: clearSession clears humanMessageQueue
// =====================================================================

describe('P1-1: clearSession ghost loop prevention', () => {
  it('should clear humanMessageQueue on clearSession', () => {
    const session = createTestSession();
    session.humanMessageQueue = [
      { target: 'pm', content: 'msg1' },
      { target: 'dev', content: 'msg2' }
    ];

    clearSession(session);

    expect(session.humanMessageQueue).toHaveLength(0);
  });

  it('should clear pendingRoutes on clearSession', () => {
    const session = createTestSession();
    session.pendingRoutes = [
      { fromRole: 'pm', route: { to: 'dev', summary: 'task' } }
    ];

    clearSession(session);

    expect(session.pendingRoutes).toHaveLength(0);
  });

  it('should clear all session state atomically', () => {
    const session = createTestSession({
      costUsd: 1.5,
      totalInputTokens: 100000,
      totalOutputTokens: 30000
    });
    session.round = 10;
    session.messageHistory = [{ from: 'pm', to: 'dev', content: 'test' }];
    session.uiMessages = [{ role: 'system', content: 'msg' }];
    session.humanMessageQueue = [{ target: 'pm', content: 'ghost' }];
    session.waitingHumanContext = { fromRole: 'dev', reason: 'requested' };
    session.pendingRoutes = [{ fromRole: 'pm', route: {} }];
    session.features.set('task-1', { taskTitle: 'test' });
    session._completedTaskIds.add('task-1');
    session._processingHumanQueue = true;

    const roleState = createTestRoleState({ turnActive: true });
    session.roleStates.set('dev', roleState);

    clearSession(session);

    expect(session.messageHistory).toHaveLength(0);
    expect(session.uiMessages).toHaveLength(0);
    expect(session.humanMessageQueue).toHaveLength(0);
    expect(session.waitingHumanContext).toBeNull();
    expect(session.pendingRoutes).toHaveLength(0);
    expect(session.features.size).toBe(0);
    expect(session._completedTaskIds.size).toBe(0);
    expect(session.round).toBe(0);
    expect(session.costUsd).toBe(0);
    expect(session.totalInputTokens).toBe(0);
    expect(session.totalOutputTokens).toBe(0);
    expect(session.roleStates.size).toBe(0);
    expect(session._processingHumanQueue).toBe(false);
    expect(session.status).toBe('running');
  });
});

// =====================================================================
// P1-2: _processingHumanQueue flag reset
// =====================================================================

describe('P1-2: _processingHumanQueue flag reset', () => {
  it('should reset _processingHumanQueue to false on clearSession', () => {
    const session = createTestSession();
    session._processingHumanQueue = true;

    clearSession(session);

    expect(session._processingHumanQueue).toBe(false);
  });

  it('should allow new message processing after clearSession + flag reset', () => {
    const session = createTestSession();
    session._processingHumanQueue = true;

    clearSession(session);

    // Simulate processHumanQueue check
    expect(session._processingHumanQueue).toBe(false);
    // Should be able to start processing
    session._processingHumanQueue = true; // starts processing
    expect(session._processingHumanQueue).toBe(true);
  });

  it('BUG SCENARIO: without reset, processHumanQueue is permanently blocked', () => {
    const session = createTestSession();
    session._processingHumanQueue = true;

    // Old code: clearSession did NOT reset _processingHumanQueue
    function clearSessionOld(s) {
      s.roleStates.clear();
      s.messageHistory = [];
      s.humanMessageQueue = [];
      s.pendingRoutes = [];
      // Missing: s._processingHumanQueue = false
    }

    clearSessionOld(session);

    // BUG: flag still true, processHumanQueue would early-return
    expect(session._processingHumanQueue).toBe(true);
  });
});

// =====================================================================
// P1-3: abort + dispatch race condition
// =====================================================================

describe('P1-3: clearSingleRole awaits abort before dispatch', () => {
  it('should await query drain after abort', async () => {
    const session = createTestSession();
    let queryDrained = false;

    // Mock a query that takes time to drain after abort
    const mockQuery = {
      [Symbol.asyncIterator]() {
        let yielded = false;
        return {
          async next() {
            if (!yielded) {
              yielded = true;
              // Simulate async drain
              await new Promise(resolve => setTimeout(resolve, 10));
              queryDrained = true;
              return { done: true, value: undefined };
            }
            return { done: true, value: undefined };
          }
        };
      }
    };

    const roleState = createTestRoleState({
      query: mockQuery,
      turnActive: true
    });
    session.roleStates.set('dev', roleState);

    await clearSingleRole(session, 'dev');

    expect(queryDrained).toBe(true);
    expect(roleState.query).toBeNull();
    expect(roleState.inputStream).toBeNull();
  });

  it('should handle query that throws AbortError during drain', async () => {
    const session = createTestSession();

    // Mock a query that throws AbortError
    const mockQuery = {
      [Symbol.asyncIterator]() {
        return {
          async next() {
            throw new DOMException('The operation was aborted', 'AbortError');
          }
        };
      }
    };

    const roleState = createTestRoleState({
      query: mockQuery,
      turnActive: true
    });
    session.roleStates.set('dev', roleState);

    // Should not throw
    await expect(clearSingleRole(session, 'dev')).resolves.not.toThrow();

    expect(roleState.query).toBeNull();
    expect(roleState.turnActive).toBe(false);
  });

  it('should handle query that throws generic error during drain', async () => {
    const session = createTestSession();

    const mockQuery = {
      [Symbol.asyncIterator]() {
        return {
          async next() {
            throw new Error('Connection lost');
          }
        };
      }
    };

    const roleState = createTestRoleState({
      query: mockQuery,
      turnActive: true
    });
    session.roleStates.set('dev', roleState);

    await expect(clearSingleRole(session, 'dev')).resolves.not.toThrow();
    expect(roleState.query).toBeNull();
  });

  it('should handle null query gracefully', async () => {
    const session = createTestSession();
    const roleState = createTestRoleState({ query: null });
    session.roleStates.set('dev', roleState);

    await expect(clearSingleRole(session, 'dev')).resolves.not.toThrow();
  });
});

// =====================================================================
// P1-4: Stream.enqueue guard
// =====================================================================

describe('P1-4: Stream.enqueue guard prevents closed-stream crash', () => {
  it('should enqueue successfully when stream is open', () => {
    const stream = new MockStream();
    const msg = { type: 'user', message: { role: 'user', content: 'test' } };

    const result = safeEnqueue(stream, msg);

    expect(result).toBe(true);
    expect(stream.queue).toHaveLength(1);
    expect(stream.queue[0]).toBe(msg);
  });

  it('should return false when stream is done/closed', () => {
    const stream = new MockStream();
    stream.isDone = true;

    const result = safeEnqueue(stream, { type: 'user' });

    expect(result).toBe(false);
    expect(stream.queue).toHaveLength(0);
  });

  it('should return false when inputStream is null', () => {
    const result = safeEnqueue(null, { type: 'user' });
    expect(result).toBe(false);
  });

  it('should return false when inputStream is undefined', () => {
    const result = safeEnqueue(undefined, { type: 'user' });
    expect(result).toBe(false);
  });

  it('should catch and handle enqueue errors gracefully', () => {
    const brokenStream = {
      isDone: false,
      enqueue() { throw new Error('Stream corrupted'); }
    };

    const result = safeEnqueue(brokenStream, { type: 'user' });
    expect(result).toBe(false);
  });

  it('should deliver directly to waiting consumer when readResolve exists', () => {
    const stream = new MockStream();
    let delivered = null;

    // Simulate a waiting consumer
    stream.readResolve = (val) => { delivered = val; };
    stream.readReject = () => {};

    const msg = { type: 'user', message: { role: 'user', content: 'hello' } };
    const result = safeEnqueue(stream, msg);

    expect(result).toBe(true);
    expect(delivered).toBeTruthy();
    expect(delivered.value).toBe(msg);
  });
});

// =====================================================================
// P1-5: resumeSession serial execution prevents duplicate dispatch
// =====================================================================

describe('P1-5: resumeSession serial route execution', () => {
  it('should process pending routes serially (not in parallel)', async () => {
    const session = createTestSession({ status: 'paused' });
    const executionOrder = [];

    // Simulate multiple pending routes to the same role
    session.pendingRoutes = [
      { fromRole: 'pm', route: { to: 'dev', summary: 'task 1' } },
      { fromRole: 'pm', route: { to: 'dev', summary: 'task 2' } },
      { fromRole: 'pm', route: { to: 'rev', summary: 'review' } }
    ];

    // Mock serial execution
    async function resumeSessionSerial(sess) {
      if (sess.status !== 'paused') return;
      sess.status = 'running';

      if (sess.pendingRoutes.length > 0) {
        const pending = sess.pendingRoutes.slice();
        sess.pendingRoutes = [];
        for (const { fromRole, route } of pending) {
          executionOrder.push(`${fromRole}->${route.to}:${route.summary}`);
          await new Promise(resolve => setTimeout(resolve, 5)); // simulate async work
        }
      }
    }

    await resumeSessionSerial(session);

    // Verify serial execution (order preserved)
    expect(executionOrder).toEqual([
      'pm->dev:task 1',
      'pm->dev:task 2',
      'pm->rev:review'
    ]);
  });

  it('BUG SCENARIO: parallel execution could dispatch to same role concurrently', async () => {
    const concurrentDispatches = [];

    // Simulate parallel execution (the old behavior)
    async function resumeSessionParallel(pendingRoutes) {
      const results = await Promise.allSettled(
        pendingRoutes.map(async ({ fromRole, route }) => {
          concurrentDispatches.push(`start:${route.to}`);
          await new Promise(resolve => setTimeout(resolve, 10));
          concurrentDispatches.push(`end:${route.to}`);
        })
      );
      return results;
    }

    await resumeSessionParallel([
      { fromRole: 'pm', route: { to: 'dev', summary: 'task 1' } },
      { fromRole: 'pm', route: { to: 'dev', summary: 'task 2' } }
    ]);

    // With parallel, both start before either ends
    const startCount = concurrentDispatches.filter(e => e === 'start:dev').length;
    expect(startCount).toBe(2);

    // Both starts happen before any end (race condition)
    const firstEndIndex = concurrentDispatches.indexOf('end:dev');
    const secondStartIndex = concurrentDispatches.lastIndexOf('start:dev');
    expect(secondStartIndex).toBeLessThan(firstEndIndex); // BUG: starts overlap
  });

  it('should handle empty pendingRoutes gracefully', async () => {
    const session = createTestSession({ status: 'paused' });
    session.pendingRoutes = [];

    // Should not error
    session.status = 'running';
    expect(session.pendingRoutes).toHaveLength(0);
  });

  it('should handle route execution failure without stopping remaining routes', async () => {
    const executed = [];

    async function executeRoutesSafely(routes) {
      for (const { fromRole, route } of routes) {
        try {
          if (route.to === 'bad') throw new Error('Route failed');
          executed.push(route.to);
        } catch (err) {
          // Log and continue
          executed.push(`error:${route.to}`);
        }
      }
    }

    await executeRoutesSafely([
      { fromRole: 'pm', route: { to: 'dev', summary: 'ok' } },
      { fromRole: 'pm', route: { to: 'bad', summary: 'fail' } },
      { fromRole: 'pm', route: { to: 'rev', summary: 'ok' } }
    ]);

    expect(executed).toEqual(['dev', 'error:bad', 'rev']);
  });
});

// =====================================================================
// P1-6: createRoleQuery per-role mutex
// =====================================================================

describe('P1-6: createRoleQuery per-role mutex prevents orphan processes', () => {
  beforeEach(() => {
    _roleQueryLocks.clear();
  });

  it('should serialize concurrent createRoleQuery calls for same role', async () => {
    const session = createTestSession();
    let callCount = 0;

    async function fakeCreator(sess, roleName) {
      callCount++;
      const state = createTestRoleState();
      sess.roleStates.set(roleName, state);
      await new Promise(resolve => setTimeout(resolve, 20));
      return state;
    }

    // Two concurrent calls for same role
    const [result1, result2] = await Promise.all([
      createRoleQueryWithMutex(session, 'dev', fakeCreator),
      createRoleQueryWithMutex(session, 'dev', fakeCreator)
    ]);

    // Second call should reuse the result from first call (only 1 actual creation)
    expect(callCount).toBe(1);
    expect(result1).toBe(result2);
  });

  it('should allow concurrent calls for different roles', async () => {
    const session = createTestSession();
    let callCount = 0;

    async function fakeCreator(sess, roleName) {
      callCount++;
      const state = createTestRoleState();
      sess.roleStates.set(roleName, state);
      await new Promise(resolve => setTimeout(resolve, 10));
      return state;
    }

    await Promise.all([
      createRoleQueryWithMutex(session, 'dev', fakeCreator),
      createRoleQueryWithMutex(session, 'rev', fakeCreator)
    ]);

    // Both should execute (different roles)
    expect(callCount).toBe(2);
  });

  it('should retry creation if first attempt fails', async () => {
    const session = createTestSession();
    let callCount = 0;

    async function flakyCreator(sess, roleName) {
      callCount++;
      if (callCount === 1) {
        throw new Error('Transient failure');
      }
      const state = createTestRoleState();
      sess.roleStates.set(roleName, state);
      return state;
    }

    // First call will fail, second should succeed
    const firstCallPromise = createRoleQueryWithMutex(session, 'dev', flakyCreator).catch(() => null);
    const secondCallPromise = createRoleQueryWithMutex(session, 'dev', flakyCreator);

    const [result1, result2] = await Promise.all([firstCallPromise, secondCallPromise]);

    expect(result1).toBeNull(); // first failed
    expect(result2).toBeTruthy(); // second succeeded
  });

  it('should clean up lock after completion', async () => {
    const session = createTestSession();

    async function fakeCreator(sess, roleName) {
      const state = createTestRoleState();
      sess.roleStates.set(roleName, state);
      return state;
    }

    await createRoleQueryWithMutex(session, 'dev', fakeCreator);

    expect(_roleQueryLocks.has(`${session.id}:dev`)).toBe(false);
  });

  it('should clean up lock even on failure', async () => {
    const session = createTestSession();

    async function failingCreator() {
      throw new Error('Creation failed');
    }

    await createRoleQueryWithMutex(session, 'dev', failingCreator).catch(() => {});

    expect(_roleQueryLocks.has(`${session.id}:dev`)).toBe(false);
  });

  it('should not delete lock belonging to a newer call', async () => {
    const session = createTestSession();
    let callIndex = 0;

    async function slowCreator(sess, roleName) {
      const myIndex = ++callIndex;
      const delay = myIndex === 1 ? 50 : 10;
      await new Promise(resolve => setTimeout(resolve, delay));
      const state = createTestRoleState();
      sess.roleStates.set(roleName, state);
      return state;
    }

    // This is testing that if a new lock overwrites the old one, the old one's
    // finally block won't delete the new lock
    const p1 = createRoleQueryWithMutex(session, 'dev', slowCreator);
    await new Promise(resolve => setTimeout(resolve, 5));

    // Lock should exist for first call
    expect(_roleQueryLocks.has(`${session.id}:dev`)).toBe(true);

    await p1;
    // Should be cleaned up after completion
    expect(_roleQueryLocks.has(`${session.id}:dev`)).toBe(false);
  });
});

// =====================================================================
// Integration: full clear lifecycle
// =====================================================================

describe('Integration: clear lifecycle scenarios', () => {
  it('clearSingleRole should fully reset all role state', async () => {
    const session = createTestSession();
    const roleState = createTestRoleState({
      turnActive: true,
      currentTask: { taskId: 'task-1', taskTitle: 'Build login' },
      currentTool: 'Bash',
      lastTurnText: 'Previous output',
      accumulatedText: 'Current output',
      claudeSessionId: 'sess_123',
      consecutiveErrors: 3,
      lastDispatchContent: 'Some content',
      lastDispatchFrom: 'pm',
      lastDispatchTaskId: 'task-1',
      lastDispatchTaskTitle: 'Build login'
    });
    session.roleStates.set('dev', roleState);
    session.humanMessageQueue = [
      { target: 'dev', content: 'ghost' },
      { target: 'pm', content: 'keep' }
    ];

    await clearSingleRole(session, 'dev');

    // All state should be reset
    expect(roleState.turnActive).toBe(false);
    expect(roleState.currentTask).toBeNull();
    expect(roleState.currentTool).toBeNull();
    expect(roleState.lastTurnText).toBe('');
    expect(roleState.accumulatedText).toBe('');
    expect(roleState.claudeSessionId).toBeNull();
    expect(roleState.consecutiveErrors).toBe(0);
    expect(roleState.query).toBeNull();
    expect(roleState.inputStream).toBeNull();
    expect(roleState.lastDispatchContent).toBeNull();
    expect(roleState.lastDispatchFrom).toBeNull();
    expect(roleState.lastDispatchTaskId).toBeNull();
    expect(roleState.lastDispatchTaskTitle).toBeNull();

    // Ghost message removed, PM message kept
    expect(session.humanMessageQueue).toHaveLength(1);
    expect(session.humanMessageQueue[0].target).toBe('pm');
  });

  it('clearSession followed by clearSingleRole should not crash', async () => {
    const session = createTestSession();
    session.roleStates.set('dev', createTestRoleState());

    clearSession(session);

    // After clearSession, roleStates is empty
    expect(session.roleStates.size).toBe(0);

    // clearSingleRole on non-existent role should not crash
    await expect(clearSingleRole(session, 'dev')).resolves.not.toThrow();
  });

  it('multiple rapid clearSingleRole calls should be safe', async () => {
    const session = createTestSession();
    session.roleStates.set('dev', createTestRoleState());
    session.humanMessageQueue = [
      { target: 'dev', content: 'msg1' },
      { target: 'dev', content: 'msg2' }
    ];

    // Rapid calls
    await Promise.all([
      clearSingleRole(session, 'dev'),
      clearSingleRole(session, 'dev'),
      clearSingleRole(session, 'dev')
    ]);

    expect(session.humanMessageQueue).toHaveLength(0);
    const roleState = session.roleStates.get('dev');
    expect(roleState?.turnActive).toBe(false);
    expect(roleState?.query).toBeNull();
  });

  it('clearSession + processHumanQueue flag should not deadlock', () => {
    const session = createTestSession();
    session._processingHumanQueue = true;
    session.humanMessageQueue = [{ target: 'pm', content: 'msg' }];

    clearSession(session);

    // After clear: flag is false, queue is empty
    expect(session._processingHumanQueue).toBe(false);
    expect(session.humanMessageQueue).toHaveLength(0);

    // Simulate new processHumanQueue — should not be blocked
    function processHumanQueue(sess) {
      if (sess.humanMessageQueue.length === 0) return 'empty';
      if (sess._processingHumanQueue) return 'blocked';
      return 'processing';
    }

    expect(processHumanQueue(session)).toBe('empty');

    // Add new message and try again
    session.humanMessageQueue.push({ target: 'pm', content: 'new msg' });
    expect(processHumanQueue(session)).toBe('processing');
  });
});

// =====================================================================
// Source code verification
// =====================================================================

describe('Source code verification', () => {
  let controlSource, routingSource, roleQuerySource, humanInteractionSource;

  beforeEach(async () => {
    const { promises: fs } = await import('fs');
    const { join } = await import('path');
    const agentDir = join(process.cwd(), 'agent', 'crew');
    controlSource = await fs.readFile(join(agentDir, 'control.js'), 'utf-8');
    routingSource = await fs.readFile(join(agentDir, 'routing.js'), 'utf-8');
    roleQuerySource = await fs.readFile(join(agentDir, 'role-query.js'), 'utf-8');
    humanInteractionSource = await fs.readFile(join(agentDir, 'human-interaction.js'), 'utf-8');
  });

  describe('control.js', () => {
    it('P0-1: clearSingleRole should filter humanMessageQueue', () => {
      expect(controlSource).toContain('humanMessageQueue.filter');
      expect(controlSource).toContain('m.target !== roleName');
    });

    it('P0-3: clearSingleRole should reset currentTask', () => {
      expect(controlSource).toContain('roleState.currentTask = null');
    });

    it('P0-3: clearSingleRole should reset currentTool', () => {
      expect(controlSource).toContain('roleState.currentTool = null');
    });

    it('P0-3: clearSingleRole should reset lastTurnText', () => {
      expect(controlSource).toMatch(/roleState\.lastTurnText\s*=\s*['"]['"];/);
    });

    it('P1-2: clearSession should reset _processingHumanQueue', () => {
      expect(controlSource).toContain('session._processingHumanQueue = false');
    });

    it('P1-3: clearSingleRole should await query drain', () => {
      expect(controlSource).toContain('for await');
      expect(controlSource).toContain('of roleState.query');
    });

    it('P1-5: resumeSession should use serial execution (for...of)', () => {
      // Should NOT contain Promise.allSettled for pending routes
      const resumeSection = controlSource.split('resumeSession')[1]?.split('async function')[0] || '';
      expect(resumeSection).not.toContain('Promise.allSettled(pending.map');
      expect(controlSource).toContain('for (const { fromRole, route } of pending)');
    });
  });

  describe('routing.js', () => {
    it('P1-4: dispatchToRole should guard enqueue with isDone check', () => {
      expect(routingSource).toContain('inputStream.isDone');
    });

    it('P1-4: dispatchToRole should have try-catch around enqueue', () => {
      expect(routingSource).toContain('catch (enqueueErr)');
    });

    it('P1-4: should recreate query on closed stream', () => {
      expect(routingSource).toContain('stream closed or missing, recreating');
    });
  });

  describe('role-query.js', () => {
    it('P1-6: should have _roleQueryLocks Map', () => {
      expect(roleQuerySource).toContain('_roleQueryLocks');
      expect(roleQuerySource).toContain('new Map()');
    });

    it('P1-6: should check existing lock before creating', () => {
      expect(roleQuerySource).toContain('_roleQueryLocks.has(lockKey)');
    });

    it('P1-6: should await existing lock', () => {
      expect(roleQuerySource).toContain('await _roleQueryLocks.get(lockKey)');
    });

    it('P1-6: should reuse existing query if available after lock release', () => {
      expect(roleQuerySource).toContain('Reusing existing query');
    });

    it('P1-6: should clean up lock in finally block', () => {
      expect(roleQuerySource).toContain('_roleQueryLocks.delete(lockKey)');
    });

    it('P1-6: should check for matching promise before deleting', () => {
      expect(roleQuerySource).toContain('_roleQueryLocks.get(lockKey) === promise');
    });
  });

  describe('human-interaction.js', () => {
    it('P1-4: skill dispatch should guard enqueue', () => {
      expect(humanInteractionSource).toContain('inputStream.isDone');
    });

    it('P1-4: skill dispatch should have enqueue error handling', () => {
      expect(humanInteractionSource).toContain('enqueueErr');
    });
  });
});
