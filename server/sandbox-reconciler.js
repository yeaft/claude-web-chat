import { randomUUID, sign, verify } from 'crypto';
import { request as httpsRequest } from 'https';
import { sandboxDb } from './database.js';
import { isSandboxAgentReady } from './sandbox-agent-auth.js';
import { validateSandboxDeploymentConfig } from './sandbox-config.js';

function canonicalEnvelope(envelope) {
  return JSON.stringify({
    protocolVersion: envelope.protocolVersion,
    operationId: envelope.operationId,
    hostId: envelope.hostId,
    sandboxId: envelope.sandboxId,
    action: envelope.action,
    generation: envelope.generation,
    hostEpoch: envelope.hostEpoch,
    instanceId: envelope.instanceId,
    imageDigest: envelope.imageDigest,
    desiredState: envelope.desiredState,
    issuedAt: envelope.issuedAt,
    expiresAt: envelope.expiresAt,
    nonce: envelope.nonce,
    bootstrap: envelope.bootstrap || null,
    resources: envelope.resources
  });
}

function signEnvelope(envelope, privateKey) {
  return sign(null, Buffer.from(canonicalEnvelope(envelope)), privateKey).toString('base64url');
}

function canonicalHelperAttestation(attestation) {
  return JSON.stringify({
    protocolVersion: attestation.protocolVersion,
    operationId: attestation.operationId,
    sandboxId: attestation.sandboxId,
    action: attestation.action,
    generation: attestation.generation,
    hostEpoch: attestation.hostEpoch,
    requestNonce: attestation.requestNonce,
    issuedAt: attestation.issuedAt,
    imageDigest: attestation.imageDigest || null,
    readinessProof: attestation.readinessProof || null,
    absenceProof: attestation.absenceProof || null,
    resourceInspection: attestation.resourceInspection || null
  });
}

function canonicalControllerResult(result) {
  return JSON.stringify({
    operationId: result.operationId,
    generation: result.generation,
    hostEpoch: result.hostEpoch,
    requestNonce: result.requestNonce,
    issuedAt: result.issuedAt,
    success: result.success,
    imageDigest: result.imageDigest || null,
    helperAttestation: result.helperAttestation || null,
    errorCode: result.errorCode || null
  });
}

function verifyHelperAttestation(result, operation, config, now) {
  const attestation = result.helperAttestation;
  if (!attestation || attestation.protocolVersion !== 1
    || attestation.operationId !== operation.id
    || attestation.sandboxId !== operation.sandbox_id
    || attestation.action !== operation.kind
    || attestation.generation !== operation.generation
    || attestation.hostEpoch !== operation.host_epoch
    || attestation.requestNonce !== operation.requestNonce
    || !Number.isFinite(attestation.issuedAt)
    || Math.abs(now - attestation.issuedAt) > (config.controllerProtocolMaxSkewMs || 30_000)) {
    throw new Error('Controller returned a mismatched Helper attestation');
  }
  let signatureValid = false;
  try {
    signatureValid = verify(
      null,
      Buffer.from(canonicalHelperAttestation(attestation)),
      config.helperAttestationPublicKey,
      Buffer.from(String(attestation.signature || ''), 'base64url')
    );
  } catch {
    signatureValid = false;
  }
  if (!signatureValid) throw new Error('Controller returned an invalid Helper attestation signature');
  return attestation;
}

function verifyResourceInspection(attestation, operation) {
  if (operation.kind === 'remove') return;
  const inspection = attestation.resourceInspection;
  const expected = {
    cpuMillis: operation.cpu_millis,
    memoryMiB: operation.memory_mib,
    diskGiB: operation.disk_gib
  };
  if (!inspection
    || inspection.cpuMillis !== expected.cpuMillis
    || inspection.memoryMiB !== expected.memoryMiB
    || inspection.diskGiB !== expected.diskGiB
    || !Number.isInteger(inspection.pidsLimit) || inspection.pidsLimit <= 0
    || !Number.isInteger(inspection.ioWeight) || inspection.ioWeight <= 0
    || inspection.quotaHard !== true
    || inspection.networkPolicy !== 'public-egress-isolated') {
    throw new Error('Helper attestation does not prove the requested Sandbox resource policy');
  }
}

