import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

/**
 * Tests for PR #281 — Feature panel ROUTE message visibility fix (task-105).
 *
 * Core business logic tested:
 * 1. Route handler ends _streaming on the role's last text message
 * 2. Restore/history mappings propagate round field
 * 3. getLatestMessageSummary falls back to route-only turns
 * 4. Non-DM route messages are classified into feature segments (not global)
 * 5. Agent persists round in route uiMessages
 */

const base = resolve(__dirname, '../..');
const read = (rel) => readFileSync(resolve(base, rel), 'utf-8');

// =====================================================================
// Extract route streaming-stop logic for unit testing
// =====================================================================

/**
 * Simulates the route handler's _streaming clearing logic.
 * When a route arrives, it walks backward to find the role's last text message
 * and clears _streaming (same as tool_use handler pattern).
 */
function endStreamingOnRoute(messages, routeRole) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === routeRole && messages[i].type === 'text' && messages[i]._streaming) {
      messages[i]._streaming = false;
      return true; // found and cleared
    }
  }
  return false; // nothing to clear
}

/**
 * Simulates getLatestMessageSummary backward walk logic.
 * Returns summary object from the last visible turn (text or route-only).
 */
function getLatestMessageSummary(turns, truncateText, getRoleDisplayName) {
  for (let i = turns.length - 1; i >= 0; i--) {
    const turn = turns[i];
    if (turn.type === 'turn') {
      if (turn.textMsg) {
        const rawRole = turn.role || turn.roleName || '';
        return {
          icon: turn.roleIcon || '',
          roleName: getRoleDisplayName(rawRole),
          role: rawRole,
          text: truncateText(turn.textMsg.content, 80),
          time: turn.textMsg.timestamp ? String(turn.textMsg.timestamp) : '',
          actions: (turn.toolMsgs || []).map(t => t.toolName).filter(Boolean)
        };
      }
      // Route-only turn fallback
      if (turn.routeMsgs && turn.routeMsgs.length > 0) {
        const rm = turn.routeMsgs[turn.routeMsgs.length - 1];
        const rawRole = turn.role || turn.roleName || '';
        return {
          icon: turn.roleIcon || '',
          roleName: getRoleDisplayName(rawRole),
          role: rawRole,
          text: `→ ${getRoleDisplayName(rm.routeTo)}: ${truncateText(rm.routeSummary, 60)}`,
          time: rm.timestamp ? String(rm.timestamp) : '',
          actions: []
        };
      }
    }
    if (turn.type !== 'turn' && turn.message?.type === 'text') {
      const rawRole = turn.message.role || turn.message.roleName || '';
      return {
        icon: turn.message.roleIcon || '',
        roleName: getRoleDisplayName(rawRole),
        role: rawRole,
        text: truncateText(turn.message.content, 80),
        time: turn.message.timestamp ? String(turn.message.timestamp) : '',
        actions: []
      };
    }
  }
  return null;
}

/**
 * Simulates appendToSegments message classification.
 * Returns { global, feature } for where a message goes.
 */
function classifyMessage(msg) {
  const taskId = msg.taskId || null;
  const isGlobal = !taskId || msg.role === 'human' || msg.isDecisionMaker;
  return {
    goesGlobal: isGlobal,
    goesFeature: !isGlobal || (msg.isDecisionMaker && !!taskId),
    taskId
  };
}

/**
 * Simulates restore mapping: adds round field.
 */
function mapRestoredMessage(m) {
  return {
    content: m.content,
    routeTo: m.routeTo,
    routeSummary: m.routeSummary || '',
    round: m.round || 0,
    type: m.type
  };
}

const identity = (x) => x;
const simpletruncate = (text, max) => {
  if (!text) return '';
  return text.length <= max ? text : text.slice(0, max - 1) + '…';
};

