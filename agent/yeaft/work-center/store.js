import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

const SCHEMA_VERSION = 1;

function parseJson(value, fallback) {
  if (typeof value !== 'string' || !value) return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
}

function stringify(value) {
  return JSON.stringify(value ?? null);
}

function mapWorkItem(row) {
  if (!row) return null;
  return {
    id: row.id,
    revision: row.revision,
    title: row.title,
    goal: row.goal,
    acceptanceCriteria: parseJson(row.acceptance_criteria, []),
    workflowTemplate: row.workflow_template,
    status: row.status,
    currentActionId: row.current_action_id || null,
    currentRunId: row.current_run_id || null,
    workDir: row.work_dir || '',
    origin: parseJson(row.origin, null),
    linkedSessionIds: parseJson(row.linked_session_ids, []),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapAction(row) {
  if (!row) return null;
  return {
    id: row.id,
    workItemId: row.work_item_id,
    sequence: row.sequence,
    type: row.type,
    requiredRole: row.required_role,
    instruction: row.instruction,
    status: row.status,
    attempt: row.attempt,
    maxAttempts: row.max_attempts,
    currentRunId: row.current_run_id || null,
    leaseEpoch: row.lease_epoch,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapRun(row) {
  if (!row) return null;
  return {
    id: row.id,
    actionId: row.action_id,
    workItemId: row.work_item_id,
    ownerBootId: row.owner_boot_id,
    leaseEpoch: row.lease_epoch,
    status: row.status,
    startedAt: row.started_at,
    expiresAt: row.expires_at,
    endedAt: row.ended_at || null,
    roleSnapshot: parseJson(row.role_snapshot, null),
    vpSnapshot: parseJson(row.vp_snapshot, null),
    modelSnapshot: parseJson(row.model_snapshot, null),
    summary: row.summary || '',
    evidence: parseJson(row.evidence, []),
    waitingReason: row.waiting_reason || null,
    error: row.error || null,
  };
}

function mapEvent(row) {
  if (!row) return null;
  return {
    id: row.id,
    workItemId: row.work_item_id,
    actionId: row.action_id || null,
    runId: row.run_id || null,
    type: row.type,
    data: parseJson(row.data, {}),
    createdAt: row.created_at,
  };
}

function withTransaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch {}
    throw err;
  }
}

export class WorkItemStore {
  constructor(dbPath, options = {}) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.now = typeof options.now === 'function' ? options.now : () => Date.now();
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA synchronous = NORMAL;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.#initSchema();
  }

  #initSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS work_items (
        id TEXT PRIMARY KEY,
        revision INTEGER NOT NULL DEFAULT 1,
        title TEXT NOT NULL,
        goal TEXT NOT NULL,
        acceptance_criteria TEXT NOT NULL,
        workflow_template TEXT NOT NULL,
        status TEXT NOT NULL,
        current_action_id TEXT,
        current_run_id TEXT,
        work_dir TEXT NOT NULL DEFAULT '',
        origin TEXT,
        linked_session_ids TEXT NOT NULL DEFAULT '[]',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS actions (
        id TEXT PRIMARY KEY,
        work_item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
        sequence INTEGER NOT NULL,
        type TEXT NOT NULL,
        required_role TEXT NOT NULL,
        instruction TEXT NOT NULL,
        status TEXT NOT NULL,
        attempt INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 2,
        current_run_id TEXT,
        lease_epoch INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(work_item_id, sequence)
      );
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        action_id TEXT NOT NULL REFERENCES actions(id) ON DELETE CASCADE,
        work_item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
        owner_boot_id TEXT NOT NULL,
        lease_epoch INTEGER NOT NULL,
        status TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        ended_at INTEGER,
        role_snapshot TEXT,
        vp_snapshot TEXT,
        model_snapshot TEXT,
        summary TEXT,
        evidence TEXT NOT NULL DEFAULT '[]',
        waiting_reason TEXT,
        error TEXT
      );
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        work_item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
        action_id TEXT,
        run_id TEXT,
        type TEXT NOT NULL,
        data TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_work_items_status_updated ON work_items(status, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_actions_ready ON actions(status, updated_at, sequence);
      CREATE INDEX IF NOT EXISTS idx_runs_active ON runs(status, expires_at);
      CREATE INDEX IF NOT EXISTS idx_events_work_item ON events(work_item_id, id);
    `);
    this.db.prepare(`INSERT INTO schema_meta(key, value) VALUES('schema_version', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(String(SCHEMA_VERSION));
  }

  close() {
    this.db.close();
  }

  appendEvent(workItemId, type, data = {}, refs = {}) {
    const now = this.now();
    const result = this.db.prepare(`INSERT INTO events
      (work_item_id, action_id, run_id, type, data, created_at)
      VALUES (?, ?, ?, ?, ?, ?)`).run(
      workItemId,
      refs.actionId || null,
      refs.runId || null,
      type,
      stringify(data),
      now,
    );
    return Number(result.lastInsertRowid);
  }

  createWorkItem(input, firstAction) {
    return withTransaction(this.db, () => {
      const now = this.now();
      const id = input.id || randomUUID();
      this.db.prepare(`INSERT INTO work_items
        (id, revision, title, goal, acceptance_criteria, workflow_template, status,
         current_action_id, current_run_id, work_dir, origin, linked_session_ids,
         created_at, updated_at)
        VALUES (?, 1, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?)`).run(
        id,
        input.title,
        input.goal,
        stringify(input.acceptanceCriteria || []),
        input.workflowTemplate || 'software-change',
        firstAction ? 'ready' : 'draft',
        input.workDir || '',
        stringify(input.origin || null),
        stringify(input.linkedSessionIds || []),
        now,
        now,
      );
      let action = null;
      if (firstAction) {
        action = this.#insertAction(id, firstAction, 1, now);
        this.db.prepare('UPDATE work_items SET current_action_id = ? WHERE id = ?').run(action.id, id);
      }
      this.appendEvent(id, 'work_item.created', { status: firstAction ? 'ready' : 'draft' }, { actionId: action?.id });
      return this.getWorkItem(id);
    });
  }

  #insertAction(workItemId, input, sequence, now = this.now()) {
    const action = {
      id: input.id || randomUUID(),
      workItemId,
      sequence,
      type: input.type,
      requiredRole: input.requiredRole,
      instruction: input.instruction || '',
      status: input.status || 'ready',
      attempt: Number.isInteger(input.attempt) ? input.attempt : 0,
      maxAttempts: Number.isInteger(input.maxAttempts) ? input.maxAttempts : 2,
      currentRunId: null,
      leaseEpoch: 0,
      createdAt: now,
      updatedAt: now,
    };
    this.db.prepare(`INSERT INTO actions
      (id, work_item_id, sequence, type, required_role, instruction, status,
       attempt, max_attempts, current_run_id, lease_epoch, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, ?, ?)`).run(
      action.id,
      workItemId,
      action.sequence,
      action.type,
      action.requiredRole,
      action.instruction,
      action.status,
      action.attempt,
      action.maxAttempts,
      now,
      now,
    );
    return action;
  }

  createNextAction(workItemId, input) {
    const maxRow = this.db.prepare('SELECT COALESCE(MAX(sequence), 0) AS seq FROM actions WHERE work_item_id = ?').get(workItemId);
    return this.#insertAction(workItemId, input, Number(maxRow.seq) + 1);
  }

  getWorkItem(id) {
    return mapWorkItem(this.db.prepare('SELECT * FROM work_items WHERE id = ?').get(id));
  }

  getAction(id) {
    return mapAction(this.db.prepare('SELECT * FROM actions WHERE id = ?').get(id));
  }

  getRun(id) {
    return mapRun(this.db.prepare('SELECT * FROM runs WHERE id = ?').get(id));
  }

  listWorkItems(filters = {}) {
    const where = [];
    const values = [];
    if (typeof filters.status === 'string' && filters.status) {
      where.push('status = ?');
      values.push(filters.status);
    }
    if (typeof filters.search === 'string' && filters.search.trim()) {
      where.push('(title LIKE ? OR goal LIKE ?)');
      const query = `%${filters.search.trim()}%`;
      values.push(query, query);
    }
    const limit = Math.min(Math.max(Number(filters.limit) || 100, 1), 500);
    const sql = `SELECT * FROM work_items ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY updated_at DESC LIMIT ?`;
    return this.db.prepare(sql).all(...values, limit).map(mapWorkItem);
  }

  getWorkItemDetail(id) {
    const workItem = this.getWorkItem(id);
    if (!workItem) return null;
    return {
      ...workItem,
      actions: this.db.prepare('SELECT * FROM actions WHERE work_item_id = ? ORDER BY sequence').all(id).map(mapAction),
      runs: this.db.prepare('SELECT * FROM runs WHERE work_item_id = ? ORDER BY started_at DESC').all(id).map(mapRun),
      events: this.db.prepare('SELECT * FROM events WHERE work_item_id = ? ORDER BY id DESC LIMIT 500').all(id).map(mapEvent),
    };
  }

  updateWorkItemFields(id, patch) {
    const current = this.getWorkItem(id);
    if (!current) return null;
    const next = {
      title: patch.title ?? current.title,
      goal: patch.goal ?? current.goal,
      acceptanceCriteria: patch.acceptanceCriteria ?? current.acceptanceCriteria,
      workDir: patch.workDir ?? current.workDir,
    };
    const contractChanged = next.goal !== current.goal
      || JSON.stringify(next.acceptanceCriteria) !== JSON.stringify(current.acceptanceCriteria);
    const now = this.now();
    this.db.prepare(`UPDATE work_items SET title = ?, goal = ?, acceptance_criteria = ?,
      work_dir = ?, revision = revision + ?, updated_at = ? WHERE id = ?`).run(
      next.title,
      next.goal,
      stringify(next.acceptanceCriteria),
      next.workDir,
      contractChanged ? 1 : 0,
      now,
      id,
    );
    this.appendEvent(id, contractChanged ? 'work_item.contract_updated' : 'work_item.updated', patch);
    return { workItem: this.getWorkItem(id), contractChanged };
  }

  setWorkItemState(id, status, refs = {}) {
    const now = this.now();
    const current = this.getWorkItem(id);
    if (!current) return;
    const currentActionId = Object.prototype.hasOwnProperty.call(refs, 'currentActionId')
      ? refs.currentActionId
      : current.currentActionId;
    const currentRunId = Object.prototype.hasOwnProperty.call(refs, 'currentRunId')
      ? refs.currentRunId
      : current.currentRunId;
    this.db.prepare(`UPDATE work_items SET status = ?, current_action_id = ?, current_run_id = ?, updated_at = ? WHERE id = ?`).run(
      status,
      currentActionId ?? null,
      currentRunId ?? null,
      now,
      id,
    );
  }

  setActionState(id, status, currentRunId = null) {
    this.db.prepare('UPDATE actions SET status = ?, current_run_id = ?, updated_at = ? WHERE id = ?')
      .run(status, currentRunId, this.now(), id);
  }

  supersedeOpenActions(workItemId) {
    this.db.prepare(`UPDATE actions SET status = 'superseded', current_run_id = NULL, updated_at = ?
      WHERE work_item_id = ? AND status IN ('ready','running','waiting')`).run(this.now(), workItemId);
  }

  claimReadyAction(ownerBootId, leaseMs = 60_000) {
    return withTransaction(this.db, () => {
      const row = this.db.prepare(`SELECT a.* FROM actions a
        JOIN work_items w ON w.id = a.work_item_id
        WHERE a.status = 'ready' AND w.status IN ('ready','running')
        ORDER BY a.updated_at ASC, a.sequence ASC LIMIT 1`).get();
      if (!row) return null;
      const now = this.now();
      const runId = randomUUID();
      const leaseEpoch = Number(row.lease_epoch) + 1;
      const changed = this.db.prepare(`UPDATE actions SET status = 'running', attempt = attempt + 1,
        current_run_id = ?, lease_epoch = ?, updated_at = ? WHERE id = ? AND status = 'ready'`)
        .run(runId, leaseEpoch, now, row.id);
      if (Number(changed.changes) !== 1) return null;
      this.db.prepare(`INSERT INTO runs
        (id, action_id, work_item_id, owner_boot_id, lease_epoch, status, started_at,
         expires_at, evidence)
        VALUES (?, ?, ?, ?, ?, 'running', ?, ?, '[]')`).run(
        runId,
        row.id,
        row.work_item_id,
        ownerBootId,
        leaseEpoch,
        now,
        now + leaseMs,
      );
      this.db.prepare(`UPDATE work_items SET status = 'running', current_action_id = ?,
        current_run_id = ?, updated_at = ? WHERE id = ?`).run(row.id, runId, now, row.work_item_id);
      this.appendEvent(row.work_item_id, 'run.claimed', { ownerBootId, leaseEpoch }, { actionId: row.id, runId });
      return {
        workItem: this.getWorkItem(row.work_item_id),
        action: this.getAction(row.id),
        run: this.getRun(runId),
      };
    });
  }

  renewLease(runId, ownerBootId, leaseEpoch, leaseMs = 60_000) {
    const result = this.db.prepare(`UPDATE runs SET expires_at = ?
      WHERE id = ? AND owner_boot_id = ? AND lease_epoch = ? AND status = 'running'`).run(
      this.now() + leaseMs,
      runId,
      ownerBootId,
      leaseEpoch,
    );
    return Number(result.changes) === 1;
  }

  isActiveRun(runId, ownerBootId, leaseEpoch) {
    const row = this.db.prepare(`SELECT 1 AS ok FROM runs
      WHERE id = ? AND owner_boot_id = ? AND lease_epoch = ? AND status = 'running'`).get(
      runId,
      ownerBootId,
      leaseEpoch,
    );
    return !!row;
  }

  finishRun(runId, ownerBootId, leaseEpoch, result) {
    return withTransaction(this.db, () => {
      const run = this.db.prepare(`SELECT * FROM runs
        WHERE id = ? AND owner_boot_id = ? AND lease_epoch = ? AND status = 'running'`).get(
        runId,
        ownerBootId,
        leaseEpoch,
      );
      if (!run) return null;
      const now = this.now();
      this.db.prepare(`UPDATE runs SET status = ?, ended_at = ?, summary = ?, evidence = ?,
        waiting_reason = ?, error = ? WHERE id = ?`).run(
        result.outcome,
        now,
        result.summary || '',
        stringify(result.evidence || []),
        result.waitingReason || null,
        result.error || null,
        runId,
      );
      return {
        run: this.getRun(runId),
        action: this.getAction(run.action_id),
        workItem: this.getWorkItem(run.work_item_id),
      };
    });
  }

  recoverInterruptedRuns(ownerBootId) {
    return withTransaction(this.db, () => {
      const now = this.now();
      const rows = this.db.prepare(`SELECT * FROM runs
        WHERE status = 'running' AND (owner_boot_id != ? OR expires_at <= ?)`).all(ownerBootId, now);
      for (const row of rows) {
        this.db.prepare(`UPDATE runs SET status = 'interrupted', ended_at = ?,
          error = 'Agent process or lease ended before the Run submitted a terminal outcome' WHERE id = ?`).run(now, row.id);
        const action = this.getAction(row.action_id);
        const retryable = action && action.type !== 'deliver' && action.attempt < action.maxAttempts;
        this.setActionState(row.action_id, retryable ? 'ready' : 'failed');
        this.setWorkItemState(row.work_item_id, retryable ? 'ready' : 'needs_attention', {
          currentActionId: row.action_id,
          currentRunId: null,
        });
        this.appendEvent(row.work_item_id, 'run.interrupted', { retryable }, { actionId: row.action_id, runId: row.id });
      }
      return rows.length;
    });
  }
}
