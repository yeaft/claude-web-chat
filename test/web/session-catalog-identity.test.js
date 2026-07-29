import { describe, expect, it } from 'vitest';
import {
  catalogKeyForRoute,
  chatCatalogKey,
  chatRouteRef,
  normalizeChatRuntimeProvider,
  yeaftCatalogKey,
  yeaftRouteRef,
} from '../../web/stores/helpers/session-catalog.js';

describe('Session catalog identity', () => {
  it('keeps Chat identity stable when agent ownership changes', () => {
    const first = chatRouteRef({ id: 'conversation-1', agentId: 'agent-a', provider: 'copilot' });
    const moved = chatRouteRef({ id: 'conversation-1', agentId: 'agent-b', provider: 'copilot' });

    expect(catalogKeyForRoute(first)).toBe('chat:conversation-1');
    expect(catalogKeyForRoute(moved)).toBe('chat:conversation-1');
    expect(first.agentId).not.toBe(moved.agentId);
  });

  it('scopes Yeaft identity by agent', () => {
    expect(yeaftCatalogKey('agent-a', 'session-default')).toBe('yeaft:agent-a:session-default');
    expect(yeaftCatalogKey('agent-b', 'session-default')).toBe('yeaft:agent-b:session-default');
    expect(catalogKeyForRoute(yeaftRouteRef({ id: 'session-default', agentId: 'agent-a' })))
      .toBe('yeaft:agent-a:session-default');
  });

  it('treats only a missing Chat provider as the legacy Claude Code default', () => {
    expect(normalizeChatRuntimeProvider(null)).toBe('claude-code');
    expect(normalizeChatRuntimeProvider('copilot')).toBe('copilot');
    expect(() => normalizeChatRuntimeProvider('unknown-provider')).toThrow(/Unknown Chat runtime provider/);
  });

  it('rejects incomplete identities', () => {
    expect(() => chatCatalogKey('')).toThrow(/conversationId/);
    expect(() => yeaftCatalogKey('', 'session-1')).toThrow(/agentId and sessionId/);
  });
});
