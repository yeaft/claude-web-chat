import { describe, it, expect } from 'vitest';
import {
  adaptRolePlayMessages,
  splitByRoleSignal,
  extractRouteBlocks,
  isPartialRoleSignal,
  isPartialRouteBlock
} from '../../web/components/crew/rolePlayAdapter.js';
import { buildTurns } from '../../web/components/crew/crewMessageGrouping.js';

// ── splitByRoleSignal ────────────────────────────────────────────────

describe('rolePlayAdapter — splitByRoleSignal', () => {
  it('returns single segment when no role signals', () => {
    const result = splitByRoleSignal('Hello world\nSecond line');
    expect(result).toHaveLength(1);
    expect(result[0].role).toBe(null);
    expect(result[0].content).toContain('Hello world');
    expect(result[0].content).toContain('Second line');
  });

  it('splits text by ---ROLE: xxx--- signals', () => {
    const text = '---ROLE: pm---\nPM says hello\n---ROLE: dev---\nDev implements\n';
    const result = splitByRoleSignal(text);
    expect(result).toHaveLength(2);
    expect(result[0].role).toBe('pm');
    expect(result[0].content).toContain('PM says hello');
    expect(result[1].role).toBe('dev');
    expect(result[1].content).toContain('Dev implements');
  });

  it('ignores role signals inside code blocks', () => {
    const text = '```\n---ROLE: pm---\ncode\n```\nreal content\n';
    const result = splitByRoleSignal(text);
    expect(result).toHaveLength(1);
    expect(result[0].role).toBe(null);
    expect(result[0].content).toContain('---ROLE: pm---');
  });

  it('hides partial role signal during streaming', () => {
    const text = 'Hello\n---RO';
    const result = splitByRoleSignal(text, true);
    expect(result).toHaveLength(1);
    expect(result[0].content).not.toContain('---RO');
  });

  it('keeps partial role signal when not streaming', () => {
    const text = 'Hello\n---RO';
    const result = splitByRoleSignal(text, false);
    expect(result).toHaveLength(1);
    expect(result[0].content).toContain('---RO');
  });

  it('handles content before first role signal', () => {
    const text = 'Intro text\n---ROLE: pm---\nPM content\n';
    const result = splitByRoleSignal(text);
    expect(result).toHaveLength(2);
    expect(result[0].role).toBe(null);
    expect(result[0].content).toContain('Intro text');
    expect(result[1].role).toBe('pm');
  });

  it('returns fallback when text is empty', () => {
    const result = splitByRoleSignal('');
    expect(result).toHaveLength(1);
    expect(result[0].role).toBe(null);
    // Empty string splits to [''] which produces '\n'
  });
});

// ── isPartialRoleSignal ──────────────────────────────────────────────

describe('rolePlayAdapter — isPartialRoleSignal', () => {
  it('detects partial signals', () => {
    expect(isPartialRoleSignal('---R')).toBe(true);
    expect(isPartialRoleSignal('---RO')).toBe(true);
    expect(isPartialRoleSignal('---ROL')).toBe(true);
    expect(isPartialRoleSignal('---ROLE')).toBe(true);
    expect(isPartialRoleSignal('---ROLE:')).toBe(true);
    expect(isPartialRoleSignal('---ROLE: dev')).toBe(true);
  });

  it('rejects non-signals', () => {
    expect(isPartialRoleSignal('Hello')).toBe(false);
    expect(isPartialRoleSignal('-- something')).toBe(false);
  });
});

// ── isPartialRouteBlock ──────────────────────────────────────────────

describe('rolePlayAdapter — isPartialRouteBlock', () => {
  it('detects partial route blocks', () => {
    expect(isPartialRouteBlock('---R')).toBe(true);
    expect(isPartialRouteBlock('---RO')).toBe(true);
    expect(isPartialRouteBlock('---ROU')).toBe(true);
    expect(isPartialRouteBlock('---ROUT')).toBe(true);
    expect(isPartialRouteBlock('---ROUTE')).toBe(true);
  });

  it('rejects non-route blocks', () => {
    expect(isPartialRouteBlock('Hello')).toBe(false);
    expect(isPartialRouteBlock('--RO')).toBe(false);
  });
});

// ── extractRouteBlocks ───────────────────────────────────────────────

