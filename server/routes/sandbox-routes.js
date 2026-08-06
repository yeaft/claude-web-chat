import { timingSafeEqual } from 'crypto';
import { CONFIG } from '../config.js';
import { sandboxDb, userDb } from '../database.js';
import { SandboxConflictError } from '../db/sandbox-db.js';
import {
  registerSandboxHostAttestation,
  SandboxHostAttestationError
} from '../sandbox-host-attestation.js';

function loadUser(req) {
  let user = userDb.getByUsername(req.user.username);
  if (!user && CONFIG.skipAuth) user = userDb.getOrCreate(req.user.username, req.user.username);
  return user;
}

function sendError(res, err) {
  if (err instanceof SandboxConflictError) {
    return res.status(409).json({ code: err.code });
  }
  console.error('Sandbox API error:', err);
  return res.status(500).json({ code: 'SANDBOX_INTERNAL_ERROR' });
}

function normalizedFingerprint(value) {
  return String(value || '').replaceAll(':', '').trim().toLowerCase();
}

export function authenticateSandboxController(request, expectedFingerprint) {
  if (!request?.socket?.authorized) return false;
  const expected = Buffer.from(normalizedFingerprint(expectedFingerprint));
  const certificate = request.socket.getPeerCertificate?.();
  const actual = Buffer.from(normalizedFingerprint(certificate?.fingerprint256));
  return expected.length > 0 && expected.length === actual.length
    && timingSafeEqual(expected, actual);
}

export function handleSandboxHostAttestation(req, res, config = CONFIG.sandbox) {
  if (!authenticateSandboxController(req, config.controllerAttestationFingerprint)) {
    return res.status(401).json({ code: 'SANDBOX_CONTROLLER_IDENTITY_REJECTED' });
  }
  try {
    registerSandboxHostAttestation(req.body, config);
    return res.status(202).json({ accepted: true });
  } catch (err) {
    if (err instanceof SandboxHostAttestationError) {
      return res.status(401).json({ code: 'SANDBOX_HOST_ATTESTATION_REJECTED' });
    }
    return sendError(res, err);
  }
}

export function registerSandboxRoutes(app, { requireAuth, requireAdmin }) {
  // The managed runtime has no user Agent secret. Its one-time bootstrap token
  // is itself the scoped authorization for obtaining a revocable credential.
  app.post('/api/sandbox/bootstrap/exchange', (req, res) => {
    try {
      const result = sandboxDb.exchangeBootstrap(req.body?.token, req.body?.claims);
      return res.json(result);
    } catch (err) {
      if (err instanceof SandboxConflictError) {
        return res.status(401).json({ code: 'SANDBOX_BOOTSTRAP_INVALID' });
      }
      return sendError(res, err);
    }
  });

  app.put('/api/admin/sandbox/entitlements/:userId', requireAuth, requireAdmin, (req, res) => {
    try {
      const entitlement = sandboxDb.setEntitlement(
        req.params.userId,
        req.body?.enabled,
        req.user?.username
      );
      return res.json({ entitlement });
    } catch (err) {
      if (err instanceof SandboxConflictError && err.code === 'SANDBOX_USER_NOT_FOUND') {
        return res.status(404).json({ code: err.code });
      }
      return sendError(res, err);
    }
  });

  app.get('/api/sandbox/capability', requireAuth, (req, res) => {
    const user = loadUser(req);
    if (!user) return res.status(404).json({ code: 'USER_NOT_FOUND' });
    res.json(sandboxDb.capability(user.id, CONFIG.sandbox));
  });

  app.get('/api/sandbox', requireAuth, (req, res) => {
    const user = loadUser(req);
    if (!user) return res.status(404).json({ code: 'USER_NOT_FOUND' });
    res.json({ sandbox: sandboxDb.snapshot(user.id) });
  });

  app.post('/api/sandbox', requireAuth, (req, res) => {
    const user = loadUser(req);
    if (!user) return res.status(404).json({ code: 'USER_NOT_FOUND' });
    try {
      const result = sandboxDb.create(user.id, {
        agentName: req.body?.agentName,
        sizeId: req.body?.sizeId,
        idempotencyKey: req.get('Idempotency-Key')
      }, CONFIG.sandbox);
      return res.status(result.replayed ? 200 : 202).json(result);
    } catch (err) {
      return sendError(res, err);
    }
  });

  for (const action of ['start', 'stop', 'retry', 'remove']) {
    app.post(`/api/sandbox/${action}`, requireAuth, (req, res) => {
      const user = loadUser(req);
      if (!user) return res.status(404).json({ code: 'USER_NOT_FOUND' });
      try {
        const result = sandboxDb.requestAction(
          user.id, action, req.get('Idempotency-Key'), CONFIG.sandbox
        );
        return res.status(result.replayed ? 200 : 202).json(result);
      } catch (err) {
        return sendError(res, err);
      }
    });
  }
}
