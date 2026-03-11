/**
 * RolePlay Session — session index management for .roleplay/session.json.
 *
 * Analogous to agent/crew/session.js but much simpler:
 * - No multi-process concerns (single process)
 * - No worktree management
 * - Atomic write for crash safety
 *
 * session.json schema:
 * {
 *   sessions: [{ name, teamType, language, projectDir, conversationId,
 *                roles, createdAt, updatedAt, status }],
 *   activeSession: string | null
 * }
 */
import { promises as fs } from 'fs';
import { join } from 'path';
import { existsSync, readFileSync, writeFileSync, renameSync } from 'fs';

const SESSION_FILE = 'session.json';

// ─── Read / Write ───────────────────────────────────────────────────

/**
 * Load .roleplay/session.json.
 * Returns { sessions: [], activeSession: null } if file doesn't exist or is corrupt.
 *
 * @param {string} projectDir
 * @returns {{ sessions: Array, activeSession: string|null }}
 */
export function loadRolePlaySessionIndex(projectDir) {
  const filePath = join(projectDir, '.roleplay', SESSION_FILE);
  if (!existsSync(filePath)) {
    return { sessions: [], activeSession: null };
  }
  try {
    const raw = readFileSync(filePath, 'utf-8');
    const data = JSON.parse(raw);
    return {
      sessions: Array.isArray(data.sessions) ? data.sessions : [],
      activeSession: data.activeSession || null,
    };
  } catch (e) {
    console.warn('[RolePlaySession] Failed to load session.json:', e.message);
    return { sessions: [], activeSession: null };
  }
}

/**
 * Save .roleplay/session.json atomically (write tmp → rename).
 *
 * @param {string} projectDir
 * @param {{ sessions: Array, activeSession: string|null }} data
 */
export async function saveRolePlaySessionIndex(projectDir, data) {
  const rpDir = join(projectDir, '.roleplay');
  const filePath = join(rpDir, SESSION_FILE);
  const tmpPath = `${filePath}.tmp.${Date.now()}`;

  const content = JSON.stringify(data, null, 2);
  try {
    await fs.mkdir(rpDir, { recursive: true });
    await fs.writeFile(tmpPath, content);
    await fs.rename(tmpPath, filePath);
  } catch (e) {
    console.error('[RolePlaySession] Failed to save session.json:', e.message);
    // Clean up tmp file if rename failed
    try { await fs.unlink(tmpPath); } catch {}
    throw e;
  }
}

// ─── Session CRUD ───────────────────────────────────────────────────

/**
 * Add a new session entry to .roleplay/session.json.
 * Sets it as the activeSession.
 *
 * @param {string} projectDir
 * @param {object} session - session entry to add:
 *   { name, teamType, language, projectDir, conversationId, roles, createdAt }
 * @returns {object} the session entry with updatedAt/status fields added
 */
export async function addRolePlaySession(projectDir, session) {
  const index = loadRolePlaySessionIndex(projectDir);

  // Check for duplicate session name
  const existing = index.sessions.find(s => s.name === session.name);
  if (existing) {
    // Update existing entry instead of creating duplicate
    Object.assign(existing, {
      ...session,
      updatedAt: Date.now(),
      status: 'active',
    });
    index.activeSession = session.name;
    await saveRolePlaySessionIndex(projectDir, index);
    return existing;
  }

  const entry = {
    ...session,
    updatedAt: Date.now(),
    status: 'active',
  };

  index.sessions.push(entry);
  index.activeSession = session.name;
  await saveRolePlaySessionIndex(projectDir, index);
  return entry;
}

/**
 * Remove (archive) a session from .roleplay/session.json.
 * The session entry is marked as 'archived', not deleted,
 * so the context/ directory content remains valid.
 *
 * Optionally removes the session's roles/ directory.
 *
 * @param {string} projectDir
 * @param {string} sessionName
 * @param {object} [options]
 * @param {boolean} [options.removeDir=true] - remove .roleplay/roles/{sessionName}/
 */
export async function removeRolePlaySession(projectDir, sessionName, options = {}) {
  const { removeDir = true } = options;
  const index = loadRolePlaySessionIndex(projectDir);

  const session = index.sessions.find(s => s.name === sessionName);
  if (session) {
    session.status = 'archived';
    session.updatedAt = Date.now();
  }

  // Clear activeSession if it was the removed one
  if (index.activeSession === sessionName) {
    // Pick next active session (most recently updated non-archived)
    const active = index.sessions
      .filter(s => s.status === 'active')
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    index.activeSession = active[0]?.name || null;
  }

  await saveRolePlaySessionIndex(projectDir, index);

  // Remove the session directory (but keep context/)
  if (removeDir) {
    const sessionDir = join(projectDir, '.roleplay', 'roles', sessionName);
    try {
      await fs.rm(sessionDir, { recursive: true, force: true });
    } catch {
      // Not critical — may not exist
    }
  }
}

/**
 * Find a session entry by conversationId.
 *
 * @param {string} projectDir
 * @param {string} conversationId
 * @returns {object|null} session entry or null
 */
export function findRolePlaySessionByConversationId(projectDir, conversationId) {
  if (!conversationId) return null;
  const index = loadRolePlaySessionIndex(projectDir);
  return index.sessions.find(s => s.conversationId === conversationId) || null;
}

/**
 * Update the activeSession pointer and updatedAt timestamp.
 *
 * @param {string} projectDir
 * @param {string} sessionName
 */
export async function setActiveRolePlaySession(projectDir, sessionName) {
  const index = loadRolePlaySessionIndex(projectDir);
  const session = index.sessions.find(s => s.name === sessionName);
  if (session) {
    session.updatedAt = Date.now();
    index.activeSession = sessionName;
    await saveRolePlaySessionIndex(projectDir, index);
  }
}
