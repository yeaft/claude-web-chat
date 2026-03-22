import { describe, it, expect } from 'vitest';
import { EXPERT_ROLES, buildExpertMessage } from '../../agent/expert-roles.js';

/**
 * Tests for PR #298 — Expert panel prompt upgrade (task-116b).
 *
 * Validates:
 * 1. Module loads: EXPERT_ROLES has 26 roles
 * 2. Structure: every role has required fields (name, messagePrefix/En, actions)
 * 3. Actions: every action has all 6 string fields
 * 4. messageTemplate format: ends with \n\n for extractFocusLine compatibility
 * 5. extractFocusLine: every template splits correctly on 。 or .
 * 6. buildExpertMessage: single+action+text, single+action+no-text, pure role+text, multi-select
 * 7. Bilingual: zh-CN and en both work
 * 8. Edge cases: invalid role, invalid action → fallback
 */

const ALL_ROLE_KEYS = Object.keys(EXPERT_ROLES);

// =====================================================================
// 1. Module loads with 26 roles
// =====================================================================
describe('EXPERT_ROLES: 26 roles loaded', () => {
  it('has exactly 26 roles', () => {
    expect(ALL_ROLE_KEYS).toHaveLength(26);
  });

  it('has expected team distribution (12 dev + 6 trading + 4 writing + 4 video)', () => {
    const dev = ['jobs', 'fowler', 'torvalds', 'beck', 'schneier', 'rams', 'graham', 'hightower', 'gregg', 'codd', 'knuth', 'thomas'];
    const trading = ['soros', 'livermore', 'dalio', 'taleb', 'jones', 'simons'];
    const writing = ['jinyong', 'zhouzi', 'qiongyao', 'luxun'];
    const video = ['kubrick', 'kaufman', 'spielberg', 'schoonmaker'];
    for (const key of [...dev, ...trading, ...writing, ...video]) {
      expect(EXPERT_ROLES).toHaveProperty(key);
    }
  });
});

// =====================================================================
// 2. Every role has required top-level fields
// =====================================================================
describe('role structure: required fields', () => {
  for (const key of ALL_ROLE_KEYS) {
    const role = EXPERT_ROLES[key];

    it(`${key} has name, messagePrefix, messagePrefixEn, actions`, () => {
      expect(typeof role.name).toBe('string');
      expect(role.name.length).toBeGreaterThan(0);
      expect(typeof role.messagePrefix).toBe('string');
      expect(role.messagePrefix.length).toBeGreaterThan(0);
      expect(typeof role.messagePrefixEn).toBe('string');
      expect(role.messagePrefixEn.length).toBeGreaterThan(0);
      expect(typeof role.actions).toBe('object');
      expect(Object.keys(role.actions).length).toBeGreaterThan(0);
    });
  }
});

// =====================================================================
// 3. Every action has all 6 string fields
// =====================================================================
describe('action structure: all 6 fields present', () => {
  for (const roleKey of ALL_ROLE_KEYS) {
    const role = EXPERT_ROLES[roleKey];
    for (const [actionKey, action] of Object.entries(role.actions)) {
      it(`${roleKey}.${actionKey} has name, nameEn, messageTemplate(En), defaultMessage(En)`, () => {
        expect(typeof action.name).toBe('string');
        expect(action.name.length).toBeGreaterThan(0);
        expect(typeof action.nameEn).toBe('string');
        expect(action.nameEn.length).toBeGreaterThan(0);
        expect(typeof action.messageTemplate).toBe('string');
        expect(action.messageTemplate.length).toBeGreaterThan(10);
        expect(typeof action.messageTemplateEn).toBe('string');
        expect(action.messageTemplateEn.length).toBeGreaterThan(10);
        expect(typeof action.defaultMessage).toBe('string');
        expect(action.defaultMessage.length).toBeGreaterThan(10);
        expect(typeof action.defaultMessageEn).toBe('string');
        expect(action.defaultMessageEn.length).toBeGreaterThan(10);
      });
    }
  }
});

// =====================================================================
// 4. messageTemplate format: ends with \n\n (extractFocusLine dependency)
// =====================================================================
describe('messageTemplate format: ends with \\n\\n', () => {
  for (const roleKey of ALL_ROLE_KEYS) {
    const role = EXPERT_ROLES[roleKey];
    for (const [actionKey, action] of Object.entries(role.actions)) {
      it(`${roleKey}.${actionKey} zh template ends with \\n\\n`, () => {
        expect(action.messageTemplate).toMatch(/\n\n$/);
      });

      it(`${roleKey}.${actionKey} en template ends with \\n\\n`, () => {
        expect(action.messageTemplateEn).toMatch(/\n\n$/);
      });
    }
  }
});

// =====================================================================
// 5. extractFocusLine compatibility: templates split on 。 or .
// =====================================================================
describe('extractFocusLine: templates parseable', () => {
  // Replicate extractFocusLine logic
  function extractFocusLine(template) {
    if (!template) return '';
    const trimmed = template.replace(/\n\n$/, '');
    const zhMatch = trimmed.match(/。(.+)$/);
    if (zhMatch) return zhMatch[1];
    const enMatch = trimmed.match(/\.\s+(.+)$/);
    if (enMatch) return enMatch[1];
    return trimmed;
  }

  for (const roleKey of ALL_ROLE_KEYS) {
    const role = EXPERT_ROLES[roleKey];
    for (const [actionKey, action] of Object.entries(role.actions)) {
      it(`${roleKey}.${actionKey} zh template yields non-empty focus line`, () => {
        const line = extractFocusLine(action.messageTemplate);
        expect(line.length).toBeGreaterThan(0);
      });

      it(`${roleKey}.${actionKey} en template yields non-empty focus line`, () => {
        const line = extractFocusLine(action.messageTemplateEn);
        expect(line.length).toBeGreaterThan(0);
      });
    }
  }
});