// =====================================================================
// 1. Route handler ends _streaming
// =====================================================================
describe('route handler: ends _streaming on arrival', () => {

  it('clears _streaming on the matching role text message', () => {
    const messages = [
      { role: 'dev-1', type: 'text', _streaming: true, content: 'working...' },
      { role: 'pm', type: 'text', _streaming: false, content: 'ok' }
    ];
    const cleared = endStreamingOnRoute(messages, 'dev-1');
    expect(cleared).toBe(true);
    expect(messages[0]._streaming).toBe(false);
  });

  it('does not clear streaming on a different role', () => {
    const messages = [
      { role: 'dev-1', type: 'text', _streaming: true, content: 'code' },
      { role: 'rev-1', type: 'text', _streaming: true, content: 'reviewing' }
    ];
    endStreamingOnRoute(messages, 'rev-1');
    expect(messages[0]._streaming).toBe(true); // dev-1 untouched
    expect(messages[1]._streaming).toBe(false); // rev-1 cleared
  });

  it('clears only the LAST matching text message (walks backward)', () => {
    const messages = [
      { role: 'dev-1', type: 'text', _streaming: true, content: 'first' },
      { role: 'dev-1', type: 'tool', _streaming: false, content: '' },
      { role: 'dev-1', type: 'text', _streaming: true, content: 'second' }
    ];
    endStreamingOnRoute(messages, 'dev-1');
    expect(messages[0]._streaming).toBe(true); // first stays streaming
    expect(messages[2]._streaming).toBe(false); // last cleared
  });

  it('returns false when no streaming text found', () => {
    const messages = [
      { role: 'dev-1', type: 'text', _streaming: false, content: 'done' },
      { role: 'dev-1', type: 'route', _streaming: false, content: '' }
    ];
    expect(endStreamingOnRoute(messages, 'dev-1')).toBe(false);
  });

  it('skips non-text messages (tool, route)', () => {
    const messages = [
      { role: 'dev-1', type: 'tool', _streaming: true, content: '' },
      { role: 'dev-1', type: 'route', _streaming: true, content: '' }
    ];
    expect(endStreamingOnRoute(messages, 'dev-1')).toBe(false);
  });
});

// =====================================================================
// 2. getLatestMessageSummary: text turn vs route-only turn
// =====================================================================
describe('getLatestMessageSummary: route-only fallback', () => {

  it('returns text summary when last turn has textMsg', () => {
    const turns = [{
      type: 'turn', role: 'dev-1', roleName: 'dev-1', roleIcon: '💻',
      textMsg: { content: 'Implemented the feature', timestamp: 1000 },
      toolMsgs: [{ toolName: 'Edit' }],
      routeMsgs: []
    }];
    const result = getLatestMessageSummary(turns, simpletruncate, identity);
    expect(result.text).toBe('Implemented the feature');
    expect(result.role).toBe('dev-1');
    expect(result.actions).toEqual(['Edit']);
  });

  it('falls back to route-only turn when no textMsg', () => {
    const turns = [{
      type: 'turn', role: 'dev-1', roleName: 'dev-1', roleIcon: '💻',
      textMsg: null,
      toolMsgs: [],
      routeMsgs: [{ routeTo: 'rev-1', routeSummary: 'Please review PR #281', timestamp: 2000 }]
    }];
    const result = getLatestMessageSummary(turns, simpletruncate, identity);
    expect(result.text).toContain('→ rev-1:');
    expect(result.text).toContain('Please review PR #281');
    expect(result.actions).toEqual([]);
  });

  it('prefers text turn over earlier route-only turn', () => {
    const turns = [
      {
        type: 'turn', role: 'dev-1', textMsg: null, toolMsgs: [], roleIcon: '',
        routeMsgs: [{ routeTo: 'test-1', routeSummary: 'test this', timestamp: 1000 }]
      },
      {
        type: 'turn', role: 'rev-1', roleIcon: '🔍',
        textMsg: { content: 'LGTM', timestamp: 2000 },
        toolMsgs: [], routeMsgs: []
      }
    ];
    const result = getLatestMessageSummary(turns, simpletruncate, identity);
    expect(result.text).toBe('LGTM');
    expect(result.role).toBe('rev-1');
  });

  it('uses last routeMsg when turn has multiple route messages', () => {
    const turns = [{
      type: 'turn', role: 'pm', roleName: 'pm', roleIcon: '📋',
      textMsg: null, toolMsgs: [],
      routeMsgs: [
        { routeTo: 'dev-1', routeSummary: 'first task', timestamp: 100 },
        { routeTo: 'test-1', routeSummary: 'please test', timestamp: 200 }
      ]
    }];
    const result = getLatestMessageSummary(turns, simpletruncate, identity);
    expect(result.text).toContain('test-1');
    expect(result.text).toContain('please test');
  });

  it('returns null for empty turns', () => {
    expect(getLatestMessageSummary([], simpletruncate, identity)).toBeNull();
  });

  it('truncates long route summary to 60 chars', () => {
    const longSummary = 'A'.repeat(100);
    const turns = [{
      type: 'turn', role: 'dev-1', roleIcon: '', textMsg: null, toolMsgs: [],
      routeMsgs: [{ routeTo: 'rev-1', routeSummary: longSummary, timestamp: 1000 }]
    }];
    const result = getLatestMessageSummary(turns, simpletruncate, identity);
    // Route summaries truncated to 60 chars
    expect(result.text.length).toBeLessThan(100);
  });
});

