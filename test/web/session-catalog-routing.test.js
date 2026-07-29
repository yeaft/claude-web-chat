import { describe, expect, it, vi } from 'vitest';

function openCatalogSession(descriptor) {
  if (!descriptor?.catalogKey || !descriptor.routeRef) return false;
  const { runtimeProvider, agentId, sessionId } = descriptor.routeRef;
  this.activeCatalogKey = descriptor.catalogKey;
  if (runtimeProvider === 'yeaft') {
    this.enterYeaft(agentId);
    this.setActiveSessionFilter(sessionId, { agentId, force: true });
    return true;
  }
  if (runtimeProvider !== 'claude-code' && runtimeProvider !== 'copilot') return false;
  if (this.currentView === 'yeaft') this.leaveYeaft();
  this.selectConversation(sessionId, agentId);
  return true;
}

describe('Session catalog routing', () => {
  it('routes Yeaft by agent and session composite identity', () => {
    const store = {
      activeCatalogKey: null,
      yeaftActiveSessionFilter: null,
      enterYeaft: vi.fn(),
      setActiveSessionFilter: vi.fn(),
    };
    expect(openCatalogSession.call(store, {
      catalogKey: 'yeaft:agent-b:same-id',
      routeRef: { runtimeProvider: 'yeaft', agentId: 'agent-b', sessionId: 'same-id' },
    })).toBe(true);
    expect(store.enterYeaft).toHaveBeenCalledWith('agent-b');
    expect(store.setActiveSessionFilter).toHaveBeenCalledWith('same-id', {
      agentId: 'agent-b',
      force: true,
    });
  });

  it('routes Chat providers through the existing conversation path', () => {
    const store = {
      activeCatalogKey: null,
      currentView: 'yeaft',
      leaveYeaft: vi.fn(),
      selectConversation: vi.fn(),
    };
    expect(openCatalogSession.call(store, {
      catalogKey: 'chat:c1',
      routeRef: { runtimeProvider: 'copilot', agentId: 'agent-a', sessionId: 'c1' },
    })).toBe(true);
    expect(store.leaveYeaft).toHaveBeenCalledOnce();
    expect(store.selectConversation).toHaveBeenCalledWith('c1', 'agent-a');
  });

  it('fails closed for unknown runtime providers', () => {
    const store = { activeCatalogKey: null };
    expect(openCatalogSession.call(store, {
      catalogKey: 'other:x',
      routeRef: { runtimeProvider: 'other', agentId: 'a', sessionId: 'x' },
    })).toBe(false);
  });
});
