import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import imageGenerationTool from '../../../agent/yeaft/tools/image-generation.js';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

function remoteDownloadResponse(body, contentType) {
  return {
    lookup: vi.fn(async () => [{ address: '93.184.216.34', family: 4 }]),
    requestImpl: (_url, _options, callback) => {
      const request = new PassThrough();
      request.end = () => {
        const response = new PassThrough();
        response.statusCode = 200;
        response.headers = { 'content-type': contentType };
        callback(response);
        response.end(body);
      };
      return request;
    },
  };
}

describe('ImageGeneration display output', () => {
  it('downloads the generated image and returns an embeddable supported image payload', async () => {
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ url: 'https://images.example/result.png' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));

    const result = JSON.parse(await imageGenerationTool.execute(
      { prompt: 'a small pixel', size: '256x256' },
      { config: { imageApiUrl: 'https://generator.example/images' }, remoteImageDownload: remoteDownloadResponse(PNG, 'image/png') },
    ));

    expect(result).toMatchObject({ success: true, mimeType: 'image/png', size: '256x256' });
    expect(result.image).toBe(`data:image/png;base64,${PNG.toString('base64')}`);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it('rejects unsupported generated content instead of exposing it as an image', async () => {
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ url: 'https://images.example/result.svg' }), { status: 200 }));

    const result = JSON.parse(await imageGenerationTool.execute(
      { prompt: 'unsafe svg' },
      { config: { imageApiUrl: 'https://generator.example/images' }, remoteImageDownload: remoteDownloadResponse('<svg/>', 'image/svg+xml') },
    ));
    expect(result.error).toMatch(/Unsupported generated image type/);
  });
});
