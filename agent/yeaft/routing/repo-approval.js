const approvals = new WeakMap();
const REPO_APPROVAL_ISSUER_IDS = new Set(['martin']);

function normalizeId(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeSha(value) {
  const sha = normalizeId(value).toLowerCase();
  return /^[0-9a-f]{40}$/.test(sha) ? sha : '';
}

export function normalizeApprovalRepository(value) {
  const repository = normalizeId(value).replace(/\.git$/i, '');
  const segments = repository.split('/');
  if (segments.length === 2) segments.unshift('github.com');
  if (segments.length !== 3) return '';
  const [host, owner, name] = segments;
  const safePart = part => /^[a-z0-9_.-]+$/i.test(part) && part !== '.' && part !== '..';
  if (!safePart(host) || !safePart(owner) || !safePart(name) || !host.includes('.')) return '';
  return `${host}/${owner}/${name}`.toLowerCase();
}

export function isRepoApprovalIssuer(vpId) {
  return REPO_APPROVAL_ISSUER_IDS.has(normalizeId(vpId));
}

/**
 * Mint an opaque, process-local approval capability from host-authenticated VP
 * identity. The returned object has no serializable authority; its grant lives
 * only in this module's WeakMap.
 */
export function issueRepoApprovalCapability(input = {}) {
  const sessionId = normalizeId(input.sessionId);
  const issuerVpId = normalizeId(input.issuerVpId);
  const recipientVpId = normalizeId(input.recipientVpId);
  const repository = normalizeApprovalRepository(input.repository);
  const pr = Number(input.pr);
  const reviewedHead = normalizeSha(input.reviewedHead);
  const reviewedSnapshot = normalizeSha(input.reviewedSnapshot);
  if (!sessionId || !isRepoApprovalIssuer(issuerVpId) || !recipientVpId || issuerVpId === recipientVpId
    || !repository || !Number.isSafeInteger(pr) || pr <= 0 || !reviewedHead || !reviewedSnapshot) {
    return null;
  }
  const capability = Object.freeze(Object.create(null));
  approvals.set(capability, Object.freeze({
    sessionId,
    issuerVpId,
    recipientVpId,
    repository,
    pr,
    reviewedHead,
    reviewedSnapshot,
  }));
  return capability;
}

export function isRepoApprovalCapability(capability) {
  return Boolean(capability && typeof capability === 'object' && approvals.has(capability));
}

/** Consume a capability exactly once and verify its complete landing tuple. */
export function consumeRepoApprovalCapability(capability, expected = {}) {
  if (!capability || typeof capability !== 'object') return null;
  const grant = approvals.get(capability);
  approvals.delete(capability);
  if (!grant) return null;
  const matches = grant.sessionId === normalizeId(expected.sessionId)
    && grant.recipientVpId === normalizeId(expected.recipientVpId)
    && grant.repository === normalizeApprovalRepository(expected.repository)
    && grant.pr === Number(expected.pr)
    && grant.reviewedHead === normalizeSha(expected.reviewedHead)
    && grant.reviewedSnapshot === normalizeSha(expected.reviewedSnapshot);
  return matches ? grant : null;
}
