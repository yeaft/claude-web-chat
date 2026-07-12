import { beforeEach, describe, expect, it, vi } from 'vitest';

const forwardToAgent = vi.fn();
const forwardAgentEvent = vi.fn();
const forwardToClients = vi.fn();
const sendToWebClient = vi.fn();
const agents = new Map();
const pendingFiles = new Map();

vi.mock('../../server/ws-utils.js', () => ({
  forwardAgentEvent,
  forwardToAgent,
  forwardToClients,
  sendToWebClient,
}));
vi.mock('../../server/context.js', () => ({ agents, pendingFiles }));
vi.mock('../../server/config.js', () => ({ CONFIG: { skipAuth: false, maxFileSize: 50 * 1024 * 1024 } }));

const {
  handleClientWorkCenter,
  deliverWorkCenterResponse,
  __testResetWorkCenterRequests,
} = await import('../../server/handlers/client-work-center.js');
const { handleAgentWorkCenter } = await import('../../server/handlers/agent-work-center.js');

describe('Work Center relay', () => {
  beforeEach(() => {
    forwardAgentEvent.mockReset();
    forwardToAgent.mockReset();
    forwardToClients.mockReset();
    sendToWebClient.mockReset();
    agents.clear();
    agents.set('agent-a', { capabilities: ['work_item_attachments'] });
    pendingFiles.clear();
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

  it.each([
    ['without capability', []],
    ['with capability', ['work_item_attachments']],
  ])('rejects browser-supplied files %s', async (_label, capabilities) => {
    agents.set('agent-a', { capabilities });
    const client = { currentAgent: 'agent-a', userId: 'user-1' };

    await handleClientWorkCenter(client, {
      type: 'work_center_request', requestId: 'browser-direct-files', op: 'create',
      payload: {
        title: 'Bypass upload ownership',
        files: [{ name: 'notes.txt', mimeType: 'text/plain', data: 'YnlwYXNz' }],
      },
    }, vi.fn().mockResolvedValue(true));

    expect(forwardToAgent).not.toHaveBeenCalled();
    expect(sendToWebClient).toHaveBeenCalledWith(client, expect.objectContaining({
      requestId: 'browser-direct-files',
      ok: false,
      error: expect.stringMatching(/server-generated/),
    }));
  });

  it('rejects oversized browser-supplied base64 without forwarding it', async () => {
    const client = { currentAgent: 'agent-a', userId: 'user-1' };
    const data = 'A'.repeat(12 * 1024 * 1024);

    await handleClientWorkCenter(client, {
      type: 'work_center_request', requestId: 'browser-direct-oversized', op: 'create',
      payload: { files: [{ name: 'large.txt', mimeType: 'text/plain', data }] },
    }, vi.fn().mockResolvedValue(true));

    expect(forwardToAgent).not.toHaveBeenCalled();
    expect(sendToWebClient).toHaveBeenCalledWith(client, expect.objectContaining({
      requestId: 'browser-direct-oversized', ok: false, error: expect.stringMatching(/server-generated/),
    }));
  });

  it('rejects attachments for an Agent without capability before reading or forwarding pending bytes', async () => {
    agents.set('agent-a', { capabilities: [] });
    let bufferRead = false;
    pendingFiles.set('file-unsupported', {
      name: 'evidence.txt', mimeType: 'text/plain', userId: 'user-1',
      get buffer() { bufferRead = true; return Buffer.from('evidence'); },
    });
    const client = { currentAgent: 'agent-a', userId: 'user-1' };

    await handleClientWorkCenter(client, {
      type: 'work_center_request', requestId: 'browser-create', op: 'create',
      payload: { attachments: [{ fileId: 'file-unsupported' }] },
    }, vi.fn().mockResolvedValue(true));

    expect(bufferRead).toBe(false);
    expect(forwardToAgent).not.toHaveBeenCalled();
    expect(pendingFiles.has('file-unsupported')).toBe(true);
    expect(sendToWebClient).toHaveBeenCalledWith(client, expect.objectContaining({
      requestId: 'browser-create', ok: false, error: expect.stringMatching(/does not support/),
    }));
  });

  it('resolves owned create attachments and consumes them only after Agent success', async () => {
    pendingFiles.set('file-1', {
      name: 'screen.png', mimeType: 'image/png', buffer: Buffer.from('image'), userId: 'user-1',
    });
    const client = { currentAgent: 'agent-a', userId: 'user-1' };
    await handleClientWorkCenter(client, {
      type: 'work_center_request', requestId: 'browser-create', op: 'create',
      payload: { title: 'Inspect screenshot', attachments: [{ fileId: 'file-1', name: 'forged.png' }] },
    }, vi.fn().mockResolvedValue(true));

    const request = forwardToAgent.mock.calls[0][1];
    expect(request.payload).toMatchObject({
      title: 'Inspect screenshot',
      files: [{ name: 'screen.png', mimeType: 'image/png', data: Buffer.from('image').toString('base64'), isImage: true }],
    });
    expect(pendingFiles.has('file-1')).toBe(true);

    await deliverWorkCenterResponse('agent-a', {
      type: 'work_center_response', requestId: request.requestId, op: 'create', ok: true, data: { id: 'wi-1' },
    });
    expect(pendingFiles.has('file-1')).toBe(false);
  });

  it('forwards attachments whose aggregate size equals the WorkItem limit', async () => {
    const fileLimit = 10 * 1024 * 1024;
    for (let index = 0; index < 5; index += 1) {
      pendingFiles.set(`boundary-${index}`, {
        name: `boundary-${index}.txt`, mimeType: 'text/plain', buffer: Buffer.alloc(fileLimit), userId: 'user-1',
      });
    }
    const client = { currentAgent: 'agent-a', userId: 'user-1' };
    await handleClientWorkCenter(client, {
      type: 'work_center_request', requestId: 'browser-create', op: 'create',
      payload: { attachments: Array.from({ length: 5 }, (_value, index) => ({ fileId: `boundary-${index}` })) },
    }, vi.fn().mockResolvedValue(true));

    expect(forwardToAgent).toHaveBeenCalledTimes(1);
    expect(forwardToAgent.mock.calls[0][1].payload.files).toHaveLength(5);
  });

  it('rejects aggregate attachment bytes before base64 encoding or Agent forwarding', async () => {
    const fileLimit = 10 * 1024 * 1024;
    for (let index = 0; index < 6; index += 1) {
      pendingFiles.set(`large-${index}`, {
        name: `large-${index}.txt`, mimeType: 'text/plain', buffer: Buffer.alloc(fileLimit), userId: 'user-1',
      });
    }
    const client = { currentAgent: 'agent-a', userId: 'user-1' };
    await handleClientWorkCenter(client, {
      type: 'work_center_request', requestId: 'browser-create', op: 'create',
      payload: { attachments: Array.from({ length: 6 }, (_value, index) => ({ fileId: `large-${index}` })) },
    }, vi.fn().mockResolvedValue(true));

    expect(forwardToAgent).not.toHaveBeenCalled();
    expect(sendToWebClient).toHaveBeenCalledWith(client, expect.objectContaining({
      ok: false, error: expect.stringMatching(/exceed/),
    }));
    expect([...pendingFiles.keys()]).toEqual(['large-0', 'large-1', 'large-2', 'large-3', 'large-4', 'large-5']);
  });

  it('rejects oversized inline PDFs before Agent forwarding', async () => {
    pendingFiles.set('large-pdf', {
      name: 'requirements.pdf', mimeType: 'application/pdf',
      buffer: Buffer.alloc(10 * 1024 * 1024 + 1), userId: 'user-1',
    });
    const client = { currentAgent: 'agent-a', userId: 'user-1' };
    await handleClientWorkCenter(client, {
      type: 'work_center_request', requestId: 'browser-create', op: 'create',
      payload: { attachments: [{ fileId: 'large-pdf' }] },
    }, vi.fn().mockResolvedValue(true));

    expect(forwardToAgent).not.toHaveBeenCalled();
    expect(sendToWebClient).toHaveBeenCalledWith(client, expect.objectContaining({
      ok: false, error: expect.stringMatching(/attachment exceeds 10485760 bytes/),
    }));
  });

  it('rejects unsupported attachment types before Agent forwarding', async () => {
    pendingFiles.set('office-1', {
      name: 'requirements.docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      buffer: Buffer.from('office'), userId: 'user-1',
    });
    const client = { currentAgent: 'agent-a', userId: 'user-1' };
    await handleClientWorkCenter(client, {
      type: 'work_center_request', requestId: 'browser-create', op: 'create',
      payload: { attachments: [{ fileId: 'office-1' }] },
    }, vi.fn().mockResolvedValue(true));

    expect(forwardToAgent).not.toHaveBeenCalled();
    expect(sendToWebClient).toHaveBeenCalledWith(client, expect.objectContaining({
      ok: false, error: expect.stringMatching(/Unsupported WorkItem attachment type/),
    }));
  });

  it('rejects foreign create attachments without forwarding or consuming them', async () => {
    pendingFiles.set('file-foreign', {
      name: 'secret.txt', mimeType: 'text/plain', buffer: Buffer.from('secret'), userId: 'user-2',
    });
    const client = { currentAgent: 'agent-a', userId: 'user-1' };
    await handleClientWorkCenter(client, {
      type: 'work_center_request', requestId: 'browser-create', op: 'create',
      payload: { attachments: [{ fileId: 'file-foreign' }] },
    }, vi.fn().mockResolvedValue(true));

    expect(forwardToAgent).not.toHaveBeenCalled();
    expect(pendingFiles.has('file-foreign')).toBe(true);
    expect(sendToWebClient).toHaveBeenCalledWith(client, expect.objectContaining({
      requestId: 'browser-create', ok: false, error: expect.stringMatching(/access denied/),
    }));
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

  it('uses Agent access authorization for redacted unsolicited projection events', async () => {
    agents.set('trusted-agent', { ownerId: null });
    await handleAgentWorkCenter('trusted-agent', {
      type: 'work_center_event',
      agentId: 'spoofed-agent',
      _requestUserId: 'victim',
      event: {
        type: 'work_item.updated',
        workItem: { id: 'wi-1', title: 'Safe summary', status: 'running' },
      },
    });

    expect(forwardAgentEvent).toHaveBeenCalledWith('trusted-agent', {
      type: 'work_center_event',
      agentId: 'trusted-agent',
      event: {
        type: 'work_item.updated',
        workItem: { id: 'wi-1', title: 'Safe summary', status: 'running' },
      },
    });
    expect(forwardToClients).not.toHaveBeenCalled();
  });
});
