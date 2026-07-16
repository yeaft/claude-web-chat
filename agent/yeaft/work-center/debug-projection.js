const MAX_DEBUG_STRING_BYTES = 64 * 1024;
export const MAX_ACTION_REQUEST_DETAIL_BYTES = 256 * 1024;
const MAX_ACTION_REQUEST_INPUT_BYTES = MAX_ACTION_REQUEST_DETAIL_BYTES;
const MAX_ACTION_REQUEST_INPUT_LOOPS = 16;
const MAX_ACTION_REQUEST_INPUT_TOOLS = MAX_ACTION_REQUEST_INPUT_LOOPS * 128;
const MAX_DEBUG_ARRAY_ITEMS = 128;
const SENSITIVE_NAMES = new Set([
  'apikey', 'xapikey', 'token', 'accesstoken', 'refreshtoken', 'idtoken', 'clientsecret',
  'secret', 'signature', 'sig', 'credential', 'password', 'passwd',
  'authorization', 'proxyauthorization', 'auth', 'code', 'cookie', 'setcookie',
]);
const BINARY_DATA_TYPES = new Set(['base64', 'redactedthinking', 'redacted_thinking']);
const MAX_SENSITIVE_NAME_LENGTH = Math.max(...[...SENSITIVE_NAMES].map(name => name.length));
const MAX_SENSITIVE_NAME_SOURCE_CHARS = 256;
const MAX_QUOTED_SECRET_VALUE_CHARS = 64 * 1024;
const MAX_URL_NAME_DECODE_STEPS = 3;

function byteLength(value) {
  return Buffer.byteLength(String(value || ''), 'utf8');
}

