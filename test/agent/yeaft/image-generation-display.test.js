import { afterEach, describe, expect, it, vi } from 'vitest';
import imageGenerationTool from '../../../agent/yeaft/tools/image-generation.js';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe('ImageGeneration display output', () => {
  it('downloads the generated image and returns an embeddable supported image payload', async () => {
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ url: 'https://images.example/result.png' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(PNG, {
        status: 200,
        headers: { 'content-type': 'image/png' },
      }));

    const result = JSON.parse(await imageGenerationTool.execute(
      { prompt: 'a small pixel', size: '256x256' },
      { config: { imageApiUrl: 'https://generator.example/images' } },
    ));

    expect(result).toMatchObject({ success: true, mimeType: 'image/png', size: '256x256' });
    expect(result.image).toBe(`data:image/png;base64,${PNG.toString('base64')}`);
    expect(globalThis.fetch).toHaveBeenNthCalledWith(2, 'https://images.example/result.png', { signal: undefined });
  });

  it('rejects unsupported generated content instead of exposing it as an image', async () => {
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ url: 'https://images.example/result.svg' }), { status: 200 }))
      .mockResolvedValueOnce(new Response('<svg/>', { status: 200, headers: { 'content-type': 'image/svg+xml' } }));

    const result = JSON.parse(await imageGenerationTool.execute(
      { prompt: 'unsafe svg' },
      { config: { imageApiUrl: 'https://generator.example/images' } },
    ));
    expect(result.error).toMatch(/Unsupported generated image type/);
  });
});
