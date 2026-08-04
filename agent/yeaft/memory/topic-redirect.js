import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const TOPIC_REDIRECT_FILE = 'redirect.json';

export function normalizeTopicPath(value) {
  const parts = String(value || '').split('/').map(part => part.trim()).filter(Boolean);
  if (parts.length === 0 || parts.length > 2) return '';
  if (parts.some(part => part === '.' || part === '..' || /[\\\0]/.test(part))) return '';
  return parts.join('/');
}

export function resolveTopicRedirect(root, sessionId, path) {
  let current = normalizeTopicPath(path);
  const visited = new Set();
  while (current && !visited.has(current)) {
    visited.add(current);
    const redirectPath = join(root, 'sessions', sessionId, 'topic', current, TOPIC_REDIRECT_FILE);
    if (!existsSync(redirectPath)) break;
    let payload;
    try { payload = JSON.parse(readFileSync(redirectPath, 'utf8') || '{}'); }
    catch { break; }
    const next = normalizeTopicPath(payload?.canonical);
    if (!next || next === current) break;
    current = next;
  }
  return current;
}
