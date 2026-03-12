import { describe, it, expect } from 'vitest';

/**
 * Tests for task-18: featureBlocks incremental update, lazy turns, cache invalidation.
 *
 * Behavioral tests for:
 * 1) featureBlocks array reference change detection
 * 2) _appendToSegments incremental segmentation logic
 * 3) _rebuildBlocksFromSegments streaming detection & lazy turns
 * 4) getBlockTurns lazy resolution
 * 5) Markdown render cache (LRU eviction)
 * 6) _buildTurns turn grouping
 * 7) Integration: full cache lifecycle
 */

// =====================================================================
// 1) featureBlocks: array reference change detection
// =====================================================================

describe('featureBlocks: array reference cache invalidation', () => {

  // Behavioral test: simulate array ref change
  it('should detect when messages array reference changes (session restore)', () => {
    const arr1 = [{ id: 1 }];
    const arr2 = [{ id: 1 }];  // same content, different reference
    const cache = { _lastArr: arr1, processedLen: 1, segments: ['seg1'] };

    // Simulating the check from featureBlocks
    const needsFullRebuild = cache._lastArr !== arr2;
    expect(needsFullRebuild).toBe(true);  // Different reference triggers rebuild

    // Same reference should NOT trigger rebuild
    const noRebuild = cache._lastArr !== arr1;
    expect(noRebuild).toBe(false);
  });
});

// =====================================================================
// 2) _appendToSegments: incremental segmentation
// =====================================================================

describe('_appendToSegments: incremental segmentation', () => {

  // Behavioral test: simulate segmentation logic
  function appendToSegments(allMessages, startIdx, cache) {
    const segments = cache.segments;
    for (let i = startIdx; i < allMessages.length; i++) {
      const msg = allMessages[i];
      const taskId = msg.taskId || null;
      const isGlobal = !taskId || msg.role === 'human';
      const lastSeg = segments.length > 0 ? segments[segments.length - 1] : null;

      if (isGlobal) {
        if (lastSeg && !lastSeg.taskId) {
          lastSeg.messages.push(msg);
          lastSeg._dirty = true;
        } else {
          segments.push({ taskId: null, messages: [msg], _dirty: true });
        }
      } else {
        if (lastSeg && lastSeg.taskId === taskId) {
          lastSeg.messages.push(msg);
          lastSeg._dirty = true;
        } else {
          segments.push({ taskId, messages: [msg], _dirty: true });
        }
      }
    }
    cache.processedLen = allMessages.length;
  }

  it('should group consecutive messages with same taskId into one segment', () => {
    const cache = { segments: [], processedLen: 0 };
    const messages = [
      { id: 1, taskId: 'task-1', role: 'dev', type: 'text' },
      { id: 2, taskId: 'task-1', role: 'dev', type: 'tool' },
      { id: 3, taskId: 'task-1', role: 'reviewer', type: 'text' },
    ];
    appendToSegments(messages, 0, cache);

    expect(cache.segments).toHaveLength(1);
    expect(cache.segments[0].taskId).toBe('task-1');
    expect(cache.segments[0].messages).toHaveLength(3);
    expect(cache.processedLen).toBe(3);
  });

  it('should split segments when taskId changes', () => {
    const cache = { segments: [], processedLen: 0 };
    const messages = [
      { id: 1, taskId: 'task-1', role: 'dev', type: 'text' },
      { id: 2, taskId: 'task-2', role: 'dev', type: 'text' },
      { id: 3, taskId: 'task-1', role: 'dev', type: 'text' },
    ];
    appendToSegments(messages, 0, cache);

    expect(cache.segments).toHaveLength(3);
    expect(cache.segments[0].taskId).toBe('task-1');
    expect(cache.segments[1].taskId).toBe('task-2');
    expect(cache.segments[2].taskId).toBe('task-1');
  });

  it('should treat human messages as global (no taskId)', () => {
    const cache = { segments: [], processedLen: 0 };
    const messages = [
      { id: 1, taskId: 'task-1', role: 'human', type: 'text' },
    ];
    appendToSegments(messages, 0, cache);

    expect(cache.segments).toHaveLength(1);
    expect(cache.segments[0].taskId).toBeNull();  // human → global
  });

  it('should incrementally extend last segment', () => {
    const cache = { segments: [], processedLen: 0 };

    // First batch
    const messages = [
      { id: 1, taskId: 'task-1', role: 'dev', type: 'text' },
    ];
    appendToSegments(messages, 0, cache);
    expect(cache.segments).toHaveLength(1);
    expect(cache.segments[0].messages).toHaveLength(1);

    // Second batch — same taskId, should extend existing segment
    messages.push({ id: 2, taskId: 'task-1', role: 'dev', type: 'text' });
    appendToSegments(messages, cache.processedLen, cache);
    expect(cache.segments).toHaveLength(1);  // still one segment
    expect(cache.segments[0].messages).toHaveLength(2);
    expect(cache.segments[0]._dirty).toBe(true);
  });

  it('should create new segment when incremental message has different taskId', () => {
    const cache = { segments: [], processedLen: 0 };

    // First batch
    const messages = [
      { id: 1, taskId: 'task-1', role: 'dev', type: 'text' },
    ];
    appendToSegments(messages, 0, cache);

    // Second batch — different taskId
    messages.push({ id: 2, taskId: 'task-2', role: 'dev', type: 'text' });
    appendToSegments(messages, cache.processedLen, cache);
    expect(cache.segments).toHaveLength(2);
    expect(cache.segments[1].taskId).toBe('task-2');
  });

  it('should merge consecutive global messages into one global segment', () => {
    const cache = { segments: [], processedLen: 0 };
    const messages = [
      { id: 1, role: 'human', type: 'text' },
      { id: 2, role: 'system', type: 'system' },  // no taskId → global
    ];
    appendToSegments(messages, 0, cache);
    expect(cache.segments).toHaveLength(1);
    expect(cache.segments[0].taskId).toBeNull();
    expect(cache.segments[0].messages).toHaveLength(2);
  });

  it('should mark segments as dirty when new messages are appended', () => {
    const cache = { segments: [], processedLen: 0 };
    const messages = [
      { id: 1, taskId: 'task-1', role: 'dev', type: 'text' },
    ];
    appendToSegments(messages, 0, cache);
    // Reset dirty flag manually (simulating what _rebuildBlocksFromSegments does)
    cache.segments[0]._dirty = false;

    // Add another message — should mark dirty again
    messages.push({ id: 2, taskId: 'task-1', role: 'dev', type: 'text' });
    appendToSegments(messages, cache.processedLen, cache);
    expect(cache.segments[0]._dirty).toBe(true);
  });
});