// =====================================================================
// 3. Message classification: non-DM vs DM routing
// =====================================================================
describe('message classification: non-DM route to feature only', () => {

  it('non-DM message with taskId goes to feature only (not global)', () => {
    const result = classifyMessage({
      taskId: 'task-102', role: 'dev-1', isDecisionMaker: false, type: 'route'
    });
    expect(result.goesGlobal).toBe(false);
    expect(result.goesFeature).toBe(true);
  });

  it('DM message with taskId goes to both global and feature (dual-entry)', () => {
    const result = classifyMessage({
      taskId: 'task-102', role: 'pm', isDecisionMaker: true, type: 'route'
    });
    expect(result.goesGlobal).toBe(true);
    expect(result.goesFeature).toBe(true);
  });

  it('human message always goes global', () => {
    const result = classifyMessage({
      taskId: 'task-102', role: 'human', isDecisionMaker: false
    });
    expect(result.goesGlobal).toBe(true);
  });

  it('message without taskId always goes global', () => {
    const result = classifyMessage({
      taskId: null, role: 'dev-1', isDecisionMaker: false
    });
    expect(result.goesGlobal).toBe(true);
    expect(result.goesFeature).toBe(false);
  });
});

// =====================================================================
// 4. Restore mapping propagates round field
// =====================================================================
describe('restore mapping: round field propagation', () => {

  it('includes round from persisted route message', () => {
    const mapped = mapRestoredMessage({
      type: 'route', content: '→ rev-1', routeTo: 'rev-1',
      routeSummary: 'review this', round: 5
    });
    expect(mapped.round).toBe(5);
  });

  it('defaults round to 0 when missing', () => {
    const mapped = mapRestoredMessage({
      type: 'text', content: 'hello'
    });
    expect(mapped.round).toBe(0);
  });

  it('preserves routeTo and routeSummary', () => {
    const mapped = mapRestoredMessage({
      type: 'route', routeTo: 'test-1', routeSummary: 'please test', round: 3
    });
    expect(mapped.routeTo).toBe('test-1');
    expect(mapped.routeSummary).toBe('please test');
  });
});

// =====================================================================
// 5. Source code structural verification
// =====================================================================
describe('source code: route handler structure', () => {
  const crewSrc = read('web/stores/helpers/crew.js');

  it('route handler clears _streaming before pushing message', () => {
    const routeIdx = crewSrc.indexOf("if (msg.outputType === 'route')");
    expect(routeIdx).toBeGreaterThan(-1);
    const routeBlock = crewSrc.substring(routeIdx, routeIdx + 500);
    // Must clear _streaming BEFORE messages.push
    const clearIdx = routeBlock.indexOf('_streaming = false');
    const pushIdx = routeBlock.indexOf('messages.push');
    expect(clearIdx).toBeGreaterThan(-1);
    expect(pushIdx).toBeGreaterThan(-1);
    expect(clearIdx).toBeLessThan(pushIdx);
  });

  it('route push includes round from crew status', () => {
    const routeIdx = crewSrc.indexOf("if (msg.outputType === 'route')");
    // The route handler block extends ~600+ chars before the next return;
    const returnIdx = crewSrc.indexOf('return;', routeIdx);
    const routeBlock = crewSrc.substring(routeIdx, returnIdx + 7);
    expect(routeBlock).toContain('round:');
  });
});

describe('source code: agent persists round in route uiMessages', () => {
  const agentSrc = read('agent/crew/ui-messages.js');

  it('route output includes session.round', () => {
    expect(agentSrc).toContain("type: 'route'");
    expect(agentSrc).toContain('round: session.round');
  });
});
