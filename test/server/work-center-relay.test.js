import { beforeEach, describe, expect, it, vi } from 'vitest';

const forwardToAgent = vi.fn();
const forwardToClients = vi.fn();
const sendToWebClient = vi.fn();
const agents = new Map();

vi.mock('../../server/ws-utils.js', () => ({
  forwardToAgent,
  forwardToClients,
  sendToWebClient,
}));
vi.mock('../../server/context.js', () => ({ agents }));

const {
  handleClientWorkCenter,
  __testResetWorkCenterRequests,
} = await import('../../server/handlers/client-work-center.js');
const { handleAgentWorkCenter } = await import('../../server/handlers/agent-work-center.js');

describe('Work Center relay', () => {
  beforeEach(() => {
    forwardToAgent.mockReset();
    forwardToClients.mockReset();
    sendToWebClient.mockReset();
    agents.clear();
    __testResetWorkCenterRequests();
  });

  it('checks access and sends an opaque server request id to the selected Agent', async () => {
    const checkAgentAccess = vi.fn().mockResolvedValue(true);
    const client = { currentAgent: 'agent-a', userId: 'user-1' };
    const handled = await handleClientWorkCenter(
      client,
      { type: 'work_center_request', requestId: 'browser-1', op: 'list', payload: { status: 'ready' } },
      checkAgentAccess,
    );

    expect(handled).toBe(true);
    expect(checkAgentAccess).toHaveBeenCalledWith('agent-a');
    expect(forwardToAgent).toHaveBeenCalledTimes(1);
    const [agentId, request] = forwardToAgent.mock.calls[0];
    expect(agentId).toBe('agent-a');
    expect(request).toMatchObject({
      type: 'work_center_request',
      op: 'list',
      payload: { status: 'ready' },
    });
    expect(request.requestId).not.toBe('browser-1');
    expect(request).not.toHaveProperty('_requestUserId');
  });

  it('does not forward a request when access is denied', async () => {
    const handled = await handleClientWorkCenter(
      { currentAgent: null, userId: 'user-1' },
      { type: 'work_center_request', agentId: 'agent-b', op: 'list' },
      vi.fn().mockResolvedValue(false),
    );

    expect(handled).toBe(true);
    expect(forwardToAgent).not.toHaveBeenCalled();
  });

  it('delivers a response only to the client that created the opaque request', async () => {
    const client = { currentAgent: 'agent-a', userId: 'user-1' };
    await handleClientWorkCenter(
      client,
      { type: 'work_center_request', requestId: 'browser-1', agentId: 'agent-a', op: 'list' },
      vi.fn().mockResolvedValue(true),
    );
    const opaqueId = forwardToAgent.mock.calls[0][1].requestId;

    await handleAgentWorkCenter('agent-a', {
      type: 'work_center_response',
      requestId: opaqueId,
      agentId: 'spoofed',
      _requestUserId: 'victim',
      ok: true,
      data: { items: [] },
    });

    expect(sendToWebClient).toHaveBeenCalledWith(client, {
      type: 'work_center_response',
      requestId: 'browser-1',
      agentId: 'agent-a',
      ok: true,
      data: { items: [] },
    });
    expect(forwardToClients).not.toHaveBeenCalled();
  });

  it('drops a response when the opaque request belongs to another Agent', async () => {
    const client = { currentAgent: 'agent-a', userId: 'user-1' };
    await handleClientWorkCenter(
      client,
      { type: 'work_center_request', requestId: 'browser-1', agentId: 'agent-a', op: 'list' },
      vi.fn().mockResolvedValue(true),
    );
    const opaqueId = forwardToAgent.mock.calls[0][1].requestId;

    await handleAgentWorkCenter('agent-b', {
      type: 'work_center_response', requestId: opaqueId, ok: true, data: {},
    });
    expect(sendToWebClient).not.toHaveBeenCalled();
  });

  it('uses the trusted Agent owner for unsolicited projection events', async () => {
    agents.set('trusted-agent', { ownerId: 'owner-1' });
    await handleAgentWorkCenter('trusted-agent', {
      type: 'work_center_event',
      agentId: 'spoofed-agent',
      _requestUserId: 'victim',
      event: { type: 'work_item.updated' },
    });

    expect(forwardToClients).toHaveBeenCalledWith('trusted-agent', null, {
      type: 'work_center_event',
      agentId: 'trusted-agent',
      event: { type: 'work_item.updated' },
    });
    const outgoing = forwardToClients.mock.calls[0][2];
    expect(outgoing._requestUserId).toBe('owner-1');
    expect(Object.keys(outgoing)).not.toContain('_requestUserId');
  });
});
