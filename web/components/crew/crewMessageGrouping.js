/**
 * crewMessageGrouping.js — 消息分组纯逻辑
 * featureBlocks 增量缓存、_buildTurns、分段管理
 */

/**
 * Build turns from a list of messages.
 * Groups consecutive messages from the same role into a single turn,
 * separates human messages and system/error messages as standalone entries.
 */
export function buildTurns(messages) {
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
          type: 'turn',
          role: msg.role,
          roleName: msg.roleName,
          roleIcon: msg.roleIcon,
          messages: [msg],
          textMsg: null,
          toolMsgs: [],
          routeMsgs: [],
          imageMsgs: [],
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
        type: 'turn',
        role: msg.role,
        roleName: msg.roleName,
        roleIcon: msg.roleIcon,
        messages: [msg],
        textMsg: null,
        toolMsgs: [],
        routeMsgs: [],
        imageMsgs: [],
        id: 'turn_' + (turnCounter++)
      };
    }
  }
  flushTurn();
  return turns;
}

/**
 * Incrementally append new messages (from startIdx) to cached segments.
 * Feature segments are merged by taskId (using segIndex Map for O(1) lookup),
 * so parallel role outputs for the same feature go into one segment/block.
 * Segments stay in first-appearance order — no repositioning.
 * Global segments are always appended at the end.
 */
export function appendToSegments(allMessages, startIdx, cache) {
  // Segments stay in first-appearance order — no repositioning
  const segments = cache.segments;
  const segIndex = cache._segIndex || (cache._segIndex = new Map());

  for (let i = startIdx; i < allMessages.length; i++) {
    const msg = allMessages[i];
    const taskId = msg.taskId || null;
    const isGlobal = !taskId || msg.role === 'human' || msg.isDecisionMaker;

    if (isGlobal) {
      const lastSeg = segments.length > 0 ? segments[segments.length - 1] : null;
      if (lastSeg && !lastSeg.taskId) {
        lastSeg.messages.push(msg);
        lastSeg._dirty = true;
      } else {
        segments.push({ taskId: null, messages: [msg], _dirty: true });
      }
      // Decision maker messages with taskId also go into their feature segment
      if (msg.isDecisionMaker && taskId) {
        if (segIndex.has(taskId)) {
          const seg = segments[segIndex.get(taskId)];
          seg.messages.push(msg);
          seg._dirty = true;
        } else {
          const idx = segments.length;
          segments.push({ taskId, messages: [msg], _dirty: true });
          segIndex.set(taskId, idx);
        }
      }
    } else {
      if (segIndex.has(taskId)) {
        const seg = segments[segIndex.get(taskId)];
        seg.messages.push(msg);
        seg._dirty = true;
      } else {
        const idx = segments.length;
        segments.push({ taskId, messages: [msg], _dirty: true });
        segIndex.set(taskId, idx);
      }
    }
  }

  cache.processedLen = allMessages.length;
}

/**
 * Rebuild blocks array from segments.
 * Reuses cached turns for clean segments; rebuilds dirty ones.
 * Segments with streaming messages always rebuild turns for freshness.
 */
export function rebuildBlocksFromSegments(cache, completed) {
  const segments = cache.segments;
  const blocks = [];

  for (let si = 0; si < segments.length; si++) {
    const seg = segments[si];
    const hasStreaming = seg.messages.some(m => m._streaming);

    if (seg.taskId) {
      const taskTitle = seg.messages.find(m => m.taskTitle)?.taskTitle || seg.taskId;
      const isCompleted = completed.has(seg.taskId);
      const hasPendingAsk = seg.messages.some(m =>
        m.type === 'tool' && m.toolName === 'AskUserQuestion' && !m.askAnswered
      );
      const activeRoles = [];
      const seenRoles = new Set();
      for (let i = seg.messages.length - 1; i >= 0; i--) {
        const m = seg.messages[i];
        if (m._streaming && m.role && !seenRoles.has(m.role)) {
          seenRoles.add(m.role);
          activeRoles.push({ role: m.role, roleName: m.roleName, roleIcon: m.roleIcon });
        }
      }

      const canDefer = isCompleted && !hasStreaming && !hasPendingAsk;
      let turns;
      if (canDefer && seg._turnsCache && !seg._dirty) {
        turns = seg._turnsCache;
      } else if (canDefer && !seg._turnsCache && !seg._dirty) {
        turns = null;  // defer building
      } else {
        turns = buildTurns(seg.messages);
        seg._turnsCache = turns;
        seg._dirty = false;
      }

      blocks.push({
        type: 'feature',
        taskId: seg.taskId,
        taskTitle,
        turns,
        _segIndex: si,
        isCompleted,
        hasStreaming,
        activeRoles,
        hasPendingAsk,
        lastActivityAt: seg.messages[seg.messages.length - 1]?.timestamp || 0,
        id: 'feature_' + seg.taskId + '_' + si
      });
    } else {
      const needsRebuild = seg._dirty || !seg._turnsCache || hasStreaming;
      let turns;
      if (needsRebuild) {
        turns = buildTurns(seg.messages);
        seg._turnsCache = turns;
        seg._dirty = false;
      } else {
        turns = seg._turnsCache;
      }
      blocks.push({
        type: 'global',
        turns,
        id: 'global_' + si
      });
    }
  }

  cache.blocks = blocks;
}

/**
 * Create a fresh empty cache object.
 */
export function createFbCache(arrRef) {
  return {
    segments: [],
    blocks: [],
    processedLen: 0,
    blockCounter: 0,
    turnsCache: new Map(),
    _lastArr: arrRef || null,
    _segIndex: new Map()
  };
}

/**
 * Full rebuild of feature blocks from all messages.
 */
export function fullBuildFeatureBlocks(allMessages, completed, cache) {
  cache.segments = [];
  cache.blockCounter = 0;
  cache.turnsCache.clear();
  cache._segIndex = new Map();
  appendToSegments(allMessages, 0, cache);
  rebuildBlocksFromSegments(cache, completed);
  return cache.blocks;
}

/**
 * Get turns for a block, building lazily if deferred.
 */
export function getBlockTurns(block, fbCache) {
  if (block.turns !== null) return block.turns;
  if (fbCache && block._segIndex != null) {
    const seg = fbCache.segments[block._segIndex];
    if (seg) {
      if (!seg._turnsCache) {
        seg._turnsCache = buildTurns(seg.messages);
        seg._dirty = false;
      }
      block.turns = seg._turnsCache;
      return block.turns;
    }
  }
  return [];
}

export function shouldShowTurnDivider(turns, tidx) {
  const prev = turns[tidx - 1];
  const curr = turns[tidx];
  const prevRole = prev.type === 'turn' ? prev.role : prev.message?.role;
  const currRole = curr.type === 'turn' ? curr.role : curr.message?.role;
  return prevRole && currRole && prevRole !== currRole;
}

export function getMaxRound(turn) {
  if (!turn.routeMsgs || turn.routeMsgs.length === 0) return 0;
  let max = 0;
  for (const rm of turn.routeMsgs) {
    if (rm.round > max) max = rm.round;
  }
  return max;
}
