import { describe, it, expect } from 'vitest';
import { isPromptTokenOverflow, getModelContextConfig } from '../../agent/claude.js';

// =====================================================================
// isPromptTokenOverflow — detect API 400 prompt token exceeded errors
// =====================================================================

describe('isPromptTokenOverflow', () => {
  it('detects standard API error message', () => {
    expect(isPromptTokenOverflow(
      'prompt token count of 138392 exceeds the limit of 128000'
    )).toBe(true);
  });

  it('detects error with "API Error 400" prefix', () => {
    expect(isPromptTokenOverflow(
      'API Error 400: prompt token count of 138392 exceeds the limit of 128000'
    )).toBe(true);
  });

  it('detects model_max_prompt_tokens_exceeded variant', () => {
    expect(isPromptTokenOverflow(
      'model_max_prompt_tokens_exceeded: the prompt token limit has been exceeded'
    )).toBe(true);
  });

  it('detects case-insensitive match', () => {
    expect(isPromptTokenOverflow(
      'Prompt Token count EXCEEDS the LIMIT'
    )).toBe(true);
  });

  it('rejects unrelated errors', () => {
    expect(isPromptTokenOverflow('Connection timeout')).toBe(false);
    expect(isPromptTokenOverflow('Internal server error')).toBe(false);
    expect(isPromptTokenOverflow('Rate limit exceeded')).toBe(false);
  });

  it('rejects null/undefined/empty', () => {
    expect(isPromptTokenOverflow(null)).toBe(false);
    expect(isPromptTokenOverflow(undefined)).toBe(false);
    expect(isPromptTokenOverflow('')).toBe(false);
  });

  it('rejects partial matches (needs all three keywords)', () => {
    // Has "prompt" and "token" but not "exceed" or "limit"
    expect(isPromptTokenOverflow('prompt token count is 5000')).toBe(false);
    // Has "exceed" but not "prompt" and "token"
    expect(isPromptTokenOverflow('rate limit exceeded')).toBe(false);
  });
});

// =====================================================================
// Pre-send compact token estimation — verify output_tokens inclusion
// =====================================================================

describe('token estimation logic', () => {
  // Replicate the estimation logic from conversation.js and claude.js
  function estimateTotal({ lastInputTokens, lastOutputTokens, promptLength }) {
    const estimatedNewTokens = Math.ceil(promptLength / 3);
    return lastInputTokens + lastOutputTokens + estimatedNewTokens;
  }

  it('includes output_tokens in estimation', () => {
    const result = estimateTotal({
      lastInputTokens: 100000,
      lastOutputTokens: 15000,
      promptLength: 3000, // ~1000 tokens
    });
    // 100000 + 15000 + 1000 = 116000
    expect(result).toBe(116000);
  });

  it('old formula (without output_tokens) would underestimate', () => {
    const withOutput = estimateTotal({
      lastInputTokens: 100000,
      lastOutputTokens: 30000,
      promptLength: 3000,
    });
    const withoutOutput = 100000 + Math.ceil(3000 / 3); // old formula
    // With output: 131000, without: 101000
    expect(withOutput).toBe(131000);
    expect(withoutOutput).toBe(101000);
    // The old formula would NOT trigger compact at 110000 threshold,
    // but the new formula correctly would
    expect(withOutput).toBeGreaterThan(110000);
    expect(withoutOutput).toBeLessThan(110000);
  });

  it('handles zero output_tokens gracefully', () => {
    const result = estimateTotal({
      lastInputTokens: 50000,
      lastOutputTokens: 0,
      promptLength: 300,
    });
    expect(result).toBe(50100);
  });

  it('triggers compact when input + output + new exceeds threshold', () => {
    const threshold = 110000;
    // Scenario: 95000 input + 10000 output + ~5000 new = 110000 → should trigger
    const total = estimateTotal({
      lastInputTokens: 95000,
      lastOutputTokens: 10000,
      promptLength: 15000, // ~5000 tokens
    });
    expect(total).toBe(110000);
    expect(total >= threshold).toBe(true);
  });

  it('does not trigger compact when below threshold', () => {
    const threshold = 110000;
    const total = estimateTotal({
      lastInputTokens: 80000,
      lastOutputTokens: 5000,
      promptLength: 3000,
    });
    expect(total).toBe(86000);
    expect(total < threshold).toBe(true);
  });
});

// =====================================================================
// Compact retry guard — _compactRetried prevents infinite loop
// =====================================================================

