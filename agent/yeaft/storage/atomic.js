/**
 * atomic.js — Crash-safe single-file writes.
 *
 * task-334o §Δ15 / §Δ22 §Δ23 shard-store foundation.
 *
 * Contract: writeAtomic(path, data) never leaves a half-written file at `path`.
 * If the process crashes at any point, `path` is either the pre-existing content
 * or the new content — never a torn mix. Leftover `*.tmp.<pid>.<n>` files are
 * the only debris; they are safe to delete on boot (see sweepTmp()).
 *
 * Implementation:
 *   1. Exclusively create `path.tmp.<pid>.<counter>` and write through its fd.
 *   2. fsync the same fd (force bytes to disk before rename).
 *   3. rename(tmp, path) — POSIX-atomic on same filesystem.
 *   4. fsync the parent dir (persist the rename itself).
 *
 * Step 4 is what most naive "atomic write" implementations skip. Without it,
 * a crash after the rename call returns can still lose the rename on ext4
 * with data=ordered. We do the dir fsync on Linux/macOS; on Windows we skip
 * (fsync on a directory is an error there) and accept the minor risk window.
 *
 * This module has no knowledge of VP/task/message — it's a pure primitive.
 */

import {
  writeFileSync,
  renameSync,
  openSync,
  fsyncSync,
  closeSync,
  existsSync,
  unlinkSync,
  readdirSync,
  lstatSync,
  constants,
} from 'fs';
import { dirname, basename, join } from 'path';

let tmpCounter = 0;

export function nextAtomicTmpPathForTest(path) {
  return `${path}.tmp.${process.pid}.${tmpCounter + 1}`;
}

function targetMode(path, fallbackMode) {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile()) throw new Error(`Atomic write target is not a regular file: ${path}`);
    return stat.mode & 0o777;
  } catch (error) {
    if (error?.code === 'ENOENT') return fallbackMode;
    throw error;
  }
}

/**
 * Atomically write `data` (string | Buffer) to `path`.
 * Throws on failure; never leaves `path` in a half-written state.
 *
 * `mode` is used only for first creation and is still restricted by umask.
 * Existing files keep their current permission bits. Secret-bearing callers
 * must pass an explicit restrictive mode such as `0o600`.
 */
export function writeAtomic(path, data, { mode = 0o666 } = {}) {
  const dir = dirname(path);
  const tmpPath = `${path}.tmp.${process.pid}.${++tmpCounter}`;
  const fileMode = targetMode(path, mode);
  let fd = null;
  try {
    fd = openSync(
      tmpPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      fileMode,
    );
    writeFileSync(fd, data);
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    renameSync(tmpPath, path);
  } catch (error) {
    if (fd !== null) {
      try { closeSync(fd); } catch {}
      try { unlinkSync(tmpPath); } catch {}
    }
    throw error;
  }

  // fsync the parent directory so the rename is durable.
  // Windows: cannot fsync a directory; skip.
  if (process.platform !== 'win32') {
    try {
      const dfd = openSync(dir, 'r');
      try {
        fsyncSync(dfd);
      } finally {
        closeSync(dfd);
      }
    } catch {
      // Directory fsync is best-effort. A failure here does not invalidate
      // the rename itself; it only weakens durability on power loss.
    }
  }
}

/**
 * Remove any leftover `*.tmp.*` files in `dir` from a previous crashed write.
 * Safe to call on boot. Returns the count removed.
 *
 * Only matches the specific `<basename>.tmp.<pid>.<counter>` shape — won't
 * touch user files that happen to end in `.tmp`.
 */
export function sweepTmp(dir) {
  if (!existsSync(dir)) return 0;
  let removed = 0;
  for (const name of readdirSync(dir)) {
    if (/\.tmp\.\d+\.\d+$/.test(name)) {
      try {
        unlinkSync(join(dir, name));
        removed++;
      } catch {
        // Ignore — another process may have beaten us to it.
      }
    }
  }
  return removed;
}

/** Check whether a given file path looks like our tmp sidecar. Test helper. */
export function isTmpPath(path) {
  return /\.tmp\.\d+\.\d+$/.test(basename(path));
}
