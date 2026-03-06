import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

/**
 * Tests for task-36: Chat message area responsive width adaptation.
 *
 * Verifies:
 * 1) Base .messages rule has max-width: 800px, width: 100%, box-sizing: border-box
 * 2) At ≤768px: .messages gets max-width: none, padding: 0 16px
 * 3) At ≤480px: .messages padding shrinks to 0 10px, input-area padding reduces
 * 4) Workbench active at ≤1024px: .messages gets max-width: none
 * 5) Input-wrapper and attachments-preview also get max-width: none at ≤768px
 * 6) CSS structural integrity (balanced braces)
 */

let cssSource;

beforeAll(() => {
  const cssPath = resolve(__dirname, '../../web/style.css');
  cssSource = readFileSync(cssPath, 'utf-8');
});

// =====================================================================
// Helper: extract all media query blocks for a given max-width
// =====================================================================
function extractAllMediaBlocks(query) {
  const marker = `@media (max-width: ${query})`;
  const blocks = [];
  let searchFrom = 0;
  while (true) {
    const idx = cssSource.indexOf(marker, searchFrom);
    if (idx === -1) break;
    const openBrace = cssSource.indexOf('{', idx);
    if (openBrace === -1) break;
    let depth = 0;
    let end = openBrace;
    for (let i = openBrace; i < cssSource.length; i++) {
      if (cssSource[i] === '{') depth++;
      if (cssSource[i] === '}') depth--;
      if (depth === 0) { end = i; break; }
    }
    blocks.push(cssSource.substring(openBrace + 1, end).trim());
    searchFrom = end + 1;
  }
  return blocks;
}

// Find the media block that contains a specific selector
function findMediaBlockContaining(query, selector) {
  const blocks = extractAllMediaBlocks(query);
  return blocks.find(b => b.includes(selector)) || null;
}

