const MAX_DEBUG_STRING_BYTES = 64 * 1024;
export const MAX_ACTION_REQUEST_DETAIL_BYTES = 256 * 1024;
const MAX_DEBUG_ARRAY_ITEMS = 128;
const SENSITIVE_NAMES = new Set([
  'apikey', 'xapikey', 'token', 'accesstoken', 'refreshtoken', 'idtoken', 'clientsecret',
  'secret', 'signature', 'sig', 'credential', 'password', 'passwd',
  'authorization', 'proxyauthorization', 'auth', 'code', 'cookie', 'setcookie',
]);
const BINARY_DATA_TYPES = new Set(['base64', 'redactedthinking', 'redacted_thinking']);

function byteLength(value) {
  return Buffer.byteLength(String(value || ''), 'utf8');
}

function jsonByteLength(value) {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function truncateUtf8(value, maxBytes = MAX_DEBUG_STRING_BYTES) {
  const text = String(value || '');
  if (byteLength(text) <= maxBytes) return text;
  const marker = '\n[truncated to browser debug budget]';
  const markerBytes = byteLength(marker);
  let low = 0;
  let high = text.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    let end = middle;
    if (end > 0 && /[\uD800-\uDBFF]/.test(text[end - 1])) end -= 1;
    if (byteLength(text.slice(0, end)) + markerBytes <= maxBytes) low = middle;
    else high = middle - 1;
  }
  let end = low;
  if (end > 0 && /[\uD800-\uDBFF]/.test(text[end - 1])) end -= 1;
  return `${text.slice(0, end)}${marker}`;
}

