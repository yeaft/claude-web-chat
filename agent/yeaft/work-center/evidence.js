const ALLOWED_KINDS = new Set(['text', 'tool', 'test', 'file', 'link', 'pr', 'commit']);
const OUTPUT_KINDS = new Set(['file', 'link', 'pr', 'commit']);
const ALLOWED_STATUSES = new Set(['completed', 'passed', 'failed', 'error', 'pending']);
const MAX_ITEMS = 50;
const MAX_LABEL_LENGTH = 500;
const MAX_REF_LENGTH = 1_000;
const MAX_URL_NAME_DECODE_STEPS = 3;
const SENSITIVE_URL_NAMES = new Set([
  'apikey', 'xapikey', 'token', 'accesstoken', 'refreshtoken', 'idtoken',
  'clientsecret', 'secret', 'signature', 'sig', 'credential', 'password',
  'passwd', 'authorization', 'proxyauthorization', 'auth', 'code', 'cookie',
  'setcookie',
]);

function boundedString(value, maxLength) {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, maxLength);
}

function normalizedUrlNames(value) {
  return String(value || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

function isSensitiveUrlName(value) {
  let decoded = String(value || '');
  for (let step = 0; step < MAX_URL_NAME_DECODE_STEPS; step += 1) {
    const names = normalizedUrlNames(decoded);
    if (names.some(name => SENSITIVE_URL_NAMES.has(name))
        || SENSITIVE_URL_NAMES.has(names.join(''))) return true;
    let next;
    try {
      next = decodeURIComponent(decoded.replace(/\+/g, ' '));
    } catch {
      return true;
    }
    if (next === decoded) return false;
    decoded = next;
  }
  const names = normalizedUrlNames(decoded);
  return names.some(name => SENSITIVE_URL_NAMES.has(name))
    || SENSITIVE_URL_NAMES.has(names.join(''))
    || decoded.includes('%');
}

function containsSensitiveAssignment(value) {
  const decoded = String(value || '');
  const parts = decoded.split(/[?&#;]/);
  if (parts.some(part => {
    const separator = part.indexOf('=');
    const name = separator === -1 ? part : part.slice(0, separator);
    return isSensitiveUrlName(name);
  })) return true;

  // Encoded nested values can decode to `outer=access_token=secret`
  // without introducing another query delimiter. Inspect every token that
  // immediately precedes an assignment, not only the outermost name.
  const assignments = /(?:^|[?&#;=])([^?&#;=]+)(?==)/g;
  return [...decoded.matchAll(assignments)].some(match => isSensitiveUrlName(match[1]));
}

function unsafeEncodedParameterPayload(value) {
  let decoded = String(value || '');
  if (!decoded) return false;
  for (let step = 0; step <= MAX_URL_NAME_DECODE_STEPS; step += 1) {
    if (containsSensitiveAssignment(decoded)) return true;
    if (step === MAX_URL_NAME_DECODE_STEPS) {
      // A payload still encoded after the bounded scan can hide another
      // delimiter/name layer. Output URLs are untrusted, so fail closed.
      return /%[0-9a-f]{2}/i.test(decoded);
    }
    let next;
    try {
      next = decodeURIComponent(decoded.replace(/\+/g, ' '));
    } catch {
      return true;
    }
    if (next === decoded) return false;
    decoded = next;
  }
  return false;
}

function hasSensitiveUrlParameters(url) {
  return unsafeEncodedParameterPayload(url.search.startsWith('?') ? url.search.slice(1) : url.search)
    || unsafeEncodedParameterPayload(url.hash.startsWith('#') ? url.hash.slice(1) : url.hash);
}

export function normalizeOutputUrl(value) {
  let url;
  try { url = new URL(value); } catch { return ''; }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return '';
  if (hasSensitiveUrlParameters(url)) return '';
  return url.toString();
}

function normalizeEvidenceItem(value) {
  if (typeof value === 'string') {
    const label = boundedString(value, MAX_LABEL_LENGTH);
    return label ? { kind: 'text', label } : null;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;

  if (typeof value.tool === 'string') {
    const label = boundedString(value.tool, MAX_LABEL_LENGTH);
    if (!label) return null;
    return {
      kind: 'tool',
      label,
      status: value.isError === true ? 'error' : 'completed',
    };
  }

  const kind = ALLOWED_KINDS.has(value.kind) ? value.kind : null;
  const label = boundedString(value.label, MAX_LABEL_LENGTH);
  if (!kind || !label) return null;
  const item = { kind, label };
  const ref = boundedString(value.ref, MAX_REF_LENGTH);
  if (ref) item.ref = ref;
  if (ALLOWED_STATUSES.has(value.status)) item.status = value.status;
  return item;
}

export function normalizeEvidence(value) {
  if (!Array.isArray(value)) return [];
  const result = [];
  for (const raw of value) {
    const item = normalizeEvidenceItem(raw);
    if (item) result.push(item);
    if (result.length >= MAX_ITEMS) break;
  }
  return result;
}

export function normalizeOutputs(value) {
  if (!Array.isArray(value)) return [];
  const result = [];
  const seen = new Set();
  for (const raw of value) {
    const item = normalizeEvidenceItem(raw);
    if (!item || !OUTPUT_KINDS.has(item.kind) || !item.ref) continue;
    if (item.kind === 'file') {
      const normalized = item.ref.replaceAll('\\', '/');
      if (normalized.includes('\u0000') || normalized.startsWith('/')
          || /^[A-Za-z]:\//.test(normalized)
          || normalized.split('/').includes('..')) continue;
      item.ref = normalized.replace(/^\.\//, '');
      if (!item.ref) continue;
    } else if (item.kind === 'link' || item.kind === 'pr') {
      item.ref = normalizeOutputUrl(item.ref);
      if (!item.ref) continue;
    }
    const key = `${item.kind}\u0000${item.ref}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
    if (result.length >= MAX_ITEMS) break;
  }
  return result;
}
