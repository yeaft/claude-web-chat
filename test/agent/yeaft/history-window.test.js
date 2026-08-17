import { describe, expect, it } from 'vitest';
import {
  estimateMessagesTokens,
  stripToolNoiseFromOlderTurns,
  trimSnapshotForBudget,
} from '../../../agent/yeaft/history-window.js';

describe('deterministic provider history window', () => {
  it('keeps the newest complete turns without generating a summary', () => {
    const messages = [
      { role: 'user', content: 'old question' },
      { role: 'assistant', content: 'old answer' },
      { role: 'user', content: 'middle question' },
      { role: 'assistant', content: 'middle answer' },
      { role: 'user', content: 'new question' },
      { role: 'assistant', content: 'new answer' },
    ];

    const window = trimSnapshotForBudget(messages, {
      recentTurnCap: 2,
      messageTokenBudget: 10_000,
    });

    expect(window.map(message => message.content)).toEqual([
      'middle question',
      'middle answer',
      'new question',
      'new answer',
    ]);
    expect(window.some(message => String(message.content).includes('conversation_summary'))).toBe(false);
    expect(messages).toHaveLength(6);
  });

  it('drops oldest turns until the deterministic token budget fits', () => {
    const messages = [
      { role: 'user', content: 'a'.repeat(100) },
      { role: 'assistant', content: 'b'.repeat(100) },
      { role: 'user', content: 'c'.repeat(100) },
      { role: 'assistant', content: 'd'.repeat(100) },
    ];

    const window = trimSnapshotForBudget(messages, {
      recentTurnCap: 10,
      messageTokenBudget: 55,
    });

    expect(window.map(message => message.content)).toEqual([
      'c'.repeat(100),
      'd'.repeat(100),
    ]);
    expect(estimateMessagesTokens(window)).toBeLessThanOrEqual(55);
  });

  it('removes old tool noise but preserves recent tool pairs', () => {
    const messages = [
      { role: 'user', content: 'old task' },
      {
        role: 'assistant',
        content: 'old tool answer',
        toolCalls: [{ id: 'old-call', name: 'Bash', input: { command: 'pwd' } }],
      },
      { role: 'tool', toolCallId: 'old-call', content: 'old result' },
      { role: 'user', content: 'current task' },
      {
        role: 'assistant',
        content: 'current tool answer',
        toolCalls: [{ id: 'current-call', name: 'Bash', input: { command: 'pwd' } }],
      },
      { role: 'tool', toolCallId: 'current-call', content: 'current result' },
    ];

    const window = stripToolNoiseFromOlderTurns(messages, { keepToolTurns: 1 });

    expect(window).toEqual([
      { role: 'user', content: 'old task' },
      { role: 'assistant', content: 'old tool answer' },
      { role: 'user', content: 'current task' },
      {
        role: 'assistant',
        content: 'current tool answer',
        toolCalls: [{ id: 'current-call', name: 'Bash', input: { command: 'pwd' } }],
      },
      { role: 'tool', toolCallId: 'current-call', content: 'current result' },
    ]);
    expect(messages[1].toolCalls).toHaveLength(1);
  });
});
