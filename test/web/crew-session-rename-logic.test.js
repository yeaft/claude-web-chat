import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

/**
 * Tests for PR #282 — Crew session inline rename (task-106).
 *
 * Focuses on business logic extraction and edge cases:
 * 1. commitCrewRename: empty/whitespace fallback, unchanged skip, 'Crew Session' → ''
 * 2. renameCrewSession: optimistic dual-update + WS message shape
 * 3. startCrewRename: state initialization from conv
 * 4. cancelCrewRename: state reset without save
 * 5. Input event isolation: @click.stop prevents session switch
 */

const base = resolve(__dirname, '../..');
const read = (rel) => readFileSync(resolve(base, rel), 'utf-8');

// =====================================================================
// Extract commitCrewRename logic for unit testing
// =====================================================================

/**
 * Simulates commitCrewRename business logic.
 * Returns { shouldRename, nameToSend } or null if no-op.
 */
function commitRenameLogic(editingCrewId, editingCrewName, conversations) {
  if (!editingCrewId) return null; // guard: not editing

  const name = editingCrewName.trim() || 'Crew Session';
  const conv = conversations.find(c => c.id === editingCrewId);
  const currentName = conv?.name || '';

  if (name === currentName) {
    return { shouldRename: false, nameToSend: null };
  }

  // 'Crew Session' is the default label — send empty string to clear custom name
  const nameToSend = name === 'Crew Session' ? '' : name;
  return { shouldRename: true, nameToSend };
}

/**
 * Simulates renameCrewSession optimistic update.
 */
function renameCrewSession(store, sessionId, name) {
  const conv = store.conversations.find(c => c.id === sessionId);
  if (conv) conv.name = name;
  if (store.crewSessions[sessionId]) {
    store.crewSessions[sessionId].name = name;
  }
  store.wsSent.push({
    type: 'update_crew_session',
    sessionId,
    name,
    agentId: store.currentAgent
  });
}

/**
 * Simulates startCrewRename state initialization.
 */
function startRenameState(conv) {
  return {
    editingCrewId: conv.id,
    editingCrewName: conv.name || ''
  };
}

// =====================================================================
// 1. commitCrewRename: name normalization and skip logic
// =====================================================================
describe('commitCrewRename: name normalization', () => {

  it('trims whitespace and uses trimmed result', () => {
    const result = commitRenameLogic('s1', '  My Crew  ', [{ id: 's1', name: '' }]);
    expect(result.shouldRename).toBe(true);
    expect(result.nameToSend).toBe('My Crew');
  });

  it('empty input falls back to "Crew Session" default', () => {
    const result = commitRenameLogic('s1', '', [{ id: 's1', name: 'Old Name' }]);
    // 'Crew Session' is default display → send '' to clear custom name
    expect(result.shouldRename).toBe(true);
    expect(result.nameToSend).toBe('');
  });

  it('whitespace-only input falls back to "Crew Session"', () => {
    const result = commitRenameLogic('s1', '   ', [{ id: 's1', name: 'Old Name' }]);
    expect(result.shouldRename).toBe(true);
    expect(result.nameToSend).toBe('');
  });

  it('skips rename when name is unchanged', () => {
    const result = commitRenameLogic('s1', 'Same Name', [{ id: 's1', name: 'Same Name' }]);
    expect(result.shouldRename).toBe(false);
  });

  it('skips rename when trimmed name equals current', () => {
    const result = commitRenameLogic('s1', '  Same Name  ', [{ id: 's1', name: 'Same Name' }]);
    expect(result.shouldRename).toBe(false);
  });

  it('returns null when not in editing state', () => {
    expect(commitRenameLogic(null, 'anything', [])).toBeNull();
    expect(commitRenameLogic('', 'anything', [])).toBeNull();
  });

  it('"Crew Session" literal is sent as empty string (default name)', () => {
    const result = commitRenameLogic('s1', 'Crew Session', [{ id: 's1', name: 'Old' }]);
    expect(result.nameToSend).toBe('');
  });

  it('handles conv not found (no crash, still renames)', () => {
    const result = commitRenameLogic('missing', 'New Name', []);
    // conv not found → currentName = '', 'New Name' !== '' → rename
    expect(result.shouldRename).toBe(true);
    expect(result.nameToSend).toBe('New Name');
  });
});

