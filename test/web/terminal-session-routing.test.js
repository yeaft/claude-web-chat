import { readFileSync } from 'fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('../../web/components/TerminalTab.js', import.meta.url), 'utf8');

describe('Yeaft Session terminal routing', () => {
  it('pins every terminal frame to the currently selected Agent', () => {
    for (const type of ['terminal_create', 'terminal_input', 'terminal_resize', 'terminal_close']) {
      expect(source).toMatch(new RegExp(`type: '${type}',\\s*agentId: store\\.currentAgent,`));
    }
  });
});