// =====================================================================
// 6. buildExpertMessage integration tests
// =====================================================================
describe('buildExpertMessage: single selection scenarios', () => {

  it('action + user text: returns messageTemplate + text (zh)', () => {
    const result = buildExpertMessage(
      [{ role: 'jobs', action: 'product-analysis' }],
      '分析这个功能',
      'zh-CN'
    );
    expect(result.effectivePrompt).toContain('Steve Jobs');
    expect(result.effectivePrompt).toContain('分析这个功能');
    expect(result.displayPrompt).toBe('分析这个功能');
  });

  it('action + user text: returns messageTemplateEn + text (en)', () => {
    const result = buildExpertMessage(
      [{ role: 'jobs', action: 'product-analysis' }],
      'analyze this feature',
      'en'
    );
    expect(result.effectivePrompt).toContain('Steve Jobs');
    expect(result.effectivePrompt).toContain('analyze this feature');
  });

  it('action + no text: returns defaultMessage (zh)', () => {
    const result = buildExpertMessage(
      [{ role: 'torvalds', action: 'code-review' }],
      '',
      'zh-CN'
    );
    // Should be defaultMessage, not messageTemplate + empty
    expect(result.effectivePrompt).toContain('Torvalds');
    expect(result.effectivePrompt.length).toBeGreaterThan(50);
    expect(result.displayPrompt).toContain('@Torvalds');
  });

  it('action + no text: returns defaultMessageEn (en)', () => {
    const result = buildExpertMessage(
      [{ role: 'torvalds', action: 'code-review' }],
      '',
      'en'
    );
    expect(result.effectivePrompt).toContain('Torvalds');
    expect(result.effectivePrompt.length).toBeGreaterThan(50);
  });

  it('pure role + user text: returns messagePrefix + text', () => {
    const result = buildExpertMessage(
      [{ role: 'beck', action: null }],
      '如何写测试',
      'zh-CN'
    );
    expect(result.effectivePrompt).toContain('Beck');
    expect(result.effectivePrompt).toContain('如何写测试');
  });

  it('pure role + text (en): returns messagePrefixEn + text', () => {
    const result = buildExpertMessage(
      [{ role: 'beck', action: null }],
      'how to write tests',
      'en'
    );
    expect(result.effectivePrompt).toContain('Beck');
    expect(result.effectivePrompt).toContain('how to write tests');
  });
});

describe('buildExpertMessage: multi-selection', () => {

  it('multi + user text: combines all roles with numbered list', () => {
    const result = buildExpertMessage(
      [
        { role: 'jobs', action: 'product-analysis' },
        { role: 'fowler', action: 'architecture' }
      ],
      '审查这个系统',
      'zh-CN'
    );
    expect(result.effectivePrompt).toContain('1. Jobs');
    expect(result.effectivePrompt).toContain('2. Fowler');
    expect(result.effectivePrompt).toContain('审查这个系统');
  });

  it('multi + no text: uses default header about current code', () => {
    const result = buildExpertMessage(
      [
        { role: 'schneier', action: 'security-audit' },
        { role: 'gregg', action: 'perf-analysis' }
      ],
      '',
      'zh-CN'
    );
    expect(result.effectivePrompt).toContain('当前对话中的代码');
    expect(result.displayPrompt).toContain('@Schneier');
    expect(result.displayPrompt).toContain('@Gregg');
  });
});

describe('buildExpertMessage: edge cases', () => {

  it('invalid role: falls back to user text', () => {
    const result = buildExpertMessage(
      [{ role: 'nonexistent', action: 'whatever' }],
      'my text',
      'zh-CN'
    );
    expect(result.displayPrompt).toBe('my text');
    expect(result.effectivePrompt).toBe('my text');
  });

  it('valid role + invalid action: falls back to messagePrefix + text', () => {
    const result = buildExpertMessage(
      [{ role: 'jobs', action: 'nonexistent-action' }],
      'test text',
      'zh-CN'
    );
    expect(result.effectivePrompt).toContain('Steve Jobs');
    expect(result.effectivePrompt).toContain('test text');
  });

  it('empty selections: returns raw user text', () => {
    const result = buildExpertMessage([], 'just text', 'zh-CN');
    expect(result.displayPrompt).toBe('just text');
    expect(result.effectivePrompt).toBe('just text');
  });

  it('null selections: returns raw user text', () => {
    const result = buildExpertMessage(null, 'just text', 'zh-CN');
    expect(result.displayPrompt).toBe('just text');
    expect(result.effectivePrompt).toBe('just text');
  });
});

// =====================================================================
// 7. Bilingual: all roles have both zh and en prefix content
// =====================================================================
describe('bilingual: messagePrefix zh vs en are different', () => {
  for (const key of ALL_ROLE_KEYS) {
    const role = EXPERT_ROLES[key];
    it(`${key} zh and en prefixes are different strings`, () => {
      expect(role.messagePrefix).not.toBe(role.messagePrefixEn);
    });
  }
});
