import { readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { setManagedSandboxIdentity } from './identity-store.js';

function assertIdentity(value) {
  const claims = value?.claims;
  if (!value?.serverUrl || !claims?.sandboxId || !claims?.instanceId
    || !Number.isInteger(claims.generation) || !claims.imageDigest) {
    throw new Error('Managed Sandbox Agent rejected an invalid identity');
  }
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

async function persistCredential(path, identity) {
  const temporary = join(dirname(path), `.managed-agent-credential-${process.pid}.tmp`);
  await writeFile(temporary, JSON.stringify(identity), { mode: 0o600 });
  await rename(temporary, path);
}

function exchangeUrl(serverUrl) {
  const url = new URL(serverUrl);
  if (url.protocol === 'wss:') url.protocol = 'https:';
  else if (url.protocol === 'ws:') url.protocol = 'http:';
  url.pathname = '/api/sandbox/bootstrap/exchange';
  url.search = '';
  return url;
}

export async function loadManagedSandboxIdentity({ bootstrapFile, credentialFile, fetchImpl = fetch }) {
  try {
    const saved = await readJson(credentialFile);
    assertIdentity(saved);
    if (!saved.credentialId || !saved.secret) throw new Error('Managed Sandbox Agent credential is incomplete');
    return saved;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  const bootstrap = await readJson(bootstrapFile);
  assertIdentity(bootstrap);
  if (!bootstrap.token) throw new Error('Managed Sandbox Agent bootstrap token is missing');
  const response = await fetchImpl(exchangeUrl(bootstrap.serverUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: bootstrap.token, claims: bootstrap.claims })
  });
  if (!response.ok) throw new Error(`Managed Sandbox Agent bootstrap exchange failed (${response.status})`);
  const credential = await response.json();
  const identity = { ...bootstrap, token: undefined, ...credential };
  if (!identity.credentialId || !identity.secret) throw new Error('Managed Sandbox Agent bootstrap returned no credential');
  await persistCredential(credentialFile, identity);
  await unlink(bootstrapFile);
  return identity;
}

export async function runManagedSandboxAgent(args, options = {}) {
  const bootstrapIndex = args.indexOf('--bootstrap-file');
  if (bootstrapIndex < 0 || !args[bootstrapIndex + 1]) {
    throw new Error('managed-sandbox requires --bootstrap-file');
  }
  const bootstrapFile = args[bootstrapIndex + 1];
  const credentialFile = options.credentialFile || '/home/yeaft/.yeaft/managed-agent-credential';
  const identity = await loadManagedSandboxIdentity({ bootstrapFile, credentialFile, fetchImpl: options.fetchImpl });
  setManagedSandboxIdentity(identity);
  process.env.SERVER_URL = identity.serverUrl;
  process.env.AGENT_NAME = identity.claims.sandboxId;
  process.env.YEAFT_AGENT_INSTANCE = identity.claims.instanceId;
  process.env.WORK_DIR = '/workspace';
  await (options.startAgent || (() => import('../index.js')))();
}
