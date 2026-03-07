import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { loadAllCss } from '../helpers/loadCss.js';

/**
 * Tests for dev-3/remove-crew-maxwidth: remove max-width constraints
 * from crew chat panel content area.
 *
 * Verifies:
 * 1) crew-message, crew-turn-divider, crew-task-panel, crew-feature-thread,
 *    crew-round-divider, crew-streaming-indicator
 *    no longer have max-width in their base rules
 * 2) crew-input-area .input-hints and .input-wrapper max-width overridden to none
 * 3) Responsive breakpoints (1279px/1023px/767px) still work
 * 4) Normal chat .input-hints and .input-wrapper still have max-width: min(90%, 960px)
 */

let cssSource;

beforeAll(() => {
  cssSource = loadAllCss();
});

// =====================================================================
// Helper: extract a CSS rule block for a given selector
// =====================================================================
function extractBlock(selector) {
  // Find the selector in source, then grab content between { and matching }
  const idx = cssSource.indexOf(selector);
  if (idx === -1) return null;
  const openBrace = cssSource.indexOf('{', idx);
  if (openBrace === -1) return null;
  // Find matching close brace (handles nested braces)
  let depth = 0;
  let end = openBrace;
  for (let i = openBrace; i < cssSource.length; i++) {
    if (cssSource[i] === '{') depth++;
    if (cssSource[i] === '}') depth--;
    if (depth === 0) { end = i; break; }
  }
  return cssSource.substring(openBrace + 1, end).trim();
}

// =====================================================================
// 1. Crew content selectors should NOT have max-width in base rules
// =====================================================================
describe('crew content selectors — no max-width', () => {
  const selectors = [
    { css: '.crew-message {', label: 'crew-message' },
    { css: '.crew-turn-divider {', label: 'crew-turn-divider' },
    { css: '.crew-task-panel {', label: 'crew-task-panel' },
    { css: '.crew-feature-thread {', label: 'crew-feature-thread' },
    { css: '.crew-round-divider {', label: 'crew-round-divider' },
    { css: '.crew-streaming-indicator {', label: 'crew-streaming-indicator' },
  ];

  for (const { css, label } of selectors) {
    describe(label, () => {
      it('selector exists in CSS', () => {
        expect(cssSource).toContain(css);
      });

      it('base rule does NOT contain max-width', () => {
        const block = extractBlock(css);
        expect(block).not.toBeNull();
        expect(block).not.toContain('max-width');
      });

      it('has width: 100%', () => {
        const block = extractBlock(css);
        expect(block).toContain('width: 100%');
      });

      it('has box-sizing: border-box', () => {
        const block = extractBlock(css);
        expect(block).toContain('box-sizing: border-box');
      });
    });
  }

  describe('crew-message — no margin: 0 auto', () => {
    it('should not have margin: 0 auto (was used for centering with max-width)', () => {
      const block = extractBlock('.crew-message {');
      expect(block).not.toContain('margin: 0 auto');
    });
  });

  describe('crew-turn-divider — no margin: 2px auto', () => {
    it('should not have margin with auto centering', () => {
      const block = extractBlock('.crew-turn-divider {');
      expect(block).not.toContain('auto');
    });
  });

  describe('crew-task-panel — margin uses 0 not auto', () => {
    it('should have margin: 8px 0 4px (not auto)', () => {
      const block = extractBlock('.crew-task-panel {');
      expect(block).toContain('margin: 8px 0 4px');
      expect(block).not.toContain('auto');
    });
  });

  describe('crew-feature-thread — margin uses 0 not auto', () => {
    it('should have margin: 8px 0 (not auto)', () => {
      const block = extractBlock('.crew-feature-thread {');
      expect(block).toContain('margin: 8px 0');
      expect(block).not.toContain('auto');
    });
  });

  describe('crew-round-divider — no margin: 0 auto', () => {
    it('should not have margin: 0 auto', () => {
      const block = extractBlock('.crew-round-divider {');
      expect(block).not.toContain('margin: 0 auto');
    });
  });

  describe('crew-streaming-indicator — no margin: 0 auto', () => {
    it('should not have margin: 0 auto', () => {
      const block = extractBlock('.crew-streaming-indicator {');
      expect(block).not.toContain('margin: 0 auto');
    });
  });

  describe('crew-input-area .crew-input-hints — no max-width', () => {
    it('should not have max-width in the crew-specific input hints', () => {
      const block = extractBlock('.crew-input-area .crew-input-hints {');
      expect(block).not.toBeNull();
      expect(block).not.toContain('max-width');
    });
  });
});

