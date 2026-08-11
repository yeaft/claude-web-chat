async function readJsonResponse(response) {
  try {
    return await response.json();
  } catch {
    throw new Error('SANDBOX_LOAD_FAILED');
  }
}

/**
 * Load the Server-owned Sandbox capability before touching the Docker-backed
 * snapshot endpoint. Disabled deployments must not depend on a Docker runtime.
 *
 * @param {{ headers?: Record<string, string>, fetchImpl?: typeof fetch }} options
 * @returns {Promise<{ capability: object, sandbox: object|null }>}
 */
export async function loadSandboxState({ headers = {}, fetchImpl = globalThis.fetch } = {}) {
  const capabilityResponse = await fetchImpl('/api/sandbox/capability', { headers });
  if (!capabilityResponse.ok) throw new Error('SANDBOX_LOAD_FAILED');

  const capability = await readJsonResponse(capabilityResponse);
  if (!capability || typeof capability !== 'object') throw new Error('SANDBOX_LOAD_FAILED');
  if (capability.available !== true) return { capability, sandbox: null };

  const snapshotResponse = await fetchImpl('/api/sandbox', { headers });
  if (!snapshotResponse.ok) throw new Error('SANDBOX_LOAD_FAILED');
  const snapshot = await readJsonResponse(snapshotResponse);
  return { capability, sandbox: snapshot?.sandbox || null };
}
