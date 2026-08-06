import { createServer as createHttpsServer } from 'node:https';
import { sign, timingSafeEqual } from 'node:crypto';

const MAX_REQUEST_BYTES = 64 * 1024;

function canonicalControllerResult(result) {
  return JSON.stringify({
    operationId: result.operationId,
    action: result.action,
    hostId: result.hostId,
    sandboxId: result.sandboxId,
    requestDigest: result.requestDigest,
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

function tokenMatches(header, expectedToken) {
  const prefix = 'Bearer ';
  if (typeof header !== 'string' || !header.startsWith(prefix)) return false;
  const actual = Buffer.from(header.slice(prefix.length));
  const expected = Buffer.from(expectedToken);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function writeJson(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

/**
 * Dedicated-Host Controller boundary. Privileged work remains exclusively in
 * the Helper; the Controller only authenticates Server requests and signs the
 * Helper's durable result for transport back to the control plane.
 */
export function createSandboxController({ config, helper, now = Date.now, createServer = createHttpsServer }) {
  if (!config?.hostId || !config.token || !config.tlsCert || !config.tlsKey || !config.clientCa
    || !config.resultSigningPrivateKey || !helper?.execute) {
    throw new Error('Sandbox Controller requires complete dedicated Host configuration');
  }

  async function execute(operation) {
    if (!operation || operation.hostId !== config.hostId) {
      throw new Error('Sandbox Controller rejected an operation for another Host');
    }
    const helperResult = await helper.execute(operation);
    const result = {
      operationId: operation.operationId,
      action: operation.action,
      hostId: operation.hostId,
      sandboxId: operation.sandboxId || null,
      requestDigest: operation.requestDigest,
      generation: operation.generation || null,
      hostEpoch: operation.hostEpoch,
      requestNonce: operation.nonce,
      issuedAt: now(),
      success: helperResult.success === true,
      imageDigest: helperResult.helperAttestation?.imageDigest || null,
      helperAttestation: helperResult.helperAttestation || null,
      errorCode: helperResult.errorCode || null
    };
    result.signature = sign(
      null,
      Buffer.from(canonicalControllerResult(result)),
      config.resultSigningPrivateKey
    ).toString('base64url');
    return result;
  }

  const server = createServer({
    cert: config.tlsCert,
    key: config.tlsKey,
    ca: config.clientCa,
    requestCert: true,
    rejectUnauthorized: true
  }, (request, response) => {
    if (request.method !== 'POST' || request.url !== '/v1/operations') {
      writeJson(response, 404, { code: 'NOT_FOUND' });
      return;
    }
    if (!request.socket.authorized || !tokenMatches(request.headers.authorization, config.token)) {
      writeJson(response, 401, { code: 'UNAUTHORIZED' });
      request.resume();
      return;
    }

    const chunks = [];
    let size = 0;
    request.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_REQUEST_BYTES) request.destroy();
      else chunks.push(chunk);
    });
    request.on('end', async () => {
      if (size > MAX_REQUEST_BYTES) return;
      try {
        const operation = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        writeJson(response, 200, await execute(operation));
      } catch {
        writeJson(response, 400, { code: 'SANDBOX_OPERATION_REJECTED' });
      }
    });
  });

  return {
    execute,
    listen: (...args) => server.listen(...args),
    close: () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  };
}

export { canonicalControllerResult };