// =====================================================================
// 2. crew-input-area overrides for .input-hints and .input-wrapper
// =====================================================================
describe('crew-input-area — input max-width overrides', () => {
  describe('.crew-input-area .input-hints', () => {
    it('override rule exists', () => {
      expect(cssSource).toContain('.crew-input-area .input-hints {');
    });

    it('sets max-width to none', () => {
      const block = extractBlock('.crew-input-area .input-hints {');
      expect(block).not.toBeNull();
      expect(block).toContain('max-width: none');
    });
  });

  describe('.crew-input-area .input-wrapper', () => {
    it('override rule exists', () => {
      expect(cssSource).toContain('.crew-input-area .input-wrapper {');
    });

    it('sets max-width to none', () => {
      const block = extractBlock('.crew-input-area .input-wrapper {');
      expect(block).not.toBeNull();
      expect(block).toContain('max-width: none');
    });
  });

  it('overrides appear after the crew-input-area base rule', () => {
    const baseIdx = cssSource.indexOf('.crew-input-area {');
    const hintsOverrideIdx = cssSource.indexOf('.crew-input-area .input-hints {');
    const wrapperOverrideIdx = cssSource.indexOf('.crew-input-area .input-wrapper {');

    expect(baseIdx).toBeGreaterThan(-1);
    expect(hintsOverrideIdx).toBeGreaterThan(baseIdx);
    expect(wrapperOverrideIdx).toBeGreaterThan(baseIdx);
  });
});

// =====================================================================
// 3. Responsive breakpoints still exist and work
// =====================================================================
describe('responsive breakpoints — still present', () => {
  it('1279px breakpoint exists', () => {
    expect(cssSource).toContain('@media (max-width: 1279px)');
  });

  it('1023px breakpoint exists', () => {
    expect(cssSource).toContain('@media (max-width: 1023px)');
  });

  it('767px breakpoint exists', () => {
    expect(cssSource).toContain('@media (max-width: 767px)');
  });

  describe('1279px breakpoint — left panel collapses to icon bar', () => {
    it('contains crew-panel-left rule', () => {
      const idx = cssSource.indexOf('@media (max-width: 1279px)');
      const blockStart = cssSource.indexOf('{', idx);
      let depth = 0;
      let end = blockStart;
      for (let i = blockStart; i < cssSource.length; i++) {
        if (cssSource[i] === '{') depth++;
        if (cssSource[i] === '}') depth--;
        if (depth === 0) { end = i; break; }
      }
      const mediaBlock = cssSource.substring(blockStart, end + 1);
      expect(mediaBlock).toContain('.crew-panel-left');
    });
  });

  describe('1023px breakpoint — hide left panel', () => {
    it('contains crew-panel-left display none', () => {
      const idx = cssSource.indexOf('@media (max-width: 1023px)');
      const blockStart = cssSource.indexOf('{', idx);
      let depth = 0;
      let end = blockStart;
      for (let i = blockStart; i < cssSource.length; i++) {
        if (cssSource[i] === '{') depth++;
        if (cssSource[i] === '}') depth--;
        if (depth === 0) { end = i; break; }
      }
      const mediaBlock = cssSource.substring(blockStart, end + 1);
      expect(mediaBlock).toContain('.crew-panel-left');
      expect(mediaBlock).toContain('display: none');
    });
  });

  describe('767px breakpoint — mobile drawer panels', () => {
    function get767Block() {
      const idx = cssSource.indexOf('@media (max-width: 767px)');
      const blockStart = cssSource.indexOf('{', idx);
      let depth = 0;
      let end = blockStart;
      for (let i = blockStart; i < cssSource.length; i++) {
        if (cssSource[i] === '{') depth++;
        if (cssSource[i] === '}') depth--;
        if (depth === 0) { end = i; break; }
      }
      return cssSource.substring(blockStart, end + 1);
    }

    it('panels use fixed position drawer mode', () => {
      const mediaBlock = get767Block();
      expect(mediaBlock).toContain('.crew-panel-left');
      expect(mediaBlock).toContain('.crew-panel-right');
      expect(mediaBlock).toContain('position: fixed');
      expect(mediaBlock).toContain('transform: translateX(-100%)');
      expect(mediaBlock).toContain('transform: translateX(100%)');
    });

    it('panels slide in via mobile-panel classes', () => {
      const mediaBlock = get767Block();
      expect(mediaBlock).toContain('.crew-workspace.mobile-panel-roles .crew-panel-left');
      expect(mediaBlock).toContain('.crew-workspace.mobile-panel-features .crew-panel-right');
      expect(mediaBlock).toContain('transform: translateX(0)');
    });
  });

  describe('768px breakpoint — crew mobile element adjustments', () => {
    // The 768px general breakpoint contains crew element mobile rules
    function get768Block() {
      // Find the LAST @media (max-width: 768px) block which contains crew rules
      let lastIdx = -1;
      let searchFrom = 0;
      while (true) {
        const found = cssSource.indexOf('@media (max-width: 768px)', searchFrom);
        if (found === -1) break;
        lastIdx = found;
        searchFrom = found + 1;
      }
      const blockStart = cssSource.indexOf('{', lastIdx);
      let depth = 0;
      let end = blockStart;
      for (let i = blockStart; i < cssSource.length; i++) {
        if (cssSource[i] === '{') depth++;
        if (cssSource[i] === '}') depth--;
        if (depth === 0) { end = i; break; }
      }
      return cssSource.substring(blockStart, end + 1);
    }

    it('contains crew-message mobile rule', () => {
      expect(get768Block()).toContain('.crew-message');
    });

    it('contains crew-streaming-indicator mobile rule', () => {
      expect(get768Block()).toContain('.crew-streaming-indicator');
    });

    it('contains crew-input-area .crew-input-hints mobile rule', () => {
      expect(get768Block()).toContain('.crew-input-area .crew-input-hints');
    });
  });
});