// Helper: extract first occurrence of a CSS rule block for a given selector
function extractBlock(selector) {
  const idx = cssSource.indexOf(selector);
  if (idx === -1) return null;
  const openBrace = cssSource.indexOf('{', idx);
  if (openBrace === -1) return null;
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
// 1. Base .messages rule — wide screen defaults
// =====================================================================
describe('base .messages rule — wide screen defaults', () => {
  let block;
  beforeAll(() => {
    block = extractBlock('.messages {');
  });

  it('has max-width: 800px for centering on wide screens', () => {
    expect(block).toContain('max-width: 800px');
  });

  it('has width: 100% to fill container up to max-width', () => {
    expect(block).toContain('width: 100%');
  });

  it('has margin: 0 auto for horizontal centering', () => {
    expect(block).toContain('margin: 0 auto');
  });

  it('has padding: 0 24px as default side padding', () => {
    expect(block).toContain('padding: 0 24px');
  });

  it('has box-sizing: border-box to include padding in width', () => {
    expect(block).toContain('box-sizing: border-box');
  });
});

// =====================================================================
// 2. ≤768px media query — narrow viewport
// =====================================================================
describe('≤768px media query — narrow viewport', () => {
  let mediaBlock;
  beforeAll(() => {
    mediaBlock = findMediaBlockContaining('768px', '.messages');
  });

  it('768px media query with .messages exists', () => {
    expect(mediaBlock).not.toBeNull();
  });

  it('.messages gets max-width: none to fill full width', () => {
    const messagesIdx = mediaBlock.indexOf('.messages');
    const afterMessages = mediaBlock.substring(messagesIdx);
    const firstBlock = afterMessages.substring(0, afterMessages.indexOf('}') + 1);
    expect(firstBlock).toContain('max-width: none');
  });

  it('.messages padding reduces to 0 16px', () => {
    const messagesIdx = mediaBlock.indexOf('.messages');
    const afterMessages = mediaBlock.substring(messagesIdx);
    const firstBlock = afterMessages.substring(0, afterMessages.indexOf('}') + 1);
    expect(firstBlock).toContain('padding: 0 16px');
  });

  it('.input-wrapper gets max-width: none', () => {
    expect(mediaBlock).toContain('.input-wrapper');
    const inputIdx = mediaBlock.indexOf('.input-wrapper');
    const afterInput = mediaBlock.substring(inputIdx);
    const firstBlock = afterInput.substring(0, afterInput.indexOf('}') + 1);
    expect(firstBlock).toContain('max-width: none');
  });

  it('.attachments-preview gets max-width: none', () => {
    expect(mediaBlock).toContain('.attachments-preview');
    const attachIdx = mediaBlock.indexOf('.attachments-preview');
    const afterAttach = mediaBlock.substring(attachIdx);
    const firstBlock = afterAttach.substring(0, afterAttach.indexOf('}') + 1);
    expect(firstBlock).toContain('max-width: none');
  });
});

// =====================================================================
// 3. ≤480px media query — extra narrow viewport
// =====================================================================
describe('≤480px media query — extra narrow viewport', () => {
  let mediaBlock;
  beforeAll(() => {
    mediaBlock = findMediaBlockContaining('480px', '.messages');
  });

  it('480px media query with .messages exists', () => {
    expect(mediaBlock).not.toBeNull();
  });

  it('.messages padding shrinks to 0 10px', () => {
    const messagesIdx = mediaBlock.indexOf('.messages');
    const afterMessages = mediaBlock.substring(messagesIdx);
    const firstBlock = afterMessages.substring(0, afterMessages.indexOf('}') + 1);
    expect(firstBlock).toContain('padding: 0 10px');
  });

  it('.input-area padding reduces for extra narrow screens', () => {
    expect(mediaBlock).toContain('.input-area');
    const inputIdx = mediaBlock.indexOf('.input-area');
    const afterInput = mediaBlock.substring(inputIdx);
    const firstBlock = afterInput.substring(0, afterInput.indexOf('}') + 1);
    expect(firstBlock).toContain('padding: 8px 10px');
  });

  it('.input-area has safe-area-inset-bottom for mobile notch', () => {
    const inputIdx = mediaBlock.indexOf('.input-area');
    const afterInput = mediaBlock.substring(inputIdx);
    const firstBlock = afterInput.substring(0, afterInput.indexOf('}') + 1);
    expect(firstBlock).toContain('env(safe-area-inset-bottom');
  });
});

// =====================================================================
// 4. Workbench active — ≤1024px media query
// =====================================================================
describe('workbench active — ≤1024px responsive', () => {
  let mediaBlock;
  beforeAll(() => {
    mediaBlock = findMediaBlockContaining('1024px', '.main-content.workbench-active .messages');
  });

  it('workbench-active .messages gets max-width: none at ≤1024px', () => {
    expect(mediaBlock).not.toBeNull();
    const msgIdx = mediaBlock.indexOf('.main-content.workbench-active .messages');
    const afterMsg = mediaBlock.substring(msgIdx);
    const firstBlock = afterMsg.substring(0, afterMsg.indexOf('}') + 1);
    expect(firstBlock).toContain('max-width: none');
  });

  it('workbench-active .messages padding: 0 16px at ≤1024px', () => {
    const msgIdx = mediaBlock.indexOf('.main-content.workbench-active .messages');
    const afterMsg = mediaBlock.substring(msgIdx);
    const firstBlock = afterMsg.substring(0, afterMsg.indexOf('}') + 1);
    expect(firstBlock).toContain('padding: 0 16px');
  });

  it('workbench-active .input-wrapper gets max-width: none at ≤1024px', () => {
    expect(mediaBlock).toContain('.main-content.workbench-active .input-wrapper');
    const idx = mediaBlock.indexOf('.main-content.workbench-active .input-wrapper');
    const afterIdx = mediaBlock.substring(idx);
    const block = afterIdx.substring(0, afterIdx.indexOf('}') + 1);
    expect(block).toContain('max-width: none');
  });

  it('workbench-active .attachments-preview gets max-width: none at ≤1024px', () => {
    expect(mediaBlock).toContain('.main-content.workbench-active .attachments-preview');
    const idx = mediaBlock.indexOf('.main-content.workbench-active .attachments-preview');
    const afterIdx = mediaBlock.substring(idx);
    const block = afterIdx.substring(0, afterIdx.indexOf('}') + 1);
    expect(block).toContain('max-width: none');
  });
});

// =====================================================================
// 5. Padding progression — values decrease as viewport narrows
// =====================================================================
describe('padding progression — decreases with viewport', () => {
  it('base padding (24px) > 768px padding (16px) > 480px padding (10px)', () => {
    const baseBlock = extractBlock('.messages {');
    expect(baseBlock).toContain('padding: 0 24px');

    const media768 = findMediaBlockContaining('768px', '.messages');
    const msg768Idx = media768.indexOf('.messages');
    const after768 = media768.substring(msg768Idx);
    const block768 = after768.substring(0, after768.indexOf('}') + 1);
    expect(block768).toContain('padding: 0 16px');

    const media480 = findMediaBlockContaining('480px', '.messages');
    const msg480Idx = media480.indexOf('.messages');
    const after480 = media480.substring(msg480Idx);
    const block480 = after480.substring(0, after480.indexOf('}') + 1);
    expect(block480).toContain('padding: 0 10px');
  });

  it('wide screen max-width: 800px is removed at 768px breakpoint', () => {
    const baseBlock = extractBlock('.messages {');
    expect(baseBlock).toContain('max-width: 800px');

    const media768 = findMediaBlockContaining('768px', '.messages');
    const msg768Idx = media768.indexOf('.messages');
    const after768 = media768.substring(msg768Idx);
    const block768 = after768.substring(0, after768.indexOf('}') + 1);
    expect(block768).toContain('max-width: none');
  });
});

// =====================================================================
// 6. CSS structural integrity
// =====================================================================
describe('CSS structural integrity', () => {
  it('CSS has balanced braces (2143/2143)', () => {
    const opens = (cssSource.match(/\{/g) || []).length;
    const closes = (cssSource.match(/\}/g) || []).length;
    expect(opens).toBe(closes);
    expect(opens).toBe(2143);
  });
});