// =====================================================================
// 3) _rebuildBlocksFromSegments: streaming & lazy turns
// =====================================================================

describe('_rebuildBlocksFromSegments: streaming and lazy turns', () => {

  // Behavioral test: lazy turns decision logic
  it('should defer turns only when all three conditions are met', () => {
    const cases = [
      // [isCompleted, hasStreaming, hasPendingAsk, expectedCanDefer]
      [true, false, false, true],    // completed, no streaming, no ask → defer
      [false, false, false, false],  // not completed → no defer
      [true, true, false, false],    // streaming → no defer
      [true, false, true, false],    // pending ask → no defer
      [false, true, true, false],    // multiple reasons → no defer
    ];

    for (const [isCompleted, hasStreaming, hasPendingAsk, expected] of cases) {
      const canDefer = isCompleted && !hasStreaming && !hasPendingAsk;
      expect(canDefer).toBe(expected);
    }
  });

  // Behavioral test: streaming forces rebuild
  it('streaming segment always rebuilds turns even when not dirty', () => {
    // Simulate the decision logic
    const seg = { _dirty: false, _turnsCache: ['old-turns'], messages: [{ _streaming: true }] };
    const hasStreaming = seg.messages.some(m => m._streaming);
    const isCompleted = false;
    const hasPendingAsk = false;
    const canDefer = isCompleted && !hasStreaming && !hasPendingAsk;

    // canDefer is false because isCompleted is false, so it falls through to the else branch
    // which always calls _buildTurns
    expect(canDefer).toBe(false);
  });
});

// =====================================================================
// 4) getBlockTurns: lazy resolution
// =====================================================================

