import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

/**
 * Tests for Active Messages — single latest text message.
 *
 * Verifies business logic:
 * 1) activeMessages computed: reverse scan, returns single latest text message
 * 2) Filters by type and role (skip non-text, skip system)
 * 3) Hidden when all tasks completed
 * 4) Behavioral verification with replicated logic
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

  it('returns array with single message via return [m]', () => {
    const body = extractComputedBody('activeMessages');
    expect(body).toContain('return [m]');
  });

  it('returns empty array when no text messages', () => {
    const body = extractComputedBody('activeMessages');
    expect(body).toContain('return []');
  });

  it('reads from store.currentCrewMessages', () => {
    const body = extractComputedBody('activeMessages');
    expect(body).toContain('this.store.currentCrewMessages');
  });
});

// =====================================================================
// 2. Reverse scan algorithm
// =====================================================================
describe('reverse scan for latest message', () => {
  it('scans messages in reverse order', () => {
    const body = extractComputedBody('activeMessages');
    expect(body).toMatch(/for\s*\(\s*let\s+i\s*=\s*messages\.length\s*-\s*1;\s*i\s*>=\s*0;\s*i--\)/);
  });
});

// =====================================================================
// 3. Hidden when all tasks completed
// =====================================================================
describe('hidden when all tasks completed', () => {
  it('v-if includes hasStreamingMessage or kanbanInProgressCount > 0', () => {
    const vifMatch = jsSource.match(/v-if="activeMessages\.length > 0 && \(hasStreamingMessage \|\| kanbanInProgressCount > 0\)"/);
    expect(vifMatch).not.toBeNull();
  });
});

// =====================================================================
// 4. Behavioral logic — replicated activeMessages
// =====================================================================
describe('activeMessages filtering — behavioral verification', () => {
  function activeMessages(messages) {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.type !== 'text' || !m.role) continue;
      if (m.role === 'system') continue;
      return [m];
    }
    return [];
  }

  it('returns AI message when latest message is from AI role', () => {
    const messages = [
      { type: 'text', role: 'human', content: 'user input' },
      { type: 'text', role: 'dev-1', content: 'AI reply' }
    ];
    const result = activeMessages(messages);
    expect(result).toHaveLength(1);
    expect(result[0].role).toBe('dev-1');
  });

  it('returns human message when it is the latest text message', () => {
    const messages = [
      { type: 'text', role: 'dev-1', content: 'first AI reply' },
      { type: 'text', role: 'pm', content: 'PM reply' },
      { type: 'text', role: 'human', content: 'user just typed this' }
    ];
    const result = activeMessages(messages);
    expect(result).toHaveLength(1);
    expect(result[0].role).toBe('human');
  });

  it('returns empty when only system messages exist', () => {
    const messages = [
      { type: 'text', role: 'system', content: 'system notice' }
    ];
    expect(activeMessages(messages)).toHaveLength(0);
  });

  it('skips non-text messages (tool, route)', () => {
    const messages = [
      { type: 'text', role: 'dev-1', content: 'AI reply' },
      { type: 'tool', role: 'dev-1', content: 'tool call' },
      { type: 'route', role: 'dev-1', content: 'routing' },
      { type: 'text', role: 'human', content: 'user input' }
    ];
    const result = activeMessages(messages);
    expect(result).toHaveLength(1);
    expect(result[0].content).toBe('user input');
  });

  it('returns empty for empty messages array', () => {
    expect(activeMessages([])).toHaveLength(0);
  });
});