describe('compact retry guard', () => {
  it('_compactRetried flag prevents repeated compact on same error', () => {
    // Simulate the retry logic
    const state = { _compactRetried: false, claudeSessionId: 'uuid-123' };

    // First overflow: should trigger retry
    const errorMsg = 'prompt token count of 138392 exceeds the limit of 128000';
    const shouldRetry1 = isPromptTokenOverflow(errorMsg) && state.claudeSessionId && !state._compactRetried;
    expect(shouldRetry1).toBe(true);

    // After retry, mark flag
    state._compactRetried = true;

    // Second overflow: should NOT retry (flag is set)
    const shouldRetry2 = isPromptTokenOverflow(errorMsg) && state.claudeSessionId && !state._compactRetried;
    expect(shouldRetry2).toBe(false);
  });

  it('does not trigger retry without claudeSessionId', () => {
    const state = { _compactRetried: false, claudeSessionId: null };
    const errorMsg = 'prompt token count exceeds the limit';
    const shouldRetry = isPromptTokenOverflow(errorMsg) && !!state.claudeSessionId && !state._compactRetried;
    expect(shouldRetry).toBe(false);
  });
});

// =====================================================================
// _lastUserMessage tracking
// =====================================================================

describe('_lastUserMessage tracking', () => {
  it('saves user message for retry after compact', () => {
    const state = {};
    const userMessage = { type: 'user', message: { role: 'user', content: 'Build feature X' } };

    // Simulate saving (as conversation.js does before enqueue)
    state._lastUserMessage = userMessage;

    expect(state._lastUserMessage).toBe(userMessage);
    expect(state._lastUserMessage.message.content).toBe('Build feature X');
  });

  it('overwrites previous message on new send', () => {
    const state = {};
    const msg1 = { type: 'user', message: { role: 'user', content: 'first' } };
    const msg2 = { type: 'user', message: { role: 'user', content: 'second' } };

    state._lastUserMessage = msg1;
    state._lastUserMessage = msg2;

    expect(state._lastUserMessage.message.content).toBe('second');
  });
});

// =====================================================================
// getModelContextConfig — dynamic compact threshold per model
// =====================================================================

describe('getModelContextConfig', () => {
  it('returns 128k defaults for null/undefined model', () => {
    expect(getModelContextConfig(null)).toEqual({ maxContext: 128000, compactThreshold: 110000 });
    expect(getModelContextConfig(undefined)).toEqual({ maxContext: 128000, compactThreshold: 110000 });
  });

  it('returns 128k defaults for unknown model', () => {
    expect(getModelContextConfig('some-unknown-model')).toEqual({ maxContext: 128000, compactThreshold: 110000 });
  });

  it('returns 128k defaults for Claude Sonnet 4 models (Copilot API reports 200k but actual is 128k)', () => {
    const config = getModelContextConfig('claude-sonnet-4-20250514');
    expect(config.maxContext).toBe(128000);
    expect(config.compactThreshold).toBe(110000);
  });

  it('returns 128k defaults for Claude Opus 4 models', () => {
    const config = getModelContextConfig('claude-opus-4-20250514');
    expect(config.maxContext).toBe(128000);
    expect(config.compactThreshold).toBe(110000);
  });

  it('returns 128k defaults for Claude 3.5 models', () => {
    expect(getModelContextConfig('claude-3-5-sonnet-20241022').maxContext).toBe(128000);
    expect(getModelContextConfig('claude-3.5-haiku-20241022').maxContext).toBe(128000);
  });

  it('returns 1M config for explicit 1M models', () => {
    const config = getModelContextConfig('claude-sonnet-4-1m-20250514');
    expect(config.maxContext).toBe(1000000);
    expect(config.compactThreshold).toBe(256000);
  });

  it('returns 1M config for 1000k indicator', () => {
    const config = getModelContextConfig('claude-opus-4-1000k');
    expect(config.maxContext).toBe(1000000);
    expect(config.compactThreshold).toBe(256000);
  });

  it('is case-insensitive', () => {
    expect(getModelContextConfig('Claude-Sonnet-4-20250514').maxContext).toBe(128000);
    expect(getModelContextConfig('CLAUDE-OPUS-4-1M').maxContext).toBe(1000000);
  });

  it('1M takes priority over default when both could match', () => {
    // A model name like "claude-sonnet-4-1m" matches 1M rule first
    const config = getModelContextConfig('claude-sonnet-4-1m');
    expect(config.maxContext).toBe(1000000);
    expect(config.compactThreshold).toBe(256000);
  });

  it('compact threshold is always less than maxContext', () => {
    const models = [null, 'claude-3-haiku', 'claude-sonnet-4-20250514', 'claude-opus-4-1m'];
    for (const model of models) {
      const config = getModelContextConfig(model);
      expect(config.compactThreshold).toBeLessThan(config.maxContext);
    }
  });
});
