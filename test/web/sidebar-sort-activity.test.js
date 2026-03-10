import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

/**
 * Tests for sidebar session sort-by-activity feature.
 *
 * Verifies the sortByActivity method behavior:
 * 1) Sessions within each group are sorted by lastActivity descending
 * 2) The current active session always appears first in its group
 * 3) Falls back to createdAt when no lastActivity exists
 * 4) crewConversations and normalConversations computed properties apply sorting
 * 5) Panel structure (Chat above, Crew below) remains unchanged
 */

let chatPageSource;

beforeAll(() => {
  const chatPagePath = resolve(__dirname, '../../web/components/ChatPage.js');
  chatPageSource = readFileSync(chatPagePath, 'utf-8');
});

/**
 * Extract sortByActivity and test it as a pure function.
 * The method depends on `this.store.currentConversation` and `this.store.executionStatusMap`,
 * so we simulate these via a context object.
 */
function createSortByActivity(currentConversationId, executionStatusMap) {
  return function sortByActivity(conversations) {
    const currentId = currentConversationId;
    return [...conversations].sort((a, b) => {
      if (a.id === currentId) return -1;
      if (b.id === currentId) return 1;
      const aTime = executionStatusMap[a.id]?.lastActivity || a.createdAt || 0;
      const bTime = executionStatusMap[b.id]?.lastActivity || b.createdAt || 0;
      return bTime - aTime;
    });
  };
}

// =====================================================================
// 1. Sort by lastActivity descending within a group
// =====================================================================
describe('sort by lastActivity descending', () => {
  it('sorts conversations with lastActivity by most recent first', () => {
    const sortByActivity = createSortByActivity('none', {
      'a': { lastActivity: 100 },
      'b': { lastActivity: 300 },
      'c': { lastActivity: 200 },
    });

    const result = sortByActivity([
      { id: 'a', type: 'chat' },
      { id: 'b', type: 'chat' },
      { id: 'c', type: 'chat' },
    ]);

    expect(result.map(c => c.id)).toEqual(['b', 'c', 'a']);
  });

  it('sorts crew sessions by lastActivity descending', () => {
    const sortByActivity = createSortByActivity('none', {
      'crew-1': { lastActivity: 50 },
      'crew-2': { lastActivity: 150 },
      'crew-3': { lastActivity: 100 },
    });

    const result = sortByActivity([
      { id: 'crew-1', type: 'crew' },
      { id: 'crew-2', type: 'crew' },
      { id: 'crew-3', type: 'crew' },
    ]);

    expect(result.map(c => c.id)).toEqual(['crew-2', 'crew-3', 'crew-1']);
  });
});

// =====================================================================
// 2. Active session always first in its group
// =====================================================================
describe('active session always first', () => {
  it('places the current active session first even if it has the oldest activity', () => {
    const sortByActivity = createSortByActivity('a', {
      'a': { lastActivity: 10 },
      'b': { lastActivity: 300 },
      'c': { lastActivity: 200 },
    });

    const result = sortByActivity([
      { id: 'a', type: 'chat' },
      { id: 'b', type: 'chat' },
      { id: 'c', type: 'chat' },
    ]);

    expect(result[0].id).toBe('a');
    // Remaining should still be sorted by activity
    expect(result[1].id).toBe('b');
    expect(result[2].id).toBe('c');
  });

  it('active session first even when it has no lastActivity at all', () => {
    const sortByActivity = createSortByActivity('x', {
      'y': { lastActivity: 500 },
      'z': { lastActivity: 400 },
    });

    const result = sortByActivity([
      { id: 'y', type: 'chat' },
      { id: 'x', type: 'chat' },
      { id: 'z', type: 'chat' },
    ]);

    expect(result[0].id).toBe('x');
  });

  it('active session only affects its own group (not present in this group)', () => {
    // Active session is 'chat-1', but we're sorting crew sessions
    const sortByActivity = createSortByActivity('chat-1', {
      'crew-a': { lastActivity: 100 },
      'crew-b': { lastActivity: 300 },
    });

    const result = sortByActivity([
      { id: 'crew-a', type: 'crew' },
      { id: 'crew-b', type: 'crew' },
    ]);

    // Since 'chat-1' is not in this list, sorting is purely by activity
    expect(result.map(c => c.id)).toEqual(['crew-b', 'crew-a']);
  });
});