function normalizeSensitiveName(name) {
  return String(name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function isSensitiveName(name) {
  return SENSITIVE_NAMES.has(normalizeSensitiveName(name));
}

function containsSensitiveFieldSyntax(value) {
  const text = String(value || '');
  const fieldPattern = /(?:^|[,{;\s])["']?([a-z][a-z0-9_-]*)["']?\s*[:=]/gi;
  let match;
  while ((match = fieldPattern.exec(text))) {
    if (isSensitiveName(match[1])) return true;
  }
  return false;
}

export function sanitizeDebugUrl(value) {
  const text = String(value || '');
  try {
    const url = new URL(text);
    url.username = '';
    url.password = '';
    for (const name of [...url.searchParams.keys()]) {
      if (isSensitiveName(name)) url.searchParams.set(name, '***');
    }
    return truncateUtf8(url.toString());
  } catch {
    const withoutUserInfo = text.replace(/\/\/[^/@\s]+@/g, '//');
    return truncateUtf8(withoutUserInfo.replace(
      /([?&])([^=&#]+)=([^&#]*)/g,
      (match, prefix, name) => (isSensitiveName(name) ? `${prefix}${name}=***` : match),
    ));
  }
}

export function sanitizeDiagnosticText(value, maxBytes = 8 * 1024) {
  let text = String(value || '');
  text = text.replace(/https?:\/\/[^\s"'<>]+/gi, match => sanitizeDebugUrl(match));
  const names = [
    'api[_-]?key', 'x[_-]?api[_-]?key', 'token', 'access[_-]?token', 'refresh[_-]?token',
    'id[_-]?token', 'client[_-]?secret', 'secret', 'credential', 'password', 'passwd',
    'authorization', 'proxy[_-]?authorization', 'cookie', 'set[_-]?cookie',
  ].join('|');
  text = text.replace(
    new RegExp(`\\b(${names})\\b(["']?\\s*[:=]\\s*)"[^"\\r\\n]*"`, 'gi'),
    '$1$2"***"',
  );
  text = text.replace(
    new RegExp(`\\b(${names})\\b(["']?\\s*[:=]\\s*)'[^'\\r\\n]*'`, 'gi'),
    "$1$2'***'",
  );
  text = text.replace(
    new RegExp(`\\b(${names})\\b(\\s*[:=]\\s*)(?:Bearer\\s+)?[^\\s,;}\\]]+`, 'gi'),
    '$1$2***',
  );
  text = text.replace(/\b(Bearer)\s+[^\s,;}\]]+/gi, '$1 ***');
  return truncateUtf8(text, maxBytes);
}

function omittedBinary(value) {
  return `[binary data omitted: ${byteLength(value)} bytes]`;
}

function sanitizeSseEvent(event, seen) {
  const lines = event.split(/\r?\n/);
  const dataIndexes = [];
  const dataParts = [];
  for (const [index, line] of lines.entries()) {
    const match = line.match(/^\s*data:\s?(.*)$/);
    if (!match) continue;
    dataIndexes.push(index);
    dataParts.push(match[1]);
  }
  if (dataParts.length === 0) {
    return lines.map(line => sanitizeDiagnosticText(line, MAX_DEBUG_STRING_BYTES)).join('\n');
  }

  const data = dataParts.join('\n');
  if (data === '[DONE]') return event;
  let sanitized;
  try {
    sanitized = JSON.stringify(sanitizeDebugValue(JSON.parse(data), null, '', seen));
  } catch {
    sanitized = containsSensitiveFieldSyntax(data)
      ? '[redacted SSE event: malformed sensitive data]'
      : sanitizeDiagnosticText(data, MAX_DEBUG_STRING_BYTES);
  }

  const firstDataIndex = dataIndexes[0];
  const dataIndexSet = new Set(dataIndexes);
  const sanitizedDataLines = String(sanitized).split('\n').map(line => `data: ${line}`).join('\n');
  return lines
    .filter((_line, index) => !dataIndexSet.has(index) || index === firstDataIndex)
    .map((line, index) => (index === firstDataIndex ? sanitizedDataLines : line))
    .join('\n');
}

function sanitizeSseBody(value, seen) {
  const text = String(value || '');
  const trailingSeparator = /(?:\r?\n){2}$/.test(text) ? '\n\n' : '';
  const events = text.split(/(?:\r?\n){2}/);
  if (events.at(-1) === '') events.pop();
  return truncateUtf8(`${events.map(event => sanitizeSseEvent(event, seen)).join('\n\n')}${trailingSeparator}`);
}

export function sanitizeDebugValue(value, parent = null, key = '', seen = new WeakSet()) {
  if (key && isSensitiveName(key)) return '***';
  if (value == null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (key === 'url') return sanitizeDebugUrl(value);
    if (value.startsWith('data:') && value.includes(';base64,')) return omittedBinary(value);
    const parentType = String(parent?.type || '').toLowerCase().replace(/[^a-z0-9_]/g, '');
    if (key === 'data' && BINARY_DATA_TYPES.has(parentType)) return omittedBinary(value);
    if (key === 'body' && /^[\s\r\n]*[\[{]/.test(value)) {
      try {
        return truncateUtf8(JSON.stringify(sanitizeDebugValue(JSON.parse(value), null, '', seen)));
      } catch {
        if (containsSensitiveFieldSyntax(value)) {
          return '[redacted malformed JSON: sensitive data]';
        }
      }
    }
    return sanitizeDiagnosticText(value, MAX_DEBUG_STRING_BYTES);
  }
  if (typeof value !== 'object') return truncateUtf8(String(value));
  if (seen.has(value)) return '[circular value omitted]';
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      const items = value.slice(0, MAX_DEBUG_ARRAY_ITEMS)
        .map(item => sanitizeDebugValue(item, value, '', seen));
      if (value.length > items.length) {
        items.push(`[${value.length - items.length} additional items omitted]`);
      }
      return items;
    }
    const out = {};
    for (const [childKey, item] of Object.entries(value)) {
      if (childKey === 'headers' && item && typeof item === 'object' && !Array.isArray(item)) {
        out.headers = Object.fromEntries(Object.entries(item).map(([name, headerValue]) => [
          name,
          isSensitiveName(name)
            ? '***'
            : sanitizeDebugValue(headerValue, item, name, seen),
        ]));
      } else if (childKey === 'body' && value.format === 'sse' && typeof item === 'string') {
        out.body = sanitizeSseBody(item, seen);
      } else {
        out[childKey] = sanitizeDebugValue(item, value, childKey, seen);
      }
    }
    return out;
  } finally {
    seen.delete(value);
  }
}

export function enforceActionRequestDetailBudget(detail) {
  if (!detail?.request || jsonByteLength(detail) <= MAX_ACTION_REQUEST_DETAIL_BYTES) return detail;
  detail.request.truncated = true;
  const loops = Array.isArray(detail.request.loops) ? detail.request.loops : [];
  const stages = [
    loop => { loop.rawResponse = null; },
    loop => { loop.rawRequest = null; },
    loop => {
      for (const tool of Array.isArray(loop.tools) ? loop.tools : []) {
        tool.output = null;
        tool.input = null;
      }
    },
    loop => { loop.messages = []; },
    loop => { loop.systemPrompt = ''; },
    loop => { loop.response = ''; },
  ];
  for (const stage of stages) {
    for (const loop of loops) stage(loop);
    if (jsonByteLength(detail) <= MAX_ACTION_REQUEST_DETAIL_BYTES) return detail;
  }
  while (loops.length > 1 && jsonByteLength(detail) > MAX_ACTION_REQUEST_DETAIL_BYTES) {
    loops.shift();
    detail.request.omittedLoopCount = (detail.request.omittedLoopCount || 0) + 1;
  }
  if (jsonByteLength(detail) <= MAX_ACTION_REQUEST_DETAIL_BYTES) return detail;
  detail.request.omittedLoopCount = (detail.request.omittedLoopCount || 0) + loops.length;
  detail.request.loops = [];
  if (jsonByteLength(detail) <= MAX_ACTION_REQUEST_DETAIL_BYTES) return detail;
  const request = detail.request;
  const metadata = value => truncateUtf8(value, 4 * 1024);
  return {
    actionId: metadata(detail.actionId),
    request: {
      id: metadata(request.id),
      runId: metadata(request.runId),
      status: metadata(request.status),
      model: metadata(request.model),
      vp: request.vp ? {
        id: metadata(request.vp.id),
        name: metadata(request.vp.name),
      } : null,
      openedAt: request.openedAt,
      closedAt: request.closedAt,
      loopCount: request.loopCount,
      totalMs: request.totalMs,
      totalTokens: request.totalTokens,
      loops: [],
      truncated: true,
      omittedLoopCount: detail.request.omittedLoopCount,
    },
  };
}