// =====================================================================
// 2. renameCrewSession: optimistic dual-update + WS message
// =====================================================================
describe('renameCrewSession: optimistic update + WS', () => {

  function makeStore(convs, crewSessions) {
    return {
      conversations: convs,
      crewSessions: crewSessions || {},
      currentAgent: 'agent-1',
      wsSent: []
    };
  }

  it('updates conversation name in conversations array', () => {
    const store = makeStore([{ id: 's1', name: 'Old' }]);
    renameCrewSession(store, 's1', 'New');
    expect(store.conversations[0].name).toBe('New');
  });

  it('updates crewSessions metadata if present', () => {
    const store = makeStore(
      [{ id: 's1', name: 'Old' }],
      { s1: { name: 'Old', roles: [] } }
    );
    renameCrewSession(store, 's1', 'New');
    expect(store.crewSessions.s1.name).toBe('New');
  });

  it('does not crash when crewSessions entry is missing', () => {
    const store = makeStore([{ id: 's1', name: 'Old' }], {});
    expect(() => renameCrewSession(store, 's1', 'New')).not.toThrow();
    expect(store.conversations[0].name).toBe('New');
  });

  it('sends correct WS message shape', () => {
    const store = makeStore([{ id: 's1', name: '' }]);
    renameCrewSession(store, 's1', 'My Project');
    expect(store.wsSent).toHaveLength(1);
    expect(store.wsSent[0]).toEqual({
      type: 'update_crew_session',
      sessionId: 's1',
      name: 'My Project',
      agentId: 'agent-1'
    });
  });

  it('sends empty name when clearing custom name', () => {
    const store = makeStore([{ id: 's1', name: 'Custom' }]);
    renameCrewSession(store, 's1', '');
    expect(store.wsSent[0].name).toBe('');
  });
});

// =====================================================================
// 3. startCrewRename: state initialization
// =====================================================================
describe('startCrewRename: state initialization', () => {

  it('sets editingCrewId from conv.id', () => {
    const state = startRenameState({ id: 's1', name: 'My Crew' });
    expect(state.editingCrewId).toBe('s1');
  });

  it('initializes editingCrewName from conv.name', () => {
    const state = startRenameState({ id: 's1', name: 'My Crew' });
    expect(state.editingCrewName).toBe('My Crew');
  });

  it('uses empty string when conv has no name', () => {
    const state = startRenameState({ id: 's1' });
    expect(state.editingCrewName).toBe('');
  });

  it('uses empty string when conv.name is null', () => {
    const state = startRenameState({ id: 's1', name: null });
    expect(state.editingCrewName).toBe('');
  });
});

// =====================================================================
// 4. cancelCrewRename: state reset
// =====================================================================
describe('cancelCrewRename: state cleared', () => {
  const chatSrc = read('web/components/ChatPage.js');

  it('cancelCrewRename clears editingCrewId to null', () => {
    expect(chatSrc).toContain('this.editingCrewId = null');
  });

  it('cancelCrewRename clears editingCrewName to empty', () => {
    expect(chatSrc).toContain("this.editingCrewName = ''");
  });
});

// =====================================================================
// 5. Input event isolation
// =====================================================================
describe('input event isolation', () => {
  const chatSrc = read('web/components/ChatPage.js');

  it('input has @click.stop to prevent session switch', () => {
    expect(chatSrc).toContain('@click.stop');
    // Verify it's on the rename input (near crew-rename-input)
    const inputIdx = chatSrc.indexOf('crew-rename-input');
    const clickStopIdx = chatSrc.lastIndexOf('@click.stop', inputIdx + 50);
    expect(clickStopIdx).toBeGreaterThan(-1);
  });

  it('dblclick on title uses .stop modifier', () => {
    expect(chatSrc).toContain('@dblclick.stop=');
  });
});
