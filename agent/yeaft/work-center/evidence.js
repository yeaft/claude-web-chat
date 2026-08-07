const ALLOWED_KINDS = new Set(['text', 'tool', 'test', 'file', 'link', 'pr', 'commit']);
const OUTPUT_KINDS = new Set(['file', 'link', 'pr', 'commit']);
const ALLOWED_STATUSES = new Set(['completed', 'passed', 'failed', 'error', 'pending']);
const MAX_ITEMS = 50;
const MAX_LABEL_LENGTH = 500;
const MAX_REF_LENGTH = 1_000;

function boundedString(value, maxLength) {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, maxLength);
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
    const key = `${item.kind}\u0000${item.ref}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
    if (result.length >= MAX_ITEMS) break;
  }
  return result;
}
