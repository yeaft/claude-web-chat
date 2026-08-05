/**
 * utf8.js — Small UTF-8 byte-budget helpers shared by Agent internals.
 *
 * JavaScript strings are UTF-16. Convert malformed lone surrogates before
 * walking code points so a byte-limited preview is always well-formed Unicode.
 */

export function normalizeUtf8ByteBudget(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed)
    ? Math.max(0, Math.floor(parsed))
    : Math.max(0, Math.floor(Number(fallback) || 0));
}

export function toWellFormedText(value) {
  return String(value ?? '').toWellFormed();
}

/**
 * Return the longest well-formed UTF-8 prefix within maxBytes.
 *
 * This makes one code-point pass and one final slice. It deliberately does
 * not repeatedly rescan successively shorter UTF-16 slices with
 * Buffer.byteLength(), which becomes quadratic for oversized payloads.
 */
export function utf8PrefixWithinBytes(value, maxBytes) {
  const text = toWellFormedText(value);
  const limit = normalizeUtf8ByteBudget(maxBytes);
  let end = 0;
  let bytes = 0;

  while (end < text.length) {
    const codePoint = text.codePointAt(end);
    const width = codePoint > 0xFFFF ? 2 : 1;
    const byteLength = codePoint <= 0x7F
      ? 1
      : (codePoint <= 0x7FF ? 2 : (codePoint <= 0xFFFF ? 3 : 4));
    if (bytes + byteLength > limit) break;
    bytes += byteLength;
    end += width;
  }

  return { text: text.slice(0, end), bytes };
}
