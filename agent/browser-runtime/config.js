const MIB = 1024 * 1024;

export const BROWSER_RUNTIME_DEFAULTS = Object.freeze({
  enabled: false,
  executablePath: null,
  cacheDir: null,
  headless: true,
  maxSessions: 2,
  maxPeersPerSession: 2,
  maxWidth: 1920,
  maxHeight: 1080,
  maxFps: 30,
  maxBitrate: 4_000_000,
  maxQueuedActionsPerSession: 128,
  maxQueuedActionsPerProducer: 32,
  maxActionQueueBytes: MIB,
  maxActionRuntimeMs: 30_000,
  producerCreditBurst: 16,
  producerCreditRefillPerSecond: 8,
  noViewerIdleMs: 120_000,
  interactiveIdleMs: 2_100_000,
  maxDownloadsBytes: 512 * MIB,
  startupProbeTimeoutMs: 20_000,
});

const INTEGER_LIMITS = Object.freeze({
  maxSessions: [1, 4],
  maxPeersPerSession: [1, 4],
  maxWidth: [320, 3840],
  maxHeight: [240, 2160],
  maxFps: [1, 60],
  maxBitrate: [100_000, 8_000_000],
  maxQueuedActionsPerSession: [1, 256],
  maxQueuedActionsPerProducer: [1, 64],
  maxActionQueueBytes: [64 * 1024, 4 * MIB],
  maxActionRuntimeMs: [1_000, 120_000],
  producerCreditBurst: [1, 64],
  producerCreditRefillPerSecond: [1, 64],
  noViewerIdleMs: [10_000, 30 * 60_000],
  interactiveIdleMs: [60_000, 8 * 60 * 60_000],
  maxDownloadsBytes: [0, 2 * 1024 * MIB],
  startupProbeTimeoutMs: [5_000, 60_000],
});

export const BROWSER_RUNTIME_SETTING_KEYS = Object.freeze([
  'enabled',
  'executablePath',
  'cacheDir',
  'headless',
  ...Object.keys(INTEGER_LIMITS),
]);

function normalizeOptionalPath(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function clampInteger(value, fallback, [minimum, maximum]) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.floor(number)));
}

/**
 * Normalize the Agent-owned Browser Runtime configuration. Unknown keys are
 * dropped and every resource knob is clamped to a hard ceiling. The feature is
 * disabled unless the persisted value is the literal boolean `true`.
 *
 * @param {unknown} raw
 * @returns {typeof BROWSER_RUNTIME_DEFAULTS}
 */
export function normaliseBrowserRuntimeSection(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw)
    ? /** @type {Record<string, unknown>} */ (raw)
    : {};
  const result = {
    ...BROWSER_RUNTIME_DEFAULTS,
    enabled: source.enabled === true,
    executablePath: normalizeOptionalPath(source.executablePath),
    cacheDir: normalizeOptionalPath(source.cacheDir),
    headless: source.headless !== false,
  };
  for (const [key, limits] of Object.entries(INTEGER_LIMITS)) {
    result[key] = clampInteger(source[key], BROWSER_RUNTIME_DEFAULTS[key], limits);
  }
  return result;
}

/**
 * Validate a partial write without silently turning a typo into a different
 * resource policy. Reads clamp hand-edited values; public writes reject them.
 *
 * @param {unknown} update
 * @returns {string|null}
 */
export function validateBrowserRuntimeUpdate(update) {
  if (!update || typeof update !== 'object' || Array.isArray(update)) return 'update payload required';
  const value = /** @type {Record<string, unknown>} */ (update);
  const unknown = Object.keys(value).find(key => !BROWSER_RUNTIME_SETTING_KEYS.includes(key));
  if (unknown) return `unknown browser runtime setting: ${unknown}`;
  for (const key of ['enabled', 'headless']) {
    if (key in value && typeof value[key] !== 'boolean') return `${key} must be a boolean`;
  }
  for (const key of ['executablePath', 'cacheDir']) {
    if (key in value && value[key] !== null && typeof value[key] !== 'string') {
      return `${key} must be a string or null`;
    }
  }
  for (const [key, [minimum, maximum]] of Object.entries(INTEGER_LIMITS)) {
    if (!(key in value)) continue;
    const number = Number(value[key]);
    if (!Number.isInteger(number) || number < minimum || number > maximum) {
      return `${key} must be an integer between ${minimum} and ${maximum}`;
    }
  }
  return null;
}
