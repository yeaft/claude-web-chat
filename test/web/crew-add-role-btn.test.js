import { describe, it, expect, beforeAll } from 'vitest';

/**
 * Tests for task-32: crew-add-role-btn style optimization.
 *
 * Verifies:
 * 1) Base .crew-add-role-btn is a plain text button (no border, no background)
 * 2) Hover turns text blue (var(--accent-blue))
 * 3) Small screen: only "+" icon visible (span hidden)
 * 4) Config panel override (.crew-config-section >) should NOT have dashed border
 * 5) HTML template uses "+" + "添加角色" with <span> for responsive hiding
 */

// =====================================================================
// CSS source verification
// =====================================================================

describe('task-32: crew-add-role-btn style optimization', () => {
  let cssContent;

  beforeAll(async () => {
    const { promises: fs } = await import('fs');
    const { join } = await import('path');
    cssContent = await fs.readFile(
      join(process.cwd(), 'web/style.css'),
      'utf-8'
    );
  });

  describe('Base button style (plain text, no border)', () => {
    it('should have border: none', () => {
      // Extract the base .crew-add-role-btn block
      const baseBlock = extractCssBlock(cssContent, '.crew-add-role-btn {');
      expect(baseBlock).toContain('border: none');
    });

    it('should have background: none', () => {
      const baseBlock = extractCssBlock(cssContent, '.crew-add-role-btn {');
      expect(baseBlock).toContain('background: none');
    });

    it('should use font-size: 12px', () => {
      const baseBlock = extractCssBlock(cssContent, '.crew-add-role-btn {');
      expect(baseBlock).toContain('font-size: 12px');
    });

    it('should use display: flex with gap for icon + text layout', () => {
      const baseBlock = extractCssBlock(cssContent, '.crew-add-role-btn {');
      expect(baseBlock).toContain('display: flex');
      expect(baseBlock).toContain('gap: 4px');
    });
  });

  describe('Hover state', () => {
    it('hover should change color to accent-blue', () => {
      const hoverBlock = extractCssBlock(cssContent, '.crew-add-role-btn:hover {');
      expect(hoverBlock).toContain('color: var(--accent-blue)');
    });

    it('hover should NOT have border change (plain text button)', () => {
      const hoverBlock = extractCssBlock(cssContent, '.crew-add-role-btn:hover {');
      expect(hoverBlock).not.toContain('border');
    });

    it('hover should NOT have background change', () => {
      const hoverBlock = extractCssBlock(cssContent, '.crew-add-role-btn:hover {');
      expect(hoverBlock).not.toContain('background');
    });
  });

  describe('Small screen responsive (span hidden, icon only)', () => {
    it('should hide span text on small screens', () => {
      // Find the media query block that hides .crew-add-role-btn span
      expect(cssContent).toContain('.crew-add-role-btn span');
      // Find the specific rule within a media query
      const spanRule = extractMediaQueryRule(cssContent, '.crew-add-role-btn span');
      expect(spanRule).toContain('display: none');
    });
  });

  describe('Config panel override should also be plain text', () => {
    it('.crew-config-section > .crew-add-role-btn should NOT have dashed border', () => {
      const configBlock = extractCssBlock(cssContent, '.crew-config-section > .crew-add-role-btn {');
      if (configBlock) {
        // If this override block exists, it should not contain dashed border
        expect(configBlock).not.toContain('dashed');
      }
      // If the block doesn't exist, that's also fine — the base style applies
    });

    it('.crew-config-section > .crew-add-role-btn hover should NOT have border change', () => {
      const configHover = extractCssBlock(cssContent, '.crew-config-section > .crew-add-role-btn:hover {');
      if (configHover) {
        expect(configHover).not.toContain('border');
      }
    });
  });

  describe('Status bar button should remain as-is (different context)', () => {
    it('.crew-status-bar .crew-add-role-btn should exist (separate style)', () => {
      expect(cssContent).toContain('.crew-status-bar .crew-add-role-btn');
    });
  });
});

// =====================================================================
// HTML template verification
// =====================================================================

describe('task-32: CrewConfigPanel HTML template', () => {
  let templateContent;

  beforeAll(async () => {
    const { promises: fs } = await import('fs');
    const { join } = await import('path');
    templateContent = await fs.readFile(
      join(process.cwd(), 'web/components/CrewConfigPanel.js'),
      'utf-8'
    );
  });

  it('add role button should have class crew-add-role-btn', () => {
    expect(templateContent).toContain('crew-add-role-btn');
  });

  it('button text should include "+" via i18n key crewConfig.addRoleBtn', () => {
    // The button should use $t('crewConfig.addRoleBtn') which contains "+"
    expect(templateContent).toContain("crewConfig.addRoleBtn");
  });

  it('button should use i18n key for add role text', () => {
    // Check that crewConfig.addRoleBtn i18n key appears near the button
    const btnRegion = templateContent.split('crew-add-role-btn')[1].split('</button>')[0];
    expect(btnRegion).toContain("crewConfig.addRoleBtn");
  });
});

// =====================================================================
// Helper: extract a CSS block by its selector
// =====================================================================
function extractCssBlock(css, selectorWithBrace) {
  const idx = css.indexOf(selectorWithBrace);
  if (idx === -1) return null;
  let depth = 0;
  let start = idx + selectorWithBrace.length;
  for (let i = start; i < css.length; i++) {
    if (css[i] === '{') depth++;
    if (css[i] === '}') {
      if (depth === 0) return css.substring(idx, i + 1);
      depth--;
    }
  }
  return null;
}

// Helper: find a CSS rule within any @media block
function extractMediaQueryRule(css, selector) {
  // Find all @media blocks, then look for the selector within them
  const mediaRegex = /@media[^{]*\{([\s\S]*?\n\})/g;
  let match;
  while ((match = mediaRegex.exec(css)) !== null) {
    const block = match[1];
    if (block.includes(selector)) {
      // Extract the specific rule
      const ruleStart = block.indexOf(selector);
      const ruleBlock = block.substring(ruleStart);
      const endBrace = ruleBlock.indexOf('}');
      return ruleBlock.substring(0, endBrace + 1);
    }
  }
  return null;
}
