import express from 'express';
import { createServer } from 'https';
import { CONFIG } from './config.js';
import { handleSandboxHostAttestation } from './routes/sandbox-routes.js';

export const SANDBOX_HOST_ATTESTATION_PATH = '/api/sandbox/hosts/attest';

function jsonErrorHandler(err, req, res, next) {
  if (!err) return next();
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ code: 'SANDBOX_ATTESTATION_BODY_TOO_LARGE' });
  }
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    return res.status(400).json({ code: 'SANDBOX_ATTESTATION_BODY_INVALID' });
  }
  return next(err);
}

/**
 * Create the dedicated HTTPS server used only for Controller Host attestation.
 * TLS chain authorization occurs before Express, while the route also pins the
 * leaf certificate fingerprint before accepting the signed payload.
 *
 * @param {{ config?: object, handler?: Function }} options
 * @returns {import('https').Server}
 */
export function createSandboxAttestationListener({
  config = CONFIG.sandbox,
  handler = handleSandboxHostAttestation
} = {}) {
  const app = express();
  app.disable('x-powered-by');

  app.post(
    SANDBOX_HOST_ATTESTATION_PATH,
    express.json({ limit: config.hostAttestationBodyLimitBytes, strict: true }),
    (req, res) => handler(req, res, config)
  );
  app.use(jsonErrorHandler);

  return createServer({
    cert: config.hostAttestationServerCert,
    key: config.hostAttestationServerKey,
    ca: config.hostAttestationClientCa,
    requestCert: true,
    rejectUnauthorized: true,
    minVersion: 'TLSv1.2'
  }, app);
}

/**
 * Start the attestation listener when Managed Sandbox is enabled.
 * @param {{ config?: object, handler?: Function }} options
 * @returns {Promise<import('https').Server|null>}
 */
export async function startSandboxAttestationListener({
  config = CONFIG.sandbox,
  handler = handleSandboxHostAttestation
} = {}) {
  if (!config.enabled) return null;
  const listener = createSandboxAttestationListener({ config, handler });
  await new Promise((resolve, reject) => {
    const onError = (err) => {
      listener.off('listening', onListening);
      reject(err);
    };
    const onListening = () => {
      listener.off('error', onError);
      resolve();
    };
    listener.once('error', onError);
    listener.once('listening', onListening);
    listener.listen(config.hostAttestationListenerPort, config.hostAttestationListenerHost);
  });
  return listener;
}

export async function closeSandboxAttestationListener(listener) {
  if (!listener?.listening) return;
  await new Promise((resolve, reject) => {
    listener.close(err => err ? reject(err) : resolve());
  });
}
