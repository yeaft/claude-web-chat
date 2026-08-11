const WINDOWS_ABSOLUTE_PATH = /^[A-Za-z]:[\\/]/;
const URI_SCHEME = /^[A-Za-z][A-Za-z\d+.-]*:/;
const API_PATH = /^\/api(?:\/|$)/;
const LINE_HASH = /#L(\d+)(?:C\d+)?$/i;
const LINE_SUFFIX = /:(\d+)(?::\d+)?$/;
const VERSION_BASENAME = /^v?\d+(?:\.\d+){1,}(?:[-+][A-Za-z\d.-]+)?$/i;
const ARCHIVE_EXTENSION = /\.(?:7z|bz2?|gz|rar|tar|tgz|xz|zip|zst)$/i;
const KNOWN_EXTENSIONLESS_FILE = /^(?:README|LICENSE|CHANGELOG|CONTRIBUTING|Dockerfile|Makefile)(?:[-_.][A-Za-z\d-]+)?$/i;

const isRecognizableFilePath = value => {
  const basename = value.split(/[\\/]/).pop() || '';
  if (!basename || ARCHIVE_EXTENSION.test(basename)) return false;
  if (WINDOWS_ABSOLUTE_PATH.test(value) || /^(?:\/|\.\.?[\\/]|~[\\/])/.test(value)) return true;
  if (VERSION_BASENAME.test(basename)) return false;
  if (basename.startsWith('.') && basename.length > 1) return true;
  if (KNOWN_EXTENSIONLESS_FILE.test(basename)) return true;
  return /\.[A-Za-z\d][A-Za-z\d_-]*$/.test(basename);
};

export function resolveMessageFileReference(href) {
  if (typeof href !== 'string') return null;
  let value = href.trim();
  if (!value || value.startsWith('#')) return null;
  try { value = decodeURIComponent(value); } catch (_) {}

  if (/^file:\/\//i.test(value)) {
    try {
      const url = new URL(value);
      value = url.pathname || '';
      if (url.hostname && url.hostname !== 'localhost') value = `//${url.hostname}${value}`;
    } catch (_) { return null; }
  } else if (URI_SCHEME.test(value) && !WINDOWS_ABSOLUTE_PATH.test(value)) return null;
  if (API_PATH.test(value)) return null;

  let line = null;
  const hashMatch = value.match(LINE_HASH);
  if (hashMatch) {
    line = Number(hashMatch[1]);
    value = value.slice(0, hashMatch.index);
  } else {
    const suffixMatch = value.match(LINE_SUFFIX);
    if (suffixMatch && !WINDOWS_ABSOLUTE_PATH.test(value.slice(0, suffixMatch.index + 1))) {
      line = Number(suffixMatch[1]);
      value = value.slice(0, suffixMatch.index);
    }
  }

  value = value.split(/[?#]/, 1)[0]?.trim() || '';
  if (!value || value.endsWith('/') || !isRecognizableFilePath(value)) return null;
  return { path: value, line: Number.isFinite(line) && line > 0 ? line : null };
}

const decodeHtml = value => value
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'");
const escapeAttribute = value => value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function collectMessageFileReferences(html) {
  if (typeof html !== 'string' || !html) return [];
  const references = new Set();
  html.replace(/(<pre\b[^>]*>[\s\S]*?<\/pre>)|<a\s+[^>]*?href=(['"])(.*?)\2[^>]*>|<code>([^<]+)<\/code>/gi,
    (_match, pre, _quote, href, codeText) => {
      if (pre) return '';
      const reference = resolveMessageFileReference(href || decodeHtml(codeText || ''));
      if (reference) references.add(reference.path);
      return '';
    });
  return [...references];
}

/** Render only Agent-confirmed references as file links. Unconfirmed Markdown
 * file anchors are downgraded to plain text; inline code remains inline code. */
export function decorateMessageFileReferences(html, resolvedReferences = {}) {
  if (typeof html !== 'string' || !html) return html || '';
  const resolved = resolvedReferences instanceof Map
    ? resolvedReferences
    : new Map(Object.entries(resolvedReferences || {}));
  const anchors = html.replace(/<a\s+([^>]*?href=(['"])(.*?)\2[^>]*)>([\s\S]*?)<\/a>/gi,
    (match, _attrs, _quote, href, label) => {
      const reference = resolveMessageFileReference(href);
      if (!reference) return match;
      const resolvedPath = resolved.get(reference.path);
      if (!resolvedPath) return label;
      return `<a href="${escapeAttribute(href)}" data-resolved-file-path="${escapeAttribute(resolvedPath)}" class="message-file-reference">${label}</a>`;
    });

  return anchors.replace(/(<pre\b[^>]*>[\s\S]*?<\/pre>)|<code>([^<]+)<\/code>/gi, (match, pre, codeText) => {
    if (pre || !codeText) return match;
    const decoded = decodeHtml(codeText);
    const reference = resolveMessageFileReference(decoded);
    const resolvedPath = reference && resolved.get(reference.path);
    if (!reference || !resolvedPath) return match;
    return `<a href="${escapeAttribute(decoded)}" data-resolved-file-path="${escapeAttribute(resolvedPath)}" class="message-file-reference"><code>${codeText}</code></a>`;
  });
}
