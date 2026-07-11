import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { normalizeEvidence } from './evidence.js';

const SCHEMA_VERSION = 4;
const OPEN_ACTION_STATUSES = "'ready','running','waiting'";
const MAX_REUSABLE_CONTEXT_ITEMS = 12;

function canonicalWorkspaceKey(workDir) {
  if (typeof workDir !== 'string' || !workDir.trim()) return '';
  try { return realpathSync(resolve(workDir.trim())); } catch { return ''; }
}

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
    workflowSnapshot: parseJson(row.workflow_snapshot, null),
    status: row.status,
    currentActionId: row.current_action_id || null,
    currentRunId: row.current_run_id || null,
    workDir: row.work_dir || '',
    workspaceKey: row.workspace_key || '',
    reuseMemory: row.reuse_memory !== 0,
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
    stageId: row.stage_id || row.type,
    assignmentPolicy: parseJson(row.assignment_policy, null),
    modelPolicy: parseJson(row.model_policy, null),
    requiredRole: row.required_role || '',
    instruction: row.instruction,
    context: parseJson(row.context, []),
    contractRevision: row.contract_revision,
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
    toolPolicySnapshot: parseJson(row.tool_policy_snapshot, null),
    summary: row.summary || '',
    evidence: normalizeEvidence(parseJson(row.evidence, [])),
    waitingReason: row.waiting_reason || null,
    error: row.error || null,
    reviewDecision: row.review_decision || null,
    contractPatch: parseJson(row.contract_patch, null),
    loopCount: Math.max(0, Number(row.loop_count) || 0),
    toolCount: Math.max(0, Number(row.tool_count) || 0),
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

function hasColumn(db, table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some(row => row.name === column);
}

export class WorkItemStore {
  constructor(dbPath, options = {}) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.now = typeof options.now === 'function' ? options.now : () => Date.now();
    this.onTransitionStep = typeof options.onTransitionStep === 'function'
      ? options.onTransitionStep
      : null;
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
        workflow_snapshot TEXT,
        status TEXT NOT NULL,
        current_action_id TEXT,
        current_run_id TEXT,
        work_dir TEXT NOT NULL DEFAULT '',
        workspace_key TEXT NOT NULL DEFAULT '',
        reuse_memory INTEGER NOT NULL DEFAULT 1,
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
        stage_id TEXT,
        assignment_policy TEXT,
        model_policy TEXT,
        instruction TEXT NOT NULL,
        context TEXT NOT NULL DEFAULT '[]',
        contract_revision INTEGER NOT NULL DEFAULT 1,
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
        tool_policy_snapshot TEXT,
        summary TEXT,
        evidence TEXT NOT NULL DEFAULT '[]',
        waiting_reason TEXT,
        error TEXT,
        review_decision TEXT,
        contract_patch TEXT,
        loop_count INTEGER NOT NULL DEFAULT 0,
        tool_count INTEGER NOT NULL DEFAULT 0
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

