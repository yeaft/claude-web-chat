/**
 * session-manifest.js — canonical index for Yeaft Session folders.
 *
 * Boot flow:
 *   1. If `<yeaftDir>/sessions-manifest.json` exists, load it and trust only
 *      valid entries whose folder still contains readable session metadata.
 *   2. If it does not exist, bootstrap once from legacy folder-based storage:
 *      copy registered workDir-backed Sessions into `<yeaftDir>/sessions/`, then
 *      index `<yeaftDir>/sessions/` into the manifest.
 *
 * The legacy `group-workdirs.json` registry remains readable for bootstrap only.
 * New steady-state discovery should use this manifest.
 */

import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'fs';
import { join } from 'path';
import { loadSessionMeta } from './session-store.js';
import { writeAtomic } from '../storage/atomic.js';

export const SESSIONS_MANIFEST_FILE = 'sessions-manifest.json';
const MANIFEST_VERSION = 1;
const MANIFEST_LOCK_DIR = 'sessions-manifest.lock';
const MANIFEST_LOCK_WAIT_MS = 5_000;
const lockWaitArray = new Int32Array(new SharedArrayBuffer(4));

export function sessionManifestPath(yeaftDir) {
  return join(yeaftDir, SESSIONS_MANIFEST_FILE);
}

export function hasSessionManifest(yeaftDir) {
  return !!yeaftDir && existsSync(sessionManifestPath(yeaftDir));
}

