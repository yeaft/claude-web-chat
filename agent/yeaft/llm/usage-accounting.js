import { LLMAdapter } from './adapter.js';

function tokenCount(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

/**
 * Normalize one provider usage payload without double-counting cached input.
 * OpenAI includes cached tokens in input_tokens; Anthropic reports cache input
 * separately. Adapters expose that distinction through
 * `cacheTokensAreIncludedInInput`.
 */
export function normalizeTokenUsage(usage = {}) {
  const inputTokens = tokenCount(usage.inputTokens ?? usage.input_tokens);
  const outputTokens = tokenCount(usage.outputTokens ?? usage.output_tokens);
  const cacheReadTokens = tokenCount(
    usage.cacheReadTokens ?? usage.cache_read_tokens ?? usage.cache_read_input_tokens
  );
  const cacheWriteTokens = tokenCount(
    usage.cacheWriteTokens ?? usage.cache_write_tokens ?? usage.cache_creation_input_tokens
  );
  const explicitTotal = tokenCount(usage.totalTokens ?? usage.total_tokens);
  const cacheInputTokens = usage.cacheTokensAreIncludedInInput === true
    ? 0
    : cacheReadTokens + cacheWriteTokens;

  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    totalTokens: explicitTotal || inputTokens + outputTokens + cacheInputTokens,
  };
}

function addUsage(total, usage) {
  const normalized = normalizeTokenUsage(usage);
  total.inputTokens += normalized.inputTokens;
  total.outputTokens += normalized.outputTokens;
  total.cacheReadTokens += normalized.cacheReadTokens;
  total.cacheWriteTokens += normalized.cacheWriteTokens;
  total.totalTokens += normalized.totalTokens;
}

function hasUsage(usage) {
  return Object.values(usage).some(value => value > 0);
}

/**
 * Wrap the shared adapter at the provider-call boundary. Every stream request
 * reports once after its event stream finishes (or aborts after returning
 * usage), and every non-streaming side call reports once after success.
 *
 * Parent VP engines, sub-agent engines, Dream, compact, reflection, AMS, and
 * classifiers all reuse this adapter, so none need their own accounting hook.
 */
export class UsageAccountingAdapter extends LLMAdapter {
  #adapter;
  #onUsage;

  constructor(adapter, onUsage) {
    super(adapter?.config || {});
    this.#adapter = adapter;
    this.#onUsage = onUsage;
  }

  #report(usage) {
    if (!hasUsage(usage)) return;
    try {
      this.#onUsage(usage);
    } catch (error) {
      console.warn(`[llm-usage] accounting callback failed: ${error?.message || error}`);
    }
  }

  async *stream(params) {
    const total = normalizeTokenUsage();
    try {
      for await (const event of this.#adapter.stream(params)) {
        if (event?.type === 'usage') addUsage(total, event);
        yield event;
      }
    } finally {
      this.#report(total);
    }
  }

  async call(params) {
    const result = await this.#adapter.call(params);
    this.#report(normalizeTokenUsage(result?.usage || {}));
    return result;
  }

  refreshProviders(providers) {
    return this.#adapter.refreshProviders?.(providers);
  }

  getProviderForModel(modelId) {
    return this.#adapter.getProviderForModel?.(modelId) || null;
  }

  listAvailableModels() {
    return this.#adapter.listAvailableModels?.() || [];
  }
}

export function withUsageAccounting(adapter, onUsage) {
  return typeof onUsage === 'function'
    ? new UsageAccountingAdapter(adapter, onUsage)
    : adapter;
}
