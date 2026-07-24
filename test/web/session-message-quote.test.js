import { describe, expect, it } from 'vitest';
import {
  formatSessionMessageDateTime,
  normalizeSessionMessageQuote,
  quoteFromAssistantTurn,
  quoteFromUserMessage,
} from '../../web/utils/session-message-quote.js';

describe('Session message quotes', () => {
  it('formats message timestamps with year, month, day, hour and minute', () => {
    const formatted = formatSessionMessageDateTime(Date.UTC(2026, 6, 24, 3, 5));
    expect(formatted).toContain('2026');
    expect(formatted).toMatch(/07|7/);
    expect(formatted).toMatch(/24/);
  });

  it('builds a user quote without mutating the source message', () => {
    const message = { id: 'm1', content: 'original', timestamp: 1234567890000 };
    const quote = quoteFromUserMessage(message, 'You');
    expect(quote).toEqual({
      id: 'm1', role: 'user', author: 'You', content: 'original', timestamp: 1234567890000,
    });
    expect(message).not.toHaveProperty('role');
  });

  it('captures the latest TodoWrite snapshot on an assistant turn', () => {
    const quote = quoteFromAssistantTurn({
      id: 'turn-1',
      textContent: 'implementation update',
      speakerTimestamp: 1234567890000,
      todoMsg: { toolInput: { todos: [
        { content: 'Inspect', status: 'completed' },
        { content: 'Test', activeForm: 'Testing', status: 'in_progress' },
      ] } },
    }, 'Linus');
    expect(quote.todos).toEqual([
      { content: 'Inspect', status: 'completed' },
      { content: 'Test', activeForm: 'Testing', status: 'in_progress' },
    ]);
  });

  it('rejects empty quotes and normalizes unsafe fields', () => {
    expect(normalizeSessionMessageQuote({ content: '   ', todos: [] })).toBeNull();
    expect(normalizeSessionMessageQuote({
      role: 'other', author: ' User ', content: ' text ', todos: [{ content: ' x ', status: 'unknown' }],
    })).toMatchObject({
      role: 'user', author: 'User', content: 'text', todos: [{ content: 'x', status: 'pending' }],
    });
  });
});
