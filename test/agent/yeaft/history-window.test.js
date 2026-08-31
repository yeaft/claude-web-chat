import { describe, expect, it } from 'vitest';
import {
  estimateContentPartTokens,
  estimateMessageTokens,
  estimateMessagesTokens,
  estimateContentTokens,
  stripToolNoiseFromOlderTurns,
  trimSnapshotForBudget,
} from '../../../agent/yeaft/history-window.js';

describe('deterministic provider history window', () => {
  it('counts signed thinking blocks and JSON-serialized function outputs', () => {
    const thinking = {
      thinking: 'x'.repeat(100_000),
      signature: 'signature',
    };
    const functionOutput = {
      type: 'function_call_output',
      output: { payload: 'y'.repeat(100_000) },
    };

    expect(estimateMessageTokens({ role: 'assistant', content: 'done', thinkingBlocks: [thinking] })).toBeGreaterThan(20_000);
    expect(estimateContentPartTokens(functionOutput)).toBeGreaterThan(20_000);
    expect(estimateContentTokens([functionOutput])).toBeGreaterThan(20_000);
  });

  it('drops a signed thinking/tool arc atomically when its replay cannot fit', () => {
    const messages = [
      { role: 'user', content: 'run the tool' },
      {
        role: 'assistant',
        content: '',
        thinkingBlocks: [{ thinking: 'x'.repeat(100_000), signature: 'opaque-signature' }],
        toolCalls: [{ id: 'call-signed', name: 'Inspect', input: {} }],
      },
      { role: 'tool', toolCallId: 'call-signed', content: 'tool result' },
    ];

    const window = trimSnapshotForBudget(messages, { messageTokenBudget: 100 });

    expect(estimateMessagesTokens(window)).toBeLessThanOrEqual(100);
    expect(window).toEqual([{ role: 'user', content: 'run the tool' }]);
    expect(JSON.stringify(window)).not.toContain('opaque-signature');
    expect(messages[1].thinkingBlocks[0].thinking).toHaveLength(100_000);
  });

  it('drops an oversized signed thinking block as an atomic replay unit', () => {
    const thinking = [{
      role: 'assistant',
      content: 'answer',
      thinkingBlocks: [{ thinking: 'x'.repeat(100_000), signature: 'opaque-signature' }],
    }];

    const window = trimSnapshotForBudget(thinking, { messageTokenBudget: 100 });

    expect(estimateMessagesTokens(window)).toBeLessThanOrEqual(100);
    expect(window).toEqual([{ role: 'assistant', content: 'answer' }]);
    expect(JSON.stringify(window)).not.toContain('opaque-signature');
    expect(thinking[0].thinkingBlocks[0].thinking).toHaveLength(100_000);
  });

  it('bounds object-valued function_call_output before Responses JSON serialization', () => {
    const messages = [{
      role: 'user',
      content: [{
        type: 'function_call_output',
        output: { payload: 'y'.repeat(100_000) },
      }],
    }];

    const window = trimSnapshotForBudget(messages, { messageTokenBudget: 100 });

    expect(estimateMessagesTokens(window)).toBeLessThanOrEqual(100);
    expect(JSON.stringify(window)).not.toContain('y'.repeat(1_000));
    expect(messages[0].content[0].output.payload).toHaveLength(100_000);
  });

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

  it('retains recent dialogue turns by shrinking text before deleting below the floor', () => {
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

    expect(window).toHaveLength(4);
    expect(window.map(message => message.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(window[0].content).toMatch(/^a+/);
    expect(window[1].content).toMatch(/^b+/);
    expect(window[2].content).toMatch(/^c+/);
    expect(window[3].content).toMatch(/^d+/);
    expect(estimateMessagesTokens(window)).toBeLessThanOrEqual(55);
  });

  it('drops tool payload before evicting the five most recent dialogue turns', () => {
    const messages = [];
    for (let turn = 1; turn <= 7; turn += 1) {
      messages.push({ role: 'user', content: `question ${turn} ${'q'.repeat(80)}` });
      if (turn === 7) {
        messages.push({
          role: 'assistant',
          content: `answer ${turn} ${'a'.repeat(80)}`,
          toolCalls: [{ id: 'huge-call', name: 'Bash', input: { command: 'inspect' } }],
        });
        messages.push({ role: 'tool', toolCallId: 'huge-call', content: 'x'.repeat(100_000) });
      } else {
        messages.push({ role: 'assistant', content: `answer ${turn} ${'a'.repeat(80)}` });
      }
    }

    const window = trimSnapshotForBudget(messages, {
      recentTurnCap: 25,
      messageTokenBudget: 180,
    });

    const users = window.filter(message => message.role === 'user');
    const assistants = window.filter(message => message.role === 'assistant');
    expect(users).toHaveLength(5);
    expect(assistants).toHaveLength(5);
    expect(users.map(message => message.content.match(/^question \d+/)?.[0])).toEqual([
      'question 3',
      'question 4',
      'question 5',
      'question 6',
      'question 7',
    ]);
    expect(assistants.map(message => message.content.match(/^answer \d+/)?.[0])).toEqual([
      'answer 3',
      'answer 4',
      'answer 5',
      'answer 6',
      'answer 7',
    ]);
    expect(window.some(message => message.role === 'tool')).toBe(false);
    expect(window.some(message => Array.isArray(message.toolCalls) && message.toolCalls.length > 0)).toBe(false);
    expect(estimateMessagesTokens(window)).toBeLessThanOrEqual(180);

    // Engine and bridge both shape provider snapshots. Re-trimming (including
    // after a model/config change) must not erode the retained dialogue again.
    expect(trimSnapshotForBudget(window, {
      recentTurnCap: 25,
      messageTokenBudget: 180,
    })).toEqual(window);
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
