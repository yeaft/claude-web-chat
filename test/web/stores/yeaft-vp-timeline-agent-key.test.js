import { describe, expect, it } from 'vitest';

const { buildTimelineRows, resolveTimelineSession, selectGroupRosterVpList } = await import('../../../web/stores/helpers/vp-timeline.js');

describe('Yeaft VP timeline session lookup', () => {
  it('renders roster rows when sessions are keyed by agent plus session id', () => {
    const sessionId = 'session-ux';
    const agentId = 'agent-2';
    const storeKey = `${agentId}\u001f${sessionId}`;
    const sessionsStore = {
      activeSessionId: sessionId,
      sessions: {
        [storeKey]: { id: sessionId, agentId, roster: ['linus', 'martin'], defaultVpId: 'linus' },
      },
      sessionById(id, requestedAgentId = null) {
        const direct = requestedAgentId ? `${requestedAgentId}\u001f${id}` : id;
        return this.sessions[direct] || Object.values(this.sessions).find(s => s.id === id) || null;
      },
    };
    const vpStore = {
      vpList: [
        { vpId: 'linus', displayName: 'Linus', description: 'Implementation and debugging' },
        { vpId: 'martin', displayName: 'Martin', description: 'Review and architecture' },
      ],
      vpLabel(id) {
        return this.vpList.find(vp => vp.vpId === id)?.displayName || id;
      },
      vpDescription(id) {
        return this.vpList.find(vp => vp.vpId === id)?.description || '';
      },
    };
    const chatStore = {
      currentAgent: agentId,
      yeaftConversationId: 'yeaft-conv',
      yeaftActiveSessionFilter: sessionId,
      vpStatuses: {},
      stoppingVpTurnIds: {},
      connectionState: 'connected',
    };

    const filter = chatStore.yeaftActiveSessionFilter || sessionsStore.activeSessionId || null;
    expect(sessionsStore.sessions[sessionId]).toBeUndefined();

    const group = resolveTimelineSession(sessionsStore, filter, chatStore.currentAgent || null);
    const roster = (group && Array.isArray(group.roster)) ? group.roster : [];
    const vpList = selectGroupRosterVpList(roster, vpStore.vpList || []);
    const rows = buildTimelineRows({
      vpList,
      vpStatuses: {},
      stoppingVpTurnIds: chatStore.stoppingVpTurnIds || {},
      connectionState: chatStore.connectionState,
      vpLabelOf: (id) => vpStore.vpLabel(id),
      vpDescriptionOf: (id) => vpStore.vpDescription(id),
    });

    expect(rows.map(row => row.vpId)).toEqual(['linus', 'martin']);
    expect(rows.map(row => row.description)).toEqual(['Implementation and debugging', 'Review and architecture']);
  });
});
