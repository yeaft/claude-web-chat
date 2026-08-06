import { X509Certificate } from 'crypto';
import { request } from 'https';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const CA_PEM = `-----BEGIN CERTIFICATE-----
MIIBhDCCASugAwIBAgIUGWJQDhltNPaouClTc3jMZVb3EAowCgYIKoZIzj0EAwIw
GDEWMBQGA1UEAwwNWWVhZnQgVGVzdCBDQTAeFw0yNjA4MDYwNjEwMjRaFw0zNjA4
MDMwNjEwMjRaMBgxFjAUBgNVBAMMDVllYWZ0IFRlc3QgQ0EwWTATBgcqhkjOPQIB
BggqhkjOPQMBBwNCAAQoZKCQPdDCwqMO1nxljpu8ytFio7BbgW/cXDuBxtM7/Ypq
KxhrN5/u5iUZJFzHLdvVtede3Sv9SBiKGc7sd1oJo1MwUTAdBgNVHQ4EFgQUOJev
kczRNvL0ribbjMxvkafbaHAwHwYDVR0jBBgwFoAUOJevkczRNvL0ribbjMxvkafb
aHAwDwYDVR0TAQH/BAUwAwEB/zAKBggqhkjOPQQDAgNHADBEAiBOT4mXmpNLO4LZ
fYJ6565Z6GsRj1qTfAwhs4K3HQBPegIgYb6aZal1VWKlseGs3nbpHcnWA/7nDiLJ
OrN+fhq84u4=
-----END CERTIFICATE-----`;
const SERVER_PEM = `-----BEGIN CERTIFICATE-----
MIIBYTCCAQegAwIBAgIUYSxn4A5dfppDhmN8fCu/yjz5pXUwCgYIKoZIzj0EAwIw
GDEWMBQGA1UEAwwNWWVhZnQgVGVzdCBDQTAeFw0yNjA4MDYwNjEwMjRaFw0zNjA4
MDMwNjEwMjRaMBQxEjAQBgNVBAMMCWxvY2FsaG9zdDBZMBMGByqGSM49AgEGCCqG
SM49AwEHA0IABAjdK6dZ/0/DphL89DXRwuAo6Vm+hpNFLqLzLf3Vj8GnXVCTRsK+
iJhuDb1xPCP3NDQ10W9Jt/IChRjtwqNL7/2jMzAxMBoGA1UdEQQTMBGCCWxvY2Fs
aG9zdIcEfwAAATATBgNVHSUEDDAKBggrBgEFBQcDATAKBggqhkjOPQQDAgNIADBF
AiBexWgxgeZlG77s7csRUy2JEx4pH5Ogf7TB5aYRahkBsAIhAMB6nfrIIzLiQADL
EWvPDrRWktaSU4Y1aHsf3s2y5S45
-----END CERTIFICATE-----`;
const SERVER_KEY_PEM = `-----BEGIN EC PRIVATE KEY-----
MHcCAQEEICMhyGczgq9HsTzHvBttvH6QcWRDtMM9niY1NBMJ67HLoAoGCCqGSM49
AwEHoUQDQgAECN0rp1n/T8OmEvz0NdHC4CjpWb6Gk0UuovMt/dWPwaddUJNGwr6I
mG4NvXE8I/c0NDXRb0m38gKFGO3Co0vv/Q==
-----END EC PRIVATE KEY-----`;
const CLIENT_PEM = `-----BEGIN CERTIFICATE-----
MIIBQTCB6KADAgECAhRhLGfgDl1+mkOGY3x8K7/KPPmldjAKBggqhkjOPQQDAjAY
MRYwFAYDVQQDDA1ZZWFmdCBUZXN0IENBMB4XDTI2MDgwNjA2MTAyNFoXDTM2MDgw
MzA2MTAyNFowETEPMA0GA1UEAwwGY2xpZW50MFkwEwYHKoZIzj0CAQYIKoZIzj0D
AQcDQgAEZ/h5aql6eDstMYUFJ65qUCdD1uh3vTU8/ui2RcyuoPNb3F9rY3/0PlTG
LXm5TMDzQCgaS0erpV2aU1486kxGNaMXMBUwEwYDVR0lBAwwCgYIKwYBBQUHAwIw
CgYIKoZIzj0EAwIDSAAwRQIgJSaF6Oxr7qcJZnZKqxZWxITiojWIaY1nkoGx5LWg
6mUCIQDJtvsZ0kKYUhCRseHYofOgMBX/lPKuvUOuhIX+zR4Nxw==
-----END CERTIFICATE-----`;
const CLIENT_KEY_PEM = `-----BEGIN EC PRIVATE KEY-----
MHcCAQEEIFlWpGoHyNXszBqXRd9kP/QVDPaF8NGWzewvVgoVrMJcoAoGCCqGSM49
AwEHoUQDQgAEZ/h5aql6eDstMYUFJ65qUCdD1uh3vTU8/ui2RcyuoPNb3F9rY3/0
PlTGLXm5TMDzQCgaS0erpV2aU1486kxGNQ==
-----END EC PRIVATE KEY-----`;
const OTHER_PEM = `-----BEGIN CERTIFICATE-----
MIIBQDCB56ADAgECAhRhLGfgDl1+mkOGY3x8K7/KPPmldzAKBggqhkjOPQQDAjAY
MRYwFAYDVQQDDA1ZZWFmdCBUZXN0IENBMB4XDTI2MDgwNjA2MTAyNFoXDTM2MDgw
MzA2MTAyNFowEDEOMAwGA1UEAwwFb3RoZXIwWTATBgcqhkjOPQIBBggqhkjOPQMB
BwNCAASGuyLwaFzgPxc34rM6PTRY6g64g0Ikn4nCaQWP0JKPjMDLwKhHsTG0lAi+
ubCl7qSUfkEY9OQUsA2z6eCSA5sNoxcwFTATBgNVHSUEDDAKBggrBgEFBQcDAjAK
BggqhkjOPQQDAgNIADBFAiAJx4FDXJDbqSY7os1r5POlWUeVflzwkJVMfU7Vx9tD
QgIhAPJEpWQpw/ZWBRvcBemcgKfial0HNn/irZGap7qHKX+3
-----END CERTIFICATE-----`;
const OTHER_KEY_PEM = `-----BEGIN EC PRIVATE KEY-----
MHcCAQEEIHIRRpoVvVUk+oFp3zQ1VcYBj6d6nfbJswo3uKuQhu+RoAoGCCqGSM49
AwEHoUQDQgAEhrsi8Ghc4D8XN+KzOj00WOoOuINCJJ+JwmkFj9CSj4zAy8CoR7Ex
tJQIvrmwpe6klH5BGPTkFLANs+ngkgObDQ==
-----END EC PRIVATE KEY-----`;