describe('rolePlayAdapter — extractRouteBlocks', () => {
  it('extracts ROUTE blocks from text', () => {
    const text = 'Some content\n---ROUTE---\nto: reviewer\nsummary: Please review\n---END_ROUTE---\nMore content';
    const { cleanContent, routes } = extractRouteBlocks(text);
    expect(routes).toHaveLength(1);
    expect(routes[0].routeTo).toBe('reviewer');
    expect(routes[0].routeSummary).toBe('Please review');
    expect(cleanContent).toContain('Some content');
    expect(cleanContent).toContain('More content');
    expect(cleanContent).not.toContain('---ROUTE---');
  });

  it('extracts multiple ROUTE blocks', () => {
    const text = '---ROUTE---\nto: rev\nsummary: Review\n---END_ROUTE---\n---ROUTE---\nto: test\nsummary: Test\n---END_ROUTE---';
    const { routes } = extractRouteBlocks(text);
    expect(routes).toHaveLength(2);
    expect(routes[0].routeTo).toBe('rev');
    expect(routes[1].routeTo).toBe('test');
  });

  it('returns empty routes when no ROUTE blocks', () => {
    const text = 'Just normal text';
    const { cleanContent, routes } = extractRouteBlocks(text);
    expect(routes).toHaveLength(0);
    expect(cleanContent).toBe('Just normal text');
  });
});

// ── adaptRolePlayMessages ────────────────────────────────────────────

describe('rolePlayAdapter — adaptRolePlayMessages', () => {
  const roles = [
    { name: 'pm', displayName: 'PM-Jobs', icon: '📋' },
    { name: 'dev', displayName: 'Dev-Linus', icon: '💻' },
    { name: 'reviewer', displayName: 'Rev-Martin', icon: '🔍' },
  ];

  it('converts user message to Crew format', () => {
    const messages = [{ type: 'user', content: 'Hello', id: 1, timestamp: 1000 }];
    const result = adaptRolePlayMessages(messages, roles);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      type: 'text',
      role: 'human',
      roleName: 'Human',
      roleIcon: '👤',
      content: 'Hello',
    });
  });

  it('converts system message', () => {
    const messages = [{ type: 'system', content: 'System msg', id: 2 }];
    const result = adaptRolePlayMessages(messages, roles);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('system');
    expect(result[0].role).toBe('system');
  });

  it('converts assistant text with role signals', () => {
    const messages = [{
      type: 'assistant',
      content: '---ROLE: pm---\nI am PM\n---ROLE: dev---\nI am Dev\n',
      id: 3,
      timestamp: 2000
    }];
    const result = adaptRolePlayMessages(messages, roles);
    expect(result).toHaveLength(2);
    expect(result[0].role).toBe('pm');
    expect(result[0].roleName).toBe('PM-Jobs');
    expect(result[0].roleIcon).toBe('📋');
    expect(result[0].content).toContain('I am PM');
    expect(result[1].role).toBe('dev');
    expect(result[1].roleName).toBe('Dev-Linus');
    expect(result[1].content).toContain('I am Dev');
  });

  it('converts tool-use messages with current role context', () => {
    const messages = [
      { type: 'assistant', content: '---ROLE: dev---\nLet me code\n', id: 4 },
      { type: 'tool-use', toolName: 'Write', toolInput: { path: '/foo.js' }, id: 5, timestamp: 3000 },
    ];
    const result = adaptRolePlayMessages(messages, roles);
    expect(result.length).toBeGreaterThanOrEqual(2);
    const toolMsg = result.find(m => m.type === 'tool');
    expect(toolMsg).toBeDefined();
    expect(toolMsg.role).toBe('dev');
    expect(toolMsg.roleName).toBe('Dev-Linus');
    expect(toolMsg.toolName).toBe('Write');
  });

  it('extracts ROUTE blocks as route messages', () => {
    const messages = [{
      type: 'assistant',
      content: '---ROLE: pm---\nDone\n---ROUTE---\nto: reviewer\nsummary: Please review\n---END_ROUTE---\n',
      id: 6,
      timestamp: 4000
    }];
    const result = adaptRolePlayMessages(messages, roles);
    const textMsg = result.find(m => m.type === 'text' && m.role === 'pm');
    const routeMsg = result.find(m => m.type === 'route');
    expect(textMsg).toBeDefined();
    expect(textMsg.content).toContain('Done');
    expect(routeMsg).toBeDefined();
    expect(routeMsg.routeTo).toBe('reviewer');
    expect(routeMsg.routeToName).toBe('Rev-Martin');
    expect(routeMsg.routeSummary).toBe('Please review');
  });

  it('handles streaming messages', () => {
    const messages = [{
      type: 'assistant',
      content: '---ROLE: dev---\nCoding in progress...',
      id: 7,
      isStreaming: true,
      timestamp: 5000
    }];
    const result = adaptRolePlayMessages(messages, roles);
    expect(result).toHaveLength(1);
    expect(result[0]._streaming).toBe(true);
  });

  it('handles unknown roles gracefully', () => {
    const messages = [{
      type: 'assistant',
      content: '---ROLE: unknown_role---\nSomething\n',
      id: 8,
      timestamp: 6000
    }];
    const result = adaptRolePlayMessages(messages, roles);
    expect(result).toHaveLength(1);
    expect(result[0].role).toBe('unknown_role');
    expect(result[0].roleName).toBe('unknown_role');
    expect(result[0].roleIcon).toBe('🤖');
  });

  it('handles empty messages array', () => {
    const result = adaptRolePlayMessages([], roles);
    expect(result).toEqual([]);
  });

  it('handles error messages', () => {
    const messages = [{ type: 'error', content: 'Something broke', id: 9 }];
    const result = adaptRolePlayMessages(messages, roles);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('system');
  });
});

