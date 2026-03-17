import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

/**
 * Tests for PR #257 + PR #258 + PR #259 — CrewFeaturePanel dual-mode message view + UI fixes.
 *
 * Tests business logic ONLY:
 * 1. truncateText: markdown stripping, first-line extraction, length capping
 * 2. getLatestMessageSummary: backward walk, returns { icon, roleName, role, text, time, actions }
 * 3. getSummary: caching wrapper with reference-identity invalidation
 * 4. Computed properties: expandedBlock, expandedTurnsList, expandedFeatureTitle, expandedFeatureTodos
 * 5. CrewChatView: expandFeature toggle, closeFeature reset
 * 6. Template: compact list cards, expanded mode todo list, tool-line start-time
 * 7. PR #259: hasFeatureMessages, getRoleStyle, v-show, sticky header, actions row, CSS fixes
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

  it('returns icon, roleName, role, text, time, and actions from the last turn with textMsg', () => {
    const blocks = [{ type: 'feature', taskId: 'task-1' }];
    const ts = new Date('2026-03-17T10:30:00Z').getTime();
    const turns = [
      { type: 'turn', textMsg: { content: 'First message' }, roleIcon: '🐧', role: 'dev-1', messages: [{ timestamp: ts - 1000 }] },
      { type: 'turn', textMsg: { content: 'Latest message' }, roleIcon: '🤖', role: 'dev-2', messages: [{ timestamp: ts }], toolMsgs: [{ toolName: 'Read' }, { toolName: 'Edit' }] }
    ];
    const getSummary = createGetLatestMessageSummary(blocks, () => turns);
    const result = getSummary('task-1');
    expect(result).not.toBeNull();
    expect(result.icon).toBe('🤖');
    expect(result.roleName).toBe('dev-2');
    expect(result.role).toBe('dev-2');
    expect(result.text).toBe('Latest message');
    expect(result.time).toBeTruthy();
    expect(result.actions).toEqual(['Read', 'Edit']);
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

  it('returns empty actions array when turn has no toolMsgs', () => {
    const blocks = [{ type: 'feature', taskId: 'task-1' }];
    const turns = [{ type: 'turn', textMsg: { content: 'No tools' }, roleIcon: '🤖', role: 'dev' }];
    const getSummary = createGetLatestMessageSummary(blocks, () => turns);
    const result = getSummary('task-1');
    expect(result.actions).toEqual([]);
  });

  it('filters out falsy toolName values from actions', () => {
    const blocks = [{ type: 'feature', taskId: 'task-1' }];
    const turns = [{ type: 'turn', textMsg: { content: 'Mixed tools' }, roleIcon: '🤖', role: 'dev', toolMsgs: [{ toolName: 'Read' }, { toolName: '' }, { toolName: null }, { toolName: 'Write' }] }];
    const getSummary = createGetLatestMessageSummary(blocks, () => turns);
    const result = getSummary('task-1');
    expect(result.actions).toEqual(['Read', 'Write']);
  });

  it('non-turn type returns empty actions array', () => {
    const blocks = [{ type: 'feature', taskId: 'task-1' }];
    const turns = [{ type: 'human', message: { type: 'text', content: 'Test', role: 'human', timestamp: Date.now() } }];
    const getSummary = createGetLatestMessageSummary(blocks, () => turns);
    const result = getSummary('task-1');
    expect(result.actions).toEqual([]);
  });

  it('returns raw role name in role field (not display name)', () => {
    const blocks = [{ type: 'feature', taskId: 'task-1' }];
    const turns = [{ type: 'turn', textMsg: { content: 'Test' }, roleIcon: '🐧', role: 'dev-1' }];
    const displayNameFn = (name) => name === 'dev-1' ? '开发者-托瓦兹-1' : name;
    const getSummary = createGetLatestMessageSummary(blocks, () => turns, displayNameFn);
    const result = getSummary('task-1');
    expect(result.role).toBe('dev-1'); // raw name for getRoleStyle
    expect(result.roleName).toBe('开发者-托瓦兹-1'); // display name for UI
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
// 8. CSS — background differentiation + cleanup + PR #259 fixes
// =====================================================================
describe('CSS — expanded messages background + chevron cleanup + sticky header', () => {
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

  it('expanded header is sticky with z-index', () => {
    const headerCSS = cssSrc.match(/\.crew-feature-expanded-header\s*\{([^}]+)\}/);
    expect(headerCSS).toBeTruthy();
    expect(headerCSS[1]).toContain('position: sticky');
    expect(headerCSS[1]).toContain('top: 0');
    expect(headerCSS[1]).toContain('z-index: 10');
    expect(headerCSS[1]).toContain('background: var(--bg-main)');
  });

  it('expanded header has no border-bottom', () => {
    const headerCSS = cssSrc.match(/\.crew-feature-expanded-header\s*\{([^}]+)\}/);
    expect(headerCSS[1]).not.toContain('border-bottom');
  });

  it('todos section has margin-bottom for spacing (no border-top)', () => {
    const todosCSS = cssSrc.match(/\.crew-feature-card-todos\s*\{([^}]+)\}/);
    expect(todosCSS).toBeTruthy();
    expect(todosCSS[1]).toContain('margin-bottom: 16px');
    expect(todosCSS[1]).not.toContain('border-top');
  });

  it('tool-line in expanded messages has min-width:0 for proper truncation', () => {
    expect(cssSrc).toContain('.crew-feature-expanded-messages .tool-line');
    const toolLineCSS = cssSrc.match(/\.crew-feature-expanded-messages\s+\.tool-line\s*\{([^}]+)\}/);
    expect(toolLineCSS).toBeTruthy();
    expect(toolLineCSS[1]).toContain('min-width: 0');
  });

  it('tool-line status and time in expanded messages have flex-shrink:0', () => {
    expect(cssSrc).toMatch(/\.crew-feature-expanded-messages\s+\.tool-line-status[\s\S]*?flex-shrink:\s*0/);
    expect(cssSrc).toMatch(/\.crew-feature-expanded-messages\s+\.tool-line-time[\s\S]*?flex-shrink:\s*0/);
  });

  it('summary role uses --role-color CSS variable', () => {
    const roleCSS = cssSrc.match(/\.crew-feature-summary-role\s*\{([^}]+)\}/);
    expect(roleCSS).toBeTruthy();
    expect(roleCSS[1]).toContain('var(--role-color');
  });

  it('summary actions section exists with proper layout', () => {
    expect(cssSrc).toContain('.crew-feature-summary-actions');
    expect(cssSrc).toContain('.crew-feature-summary-actions-count');
    expect(cssSrc).toContain('.crew-feature-summary-actions-list');
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

// =====================================================================
// 11. PR #259: hasFeatureMessages, getRoleStyle, v-show, actions row
// =====================================================================
describe('PR #259 — hasFeatureMessages, getRoleStyle integration, actions row', () => {
  const panelSrc = read('web/components/crew/CrewFeaturePanel.js');

  it('imports getRoleStyle from crewHelpers', () => {
    expect(panelSrc).toMatch(/import\s*\{[^}]*getRoleStyle[^}]*\}\s*from\s*'\.\/crewHelpers\.js'/);
  });

  it('exposes getRoleStyle in methods', () => {
    expect(panelSrc).toMatch(/methods:\s*\{[\s\S]*?getRoleStyle/);
  });

  it('hasFeatureMessages method checks for block existence and turns length', () => {
    const fnMatch = panelSrc.match(/hasFeatureMessages\(taskId\)\s*\{([\s\S]*?)\n    \}/);
    expect(fnMatch).toBeTruthy();
    expect(fnMatch[1]).toContain("b.type === 'feature'");
    expect(fnMatch[1]).toContain('b.taskId === taskId');
    expect(fnMatch[1]).toContain('if (!block) return false');
    expect(fnMatch[1]).toContain('turns && turns.length > 0');
  });

  it('list mode cards use v-show="hasFeatureMessages" to hide empty features', () => {
    const templateMatch = panelSrc.match(/template:\s*`([\s\S]*?)`\s*,/);
    const template = templateMatch[1];
    expect(template).toContain('v-show="hasFeatureMessages(feature.taskId)"');
  });

  it('both inProgress and completed cards use v-show', () => {
    const templateMatch = panelSrc.match(/template:\s*`([\s\S]*?)`\s*,/);
    const listSection = templateMatch[1].split('v-else>')[1];
    const vShowMatches = listSection.match(/v-show="hasFeatureMessages\(feature\.taskId\)"/g);
    expect(vShowMatches).toHaveLength(2);
  });

  it('role name in summary uses getRoleStyle for color binding', () => {
    expect(panelSrc).toContain(':style="getRoleStyle(getSummary(feature.taskId).role)"');
  });

  it('getLatestMessageSummary returns role and actions fields', () => {
    const fnMatch = panelSrc.match(/getLatestMessageSummary\(taskId\)\s*\{([\s\S]*?)\n    \},/);
    expect(fnMatch).toBeTruthy();
    // Returns rawRole and actions for turn type
    expect(fnMatch[1]).toContain('role: rawRole');
    expect(fnMatch[1]).toContain("(turn.toolMsgs || []).map(t => t.toolName).filter(Boolean)");
    // Non-turn type returns empty actions
    expect(fnMatch[1]).toContain('actions: []');
  });

  it('template shows actions row when summary has actions', () => {
    expect(panelSrc).toContain('crew-feature-summary-actions');
    expect(panelSrc).toContain('getSummary(feature.taskId).actions.length > 0');
    expect(panelSrc).toContain('crew-feature-summary-actions-count');
    expect(panelSrc).toContain('crew-feature-summary-actions-list');
  });
});

// =====================================================================
// 12. hasFeatureMessages — functional test
// =====================================================================
describe('hasFeatureMessages — functional test', () => {
  function hasFeatureMessages(featureBlocks, getBlockTurns, taskId) {
    const block = featureBlocks.find(b => b.type === 'feature' && b.taskId === taskId);
    if (!block) return false;
    const turns = getBlockTurns(block);
    return turns && turns.length > 0;
  }

  it('returns false when no block matches', () => {
    expect(hasFeatureMessages([], () => [], 'task-1')).toBe(false);
  });

  it('returns false when block exists but has no turns', () => {
    const blocks = [{ type: 'feature', taskId: 'task-1' }];
    expect(hasFeatureMessages(blocks, () => [], 'task-1')).toBe(false);
  });

  it('returns true when block exists and has turns', () => {
    const blocks = [{ type: 'feature', taskId: 'task-1' }];
    expect(hasFeatureMessages(blocks, () => [{ type: 'turn' }], 'task-1')).toBe(true);
  });

  it('returns falsy for null turns', () => {
    const blocks = [{ type: 'feature', taskId: 'task-1' }];
    expect(hasFeatureMessages(blocks, () => null, 'task-1')).toBeFalsy();
  });
});
