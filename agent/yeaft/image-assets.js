import { createHash } from 'node:crypto';

const SUPPORTED_IMAGE_MIME = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const MAX_UI_IMAGE_BYTES = 20 * 1024 * 1024;

function parseJsonObject(value) {
  if (value && typeof value === 'object') return value;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return null;
  try { return JSON.parse(trimmed); } catch { return null; }
}

function decodeDataUri(value) {
  const match = typeof value === 'string'
    ? value.match(/^data:(image\/[A-Za-z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)$/)
    : null;
  if (!match) return null;
  const mimeType = match[1].toLowerCase();
  if (!SUPPORTED_IMAGE_MIME.has(mimeType)) return null;
  const data = match[2].replace(/\s+/g, '');
  let buffer;
  try { buffer = Buffer.from(data, 'base64'); } catch { return null; }
  if (!buffer.length || buffer.length > MAX_UI_IMAGE_BYTES) return null;
  return { mimeType, data, buffer };
}

function imageCandidates(payload) {
  if (!payload) return [];
  if (Array.isArray(payload)) return payload;
  const out = [];
  if (payload.image) out.push(typeof payload.image === 'object' ? payload.image : { image: payload.image });
  if (payload.dataUri) out.push({ dataUri: payload.dataUri });
  if (Array.isArray(payload.images)) out.push(...payload.images);
  return out;
}

export function extractDisplayImages(toolName, output) {
  const payload = parseJsonObject(output);
  const images = [];
  const seen = new Set();
  for (const item of imageCandidates(payload)) {
    const dataUri = typeof item === 'string'
      ? item
      : (item?.dataUri || item?.image || (item?.data && item?.mimeType ? `data:${item.mimeType};base64,${item.data}` : null));
    const decoded = decodeDataUri(dataUri);
    if (!decoded) continue;
    const assetId = createHash('sha256').update(decoded.buffer).digest('hex');
    if (seen.has(assetId)) continue;
    seen.add(assetId);
    const filename = String(item?.filename || payload?.filename || payload?.path || `${toolName || 'image'}-${assetId.slice(0, 12)}`)
      .split(/[/\\]/)
      .pop();
    images.push({
      assetId,
      mimeType: decoded.mimeType,
      filename,
      size: decoded.buffer.length,
      width: Number.isFinite(item?.width ?? payload?.width) ? Number(item?.width ?? payload.width) : null,
      height: Number.isFinite(item?.height ?? payload?.height) ? Number(item?.height ?? payload.height) : null,
      previewData: { data: decoded.data, mimeType: decoded.mimeType, filename },
    });
  }
  return images;
}

export function imageMetadataForPersistence(image) {
  if (!image?.assetId || !image?.mimeType) return null;
  return {
    assetId: image.assetId,
    mimeType: image.mimeType,
    filename: image.filename || 'image',
    size: Number(image.size) || null,
    width: Number(image.width) || null,
    height: Number(image.height) || null,
  };
}

export function stripDisplayImageData(output, images) {
  if (!Array.isArray(images) || images.length === 0) {
    return typeof output === 'string' ? output : JSON.stringify(output ?? '');
  }
  const payload = parseJsonObject(output);
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return '[image asset]';
  const clean = { ...payload };
  delete clean.image;
  delete clean.images;
  delete clean.dataUri;
  if (typeof clean.data === 'string' && clean.data.length > 1024) delete clean.data;
  return JSON.stringify({ ...clean, imageAssetIds: images.map(image => image.assetId) });
}
