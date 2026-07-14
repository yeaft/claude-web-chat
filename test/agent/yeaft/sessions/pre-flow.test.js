import { describe, expect, it } from 'vitest';

import {
  buildRelevantScopes,
  memoryScopeLabel,
  runMemoryPreflow,
  selectRespondingVps,
} from '../../../../agent/yeaft/sessions/pre-flow.js';

function fakeIndex(rows) {
  return {
    search({ scopeFilter }) {
      return rows
        .filter(row => scopeFilter.includes(row.scope))
        .map((row, index) => ({
          id: row.id || `seg-${index}`,
          scope: row.scope,
          kind: row.kind || 'context',
          tags: row.tags || [],
          body: row.body,
          sourceMessages: row.sourceMessages || [],
          rank: row.rank ?? 0,
          createdAt: row.createdAt || '2026-06-25T00:00:00.000Z',
          updatedAt: row.updatedAt || '2026-06-25T00:00:00.000Z',
        }));
    },
  };
}

describe('Yeaft VP selection pre-flow', () => {
  const meta = {
    roster: ['vp-linus', 'vp-martin'],
    defaultVpId: 'vp-linus',
  };

  it('falls back to the default VP when every @ token is unknown', () => {
    expect(selectRespondingVps({
      meta,
      fromUser: true,
      mentions: ['example', 'missing-vp'],
    })).toEqual({
      dispatched: ['vp-linus'],
      fallback: 'vp-linus',
      errors: [],
      reason: 'fallback',
    });
  });

  it('routes valid mentions and silently ignores unknown @ tokens', () => {
    expect(selectRespondingVps({
      meta,
      fromUser: true,
      mentions: ['missing-vp', 'vp-martin'],
    })).toEqual({
      dispatched: ['vp-martin'],
      fallback: null,
      errors: [],
      reason: 'mention',
    });
  });

  it('keeps task membership errors for real VP mentions', () => {
    expect(selectRespondingVps({
      meta,
      fromUser: true,
      mentions: ['missing-vp', 'vp-martin'],
      taskMembers: ['vp-linus'],
    })).toEqual({
      dispatched: [],
      fallback: null,
      errors: [{ vpId: 'vp-martin', error: 'not_in_task_members' }],
      reason: 'mention',
    });
  });
});