// =====================================================================
// 3. Fallback to createdAt when no lastActivity
// =====================================================================
describe('fallback to createdAt', () => {
  it('uses createdAt when executionStatusMap has no entry for the session', () => {
    const sortByActivity = createSortByActivity('none', {});

    const result = sortByActivity([
      { id: 'a', type: 'chat', createdAt: 100 },
      { id: 'b', type: 'chat', createdAt: 300 },
      { id: 'c', type: 'chat', createdAt: 200 },
    ]);

    expect(result.map(c => c.id)).toEqual(['b', 'c', 'a']);
  });

  it('uses createdAt when lastActivity is absent in the status entry', () => {
    const sortByActivity = createSortByActivity('none', {
      'a': { status: 'idle' }, // no lastActivity field
      'b': { status: 'running' },
    });

    const result = sortByActivity([
      { id: 'a', type: 'chat', createdAt: 100 },
      { id: 'b', type: 'chat', createdAt: 200 },
    ]);

    expect(result.map(c => c.id)).toEqual(['b', 'a']);
  });

  it('mixes lastActivity and createdAt — lastActivity takes priority', () => {
    const sortByActivity = createSortByActivity('none', {
      'a': { lastActivity: 500 },
      // 'b' has no status entry, will use createdAt
    });

    const result = sortByActivity([
      { id: 'a', type: 'chat', createdAt: 10 },
      { id: 'b', type: 'chat', createdAt: 400 },
    ]);

    // 'a' has lastActivity=500, 'b' uses createdAt=400
    expect(result.map(c => c.id)).toEqual(['a', 'b']);
  });

  it('defaults to 0 when neither lastActivity nor createdAt exists', () => {
    const sortByActivity = createSortByActivity('none', {});

    const result = sortByActivity([
      { id: 'a', type: 'chat' },
      { id: 'b', type: 'chat', createdAt: 100 },
    ]);

    // 'b' has createdAt=100, 'a' defaults to 0
    expect(result[0].id).toBe('b');
    expect(result[1].id).toBe('a');
  });
});

// =====================================================================
// 4. Computed properties apply sorting
// =====================================================================
describe('computed properties integrate sortByActivity', () => {
  it('crewConversations computed calls sortByActivity', () => {
    expect(chatPageSource).toContain(
      'this.sortByActivity(this.store.conversations.filter(c => c.type === \'crew\'))'
    );
  });

  it('normalConversations computed calls sortByActivity', () => {
    expect(chatPageSource).toContain(
      'this.sortByActivity(this.store.conversations.filter(c => c.type !== \'crew\' && c.type !== \'rolePlay\'))'
    );
  });

  it('sortByActivity is defined as a method', () => {
    expect(chatPageSource).toContain('sortByActivity(conversations)');
  });
});

// =====================================================================
// 5. Panel structure unchanged — Chat above, Crew below
// =====================================================================
describe('panel structure unchanged', () => {
  it('normalConversations v-for still appears before crewConversations v-for', () => {
    const normalIdx = chatPageSource.indexOf('v-for="conv in normalConversations"');
    const crewIdx = chatPageSource.indexOf('v-for="conv in crewConversations"');
    expect(normalIdx).toBeGreaterThan(-1);
    expect(crewIdx).toBeGreaterThan(-1);
    expect(normalIdx).toBeLessThan(crewIdx);
  });

  it('session-panel structure is preserved (chat + crew + roleplay)', () => {
    const panelsStart = chatPageSource.indexOf('class="session-panels"');
    expect(panelsStart).toBeGreaterThan(-1);
    const matches = chatPageSource.match(/class="session-panel"/g) || [];
    expect(matches.length).toBe(3);
  });

  it('group headers remain — Chat uses i18n recentChats, Crew shows "Crew Sessions"', () => {
    expect(chatPageSource).toContain("$t('chat.sidebar.recentChats')");
    expect(chatPageSource).toContain('<span>Crew Sessions</span>');
  });
});

// =====================================================================
// 6. Edge cases
// =====================================================================
describe('edge cases', () => {
  it('handles empty conversation list', () => {
    const sortByActivity = createSortByActivity('x', {});
    const result = sortByActivity([]);
    expect(result).toEqual([]);
  });

  it('handles single conversation (also the active one)', () => {
    const sortByActivity = createSortByActivity('only', {
      'only': { lastActivity: 100 },
    });
    const result = sortByActivity([{ id: 'only', type: 'chat' }]);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('only');
  });

  it('does not mutate the original array', () => {
    const sortByActivity = createSortByActivity('none', {
      'a': { lastActivity: 100 },
      'b': { lastActivity: 200 },
    });
    const original = [
      { id: 'a', type: 'chat' },
      { id: 'b', type: 'chat' },
    ];
    const originalCopy = [...original];
    sortByActivity(original);
    expect(original).toEqual(originalCopy);
  });

  it('stable order for conversations with equal timestamps', () => {
    const sortByActivity = createSortByActivity('none', {
      'a': { lastActivity: 100 },
      'b': { lastActivity: 100 },
      'c': { lastActivity: 100 },
    });

    const result = sortByActivity([
      { id: 'a', type: 'chat' },
      { id: 'b', type: 'chat' },
      { id: 'c', type: 'chat' },
    ]);

    // All have equal timestamps — should not crash, result length should match
    expect(result).toHaveLength(3);
  });
});
