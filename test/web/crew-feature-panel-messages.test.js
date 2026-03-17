import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

/**
 * Tests for PR #257 + PR #258 — CrewFeaturePanel dual-mode message view + UI fixes.
 *
 * Tests business logic ONLY:
 * 1. truncateText: markdown stripping, first-line extraction, length capping
 * 2. getLatestMessageSummary: backward walk, returns { icon, roleName, text, time }
 * 3. getSummary: caching wrapper with reference-identity invalidation
 * 4. Computed properties: expandedBlock, expandedTurnsList, expandedFeatureTitle, expandedFeatureTodos
 * 5. CrewChatView: expandFeature toggle, closeFeature reset
 * 6. Template: compact list cards (no expand/collapse), expanded mode todo list, tool-line start-time
 */

const base = resolve(__dirname, '../..');
const read = (rel) => readFileSync(resolve(base, rel), 'utf-8');

// =====================================================================
// Extract truncateText and getLatestMessageSummary from source
// =====================================================================

function loadFeaturePanelMethods() {
  const src = read('web/components/crew/CrewFeaturePanel.js');

  // Extract truncateText method body
  const truncateMatch = src.match(/truncateText\(text,\s*maxLen\)\s*\{([\s\S]*?)\n    \}/);
  if (!truncateMatch) throw new Error('Could not extract truncateText');
  const truncateText = new Function('text', 'maxLen', truncateMatch[1]);

  // Extract getLatestMessageSummary — needs `this` context
  const summaryMatch = src.match(/getLatestMessageSummary\(taskId\)\s*\{([\s\S]*?)\n    \},/);
  if (!summaryMatch) throw new Error('Could not extract getLatestMessageSummary');

  // Extract formatTime from crewHelpers
  const helpersSrc = read('web/components/crew/crewHelpers.js');
  const formatTimeMatch = helpersSrc.match(/export function formatTime\(ts\)\s*\{([\s\S]*?)\n\}/);
  if (!formatTimeMatch) throw new Error('Could not extract formatTime');
  const formatTime = new Function('ts', formatTimeMatch[1]);

  function createGetLatestMessageSummary(featureBlocks, getBlockTurns, getRoleDisplayName) {
    const ctx = {
      featureBlocks,
      getBlockTurns,
      getRoleDisplayName: getRoleDisplayName || ((name) => name),
      truncateText
    };
    // Inject formatTime into the function scope
    const fnBody = summaryMatch[1];
    return new Function('formatTime', 'taskId', fnBody).bind(ctx, formatTime);
  }

  return { truncateText, createGetLatestMessageSummary, formatTime };
}

const { truncateText, createGetLatestMessageSummary, formatTime } = loadFeaturePanelMethods();

// =====================================================================
// 1. truncateText — markdown stripping, first-line, length capping
// =====================================================================
describe('truncateText — markdown stripping and truncation', () => {
  it('returns empty string for null/undefined/empty input', () => {
    expect(truncateText(null, 80)).toBe('');
    expect(truncateText(undefined, 80)).toBe('');
    expect(truncateText('', 80)).toBe('');
  });

  it('strips markdown characters (#, *, _, `, ~, [, ])', () => {
    const result = truncateText('## Hello **world** `code`', 80);
    expect(result).not.toContain('#');
    expect(result).not.toContain('*');
    expect(result).not.toContain('`');
    expect(result).toContain('Hello');
    expect(result).toContain('world');
    expect(result).toContain('code');
  });

  it('takes only the first line of multi-line text', () => {
    const result = truncateText('First line\nSecond line\nThird line', 80);
    expect(result).toBe('First line');
  });

  it('returns text as-is when within maxLen', () => {
    expect(truncateText('Short text', 80)).toBe('Short text');
  });

  it('truncates with ellipsis when exceeding maxLen', () => {
    const longText = 'A'.repeat(100);
    const result = truncateText(longText, 80);
    expect(result).toHaveLength(81); // 80 chars + '…'
    expect(result.endsWith('\u2026')).toBe(true);
  });

  it('respects different maxLen values', () => {
    const text = 'Hello World of Testing';
    const result = truncateText(text, 10);
    expect(result).toBe('Hello Worl\u2026');
  });
});

