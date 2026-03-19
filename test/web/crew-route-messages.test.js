import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

/**
 * Tests for Feature panel route message handling.
 *
 * Verification points:
 * 1) Route messages end streaming (client-side handler aligns with agent)
 * 2) Restore mapping includes round field for route messages
 * 3) History loaded mapping includes round field
 * 4) Agent persists round in route uiMessages
 * 5) getLatestMessageSummary falls back to route-only turns
 * 6) buildTurns correctly processes route messages from non-DM roles
 */

let crewSource;
let featurePanelSource;
let agentUiSource;
let groupingSource;

beforeAll(() => {
  crewSource = readFileSync(
    resolve(__dirname, '../../web/stores/helpers/crew.js'), 'utf-8'
  );
  featurePanelSource = readFileSync(
    resolve(__dirname, '../../web/components/crew/CrewFeaturePanel.js'), 'utf-8'
  );
  agentUiSource = readFileSync(
    resolve(__dirname, '../../agent/crew/ui-messages.js'), 'utf-8'
  );
  groupingSource = readFileSync(
    resolve(__dirname, '../../web/components/crew/crewMessageGrouping.js'), 'utf-8'
  );
});

// =====================================================================
// 1. Route handler ends streaming (like tool_use does)
// =====================================================================
describe('route handler ends streaming', () => {
  it('client route handler clears _streaming before pushing route message', () => {
    // Find the route handler block
    const routeIdx = crewSource.indexOf("if (msg.outputType === 'route')");
    expect(routeIdx).toBeGreaterThan(-1);
    // Get the code between route handler start and 'return;'
    const routeBlock = crewSource.substring(routeIdx, crewSource.indexOf('return;', routeIdx) + 7);
    // Must clear _streaming (same pattern as tool_use handler)
    expect(routeBlock).toContain('_streaming = false');
    expect(routeBlock).toContain("messages[i].role === msg.role");
  });
});

// =====================================================================
// 2. Restore mapping includes round field
// =====================================================================
describe('restore mapping includes round', () => {
  it('crew_session_restored mapping includes round from persisted message', () => {
    const restoreIdx = crewSource.indexOf("crew_session_restored");
    expect(restoreIdx).toBeGreaterThan(-1);
    // Find the uiMessages.map section after crew_session_restored
    const mapIdx = crewSource.indexOf('msg.uiMessages.map', restoreIdx);
    expect(mapIdx).toBeGreaterThan(-1);
    const mapBlock = crewSource.substring(mapIdx, crewSource.indexOf('});', mapIdx + 200) + 3);
    expect(mapBlock).toContain('round: m.round || 0');
  });

  it('crew_history_loaded mapping includes round', () => {
    const historyIdx = crewSource.indexOf('crew_history_loaded');
    expect(historyIdx).toBeGreaterThan(-1);
    const mapIdx = crewSource.indexOf('msg.messages.map', historyIdx);
    expect(mapIdx).toBeGreaterThan(-1);
    const mapBlock = crewSource.substring(mapIdx, crewSource.indexOf('});', mapIdx + 200) + 3);
    expect(mapBlock).toContain('round: m.round || 0');
  });
});

// =====================================================================
// 3. Agent persists round in route messages
// =====================================================================
describe('agent persists round in route uiMessages', () => {
  it('agent route handler stores session.round', () => {
    const routeIdx = agentUiSource.indexOf("outputType === 'route'");
    expect(routeIdx).toBeGreaterThan(-1);
    const pushIdx = agentUiSource.indexOf('session.uiMessages.push', routeIdx);
    expect(pushIdx).toBeGreaterThan(-1);
    const pushBlock = agentUiSource.substring(pushIdx, agentUiSource.indexOf('});', pushIdx) + 3);
    expect(pushBlock).toContain('round: session.round');
  });
});

// =====================================================================
// 4. getLatestMessageSummary includes route-only turns
// =====================================================================
describe('getLatestMessageSummary handles route-only turns', () => {
  it('method checks for route-only turns as fallback', () => {
    expect(featurePanelSource).toContain('turn.routeMsgs && turn.routeMsgs.length > 0');
  });

  it('route summary shows arrow + target + summary text', () => {
    expect(featurePanelSource).toContain("text: `→ ${this.getRoleDisplayName(rm.routeTo)}");
  });
});

// =====================================================================
// 5. appendToSegments correctly classifies non-DM route messages
// =====================================================================
describe('appendToSegments classifies non-DM messages correctly', () => {
  it('isGlobal check uses isDecisionMaker flag', () => {
    expect(groupingSource).toContain('msg.isDecisionMaker');
  });

  it('non-global messages go to feature segment by taskId', () => {
    expect(groupingSource).toContain('segIndex.has(taskId)');
  });

  it('decision maker messages get dual-entry (global + feature)', () => {
    expect(groupingSource).toContain('msg.isDecisionMaker && taskId');
  });
});

// =====================================================================
// 6. buildTurns handles route messages correctly
// =====================================================================
describe('buildTurns route handling', () => {
  it('route messages join same-role current turn', () => {
    expect(groupingSource).toContain("msg.type === 'route'");
    expect(groupingSource).toContain('currentTurn.role === msg.role');
  });

  it('flushTurn extracts routeMsgs from turn messages', () => {
    expect(groupingSource).toContain("currentTurn.routeMsgs = currentTurn.messages.filter(m => m.type === 'route')");
  });
});
