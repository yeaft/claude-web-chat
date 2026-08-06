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
    || !config.hostAttestationListenerHost
    || !Number.isSafeInteger(config.hostAttestationListenerPort)
    || config.hostAttestationListenerPort <= 0
    || config.hostAttestationListenerPort > 65_535
    || !config.hostAttestationServerCert || !config.hostAttestationServerKey
    || !config.hostAttestationClientCa
    || !Number.isSafeInteger(config.hostAttestationBodyLimitBytes)
    || config.hostAttestationBodyLimitBytes <= 0
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