function jsonByteLength(value) {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function truncateUtf8(value, maxBytes = MAX_DEBUG_STRING_BYTES) {
  const bytes = Buffer.from(String(value || ''), 'utf8');
  if (bytes.length <= maxBytes) return bytes.toString('utf8');
  const marker = '\n[truncated to browser debug budget]';
  const contentBytes = Math.max(0, maxBytes - byteLength(marker));
  let end = Math.min(contentBytes, bytes.length);
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
  return `${bytes.subarray(0, end).toString('utf8')}${marker}`;
}

function normalizeSensitiveName(name) {
  return String(name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function isSensitiveName(name) {
  return SENSITIVE_NAMES.has(normalizeSensitiveName(name));
}

function decodeQuotedName(value, quote) {
  if (quote === "'") return value;
  try {
    return JSON.parse(`"${value}"`);
  } catch {
    return null;
  }
}

function quotedNameBeforeOperator(text, operatorIndex) {
  let end = operatorIndex;
  while (end > 0 && /\s/.test(text[end - 1])) end -= 1;
  const quote = text[end - 1];
  if (quote !== '"' && quote !== "'") return undefined;
  const earliest = Math.max(0, end - MAX_SENSITIVE_NAME_SOURCE_CHARS);
  for (let start = end - 2; start >= earliest; start -= 1) {
    if (text[start] !== quote) continue;
    let slashCount = 0;
    for (let cursor = start - 1; cursor >= earliest && text[cursor] === '\\'; cursor -= 1) {
      slashCount += 1;
    }
    if (slashCount % 2 === 0) {
      return decodeQuotedName(text.slice(start + 1, end - 1), quote);
    }
  }
  return null;
}

function candidateStart(text, end, colonOperator) {
  let start = end;
  const boundary = colonOperator
    ? /[\r\n,:=;{}\[\]()"'?&]/
    : /[\r\n,=;{}\[\]()"'?&]/;
  while (start > 0 && !boundary.test(text[start - 1])) start -= 1;
  return start;
}

function hasSensitiveSuffix(text, start, end) {
  let reversed = '';
  const earliest = Math.max(start, end - MAX_SENSITIVE_NAME_SOURCE_CHARS);
  for (let index = end - 1; index >= earliest; index -= 1) {
    const character = text[index].toLowerCase();
    if (/[a-z0-9]/.test(character)) {
      reversed += character;
      if (reversed.length > MAX_SENSITIVE_NAME_LENGTH) return false;
      continue;
    }
    if (!reversed) continue;
    const normalized = [...reversed].reverse().join('');
    if (/[\s:&?;,={}\[\]()"']/.test(character)) {
      if (SENSITIVE_NAMES.has(normalized)) return true;
      if (!/[\s:]/.test(character)) return false;
    }
  }
  return SENSITIVE_NAMES.has([...reversed].reverse().join(''));
}

function assignmentHasSensitiveName(text, operatorIndex, operator) {
  let end = operatorIndex;
  while (end > 0 && /\s/.test(text[end - 1])) end -= 1;
  if (end === 0) return false;
  const quotedName = quotedNameBeforeOperator(text, operatorIndex);
  if (quotedName !== undefined) return quotedName == null || isSensitiveName(quotedName);
  if (operator === '=') return hasSensitiveSuffix(text, 0, end);
  const start = candidateStart(text, end, true);
  const candidate = text.slice(start, end).trim();
  if (/(?:^|\s)status\s+code$/i.test(candidate)) return false;
  return isSensitiveName(candidate) || hasSensitiveSuffix(text, start, end);
}

function sensitiveAssignmentOperators(value, allowColon = true) {
  const text = String(value || '');
  const operators = [];
  for (let index = 0; index < text.length; index += 1) {
    const operator = text[index];
    if (operator !== '=' && operator !== ':') continue;
    if (operator === ':') {
      if (!allowColon) continue;
      let valueStart = index + 1;
      const valueLimit = Math.min(text.length, index + MAX_SENSITIVE_NAME_SOURCE_CHARS);
      while (valueStart < valueLimit && /[\t ]/.test(text[valueStart])) valueStart += 1;
      const quotedName = quotedNameBeforeOperator(text, index);
      const hasStructuredValue = valueStart > index + 1 || /["']/.test(text[valueStart] || '');
      if (quotedName === undefined && !hasStructuredValue) {
        let end = index;
        const earliest = Math.max(0, index - MAX_SENSITIVE_NAME_SOURCE_CHARS);
        while (end > earliest && /\s/.test(text[end - 1])) end -= 1;
        const start = candidateStart(text, end, true);
        if (start > 0 && text[start - 1] === ':') continue;
      }
    }
    if (assignmentHasSensitiveName(text, index, operator)) operators.push(index);
  }
  return operators;
}

function containsSensitiveFieldSyntax(value) {
  return sensitiveAssignmentOperators(value).length > 0;
}

function assignmentValueReplacement(text, operatorIndex) {
  let start = operatorIndex + 1;
  const valueLimit = Math.min(text.length, operatorIndex + MAX_SENSITIVE_NAME_SOURCE_CHARS);
  while (start < valueLimit && /[\t ]/.test(text[start])) start += 1;
  if (start === valueLimit && start < text.length) {
    return { start: operatorIndex + 1, end: text.length, value: '***' };
  }
  if (start >= text.length || /[\r\n]/.test(text[start])) return null;
  const quote = text[start];
  if (quote === '"' || quote === "'") {
    let end = start + 1;
    const quoteLimit = Math.min(text.length, start + MAX_QUOTED_SECRET_VALUE_CHARS);
    while (end < quoteLimit && !/[\r\n]/.test(text[end])) {
      if (text[end] === quote && text[end - 1] !== '\\') {
        return { start, end: end + 1, value: `${quote}***${quote}` };
      }
      end += 1;
    }
    return { start, end, value: `${quote}***${quote}` };
  }
  let end = start;
  const bearer = /^Bearer\s+/i.exec(text.slice(start, start + 32));
  if (bearer) end += bearer[0].length;
  while (end < text.length && !/[\s,;=&}\]]/.test(text[end])) end += 1;
  return end > start ? { start, end, value: '***' } : null;
}

function redactSensitiveAssignments(value, allowColon = true) {
  const text = String(value || '');
  const replacements = sensitiveAssignmentOperators(text, allowColon)
    .map(index => assignmentValueReplacement(text, index))
    .filter(Boolean);
  const merged = [];
  for (const replacement of replacements) {
    const previous = merged.at(-1);
    if (!previous || replacement.start >= previous.end) {
      merged.push({ ...replacement });
      continue;
    }
    if (replacement.end <= previous.end) continue;
    previous.end = replacement.end;
    previous.value = '***';
  }
  if (merged.length === 0) return text;
  const parts = [];
  let cursor = 0;
  for (const replacement of merged) {
    parts.push(text.slice(cursor, replacement.start), replacement.value);
    cursor = replacement.end;
  }
  parts.push(text.slice(cursor));
  return parts.join('');
}

function isSensitiveUrlName(name) {
  let decoded = String(name || '');
  for (let step = 0; step < MAX_URL_NAME_DECODE_STEPS; step += 1) {
    if (isSensitiveName(decoded)) return true;
    let next;
    try {
      next = decodeURIComponent(decoded.replace(/\+/g, ' '));
    } catch {
      return true;
    }
    if (next === decoded) return false;
    decoded = next;
  }
  return isSensitiveName(decoded) || decoded.includes('%');
}

function boundedDebugInputBytes(value, maxBytes) {
  let bytes = 0;
  const seen = new Set();
  const stack = [value];
  while (stack.length > 0 && bytes <= maxBytes) {
    const item = stack.pop();
    if (item == null) {
      bytes += 4;
      continue;
    }
    if (typeof item === 'string') {
      if (item.length > maxBytes - bytes) return maxBytes + 1;
      bytes += byteLength(item);
      continue;
    }
    if (typeof item !== 'object') {
      bytes += byteLength(item);
      continue;
    }
    if (seen.has(item)) continue;
    seen.add(item);
    if (Array.isArray(item)) {
      const length = Math.min(item.length, MAX_DEBUG_ARRAY_ITEMS);
      if (item.length > length) bytes += 32;
      for (let index = length - 1; index >= 0; index -= 1) stack.push(item[index]);
      continue;
    }
    for (const key in item) {
      if (!Object.hasOwn(item, key)) continue;
      bytes += byteLength(key);
      if (bytes > maxBytes) break;
      stack.push(item[key]);
    }
  }
  return bytes > maxBytes ? maxBytes + 1 : bytes;
}

export function limitActionRequestDebugInput(loopValues, toolValues) {
  const sourceLoops = Array.isArray(loopValues) ? loopValues : [];
  const sourceTools = Array.isArray(toolValues) ? toolValues : [];
  const candidates = sourceLoops.slice(-MAX_ACTION_REQUEST_INPUT_LOOPS);
  const candidateNumbers = new Set(candidates.map(loop => Number(loop?.loopNumber) || 0));
  const toolsByLoop = new Map();
  for (const tool of sourceTools.slice(-MAX_ACTION_REQUEST_INPUT_TOOLS)) {
    const loopNumber = Number(tool?.loopNumber) || 0;
    if (!candidateNumbers.has(loopNumber)) continue;
    const tools = toolsByLoop.get(loopNumber) || [];
    tools.push(tool);
    toolsByLoop.set(loopNumber, tools);
  }

  let remainingBytes = MAX_ACTION_REQUEST_INPUT_BYTES;
  const loops = [];
  const tools = [];
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const loop = candidates[index];
    const loopTools = toolsByLoop.get(Number(loop?.loopNumber) || 0) || [];
    const inputBytes = boundedDebugInputBytes({ loop, tools: loopTools }, remainingBytes);
    if (inputBytes > remainingBytes) continue;
    loops.unshift(loop);
    tools.unshift(...loopTools);
    remainingBytes -= inputBytes;
  }
  return {
    loops,
    tools,
    omittedLoopCount: sourceLoops.length - loops.length,
  };
}

function sanitizeUrlQueryNames(value) {
  return String(value || '').replace(
    /([?&])([^=&#]+)=([^&#]*)/g,
    (match, prefix, name) => (isSensitiveUrlName(name) ? `${prefix}${name}=***` : match),
  );
}

export function sanitizeDebugUrl(value) {
  const text = sanitizeUrlQueryNames(truncateUtf8(value, MAX_DEBUG_STRING_BYTES));
  try {
    const url = new URL(text);
    url.username = '';
    url.password = '';
    return truncateUtf8(url.toString());
  } catch {
    return truncateUtf8(text.replace(/\/\/[^/@\s]+@/g, '//'));
  }
}

export function sanitizeDiagnosticText(value, maxBytes = 8 * 1024) {
  let text = truncateUtf8(value, maxBytes);
  text = text.replace(/https?:\/\/[^\s"'<>]+/gi, match => sanitizeDebugUrl(match));
  text = redactSensitiveAssignments(text);
  text = text.replace(/\b(Bearer)\s+[^\s,;}\]]+/gi, '$1 ***');
  return truncateUtf8(text, maxBytes);
}

function omittedBinary(value) {
  return `[binary data omitted: ${byteLength(value)} bytes]`;
}

function sanitizeSseMetadataLine(line) {
  const match = String(line || '').match(/^(\s*(?:event|id|retry)?\s*:)(.*)$/i);
  if (!match) return sanitizeDiagnosticText(line, MAX_DEBUG_STRING_BYTES);
  let value = truncateUtf8(match[2], MAX_DEBUG_STRING_BYTES);
  value = value.replace(/https?:\/\/[^\s"'<>]+/gi, url => sanitizeDebugUrl(url));
  value = redactSensitiveAssignments(value, false);
  const colonValue = value.match(/^(\s*)([^:=\s]+)(\s+|\s*:\s+)(.+)$/);
  if (colonValue && isSensitiveName(colonValue[2])) {
    value = `${colonValue[1]}${colonValue[2]}${colonValue[3]}***`;
  }
  value = value.replace(/\b(Bearer)\s+[^\s,;}\]]+/gi, '$1 ***');
  return truncateUtf8(`${match[1]}${value}`, MAX_DEBUG_STRING_BYTES);
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
    return lines.map(line => sanitizeSseMetadataLine(line)).join('\n');
  }

  const data = dataParts.join('\n');
  let sanitized = data;
  if (data !== '[DONE]') {
    try {
      sanitized = JSON.stringify(sanitizeDebugValue(JSON.parse(data), null, '', seen));
    } catch {
      sanitized = containsSensitiveFieldSyntax(data)
        ? '[redacted SSE event: malformed sensitive data]'
        : sanitizeDiagnosticText(data, MAX_DEBUG_STRING_BYTES);
    }
  }

  const firstDataIndex = dataIndexes[0];
  const dataIndexSet = new Set(dataIndexes);
  const sanitizedDataLines = String(sanitized).split('\n').map(line => `data: ${line}`).join('\n');
  const sanitizedLines = [];
  for (const [index, line] of lines.entries()) {
    if (dataIndexSet.has(index)) {
      if (index === firstDataIndex) sanitizedLines.push(sanitizedDataLines);
      continue;
    }
    sanitizedLines.push(sanitizeSseMetadataLine(line));
  }
  return sanitizedLines.join('\n');
}

function sanitizeSseBody(value, seen) {
  const text = truncateUtf8(value, MAX_DEBUG_STRING_BYTES);
  const trailingSeparator = /(?:\r?\n){2}$/.test(text) ? '\n\n' : '';
  const events = text.split(/(?:\r?\n){2}/);
  if (events.at(-1) === '') events.pop();
  return truncateUtf8(`${events.map(event => sanitizeSseEvent(event, seen)).join('\n\n')}${trailingSeparator}`);
}

export function sanitizeDebugValue(value, parent = null, key = '', seen = new WeakSet()) {
  if (key && isSensitiveName(key)) return '***';
  if (value == null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const text = truncateUtf8(value, MAX_DEBUG_STRING_BYTES);
    if (key === 'url') return sanitizeDebugUrl(text);
    if (text.startsWith('data:') && text.includes(';base64,')) return omittedBinary(value);
    const parentType = String(parent?.type || '').toLowerCase().replace(/[^a-z0-9_]/g, '');
    if (key === 'data' && BINARY_DATA_TYPES.has(parentType)) return omittedBinary(value);
    if (key === 'body' && /^[\s\r\n]*[\[{]/.test(text)) {
      try {
        return truncateUtf8(JSON.stringify(sanitizeDebugValue(JSON.parse(text), null, '', seen)));
      } catch {
        if (containsSensitiveFieldSyntax(text)) {
          return '[redacted malformed JSON: sensitive data]';
        }
      }
    }
    return sanitizeDiagnosticText(text, MAX_DEBUG_STRING_BYTES);
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

export function enforceActionRequestDetailBudget(detail, omittedLoopCount = 0) {
  if (omittedLoopCount > 0 && detail?.request) {
    detail.request.truncated = true;
    detail.request.omittedLoopCount = omittedLoopCount;
  }
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
