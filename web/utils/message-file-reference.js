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

/**
 * Resolve a rendered Markdown href to an Agent-local file reference.
 * External URLs, page anchors, and browser API routes remain normal links.
 *
 * @param {string} href
 * @returns {{path: string, line: number|null}|null}
 */
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
    } catch (_) {
      return null;
    }
  } else if (URI_SCHEME.test(value) && !WINDOWS_ABSOLUTE_PATH.test(value)) {
    return null;
  }

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

const escapeAttribute = value => value
  .replace(/&/g, '&amp;')
  .replace(/"/g, '&quot;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;');

/**
 * Mark file links and turn standalone inline-code file references into links.
 * Code blocks are deliberately excluded.
 *
 * @param {string} html
 * @returns {string}
 */
export function decorateMessageFileReferences(html) {
  if (typeof html !== 'string' || !html) return html || '';
  const markedLinks = html.replace(/<a\s+([^>]*?href=(['"])(.*?)\2[^>]*)>/gi, (match, attrs, _quote, href) => {
    if (!resolveMessageFileReference(href) || /\bmessage-file-reference\b/.test(attrs)) return match;
    if (/\bclass\s*=/.test(attrs)) {
      return `<a ${attrs.replace(/\bclass=(['"])(.*?)\1/i, (_classMatch, quote, classes) => `class=${quote}${classes} message-file-reference${quote}`)}>`;
    }
    return `<a ${attrs} class="message-file-reference">`;
  });

  return markedLinks.replace(/(<pre\b[^>]*>[\s\S]*?<\/pre>)|<code>([^<]+)<\/code>/gi, (match, pre, codeText) => {
    if (pre || !codeText) return match;
    const decoded = codeText
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'");
    if (!resolveMessageFileReference(decoded)) return match;
    return `<a href="${escapeAttribute(decoded)}" class="message-file-reference"><code>${codeText}</code></a>`;
  });
}