// =====================================================================
// 2. getLatestMessageSummary — returns { icon, roleName, text, time }
// =====================================================================
describe('getLatestMessageSummary — finds latest text message with metadata', () => {
  it('returns null when no matching feature block exists', () => {
    const getSummary = createGetLatestMessageSummary([], () => []);
    expect(getSummary('task-99')).toBeNull();
  });

  it('returns null when feature block has no turns', () => {
    const blocks = [{ type: 'feature', taskId: 'task-1' }];
    const getSummary = createGetLatestMessageSummary(blocks, () => []);
    expect(getSummary('task-1')).toBeNull();
  });

  it('returns null when turns have no text content', () => {
    const blocks = [{ type: 'feature', taskId: 'task-1' }];
    const turns = [{ type: 'turn', textMsg: null, roleIcon: '🤖' }];
    const getSummary = createGetLatestMessageSummary(blocks, () => turns);
    expect(getSummary('task-1')).toBeNull();
  });

  it('returns icon, roleName, text, and time from the last turn with textMsg', () => {
    const blocks = [{ type: 'feature', taskId: 'task-1' }];
    const ts = new Date('2026-03-17T10:30:00Z').getTime();
    const turns = [
      { type: 'turn', textMsg: { content: 'First message' }, roleIcon: '🐧', role: 'dev-1', messages: [{ timestamp: ts - 1000 }] },
      { type: 'turn', textMsg: { content: 'Latest message' }, roleIcon: '🤖', role: 'dev-2', messages: [{ timestamp: ts }] }
    ];
    const getSummary = createGetLatestMessageSummary(blocks, () => turns);
    const result = getSummary('task-1');
    expect(result).not.toBeNull();
    expect(result.icon).toBe('🤖');
    expect(result.roleName).toBe('dev-2');
    expect(result.text).toBe('Latest message');
    expect(result.time).toBeTruthy(); // formatted timestamp
  });

  it('walks backward and skips turns without textMsg', () => {
    const blocks = [{ type: 'feature', taskId: 'task-1' }];
    const turns = [
      { type: 'turn', textMsg: { content: 'Has text' }, roleIcon: '📋', role: 'pm' },
      { type: 'turn', textMsg: null, roleIcon: '🤖' },
      { type: 'turn', textMsg: null, roleIcon: '🐧' }
    ];
    const getSummary = createGetLatestMessageSummary(blocks, () => turns);
    const result = getSummary('task-1');
    expect(result.icon).toBe('📋');
    expect(result.roleName).toBe('pm');
    expect(result.text).toBe('Has text');
  });

  it('handles non-turn type with message.type === "text"', () => {
    const blocks = [{ type: 'feature', taskId: 'task-1' }];
    const ts = Date.now();
    const turns = [
      { type: 'human', message: { type: 'text', content: 'Human said this', roleIcon: '👤', role: 'human', timestamp: ts } }
    ];
    const getSummary = createGetLatestMessageSummary(blocks, () => turns);
    const result = getSummary('task-1');
    expect(result).not.toBeNull();
    expect(result.text).toBe('Human said this');
    expect(result.time).toBeTruthy();
  });

  it('uses getRoleDisplayName to resolve role name', () => {
    const blocks = [{ type: 'feature', taskId: 'task-1' }];
    const turns = [
      { type: 'turn', textMsg: { content: 'Test' }, roleIcon: '🐧', role: 'dev-1' }
    ];
    const displayNameFn = (name) => name === 'dev-1' ? '开发者-托瓦兹-1' : name;
    const getSummary = createGetLatestMessageSummary(blocks, () => turns, displayNameFn);
    const result = getSummary('task-1');
    expect(result.roleName).toBe('开发者-托瓦兹-1');
  });

  it('uses roleIcon empty string fallback when missing', () => {
    const blocks = [{ type: 'feature', taskId: 'task-1' }];
    const turns = [{ type: 'turn', textMsg: { content: 'No icon' } }];
    const getSummary = createGetLatestMessageSummary(blocks, () => turns);
    const result = getSummary('task-1');
    expect(result.icon).toBe('');
  });

  it('returns empty time when no timestamp available', () => {
    const blocks = [{ type: 'feature', taskId: 'task-1' }];
    const turns = [{ type: 'turn', textMsg: { content: 'No time' }, roleIcon: '🤖', role: 'dev' }];
    const getSummary = createGetLatestMessageSummary(blocks, () => turns);
    const result = getSummary('task-1');
    expect(result.time).toBe('');
  });
});

