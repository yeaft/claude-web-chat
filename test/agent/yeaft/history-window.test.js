import { describe, expect, it } from 'vitest';
import {
  estimateContentPartTokens,
  estimateMessageTokens,
  estimateMessagesTokens,
  stripToolNoiseFromOlderTurns,
  trimSnapshotForBudget,
} from '../../../agent/yeaft/history-window.js';

describe('deterministic provider history window', () => {
  it('counts text, image, and document content parts instead of treating arrays as zero', () => {
    const textPart = { type: 'text', text: 'x'.repeat(100_000) };
    const imagePart = {
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: 'a'.repeat(100_000) },
    };
    const documentPart = {
      type: 'document',
      title: 'requirements.pdf',
      source: { type: 'base64', media_type: 'application/pdf', data: 'b'.repeat(100_000) },
    };

    expect(estimateContentPartTokens(textPart)).toBeGreaterThan(10_000);
    expect(estimateContentPartTokens(imagePart)).toBeGreaterThan(6_000);
    expect(estimateContentPartTokens(documentPart)).toBeGreaterThan(6_000);
    expect(estimateMessageTokens({ role: 'user', content: [textPart, imagePart, documentPart] })).toBeGreaterThan(20_000);
  });

  it('bounds a single oversized multimodal message without sending the full part', () => {
    const messages = [{
      role: 'user',
      content: [{
        type: 'text',
        text: 'x'.repeat(100_000),
      }, {
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: 'a'.repeat(100_000) },
      }],
    }];

    const window = trimSnapshotForBudget(messages, { messageTokenBudget: 100 });

    expect(estimateMessagesTokens(window)).toBeLessThanOrEqual(100);
    expect(JSON.stringify(window)).not.toContain('a'.repeat(1_000));
    expect(messages[0].content[0].text).toHaveLength(100_000);
  });

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
