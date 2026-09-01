/**
 * Work Center is opt-in. Only the explicit string "true" enables the feature;
 * missing, malformed, and legacy configurations remain disabled.
 *
 * @param {NodeJS.ProcessEnv|Record<string, string|undefined>} [env]
 * @returns {boolean}
 */
export function isWorkCenterEnabled(env = process.env) {
  return env?.YEAFT_WORK_CENTER_ENABLED === 'true';
}
