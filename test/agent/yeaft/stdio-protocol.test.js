import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import {
  createJsonlWriter,
  extractPrompt,
  JsonlInput,
  runStreamTurn,
  selectedSkills,
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

  it('rejects a pending prompt read when stdin contains invalid JSON', async () => {
    const stdin = new PassThrough();
    const input = new JsonlInput(stdin);
    const pending = input.nextPrompt();
    stdin.end('{not-json}\n');
    await expect(pending).rejects.toThrow('Invalid stream-json input');
  });

  it('reports explicit and automatically matched skills', () => {
    const rows = [{ name: 'review', description: 'Review code' }];
    const manager = {
      has: name => name === 'review',
      list: () => rows,
      findRelevant: () => [{ name: 'review', description: 'Review code', _tier: 'project' }],
    };
    expect(selectedSkills(manager, '/review now')).toEqual([{ ...rows[0], explicit: true }]);
    expect(selectedSkills(manager, 'please inspect')).toEqual([
      expect.objectContaining({ name: 'review', explicit: false, tier: 'project' }),
    ]);
  });

  it('maps text, TodoWrite, tools, usage and final result', async () => {
    const { events: output, write } = captureWriter();
    const engine = {
      query: () => events([
        { type: 'turn_open', turnId: 'turn-1', threadId: 'main', at: 10 },
        { type: 'text_delta', text: 'Working' },
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