// =====================================================================
// 3. getSummary — caching wrapper
// =====================================================================
describe('getSummary — caching with featureBlocks reference identity', () => {
  const src = read('web/components/crew/CrewFeaturePanel.js');

  it('getSummary method exists and delegates to getLatestMessageSummary', () => {
    const fnBody = src.match(/getSummary\(taskId\)\s*\{([\s\S]*?)\n    \},/);
    expect(fnBody).toBeTruthy();
    expect(fnBody[1]).toContain('this.getLatestMessageSummary(taskId)');
  });

  it('cache invalidation checks featureBlocks reference identity', () => {
    const fnBody = src.match(/getSummary\(taskId\)\s*\{([\s\S]*?)\n    \},/);
    expect(fnBody[1]).toContain('this._summaryCacheRef !== this.featureBlocks');
  });

  it('caches result and returns cached value on subsequent calls', () => {
    const fnBody = src.match(/getSummary\(taskId\)\s*\{([\s\S]*?)\n    \},/);
    // Checks cache before computing
    expect(fnBody[1]).toContain('if (taskId in this._summaryCache) return this._summaryCache[taskId]');
    // Stores result in cache
    expect(fnBody[1]).toContain('this._summaryCache[taskId] = result');
  });
});

// =====================================================================
// 4. Computed properties — expandedBlock, expandedTurnsList, expandedFeatureTitle
// =====================================================================
describe('CrewFeaturePanel computed properties', () => {
  const src = read('web/components/crew/CrewFeaturePanel.js');

  it('expandedBlock returns null when expandedFeatureTaskId is null', () => {
    const computedBody = src.match(/expandedBlock\(\)\s*\{([\s\S]*?)\n    \}/);
    expect(computedBody).toBeTruthy();
    expect(computedBody[1]).toContain('if (!this.expandedFeatureTaskId) return null');
  });

  it('expandedBlock searches featureBlocks by type=feature and matching taskId', () => {
    const computedBody = src.match(/expandedBlock\(\)\s*\{([\s\S]*?)\n    \}/);
    expect(computedBody[1]).toContain("b.type === 'feature'");
    expect(computedBody[1]).toContain('b.taskId === this.expandedFeatureTaskId');
  });

  it('expandedTurnsList returns empty array when expandedBlock is null', () => {
    const computedBody = src.match(/expandedTurnsList\(\)\s*\{([\s\S]*?)\n    \}/);
    expect(computedBody).toBeTruthy();
    expect(computedBody[1]).toContain('if (!this.expandedBlock) return []');
  });

  it('expandedFeatureTitle falls back to taskId when taskTitle is missing', () => {
    const computedBody = src.match(/expandedFeatureTitle\(\)\s*\{([\s\S]*?)\n    \}/);
    expect(computedBody).toBeTruthy();
    expect(computedBody[1]).toContain('this.expandedBlock.taskTitle || this.expandedFeatureTaskId');
  });

  it('expandedFeatureTodos returns empty array when no feature matches', () => {
    const computedBody = src.match(/expandedFeatureTodos\(\)\s*\{([\s\S]*?)\n    \}/);
    expect(computedBody).toBeTruthy();
    expect(computedBody[1]).toContain('if (!this.expandedFeatureTaskId) return []');
    expect(computedBody[1]).toContain('feature.todos');
  });
});

