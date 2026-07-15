import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const read = path => readFileSync(new URL(`../../web/${path}`, import.meta.url), 'utf8');
const page = read('components/YeaftPage.js');
const panel = read('components/YeaftTranscriptSearch.js');
const list = read('components/MessageList.js');
const virtual = read('components/VirtualTranscript.js');
const navigation = read('utils/message-search-navigation.js');
const store = read('stores/chat.js');
const css = read('styles/yeaft.css');
const agent = read('../agent/index.js');
const relay = read('../server/handlers/client-conversation.js');
const agentHandler = read('stores/helpers/handlers/agentHandler.js');

describe('Yeaft Session history search UI', () => {
  it('uses a debounced server-side query and rejects stale compound identities', () => {
    expect(page).toContain('setTimeout(() => store.searchYeaftHistory(query), 220)');
    expect(store).toContain("type: 'yeaft_search_history'");
    expect(store).toContain('msg.requestId !== state.requestId');
    expect(store).toContain('msg.agentId !== state.agentId || msg.sessionId !== state.sessionId');
    expect(store).toContain("type: 'yeaft_load_history_window'");
  });

  it('floats over the conversation instead of consuming message layout space', () => {
    expect(css).toMatch(/\.yeaft-main-center\s*\{[\s\S]*?position: relative;/);
    expect(css).toMatch(/\.yeaft-transcript-search\s*\{[\s\S]*?position: absolute;/);
    expect(css).toMatch(/\.yeaft-transcript-search\s*\{[\s\S]*?transform: translateX\(-50%\);/);
    const searchRule = css.match(/\.yeaft-transcript-search\s*\{([^}]*)\}/)?.[1] || '';
    expect(searchRule).not.toContain('flex: 0 0 auto');
  });

  it('negotiates search support and fails closed for Agents that would drop the request', () => {
    expect(agent).toContain("'session_history_search'");
    expect(relay).toContain('version: agent.version || null');
    expect(agentHandler).toContain('version: msg.version || null');
    expect(store).toContain("isAgentVersionAtLeast(agent?.version || selectedAgent?.version, '1.0.166')");
    expect(store).toContain("error: 'unsupported'");
    expect(store).toContain("error: 'timeout'");
    expect(panel).toContain("state.error === 'unsupported'");
  });

  it('supports keyboard discovery and accessible result activation', () => {
    expect(page).toContain("(e.metaKey || e.ctrlKey) && String(e.key).toLowerCase() === 'f'");
    expect(panel).toContain('role="listbox"');
    expect(panel).toContain('role="option"');
    expect(panel).toContain("event.key === 'ArrowDown'");
    expect(panel).toContain("event.key === 'Enter'");
    expect(panel).toContain("event.key === 'Escape'");
  });

  it('reveals hidden turns, scrolls the virtual transcript by key, and flashes the mapped row', () => {
    expect(store).toContain('buildYeaftMessageTurnSpans(scoped)');
    expect(list).toContain('navigateToPersistedMessage({');
    expect(list).toContain("virtualTranscriptRef.value?.scrollToKey?.(blockId, { align: 'center' })");
    expect(list).toContain("querySelectorAll?.('[data-msg-id]')");
    expect(navigation).toContain('collapseStates[target.collapseKey] = false');
    expect(virtual).toContain('expose({ scrollToKey, scrollToIndex })');
    expect(css).toContain('@keyframes yeaft-history-search-flash');
  });
});