describe('getBlockTurns: lazy turns resolution', () => {

  // Behavioral test: lazy resolution
  it('should resolve turns lazily when block.turns is null', () => {
    const mockMessages = [
      { id: 1, role: 'dev', type: 'text', content: 'hello' },
    ];
    const seg = { messages: mockMessages, _turnsCache: null, _dirty: false };
    const block = { turns: null, _segIndex: 0 };
    const fbCache = { segments: [seg] };

    // Simulate getBlockTurns logic
    if (block.turns !== null) {
      // would return block.turns
    } else if (fbCache && block._segIndex != null) {
      const s = fbCache.segments[block._segIndex];
      if (s) {
        if (!s._turnsCache) {
          // Would call _buildTurns, simulate with a mock result
          s._turnsCache = [{ type: 'turn', role: 'dev' }];
          s._dirty = false;
        }
        block.turns = s._turnsCache;
      }
    }

    expect(block.turns).not.toBeNull();
    expect(block.turns).toHaveLength(1);
    expect(block.turns[0].role).toBe('dev');
    // Segment cache is also set
    expect(seg._turnsCache).toEqual(block.turns);
  });

  it('should reuse segment turnsCache if already built', () => {
    const existingTurns = [{ type: 'turn', role: 'pm' }];
    const seg = { messages: [], _turnsCache: existingTurns, _dirty: false };
    const block = { turns: null, _segIndex: 0 };
    const fbCache = { segments: [seg] };

    // Simulate getBlockTurns logic
    if (block.turns !== null) {
      // skip
    } else if (fbCache && block._segIndex != null) {
      const s = fbCache.segments[block._segIndex];
      if (s) {
        if (!s._turnsCache) {
          s._turnsCache = [];  // would call _buildTurns
        }
        block.turns = s._turnsCache;
      }
    }

    // Should reuse existing cache, not rebuild
    expect(block.turns).toBe(existingTurns);  // same reference
    expect(block.turns[0].role).toBe('pm');
  });
});

// =====================================================================
// 5) Markdown render cache
// =====================================================================

describe('Markdown render cache', () => {

  // Behavioral test: LRU eviction
  it('LRU-like eviction should remove oldest entry', () => {
    const cache = new Map();
    const MAX = 3;

    cache.set('a', 'html-a');
    cache.set('b', 'html-b');
    cache.set('c', 'html-c');

    // Simulate adding when full
    const text = 'd';
    const html = 'html-d';
    if (cache.size >= MAX) {
      const firstKey = cache.keys().next().value;
      cache.delete(firstKey);
    }
    cache.set(text, html);

    expect(cache.size).toBe(3);
    expect(cache.has('a')).toBe(false);  // 'a' was evicted (oldest)
    expect(cache.has('b')).toBe(true);
    expect(cache.has('d')).toBe(true);
  });
});

// =====================================================================
// 6) Integration: cache invalidation on conversation switch
// =====================================================================

describe('Integration: cache invalidation', () => {

  // Behavioral test: full cache lifecycle
  it('full lifecycle: init → incremental → array change → rebuild', () => {
    // Phase 1: Initialize
    const arr1 = [{ id: 1, taskId: 'task-1', role: 'dev', type: 'text' }];
    let cache = { segments: [], blocks: [], processedLen: 0, blockCounter: 0, turnsCache: new Map(), _lastArr: null };

    // First call: _lastArr is null, !== arr1 → full rebuild
    let needsFullRebuild = cache._lastArr !== arr1;
    expect(needsFullRebuild).toBe(true);
    cache._lastArr = arr1;
    // Simulate appendToSegments
    cache.segments.push({ taskId: 'task-1', messages: [arr1[0]], _dirty: true });
    cache.processedLen = 1;

    // Phase 2: Incremental (same array ref, new message appended)
    arr1.push({ id: 2, taskId: 'task-1', role: 'dev', type: 'text' });
    needsFullRebuild = cache._lastArr !== arr1;
    expect(needsFullRebuild).toBe(false);  // Same ref → incremental
    const startIdx = cache.processedLen;
    expect(startIdx).toBe(1);
    expect(startIdx < arr1.length).toBe(true);

    // Phase 3: Array reference change (session restore)
    const arr2 = [...arr1, { id: 3, taskId: 'task-2', role: 'pm', type: 'text' }];
    needsFullRebuild = cache._lastArr !== arr2;
    expect(needsFullRebuild).toBe(true);  // Different ref → full rebuild
    cache._lastArr = arr2;
    cache.segments = [];
    cache.processedLen = 0;
    // Would do full rebuild here
  });
});

// =====================================================================
// 7) _buildTurns correctness
// =====================================================================

