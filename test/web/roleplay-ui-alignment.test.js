/**
 * Tests for RolePlay ↔ Crew UI alignment.
 *
 * Validates business logic:
 *   P1-2: pendingAsks / dismissPendingAsk
 *   P1-9: AskUserQuestion answer handling in rolePlayInput.js
 *   Server: roleplay_status forwarding + frontend handling
 *   Store: rolePlayStatuses state and cleanup
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const ROOT = resolve(__dirname, '../..');

function readSrc(relPath) {
  return readFileSync(resolve(ROOT, relPath), 'utf-8');
}

// ─── Computed properties ─────────────────────────────────────────────

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
  });

  it('has loadHistory method', () => {
    expect(src).toContain('loadHistory()');
    expect(src).toContain('scroll.loadHistory');
  });
});

// ─── Server forwarding ───────────────────────────────────────────────

describe('Server forwards roleplay messages', () => {
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

  it('stores round and currentRole from roleplay_status', () => {
    expect(src).toContain('msg.round');
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
});
