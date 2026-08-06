import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadManagedSandboxIdentity, runManagedSandboxAgent } from '../../agent/managed-sandbox/agent-runtime.js';
import { getManagedSandboxIdentity, setManagedSandboxIdentity } from '../../agent/managed-sandbox/identity-store.js';

const roots = [];
const originalEnv = { ...process.env };

function files() {
  const root = mkdtempSync(join(tmpdir(), 'yeaft-managed-agent-'));
  roots.push(root);
  return {
    bootstrapFile: join(root, 'bootstrap.json'),
    credentialFile: join(root, 'credential.json')
  };
}

function bootstrap() {
  return {
    serverUrl: 'wss://server.example',
    token: 'one-time-bootstrap',
    claims: {
      sandboxId: 'sandbox-1',
      instanceId: 'instance-1',
      generation: 1,
      imageDigest: 'sha256:fixed'
    }
  };
}

afterEach(() => {
  setManagedSandboxIdentity(null);
  process.env = { ...originalEnv };
  while (roots.length) rmSync(roots.pop(), { recursive: true, force: true });
});

describe('managed Sandbox Agent credential handling', () => {
  it('persists the scoped credential and removes the one-time bootstrap file after exchange', async () => {
    const paths = files();
    writeFileSync(paths.bootstrapFile, JSON.stringify(bootstrap()), { mode: 0o600 });

    const identity = await loadManagedSandboxIdentity({
      ...paths,
      fetchImpl: vi.fn(async () => ({
        ok: true,
        json: async () => ({ credentialId: 'credential-1', secret: 'scoped-secret' })
      }))
    });

    expect(identity.token).toBeUndefined();
    expect(existsSync(paths.bootstrapFile)).toBe(false);
    expect(JSON.parse(readFileSync(paths.credentialFile, 'utf8'))).toMatchObject({
      credentialId: 'credential-1', secret: 'scoped-secret'
    });
  });

  it('keeps the long-lived credential out of process environment variables', async () => {
    const paths = files();
    writeFileSync(paths.credentialFile, JSON.stringify({
      ...bootstrap(), token: undefined, credentialId: 'credential-1', secret: 'scoped-secret'
    }), { mode: 0o600 });

    await runManagedSandboxAgent(['--bootstrap-file', paths.bootstrapFile], {
      credentialFile: paths.credentialFile,
      startAgent: vi.fn(async () => {})
    });

    expect(getManagedSandboxIdentity()).toMatchObject({ credentialId: 'credential-1', secret: 'scoped-secret' });
    expect(process.env.YEAFT_MANAGED_SANDBOX_IDENTITY).toBeUndefined();
    expect(JSON.stringify(process.env)).not.toContain('scoped-secret');
  });
});