// =====================================================================
// 5. CrewChatView — expandFeature toggle, closeFeature, resolveBlockTurns
// =====================================================================
describe('CrewChatView — expand/close feature methods', () => {
  const viewSrc = read('web/components/CrewChatView.js');

  it('expandFeature toggles: same taskId sets null, different taskId sets it', () => {
    const fnMatch = viewSrc.match(/expandFeature\(taskId\)\s*\{([\s\S]*?)\n    \}/);
    expect(fnMatch).toBeTruthy();
    expect(fnMatch[1]).toContain('this.expandedFeatureTaskId === taskId ? null : taskId');
  });

  it('closeFeature sets expandedFeatureTaskId to null', () => {
    const fnMatch = viewSrc.match(/closeFeature\(\)\s*\{([\s\S]*?)\n    \}/);
    expect(fnMatch).toBeTruthy();
    expect(fnMatch[1]).toContain('this.expandedFeatureTaskId = null');
  });

  it('resolveBlockTurns delegates to getBlockTurns with fbCache', () => {
    const fnMatch = viewSrc.match(/resolveBlockTurns\(block\)\s*\{([\s\S]*?)\n    \}/);
    expect(fnMatch).toBeTruthy();
    expect(fnMatch[1]).toContain('getBlockTurns(block, this._fbCache)');
  });

  it('expandedFeatureTaskId initialized to null in data', () => {
    expect(viewSrc).toContain('expandedFeatureTaskId: null');
  });

  it('passes expand/close event listeners to CrewFeaturePanel', () => {
    expect(viewSrc).toContain('@expand-feature="expandFeature"');
    expect(viewSrc).toContain('@close-feature="closeFeature"');
  });

  it('does not bind scroll-to-feature event (cleaned up)', () => {
    expect(viewSrc).not.toContain('@scroll-to-feature');
  });

  it('workspace adds feature-expanded class when expandedFeatureTaskId is set', () => {
    expect(viewSrc).toContain("'feature-expanded': !!expandedFeatureTaskId");
  });

  it('passes getRoleDisplayName to CrewFeaturePanel', () => {
    expect(viewSrc).toContain(':get-role-display-name="getRoleDisplayName"');
  });
});

// =====================================================================
// 6. Template — compact list cards, expanded mode todo list
// =====================================================================
describe('CrewFeaturePanel template — list mode compact + expanded mode todos', () => {
  const panelSrc = read('web/components/crew/CrewFeaturePanel.js');

  it('feature card uses single click to emit expand-feature (not dblclick)', () => {
    expect(panelSrc).toContain("@click=\"$emit('expand-feature', feature.taskId)\"");
    expect(panelSrc).not.toContain('@dblclick');
  });

  it('list mode cards have no chevron arrow', () => {
    const templateMatch = panelSrc.match(/template:\s*`([\s\S]*?)`\s*,/);
    const listSection = templateMatch[1].split('v-else>')[1]; // list mode section
    expect(listSection).not.toContain('crew-feature-card-chevron');
  });

  it('list mode has no expand/collapse logic (no isFeatureCardExpanded, no toggleFeatureCard)', () => {
    expect(panelSrc).not.toContain('isFeatureCardExpanded');
    expect(panelSrc).not.toContain('toggleFeatureCard');
    expect(panelSrc).not.toContain('expandedFeatureCards');
  });

  it('list mode cards always show summary (no v-if expand gate)', () => {
    const templateMatch = panelSrc.match(/template:\s*`([\s\S]*?)`\s*,/);
    const template = templateMatch[1];
    // Summary should be shown without a wrapping template v-if for expand state
    expect(template).toContain('getSummary(feature.taskId)');
    // No template guard for card expand state
    expect(template).not.toContain('v-if="isFeatureCardExpanded');
  });

  it('list mode cards do not show todo list', () => {
    const templateMatch = panelSrc.match(/template:\s*`([\s\S]*?)`\s*,/);
    const listSection = templateMatch[1].split('v-else>')[1];
    expect(listSection).not.toContain('feature.todos');
    expect(listSection).not.toContain('crew-feature-card-todos');
  });

  it('expanded mode shows todo list between header and messages', () => {
    const templateMatch = panelSrc.match(/template:\s*`([\s\S]*?)`\s*,/);
    const expandedSection = templateMatch[1].split('v-else>')[0]; // expanded mode section
    expect(expandedSection).toContain('expandedFeatureTodos');
    expect(expandedSection).toContain('crew-feature-card-todos');
    // Todo list appears after header and before messages
    const headerIdx = expandedSection.indexOf('crew-feature-expanded-header');
    const todosIdx = expandedSection.indexOf('expandedFeatureTodos');
    const messagesIdx = expandedSection.indexOf('crew-feature-expanded-messages');
    expect(headerIdx).toBeLessThan(todosIdx);
    expect(todosIdx).toBeLessThan(messagesIdx);
  });

  it('imports formatTime from crewHelpers', () => {
    expect(panelSrc).toContain('formatTime');
    expect(panelSrc).toMatch(/import\s*\{[^}]*formatTime[^}]*\}\s*from\s*'\.\/crewHelpers\.js'/);
  });

  it('template uses getSummary (cached) instead of getLatestMessageSummary directly', () => {
    const templateMatch = panelSrc.match(/template:\s*`([\s\S]*?)`\s*,/);
    const template = templateMatch[1];
    expect(template).toContain('getSummary(feature.taskId)');
    expect(template).not.toContain('getLatestMessageSummary');
  });

  it('summary uses two-line layout with meta row (icon + roleName + time)', () => {
    expect(panelSrc).toContain('crew-feature-summary-meta');
    expect(panelSrc).toContain('crew-feature-summary-role');
    expect(panelSrc).toContain('crew-feature-summary-time');
    expect(panelSrc).toContain('crew-feature-summary-text');
  });

  it('expanded mode shown when expandedFeatureTaskId is truthy', () => {
    expect(panelSrc).toContain('v-if="expandedFeatureTaskId"');
  });

  it('list mode shown via v-else when expandedFeatureTaskId is falsy', () => {
    expect(panelSrc).toContain('<template v-else>');
  });

  it('expanded mode emits close-feature when back button clicked', () => {
    expect(panelSrc).toContain("@click=\"$emit('close-feature')\"");
  });

  it('emits declaration does not include scroll-to-feature', () => {
    expect(panelSrc).not.toContain("'scroll-to-feature'");
  });
});