function verifyControllerResult(result, operation, config, now = Date.now()) {
  if (result.operationId !== operation.id
    || result.generation !== operation.generation
    || result.hostEpoch !== operation.host_epoch
    || result.requestNonce !== operation.requestNonce) {
    throw new Error('Controller returned a mismatched operation result');
  }
  if (!Number.isFinite(result.issuedAt)
    || Math.abs(now - result.issuedAt) > (config.controllerProtocolMaxSkewMs || 30_000)) {
    throw new Error('Controller returned a stale operation result');
  }
  let signatureValid = false;
  try {
    signatureValid = verify(
      null,
      Buffer.from(canonicalControllerResult(result)),
      config.controllerResultPublicKey,
      Buffer.from(String(result.signature || ''), 'base64url')
    );
  } catch {
    signatureValid = false;
  }
  if (!signatureValid) throw new Error('Controller returned an invalid operation result signature');
  const attestation = verifyHelperAttestation(result, operation, config, now);
  verifyResourceInspection(attestation, operation);
  return attestation;
}

export function validateControllerConfig(config) {
  return validateSandboxDeploymentConfig(config);
}

function requestController(url, options) {
  return new Promise((resolve, reject) => {
    const request = httpsRequest(url, {
      method: 'POST',
      headers: options.headers,
      cert: options.cert,
      key: options.key,
      ca: options.ca,
      rejectUnauthorized: true,
      timeout: options.timeout
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({
        ok: response.statusCode >= 200 && response.statusCode < 300,
        status: response.statusCode,
        json: async () => JSON.parse(Buffer.concat(chunks).toString('utf8'))
      }));
    });
    request.on('timeout', () => request.destroy(new Error('Controller request timed out')));
    request.on('error', reject);
    request.end(options.body);
  });
}

export function createSandboxReconciler({
  config,
  store = sandboxDb,
  fetchImpl = requestController,
  logger = console
}) {
  let running = false;

  async function dispatch(operation) {
    if (operation.host_id !== config.controllerHostId) return;
    const issuedAt = Date.now();
    const envelope = {
      protocolVersion: 1,
      operationId: operation.id,
      hostId: operation.host_id,
      sandboxId: operation.sandbox_id,
      action: operation.kind,
      generation: operation.generation,
      hostEpoch: operation.host_epoch,
      instanceId: operation.instance_id,
      imageDigest: operation.image_digest,
      desiredState: operation.desired_state,
      issuedAt,
      expiresAt: issuedAt + (config.controllerRequestTimeoutMs || 10_000),
      nonce: randomUUID(),
      ...(['create', 'start', 'retry'].includes(operation.kind)
        ? { bootstrap: store.issueBootstrap(
          operation.id,
          config.bootstrapTtlMs,
          config.bootstrapSigningKey
        ) }
        : {}),
      resources: {
        cpuMillis: operation.cpu_millis,
        memoryMiB: operation.memory_mib,
        diskGiB: operation.disk_gib
      }
    };
    const response = await fetchImpl(new URL('/v1/operations', config.controllerUrl), {
      method: 'POST',
      headers: {
        authorization: `Bearer ${config.controllerToken}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({ ...envelope, signature: signEnvelope(envelope, config.operationSigningPrivateKey) }),
      cert: config.controllerClientCert,
      key: config.controllerClientKey,
      ca: config.controllerCaCert,
      timeout: config.controllerRequestTimeoutMs || 10_000
    });
    if (!response.ok) throw new Error(`Controller returned HTTP ${response.status}`);
    const result = await response.json();
    const helperAttestation = verifyControllerResult(
      result,
      { ...operation, requestNonce: envelope.nonce },
      config
    );
    store.applyControllerResult({
      ...result,
      imageDigest: helperAttestation.imageDigest,
      readinessProof: helperAttestation.readinessProof,
      absenceProof: helperAttestation.absenceProof,
      resourceInspection: helperAttestation.resourceInspection
    }, config, { isAgentReady: isSandboxAgentReady });
  }

  async function tick(now = Date.now()) {
    if (running || !config?.enabled) return;
    running = true;
    try {
      store.reconcileRuntimeState?.(now, config, { isAgentReady: isSandboxAgentReady });
      const operations = store.listPendingOperations(now);
      if (!validateControllerConfig(config)) return;
      await Promise.all(operations.map(operation => dispatch(operation).catch(error => {
        logger.warn(`[Sandbox] Controller dispatch failed for ${operation.id}: ${error.message}`);
      })));
    } finally {
      running = false;
    }
  }

  function start() {
    if (!config?.enabled) return null;
    const timer = setInterval(() => void tick(), config.reconcileIntervalMs || 5_000);
    timer.unref?.();
    void tick();
    return timer;
  }

  return { start, tick };
}
