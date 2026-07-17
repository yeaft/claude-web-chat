import { describe, it, expect, beforeEach } from 'vitest';
import { Engine } from '../../../agent/yeaft/engine.js';
import { NullTrace } from '../../../agent/yeaft/debug-trace.js';
import { LLMAbortError, LLMServerError } from '../../../agent/yeaft/llm/adapter.js';

/**
 * Adapter that yields a queued response per stream() call. Tests push
 * adapter behaviour per loop iteration; the engine pulls them in order.
 */
class QueueAdapter {
  constructor() {
    this.responses = [];
    this.streamCalls = [];
  }
  pushResponse(events) { this.responses.push(events); }
  async *stream(params) {
    this.streamCalls.push({
      messages: JSON.parse(JSON.stringify(params.messages || [])),
    });
    const response = this.responses.shift();
    if (!response) throw new Error('QueueAdapter: no more responses queued');
    if (typeof response === 'function') {
      for await (const event of response(params)) yield event;
      return;
    }
    for (const event of response) yield event;
  }
  async call() { return { text: 'ok', usage: {} }; }
}

function endTurn(text = 'done') {
  return [
    { type: 'text_delta', text },
    { type: 'stop', stopReason: 'end_turn' },
  ];
}

function buildEngine(config = {}) {
  const adapter = new QueueAdapter();
  const engine = new Engine({
    adapter,
    trace: new NullTrace(),
    config: { model: 'test-model', maxOutputTokens: 1024, _readOnly: true, ...config },
  });
  return { engine, adapter };
}

async function drainEvents(it) {
  const events = [];
  for await (const ev of it) events.push(ev);
  return events;
}

function registerPendingTask(engine, adapter, taskId, toolName = `tool-${taskId}`) {
  engine.registerTool({
    name: toolName,
    description: 'launches a fake background task',
    parameters: { type: 'object', properties: {} },
    execute: async (_input, ctx) => {
      ctx.registerAsyncTask(taskId);
      return 'started';
    },
  });
  adapter.pushResponse([
    { type: 'tool_call', id: `call-${taskId}`, name: toolName, input: {} },
    { type: 'stop', stopReason: 'tool_use' },
  ]);
  adapter.pushResponse(endTurn('parking'));
}

function trackTaskDelivery(engine) {
  const consumed = [];
  const undelivered = [];
  engine.setAsyncTaskCoordinator({
    onConsumed(taskId) { consumed.push(taskId); },
    onUndelivered(taskId) { undelivered.push(taskId); },
  });
  return { consumed, undelivered };
}

