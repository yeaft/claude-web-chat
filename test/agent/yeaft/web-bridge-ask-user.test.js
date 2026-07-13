import { afterEach, describe, expect, it } from 'vitest';
import {
  __testHooks,
  handleYeaftAskUserAnswer,
} from '../../../agent/yeaft/web-bridge.js';

afterEach(() => {
  __testHooks.resetPendingUserPrompts();
});

describe('Yeaft AskUser response routing', () => {
  it('resolves only the prompt owned by the exact Session and VP turn', async () => {
    const result = __testHooks.seedPendingUserPrompt({
      requestId: 'ask-1',
      sessionId: 'session-a',
      vpId: 'vp-a',
      threadId: 'thread-a',
      turnId: 'turn-a',
    });

    expect(handleYeaftAskUserAnswer({
      requestId: 'ask-1',
      sessionId: 'session-b',
      vpId: 'vp-a',
      threadId: 'thread-a',
      turnId: 'turn-a',
      answers: { Continue: 'No' },
    })).toBe(false);

    expect(handleYeaftAskUserAnswer({
      requestId: 'ask-1',
      sessionId: 'session-a',
      vpId: 'vp-a',
      threadId: 'thread-a',
      turnId: 'turn-a',
      answers: { Continue: 'Yes' },
    })).toBe(true);
    await expect(result).resolves.toEqual({ Continue: 'Yes' });
  });

  it('ignores unknown or already-resolved request ids', async () => {
    const result = __testHooks.seedPendingUserPrompt({ requestId: 'ask-once' });
    expect(handleYeaftAskUserAnswer({ requestId: 'ask-once', answers: { answer: 'ok' } })).toBe(true);
    await result;
    expect(handleYeaftAskUserAnswer({ requestId: 'ask-once', answers: { answer: 'again' } })).toBe(false);
    expect(handleYeaftAskUserAnswer({ requestId: 'missing' })).toBe(false);
  });
});
