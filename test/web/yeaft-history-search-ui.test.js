import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const read = path => readFileSync(new URL(`../../web/${path}`, import.meta.url), 'utf8');
const page = read('components/YeaftPage.js');
const panel = read('components/YeaftConversationOutline.js');
const actions = read('components/YeaftSessionActions.js');
const list = read('components/MessageList.js');
const virtual = read('components/VirtualTranscript.js');
const navigation = read('utils/message-search-navigation.js');
const store = read('stores/chat.js');
const css = read('styles/yeaft.css');
const agent = read('../agent/index.js');
const relay = read('../server/handlers/client-conversation.js');
const agentHandler = read('stores/helpers/handlers/agentHandler.js');

const indexOf = (haystack, needle) => haystack.indexOf(needle);

describe('Yeaft conversation outline UI', () => {
  it('replaces the search button with a lazy 50-row outline while preserving server search', () => {
    expect(actions).toContain('aria-controls="yeaft-conversation-outline"');
    expect(page).toContain('<YeaftConversationOutline');
    expect(page).toContain('store.loadYeaftHistoryOutline()');
    expect(store).toContain("type: 'yeaft_load_history_outline'");
    expect(store).toContain('limit: 50');
    expect(store).toContain('if (!append && previous.loaded && !force) return true');
    expect(page).toContain('setTimeout(() => store.searchYeaftHistory(query), 220)');
    expect(store).toContain("type: 'yeaft_search_history'");
  });

  it('keeps a compound-identity page cache and merges live rows without persistent browser storage', () => {
    expect(store).toContain('yeaftHistoryIdentityKey(targetAgentId, targetSessionId)');
    expect(store).toContain('yeaftHistoryOutlineBySession');
    expect(store).toContain('const liveRows = conversationId ? (this.messagesMap[conversationId] || []) : []');
    expect(store).toContain('clientMessageId ? `client:${row.clientMessageId}`');
    expect(store).not.toContain("localStorage.setItem('yeaft-history-outline");
  });

  it('renders a fixed scrollable outline with count, search and automatic older-page loading', () => {
    expect(css).toMatch(/\.yeaft-conversation-outline\s*\{[\s\S]*?position: absolute;[\s\S]*?height: min\(/);
    expect(css).toMatch(/\.yeaft-conversation-outline-list\s*\{[\s\S]*?overflow-y: auto;/);
    expect(panel).toContain("$t('yeaft.outline.title')");
    expect(panel).toContain('outlineState.totalCount');
    expect(panel).toContain("if ((listRef.value?.scrollTop || 0) <= 40) loadOlder()");
    expect(panel).toContain('restoreOlderScroll');
    expect(panel).toContain("$t('yeaft.outline.placeholder')");
  });

  it('negotiates outline and search support and fails closed for old Agents', () => {
    expect(agent).toContain("'session_history_outline'");
    expect(agent).toContain("'session_history_search'");
    expect(relay).toContain('version: agent.version || null');
    expect(agentHandler).toContain('version: msg.version || null');
    expect(store).toContain("agentHasCapability(this, agentId, 'session_history_outline')");
    expect(store).toContain("error: 'unsupported'");
    expect(panel).toContain("error === 'unsupported'");
  });

  it('supports keyboard discovery and result activation', () => {
    expect(page).toContain("(e.metaKey || e.ctrlKey) && String(e.key).toLowerCase() === 'f'");
    expect(panel).toContain('role="listbox"');
    expect(panel).toContain('role="option"');
    expect(panel).toContain("event.key === 'ArrowDown'");
    expect(panel).toContain("event.key === 'Enter'");
    expect(panel).toContain("event.key === 'Escape'");
  });

  it('uses the existing bounded history window to reveal and flash unloaded messages', () => {
    expect(page).toContain('const loaded = await store.loadYeaftHistoryWindow(result)');
    expect(store).toContain('buildYeaftMessageTurnSpans(scoped)');
    expect(list).toContain('navigateToPersistedMessage({');
    expect(list).toContain("virtualTranscriptRef.value?.scrollToKey?.(blockId, { align: 'center' })");
    expect(navigation).toContain('collapseStates[target.collapseKey] = false');
    expect(virtual).toContain('expose({ scrollToKey, scrollToIndex })');
    expect(css).toContain('@keyframes yeaft-history-search-flash');
  });

  it('keeps search results ordered independently from outline rows', () => {
    expect(indexOf(panel, 'isSearching.value ? props.searchState.results : props.outlineState.results')).toBeGreaterThan(-1);
  });
});