// =====================================================================
// 4. Normal chat .input-hints and .input-wrapper still have max-width: min(90%, 960px)
// =====================================================================
describe('normal chat — max-width preserved', () => {
  describe('.input-hints (global)', () => {
    it('exists in CSS', () => {
      expect(cssSource).toContain('.input-hints {');
    });

    it('has max-width: min(90%, 960px)', () => {
      // Find the global .input-hints (not .crew-input-area .input-hints)
      // The global rule starts with just ".input-hints {" not prefixed by .crew
      const block = extractBlock('.input-hints {');
      expect(block).not.toBeNull();
      expect(block).toContain('max-width: min(90%, 960px)');
    });
  });

  describe('.input-wrapper (global)', () => {
    it('exists in CSS', () => {
      expect(cssSource).toContain('.input-wrapper {');
    });

    it('has max-width: min(90%, 960px)', () => {
      const block = extractBlock('.input-wrapper {');
      expect(block).not.toBeNull();
      expect(block).toContain('max-width: min(90%, 960px)');
    });
  });

  it('global .input-hints max-width is different from crew override', () => {
    const globalBlock = extractBlock('.input-hints {');
    const crewBlock = extractBlock('.crew-input-area .input-hints {');

    expect(globalBlock).toContain('max-width: min(90%, 960px)');
    expect(crewBlock).toContain('max-width: none');
  });

  it('global .input-wrapper max-width is different from crew override', () => {
    const globalBlock = extractBlock('.input-wrapper {');
    const crewBlock = extractBlock('.crew-input-area .input-wrapper {');

    expect(globalBlock).toContain('max-width: min(90%, 960px)');
    expect(crewBlock).toContain('max-width: none');
  });
});

// =====================================================================
// 5. CSS structural integrity
// =====================================================================
describe('CSS structural integrity', () => {
  it('CSS has balanced braces (2085/2085)', () => {
    const opens = (cssSource.match(/\{/g) || []).length;
    const closes = (cssSource.match(/\}/g) || []).length;
    expect(opens).toBe(closes);
    expect(opens).toBe(2085);
  });

  it('no duplicate max-width declarations accidentally left in crew selectors', () => {
    // Check that none of the 7 crew selectors have max-width: 800px anywhere
    const crewSelectors = [
      '.crew-message', '.crew-turn-divider', '.crew-task-panel',
      '.crew-feature-thread', '.crew-round-divider',
      '.crew-streaming-indicator'
    ];

    for (const sel of crewSelectors) {
      const block = extractBlock(`${sel} {`);
      if (block) {
        expect(block).not.toContain('max-width: 800px');
      }
    }
  });
});

// =====================================================================
// 6. Kanban total styling
// =====================================================================
describe('crew-kanban-total — styling', () => {
  it('has padding for spacing', () => {
    const block = extractBlock('.crew-kanban-total {');
    expect(block).not.toBeNull();
    expect(block).toContain('padding:');
  });
});