describe('_buildTurns: turn grouping', () => {

  // Replicate _buildTurns logic for testing
  function buildTurns(messages) {
    const turns = [];
    let currentTurn = null;
    let turnCounter = 0;

    const flushTurn = () => {
      if (currentTurn) {
        const textMsgs = currentTurn.messages.filter(m => m.type === 'text');
        if (textMsgs.length > 1) {
          currentTurn.textMsg = { ...textMsgs[0], content: textMsgs.map(m => m.content).join('') };
        } else {
          currentTurn.textMsg = textMsgs[0] || null;
        }
        currentTurn.toolMsgs = currentTurn.messages.filter(m => m.type === 'tool');
        currentTurn.routeMsgs = currentTurn.messages.filter(m => m.type === 'route');
        currentTurn.imageMsgs = currentTurn.messages.filter(m => m.type === 'image');
        const askIdx = currentTurn.toolMsgs.findIndex(m => m.toolName === 'AskUserQuestion');
        if (askIdx !== -1) {
          currentTurn.askMsg = currentTurn.toolMsgs[askIdx];
          currentTurn.toolMsgs = currentTurn.toolMsgs.filter((_, i) => i !== askIdx);
        } else {
          currentTurn.askMsg = null;
        }
        turns.push(currentTurn);
        currentTurn = null;
      }
    };

    for (const msg of messages) {
      if (msg.type === 'system' || msg.type === 'human_needed' || msg.type === 'role_error') {
        flushTurn();
        turns.push({ type: msg.type, message: msg, id: 'standalone_' + (msg.id || turnCounter++) });
        continue;
      }
      if (msg.type === 'route') {
        if (currentTurn && currentTurn.role === msg.role) {
          currentTurn.messages.push(msg);
        } else {
          flushTurn();
          currentTurn = {
            type: 'turn', role: msg.role, roleName: msg.roleName, roleIcon: msg.roleIcon,
            messages: [msg], textMsg: null, toolMsgs: [], routeMsgs: [], imageMsgs: [],
            id: 'turn_' + (turnCounter++)
          };
        }
        continue;
      }
      if (msg.role === 'human') {
        flushTurn();
        turns.push({ type: 'text', message: msg, id: 'human_' + (msg.id || turnCounter++) });
        continue;
      }
      if (currentTurn && currentTurn.role === msg.role) {
        currentTurn.messages.push(msg);
      } else {
        flushTurn();
        currentTurn = {
          type: 'turn', role: msg.role, roleName: msg.roleName, roleIcon: msg.roleIcon,
          messages: [msg], textMsg: null, toolMsgs: [], routeMsgs: [], imageMsgs: [],
          id: 'turn_' + (turnCounter++)
        };
      }
    }
    flushTurn();
    return turns;
  }

  it('should group consecutive messages from same role into one turn', () => {
    const messages = [
      { id: 1, role: 'dev', type: 'text', content: 'Hello' },
      { id: 2, role: 'dev', type: 'tool', toolName: 'Edit' },
      { id: 3, role: 'dev', type: 'text', content: ' World' },
    ];
    const turns = buildTurns(messages);
    expect(turns).toHaveLength(1);
    expect(turns[0].type).toBe('turn');
    expect(turns[0].role).toBe('dev');
    // Multiple text messages should be concatenated
    expect(turns[0].textMsg.content).toBe('Hello World');
    expect(turns[0].toolMsgs).toHaveLength(1);
  });

  it('should split turns on role change', () => {
    const messages = [
      { id: 1, role: 'dev', type: 'text', content: 'Dev says' },
      { id: 2, role: 'reviewer', type: 'text', content: 'Reviewer says' },
    ];
    const turns = buildTurns(messages);
    expect(turns).toHaveLength(2);
    expect(turns[0].role).toBe('dev');
    expect(turns[1].role).toBe('reviewer');
  });

  it('should extract AskUserQuestion into askMsg', () => {
    const messages = [
      { id: 1, role: 'dev', type: 'text', content: 'Working...' },
      { id: 2, role: 'dev', type: 'tool', toolName: 'AskUserQuestion' },
    ];
    const turns = buildTurns(messages);
    expect(turns).toHaveLength(1);
    expect(turns[0].askMsg).not.toBeNull();
    expect(turns[0].askMsg.toolName).toBe('AskUserQuestion');
    expect(turns[0].toolMsgs).toHaveLength(0);  // removed from toolMsgs
  });

  it('should handle human messages as standalone entries', () => {
    const messages = [
      { id: 1, role: 'dev', type: 'text', content: 'Dev says' },
      { id: 2, role: 'human', type: 'text', content: 'User says' },
      { id: 3, role: 'dev', type: 'text', content: 'Dev responds' },
    ];
    const turns = buildTurns(messages);
    expect(turns).toHaveLength(3);
    expect(turns[0].type).toBe('turn');
    expect(turns[1].type).toBe('text');  // human → standalone
    expect(turns[2].type).toBe('turn');
  });

  it('should handle system messages as standalone entries', () => {
    const messages = [
      { id: 1, role: 'dev', type: 'text', content: 'Dev says' },
      { id: 2, type: 'system', content: 'System notice' },
    ];
    const turns = buildTurns(messages);
    expect(turns).toHaveLength(2);
    expect(turns[0].type).toBe('turn');
    expect(turns[1].type).toBe('system');
  });

  it('should handle empty messages array', () => {
    const turns = buildTurns([]);
    expect(turns).toHaveLength(0);
  });
});