const dataDir = mkdtempSync(join(tmpdir(), 'yeaft-attestation-listener-'));
process.env.SERVER_DATA_DIR = dataDir;

let createSandboxAttestationListener;
let closeSandboxAttestationListener;
let authenticateSandboxController;
let registerSandboxRoutes;
let listener;
let port;
let handler;

const fingerprint = new X509Certificate(CLIENT_PEM).fingerprint256;
const baseConfig = {
  enabled: true,
  hostAttestationServerCert: SERVER_PEM,
  hostAttestationServerKey: SERVER_KEY_PEM,
  hostAttestationClientCa: CA_PEM,
  hostAttestationBodyLimitBytes: 128,
  controllerAttestationFingerprint: fingerprint
};

function send(options = {}) {
  const {
    path = '/api/sandbox/hosts/attest', body = '{}'
  } = options;
  const cert = Object.hasOwn(options, 'cert') ? options.cert : CLIENT_PEM;
  const key = Object.hasOwn(options, 'key') ? options.key : CLIENT_KEY_PEM;
  return new Promise((resolve, reject) => {
    const requestOptions = {
      host: '127.0.0.1', port, path, method: 'POST', ca: CA_PEM,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }
    };
    if (cert) requestOptions.cert = cert;
    if (key) requestOptions.key = key;
    const req = request(requestOptions, res => {
      let responseBody = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { responseBody += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: responseBody }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

beforeAll(async () => {
  ({ createSandboxAttestationListener, closeSandboxAttestationListener }
    = await import('../../server/sandbox-attestation-listener.js'));
  ({ authenticateSandboxController, registerSandboxRoutes }
    = await import('../../server/routes/sandbox-routes.js'));
  handler = vi.fn((req, res, config) => {
    if (!authenticateSandboxController(req, config.controllerAttestationFingerprint)) {
      return res.status(401).json({ code: 'SANDBOX_CONTROLLER_IDENTITY_REJECTED' });
    }
    return res.status(202).json({ accepted: true });
  });
  listener = createSandboxAttestationListener({ config: baseConfig, handler });
  await new Promise((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', resolve);
  });
  port = listener.address().port;
});

afterAll(async () => {
  await closeSandboxAttestationListener(listener);
  const { default: db } = await import('../../server/db/connection.js');
  try { db.close(); } catch {}
  rmSync(dataDir, { recursive: true, force: true });
});

describe('sandbox Host attestation mTLS listener', () => {
  it('accepts the single route only with an authorized pinned client certificate', async () => {
    await expect(send()).resolves.toMatchObject({ status: 202 });
    expect(handler).toHaveBeenCalledOnce();
    expect(handler.mock.calls[0][0].socket.authorized).toBe(true);

    await expect(send({ path: '/api/version' })).resolves.toMatchObject({ status: 404 });
  });

  it('rejects a CA-authorized client whose leaf certificate is not pinned', async () => {
    await expect(send({ cert: OTHER_PEM, key: OTHER_KEY_PEM })).resolves.toMatchObject({
      status: 401,
      body: expect.stringContaining('SANDBOX_CONTROLLER_IDENTITY_REJECTED')
    });
  });

  it('rejects the TLS handshake when the client certificate is absent', async () => {
    await expect(send({ cert: null, key: null })).rejects.toThrow();
  });

  it('enforces the dedicated JSON body limit before invoking the handler', async () => {
    const callsBefore = handler.mock.calls.length;
    await expect(send({ body: JSON.stringify({ padding: 'x'.repeat(256) }) })).resolves.toMatchObject({
      status: 413,
      body: expect.stringContaining('SANDBOX_ATTESTATION_BODY_TOO_LARGE')
    });
    expect(handler).toHaveBeenCalledTimes(callsBefore);
  });

  it('does not register Host attestation on the public sandbox routes', () => {
    const paths = [];
    const app = {
      post(path) { paths.push(path); },
      put() {},
      get() {}
    };
    registerSandboxRoutes(app, { requireAuth() {}, requireAdmin() {} });
    expect(paths).not.toContain('/api/sandbox/hosts/attest');
  });
});
