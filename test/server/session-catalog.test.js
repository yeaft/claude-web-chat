import { describe, expect, it } from 'vitest';
import {
  projectSessionCatalog,
  yeaftCatalogKey,
} from '../../server/session-catalog.js';

describe('Server Session catalog projection', () => {
  it('merges canonical rows without collapsing duplicate Yeaft session ids', () => {
    const catalog = projectSessionCatalog({
      chatSessions: [{
        id: 'same-id',
        provider: null,
        agent_id: 'chat-agent',
        agent_name: 'Desktop',
        work_dir: '/chat',
        title: 'Chat',
        updated_at: 10,
      }],
      yeaftSessions: [
        { id: 'same-id', agentId: 'agent-a', agentName: 'A', name: 'Yeaft A', updatedAt: 20 },
        { id: 'same-id', agentId: 'agent-b', agentName: 'B', name: 'Yeaft B', updatedAt: 30 },
      ],
      metadata: [{ catalogKey: yeaftCatalogKey('agent-a', 'same-id'), pinned: true, sortRank: 1 }],
    });

    expect(catalog.map(row => row.catalogKey)).toEqual([
      'yeaft:agent-a:same-id',
      'yeaft:agent-b:same-id',
      'chat:same-id',
    ]);
    expect(catalog[0].pinned).toBe(true);
    expect(catalog[2].runtimeProvider).toBe('claude-code');
  });

  it('fails closed for an unknown non-empty Chat provider', () => {
    expect(() => projectSessionCatalog({
      chatSessions: [{ id: 'c1', provider: 'mystery', agent_id: 'a1' }],
    })).toThrow(/Unknown Chat runtime provider/);
  });
});
