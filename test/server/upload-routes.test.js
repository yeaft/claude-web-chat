import { WebSocket } from 'ws';
import { describe, expect, it, vi } from 'vitest';
import { agents, pendingFiles, previewFiles } from '../../server/context.js';
import { fallbackUploadName, registerUploadRoutes } from '../../server/routes/upload-routes.js';
import {
  __testResetWorkCenterRequests,
  handleClientWorkCenter,
  workCenterOpAcceptsAttachments,
} from '../../server/handlers/client-work-center.js';

describe('upload routes', () => {
  it('keeps existing multipart filenames', async () => {
    expect(fallbackUploadName({ originalname: 'screen.png', mimetype: 'image/png' }, 0)).toBe('screen.png');
    expect(['create', 'work_item_message', 'action_input', 'guide']
      .every(operation => workCenterOpAcceptsAttachments(operation))).toBe(true);
    expect(workCenterOpAcceptsAttachments('get')).toBe(false);

    const agentFrames = [];
    const clientFrames = [];
    const agentId = 'attachment-retry-agent';
    const clientMessageId = 'durable-client-message';
    agents.set(agentId, {
      capabilities: ['work_center', 'work_item_attachments'],
      encryptOutbound: false,
      ws: { readyState: WebSocket.OPEN, send: value => agentFrames.push(JSON.parse(value)) },
    });
    const client = {
      userId: 'user-a',
      encryptOutbound: false,
      ws: { readyState: WebSocket.OPEN, send: value => clientFrames.push(JSON.parse(value)) },
    };
    const staged = fileId => ({
      fileId, name: 'note.txt', mimeType: 'text/plain', size: 4,
    });
    const request = fileId => ({
      type: 'work_center_request', requestId: `browser-${fileId}`, agentId,
      op: 'post_work_item_message',
      payload: {
        id: 'work-item-a', clientMessageId, text: 'same durable request', revision: 1,
        target: { kind: 'coordinator' },
        quote: { id: 'assistant-1', role: 'assistant', author: 'Omni', content: 'Original answer' },
        attachments: [staged(fileId)],
      },
    });
    try {
      pendingFiles.set('file-old', {
        name: 'note.txt', mimeType: 'text/plain', buffer: Buffer.from('old!'),
        uploadedAt: Date.now(), userId: 'user-a',
      });
      await handleClientWorkCenter(client, request('file-old'), async () => true);
      expect(agentFrames).toHaveLength(1);
      expect(agentFrames[0].payload).toMatchObject({
        clientMessageId,
        quote: { id: 'assistant-1', role: 'assistant', author: 'Omni', content: 'Original answer' },
        files: [{ name: 'note.txt', mimeType: 'text/plain', data: Buffer.from('old!').toString('base64') }],
      });

      pendingFiles.delete('file-old');
      await handleClientWorkCenter(client, request('file-old'), async () => true);
      expect(agentFrames).toHaveLength(1);
      expect(clientFrames.at(-1)).toMatchObject({
        requestId: 'browser-file-old', ok: false,
        error: 'WorkItem attachment expired; upload it again',
      });

      pendingFiles.set('file-new', {
        name: 'note.txt', mimeType: 'text/plain', buffer: Buffer.from('new!'),
        uploadedAt: Date.now(), userId: 'user-a',
      });
      await handleClientWorkCenter(client, request('file-new'), async () => true);
      expect(agentFrames).toHaveLength(2);
      expect(agentFrames[1].payload).toMatchObject({
        clientMessageId,
        quote: { id: 'assistant-1', role: 'assistant', author: 'Omni', content: 'Original answer' },
        files: [{ name: 'note.txt', mimeType: 'text/plain', data: Buffer.from('new!').toString('base64') }],
      });
    } finally {
      __testResetWorkCenterRequests();
      pendingFiles.delete('file-old');
      pendingFiles.delete('file-new');
      agents.delete(agentId);
    }
  });

  it('generates usable names for pasted clipboard images with empty multipart filenames', () => {
    const name = fallbackUploadName({ originalname: '', mimetype: 'image/png' }, 1);
    expect(name).toMatch(/^pasted-image-\d+-2\.png$/);
  });

  it('serves token previews with MIME sniffing disabled', () => {
    const routes = new Map();
    const app = {
      post: vi.fn(),
      get: vi.fn((path, handler) => routes.set(path, handler)),
    };
    registerUploadRoutes(app, { requireAuth: vi.fn() });
    previewFiles.set('preview-1', {
      buffer: Buffer.from('<script>alert(1)</script>'),
      mimeType: 'text/plain; charset=utf-8',
      filename: 'page.html',
      token: 'secret',
      createdAt: Date.now(),
    });
    const headers = {};
    const res = {
      setHeader: vi.fn((name, value) => { headers[name] = value; }),
      send: vi.fn(),
      status: vi.fn(() => res),
    };

    routes.get('/api/preview/:fileId')({ params: { fileId: 'preview-1' }, query: { token: 'secret' } }, res);

    expect(headers).toMatchObject({
      'Content-Type': 'text/plain; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store',
    });
    expect(headers['Content-Disposition']).toBe('inline; filename="page.html"');
    expect(res.send).toHaveBeenCalledWith(Buffer.from('<script>alert(1)</script>'));

    routes.get('/api/preview/:fileId')({
      params: { fileId: 'preview-1' },
      query: { token: 'secret', download: '1' },
    }, res);
    expect(headers['Content-Disposition']).toBe('attachment; filename="page.html"');
    previewFiles.delete('preview-1');
  });

  it('registers the stable Yeaft asset route without bearer middleware', () => {
    const routes = new Map();
    const app = {
      post: vi.fn(),
      get: vi.fn((path, handler) => routes.set(path, handler)),
    };
    registerUploadRoutes(app, { requireAuth: vi.fn() });
    expect(routes.has('/api/yeaft/assets/:scopeId/:assetId')).toBe(true);
    expect(app.get).toHaveBeenCalledWith('/api/yeaft/assets/:scopeId/:assetId', expect.any(Function));
  });
});
