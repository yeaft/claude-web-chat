const ALLOWED_KINDS = new Set(['text', 'tool', 'test', 'file', 'link', 'pr', 'commit']);
const OUTPUT_KINDS = new Set(['file', 'link', 'pr', 'commit']);
const ALLOWED_STATUSES = new Set(['completed', 'passed', 'failed', 'error', 'pending']);
const MAX_ITEMS = 50;
const MAX_LABEL_LENGTH = 500;
const MAX_REF_LENGTH = 1_000;
const MAX_URL_NAME_DECODE_STEPS = 3;
const URL_SCHEME_PATTERN = /^[A-Za-z][A-Za-z0-9+.-]*:/;
const COMMIT_HASH_PATTERN = /^[0-9a-f]{7,64}$/i;
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

function normalizeFileRef(value) {
  const normalized = boundedString(value, MAX_REF_LENGTH).replaceAll('\\', '/');
  if (!normalized || /[\u0000-\u001f\u007f]/.test(normalized)
      || normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized)
      || URL_SCHEME_PATTERN.test(normalized) || /%[0-9a-f]{2}/i.test(normalized)) return '';
  const relative = normalized.replace(/^\.\//, '');
  const parts = relative.split('/');
  if (!relative || parts.some(part => !part || part === '.' || part === '..')) return '';
  return relative;
}

function validFullGitRef(value) {
  const hasForbiddenCharacter = [...value].some(character => (
    character.charCodeAt(0) <= 0x20 || character.charCodeAt(0) === 0x7f
      || '~^:?*[\\'.includes(character)
  ));
  if (!value.startsWith('refs/') || value.endsWith('/') || value.endsWith('.')
      || value.includes('..') || value.includes('@{') || value.includes('//')
      || hasForbiddenCharacter) return false;
  const parts = value.split('/');
  return parts.length >= 3 && parts.every(part => (
    part && !part.startsWith('.') && !part.endsWith('.lock')
  ));
}

function normalizeCommitRef(value) {
  const ref = boundedString(value, MAX_REF_LENGTH);
  if (!ref || URL_SCHEME_PATTERN.test(ref) || /%[0-9a-f]{2}/i.test(ref)) return '';
  return COMMIT_HASH_PATTERN.test(ref) || validFullGitRef(ref) ? ref : '';
}

function normalizeRepositorySegment(value) {
  let decoded = String(value || '');
  if (!decoded || decoded.length > MAX_REF_LENGTH) return '';
  for (let step = 0; step < MAX_URL_NAME_DECODE_STEPS; step += 1) {
    let next;
    try {
      next = decodeURIComponent(decoded);
    } catch {
      return '';
    }
    if (next === decoded) break;
    decoded = next;
  }
  if (!decoded || decoded !== decoded.trim() || decoded === '.' || decoded === '..'
      || decoded.includes('%')
      || /[\u0000-\u001f\u007f/\\?#:@=&;{}\[\]"'<>]/.test(decoded)) return '';
  return decoded;
}

function normalizeRepositorySegments(values, minimum = 1) {
  if (!Array.isArray(values) || values.length < minimum) return null;
  const normalized = values.map(normalizeRepositorySegment);
  return normalized.every(Boolean) ? normalized : null;
}

function normalizePullRequestPath(pathname) {
  const withoutTrailingSlash = pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
  if (!withoutTrailingSlash.startsWith('/') || withoutTrailingSlash.includes('//')) return '';
  const segments = withoutTrailingSlash.slice(1).split('/');
  const requestId = segments.at(-1);
  if (!/^[1-9]\d*$/.test(requestId || '')) return '';
  const lower = segments.map(segment => segment.toLowerCase());

  if (segments.length === 4 && ['pull', 'pulls'].includes(lower[2])) {
    const repository = normalizeRepositorySegments(segments.slice(0, 2), 2);
    return repository ? `/${repository.join('/')}/${lower[2]}/${requestId}` : '';
  }

  if (segments.length >= 5 && segments.at(-3) === '-' && lower.at(-2) === 'merge_requests') {
    const repository = normalizeRepositorySegments(segments.slice(0, -3), 2);
    return repository ? `/${repository.join('/')}/-/merge_requests/${requestId}` : '';
  }

  if (segments.length === 4 && lower[2] === 'pull-requests') {
    const repository = normalizeRepositorySegments(segments.slice(0, 2), 2);
    return repository ? `/${repository.join('/')}/pull-requests/${requestId}` : '';
  }

  if (segments.length === 6 && ['projects', 'users'].includes(lower[0])
      && lower[2] === 'repos' && lower[4] === 'pull-requests') {
    const repository = normalizeRepositorySegments([segments[1], segments[3]], 2);
    return repository
      ? `/${lower[0]}/${repository[0]}/repos/${repository[1]}/pull-requests/${requestId}`
      : '';
  }

  const gitIndex = segments.length - 4;
  if (gitIndex >= 1 && lower[gitIndex] === '_git' && lower.at(-2) === 'pullrequest') {
    const repository = normalizeRepositorySegments([
      ...segments.slice(0, gitIndex),
      segments[gitIndex + 1],
    ], 2);
    if (!repository) return '';
    const prefix = repository.slice(0, -1);
    return `/${prefix.join('/')}/_git/${repository.at(-1)}/pullrequest/${requestId}`;
  }

  return '';
}

function normalizePullRequestUrl(value) {
  const ref = normalizeOutputUrl(value);
  if (!ref) return '';
  const url = new URL(ref);
  if (url.search || url.hash) return '';
  const pathname = normalizePullRequestPath(url.pathname);
  if (!pathname) return '';
  url.search = '';
  url.hash = '';
  url.pathname = pathname;
  return url.toString();
}

function normalizeTypedOutputRef(kind, value) {
  if (kind === 'file') return normalizeFileRef(value);
  if (kind === 'link') return normalizeOutputUrl(value);
  if (kind === 'pr') return normalizePullRequestUrl(value);
  if (kind === 'commit') return normalizeCommitRef(value);
  return '';
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
    item.ref = normalizeTypedOutputRef(item.kind, item.ref);
    if (!item.ref) continue;
    const key = `${item.kind}\u0000${item.ref}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
    if (result.length >= MAX_ITEMS) break;
  }
  return result;
}
