import { createHash, randomUUID } from 'crypto';
import db, { stmts, generateUserId, generateAgentSecret, transaction } from './connection.js';

function deletionRequestDigest() {
  return createHash('sha256').update(JSON.stringify({ kind: 'remove' })).digest('hex');
}

function ensureDeletionRemoval(userId, deletionId, now = Date.now()) {
  const sandbox = db.prepare('SELECT * FROM sandboxes WHERE user_id = ? AND reservation_held = 1').get(userId);
  if (!sandbox) return null;
  const key = `account-delete:${deletionId}`;
  const existing = db.prepare('SELECT * FROM sandbox_operations WHERE user_id = ? AND idempotency_key = ?')
    .get(userId, key);
  if (existing) return existing;
  db.prepare(`
    UPDATE sandbox_operations SET status = 'failed', error_code = 'ACCOUNT_DELETION_REQUESTED', updated_at = ?
    WHERE sandbox_id = ? AND status IN ('pending', 'running')
  `).run(now, sandbox.id);
  db.prepare('UPDATE sandbox_credentials SET revoked_at = ? WHERE sandbox_id = ? AND revoked_at IS NULL')
    .run(now, sandbox.id);
  const host = db.prepare('SELECT epoch FROM sandbox_hosts WHERE id = ?').get(sandbox.host_id);
  const hostEpoch = host?.epoch || sandbox.host_epoch;
  const generation = sandbox.generation + 1;
  db.prepare(`
    UPDATE sandboxes SET desired_state = 'removed', observed_state = CASE
      WHEN observed_state = 'removed' THEN observed_state ELSE 'recovery_required' END,
      generation = ?, host_epoch = ?, last_error_code = NULL, updated_at = ?
    WHERE id = ? AND reservation_held = 1
  `).run(generation, hostEpoch, now, sandbox.id);
  const operationId = `sandbox_op_${randomUUID()}`;
  db.prepare(`
    INSERT INTO sandbox_operations (
      id, sandbox_id, user_id, idempotency_key, request_digest, kind, status,
      stage, generation, host_epoch, deadline_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'remove', 'pending', 'removing', ?, ?, ?, ?, ?)
  `).run(operationId, sandbox.id, userId, key, deletionRequestDigest(), generation,
    hostEpoch, now + 10 * 60_000, now, now);
  return db.prepare('SELECT * FROM sandbox_operations WHERE id = ?').get(operationId);
}

