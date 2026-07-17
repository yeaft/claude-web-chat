import { afterEach, describe, expect, it } from 'vitest';
import ctx from '../../../agent/context.js';
import {
  __testHooks,
  handleYeaftAskUserAnswer,
} from '../../../agent/yeaft/web-bridge.js';

afterEach(() => {
  __testHooks.resetPendingUserPrompts();
  ctx.messageBuffer.length = 0;
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

  it('replays an unexpired prompt when another device loads the Session', () => {
    ctx.messageBuffer.length = 0;
    __testHooks.seedPendingUserPrompt({
      requestId: 'ask-replay',
      sessionId: 'session-a',
      vpId: 'vp-a',
      threadId: 'thread-a',
      turnId: 'turn-a',
      question: 'Pick one',
      options: ['A', 'B'],
      createdAt: 100,
      expiresAt: Date.now() + 60_000,
    });

    __testHooks.replayPendingUserPrompts('session-a');

    const replay = ctx.messageBuffer.find(msg => msg?.event?.requestId === 'ask-replay');
    expect(replay).toMatchObject({
      type: 'yeaft_output',
      sessionId: 'session-a',
      vpId: 'vp-a',
      threadId: 'thread-a',
      turnId: 'turn-a',
      event: {
        type: 'ask_user_question',
        replay: true,
        requestId: 'ask-replay',
        createdAt: 100,
        questions: [{ question: 'Pick one' }],
      },
    });
  });

  it('expires a prompt once and rejects answers that arrive after timeout', async () => {
    ctx.messageBuffer.length = 0;
    const result = __testHooks.seedPendingUserPrompt({
      requestId: 'ask-expired',
      sessionId: 'session-a',
      vpId: 'vp-a',
      threadId: 'thread-a',
      turnId: 'turn-a',
    });

    expect(__testHooks.settlePendingUserPromptForTest('ask-expired', { timedOut: true })).toBe(true);
    await expect(result).resolves.toEqual({ __yeaftTimedOut: true });
    expect(handleYeaftAskUserAnswer({ requestId: 'ask-expired', answers: { answer: 'late' } })).toBe(false);
    expect(ctx.messageBuffer.find(msg => msg?.event?.type === 'ask_user_expired')).toMatchObject({
      sessionId: 'session-a',
      vpId: 'vp-a',
      turnId: 'turn-a',
    });
  });
});
