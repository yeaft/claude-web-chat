import { describe, expect, it, vi } from 'vitest';
import { previewFiles } from '../../server/context.js';
import { fallbackUploadName, registerUploadRoutes } from '../../server/routes/upload-routes.js';
import { workCenterOpAcceptsAttachments } from '../../server/handlers/client-work-center.js';

describe('upload routes', () => {
  it('keeps existing multipart filenames', () => {
    expect(fallbackUploadName({ originalname: 'screen.png', mimetype: 'image/png' }, 0)).toBe('screen.png');
    expect(['create', 'work_item_message', 'action_input', 'guide']
      .every(operation => workCenterOpAcceptsAttachments(operation))).toBe(true);
    expect(workCenterOpAcceptsAttachments('get')).toBe(false);
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
    expect(res.send).toHaveBeenCalledWith(Buffer.from('<script>alert(1)</script>'));
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
