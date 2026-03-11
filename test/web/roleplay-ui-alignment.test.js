/**
 * Tests for RolePlay ↔ Crew UI alignment (task-23).
 *
 * Validates that RolePlayChatView includes the same UI features as CrewChatView:
 *   P1-1: Input area status bar (Round / Tokens)
 *   P1-2: AskUserQuestion hint bar (pendingAsks / currentPendingAsk / dismissPendingAsk)
 *   P1-3: History message loading (3-tier: loading → hidden blocks → disk history)
 *   P1-9: AskUserQuestion answer handling in rolePlayInput.js
 *   P2-4: Feature header +N more overflow indicator
 *   P2-5: isFeatureExpanded hasPendingAsk check
 *   P2-6: Round divider in feature history
 *   Server: roleplay_status forwarding + frontend handling
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const ROOT = resolve(__dirname, '../..');

function readSrc(relPath) {
  return readFileSync(resolve(ROOT, relPath), 'utf-8');
}

// ─── Source-level structural checks ──────────────────────────────────

describe('RolePlayChatView template alignment', () => {
  const src = readSrc('web/components/RolePlayChatView.js');

  // P1-1: Input area status bar
  it('has crew-input-hints with round and token display', () => {
    expect(src).toContain('crew-input-hints');
    expect(src).toContain('rolePlayStatus.round');
    expect(src).toContain('formatTokens(totalTokens)');
  });

  // P1-2: AskUserQuestion hint bar
  it('has crew-ask-hint bar with pending ask display', () => {
    expect(src).toContain('crew-ask-hint');
    expect(src).toContain('currentPendingAsk');
    expect(src).toContain("$t('crew.askingYou')");
    expect(src).toContain('crew-ask-hint-dismiss');
  });

  // P1-3: History loading — 3-tier template
  it('has 3-tier history loading template', () => {
    expect(src).toContain('scroll.isLoadingHistory.value');
    expect(src).toContain('crew-load-more-loading');
    expect(src).toContain('crew-typing-dot');
    expect(src).toContain('scroll.hiddenBlockCount.value');
    expect(src).toContain('scroll.hasOlderMessages.value');
    expect(src).toContain("$t('crew.loadHistory')");
  });

  // P2-4: Feature header +N more overflow
  it('has +N more overflow indicator in feature header', () => {
    expect(src).toContain('crew-feature-active-more');
    expect(src).toContain('block.activeRoles.length > 3');
    expect(src).toContain('block.activeRoles.length - 3');
  });

  // P2-5: isFeatureExpanded includes hasPendingAsk
  it('checks hasPendingAsk in isFeatureExpanded', () => {
    expect(src).toContain('block.hasPendingAsk');
    // Verify it's before hasStreaming (same order as CrewChatView)
    const pendingIdx = src.indexOf('block.hasPendingAsk');
    const streamingIdx = src.indexOf('block.hasStreaming', pendingIdx);
    expect(pendingIdx).toBeGreaterThan(0);
    expect(streamingIdx).toBeGreaterThan(pendingIdx);
  });

  // P2-6: Round divider in feature history
  it('has round divider in feature history section', () => {
    // The round divider should appear inside the feature history div
    const historyIdx = src.indexOf('crew-feature-history"');
    expect(historyIdx).toBeGreaterThan(0);
    const afterHistory = src.substring(historyIdx, historyIdx + 800);
    expect(afterHistory).toContain('crew-round-divider');
    expect(afterHistory).toContain('getMaxRound(turn)');
    expect(afterHistory).toContain('crew-round-label');
  });
});

describe('RolePlayChatView computed properties', () => {
  const src = readSrc('web/components/RolePlayChatView.js');

  it('has rolePlayStatus computed property', () => {
    expect(src).toContain('rolePlayStatus()');
    expect(src).toContain('store.rolePlayStatuses');
  });

  it('has totalTokens computed property', () => {
    expect(src).toContain('totalTokens()');
    expect(src).toContain('store.contextUsage');
  });

  it('has pendingAsks computed property', () => {
    expect(src).toContain('pendingAsks()');
    expect(src).toContain('askAnswered');
    expect(src).toContain('askRequestId');
  });

  it('has currentPendingAsk computed property', () => {
    expect(src).toContain('currentPendingAsk()');
    expect(src).toContain('this.pendingAsks');
  });

  it('has dismissPendingAsk method', () => {
    expect(src).toContain('dismissPendingAsk()');
    expect(src).toContain('askMsg.askAnswered = true');
    expect(src).toContain('_dismissed');
  });

  it('has loadHistory method', () => {
    expect(src).toContain('loadHistory()');
    expect(src).toContain('scroll.loadHistory');
  });
});

// ─── Server forwarding ───────────────────────────────────────────────

describe('Server forwards roleplay_status messages', () => {
  const src = readSrc('server/handlers/agent-output.js');

  it('handles roleplay_status message type', () => {
    expect(src).toContain("case 'roleplay_status':");
    expect(src).toContain('forwardToClients');
  });

  it('handles roleplay_route message type', () => {
    expect(src).toContain("case 'roleplay_route':");
  });

  it('handles roleplay_waiting_human message type', () => {
    expect(src).toContain("case 'roleplay_waiting_human':");
  });
});

// ─── Frontend message handler ────────────────────────────────────────

describe('Frontend handles roleplay_status messages', () => {
  const src = readSrc('web/stores/helpers/messageHandler.js');

  it('has roleplay_status case in message handler', () => {
    expect(src).toContain("case 'roleplay_status':");
    expect(src).toContain('rolePlayStatuses');
  });

  it('stores round from roleplay_status', () => {
    expect(src).toContain('msg.round');
  });

  it('stores currentRole from roleplay_status', () => {
    expect(src).toContain('msg.currentRole');
  });
});

// ─── Store state ─────────────────────────────────────────────────────

describe('Store has rolePlayStatuses state', () => {
  const src = readSrc('web/stores/chat.js');

  it('declares rolePlayStatuses in state', () => {
    expect(src).toContain('rolePlayStatuses: {}');
  });
});

// ─── Cleanup on conversation delete ──────────────────────────────────

describe('rolePlayStatuses cleanup on delete', () => {
  it('conversation.js cleans up rolePlayStatuses', () => {
    const src = readSrc('web/stores/helpers/conversation.js');
    expect(src).toContain('delete store.rolePlayStatuses[conversationId]');
  });

  it('conversationHandler.js cleans up rolePlayStatuses', () => {
    const src = readSrc('web/stores/helpers/handlers/conversationHandler.js');
    expect(src).toContain('rolePlayStatuses');
  });
});

// ─── Crew parity: structural comparison ──────────────────────────────

describe('RolePlay template matches Crew template structure', () => {
  const rpSrc = readSrc('web/components/RolePlayChatView.js');
  const crewSrc = readSrc('web/components/CrewChatView.js');

  it('both have crew-input-hints', () => {
    expect(rpSrc).toContain('crew-input-hints');
    expect(crewSrc).toContain('crew-input-hints');
  });

  it('both have crew-ask-hint', () => {
    expect(rpSrc).toContain('crew-ask-hint');
    expect(crewSrc).toContain('crew-ask-hint');
  });

  it('both have crew-feature-active-more', () => {
    expect(rpSrc).toContain('crew-feature-active-more');
    expect(crewSrc).toContain('crew-feature-active-more');
  });

  it('both check hasPendingAsk in isFeatureExpanded', () => {
    expect(rpSrc).toContain('hasPendingAsk');
    expect(crewSrc).toContain('hasPendingAsk');
  });

  it('both have round divider in feature history', () => {
    // Both should have crew-round-divider inside crew-feature-history
    const rpHistorySection = rpSrc.substring(
      rpSrc.indexOf('crew-feature-history"'),
      rpSrc.indexOf('crew-feature-history"') + 800
    );
    const crewHistorySection = crewSrc.substring(
      crewSrc.indexOf('crew-feature-history"'),
      crewSrc.indexOf('crew-feature-history"') + 800
    );
    expect(rpHistorySection).toContain('crew-round-divider');
    expect(crewHistorySection).toContain('crew-round-divider');
  });

  it('both have 3-tier history loading', () => {
    expect(rpSrc).toContain('isLoadingHistory');
    expect(crewSrc).toContain('isLoadingHistory');
    expect(rpSrc).toContain('hasOlderMessages');
    expect(crewSrc).toContain('hasOlderMessages');
  });

  it('both have dismissPendingAsk method', () => {
    expect(rpSrc).toContain('dismissPendingAsk');
    expect(crewSrc).toContain('dismissPendingAsk');
  });

  it('both have loadHistory method', () => {
    expect(rpSrc).toContain('loadHistory');
    expect(crewSrc).toContain('loadHistory');
  });
});

// ─── P1-9: AskUserQuestion answer handling in rolePlayInput ──────────

describe('P1-9: rolePlayInput handles AskUserQuestion answers', () => {
  const rpInputSrc = readSrc('web/components/crew/rolePlayInput.js');
  const crewInputSrc = readSrc('web/components/crew/crewInput.js');

  it('rolePlayInput accepts getCurrentPendingAsk in factory', () => {
    expect(rpInputSrc).toContain('getCurrentPendingAsk');
  });

  it('rolePlayInput calls answerUserQuestion when pending ask exists', () => {
    expect(rpInputSrc).toContain('store.answerUserQuestion');
    expect(rpInputSrc).toContain('ask.askMsg.askRequestId');
  });

  it('rolePlayInput builds answers from questions like crewInput', () => {
    // Both should map text to each question
    expect(rpInputSrc).toContain('answers[q.question] = text');
    expect(crewInputSrc).toContain('answers[q.question] = text');
  });

  it('rolePlayInput marks ask as answered after answering', () => {
    expect(rpInputSrc).toContain('ask.askMsg.askAnswered = true');
    expect(rpInputSrc).toContain('ask.askMsg.selectedAnswers = answers');
  });

  it('RolePlayChatView passes getCurrentPendingAsk to input factory', () => {
    const rpViewSrc = readSrc('web/components/RolePlayChatView.js');
    expect(rpViewSrc).toContain('getCurrentPendingAsk: () => this.currentPendingAsk');
  });

  it('both inputs have the same answer-building pattern', () => {
    // Both should handle the case of no questions with a fallback key
    expect(rpInputSrc).toContain("answers['response'] = text");
    expect(crewInputSrc).toContain("answers['response'] = text");
  });
});
