import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

/**
 * Tests for Active Messages — per-feature latest text messages.
 *
 * Verifies business logic:
 * 1) activeMessages computed: groups by taskId, returns latest text per active feature
 * 2) Filters out system and human roles
 * 3) Respects in-progress feature filtering
 * 4) Limits to 5 messages max
 * 5) Hidden when all tasks completed
 */

let jsSource;

beforeAll(() => {
  const jsPath = resolve(__dirname, '../../web/components/CrewChatView.js');
  jsSource = readFileSync(jsPath, 'utf-8');
});

function extractComputedBody(name) {
  const idx = jsSource.indexOf(`${name}() {`);
  if (idx === -1) return '';
  const braceStart = jsSource.indexOf('{', idx);
  if (braceStart === -1) return '';
  let depth = 0;
  let end = braceStart;
  for (let i = braceStart; i < jsSource.length; i++) {
    if (jsSource[i] === '{') depth++;
    if (jsSource[i] === '}') depth--;
    if (depth === 0) { end = i; break; }
  }
  return jsSource.substring(braceStart + 1, end).trim();
}

// =====================================================================
// 1. activeMessages computed — filtering logic
// =====================================================================
describe('activeMessages computed — filtering logic', () => {
  it('activeMessages method exists', () => {
    const body = extractComputedBody('activeMessages');
    expect(body.length).toBeGreaterThan(0);
  });

  it('filters by m.type !== text (skip non-text)', () => {
    const body = extractComputedBody('activeMessages');
    expect(body).toContain("m.type !== 'text'");
  });

  it('skips system role', () => {
    const body = extractComputedBody('activeMessages');
    expect(body).toContain("m.role === 'system'");
  });

  it('skips human role', () => {
    const body = extractComputedBody('activeMessages');
    expect(body).toContain("m.role === 'human'");
  });

  it('reads from store.currentCrewMessages', () => {
    const body = extractComputedBody('activeMessages');
    expect(body).toContain('this.store.currentCrewMessages');
  });

  it('groups messages by taskId', () => {
    const body = extractComputedBody('activeMessages');
    expect(body).toContain('taskId');
    expect(body).toContain('_global');
  });

  it('limits results to 5', () => {
    const body = extractComputedBody('activeMessages');
    expect(body).toContain('.slice(0, 5)');
  });
});

// =====================================================================
// 2. Hidden when all tasks completed
// =====================================================================
describe('hidden when all tasks completed', () => {
  it('v-if includes hasStreamingMessage or kanbanInProgressCount > 0', () => {
    const vifMatch = jsSource.match(/v-if="activeMessages\.length > 0 && \(hasStreamingMessage \|\| kanbanInProgressCount > 0\)"/);
    expect(vifMatch).not.toBeNull();
  });
});

// =====================================================================
// 3. Behavioral logic — replicated multi-feature activeMessages
// =====================================================================
describe('activeMessages filtering — behavioral verification', () => {
  function activeMessages(messages, inProgressTaskIds = []) {
    const inProgressIds = new Set(inProgressTaskIds);
    const lastByTask = new Map();
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.type !== 'text' || !m.role) continue;
      if (m.role === 'system' || m.role === 'human') continue;
      const key = m.taskId || '_global';
      if (lastByTask.has(key)) continue;
      if (m._streaming || key === '_global' || inProgressIds.has(key)) {
        lastByTask.set(key, m);
      }
    }
    return Array.from(lastByTask.values())
      .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
      .slice(0, 5);
  }

  it('returns latest message per active feature', () => {
    const messages = [
      { type: 'text', role: 'dev-1', taskId: 'task-1', content: 'old', timestamp: 1 },
      { type: 'text', role: 'dev-1', taskId: 'task-1', content: 'newer', timestamp: 2 },
      { type: 'text', role: 'rev-1', taskId: 'task-2', content: 'review', timestamp: 3 },
    ];
    const result = activeMessages(messages, ['task-1', 'task-2']);
    expect(result).toHaveLength(2);
    expect(result[0].content).toBe('review');
    expect(result[1].content).toBe('newer');
  });

  it('includes global (no taskId) latest message', () => {
    const messages = [
      { type: 'text', role: 'pm', content: 'global msg', timestamp: 5 },
      { type: 'text', role: 'dev-1', taskId: 'task-1', content: 'task msg', timestamp: 3 },
    ];
    const result = activeMessages(messages, ['task-1']);
    expect(result).toHaveLength(2);
    expect(result[0].content).toBe('global msg');
  });

  it('excludes completed features (not in inProgress)', () => {
    const messages = [
      { type: 'text', role: 'dev-1', taskId: 'task-done', content: 'done task', timestamp: 1 },
      { type: 'text', role: 'dev-1', taskId: 'task-active', content: 'active task', timestamp: 2 },
    ];
    const result = activeMessages(messages, ['task-active']);
    expect(result).toHaveLength(1);
    expect(result[0].taskId).toBe('task-active');
  });

  it('includes streaming messages regardless of feature status', () => {
    const messages = [
      { type: 'text', role: 'dev-1', taskId: 'task-x', content: 'streaming', timestamp: 1, _streaming: true },
    ];
    const result = activeMessages(messages, []);
    expect(result).toHaveLength(1);
    expect(result[0].content).toBe('streaming');
  });

  it('skips system and human messages', () => {
    const messages = [
      { type: 'text', role: 'system', content: 'notice', timestamp: 3 },
      { type: 'text', role: 'human', content: 'user input', timestamp: 2 },
      { type: 'text', role: 'dev-1', content: 'AI reply', timestamp: 1 },
    ];
    const result = activeMessages(messages, []);
    expect(result).toHaveLength(1);
    expect(result[0].role).toBe('dev-1');
  });

  it('returns empty for empty messages array', () => {
    expect(activeMessages([], [])).toHaveLength(0);
  });

  it('limits to 5 messages max', () => {
    const messages = [];
    for (let i = 0; i < 8; i++) {
      messages.push({ type: 'text', role: 'dev-1', taskId: `task-${i}`, content: `msg ${i}`, timestamp: i });
    }
    const inProgress = messages.map(m => m.taskId);
    const result = activeMessages(messages, inProgress);
    expect(result.length).toBeLessThanOrEqual(5);
  });

  it('sorts by timestamp descending', () => {
    const messages = [
      { type: 'text', role: 'dev-1', taskId: 'task-1', content: 'old', timestamp: 1 },
      { type: 'text', role: 'dev-2', taskId: 'task-2', content: 'new', timestamp: 10 },
    ];
    const result = activeMessages(messages, ['task-1', 'task-2']);
    expect(result[0].timestamp).toBe(10);
    expect(result[1].timestamp).toBe(1);
  });
});