export const userDb = {
  getOrCreate(username, displayName = null) {
    let user = stmts.getUserByUsername.get(username);
    if (!user) {
      const id = generateUserId();
      const now = Date.now();
      stmts.insertUser.run(id, username, displayName || username, now);
      user = { id, username, display_name: displayName || username, created_at: now };
    }
    return user;
  },

  createFull(username, passwordHash, email = null, role = 'user') {
    const id = generateUserId();
    const now = Date.now();
    const agentSecret = generateAgentSecret();
    stmts.insertUserFull.run(id, username, username, passwordHash, email, agentSecret, role, now);
    return { id, username, display_name: username, password_hash: passwordHash, email, agent_secret: agentSecret, role, created_at: now };
  },

  migrateUser(username, passwordHash, email, role = 'admin') {
    const existing = stmts.getUserByUsername.get(username);
    if (existing) {
      if (existing.password_hash) {
        return existing;
      }
      const newSecret = generateAgentSecret();
      stmts.updateUserMigrate.run(passwordHash, email, role, newSecret, existing.id);
      return { ...existing, password_hash: passwordHash, email, role, agent_secret: existing.agent_secret || newSecret };
    }
    return this.createFull(username, passwordHash, email, role);
  },

  get(id) {
    return stmts.getUserById.get(id);
  },

  getByUsername(username) {
    return stmts.getUserByUsername.get(username);
  },

  getUserByAgentSecret(secret) {
    if (!secret) return null;
    return stmts.getUserByAgentSecret.get(secret) || null;
  },

  getAll() {
    return stmts.getAllUsers.all();
  },

  isActive(userId) {
    return db.prepare("SELECT 1 FROM users WHERE id = ? AND deletion_state = 'active'").get(userId) !== undefined;
  },

  beginDeletion(userId, now = Date.now()) {
    return transaction(() => {
      const user = stmts.getUserById.get(userId);
      if (!user) return null;
      const deletionId = user.deletion_id || `deletion_${randomUUID()}`;
      if (user.deletion_state !== 'pending') {
        const changed = db.prepare(`
          UPDATE users SET deletion_state = 'pending', deletion_requested_at = ?, deletion_id = ?,
            password_hash = NULL, agent_secret = NULL, totp_secret = NULL, totp_enabled = 0
          WHERE id = ? AND deletion_state = 'active'
        `).run(now, deletionId, userId);
        if (changed.changes !== 1) {
          throw new Error('ACCOUNT_DELETION_STATE_CONFLICT');
        }
      }
      db.prepare('UPDATE sandbox_entitlements SET enabled = 0, updated_at = ? WHERE user_id = ?')
        .run(now, userId);
      const operation = ensureDeletionRemoval(userId, deletionId, now);
      return { deletionId, status: 'pending', operationId: operation?.id || null };
    })();
  },

  reconcilePendingDeletions(now = Date.now()) {
    const pending = db.prepare("SELECT id, deletion_id FROM users WHERE deletion_state = 'pending'").all();
    let finalized = 0;
    for (const user of pending) {
      if (stmts.getReservedSandboxForUser.get(user.id)) {
        transaction(() => ensureDeletionRemoval(user.id, user.deletion_id, now))();
        continue;
      }
      const unsettled = db.prepare(`
        SELECT 1 FROM sandboxes s
        WHERE s.user_id = ? AND (
          s.observed_state != 'removed' OR s.removed_at IS NULL
          OR EXISTS (
            SELECT 1 FROM sandbox_operations o
            WHERE o.sandbox_id = s.id AND o.status IN ('pending', 'running')
          )
          OR NOT EXISTS (
            SELECT 1 FROM sandbox_operations o
            WHERE o.sandbox_id = s.id AND o.kind = 'remove' AND o.status = 'succeeded'
          )
          OR EXISTS (
            SELECT 1 FROM sandbox_credentials c
            WHERE c.sandbox_id = s.id AND c.revoked_at IS NULL
          )
        ) LIMIT 1
      `).get(user.id);
      if (!unsettled && this.deleteUser(user.id, { requirePending: true })) finalized++;
    }
    return finalized;
  },

  updateLogin(id) {
    stmts.updateUserLogin.run(Date.now(), id);
  },

  updatePassword(userId, passwordHash) {
    stmts.updateUserPassword.run(passwordHash, userId);
  },

  updateEmail(userId, email) {
    stmts.updateUserEmail.run(email, userId);
  },

  updateDisplayName(userId, displayName) {
    if (!displayName) return;
    stmts.updateUserDisplayName.run(displayName, userId);
  },

  getAgentSecret(userId) {
    const user = stmts.getUserById.get(userId);
    return user?.agent_secret || null;
  },

  resetAgentSecret(userId) {
    const newSecret = generateAgentSecret();
    stmts.updateUserAgentSecret.run(newSecret, userId);
    return newSecret;
  },

  updateRole(userId, role) {
    stmts.updateUserRole.run(role, userId);
  },

  getTotp(username) {
    const result = stmts.getUserTotp.get(username);
    if (result) {
      return {
        totpSecret: result.totp_secret,
        totpEnabled: !!result.totp_enabled
      };
    }
    return null;
  },

  updateTotp(username, totpSecret, totpEnabled) {
    let user = stmts.getUserByUsername.get(username);
    if (!user) {
      const id = generateUserId();
      const now = Date.now();
      stmts.insertUser.run(id, username, username, now);
    }
    stmts.updateUserTotp.run(totpSecret, totpEnabled ? 1 : 0, username);
    return true;
  },

  getByAadOid(aadOid) {
    if (!aadOid) return null;
    const user = stmts.getUserByAadOid.get(aadOid) || null;
    return user?.deletion_state === 'active' ? user : null;
  },

  updateAadOid(userId, aadOid) {
    stmts.updateUserAadOid.run(aadOid, userId);
  },

  /**
   * Create a user from AAD profile (no password, linked by aad_oid).
   * `displayName` is used as a friendlier label (e.g. the Alipay nickname);
   * falls back to the username when not provided.
   */
  createFromAad(username, email, aadOid, role = 'pro', displayName = null) {
    const id = generateUserId();
    const now = Date.now();
    const agentSecret = generateAgentSecret();
    const display = displayName || username;
    stmts.insertUserFull.run(id, username, display, null, email, agentSecret, role, now);
    stmts.updateUserAadOid.run(aadOid, id);
    return { id, username, display_name: display, email, aad_oid: aadOid, agent_secret: agentSecret, role, created_at: now };
  },

  /**
   * Permanently delete a user and ALL data scoped to that user.
   *
   * Tables touched (all inside one transaction):
   *   - user_identities         hard delete (also covered by FK CASCADE, belt-and-braces)
   *   - sessions                hard delete (messages cascade via FK)
   *   - user_stats              hard delete
   *   - daily_stats             hard delete
   *   - agent_metric_watermarks cascade delete
   *   - custom_expert_roles     hard delete (custom_expert_actions cascade via FK)
   *   - invitations.created_by  rows deleted (codes the user issued)
   *   - invitations.used_by     set NULL (preserve history of *who consumed what* — but we lose the link)
   *   - users                   row deleted last
   *
   * Caller is responsible for revoking JWT sessions (we don't import the
   * session store from here to keep this layer pure).
   */
  deleteUser(userId, { requirePending = false } = {}) {
    // Final erasure is allowed only after every Sandbox reservation has settled.
    const run = transaction((id) => {
      const user = stmts.getUserById.get(id);
      if (!user || (requirePending && user.deletion_state !== 'pending')) return false;
      if (stmts.getReservedSandboxForUser.get(id)) {
        const error = new Error('SANDBOX_REMOVE_REQUIRED');
        error.code = 'SANDBOX_REMOVE_REQUIRED';
        throw error;
      }
      if (requirePending) {
        const unsettled = db.prepare(`
          SELECT 1 FROM sandboxes s WHERE s.user_id = ? AND (
            s.observed_state != 'removed' OR s.removed_at IS NULL
            OR EXISTS (SELECT 1 FROM sandbox_operations o WHERE o.sandbox_id = s.id AND o.status IN ('pending', 'running'))
            OR NOT EXISTS (SELECT 1 FROM sandbox_operations o WHERE o.sandbox_id = s.id AND o.kind = 'remove' AND o.status = 'succeeded')
            OR EXISTS (SELECT 1 FROM sandbox_credentials c WHERE c.sandbox_id = s.id AND c.revoked_at IS NULL)
          ) LIMIT 1
        `).get(id);
        if (unsettled) return false;
      }
      stmts.deleteReleasedSandboxesForUser.run(id);
      stmts.deleteIdentitiesForUser.run(id);
      stmts.deleteUserSessionsByUser.run(id);
      stmts.deleteYeaftSessionsByUserCascade.run(id);
      stmts.deleteUserStats.run(id);
      stmts.deleteDailyStatsForUser.run(id);
      stmts.deleteCustomExpertRolesForUser.run(id);
      stmts.deleteInvitationsCreatedBy.run(id);
      stmts.clearInvitationUsedBy.run(id);
      const result = stmts.deleteUserById.run(id);
      return result.changes > 0;
    });
    return run(userId);
  }
};
