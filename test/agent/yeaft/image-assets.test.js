import { describe, expect, it } from 'vitest';
import { extractDisplayImages, imageMetadataForPersistence, stripDisplayImageData } from '../../../agent/yeaft/image-assets.js';

const ONE_PIXEL_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

describe('Yeaft display images', () => {
  it('extracts supported data images and strips base64 from model-visible output', () => {
    const output = JSON.stringify({
      success: true,
      path: '/project/generated.png',
      image: `data:image/png;base64,${ONE_PIXEL_PNG}`,
      mimeType: 'image/png',
      filename: 'generated.png',
    });
    const images = extractDisplayImages('ImageGeneration', output);
    expect(images).toHaveLength(1);
    expect(images[0]).toMatchObject({ mimeType: 'image/png', filename: 'generated.png' });
    expect(images[0].previewData.data).toBe(ONE_PIXEL_PNG);

    const stripped = stripDisplayImageData(output, images);
    expect(stripped).not.toContain(ONE_PIXEL_PNG);
    expect(JSON.parse(stripped)).toMatchObject({
      success: true,
      path: '/project/generated.png',
      imageAssetIds: [images[0].assetId],
    });
    expect(imageMetadataForPersistence(images[0])).not.toHaveProperty('previewData');
  });

  it('rejects SVG and oversized/invalid base64 payloads', () => {
    expect(extractDisplayImages('ViewImage', JSON.stringify({ image: 'data:image/svg+xml;base64,PHN2Zz4=' }))).toEqual([]);
    expect(extractDisplayImages('ViewImage', JSON.stringify({ image: 'data:image/png;base64,not_base64!' }))).toEqual([]);
  });
});
