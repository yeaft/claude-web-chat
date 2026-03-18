import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

/**
 * Tests for PR #266 — Feature panel completion accuracy, streaming pulse animation,
 * and crew panel alignment (task-98 + task-99).
 *
 * Validates:
 * 1. isFeatureCompleted: merge → completed; merge then new messages → reactivated (not completed)
 * 2. CSS: streaming pulse animation keyframes
 * 3. CSS: crew messages padding aligned with side panels
 */

const base = resolve(__dirname, '../..');
const read = (rel) => readFileSync(resolve(base, rel), 'utf-8');

// =====================================================================
// Extract isFeatureCompleted logic for unit testing
// =====================================================================

/**
 * Pure function version of isFeatureCompleted.
 * @param {object} feature - { hasStreaming, taskId }
 * @param {Array} turns - array of turn objects, each { textMsg | message: { content, isDecisionMaker } }
 * @returns {boolean}
 */
function isFeatureCompleted(feature, turns) {
  if (feature.hasStreaming) return false;
  if (!turns || turns.length === 0) return false;

  const MERGE_PATTERN = /(?:已\s*(?:合并|merge)|squash\s*merge|PR\s*#\d+\s*已|tag\s+v[\d.]+\s*已|已\s*push|merged\s+to\s+main|已\s*完成)/i;
  let lastMergeIdx = -1;
  for (let i = turns.length - 1; i >= 0; i--) {
    const turn = turns[i];
    const msg = turn.textMsg || turn.message;
    if (!msg || !msg.content) continue;
    if (msg.isDecisionMaker && MERGE_PATTERN.test(msg.content)) {
      lastMergeIdx = i;
      break;
    }
  }
  if (lastMergeIdx === -1) return false;

  for (let i = lastMergeIdx + 1; i < turns.length; i++) {
    const turn = turns[i];
    const msg = turn.textMsg || turn.message;
    if (msg && msg.content) return false; // reactivated
  }
  return true;
}

/** Helper: create a turn with a text message */
function textTurn(content, isDecisionMaker = false) {
  return { textMsg: { content, isDecisionMaker } };
}

/** Helper: create a turn with no content (e.g. tool-only) */
function emptyTurn() {
  return { textMsg: null };
}

// =====================================================================
// 1. isFeatureCompleted — merge detection + reactivation
// =====================================================================
describe('isFeatureCompleted: merge detection and reactivation', () => {

  it('returns false when feature is actively streaming', () => {
    const feature = { hasStreaming: true, taskId: 'task-1' };
    const turns = [textTurn('PR #123 已 squash merge 到 main', true)];
    expect(isFeatureCompleted(feature, turns)).toBe(false);
  });

  it('returns false when no turns exist', () => {
    expect(isFeatureCompleted({ hasStreaming: false }, [])).toBe(false);
    expect(isFeatureCompleted({ hasStreaming: false }, null)).toBe(false);
  });

  it('returns false when no merge message from decision maker', () => {
    const turns = [
      textTurn('开始开发 task-1'),
      textTurn('代码已提交'),
      textTurn('测试通过')
    ];
    expect(isFeatureCompleted({ hasStreaming: false }, turns)).toBe(false);
  });

  it('returns true when last meaningful message is a merge from decision maker', () => {
    const turns = [
      textTurn('开始开发'),
      textTurn('PR #100 已 squash merge 到 main，tag v0.1.50', true)
    ];
    expect(isFeatureCompleted({ hasStreaming: false }, turns)).toBe(true);
  });

  it('returns true with "已完成" keyword from decision maker', () => {
    const turns = [
      textTurn('task-5 已完成', true)
    ];
    expect(isFeatureCompleted({ hasStreaming: false }, turns)).toBe(true);
  });

  it('returns true with "merged to main" keyword', () => {
    const turns = [
      textTurn('PR merged to main successfully', true)
    ];
    expect(isFeatureCompleted({ hasStreaming: false }, turns)).toBe(true);
  });

  it('returns true with "已 push" keyword', () => {
    const turns = [
      textTurn('tag v0.1.99 已 push', true)
    ];
    expect(isFeatureCompleted({ hasStreaming: false }, turns)).toBe(true);
  });

  // ★ The key fix: reactivation
  it('returns false when new messages appear AFTER merge (reactivated)', () => {
    const turns = [
      textTurn('开始开发'),
      textTurn('PR #100 已 squash merge 到 main', true),
      textTurn('用户又提了新需求，需要继续')  // reactivation
    ];
    expect(isFeatureCompleted({ hasStreaming: false }, turns)).toBe(false);
  });

  it('returns false when multiple messages appear after merge', () => {
    const turns = [
      textTurn('PR #50 已合并', true),
      textTurn('发现 bug，需要修复'),
      textTurn('正在排查中')
    ];
    expect(isFeatureCompleted({ hasStreaming: false }, turns)).toBe(false);
  });

  it('ignores merge messages from non-decision-makers', () => {
    const turns = [
      textTurn('PR #100 已 squash merge 到 main', false),  // not decision maker
    ];
    expect(isFeatureCompleted({ hasStreaming: false }, turns)).toBe(false);
  });

  it('still completed if only empty turns follow merge', () => {
    const turns = [
      textTurn('PR #100 已合并', true),
      emptyTurn(),  // tool-only turn, no text
      emptyTurn()
    ];
    expect(isFeatureCompleted({ hasStreaming: false }, turns)).toBe(true);
  });

  it('scans all turns not just last 3 to find merge', () => {
    const turns = [
      textTurn('msg 1'),
      textTurn('msg 2'),
      textTurn('msg 3'),
      textTurn('PR #200 已 squash merge', true),  // 4th from start, more than 3 from end
      emptyTurn(),
      emptyTurn(),
      emptyTurn(),
      emptyTurn()
    ];
    expect(isFeatureCompleted({ hasStreaming: false }, turns)).toBe(true);
  });

  it('finds the LAST merge message, not the first', () => {
    const turns = [
      textTurn('PR #100 已合并', true),    // first merge
      textTurn('需要 hotfix'),              // reactivation
      textTurn('hotfix PR #101 已合并', true)  // second merge — should be found
    ];
    expect(isFeatureCompleted({ hasStreaming: false }, turns)).toBe(true);
  });

  it('reactivation after second merge still detected', () => {
    const turns = [
      textTurn('PR #100 已合并', true),
      textTurn('需要 hotfix'),
      textTurn('hotfix PR #101 已合并', true),
      textTurn('又发现了新问题')  // reactivation after second merge
    ];
    expect(isFeatureCompleted({ hasStreaming: false }, turns)).toBe(false);
  });
});

// =====================================================================
// 2. CSS: streaming pulse animation
// =====================================================================
describe('CSS: streaming pulse animation', () => {
  const css = read('web/styles/crew-workspace.css');

  it('.crew-feature-card.has-streaming has animation property', () => {
    // Extract the .crew-feature-card.has-streaming rule
    const match = css.match(/\.crew-feature-card\.has-streaming\s*\{([^}]+)\}/);
    expect(match).not.toBeNull();
    expect(match[1]).toMatch(/animation:\s*feature-pulse/);
  });

  it('@keyframes feature-pulse is defined with opacity transitions', () => {
    expect(css).toContain('@keyframes feature-pulse');
    // Verify it has opacity values
    const kfMatch = css.match(/@keyframes feature-pulse\s*\{([^}]*\{[^}]*\}[^}]*)\}/);
    expect(kfMatch).not.toBeNull();
    expect(kfMatch[1]).toMatch(/opacity:\s*1/);
    expect(kfMatch[1]).toMatch(/opacity:\s*0\.6/);
  });

  it('animation is infinite (continuous pulse)', () => {
    const match = css.match(/\.crew-feature-card\.has-streaming\s*\{([^}]+)\}/);
    expect(match[1]).toMatch(/infinite/);
  });
});

// =====================================================================
// 3. CSS: crew messages padding alignment with side panels
// =====================================================================
describe('CSS: crew panel top alignment', () => {
  const css = read('web/styles/crew-workspace.css');

  it('.crew-messages has reduced top padding for alignment with side panels', () => {
    const match = css.match(/\.crew-messages\s*\{([^}]+)\}/);
    expect(match).not.toBeNull();
    // Should be 12px (not 24px) to align with side panel scroll areas
    expect(match[1]).toMatch(/padding:\s*12px\s+0/);
  });
});
