import { afterEach, describe, expect, it } from 'vitest';

import { CONFIG } from '../../server/config.js';
import { agents } from '../../server/context.js';
import { sessionDb, yeaftProjectDb, yeaftSessionDb, sessionUiMetadataDb } from '../../server/database.js';
import {
  buildSessionCatalog,
  resolveAgentAccessError,
  verifyConversationOwnership,
} from '../../server/ws-utils.js';
import { handleAgentOutput } from '../../server/handlers/agent-output.js';
import { handleClientConversation } from '../../server/handlers/client-conversation.js';
import { routeSessionPin } from '../../server/handlers/session-pin-router.js';

describe('resolveAgentAccessError', () => {
  const originalSkipAuth = CONFIG.skipAuth;

  afterEach(() => {
    CONFIG.skipAuth = originalSkipAuth;
    agents.clear();
  });

  it('classifies Agent access states and rejects foreign Project mutations', async () => {
    CONFIG.skipAuth = false;
    expect(resolveAgentAccessError('agent-missing', 'user-1', 'user')).toBe('Agent not found or offline');

    agents.set('agent-1', { ownerId: 'user-1', ws: { readyState: 1 } });
    expect(resolveAgentAccessError('agent-1', 'user-2', 'user')).toBe('Agent access denied');
    expect(resolveAgentAccessError('agent-1', 'user-1', 'user')).toBeNull();
    agents.get('agent-1').ws.readyState = 3;
    expect(resolveAgentAccessError('agent-1', 'user-1', 'user')).toBe('Agent not found or offline');

    const forwarded = [];
    agents.set('agent-foreign', {
      ownerId: 'user-2',
      ws: { readyState: 1, send: payload => forwarded.push(JSON.parse(payload)) },
    });
    const client = {
      userId: 'user-1', role: 'user', currentAgent: null, authenticated: true,
      ws: { readyState: 1, send() {}, close() {} },
    };
    const accessChecks = [];
    const handled = await handleClientConversation('project-access-client', client, {
      type: 'yeaft_project_mutation',
      agentId: 'agent-foreign',
      requestId: 'project-denied',
      op: 'delete',
      projectId: 'project-1',
    }, async agentId => {
      accessChecks.push(agentId);
      return false;
    });
    expect(handled).toBe(true);
    expect(accessChecks).toEqual([]);
    expect(forwarded).toEqual([]);
  });

  it('filters NULL-owner Chat rows by Agent ACL', async () => {
    CONFIG.skipAuth = false;
    agents.set('agent-owned', { ownerId: 'user-1', ws: { readyState: 1 } });
    agents.set('agent-foreign', { ownerId: 'user-2', ws: { readyState: 1 } });
    agents.set('agent-global', { ownerId: null, ws: { readyState: 1 } });
    const getActive = sessionDb.getActiveByUser;
    const getByUser = sessionDb.getByUser;
    sessionDb.getByUser = () => [];
    sessionDb.getActiveByUser = () => [
      { id: 'legacy-owned', user_id: null, agent_id: 'agent-owned', is_active: 1 },
      { id: 'legacy-foreign', user_id: null, agent_id: 'agent-foreign', is_active: 1 },
      { id: 'legacy-global', user_id: null, agent_id: 'agent-global', is_active: 1 },
      { id: 'legacy-offline', user_id: null, agent_id: 'agent-offline', is_active: 1 },
    ];
    try {
      sessionDb.getByUser = () => [{ user_id: 'user-1', agent_id: 'agent-offline' }];
      expect(buildSessionCatalog('user-1', 'user').map(row => row.catalogKey)).toEqual([
        'chat:legacy-offline', 'chat:legacy-owned',
      ]);
      expect(buildSessionCatalog('user-1', 'admin').map(row => row.catalogKey)).toEqual([
        'chat:legacy-global', 'chat:legacy-offline', 'chat:legacy-owned',
      ]);

      agents.clear();
      const getSession = sessionDb.get;
      const hasOwnedRoute = sessionDb.hasOwnedRoute;
      sessionDb.get = () => ({ id: 'legacy-chat', user_id: null, agent_id: 'agent-offline' });
      sessionDb.hasOwnedRoute = (userId, agentId) => userId === 'user-1' && agentId === 'agent-offline';
      try {
        expect(verifyConversationOwnership('legacy-chat', 'user-1', 'user')).toBe(true);
        expect(verifyConversationOwnership('legacy-chat', 'user-2', 'user')).toBe(false);

        const foreignClient = {
          userId: 'user-2', role: 'user', currentAgent: null, authenticated: true,
          ws: { readyState: 1, send() {}, close() {} },
        };
        const setActive = sessionDb.setActive;
        sessionDb.setActive = (...args) => { throw new Error(`unexpected mutation ${args.join(':')}`); };
        try {
          await handleClientConversation('foreign-client', foreignClient, {
            type: 'delete_conversation',
            conversationId: 'legacy-chat',
            agentId: 'agent-offline',
            requestId: 'foreign-delete',
          }, async () => true);
        } finally {
          sessionDb.setActive = setActive;
        }
      } finally {
        sessionDb.get = getSession;
        sessionDb.hasOwnedRoute = hasOwnedRoute;
      }
    } finally {
      sessionDb.getActiveByUser = getActive;
      sessionDb.getByUser = getByUser;
    }
  });

  it('atomically writes canonical metadata and authoritative Session snapshots', async () => {
    const suffix = `${Date.now()}-${Math.random()}`;
    const userId = `catalog-user-${suffix}`;
    const username = `catalog-${suffix}`;
    const now = Date.now();
    // The production DB module is isolated by the Vitest worker. Use public
    // APIs so this test exercises the same transaction as the handler.
    const { default: sql } = await import('../../server/db/connection.js');
    sql.prepare('INSERT INTO users (id, username, created_at) VALUES (?, ?, ?)').run(userId, username, now);
    const chatId = `chat-${suffix}`;
    sessionDb.create(chatId, 'agent-a', 'A', '/tmp', null, 'Chat', userId, 'copilot');
    sessionUiMetadataDb.applyBatch(userId, [{
      catalogKey: `chat:${chatId}`,
      runtimeProvider: 'copilot', agentId: 'agent-a', sessionId: chatId,
      pinned: true, sortRank: 1,
    }]);
    expect(sessionDb.get(chatId).is_pinned).toBe(1);
    yeaftSessionDb.upsertFromSnapshot(userId, 'agent-a', { id: `same-${suffix}`, name: 'A' });
    yeaftSessionDb.upsertFromSnapshot(userId, 'agent-b', { id: `same-${suffix}`, name: 'B' });
    sessionUiMetadataDb.applyBatch(userId, [{
      catalogKey: `yeaft:agent-a:same-${suffix}`,
      runtimeProvider: 'yeaft', agentId: 'agent-a', sessionId: `same-${suffix}`,
      pinned: true, sortRank: 0,
    }]);
    expect(yeaftSessionDb.getForAgent(userId, 'agent-a', `same-${suffix}`).pinned).toBe(true);
    expect(yeaftSessionDb.getForAgent(userId, 'agent-b', `same-${suffix}`).pinned).toBe(false);
    expect(sessionUiMetadataDb.get(userId, `yeaft:agent-a:same-${suffix}`)).toMatchObject({
      pinned: true, sortRank: 0,
    });

    const project = yeaftProjectDb.create(userId, `Project ${suffix}`);
    const secondProject = yeaftProjectDb.create(userId, `Project second ${suffix}`);
    expect(yeaftProjectDb.reorder(userId, [secondProject.id, project.id]).map(row => row.id))
      .toEqual([secondProject.id, project.id]);
    expect(() => yeaftProjectDb.reorder(userId, [project.id]))
      .toThrow('Complete Project order is required');
    expect(() => yeaftProjectDb.reorder(userId, [project.id, project.id]))
      .toThrow('Complete Project order is required');
    expect(yeaftProjectDb.reorder(userId, [project.id, secondProject.id]).map(row => row.id))
      .toEqual([project.id, secondProject.id]);
    yeaftProjectDb.delete(userId, secondProject.id);
    yeaftProjectDb.moveSession(userId, {
      agentId: 'agent-a', sessionId: `same-${suffix}`, projectId: project.id,
    });
    yeaftProjectDb.moveSession(userId, {
      agentId: 'agent-a', sessionId: `sibling-${suffix}`, projectId: project.id,
    });
    yeaftProjectDb.moveSession(userId, {
      agentId: 'agent-b', sessionId: `foreign-agent-${suffix}`, projectId: project.id,
    });
    yeaftProjectDb.updateInstruction(userId, project.id, '  Follow the Project release checklist.  ');
    expect(() => yeaftProjectDb.updateInstruction(userId, project.id, 'x'.repeat(20_001)))
      .toThrow('must not exceed 20000 characters');
    expect(yeaftProjectDb.list(userId)).toEqual([
      expect.objectContaining({
        id: project.id,
        instruction: 'Follow the Project release checklist.',
        members: [
          { agentId: 'agent-a', sessionId: `same-${suffix}` },
          { agentId: 'agent-a', sessionId: `sibling-${suffix}` },
          { agentId: 'agent-b', sessionId: `foreign-agent-${suffix}` },
        ],
      }),
    ]);
    expect(yeaftProjectDb.contextForSession(userId, 'agent-a', `same-${suffix}`)).toEqual({
      projectId: project.id,
      projectName: `Project ${suffix}`,
      projectInstruction: 'Follow the Project release checklist.',
      sessionIds: [`sibling-${suffix}`],
    });
    expect(yeaftProjectDb.contextForSession(userId, 'agent-b', `foreign-agent-${suffix}`)).toEqual({
      projectId: project.id,
      projectName: `Project ${suffix}`,
      projectInstruction: 'Follow the Project release checklist.',
      sessionIds: [],
    });
    expect(yeaftProjectDb.listForAgent(userId, 'agent-a')).toEqual([
      expect.objectContaining({
        id: project.id,
        sessionIds: [`same-${suffix}`, `sibling-${suffix}`],
        members: expect.arrayContaining([
          { agentId: 'agent-b', sessionId: `foreign-agent-${suffix}` },
        ]),
      }),
    ]);

    expect(() => yeaftProjectDb.moveSession(userId, {
      agentId: 'agent-a',
      sessionId: `same-${suffix}`,
      projectId: null,
      catalogUpdates: [
        {
          catalogKey: `chat:${chatId}`,
          runtimeProvider: 'copilot',
          agentId: 'agent-a',
          sessionId: chatId,
          pinned: false,
          sortRank: 7,
        },
        {
          catalogKey: `yeaft:agent-a:missing-${suffix}`,
          runtimeProvider: 'yeaft',
          agentId: 'agent-a',
          sessionId: `missing-${suffix}`,
          pinned: false,
          sortRank: 8,
        },
      ],
    })).toThrow('Yeaft Session identity changed during metadata update');
    expect(yeaftProjectDb.contextForSession(userId, 'agent-a', `same-${suffix}`)).toMatchObject({
      projectId: project.id,
    });
    expect(sessionUiMetadataDb.get(userId, `chat:${chatId}`)).toMatchObject({
      pinned: true,
      sortRank: 1,
    });
    expect(sessionDb.get(chatId).is_pinned).toBe(1);

    const originalReconcileProjectSessions = yeaftProjectDb.reconcileAgentSessions;
    yeaftProjectDb.reconcileAgentSessions = () => { throw new Error('forced project reconciliation failure'); };
    try {
      await handleAgentOutput('agent-a', {
        ownerId: userId,
        ws: { readyState: 1 },
        conversations: new Map(),
      }, {
        type: 'session_crud_result',
        op: 'list',
        ok: true,
        sessions: [{ id: `replacement-${suffix}`, name: 'Replacement' }],
      });
      expect(yeaftSessionDb.getForAgent(userId, 'agent-a', `same-${suffix}`)).not.toBeNull();
      expect(yeaftSessionDb.getForAgent(userId, 'agent-a', `replacement-${suffix}`)).toBeUndefined();
      expect(yeaftProjectDb.contextForSession(userId, 'agent-a', `same-${suffix}`)).toMatchObject({
        projectId: project.id,
      });
    } finally {
      yeaftProjectDb.reconcileAgentSessions = originalReconcileProjectSessions;
    }

    await handleAgentOutput('agent-a', {
      ownerId: userId,
      ws: { readyState: 1 },
      conversations: new Map(),
    }, {
      type: 'session_crud_result',
      op: 'list',
      ok: true,
      sessions: [],
    });
    expect(yeaftSessionDb.getByAgent('agent-a').filter(row => row.userId === userId)).toEqual([]);
    expect(yeaftProjectDb.list(userId)[0].members).toEqual([
      { agentId: 'agent-b', sessionId: `foreign-agent-${suffix}` },
    ]);
  });

  it('fails closed when legacy Yeaft pin identity is ambiguous', () => {
    const result = routeSessionPin({
      getYeaftRows: () => [
        { userId: 'user-1', agentId: 'agent-a' },
        { userId: 'user-1', agentId: 'agent-b' },
      ],
      verifyChatOwnership: () => true,
      skipAuth: false,
    }, { userId: 'user-1' }, { type: 'pin_session', conversationId: 'same-id' });
    expect(result).toMatchObject({ kind: 'denied', reason: 'yeaft-ambiguous' });
  });
});
