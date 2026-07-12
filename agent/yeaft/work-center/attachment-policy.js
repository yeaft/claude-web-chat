import { extname } from 'node:path';

export const MAX_WORK_ITEM_ATTACHMENTS = 10;
export const MAX_WORK_ITEM_ATTACHMENT_BYTES = 50 * 1024 * 1024;
export const MAX_WORK_ITEM_INLINE_BYTES = 10 * 1024 * 1024;

const IMAGE_EXTENSIONS_BY_MIME = new Map([
  ['image/png', new Set(['.png'])],
  ['image/jpeg', new Set(['.jpg', '.jpeg', '.jfif'])],
  ['image/gif', new Set(['.gif'])],
  ['image/webp', new Set(['.webp'])],
]);

const TEXT_EXTENSIONS = new Set([
  '.txt', '.md', '.markdown', '.json', '.jsonl', '.csv', '.xml', '.yaml', '.yml',
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.css', '.html', '.htm', '.py',
  '.sh', '.zsh', '.bash', '.sql', '.toml', '.ini', '.conf', '.log',
]);

const TEXT_MIME_TYPES = new Set([
  'application/json',
  'application/ld+json',
  'application/javascript',
  'application/x-javascript',
  'application/xml',
  'application/yaml',
  'application/x-yaml',
]);

export function classifyWorkItemAttachment(name, mimeType) {
  const normalizedMime = String(mimeType || 'application/octet-stream').trim().toLowerCase();
  const extension = extname(String(name || '')).toLowerCase();
  if (extension === '.pdf') return normalizedMime === 'application/pdf' ? 'pdf' : null;

  const imageExtensions = IMAGE_EXTENSIONS_BY_MIME.get(normalizedMime);
  if (imageExtensions) return imageExtensions.has(extension) ? 'image' : null;

  const textMime = normalizedMime.startsWith('text/') || TEXT_MIME_TYPES.has(normalizedMime);
  if (textMime) return !extension || TEXT_EXTENSIONS.has(extension) ? 'text' : null;
  if (TEXT_EXTENSIONS.has(extension) && normalizedMime === 'application/octet-stream') return 'text';
  return null;
}

export function assertSupportedWorkItemAttachment(name, mimeType) {
  const kind = classifyWorkItemAttachment(name, mimeType);
  if (!kind) {
    throw new Error('Unsupported WorkItem attachment type; use an image, PDF, or text-based file');
  }
  return kind;
}

export function assertWorkItemAttachmentSize(size) {
  if (!Number.isSafeInteger(size) || size < 0 || size > MAX_WORK_ITEM_INLINE_BYTES) {
    throw new Error(`WorkItem attachment exceeds ${MAX_WORK_ITEM_INLINE_BYTES} bytes`);
  }
}
