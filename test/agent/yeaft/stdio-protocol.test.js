import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import {
  createJsonlWriter,
  extractPrompt,
  JsonlInput,
  runStreamTurn,
} from '../../../agent/yeaft/stdio-protocol.js';

function captureWriter() {
  const events = [];
  return { events, write: event => events.push(event) };
}

async function* events(items) {
  for (const item of items) yield item;
}

describe('Yeaft stdio stream-json protocol', () => {
  it('extracts prompts from supported JSONL user envelopes', () => {
    expect(extractPrompt({ type: 'prompt', prompt: 'one' })).toBe('one');
    expect(extractPrompt({ type: 'user', message: { content: [{ type: 'text', text: 'two' }] } })).toBe('two');
    expect(extractPrompt({ type: 'user', content: 'three' })).toBe('three');
  });

  it('writes exactly one JSON object per line', () => {
    const output = new PassThrough();
    let text = '';
    output.on('data', chunk => { text += chunk.toString(); });
    const write = createJsonlWriter(output);
    write({ type: 'first', value: 1 });
    write({ type: 'second', value: 2 });
    expect(text.trim().split('\n').map(JSON.parse)).toEqual([
      { type: 'first', value: 1 },
      { type: 'second', value: 2 },
    ]);
  });

  it('routes prompts and correlated AskUser responses independently', async () => {
    const stdin = new PassThrough();
    const input = new JsonlInput(stdin);
    stdin.write(`${JSON.stringify({ type: 'user', prompt: 'fix it' })}\n`);
    stdin.write(`${JSON.stringify({ type: 'ask_user_response', request_id: 'req-1', answers: { choice: 'yes' } })}\n`);
    expect(await input.nextPrompt()).toMatchObject({ prompt: 'fix it' });
    expect(await input.waitForAnswer('req-1')).toEqual({ choice: 'yes' });
    stdin.end();
  });

  it('rejects duplicate AskUser request and response ids instead of overwriting correlation state', async () => {
    const pendingInput = new PassThrough();
    const pending = new JsonlInput(pendingInput);
    const first = pending.waitForAnswer('req-duplicate');
    await expect(pending.waitForAnswer('req-duplicate')).rejects.toThrow('Duplicate AskUser request_id');
    pendingInput.write(`${JSON.stringify({ type: 'ask_user_response', request_id: 'req-duplicate', answer: 'yes' })}\n`);
    await expect(first).resolves.toBe('yes');
    pendingInput.end();

    const earlyInput = new PassThrough();
    const early = new JsonlInput(earlyInput);
    const response = JSON.stringify({ type: 'ask_user_response', request_id: 'req-early', answer: 'yes' });
    earlyInput.write(`${response}\n${response}\n`);
    await expect(early.waitForAnswer('req-early')).rejects.toThrow('Duplicate AskUser response request_id');
    earlyInput.end();
  });

  it('rejects a pending prompt read when stdin contains invalid JSON', async () => {
    const stdin = new PassThrough();
    const input = new JsonlInput(stdin);
    const pending = input.nextPrompt();
    stdin.end('{not-json}\n');
    await expect(pending).rejects.toThrow('Invalid stream-json input');
  });

  it('maps text, TodoWrite, tools, usage and final result', async () => {
    const { events: output, write } = captureWriter();
    const engine = {
      query: () => events([
        { type: 'turn_open', turnId: 'turn-1', threadId: 'main', at: 10 },
        { type: 'text_delta', text: 'Working' },
        { type: 'skill_loaded', skill: { name: 'review', explicit: true } },
        { type: 'tool_call', id: 'todo-1', name: 'TodoWrite', input: { todos: [{ content: 'Test', status: 'in_progress', activeForm: 'Testing' }] } },
        { type: 'tool_start', id: 'todo-1', name: 'TodoWrite', input: { todos: [] } },
        { type: 'tool_end', id: 'todo-1', name: 'TodoWrite', output: '{"success":true}', isError: false },
        { type: 'usage', inputTokens: 10, outputTokens: 4, cacheReadTokens: 3, cacheWriteTokens: 2, cacheTokensAreIncludedInInput: false },
        { type: 'stop', stopReason: 'end_turn' },
        { type: 'turn_close', turnId: 'turn-1', totalMs: 25, totalTokens: 19, loopCount: 1 },
      ]),
    };

    const result = await runStreamTurn({
      engine,
      prompt: 'do it',
      sessionId: 'session-1',
      workDir: '/workspace',
      model: 'provider/model',
      modelEffort: 'high',
      write,
    });

    expect(output).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'assistant', subtype: 'text_delta', turn_id: 'turn-1' }),
      expect.objectContaining({ type: 'skill', subtype: 'loaded', skill: { name: 'review', explicit: true } }),
      expect.objectContaining({ type: 'todo', subtype: 'update', tool_use_id: 'todo-1' }),
      expect.objectContaining({ type: 'tool', subtype: 'result', is_error: false }),
      expect.objectContaining({ type: 'usage', usage: expect.objectContaining({ total_tokens: 19 }) }),
    ]));
    expect(result).toMatchObject({
      type: 'result',
      subtype: 'success',
      session_id: 'session-1',
      result: 'Working',
      usage: { input_tokens: 10, output_tokens: 4, cache_read_input_tokens: 3, cache_creation_input_tokens: 2, total_input_tokens: 15, total_tokens: 19 },
    });
  });

  it('accumulates usage without double counting provider-included cache tokens', async () => {
    const { write } = captureWriter();
    const engine = {
      query: () => events([
        { type: 'turn_open', turnId: 'turn-usage' },
        { type: 'usage', inputTokens: 10, outputTokens: 2, cacheReadTokens: 4, cacheWriteTokens: 1, cacheTokensAreIncludedInInput: true },
        { type: 'usage', inputTokens: 3, outputTokens: 1, cacheReadTokens: 2, cacheWriteTokens: 0, cacheTokensAreIncludedInInput: false },
        { type: 'stop', stopReason: 'end_turn' },
      ]),
    };
    const result = await runStreamTurn({ engine, prompt: 'count', sessionId: 'session-usage', write });
    expect(result.usage).toEqual({
      input_tokens: 13,
      output_tokens: 3,
      cache_read_input_tokens: 6,
      cache_creation_input_tokens: 1,
      total_input_tokens: 15,
      total_tokens: 18,
    });
  });

  it('maps authoritative missing-skill errors from the engine', async () => {
    const { events: output, write } = captureWriter();
    const engine = {
      query: () => events([
        { type: 'turn_open', turnId: 'turn-skill' },
        { type: 'skill_error', skillName: 'missing', message: 'Requested skill "missing" was not found.' },
        { type: 'stop', stopReason: 'end_turn' },
      ]),
    };
    await runStreamTurn({ engine, prompt: '/skill:missing inspect', sessionId: 'session-skill', write });
    expect(output).toContainEqual(expect.objectContaining({
      type: 'skill',
      subtype: 'error',
      skill_name: 'missing',
    }));
  });

  it('round-trips AskUser through JSONL while the engine is running', async () => {
    const stdin = new PassThrough();
    const input = new JsonlInput(stdin);
    const { events: output, write } = captureWriter();
    const engine = {
      async *query({ askUser }) {
        yield { type: 'turn_open', turnId: 'turn-ask' };
        const answerPromise = askUser({ question: 'Continue?', options: ['yes', 'no'] });
        await new Promise(resolve => setImmediate(resolve));
        const request = output.find(event => event.type === 'ask_user' && event.subtype === 'request');
        stdin.write(`${JSON.stringify({ type: 'ask_user_response', request_id: request.request_id, answers: { answer: 'yes' } })}\n`);
        const answer = await answerPromise;
        yield { type: 'text_delta', text: answer.answer };
        yield { type: 'stop', stopReason: 'end_turn' };
        yield { type: 'turn_close', turnId: 'turn-ask', totalMs: 5, totalTokens: 0, loopCount: 1 };
      },
    };

    const result = await runStreamTurn({ engine, prompt: 'ask', sessionId: 'session-ask', input, write });
    expect(output).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'ask_user', subtype: 'request', question: 'Continue?' }),
      expect.objectContaining({ type: 'ask_user', subtype: 'response', answers: { answer: 'yes' } }),
    ]));
    expect(result.result).toBe('yes');
    stdin.end();
  });
});