// ── Integration: adapted messages → buildTurns ───────────────────────

describe('rolePlayAdapter → crewMessageGrouping integration', () => {
  const roles = [
    { name: 'pm', displayName: 'PM-Jobs', icon: '📋' },
    { name: 'dev', displayName: 'Dev-Linus', icon: '💻' },
  ];

  it('adapted messages produce valid turns via buildTurns', () => {
    const messages = [
      { type: 'user', content: 'Build feature X', id: 1, timestamp: 1000 },
      { type: 'assistant', content: '---ROLE: pm---\nAnalyzing...\n---ROLE: dev---\nImplementing...\n', id: 2, timestamp: 2000 },
    ];
    const adapted = adaptRolePlayMessages(messages, roles);
    const turns = buildTurns(adapted);
    expect(turns.length).toBeGreaterThanOrEqual(2);

    // First should be human message
    const humanTurn = turns.find(t => t.message?.role === 'human');
    expect(humanTurn).toBeDefined();

    // Should have role turns
    const roleTurns = turns.filter(t => t.type === 'turn');
    expect(roleTurns.length).toBeGreaterThanOrEqual(1);
  });

  it('consecutive messages from same role group into one turn', () => {
    const messages = [
      { type: 'assistant', content: '---ROLE: dev---\nPart 1\n', id: 1, timestamp: 1000 },
      { type: 'assistant', content: '---ROLE: dev---\nPart 2\n', id: 2, timestamp: 2000 },
    ];
    const adapted = adaptRolePlayMessages(messages, roles);
    const turns = buildTurns(adapted);
    // Both messages should be from dev, consecutive → grouped
    const devTurns = turns.filter(t => t.type === 'turn' && t.role === 'dev');
    expect(devTurns).toHaveLength(1);
    expect(devTurns[0].messages).toHaveLength(2);
  });

  it('role change creates separate turns', () => {
    const messages = [
      { type: 'assistant', content: '---ROLE: pm---\nPM says\n---ROLE: dev---\nDev says\n', id: 1, timestamp: 1000 },
    ];
    const adapted = adaptRolePlayMessages(messages, roles);
    const turns = buildTurns(adapted);
    const roleTurns = turns.filter(t => t.type === 'turn');
    expect(roleTurns).toHaveLength(2);
    expect(roleTurns[0].role).toBe('pm');
    expect(roleTurns[1].role).toBe('dev');
  });

  it('route messages are included in turn routeMsgs', () => {
    const messages = [{
      type: 'assistant',
      content: '---ROLE: pm---\nDone\n---ROUTE---\nto: dev\nsummary: Go code\n---END_ROUTE---\n',
      id: 1,
      timestamp: 1000
    }];
    const adapted = adaptRolePlayMessages(messages, roles);
    const turns = buildTurns(adapted);
    const pmTurn = turns.find(t => t.type === 'turn' && t.role === 'pm');
    expect(pmTurn).toBeDefined();
    expect(pmTurn.routeMsgs.length).toBeGreaterThanOrEqual(1);
    expect(pmTurn.routeMsgs[0].routeTo).toBe('dev');
  });
});