export function loadSessionsManifest(yeaftDir) {
  if (!hasSessionManifest(yeaftDir)) return null;
  try {
    const parsed = JSON.parse(readFileSync(sessionManifestPath(yeaftDir), 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    if (!Array.isArray(parsed.sessions)) return null;
    return {
      version: Number(parsed.version) || MANIFEST_VERSION,
      generatedAt: typeof parsed.generatedAt === 'string' ? parsed.generatedAt : '',
      sessions: parsed.sessions
        .filter(row => row && typeof row === 'object' && typeof row.id === 'string' && typeof row.path === 'string')
        .map(row => ({
          id: row.id,
          path: row.path,
          name: typeof row.name === 'string' ? row.name : row.id,
          createdAt: typeof row.createdAt === 'string' ? row.createdAt : '',
          workDir: typeof row.workDir === 'string' ? row.workDir : '',
          workspaceKey: typeof row.workspaceKey === 'string' ? row.workspaceKey : '',
        })),
    };
  } catch {
    return null;
  }
}

export function writeSessionsManifest(yeaftDir, sessions) {
  return withManifestLock(yeaftDir, () => writeSessionsManifestUnlocked(yeaftDir, sessions));
}

function writeSessionsManifestUnlocked(yeaftDir, sessions) {
  if (!yeaftDir) throw new Error('yeaftDir required');
  mkdirSync(yeaftDir, { recursive: true });
  const manifest = {
    version: MANIFEST_VERSION,
    generatedAt: new Date().toISOString(),
    sessions: dedupeSessions(sessions).sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || ''))),
  };
  writeAtomic(sessionManifestPath(yeaftDir), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

export function buildManifestFromLocalSessions(yeaftDir, sessionsRoot) {
  const rows = [];
  if (!sessionsRoot || !existsSync(sessionsRoot)) return rows;
  let entries;
  try {
    entries = readdirSync(sessionsRoot);
  } catch {
    return rows;
  }
  for (const name of entries) {
    if (name.startsWith('.')) continue;
    const dir = join(sessionsRoot, name);
    try { if (!statSync(dir).isDirectory()) continue; } catch { continue; }
    const meta = loadSessionMeta(dir);
    if (!meta) continue;
    rows.push(manifestRowFromMeta(meta, dir));
  }
  return rows;
}

export function listManifestSessions(yeaftDir) {
  const manifest = loadSessionsManifest(yeaftDir);
  if (!manifest) return [];
  const rows = [];
  const seen = new Set();
  for (const entry of manifest.sessions) {
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    const meta = loadSessionMeta(entry.path);
    if (!meta) continue;
    rows.push({ meta, dir: entry.path });
  }
  return rows.sort((a, b) => String(a.meta.createdAt || '').localeCompare(String(b.meta.createdAt || '')));
}

export function resolveManifestSessionDir(yeaftDir, sessionId) {
  const manifest = loadSessionsManifest(yeaftDir);
  if (!manifest || !sessionId) return null;
  const entry = manifest.sessions.find(row => row.id === sessionId);
  if (!entry) return null;
  if (!loadSessionMeta(entry.path)) return null;
  return entry.path;
}

/**
 * Bootstrap the manifest from legacy storage if it does not exist.
 *
 * @param {string} yeaftDir
 * @param {{sessionsRoot:string, registry?:object, yeaftDirForWorkDir:(workDir:string)=>string, sessionsRootForYeaftDir:(dir:string)=>string, copySessionExtras?:(projectYeaftDir:string, sessionId:string)=>void, unregisterSessionWorkDir?:(sessionId:string)=>void}} options
 */
export function ensureSessionsManifest(yeaftDir, options) {
  if (hasSessionManifest(yeaftDir)) {
    return { created: false, migrated: 0, skipped: 0, manifest: loadSessionsManifest(yeaftDir) };
  }
  const root = options.sessionsRoot;
  mkdirSync(root, { recursive: true });

  let migrated = 0;
  let skipped = 0;
  const migratedIds = [];
  const skippedIds = [];
  const registry = options.registry && typeof options.registry === 'object' ? options.registry : {};
  for (const [sessionId, workDir] of Object.entries(registry)) {
    if (!sessionId || !workDir) continue;
    const projectYeaftDir = options.yeaftDirForWorkDir(workDir);
    const projectRoot = options.sessionsRootForYeaftDir(projectYeaftDir);
    const sourceDir = join(projectRoot, sessionId);
    const destDir = join(root, sessionId);
    const meta = existsSync(sourceDir) ? loadSessionMeta(sourceDir) : null;
    if (!meta) {
      skipped += 1;
      skippedIds.push(sessionId);
      continue;
    }
    if (existsSync(destDir)) {
      if (loadSessionMeta(destDir)) {
        skipped += 1;
        skippedIds.push(sessionId);
        if (typeof options.unregisterSessionWorkDir === 'function') {
          options.unregisterSessionWorkDir(sessionId);
        }
        continue;
      }
      skipped += 1;
      skippedIds.push(sessionId);
      continue;
    }
    cpSync(sourceDir, destDir, { recursive: true, errorOnExist: false });
    migrated += 1;
    migratedIds.push(sessionId);
    if (typeof options.copySessionExtras === 'function') {
      options.copySessionExtras(projectYeaftDir, sessionId);
    }
    if (typeof options.unregisterSessionWorkDir === 'function') {
      options.unregisterSessionWorkDir(sessionId);
    }
  }

  return withManifestLock(yeaftDir, () => {
    const current = loadSessionsManifest(yeaftDir);
    const manifest = writeSessionsManifestUnlocked(yeaftDir, [
      ...(current?.sessions || []),
      ...buildManifestFromLocalSessions(yeaftDir, root),
    ]);
    return {
      created: !current,
      migrated,
      skipped,
      migratedIds,
      skippedIds,
      manifest,
    };
  });
}

export function addOrUpdateManifestSession(yeaftDir, meta, dir) {
  return withManifestLock(yeaftDir, () => {
    const current = loadSessionsManifest(yeaftDir);
    const recovered = current?.sessions
      || buildManifestFromLocalSessions(yeaftDir, join(yeaftDir, 'sessions'));
    const rows = recovered.filter(row => row.id !== meta.id);
    rows.push(manifestRowFromMeta(meta, dir));
    return writeSessionsManifestUnlocked(yeaftDir, rows);
  });
}

export function removeManifestSession(yeaftDir, sessionId) {
  return withManifestLock(yeaftDir, () => {
    const current = loadSessionsManifest(yeaftDir);
    if (!current) return null;
    return writeSessionsManifestUnlocked(yeaftDir, current.sessions.filter(row => row.id !== sessionId));
  });
}

function withManifestLock(yeaftDir, operation) {
  if (!yeaftDir) throw new Error('yeaftDir required');
  mkdirSync(yeaftDir, { recursive: true });
  const lockDir = join(yeaftDir, MANIFEST_LOCK_DIR);
  const deadline = Date.now() + MANIFEST_LOCK_WAIT_MS;
  for (;;) {
    try {
      mkdirSync(lockDir);
      break;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      if (Date.now() >= deadline) throw new Error('Timed out waiting for Session manifest lock');
      Atomics.wait(lockWaitArray, 0, 0, 25);
    }
  }
  try {
    return operation();
  } finally {
    rmSync(lockDir, { recursive: true, force: true });
  }
}

function manifestRowFromMeta(meta, dir) {
  return {
    id: meta.id,
    name: meta.name || meta.id,
    path: dir,
    createdAt: meta.createdAt || '',
    workDir: meta.workDir || '',
    workspaceKey: meta.workspaceKey || '',
  };
}

function dedupeSessions(sessions) {
  const byId = new Map();
  for (const row of sessions || []) {
    if (!row || !row.id || !row.path) continue;
    byId.set(row.id, {
      id: row.id,
      name: row.name || row.id,
      path: row.path,
      createdAt: row.createdAt || '',
      workDir: row.workDir || '',
      workspaceKey: row.workspaceKey || '',
    });
  }
  return Array.from(byId.values());
}

export function __testRemoveSessionsManifest(yeaftDir) {
  rmSync(sessionManifestPath(yeaftDir), { force: true });
}