describe('Yeaft memory pre-flow scopes', () => {
  it('renders compact model-facing labels without changing storage scopes', () => {
    expect(memoryScopeLabel('sessions/s1')).toBe('session');
    expect(memoryScopeLabel('sessions/s1/topic/dream/recall')).toBe('topic: dream/recall');
    expect(memoryScopeLabel('session/s1/topic/storage')).toBe('topic: storage');
    expect(memoryScopeLabel('group/s1/topic/legacy')).toBe('topic: legacy');
    expect(memoryScopeLabel('sessions/s1/vp/linus')).toBe('sessions/s1/vp/linus');
    expect(memoryScopeLabel('user')).toBe('user');
  });

  it('includes current sessions/* Dream scopes plus legacy aliases', () => {
    expect(buildRelevantScopes({
      sessionId: 's1',
      vpId: 'linus',
      extra: ['sessions/s1/topic/dream/recall'],
    })).toEqual([
      'user',
      'sessions/s1',
      'sessions/s1/user',
      'session/s1',
      'session/s1/user',
      'group/s1',
      'group/s1/user',
      'sessions/s1/vp/linus',
      'session/s1/vp/linus',
      'group/s1/vp/linus',
      'sessions/s1/topic/dream/recall',
    ]);
  });

  it('recalls FTS rows written under the current sessions/* Dream path', () => {
    const result = runMemoryPreflow(fakeIndex([
      { scope: 'sessions/s1', body: 'Dream remembers the Sydney project preference.' },
      { scope: 'sessions/s1/vp/linus', body: 'Linus should keep the Dream fix minimal.' },
      { scope: 'sessions/other', body: 'This session must not leak into s1.' },
    ]), {
      sessionId: 's1',
      vpId: 'linus',
      userMsg: 'Sydney Dream minimal project',
      budgetTokens: 1000,
    });

    expect(result.entries.map(entry => entry.scope)).toEqual([
      'sessions/s1',
      'sessions/s1/vp/linus',
    ]);
    expect(result.formatted).toContain('Dream remembers the Sydney project preference.');
    expect(result.formatted).toContain('Linus should keep the Dream fix minimal.');
    expect(result.formatted).not.toContain('This session must not leak into s1.');
  });

  it('filters foreign current sessions/* VP scopes from recall', () => {
    const result = runMemoryPreflow(fakeIndex([
      { scope: 'sessions/s1/vp/linus', body: 'Own VP memory is visible.' },
      { scope: 'sessions/s1/vp/martin', body: 'Foreign VP memory must not leak.' },
    ]), {
      sessionId: 's1',
      vpId: 'linus',
      extraScopes: ['sessions/s1/vp/martin'],
      userMsg: 'VP memory visible leak',
      budgetTokens: 1000,
    });

    expect(result.entries.map(entry => entry.scope)).toEqual(['sessions/s1/vp/linus']);
    expect(result.formatted).toContain('Own VP memory is visible.');
    expect(result.formatted).not.toContain('Foreign VP memory must not leak.');
  });

  it('recalls topic segments when current session topic scopes are supplied', () => {
    const result = runMemoryPreflow(fakeIndex([
      { scope: 'sessions/s1/topic/dream/recall', body: 'Topic memory explains Dream recall wiring.' },
      { scope: 'sessions/s1/topic/storage', body: 'Unrelated supplied topic is still eligible when in scope.' },
      { scope: 'sessions/other/topic/dream/recall', body: 'Foreign topic must not leak.' },
    ]), {
      sessionId: 's1',
      vpId: 'linus',
      extraScopes: ['sessions/s1/topic/dream/recall', 'sessions/s1/topic/storage'],
      userMsg: 'Dream recall topic memory',
      budgetTokens: 1000,
    });

    expect(result.entries.map(entry => entry.scope)).toEqual([
      'sessions/s1/topic/dream/recall',
      'sessions/s1/topic/storage',
    ]);
    expect(result.formatted).toContain('## Memory: Topic dream/recall');
    expect(result.formatted).not.toContain('sessions/s1/topic/dream/recall');
    expect(result.formatted).toContain('Topic memory explains Dream recall wiring.');
    expect(result.formatted).not.toContain('Foreign topic must not leak.');
  });

  it('falls back to bounded recent scoped segments when FTS has no keyword hits', () => {
    const index = {
      search() { return []; },
      listByScope(scope) {
        const rows = {
          'sessions/s1': [
            { id: 'old', scope, body: 'Old session fallback.', updatedAt: '2026-01-01T00:00:00.000Z' },
            { id: 'new', scope, body: 'Newest session fallback.', updatedAt: '2026-02-01T00:00:00.000Z' },
          ],
          'sessions/s1/topic/dream/recall': [
            { id: 'topic-new', scope, body: 'Newest topic fallback.', updatedAt: '2026-03-01T00:00:00.000Z' },
          ],
        };
        return rows[scope] || [];
      },
    };

    const result = runMemoryPreflow(index, {
      sessionId: 's1',
      vpId: 'linus',
      extraScopes: ['sessions/s1/topic/dream/recall'],
      userMsg: 'zzzz no matching keyword',
      budgetTokens: 1000,
      fallbackOnEmpty: true,
      fallbackPerScope: 1,
    });

    expect(result.meta.fallbackUsed).toBe(true);
    expect(result.entries.map(entry => entry.body)).toEqual([
      'Newest topic fallback.',
      'Newest session fallback.',
    ]);
    expect(result.formatted).not.toContain('Old session fallback.');
  });

  it('does not let early oversized scopes starve topic fallback segments', () => {
    const longBody = 'x'.repeat(2000);
    const index = {
      search() { return []; },
      listByScope(scope) {
        const rows = {
          user: [
            { id: 'huge-user', scope, body: longBody, updatedAt: '2026-04-01T00:00:00.000Z' },
          ],
          'sessions/s1': [
            { id: 'huge-session', scope, body: longBody, updatedAt: '2026-04-02T00:00:00.000Z' },
          ],
          'sessions/s1/topic/dream/recall': [
            { id: 'topic-small', scope, body: 'Small topic fallback survives.', updatedAt: '2026-04-03T00:00:00.000Z' },
          ],
        };
        return rows[scope] || [];
      },
    };

    const result = runMemoryPreflow(index, {
      sessionId: 's1',
      vpId: 'linus',
      extraScopes: ['sessions/s1/topic/dream/recall'],
      userMsg: 'no keyword hit here',
      budgetTokens: 20,
      fallbackOnEmpty: true,
      fallbackPerScope: 1,
    });

    expect(result.entries.map(entry => entry.body)).toEqual(['Small topic fallback survives.']);
  });
});
