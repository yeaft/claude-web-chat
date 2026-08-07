const WINDOWS_ABSOLUTE_PATH = /^[A-Za-z]:[\\/]/;
const URI_SCHEME = /^[A-Za-z][A-Za-z\d+.-]*:/;
const API_PATH = /^\/api(?:\/|$)/;
const LINE_HASH = /#L(\d+)(?:C\d+)?$/i;
const LINE_SUFFIX = /:(\d+)(?::\d+)?$/;

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
  if (!value || value.endsWith('/')) return null;
  if (!/[\\/.]/.test(value)) return null;

  return { path: value, line: Number.isFinite(line) && line > 0 ? line : null };
}