    // The feature shipped first as an unmerged PR, but keep the store tolerant
    // of databases created by review builds.
    if (!hasColumn(this.db, 'work_items', 'workspace_key')) {
      withTransaction(this.db, () => {
        this.db.exec("ALTER TABLE work_items ADD COLUMN workspace_key TEXT NOT NULL DEFAULT ''");
        const update = this.db.prepare('UPDATE work_items SET workspace_key = ? WHERE id = ?');
        for (const row of this.db.prepare("SELECT id, work_dir FROM work_items WHERE work_dir != ''").all()) {
          const workspaceKey = canonicalWorkspaceKey(row.work_dir);
          if (workspaceKey) update.run(workspaceKey, row.id);
        }
      });
    }
    if (!hasColumn(this.db, 'work_items', 'reuse_memory')) {
      this.db.exec('ALTER TABLE work_items ADD COLUMN reuse_memory INTEGER NOT NULL DEFAULT 1');
    }
    if (!hasColumn(this.db, 'actions', 'context')) {
      this.db.exec("ALTER TABLE actions ADD COLUMN context TEXT NOT NULL DEFAULT '[]'");
    }
    if (!hasColumn(this.db, 'actions', 'contract_revision')) {
      this.db.exec('ALTER TABLE actions ADD COLUMN contract_revision INTEGER NOT NULL DEFAULT 1');
    }
    if (!hasColumn(this.db, 'runs', 'tool_policy_snapshot')) {
      this.db.exec('ALTER TABLE runs ADD COLUMN tool_policy_snapshot TEXT');
    }
    if (!hasColumn(this.db, 'runs', 'review_decision')) {
      this.db.exec('ALTER TABLE runs ADD COLUMN review_decision TEXT');
    }
    if (!hasColumn(this.db, 'runs', 'contract_patch')) {
      this.db.exec('ALTER TABLE runs ADD COLUMN contract_patch TEXT');
    }
    if (!hasColumn(this.db, 'runs', 'loop_count')) {
      this.db.exec('ALTER TABLE runs ADD COLUMN loop_count INTEGER NOT NULL DEFAULT 0');
    }
    if (!hasColumn(this.db, 'runs', 'tool_count')) {
      this.db.exec('ALTER TABLE runs ADD COLUMN tool_count INTEGER NOT NULL DEFAULT 0');
    }
    if (!hasColumn(this.db, 'work_items', 'workflow_snapshot')) {
      this.db.exec('ALTER TABLE work_items ADD COLUMN workflow_snapshot TEXT');
    }
    if (!hasColumn(this.db, 'actions', 'stage_id')) {
      this.db.exec('ALTER TABLE actions ADD COLUMN stage_id TEXT');
    }
    if (!hasColumn(this.db, 'actions', 'assignment_policy')) {
      this.db.exec('ALTER TABLE actions ADD COLUMN assignment_policy TEXT');
    }
    if (!hasColumn(this.db, 'actions', 'model_policy')) {
      this.db.exec('ALTER TABLE actions ADD COLUMN model_policy TEXT');
    }
    this.db.prepare(`INSERT INTO schema_meta(key, value) VALUES('schema_version', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(String(SCHEMA_VERSION));
  }

  close() {
    this.db.close();
  }

  appendEvent(workItemId, type, data = {}, refs = {}) {
    const result = this.db.prepare(`INSERT INTO events
      (work_item_id, action_id, run_id, type, data, created_at)
      VALUES (?, ?, ?, ?, ?, ?)`).run(
      workItemId,
      refs.actionId || null,
      refs.runId || null,
      type,
      stringify(data),
      this.now(),
    );
    return Number(result.lastInsertRowid);
  }

  createWorkItem(input, firstAction) {
    return withTransaction(this.db, () => {
      const now = this.now();
      const id = input.id || randomUUID();
      const workspaceKey = canonicalWorkspaceKey(input.workDir);
      this.db.prepare(`INSERT INTO work_items
        (id, revision, title, goal, acceptance_criteria, workflow_template, workflow_snapshot, status,
         current_action_id, current_run_id, work_dir, workspace_key, reuse_memory, origin, linked_session_ids,
         created_at, updated_at)
        VALUES (?, 1, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?)`).run(
        id,
        input.title,
        input.goal,
        stringify(input.acceptanceCriteria || []),
        input.workflowTemplate || 'software-change',
        stringify(input.workflowSnapshot || null),
        firstAction ? 'ready' : 'draft',
        input.workDir || '',
        workspaceKey,
        input.reuseMemory === false ? 0 : 1,
        stringify(input.origin || null),
        stringify(input.linkedSessionIds || []),
        now,
        now,
      );
      let action = null;
      if (firstAction) {
        action = this.#insertAction(id, { ...firstAction, contractRevision: 1 }, 1, now);
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
      stageId: input.stageId || input.type,
      assignmentPolicy: input.assignmentPolicy || null,
      modelPolicy: input.modelPolicy || null,
      requiredRole: input.requiredRole || '',
      instruction: input.instruction || '',
      context: Array.isArray(input.context) ? input.context : [],
      contractRevision: Number.isInteger(input.contractRevision) ? input.contractRevision : 1,
      status: input.status || 'ready',
      attempt: Number.isInteger(input.attempt) ? input.attempt : 0,
      maxAttempts: Number.isInteger(input.maxAttempts) ? input.maxAttempts : 2,
      currentRunId: null,
      leaseEpoch: 0,
      createdAt: now,
      updatedAt: now,
    };
    this.db.prepare(`INSERT INTO actions
      (id, work_item_id, sequence, type, required_role, stage_id, assignment_policy, model_policy,
       instruction, context, contract_revision, status, attempt, max_attempts, current_run_id,
       lease_epoch, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, ?, ?)`).run(
      action.id,
      workItemId,
      action.sequence,
      action.type,
      action.requiredRole,
      action.stageId,
      stringify(action.assignmentPolicy),
      stringify(action.modelPolicy),
      action.instruction,
      stringify(action.context),
      action.contractRevision,
      action.status,
      action.attempt,
      action.maxAttempts,
      now,
      now,
    );
    return action;
  }

  #nextSequence(workItemId) {
    const row = this.db.prepare('SELECT COALESCE(MAX(sequence), 0) AS seq FROM actions WHERE work_item_id = ?').get(workItemId);
    return Number(row.seq) + 1;
  }

  createNextAction(workItemId, input) {
    return this.#insertAction(workItemId, input, this.#nextSequence(workItemId));
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

  listCompletedRuns(workItemId) {
    return this.db.prepare(`SELECT r.*, a.type AS action_type FROM runs r
      JOIN actions a ON a.id = r.action_id
      WHERE r.work_item_id = ? AND r.status != 'running'
      ORDER BY r.started_at ASC`).all(workItemId).map(row => ({
        ...mapRun(row),
        actionType: row.action_type,
      }));
  }

  listWorkItems(filters = {}) {
    const where = [];
    const values = [];
    if (typeof filters.status === 'string' && filters.status) {
      where.push('status = ?');
      values.push(filters.status);
    }
    if (typeof filters.sessionId === 'string' && filters.sessionId.trim()) {
      const sessionId = filters.sessionId.trim();
      where.push('(instr(origin, ?) > 0 OR instr(linked_session_ids, ?) > 0)');
      values.push(`\"sessionId\":${JSON.stringify(sessionId)}`, JSON.stringify(sessionId));
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

  getReusableContext(workDir, excludeWorkItemId = null) {
    const workspaceKey = canonicalWorkspaceKey(workDir);
    if (!workspaceKey) return [];
    const rows = this.db.prepare(`SELECT r.*, a.type AS action_type, a.required_role,
        w.title AS source_title
      FROM runs r
      JOIN actions a ON a.id = r.action_id
      JOIN work_items w ON w.id = r.work_item_id
      WHERE w.workspace_key = ? AND w.reuse_memory = 1 AND w.id != ? AND w.status = 'done'
        AND r.status = 'completed' AND length(trim(COALESCE(r.summary, ''))) > 0
      ORDER BY r.ended_at DESC, r.started_at DESC
      LIMIT ?`).all(workspaceKey, excludeWorkItemId || '', MAX_REUSABLE_CONTEXT_ITEMS);
    return rows.reverse().map(row => {
      const run = mapRun(row);
      return {
        type: row.action_type,
        role: row.required_role,
        summary: run.summary,
        evidence: run.evidence,
        reviewDecision: run.reviewDecision,
        sourceTitle: row.source_title,
      };
    });
  }

  addActionGuidance(id, guidance, expected, makeAction) {
    return withTransaction(this.db, () => {
      const workItem = this.getWorkItem(id);
      if (!workItem) return null;
      if (workItem.currentActionId !== expected.actionId || workItem.revision !== expected.revision) {
        throw new Error('Action changed before guidance was applied; refresh and try again');
      }
      if (!['ready', 'running'].includes(workItem.status)) {
        throw new Error(`WorkItem in ${workItem.status} cannot accept Action guidance`);
      }
      const previous = workItem.currentActionId ? this.getAction(workItem.currentActionId) : null;
      if (!previous || !['ready', 'running'].includes(previous.status)) {
        throw new Error('WorkItem has no active Action for guidance');
      }
      const now = this.now();
      this.#invalidateExecution(
        workItem,
        'superseded',
        'superseded',
        'Action restarted after user guidance',
        now,
      );
      const action = this.#insertAction(id, {
        ...makeAction(workItem, previous),
        contractRevision: workItem.revision,
      }, this.#nextSequence(id), now);
      this.db.prepare(`UPDATE work_items SET status = 'ready', current_action_id = ?,
        current_run_id = NULL, updated_at = ? WHERE id = ?`).run(action.id, now, id);
      this.appendEvent(id, 'action.guidance_added', { guidance }, { actionId: action.id });
      return this.getWorkItemDetail(id);
    });
  }

  #invalidateExecution(workItem, actionStatus, runStatus, reason, now) {
    if (workItem.currentRunId) {
      this.db.prepare(`UPDATE runs SET status = ?, ended_at = ?, error = ?
        WHERE id = ? AND status = 'running'`).run(runStatus, now, reason, workItem.currentRunId);
    }
    this.db.prepare(`UPDATE actions SET status = ?, current_run_id = NULL, updated_at = ?
      WHERE work_item_id = ? AND status IN (${OPEN_ACTION_STATUSES})`).run(actionStatus, now, workItem.id);
  }

  updateWorkItemAtomic(id, patch, makeInitialAction) {
    return withTransaction(this.db, () => {
      const current = this.getWorkItem(id);
      if (!current) return null;
      if (['done', 'cancelled'].includes(current.status)) {
        throw new Error(`Cannot update WorkItem in ${current.status}`);
      }
      const next = {
        title: patch.title ?? current.title,
        goal: patch.goal ?? current.goal,
        acceptanceCriteria: patch.acceptanceCriteria ?? current.acceptanceCriteria,
        workDir: patch.workDir ?? current.workDir,
      };
      const contractChanged = next.goal !== current.goal
        || next.workDir !== current.workDir
        || JSON.stringify(next.acceptanceCriteria) !== JSON.stringify(current.acceptanceCriteria);
      const now = this.now();
      const revision = current.revision + (contractChanged ? 1 : 0);
      if (contractChanged) {
        this.#invalidateExecution(
          current,
          'superseded',
          'superseded',
          'WorkItem contract changed while this Run was active',
          now,
        );
      }
      this.db.prepare(`UPDATE work_items SET title = ?, goal = ?, acceptance_criteria = ?,
        work_dir = ?, workspace_key = ?, revision = ?, updated_at = ? WHERE id = ?`).run(
        next.title,
        next.goal,
        stringify(next.acceptanceCriteria),
        next.workDir,
        canonicalWorkspaceKey(next.workDir),
        revision,
        now,
        id,
      );
      let action = null;
      if (contractChanged) {
        const updated = this.getWorkItem(id);
        action = this.#insertAction(id, {
          ...makeInitialAction(updated),
          contractRevision: revision,
        }, this.#nextSequence(id), now);
        this.db.prepare(`UPDATE work_items SET status = 'ready', current_action_id = ?,
          current_run_id = NULL, updated_at = ? WHERE id = ?`).run(action.id, now, id);
      }
      this.appendEvent(id, contractChanged ? 'workflow.retriaged' : 'work_item.updated', {
        revision,
        changedFields: Object.keys(patch || {}),
      }, { actionId: action?.id });
      return { workItem: this.getWorkItem(id), contractChanged };
    });
  }

  cancelWorkItemAtomic(id) {
    return withTransaction(this.db, () => {
      const workItem = this.getWorkItem(id);
      if (!workItem) return null;
      if (workItem.status === 'done') throw new Error('Completed WorkItem cannot be cancelled');
      if (workItem.status === 'cancelled') return workItem;
      const now = this.now();
      this.#invalidateExecution(
        workItem,
        'cancelled',
        'cancelled',
        'WorkItem was cancelled',
        now,
      );
      this.db.prepare(`UPDATE work_items SET status = 'cancelled', current_action_id = NULL,
        current_run_id = NULL, updated_at = ? WHERE id = ?`).run(now, id);
      this.appendEvent(id, 'work_item.cancelled');
      return this.getWorkItem(id);
    });
  }

  startWorkItemAtomic(id, makeInitialAction) {
    return withTransaction(this.db, () => {
      const workItem = this.getWorkItem(id);
      if (!workItem) return null;
      if (['done', 'cancelled'].includes(workItem.status)) {
        throw new Error(`Cannot start WorkItem in ${workItem.status}`);
      }
      const current = workItem.currentActionId ? this.getAction(workItem.currentActionId) : null;
      if (current?.status === 'ready') return this.getWorkItemDetail(id);
      if (workItem.status !== 'draft') {
        throw new Error(`WorkItem in ${workItem.status} must be resumed with retry`);
      }
      const now = this.now();
      const action = this.#insertAction(id, {
        ...makeInitialAction(workItem),
        contractRevision: workItem.revision,
      }, this.#nextSequence(id), now);
      this.db.prepare(`UPDATE work_items SET status = 'ready', current_action_id = ?,
        current_run_id = NULL, updated_at = ? WHERE id = ?`).run(action.id, now, id);
      this.appendEvent(id, 'work_item.started', {}, { actionId: action.id });
      return this.getWorkItemDetail(id);
    });
  }

  retryWorkItemAtomic(id, makeAction) {
    return withTransaction(this.db, () => {
      const workItem = this.getWorkItem(id);
      if (!workItem) return null;
      if (!['waiting', 'needs_attention'].includes(workItem.status)) {
        throw new Error(`WorkItem in ${workItem.status} does not need retry`);
      }
      const previous = workItem.currentActionId ? this.getAction(workItem.currentActionId) : null;
      const previousRun = previous
        ? mapRun(this.db.prepare(`SELECT * FROM runs WHERE work_item_id = ? AND action_id = ?
            AND status != 'running' ORDER BY ended_at DESC, started_at DESC LIMIT 1`).get(id, previous.id))
        : null;
      const now = this.now();
      const action = this.#insertAction(id, {
        ...makeAction(workItem, previous, previousRun),
        contractRevision: workItem.revision,
      }, this.#nextSequence(id), now);
      this.db.prepare(`UPDATE work_items SET status = 'ready', current_action_id = ?,
        current_run_id = NULL, updated_at = ? WHERE id = ?`).run(action.id, now, id);
      this.appendEvent(id, 'work_item.retried', {}, { actionId: action.id });
      return this.getWorkItemDetail(id);
    });
  }

  claimReadyAction(ownerBootId, leaseMs = 60_000) {
    return withTransaction(this.db, () => {
      const row = this.db.prepare(`SELECT a.* FROM actions a
        JOIN work_items w ON w.id = a.work_item_id
        WHERE a.status = 'ready' AND a.current_run_id IS NULL
          AND w.status = 'ready' AND w.current_action_id = a.id AND w.current_run_id IS NULL
        ORDER BY a.updated_at ASC, a.sequence ASC LIMIT 1`).get();
      if (!row) return null;
      const now = this.now();
      const runId = randomUUID();
      const leaseEpoch = Number(row.lease_epoch) + 1;
      const changedAction = this.db.prepare(`UPDATE actions SET status = 'running', attempt = attempt + 1,
        current_run_id = ?, lease_epoch = ?, updated_at = ?
        WHERE id = ? AND status = 'ready' AND current_run_id IS NULL`).run(
        runId,
        leaseEpoch,
        now,
        row.id,
      );
      if (Number(changedAction.changes) !== 1) return null;
      const changedWorkItem = this.db.prepare(`UPDATE work_items SET status = 'running',
        current_run_id = ?, updated_at = ? WHERE id = ? AND status = 'ready'
        AND current_action_id = ? AND current_run_id IS NULL`).run(
        runId,
        now,
        row.work_item_id,
        row.id,
      );
      if (Number(changedWorkItem.changes) !== 1) throw new Error('WorkItem claim lost its current Action');
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
      this.appendEvent(row.work_item_id, 'run.claimed', { ownerBootId, leaseEpoch }, { actionId: row.id, runId });
      return {
        workItem: this.getWorkItem(row.work_item_id),
        action: this.getAction(row.id),
        run: this.getRun(runId),
      };
    });
  }

  #activeRunRow(runId, ownerBootId, leaseEpoch, requireUnexpired = true) {
    return this.db.prepare(`SELECT r.* FROM runs r
      JOIN actions a ON a.id = r.action_id
      JOIN work_items w ON w.id = r.work_item_id
      WHERE r.id = ? AND r.owner_boot_id = ? AND r.lease_epoch = ? AND r.status = 'running'
        AND a.status = 'running' AND a.current_run_id = r.id AND a.lease_epoch = r.lease_epoch
        AND w.status = 'running' AND w.current_action_id = a.id AND w.current_run_id = r.id
        ${requireUnexpired ? 'AND r.expires_at > ?' : ''}`).get(
      runId,
      ownerBootId,
      leaseEpoch,
      ...(requireUnexpired ? [this.now()] : []),
    );
  }

  renewLease(runId, ownerBootId, leaseEpoch, leaseMs = 60_000) {
    return withTransaction(this.db, () => {
      const active = this.#activeRunRow(runId, ownerBootId, leaseEpoch, true);
      if (!active) return false;
      const result = this.db.prepare(`UPDATE runs SET expires_at = ?
        WHERE id = ? AND status = 'running' AND expires_at > ?`).run(
        this.now() + leaseMs,
        runId,
        this.now(),
      );
      return Number(result.changes) === 1;
    });
  }

  isActiveRun(runId, ownerBootId, leaseEpoch) {
    return !!this.#activeRunRow(runId, ownerBootId, leaseEpoch, true);
  }

  interruptRun(runId, ownerBootId, leaseEpoch, reason = 'Work Center watcher stopped') {
    return withTransaction(this.db, () => {
      const active = this.#activeRunRow(runId, ownerBootId, leaseEpoch, false);
      if (!active) return false;
      const action = this.getAction(active.action_id);
      const now = this.now();
      const retryable = action.type !== 'deliver' && action.attempt < action.maxAttempts;
      const runChanged = this.db.prepare(`UPDATE runs SET status = 'interrupted', ended_at = ?, error = ?
        WHERE id = ? AND owner_boot_id = ? AND lease_epoch = ? AND status = 'running'`).run(
        now,
        reason,
        runId,
        ownerBootId,
        leaseEpoch,
      );
      if (Number(runChanged.changes) !== 1) return false;
      const actionChanged = this.db.prepare(`UPDATE actions SET status = ?, current_run_id = NULL,
        updated_at = ? WHERE id = ? AND status = 'running' AND current_run_id = ?
        AND lease_epoch = ?`).run(
        retryable ? 'ready' : 'failed',
        now,
        action.id,
        runId,
        leaseEpoch,
      );
      if (Number(actionChanged.changes) !== 1) throw new Error('Run interruption lost the Action fence');
      const itemChanged = this.db.prepare(`UPDATE work_items SET status = ?, current_run_id = NULL,
        updated_at = ? WHERE id = ? AND status = 'running' AND current_action_id = ?
        AND current_run_id = ?`).run(
        retryable ? 'ready' : 'needs_attention',
        now,
        active.work_item_id,
        action.id,
        runId,
      );
      if (Number(itemChanged.changes) !== 1) throw new Error('Run interruption lost the WorkItem fence');
      this.appendEvent(active.work_item_id, 'run.interrupted', { retryable, reason }, {
        actionId: action.id,
        runId,
      });
      return true;
    });
  }

  setRunExecutionSnapshots(runId, ownerBootId, leaseEpoch, snapshots) {
    return withTransaction(this.db, () => {
      if (!this.#activeRunRow(runId, ownerBootId, leaseEpoch, true)) return false;
      const result = this.db.prepare(`UPDATE runs SET role_snapshot = ?, vp_snapshot = ?,
        model_snapshot = ?, tool_policy_snapshot = ? WHERE id = ? AND status = 'running'
        AND role_snapshot IS NULL AND vp_snapshot IS NULL AND model_snapshot IS NULL
        AND tool_policy_snapshot IS NULL`).run(
        stringify(snapshots.roleSnapshot || null),
        stringify(snapshots.vpSnapshot || null),
        stringify(snapshots.modelSnapshot || null),
        stringify(snapshots.toolPolicySnapshot || null),
        runId,
      );
      return Number(result.changes) === 1;
    });
  }

  finalizeRun(runId, ownerBootId, leaseEpoch, result, makeTransition) {
    return withTransaction(this.db, () => {
      const active = this.#activeRunRow(runId, ownerBootId, leaseEpoch, true);
      if (!active) return null;
      const action = this.getAction(active.action_id);
      const workItem = this.getWorkItem(active.work_item_id);
      const priorRuns = this.db.prepare(`SELECT * FROM runs
        WHERE work_item_id = ? AND id != ? AND status != 'running'
        ORDER BY started_at ASC`).all(workItem.id, runId).map(mapRun);
      const transition = makeTransition({ run: mapRun(active), action, workItem, priorRuns });
      if (!transition || !transition.actionStatus || !transition.workItemStatus) {
        throw new Error('Work Center transition plan is incomplete');
      }
      const now = this.now();
      this.db.prepare(`UPDATE runs SET status = ?, ended_at = ?, summary = ?, evidence = ?,
        waiting_reason = ?, error = ?, review_decision = ?, contract_patch = ?,
        loop_count = ?, tool_count = ? WHERE id = ?`).run(
        result.outcome,
        now,
        result.summary || '',
        stringify(normalizeEvidence(result.evidence)),
        result.waitingReason || null,
        result.error || null,
        result.reviewDecision || null,
        stringify(result.contractPatch || null),
        Math.max(0, Number(result.loopCount) || 0),
        Math.max(0, Number(result.toolCount) || 0),
        runId,
      );
      this.onTransitionStep?.('after_run_update');

      const changedAction = this.db.prepare(`UPDATE actions SET status = ?, current_run_id = NULL, updated_at = ?
        WHERE id = ? AND status = 'running' AND current_run_id = ?`).run(
        transition.actionStatus,
        now,
        action.id,
        runId,
      );
      if (Number(changedAction.changes) !== 1) {
        throw new Error('Work Center terminal transition lost the current Action fence');
      }

      let nextWorkItem = workItem;
      if (transition.contractPatch) {
        const patch = transition.contractPatch;
        const goal = patch.goal ?? workItem.goal;
        const criteria = patch.acceptanceCriteria ?? workItem.acceptanceCriteria;
        this.db.prepare(`UPDATE work_items SET goal = ?, acceptance_criteria = ?,
          revision = revision + 1, updated_at = ? WHERE id = ?`).run(
          goal,
          stringify(criteria),
          now,
          workItem.id,
        );
        nextWorkItem = this.getWorkItem(workItem.id);
      }

      let nextAction = null;
      if (transition.nextAction) {
        nextAction = this.#insertAction(workItem.id, {
          ...transition.nextAction,
          contractRevision: nextWorkItem.revision,
        }, this.#nextSequence(workItem.id), now);
      }
      const currentActionId = nextAction?.id
        ?? (transition.keepCurrentAction ? action.id : null);
      const changedWorkItem = this.db.prepare(`UPDATE work_items SET status = ?, current_action_id = ?,
        current_run_id = NULL, updated_at = ? WHERE id = ? AND current_run_id = ?
        AND current_action_id = ? AND status = 'running'`).run(
        transition.workItemStatus,
        currentActionId,
        now,
        workItem.id,
        runId,
        action.id,
      );
      if (Number(changedWorkItem.changes) !== 1) {
        throw new Error('Work Center terminal transition lost the current WorkItem fence');
      }
      this.onTransitionStep?.('before_event');
      this.appendEvent(workItem.id, transition.eventType, transition.eventData || {}, {
        actionId: action.id,
        runId,
      });
      return this.getWorkItemDetail(workItem.id);
    });
  }

  recoverInterruptedRuns(ownerBootId) {
    return withTransaction(this.db, () => {
      const now = this.now();
      const rows = this.db.prepare(`SELECT * FROM runs
        WHERE status = 'running' AND (owner_boot_id != ? OR expires_at <= ?)`).all(ownerBootId, now);
      for (const row of rows) {
        const action = this.getAction(row.action_id);
        const workItem = this.getWorkItem(row.work_item_id);
        const isCurrent = action?.status === 'running'
          && action.currentRunId === row.id
          && action.leaseEpoch === row.lease_epoch
          && workItem?.status === 'running'
          && workItem.currentActionId === action.id
          && workItem.currentRunId === row.id;
        if (!isCurrent) {
          const staleStatus = workItem?.status === 'cancelled' ? 'cancelled' : 'superseded';
          this.db.prepare(`UPDATE runs SET status = ?, ended_at = ?, error = ?
            WHERE id = ? AND status = 'running'`).run(
            staleStatus,
            now,
            'Run no longer owns the current WorkItem Action',
            row.id,
          );
          this.appendEvent(row.work_item_id, 'run.stale_recovered', { status: staleStatus }, {
            actionId: row.action_id,
            runId: row.id,
          });
          continue;
        }

        this.db.prepare(`UPDATE runs SET status = 'interrupted', ended_at = ?,
          error = 'Agent process or lease ended before the Run submitted a terminal outcome'
          WHERE id = ?`).run(now, row.id);
        const retryable = action.type !== 'deliver' && action.attempt < action.maxAttempts;
        this.db.prepare(`UPDATE actions SET status = ?, current_run_id = NULL, updated_at = ?
          WHERE id = ?`).run(retryable ? 'ready' : 'failed', now, action.id);
        this.db.prepare(`UPDATE work_items SET status = ?, current_action_id = ?,
          current_run_id = NULL, updated_at = ? WHERE id = ?`).run(
          retryable ? 'ready' : 'needs_attention',
          action.id,
          now,
          workItem.id,
        );
        this.appendEvent(workItem.id, 'run.interrupted', { retryable }, {
          actionId: action.id,
          runId: row.id,
        });
      }
      return rows.length;
    });
  }
}
