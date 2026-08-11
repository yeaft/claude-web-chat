import { sanitizeDiagnosticText } from './debug-projection.js';

const MAX_FAILURE_INSPECTION_LENGTH = 16_000;
const MAX_MODEL_FAILURE_DIAGNOSTIC_BYTES = 2_000;
const SAFE_FAILURE_FALLBACK = 'The Action failed. Sensitive details were omitted.';
const PROVIDER_TOKEN_PATTERN = /\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{12,}|github_pat_[A-Za-z0-9_]{12,}|gh[pousr]_[A-Za-z0-9_]{12,}|xox[baprs]-[A-Za-z0-9-]{12,}|AKIA[A-Z0-9]{12,})\b/i;
const HIGH_ENTROPY_SECRET_PATTERN = /\b(?=[A-Za-z0-9_./+=-]{32,}\b)(?=[A-Za-z0-9_./+=-]*[A-Za-z])(?=[A-Za-z0-9_./+=-]*\d)[A-Za-z0-9_./+=-]+\b/;
const LOCAL_PATH_ASSIGNMENT_PATTERN = /\b(?:path|cwd|file|filename|directory)\s*[:=]\s*(?:\/(?!\/)|[A-Za-z]:\\|\\\\)/i;
const POSIX_ABSOLUTE_PATH_PATTERN = /(?:^|[\s("'`])\/(?!\/)[^\r\n]*/m;
const WINDOWS_ABSOLUTE_PATH_PATTERN = /(?:^|[\s("'`])(?:[A-Za-z]:\\|\\\\)[^\r\n]*/m;

function containsUnsafeFailureText(value) {
  return PROVIDER_TOKEN_PATTERN.test(value)
    || HIGH_ENTROPY_SECRET_PATTERN.test(value)
    || LOCAL_PATH_ASSIGNMENT_PATTERN.test(value)
    || POSIX_ABSOLUTE_PATH_PATTERN.test(value)
    || WINDOWS_ABSOLUTE_PATH_PATTERN.test(value);
}

/** Project a persisted Run error into bounded, model-safe Action context. */
export function sanitizeModelFailureDiagnostic(value) {
  const raw = typeof value === 'string'
    ? value.trim().slice(0, MAX_FAILURE_INSPECTION_LENGTH)
    : '';
  if (!raw) return null;
  if (containsUnsafeFailureText(raw)) return SAFE_FAILURE_FALLBACK;
  return sanitizeDiagnosticText(raw, MAX_MODEL_FAILURE_DIAGNOSTIC_BYTES) || null;
}