describe('engine — same-turn background task wait', () => {
  let engine, adapter;

  beforeEach(() => {
    ({ engine, adapter } = buildEngine());
  });

  it('end_turn waits for terminal task event, then resumes for one more loop', async () => {
    const e = engine;
    const a = adapter;

    e.registerTool({
      name: 'fakeBgTool',
      description: 'launches a fake background task',
      parameters: { type: 'object', properties: {} },
      execute: async (_input, ctx) => {
        ctx.registerAsyncTask('task-xyz');
        return 'Started background task task-xyz.';
      },
    });

    // Loop 1: model calls fakeBgTool. Tool returns immediately and
    // registers the async task with the engine.
    a.pushResponse([
      { type: 'tool_call', id: 'call-1', name: 'fakeBgTool', input: {} },
      { type: 'stop', stopReason: 'tool_use' },
    ]);
    // Loop 2: model says end_turn. With our fix, engine should park
    // because task-xyz is still pending — NOT emit turn_end.
    a.pushResponse(endTurn('launched, awaiting result'));
    // Loop 3 (after we deliver the task result): model says end_turn
    // for real.
    a.pushResponse(endTurn('handled task result'));

    // Run query() in the background so we can deliver the task result
    // mid-flight from the test driver.
    const events = [];
    const queryPromise = (async () => {
      for await (const ev of e.query({
        prompt: 'do the thing',
        messages: [],
      })) {
        events.push(ev);
        // The moment we see async_task_wait_start, deliver the task
        // result. This is exactly what web-bridge's task event sink
        // does in production.
        if (ev.type === 'async_task_wait_start') {
          const accepted = e.notifyAsyncTaskCompleted(
            'task-xyz',
            '<task-result id="task-xyz" status="succeeded">all good</task-result>',
            { preview: 'task succeeded' },
          );
          expect(accepted).toBe(true);
        }
      }
    })();

    await queryPromise;

    // Verify the adapter was called three times — one for the initial
    // turn, one for the parked end_turn, one for the post-injection loop.
    expect(a.streamCalls.length).toBe(3);

    // Verify a user-role message containing the task result was on
    // the wire for the third call (the post-injection loop).
    const lastCallMessages = a.streamCalls[2].messages;
    const lastMessageText = JSON.stringify(lastCallMessages);
    expect(lastMessageText).toContain('task-xyz');
    expect(lastMessageText).toContain('all good');

    // Engine should have emitted both wait_start and wait_end, plus
    // tool_result_update for the original tool result, plus a final turn_end.
    const waitStart = events.find(ev => ev.type === 'async_task_wait_start');
    const waitEnd = events.find(ev => ev.type === 'async_task_wait_end');
    const userAppend = events.find(ev => ev.type === 'user_append');
    const toolResultUpdate = events.find(ev => ev.type === 'tool_result_update');
    const finalTurnEnd = events.filter(ev => ev.type === 'turn_end').pop();

    expect(waitStart).toBeTruthy();
    expect(waitStart.pendingTaskIds).toContain('task-xyz');
    expect(waitEnd).toBeTruthy();
    expect(waitEnd.aborted).toBe(false);
    expect(userAppend).toBeFalsy();
    expect(toolResultUpdate).toMatchObject({ taskId: 'task-xyz', toolCallId: 'call-1' });
    expect(finalTurnEnd).toBeTruthy();
    expect(finalTurnEnd.stopReason).toBe('end_turn');

    // After query() returns, the engine must no longer claim ownership.
    expect(e.hasPendingAsyncTasks()).toBe(false);
    expect(e.ownsPendingAsyncTask('task-xyz')).toBe(false);
  });

  it('external thread-queue wake releases the wait and drains the user message without completing the task', async () => {
    const e = engine;
    const a = adapter;
    let queued = [];

    e.registerTool({
      name: 'fakeExternalWakeTool',
      description: 'launches a fake background task',
      parameters: { type: 'object', properties: {} },
      execute: async (_input, ctx) => {
        ctx.registerAsyncTask('task-external-wake');
        return 'Started background task task-external-wake.';
      },
    });

    a.pushResponse([
      { type: 'tool_call', id: 'call-external', name: 'fakeExternalWakeTool', input: {} },
      { type: 'stop', stopReason: 'tool_use' },
    ]);
    a.pushResponse(endTurn('parked'));
    a.pushResponse(endTurn('answered user while task remains active'));
    a.pushResponse(endTurn('task finished'));

    const events = [];
    let wakeSent = false;
    let completionSent = false;
    for await (const ev of e.query({
      prompt: 'start it',
      messages: [],
      drainPendingUserMessages: () => queued.splice(0),
    })) {
      events.push(ev);
      if (ev.type === 'async_task_wait_start' && !wakeSent) {
        wakeSent = true;
        queued.push({ content: 'answer this now too', preview: 'answer this now too' });
        expect(e.wakeForPendingUserMessage()).toBe(true);
      } else if (ev.type === 'async_task_wait_start' && wakeSent && !completionSent) {
        completionSent = true;
        e.notifyAsyncTaskCompleted(
          'task-external-wake',
          '<task-result id="task-external-wake" status="succeeded">done</task-result>',
          { preview: 'done' },
        );
      }
    }

    expect(a.streamCalls).toHaveLength(4);
    expect(JSON.stringify(a.streamCalls[2].messages)).toContain('answer this now too');
    expect(events.filter(ev => ev.type === 'user_append')).toEqual([
      expect.objectContaining({ preview: 'answer this now too', internal: false }),
    ]);
    expect(e.hasPendingAsyncTasks()).toBe(false);
  });

  it('user append during the wait splices the user message and continues without dropping the still-pending task', async () => {
    const e = engine;
    const a = adapter;

    e.registerTool({
      name: 'fakeBgTool',
      description: 'launches a fake background task',
      parameters: { type: 'object', properties: {} },
      execute: async (_input, ctx) => {
        ctx.registerAsyncTask('task-slow');
        return 'Started background task task-slow.';
      },
    });

    // Loop 1: tool_use.
    a.pushResponse([
      { type: 'tool_call', id: 'call-1', name: 'fakeBgTool', input: {} },
      { type: 'stop', stopReason: 'tool_use' },
    ]);
    // Loop 2: end_turn → parks.
    a.pushResponse(endTurn('parked'));
    // Loop 3: after user append, model says end_turn (no tool calls).
    // The task is still pending so this should park again.
    a.pushResponse(endTurn('replied to user, task still pending'));
    // Loop 4: after task result, model says end_turn for real.
    a.pushResponse(endTurn('all done'));

    const events = [];
    let userAppended = false;
    let taskCompleted = false;
    const queryPromise = (async () => {
      for await (const ev of e.query({
        prompt: 'do it',
        messages: [],
      })) {
        events.push(ev);
        if (ev.type === 'async_task_wait_start' && !userAppended) {
          // Simulate the user typing into the same turn.
          userAppended = true;
          const ok = e.appendUserMessage('also tell me what you launched');
          expect(ok).toBe(true);
        } else if (ev.type === 'async_task_wait_start' && userAppended && !taskCompleted) {
          // Second time we park, the task is still in flight. Now
          // deliver its terminal event.
          taskCompleted = true;
          e.notifyAsyncTaskCompleted(
            'task-slow',
            '<task-result id="task-slow" status="succeeded">finally done</task-result>',
            { preview: 'slow task done' },
          );
        }
      }
    })();

    await queryPromise;

    // We expect FOUR adapter calls:
    //   1. initial tool_use
    //   2. end_turn → park
    //   3. after user_append injection → end_turn → park again (task still pending)
    //   4. after task result injection → final end_turn
    expect(a.streamCalls.length).toBe(4);

    const wireRound3 = JSON.stringify(a.streamCalls[2].messages);
    expect(wireRound3).toContain('also tell me what you launched');
    // The task hadn't completed before round 3, so the synthetic
    // `<task-result>` injection must NOT have been on the wire yet.
    // (The pre-existing tool_result row from loop 1 mentions the task
    // id verbatim — that's expected — so assert on the synthetic
    // wrapper instead.)
    expect(wireRound3).not.toContain('<task-result');

    const wireRound4 = JSON.stringify(a.streamCalls[3].messages);
    expect(wireRound4).toContain('finally done');

    // The user append before the task should NOT be tagged internal=true;
    // the later task completion is a tool_result_update, not another
    // synthetic user append.
    const userAppendEvts = events.filter(ev => ev.type === 'user_append');
    expect(userAppendEvts.length).toBe(1);
    expect(userAppendEvts[0].internal).toBe(false);
    expect(userAppendEvts[0].preview).toContain('also tell me');
    const toolResultUpdate = events.find(ev => ev.type === 'tool_result_update');
    expect(toolResultUpdate).toMatchObject({ taskId: 'task-slow', toolCallId: 'call-1' });

    // Two wait starts, two wait ends.
    expect(events.filter(ev => ev.type === 'async_task_wait_start').length).toBe(2);
    expect(events.filter(ev => ev.type === 'async_task_wait_end').length).toBe(2);
  });

  it('abort during wait exits the wait loop and finalizes the turn instead of hanging', async () => {
    const e = engine;
    const a = adapter;
    const ctrl = new AbortController();

    e.registerTool({
      name: 'fakeBgTool',
      description: 'launches a fake background task',
      parameters: { type: 'object', properties: {} },
      execute: async (_input, ctx) => {
        ctx.registerAsyncTask('task-never');
        return 'Started background task task-never.';
      },
    });

    a.pushResponse([
      { type: 'tool_call', id: 'call-1', name: 'fakeBgTool', input: {} },
      { type: 'stop', stopReason: 'tool_use' },
    ]);
    a.pushResponse(endTurn('parking'));

    const events = [];
    const queryPromise = (async () => {
      for await (const ev of e.query({
        prompt: 'do it',
        messages: [],
        signal: ctrl.signal,
      })) {
        events.push(ev);
        if (ev.type === 'async_task_wait_start') {
          // Abort the turn instead of completing the task.
          ctrl.abort();
        }
      }
    })();

    // Bounded wait so a regression doesn't hang the test runner forever.
    await Promise.race([
      queryPromise,
      new Promise((_, reject) => setTimeout(() => reject(new Error('query hung after abort')), 2000)),
    ]);

    const waitEnd = events.find(ev => ev.type === 'async_task_wait_end');
    expect(waitEnd).toBeTruthy();
    expect(waitEnd.aborted).toBe(true);
    expect(events.filter(ev => ev.type === 'aborted')).toHaveLength(1);
    expect(events.filter(ev => ev.type === 'turn_end').at(-1)?.stopReason).toBe('aborted');

    // After abort the engine should have cleared ownership.
    expect(e.hasPendingAsyncTasks()).toBe(false);
  });

  it('rejects task completion after abort so the bridge can rescue it in a new turn', async () => {
    const e = engine;
    const a = adapter;

    e.registerTool({
      name: 'fakeBgTool',
      description: 'launches a fake background task',
      parameters: { type: 'object', properties: {} },
      execute: async (_input, ctx) => {
        ctx.registerAsyncTask('task-after-abort');
        return 'started';
      },
    });

    a.pushResponse([
      { type: 'tool_call', id: 'call-1', name: 'fakeBgTool', input: {} },
      { type: 'stop', stopReason: 'tool_use' },
    ]);
    a.pushResponse(endTurn('parking'));

    let accepted = null;
    const events = [];
    for await (const ev of e.query({ prompt: 'do it', messages: [] })) {
      events.push(ev);
      if (ev.type === 'async_task_wait_start') {
        e.abort('timeout');
        accepted = e.notifyAsyncTaskCompleted(
          'task-after-abort',
          '<task-result id="task-after-abort">done</task-result>',
        );
      }
    }

    expect(accepted).toBe(false);
    expect(a.streamCalls).toHaveLength(2);
    expect(events.filter(ev => ev.type === 'aborted')).toHaveLength(1);
    expect(events.filter(ev => ev.type === 'turn_end').at(-1)?.stopReason).toBe('aborted');
  });

  it('hands accepted-but-undrained completion back when abort wins before continuation', async () => {
    const e = engine;
    const a = adapter;
    const consumed = [];
    const undelivered = [];
    e.setAsyncTaskCoordinator({
      onConsumed(taskId) { consumed.push(taskId); },
      onUndelivered(taskId) { undelivered.push(taskId); },
    });

    e.registerTool({
      name: 'fakeBgTool',
      description: 'launches a fake background task',
      parameters: { type: 'object', properties: {} },
      execute: async (_input, ctx) => {
        ctx.registerAsyncTask('task-before-abort');
        return 'started';
      },
    });

    a.pushResponse([
      { type: 'tool_call', id: 'call-1', name: 'fakeBgTool', input: {} },
      { type: 'stop', stopReason: 'tool_use' },
    ]);
    a.pushResponse(endTurn('parking'));

    let accepted = null;
    const events = [];
    for await (const ev of e.query({ prompt: 'do it', messages: [] })) {
      events.push(ev);
      if (ev.type === 'async_task_wait_start') {
        accepted = e.notifyAsyncTaskCompleted(
          'task-before-abort',
          '<task-result id="task-before-abort">done</task-result>',
        );
        e.abort('timeout');
      }
    }

    expect(accepted).toBe(true);
    expect(a.streamCalls).toHaveLength(2);
    expect(consumed).toEqual([]);
    expect(undelivered).toEqual(['task-before-abort']);
    expect(events.filter(ev => ev.type === 'aborted')).toHaveLength(1);
  });

  it('keeps a fetch-pending task result undelivered when watchdog aborts before provider events', async () => {
    const { engine: e, adapter: a } = buildEngine();
    const delivery = trackTaskDelivery(e);
    registerPendingTask(e, a, 'task-fetch-pending');

    let markThirdRequestStarted;
    const thirdRequestStarted = new Promise(resolve => { markThirdRequestStarted = resolve; });
    a.pushResponse(async function* (params) {
      markThirdRequestStarted();
      await new Promise((_, reject) => {
        const rejectAbort = () => reject(new LLMAbortError());
        if (params.signal.aborted) rejectAbort();
        else params.signal.addEventListener('abort', rejectAbort, { once: true });
      });
    });

    const events = [];
    const queryPromise = (async () => {
      for await (const event of e.query({ prompt: 'do it', messages: [] })) {
        events.push(event);
        if (event.type === 'async_task_wait_start') {
          expect(e.notifyAsyncTaskCompleted(
            'task-fetch-pending',
            '<task-result id="task-fetch-pending">done</task-result>',
          )).toBe(true);
        }
      }
    })();

    await thirdRequestStarted;
    expect(e.abort('timeout')).toBe(true);
    await queryPromise;

    expect(a.streamCalls).toHaveLength(3);
    expect(JSON.stringify(a.streamCalls[2].messages)).toContain('task-fetch-pending');
    expect(delivery.consumed).toEqual([]);
    expect(delivery.undelivered).toEqual(['task-fetch-pending']);
    expect(events.filter(event => event.type === 'aborted')).toHaveLength(1);
  });

  it('keeps task result escrow across a transient stream error and consumes it after retry success', async () => {
    const { engine: e, adapter: a } = buildEngine({
      llmRetry: { maxRetries: 1, baseDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 },
    });
    const delivery = trackTaskDelivery(e);
    registerPendingTask(e, a, 'task-retry');
    a.pushResponse(async function* () {
      throw new LLMServerError('temporary gateway failure', 502);
    });
    a.pushResponse(endTurn('handled after retry'));

    const events = [];
    for await (const event of e.query({ prompt: 'do it', messages: [] })) {
      events.push(event);
      if (event.type === 'async_task_wait_start') {
        expect(e.notifyAsyncTaskCompleted(
          'task-retry',
          '<task-result id="task-retry">done</task-result>',
        )).toBe(true);
      }
    }

    expect(a.streamCalls).toHaveLength(4);
    expect(JSON.stringify(a.streamCalls[2].messages)).toContain('task-retry');
    expect(JSON.stringify(a.streamCalls[3].messages)).toContain('task-retry');
    expect(events.filter(event => event.type === 'llm_retry')).toHaveLength(1);
    expect(delivery.consumed).toEqual(['task-retry']);
    expect(delivery.undelivered).toEqual([]);
  });

  it('consumes a task result once after a successful provider terminal stop', async () => {
    const { engine: e, adapter: a } = buildEngine();
    const delivery = trackTaskDelivery(e);
    registerPendingTask(e, a, 'task-success');
    a.pushResponse(endTurn('handled successfully'));

    for await (const event of e.query({ prompt: 'do it', messages: [] })) {
      if (event.type === 'async_task_wait_start') {
        expect(e.notifyAsyncTaskCompleted(
          'task-success',
          '<task-result id="task-success">done</task-result>',
        )).toBe(true);
      }
    }

    expect(a.streamCalls).toHaveLength(3);
    expect(JSON.stringify(a.streamCalls[2].messages)).toContain('task-success');
    expect(delivery.consumed).toEqual(['task-success']);
    expect(delivery.undelivered).toEqual([]);
  });

  it('rescues task result when stream emits a nonterminal event and then aborts', async () => {
    const { engine: e, adapter: a } = buildEngine();
    const delivery = trackTaskDelivery(e);
    registerPendingTask(e, a, 'task-partial-abort');
    a.pushResponse(async function* (params) {
      yield { type: 'text_delta', text: 'partial task handling' };
      await new Promise((_, reject) => {
        const rejectAbort = () => reject(new LLMAbortError());
        if (params.signal.aborted) rejectAbort();
        else params.signal.addEventListener('abort', rejectAbort, { once: true });
      });
    });

    const events = [];
    for await (const event of e.query({ prompt: 'do it', messages: [] })) {
      events.push(event);
      if (event.type === 'async_task_wait_start') {
        expect(e.notifyAsyncTaskCompleted(
          'task-partial-abort',
          '<task-result id="task-partial-abort">done</task-result>',
        )).toBe(true);
      }
      if (event.type === 'text_delta' && event.text === 'partial task handling') {
        expect(e.abort('timeout')).toBe(true);
      }
    }

    expect(a.streamCalls).toHaveLength(3);
    expect(JSON.stringify(a.streamCalls[2].messages)).toContain('task-partial-abort');
    expect(delivery.consumed).toEqual([]);
    expect(delivery.undelivered).toEqual(['task-partial-abort']);
    expect(events.filter(event => event.type === 'aborted')).toHaveLength(1);
  });

  it('end_turn with no pending async tasks finalizes immediately (legacy behaviour unchanged)', async () => {
    const e = engine;
    const a = adapter;

    a.pushResponse(endTurn('quick reply'));

    const events = await drainEvents(e.query({
      prompt: 'hi',
      messages: [],
    }));

    expect(a.streamCalls.length).toBe(1);
    expect(events.find(ev => ev.type === 'async_task_wait_start')).toBeUndefined();
    const finalTurnEnd = events.filter(ev => ev.type === 'turn_end').pop();
    expect(finalTurnEnd.stopReason).toBe('end_turn');
  });

  it('coordinator onRegister / onUnregister is invoked for the full task lifecycle', async () => {
    const e = engine;
    const a = adapter;

    const registered = [];
    const unregistered = [];
    e.setAsyncTaskCoordinator({
      onRegister(taskId) { registered.push(taskId); },
      onUnregister(taskId) { unregistered.push(taskId); },
    });

    e.registerTool({
      name: 'fakeBgTool',
      description: 'launches a fake background task',
      parameters: { type: 'object', properties: {} },
      execute: async (_input, ctx) => {
        ctx.registerAsyncTask('task-coord');
        return 'started';
      },
    });

    a.pushResponse([
      { type: 'tool_call', id: 'call-1', name: 'fakeBgTool', input: {} },
      { type: 'stop', stopReason: 'tool_use' },
    ]);
    a.pushResponse(endTurn('parking'));
    a.pushResponse(endTurn('done'));

    const queryPromise = (async () => {
      for await (const ev of e.query({ prompt: 'do', messages: [] })) {
        if (ev.type === 'async_task_wait_start') {
          e.notifyAsyncTaskCompleted('task-coord', '<task-result>ok</task-result>');
        }
      }
    })();
    await queryPromise;

    expect(registered).toEqual(['task-coord']);
    expect(unregistered).toEqual(['task-coord']);
  });

  it('ownsPendingAsyncTask returns false for unknown taskId', () => {
    const e = engine;
    expect(e.ownsPendingAsyncTask('nope')).toBe(false);
    expect(e.notifyAsyncTaskCompleted('nope', 'irrelevant')).toBe(false);
  });

  it('notifyAsyncTaskCompleted defensively rejects empty / non-content payloads even when the engine owns the task', async () => {
    const e = engine;
    const a = adapter;

    e.registerTool({
      name: 'fakeBgTool',
      description: 'launches a fake background task',
      parameters: { type: 'object', properties: {} },
      execute: async (_input, ctx) => {
        ctx.registerAsyncTask('task-empty');
        return 'started';
      },
    });

    a.pushResponse([
      { type: 'tool_call', id: 'call-1', name: 'fakeBgTool', input: {} },
      { type: 'stop', stopReason: 'tool_use' },
    ]);
    a.pushResponse(endTurn('parking'));
    a.pushResponse(endTurn('done'));

    const queryPromise = (async () => {
      for await (const ev of e.query({ prompt: 'do', messages: [] })) {
        if (ev.type === 'async_task_wait_start') {
          // Each of these must be rejected (returns false) AND must leave
          // the task in the pending set — otherwise we'd hang on the
          // next loop iteration. Note: empty/whitespace string and
          // non-string-non-array are rejected BEFORE the engine removes
          // the task; an empty content-block array is too. Only the
          // final well-formed payload should actually unblock the wait.
          expect(e.notifyAsyncTaskCompleted('task-empty', '')).toBe(false);
          expect(e.notifyAsyncTaskCompleted('task-empty', '   ')).toBe(false);
          expect(e.notifyAsyncTaskCompleted('task-empty', null)).toBe(false);
          expect(e.notifyAsyncTaskCompleted('task-empty', 42)).toBe(false);
          expect(e.notifyAsyncTaskCompleted('task-empty', [])).toBe(false);
          // All rejections must have left the task in flight.
          expect(e.ownsPendingAsyncTask('task-empty')).toBe(true);
          // Now deliver the real payload to drain the wait.
          expect(e.notifyAsyncTaskCompleted('task-empty', '<task-result>ok</task-result>')).toBe(true);
        }
      }
    })();
    await queryPromise;

    expect(a.streamCalls.length).toBe(3);
    expect(e.hasPendingAsyncTasks()).toBe(false);
  });
});