// =====================================================================
// 7. CrewTurnRenderer — tool-line start-time prop
// =====================================================================
describe('CrewTurnRenderer — tool-line start-time prop', () => {
  const rendererSrc = read('web/components/crew/CrewTurnRenderer.js');

  it('passes :start-time to tool-line for expanded tool messages', () => {
    expect(rendererSrc).toContain(':start-time="toolMsg.timestamp"');
  });

  it('passes :start-time to tool-line for latest (last) tool message', () => {
    // The last tool message uses turn.toolMsgs[turn.toolMsgs.length - 1].timestamp
    expect(rendererSrc).toContain(':start-time="turn.toolMsgs[turn.toolMsgs.length - 1].timestamp"');
  });
});

// =====================================================================
// 8. CSS — background differentiation + cleanup
// =====================================================================
describe('CSS — expanded messages background + chevron cleanup', () => {
  const cssSrc = read('web/styles/crew-workspace.css');

  it('crew-feature-expanded-messages has color-mix background', () => {
    expect(cssSrc).toContain('crew-feature-expanded-messages');
    expect(cssSrc).toContain('color-mix');
  });

  it('feature card is clickable with cursor pointer', () => {
    expect(cssSrc).toMatch(/\.crew-feature-card\s*\{[\s\S]*?cursor:\s*pointer/);
  });

  it('crew-feature-card-chevron CSS has been removed', () => {
    expect(cssSrc).not.toContain('.crew-feature-card-chevron');
  });

  it('.is-expanded chevron rotation CSS has been removed', () => {
    expect(cssSrc).not.toContain('.crew-feature-card.is-expanded .crew-feature-card-chevron');
  });

  it('active roles CSS has been removed (no longer in list cards)', () => {
    expect(cssSrc).not.toContain('.crew-feature-card-roles');
  });
});

// =====================================================================
// 9. Functional test — expandFeature toggle logic
// =====================================================================
describe('expandFeature toggle logic — functional test', () => {
  function expandFeature(current, taskId) {
    return current === taskId ? null : taskId;
  }

  it('sets taskId when current is null', () => {
    expect(expandFeature(null, 'task-1')).toBe('task-1');
  });

  it('toggles to null when same taskId is passed', () => {
    expect(expandFeature('task-1', 'task-1')).toBeNull();
  });

  it('switches to new taskId when different taskId is passed', () => {
    expect(expandFeature('task-1', 'task-2')).toBe('task-2');
  });
});

// =====================================================================
// 10. formatTime — basic sanity
// =====================================================================
describe('formatTime — time formatting', () => {
  it('returns empty string for falsy input', () => {
    expect(formatTime(null)).toBe('');
    expect(formatTime(undefined)).toBe('');
    expect(formatTime(0)).toBe('');
  });

  it('returns a formatted time string for valid timestamp', () => {
    const ts = new Date('2026-03-17T14:30:45Z').getTime();
    const result = formatTime(ts);
    // Should contain hour:minute:second pattern
    expect(result).toMatch(/\d{2}:\d{2}:\d{2}/);
  });
});
