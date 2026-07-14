import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const read = path => readFileSync(new URL(`../../web/${path}`, import.meta.url), 'utf8');
const page = read('components/YeaftPage.js');
const panel = read('components/YeaftTranscriptSearch.js');
const list = read('components/MessageList.js');
const virtual = read('components/VirtualTranscript.js');
const store = read('stores/chat.js');
const css = read('styles/yeaft.css');

describe('Yeaft Session history search UI', () => {
  it('uses a debounced server-side query and rejects stale compound identities', () => {
    expect(page).toContain('setTimeout(() => store.searchYeaftHistory(query), 220)');
    expect(store).toContain("type: 'yeaft_search_history'");
    expect(store).toContain('msg.requestId !== state.requestId');
    expect(store).toContain('msg.agentId !== state.agentId || msg.sessionId !== state.sessionId');
    expect(store).toContain("type: 'yeaft_load_history_window'");
  });

  it('supports keyboard discovery and accessible result activation', () => {
    expect(page).toContain("(e.metaKey || e.ctrlKey) && String(e.key).toLowerCase() === 'f'");
    expect(panel).toContain('role="listbox"');
    expect(panel).toContain('role="option"');
    expect(panel).toContain("event.key === 'ArrowDown'");
    expect(panel).toContain("event.key === 'Enter'");
    expect(panel).toContain("event.key === 'Escape'");
  });

  it('reveals hidden turns, scrolls the virtual transcript by key, and flashes the exact row', () => {
    expect(store).toContain('buildYeaftMessageTurnSpans(scoped)');
    expect(list).toContain("virtualTranscriptRef.value?.scrollToKey?.(block.id, { align: 'center' })");
    expect(list).toContain("querySelectorAll?.('[data-msg-id]')");
    expect(virtual).toContain('expose({ scrollToKey, scrollToIndex })');
    expect(css).toContain('@keyframes yeaft-history-search-flash');
  });
});
