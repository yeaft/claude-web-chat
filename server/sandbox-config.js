/**
 * Sandbox execution is allowed only through a fully configured dedicated HTTPS Controller.
 * The current mixed-use Server Host is never an implicit execution target.
 * @param {object} config
 * @returns {boolean}
 */
export function validateSandboxDeploymentConfig(config) {
  if (!config?.enabled || !config.controllerUrl || !config.controllerToken
    || !config.operationSigningPrivateKey || !config.controllerResultPublicKey
    || !config.controllerHostId || !config.bootstrapSigningKey
    || !config.hostAttestationKey || !config.controllerAttestationFingerprint
    || !config.helperAttestationPublicKey || !config.imageDigest
    || !config.controllerClientCert || !config.controllerClientKey
    || !config.controllerCaCert
    || !Number.isSafeInteger(config.hostMemoryReserveMiB)
    || config.hostMemoryReserveMiB <= 0) return false;
  try {
    return new URL(config.controllerUrl).protocol === 'https:';
  } catch {
    return false;
  }
}
