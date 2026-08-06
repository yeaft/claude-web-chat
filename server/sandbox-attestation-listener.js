import express from 'express';
import { createServer } from 'https';
import { CONFIG } from './config.js';
import {
  authenticateSandboxController,
  handleSandboxHostAttestation
} from './routes/sandbox-routes.js';

export const SANDBOX_HOST_ATTESTATION_PATH = '/api/sandbox/hosts/attest';

function authenticatePeer(req, res, next, config) {
  if (!authenticateSandboxController(req, config.controllerAttestationFingerprint)) {
    return res.status(401).json({ code: 'SANDBOX_CONTROLLER_IDENTITY_REJECTED' });
  }
  return next();
}

function parseStrictJson(req, res, next) {
  try {
    const body = JSON.parse(req.body.toString('utf8'));
    if (!body || typeof body !== 'object') {
      return res.status(400).json({ code: 'SANDBOX_ATTESTATION_BODY_INVALID' });
    }
    req.body = body;
    return next();
  } catch {
    return res.status(400).json({ code: 'SANDBOX_ATTESTATION_BODY_INVALID' });
  }
}

function bodyErrorHandler(err, req, res, next) {
  if (!err) return next();
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ code: 'SANDBOX_ATTESTATION_BODY_TOO_LARGE' });
  }
  return next(err);
}

/**
 * Create the dedicated HTTPS server used only for Controller Host attestation.
 * TLS chain authorization occurs before Express, while the route also pins the
 * leaf certificate fingerprint before consuming the signed payload.
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
    (req, res, next) => authenticatePeer(req, res, next, config),
    express.raw({ limit: config.hostAttestationBodyLimitBytes, type: () => true }),
    parseStrictJson,
    (req, res) => handler(req, res, config)
  );
  app.use(bodyErrorHandler);

  const listener = createServer({
    cert: config.hostAttestationServerCert,
    key: config.hostAttestationServerKey,
    ca: config.hostAttestationClientCa,
    requestCert: true,
    rejectUnauthorized: true,
    minVersion: 'TLSv1.2'
  }, app);
  const sockets = new Set();
  listener.on('connection', socket => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  listener.sandboxAttestationSockets = sockets;
  listener.sandboxAttestationShutdownTimeoutMs = config.hostAttestationShutdownTimeoutMs;
  return listener;
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
  if (!listener) return;
  const sockets = listener.sandboxAttestationSockets || new Set();
  const timeoutMs = listener.sandboxAttestationShutdownTimeoutMs || 1_000;
  await new Promise((resolve, reject) => {
    let settled = false;
    const finish = err => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err && err.code !== 'ERR_SERVER_NOT_RUNNING') reject(err);
      else resolve();
    };
    const timer = setTimeout(() => {
      for (const socket of sockets) socket.destroy();
    }, timeoutMs);
    timer.unref?.();
    listener.close(finish);
    listener.closeIdleConnections?.();
  });
}
