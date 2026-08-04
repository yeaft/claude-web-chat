import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';

const TERMINAL_STOP_REASONS = new Set(['end_turn', 'max_tokens', 'stop_sequence', 'aborted', 'error']);

function snakeUsage(usage) {
  const inputTokens = usage.inputTokens || 0;
  const outputTokens = usage.outputTokens || 0;
  const cacheReadTokens = usage.cacheReadTokens || 0;
  const cacheWriteTokens = usage.cacheWriteTokens || 0;
  const cacheDelta = usage.cacheTokensAreIncludedInInput ? 0 : cacheReadTokens + cacheWriteTokens;
  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cache_read_input_tokens: cacheReadTokens,
    cache_creation_input_tokens: cacheWriteTokens,
    total_input_tokens: inputTokens + cacheDelta,
    total_tokens: inputTokens + cacheDelta + outputTokens,
  };
}

export function extractPrompt(message) {
  if (!message || typeof message !== 'object') return '';
  if (typeof message.prompt === 'string') return message.prompt;
  if (typeof message.text === 'string') return message.text;
  const content = message.message?.content ?? message.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter(block => block?.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('');
}

export function createJsonlWriter(output = process.stdout) {
  return (event) => {
    output.write(`${JSON.stringify(event)}\n`);
  };
}

export class JsonlInput {
  #rl;
  #prompts = [];
  #promptWaiters = [];
  #answers = new Map();
  #answerWaiters = new Map();
  #answerRequestIds = new Set();
  #closed = false;
  #error = null;

  constructor(input = process.stdin) {
    this.#rl = createInterface({ input, crlfDelay: Infinity, terminal: false });
    this.#rl.on('line', line => this.#acceptLine(line));
    this.#rl.on('close', () => this.#close());
  }

  #acceptLine(line) {
    const trimmed = line.trim();
    if (!trimmed) return;
    let message;
    try {
      message = JSON.parse(trimmed);
    } catch (err) {
      this.#error = new Error(`Invalid stream-json input: ${err.message}`);
      this.#close();
      return;
    }
    const type = message.type || '';
    if (type === 'ask_user_response' || type === 'user_response') {
      const requestId = message.request_id || message.requestId;
      if (!requestId) return;
      const value = message.answers ?? message.answer ?? message.response ?? {};
      const waiter = this.#answerWaiters.get(requestId);
      if (waiter) {
        this.#answerWaiters.delete(requestId);
        waiter.resolve(value);
      } else if (this.#answerRequestIds.has(requestId)) {
        this.#error = new Error(`Duplicate AskUser response request_id: ${requestId}`);
        this.#close();
      } else {
        this.#answerRequestIds.add(requestId);
        this.#answers.set(requestId, value);
      }
      return;
    }
    if (type === 'user' || type === 'prompt' || message.prompt !== undefined) {
      const prompt = extractPrompt(message);
      if (!prompt) return;
      const item = { prompt, message };
      const waiter = this.#promptWaiters.shift();
      if (waiter) waiter.resolve(item);
      else this.#prompts.push(item);
    }
  }

  #close() {
    if (this.#closed) return;
    this.#closed = true;
    for (const waiter of this.#promptWaiters.splice(0)) {
      if (this.#error) waiter.reject(this.#error);
      else waiter.resolve(null);
    }
    for (const waiter of this.#answerWaiters.values()) {
      waiter.reject(this.#error || new Error('stdin closed before AskUser response'));
    }
    this.#answerWaiters.clear();
  }

  async nextPrompt() {
    if (this.#prompts.length) return this.#prompts.shift();
    if (this.#error) throw this.#error;
    if (this.#closed) return null;
    return new Promise((resolve, reject) => this.#promptWaiters.push({ resolve, reject }));
  }

  async waitForAnswer(requestId) {
    if (!requestId || typeof requestId !== 'string') {
      throw new Error('AskUser request_id must be a non-empty string');
    }
    if (this.#error) throw this.#error;
    if (this.#answers.has(requestId)) {
      const value = this.#answers.get(requestId);
      this.#answers.delete(requestId);
      return value;
    }
    if (this.#answerRequestIds.has(requestId)) {
      throw new Error(`Duplicate AskUser request_id: ${requestId}`);
    }
    if (this.#error) throw this.#error;
    if (this.#closed) throw new Error('stdin closed before AskUser response');
    this.#answerRequestIds.add(requestId);
    return new Promise((resolve, reject) => this.#answerWaiters.set(requestId, { resolve, reject }));
  }

  close() {
    this.#rl.close();
  }
}

export async function runStreamTurn({
  engine,
  prompt,
  messages = [],
  sessionId = null,
  workDir = process.cwd(),
  model = null,
  modelEffort = null,
  input = null,
  write,
  getCurrentTodos = null,
  setCurrentTodos = null,
}) {
  const clientTurnId = randomUUID();
  let engineTurnId = null;
  let resultText = '';
  let stopReason = 'end_turn';
  let failed = null;
  const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cacheInputDeltaTokens: 0 };

  const askUser = async ({ question, options }) => {
    const requestId = randomUUID();
    write({
      type: 'ask_user',
      subtype: 'request',
      request_id: requestId,
      session_id: sessionId,
      turn_id: engineTurnId || clientTurnId,
      question,
      options: Array.isArray(options) ? options : [],
    });
    if (!input) throw new Error('AskUser requires --input-format stream-json');
    const answers = await input.waitForAnswer(requestId);
    write({
      type: 'ask_user',
      subtype: 'response',
      request_id: requestId,
      session_id: sessionId,
      turn_id: engineTurnId || clientTurnId,
      answers,
    });
    return answers;
  };

  try {
    for await (const event of engine.query({
      prompt,
      messages,
      sessionId,
      workDir,
      userEffort: modelEffort,
      askUser,
      getCurrentTodos,
      setCurrentTodos,
    })) {
      if (event.type === 'turn_open') engineTurnId = event.turnId;
      const turnId = engineTurnId || clientTurnId;
      switch (event.type) {
        case 'turn_open':
          write({ ...event, type: 'turn', subtype: 'start', session_id: sessionId, turn_id: event.turnId, model, model_effort: modelEffort, cwd: workDir });
          break;
        case 'text_delta':
          resultText += event.text || '';
          write({ type: 'assistant', subtype: 'text_delta', session_id: sessionId, turn_id: turnId, delta: { type: 'text_delta', text: event.text || '' } });
          break;
        case 'thinking_delta':
          write({ type: 'assistant', subtype: 'thinking_delta', session_id: sessionId, turn_id: turnId, delta: { type: 'thinking_delta', thinking: event.text || '' } });
          break;
        case 'skill_loaded':
          write({ type: 'skill', subtype: 'loaded', session_id: sessionId, turn_id: turnId, skill: event.skill });
          break;
        case 'skill_error':
          write({ type: 'skill', subtype: 'error', session_id: sessionId, turn_id: turnId, skill_name: event.skillName, error: event.message });
          break;
        case 'tool_call':
          write({ type: 'assistant', subtype: 'tool_use', session_id: sessionId, turn_id: turnId, content: [{ type: 'tool_use', id: event.id, name: event.name, input: event.input }] });
          if (event.name === 'TodoWrite') {
            write({ type: 'todo', subtype: 'update', session_id: sessionId, turn_id: turnId, tool_use_id: event.id, todos: event.input?.todos || [] });
          }
          break;
        case 'tool_start':
          write({ type: 'tool', subtype: 'start', session_id: sessionId, turn_id: turnId, tool_use_id: event.id, name: event.name, input: event.input });
          break;
        case 'tool_end':
          write({
            type: 'tool',
            subtype: 'result',
            session_id: sessionId,
            turn_id: turnId,
            tool_use_id: event.id,
            name: event.name,
            content: event.output,
            is_error: !!event.isError,
            ...(Array.isArray(event.displayImages) && event.displayImages.length > 0
              ? { display_images: event.displayImages }
              : {}),
          });
          break;
        case 'usage': {
          const cacheDelta = event.cacheTokensAreIncludedInInput ? 0 : (event.cacheReadTokens || 0) + (event.cacheWriteTokens || 0);
          usage.inputTokens += event.inputTokens || 0;
          usage.outputTokens += event.outputTokens || 0;
          usage.cacheReadTokens += event.cacheReadTokens || 0;
          usage.cacheWriteTokens += event.cacheWriteTokens || 0;
          usage.cacheInputDeltaTokens += cacheDelta;
          write({ type: 'usage', session_id: sessionId, turn_id: turnId, usage: snakeUsage(event) });
          break;
        }
        case 'stop':
          if (event.stopReason) stopReason = event.stopReason;
          break;
        case 'turn_end':
          if (event.stopReason && TERMINAL_STOP_REASONS.has(event.stopReason)) stopReason = event.stopReason;
          break;
        case 'turn_close':
          write({ type: 'turn', subtype: 'stop', session_id: sessionId, turn_id: turnId, duration_ms: event.totalMs, loop_count: event.loopCount, total_tokens: event.totalTokens });
          break;
        case 'error':
          failed = event.error instanceof Error ? event.error : new Error(event.error?.message || String(event.error || 'Unknown error'));
          write({ type: 'error', session_id: sessionId, turn_id: turnId, error: { name: failed.name, message: failed.message }, retryable: !!event.retryable });
          break;
        case 'fallback':
        case 'llm_retry':
        case 'memory_used':
        case 'recall':
        case 'consolidate':
        case 'reflection':
          write({ ...event, session_id: sessionId, turn_id: turnId });
          break;
      }
    }
  } catch (err) {
    failed = err;
    write({ type: 'error', session_id: sessionId, turn_id: engineTurnId || clientTurnId, error: { name: err.name || 'Error', message: err.message || String(err) } });
  }

  const finalUsage = {
    input_tokens: usage.inputTokens,
    output_tokens: usage.outputTokens,
    cache_read_input_tokens: usage.cacheReadTokens,
    cache_creation_input_tokens: usage.cacheWriteTokens,
    total_input_tokens: usage.inputTokens + usage.cacheInputDeltaTokens,
    total_tokens: usage.inputTokens + usage.cacheInputDeltaTokens + usage.outputTokens,
  };
  const result = {
    type: 'result',
    subtype: failed ? 'error' : 'success',
    session_id: sessionId,
    turn_id: engineTurnId || clientTurnId,
    model,
    model_effort: modelEffort,
    stop_reason: failed ? 'error' : stopReason,
    is_error: !!failed,
    result: resultText,
    usage: finalUsage,
    ...(failed ? { error: failed.message || String(failed) } : {}),
  };
  write(result);
  return result;
}

/**
 * Run one prompt through the multi-VP CLI Session runner. Engine events keep
 * the stream-json shape used by runStreamTurn and add `vp_id`, allowing
 * concurrent VP streams to be demultiplexed without imposing output order.
 */
export async function runStreamSessionTurn({
  runner,
  prompt,
  sessionId,
  workDir = process.cwd(),
  model = null,
  modelEffort = null,
  input = null,
  write,
}) {
  const clientTurnId = randomUUID();
  const states = new Map();
  let failed = null;

  const stateFor = (vpId) => {
    let state = states.get(vpId);
    if (!state) {
      state = {
        turnId: clientTurnId,
        resultText: '',
        stopReason: 'end_turn',
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cacheInputDeltaTokens: 0 },
      };
      states.set(vpId, state);
    }
    return state;
  };

  const askUser = async ({ question, options }, vpId = null, turnId = clientTurnId) => {
    const requestId = randomUUID();
    write({
      type: 'ask_user', subtype: 'request', request_id: requestId,
      session_id: sessionId, turn_id: turnId, vp_id: vpId,
      question, options: Array.isArray(options) ? options : [],
    });
    if (!input) throw new Error('AskUser requires --input-format stream-json');
    const answers = await input.waitForAnswer(requestId);
    write({
      type: 'ask_user', subtype: 'response', request_id: requestId,
      session_id: sessionId, turn_id: turnId, vp_id: vpId, answers,
    });
    return answers;
  };

  const onEvent = async ({ vpId, event, turnId: fallbackTurnId }) => {
    const state = stateFor(vpId);
    if (event.type === 'turn_open' && event.turnId) state.turnId = event.turnId;
    const turnId = state.turnId || fallbackTurnId || clientTurnId;
    const base = { session_id: sessionId, turn_id: turnId, vp_id: vpId };
    switch (event.type) {
      case 'turn_open':
        write({ ...event, type: 'turn', subtype: 'start', ...base, model, model_effort: modelEffort, cwd: workDir });
        break;
      case 'text_delta':
        state.resultText += event.text || '';
        write({ type: 'assistant', subtype: 'text_delta', ...base, delta: { type: 'text_delta', text: event.text || '' } });
        break;
      case 'thinking_delta':
        write({ type: 'assistant', subtype: 'thinking_delta', ...base, delta: { type: 'thinking_delta', thinking: event.text || '' } });
        break;
      case 'skill_loaded':
        write({ type: 'skill', subtype: 'loaded', ...base, skill: event.skill });
        break;
      case 'skill_error':
        write({ type: 'skill', subtype: 'error', ...base, skill_name: event.skillName, error: event.message });
        break;
      case 'tool_call':
        write({ type: 'assistant', subtype: 'tool_use', ...base, content: [{ type: 'tool_use', id: event.id, name: event.name, input: event.input }] });
        if (event.name === 'TodoWrite') {
          write({ type: 'todo', subtype: 'update', ...base, tool_use_id: event.id, todos: event.input?.todos || [] });
        }
        break;
      case 'tool_start':
        write({ type: 'tool', subtype: 'start', ...base, tool_use_id: event.id, name: event.name, input: event.input });
        break;
      case 'tool_end':
        write({ type: 'tool', subtype: 'result', ...base, tool_use_id: event.id, name: event.name, content: event.output, is_error: !!event.isError });
        break;
      case 'usage': {
        const cacheDelta = event.cacheTokensAreIncludedInInput ? 0 : (event.cacheReadTokens || 0) + (event.cacheWriteTokens || 0);
        state.usage.inputTokens += event.inputTokens || 0;
        state.usage.outputTokens += event.outputTokens || 0;
        state.usage.cacheReadTokens += event.cacheReadTokens || 0;
        state.usage.cacheWriteTokens += event.cacheWriteTokens || 0;
        state.usage.cacheInputDeltaTokens += cacheDelta;
        write({ type: 'usage', ...base, usage: snakeUsage(event) });
        break;
      }
      case 'stop':
      case 'turn_end':
        if (event.stopReason && TERMINAL_STOP_REASONS.has(event.stopReason)) state.stopReason = event.stopReason;
        break;
      case 'turn_close':
        write({ type: 'turn', subtype: 'stop', ...base, duration_ms: event.totalMs, loop_count: event.loopCount, total_tokens: event.totalTokens });
        break;
      case 'error':
        failed ||= event.error instanceof Error ? event.error : new Error(event.error?.message || String(event.error || 'Unknown error'));
        write({ type: 'error', ...base, error: { name: failed.name, message: failed.message }, retryable: !!event.retryable });
        break;
      case 'fallback':
      case 'llm_retry':
      case 'memory_used':
      case 'recall':
      case 'consolidate':
      case 'reflection':
        write({ ...event, ...base });
        break;
    }
  };

  let outcome;
  try {
    outcome = await runner.run(prompt, {
      modelEffort,
      onEvent,
      askUser,
    });
  } catch (error) {
    failed = error;
    write({ type: 'error', session_id: sessionId, turn_id: clientTurnId, error: { name: error.name || 'Error', message: error.message || String(error) } });
    outcome = { report: { dispatched: [] }, results: [] };
  }

  const perVp = Array.from(states, ([vpId, state]) => ({
    vp_id: vpId,
    turn_id: state.turnId,
    stop_reason: state.stopReason,
    result: state.resultText,
    usage: {
      input_tokens: state.usage.inputTokens,
      output_tokens: state.usage.outputTokens,
      cache_read_input_tokens: state.usage.cacheReadTokens,
      cache_creation_input_tokens: state.usage.cacheWriteTokens,
      total_input_tokens: state.usage.inputTokens + state.usage.cacheInputDeltaTokens,
      total_tokens: state.usage.inputTokens + state.usage.cacheInputDeltaTokens + state.usage.outputTokens,
    },
  }));
  const stopReasons = perVp.map(item => item.stop_reason);
  const aggregateStopReason = failed || stopReasons.includes('error')
    ? 'error'
    : stopReasons.length > 0 && stopReasons.every(reason => reason === 'aborted')
      ? 'aborted'
      : 'end_turn';
  const isError = !!failed || aggregateStopReason === 'error';
  const result = {
    type: 'result', subtype: isError ? 'error' : 'success',
    session_id: sessionId, turn_id: clientTurnId,
    model, model_effort: modelEffort,
    stop_reason: aggregateStopReason,
    is_error: isError,
    result: perVp.map(item => item.result).filter(Boolean).join('\n'),
    dispatched_vp_ids: outcome?.report?.dispatched || [],
    vp_results: perVp,
    ...(failed ? { error: failed.message || String(failed) } : {}),
  };
  write(result);
  return result;
}
