import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { normalizeEvidence } from './evidence.js';
import { normalizeActionCheckpoint } from './action-checkpoint.js';
import { runMatchesActionIdentity } from './action-identity.js';

const SCHEMA_VERSION = 17;
const OPEN_ACTION_STATUSES = "'ready','running','waiting'";
const MAX_REUSABLE_CONTEXT_ITEMS = 12;
const MAX_RUN_RESPONSE_CHARS = 65_536;

function normalizeRunResponse(value) {
  const response = typeof value === 'string' ? value : String(value || '');
  return response.slice(0, MAX_RUN_RESPONSE_CHARS);
}

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

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function actionSpecHash(action) {
  const spec = {
    type: action.type || '',
    stageId: action.stageId || action.type || '',
    assignmentPolicy: action.assignmentPolicy || null,
    modelPolicy: action.modelPolicy || null,
    dependsOnStageIds: [...new Set(action.dependsOnStageIds || [])].sort(),
    workspaceMode: action.workspaceMode || 'shared',
    changesRequestedStageId: action.changesRequestedStageId || null,
    requiredRole: action.requiredRole || '',
    instruction: action.instruction || '',
    brief: action.brief || null,
    context: Array.isArray(action.context) ? action.context : [],
    contractRevision: Number.isInteger(action.contractRevision) ? action.contractRevision : 1,
  };
  return createHash('sha256').update(stableJson(spec), 'utf8').digest('hex');
}

function mapWorkItem(row) {
  if (!row) return null;
  return {
    id: row.id,
    revision: row.revision,
    planRevision: Math.max(0, Number(row.plan_revision) || 0),
    executionSchemaVersion: Math.max(1, Number(row.execution_schema_version) || 1),
    ledgerRevision: Math.max(0, Number(row.ledger_revision) || 0),
    title: row.title,
    goal: row.goal,
    acceptanceCriteria: parseJson(row.acceptance_criteria, []),
    workflowTemplate: row.workflow_template,
    workflowSnapshot: parseJson(row.workflow_snapshot, null),
    status: row.status,
    currentActionId: row.current_action_id || null,
    currentAction: row.current_action_type ? {
      id: row.current_action_id,
      type: row.current_action_type,
      stageId: row.current_action_stage_id || row.current_action_type,
      status: row.current_action_status || null,
      brief: parseJson(row.current_action_brief, null),
    } : null,
    currentRunId: row.current_run_id || null,
    workDir: row.work_dir || '',
    workspaceKey: row.workspace_key || '',
    reuseMemory: row.reuse_memory !== 0,
    origin: parseJson(row.origin, null),
    linkedSessionIds: parseJson(row.linked_session_ids, []),
    actionCount: Math.max(0, Number(row.action_count) || 0),
    completedActionCount: Math.max(0, Number(row.completed_action_count) || 0),
    sessionContext: parseJson(row.session_context, []),
    messages: parseJson(row.messages, []),
    attachments: parseJson(row.attachments, []),
    executionStats: {
      llmRequestCount: Math.max(0, Number(row.usage_llm_request_count) || 0),
      loopCount: Math.max(0, Number(row.usage_loop_count) || 0),
      toolCount: Math.max(0, Number(row.usage_tool_count) || 0),
      inputTokens: Math.max(0, Number(row.usage_input_tokens) || 0),
      outputTokens: Math.max(0, Number(row.usage_output_tokens) || 0),
      cacheReadTokens: Math.max(0, Number(row.usage_cache_read_tokens) || 0),
      cacheWriteTokens: Math.max(0, Number(row.usage_cache_write_tokens) || 0),
      totalTokens: Math.max(0, Number(row.usage_total_tokens) || 0),
    },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function isGraphWorkItem(workItem) {
  return workItem?.workflowSnapshot?.executionMode === 'graph';
}

function graphExecutionState(workItem, actions) {
  if (!isGraphWorkItem(workItem)) return workItem;
  const current = (Array.isArray(actions) ? actions : [])
    .filter(action => !['superseded', 'cancelled'].includes(action.status));
  const activeActionIds = current
    .filter(action => ['ready', 'running'].includes(action.status))
    .map(action => action.id);
  const waitingIds = current.filter(action => action.status === 'waiting').map(action => action.id);
  const failedIds = current.filter(action => action.status === 'failed').map(action => action.id);
  const attentionActionIds = current
    .filter(action => ['waiting', 'failed'].includes(action.status))
    .map(action => action.id);
  const lifecycle = workItem.status === 'cancelled' ? 'cancelled'
    : current.length === 0 || workItem.status === 'draft' ? 'draft'
      : current.every(action => action.status === 'completed') ? 'done'
        : 'active';
  const attentionState = waitingIds.length > 0 && failedIds.length > 0 ? 'mixed'
    : waitingIds.length > 0 ? 'waiting'
      : failedIds.length > 0 ? 'failed'
        : 'none';
  return {
    ...workItem,
    lifecycle,
    attentionState,
    activeActionIds,
    attentionActionIds,
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
    dependsOnStageIds: parseJson(row.depends_on_stage_ids, []),
    workspaceMode: row.workspace_mode || 'shared',
    changesRequestedStageId: row.changes_requested_stage_id || null,
    workspace: parseJson(row.workspace, null),
    requiredRole: row.required_role || '',
    instruction: row.instruction,
    brief: parseJson(row.brief, null),
    context: parseJson(row.context, []),
    contractRevision: row.contract_revision,
    generation: Math.max(1, Number(row.generation) || 1),
    specHash: row.spec_hash || '',
    resultRunId: row.result_run_id || null,
    status: row.status,
    attempt: row.attempt,
    maxAttempts: row.max_attempts,
    currentRunId: row.current_run_id || null,
    leaseEpoch: row.lease_epoch,
    replacesActionId: row.replaces_action_id || null,
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
    contextSnapshot: parseJson(row.context_snapshot, null),
    executionManifest: parseJson(row.execution_manifest, null),
    response: row.response || '',
    summary: row.summary || '',
    evidence: normalizeEvidence(parseJson(row.evidence, [])),
    waitingReason: row.waiting_reason || null,
    error: row.error || null,
    failureKind: row.failure_kind || null,
    failureCode: row.failure_code || null,
    reviewDecision: row.review_decision || null,
    contractPatch: parseJson(row.contract_patch, null),
    loopCount: Math.max(0, Number(row.loop_count) || 0),
    toolCount: Math.max(0, Number(row.tool_count) || 0),
    llmRequestCount: Math.max(0, Number(row.llm_request_count) || 0),
    inputTokens: Math.max(0, Number(row.input_tokens) || 0),
    outputTokens: Math.max(0, Number(row.output_tokens) || 0),
    cacheReadTokens: Math.max(0, Number(row.cache_read_tokens) || 0),
    cacheWriteTokens: Math.max(0, Number(row.cache_write_tokens) || 0),
    totalTokens: Math.max(0, Number(row.total_tokens) || 0),
    progressRevision: Math.max(0, Number(row.progress_revision) || 0),
    checkpoint: normalizeActionCheckpoint(parseJson(row.checkpoint, null)),
    acceptingInput: row.accepting_input !== 0,
    actionGeneration: Math.max(1, Number(row.action_generation) || 1),
    actionSpecHash: row.action_spec_hash || parseJson(row.execution_manifest, null)?.actionSpecHash || '',
    actionAttempt: Math.max(1, Number(row.action_attempt) || 1),
  };
}

function mapPlanConflict(row) {
  if (!row) return null;
  return {
    id: row.id,
    workItemId: row.work_item_id,
    actionId: row.action_id || null,
    generation: Math.max(1, Number(row.generation) || 1),
    kind: row.kind,
    status: row.status,
    details: parseJson(row.details, {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    resolvedAt: row.resolved_at || null,
  };
}

function mapEvent(row) {
  if (!row) return null;
  return {
    id: row.id,
    workItemId: row.work_item_id,
    actionId: row.action_id || null,
    runId: row.run_id || null,
    actionGeneration: row.action_generation == null ? null : Math.max(1, Number(row.action_generation) || 1),
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
        plan_revision INTEGER NOT NULL DEFAULT 0,
        execution_schema_version INTEGER NOT NULL DEFAULT 2,
        ledger_revision INTEGER NOT NULL DEFAULT 0,
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
        session_context TEXT NOT NULL DEFAULT '[]',
        messages TEXT NOT NULL DEFAULT '[]',
        attachments TEXT NOT NULL DEFAULT '[]',
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
        depends_on_stage_ids TEXT NOT NULL DEFAULT '[]',
        workspace_mode TEXT NOT NULL DEFAULT 'shared',
        changes_requested_stage_id TEXT,
        workspace TEXT,
        instruction TEXT NOT NULL,
        brief TEXT,
        context TEXT NOT NULL DEFAULT '[]',
        contract_revision INTEGER NOT NULL DEFAULT 1,
        generation INTEGER NOT NULL DEFAULT 1,
        spec_hash TEXT NOT NULL DEFAULT '',
        result_run_id TEXT,
        status TEXT NOT NULL,
        attempt INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 2,
        current_run_id TEXT,
        lease_epoch INTEGER NOT NULL DEFAULT 0,
        replaces_action_id TEXT REFERENCES actions(id) ON DELETE SET NULL,
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
        context_snapshot TEXT,
        execution_manifest TEXT,
        summary TEXT,
        evidence TEXT NOT NULL DEFAULT '[]',
        waiting_reason TEXT,
        error TEXT,
        failure_kind TEXT,
        failure_code TEXT,
        review_decision TEXT,
        contract_patch TEXT,
        response TEXT NOT NULL DEFAULT '',
        loop_count INTEGER NOT NULL DEFAULT 0,
        tool_count INTEGER NOT NULL DEFAULT 0,
        llm_request_count INTEGER NOT NULL DEFAULT 0,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        cache_read_tokens INTEGER NOT NULL DEFAULT 0,
        cache_write_tokens INTEGER NOT NULL DEFAULT 0,
        total_tokens INTEGER NOT NULL DEFAULT 0,
        progress_revision INTEGER NOT NULL DEFAULT 0,
        checkpoint TEXT,
        accepting_input INTEGER NOT NULL DEFAULT 1,
        action_generation INTEGER NOT NULL DEFAULT 1,
        action_spec_hash TEXT NOT NULL DEFAULT '',
        action_attempt INTEGER NOT NULL DEFAULT 1
      );
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        work_item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
        action_id TEXT,
        run_id TEXT,
        action_generation INTEGER,
        type TEXT NOT NULL,
        data TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS pending_action_inputs (
        event_id INTEGER PRIMARY KEY REFERENCES events(id) ON DELETE CASCADE,
        work_item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
        action_id TEXT NOT NULL REFERENCES actions(id) ON DELETE CASCADE,
        run_id TEXT,
        text TEXT NOT NULL,
        attachments TEXT NOT NULL DEFAULT '[]',
        consumed_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS plan_audits (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        work_item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
        proposal_id TEXT NOT NULL,
        base_plan_revision INTEGER NOT NULL,
        plan_revision INTEGER NOT NULL,
        kind TEXT NOT NULL,
        action_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        data TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        UNIQUE(work_item_id, proposal_id)
      );
      CREATE TABLE IF NOT EXISTS plan_conflicts (
        id TEXT PRIMARY KEY,
        work_item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
        action_id TEXT REFERENCES actions(id) ON DELETE SET NULL,
        generation INTEGER NOT NULL DEFAULT 1,
        kind TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'open',
        details TEXT NOT NULL DEFAULT '{}',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        resolved_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_plan_conflicts_work_item ON plan_conflicts(work_item_id, created_at, id);
      CREATE INDEX IF NOT EXISTS idx_work_items_status_updated ON work_items(status, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_actions_ready ON actions(status, updated_at, sequence);
      CREATE INDEX IF NOT EXISTS idx_runs_active ON runs(status, expires_at);
      CREATE INDEX IF NOT EXISTS idx_events_work_item ON events(work_item_id, id);
      CREATE INDEX IF NOT EXISTS idx_pending_action_inputs_action
        ON pending_action_inputs(action_id, consumed_at, event_id);
    `);

    const storedSchemaVersion = Number(
      this.db.prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'").get()?.value,
    ) || 0;

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
    if (!hasColumn(this.db, 'work_items', 'messages')) {
      this.db.exec("ALTER TABLE work_items ADD COLUMN messages TEXT NOT NULL DEFAULT '[]'");
    }
    if (!hasColumn(this.db, 'actions', 'brief')) {
      this.db.exec('ALTER TABLE actions ADD COLUMN brief TEXT');
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
    if (!hasColumn(this.db, 'runs', 'failure_kind')) {
      this.db.exec('ALTER TABLE runs ADD COLUMN failure_kind TEXT');
    }
    if (!hasColumn(this.db, 'runs', 'failure_code')) {
      this.db.exec('ALTER TABLE runs ADD COLUMN failure_code TEXT');
    }
    if (!hasColumn(this.db, 'runs', 'loop_count')) {
      this.db.exec('ALTER TABLE runs ADD COLUMN loop_count INTEGER NOT NULL DEFAULT 0');
    }
    if (!hasColumn(this.db, 'runs', 'tool_count')) {
      this.db.exec('ALTER TABLE runs ADD COLUMN tool_count INTEGER NOT NULL DEFAULT 0');
    }
    for (const column of [
      'llm_request_count',
      'input_tokens',
      'output_tokens',
      'cache_read_tokens',
      'cache_write_tokens',
      'total_tokens',
    ]) {
      if (!hasColumn(this.db, 'runs', column)) {
        this.db.exec(`ALTER TABLE runs ADD COLUMN ${column} INTEGER NOT NULL DEFAULT 0`);
      }
    }
    if (!hasColumn(this.db, 'runs', 'response')) {
      this.db.exec("ALTER TABLE runs ADD COLUMN response TEXT NOT NULL DEFAULT ''");
    }
    if (!hasColumn(this.db, 'runs', 'progress_revision')) {
      this.db.exec('ALTER TABLE runs ADD COLUMN progress_revision INTEGER NOT NULL DEFAULT 0');
    }
    if (!hasColumn(this.db, 'runs', 'checkpoint')) {
      this.db.exec('ALTER TABLE runs ADD COLUMN checkpoint TEXT');
    }
    if (!hasColumn(this.db, 'runs', 'accepting_input')) {
      this.db.exec('ALTER TABLE runs ADD COLUMN accepting_input INTEGER NOT NULL DEFAULT 1');
    }
    if (!hasColumn(this.db, 'work_items', 'workflow_snapshot')) {
      this.db.exec('ALTER TABLE work_items ADD COLUMN workflow_snapshot TEXT');
    }
    if (!hasColumn(this.db, 'work_items', 'session_context')) {
      this.db.exec("ALTER TABLE work_items ADD COLUMN session_context TEXT NOT NULL DEFAULT '[]'");
    }
    if (!hasColumn(this.db, 'work_items', 'attachments')) {
      this.db.exec("ALTER TABLE work_items ADD COLUMN attachments TEXT NOT NULL DEFAULT '[]'");
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
    if (!hasColumn(this.db, 'actions', 'depends_on_stage_ids')) {
      this.db.exec("ALTER TABLE actions ADD COLUMN depends_on_stage_ids TEXT NOT NULL DEFAULT '[]'");
    }
    if (!hasColumn(this.db, 'actions', 'workspace_mode')) {
      this.db.exec("ALTER TABLE actions ADD COLUMN workspace_mode TEXT NOT NULL DEFAULT 'shared'");
    }
    if (!hasColumn(this.db, 'actions', 'changes_requested_stage_id')) {
      this.db.exec('ALTER TABLE actions ADD COLUMN changes_requested_stage_id TEXT');
    }
    if (!hasColumn(this.db, 'actions', 'workspace')) {
      this.db.exec('ALTER TABLE actions ADD COLUMN workspace TEXT');
    }
    if (!hasColumn(this.db, 'work_items', 'plan_revision')) {
      this.db.exec('ALTER TABLE work_items ADD COLUMN plan_revision INTEGER NOT NULL DEFAULT 0');
    }
    if (!hasColumn(this.db, 'work_items', 'execution_schema_version')) {
      this.db.exec('ALTER TABLE work_items ADD COLUMN execution_schema_version INTEGER NOT NULL DEFAULT 1');
    }
    if (!hasColumn(this.db, 'work_items', 'ledger_revision')) {
      this.db.exec('ALTER TABLE work_items ADD COLUMN ledger_revision INTEGER NOT NULL DEFAULT 0');
    }
    if (!hasColumn(this.db, 'actions', 'generation')) {
      this.db.exec('ALTER TABLE actions ADD COLUMN generation INTEGER NOT NULL DEFAULT 1');
    }
    if (!hasColumn(this.db, 'actions', 'spec_hash')) {
      this.db.exec("ALTER TABLE actions ADD COLUMN spec_hash TEXT NOT NULL DEFAULT ''");
    }
    if (!hasColumn(this.db, 'actions', 'result_run_id')) {
      this.db.exec('ALTER TABLE actions ADD COLUMN result_run_id TEXT');
    }
    if (!hasColumn(this.db, 'actions', 'replaces_action_id')) {
      this.db.exec('ALTER TABLE actions ADD COLUMN replaces_action_id TEXT REFERENCES actions(id) ON DELETE SET NULL');
    }
    if (!hasColumn(this.db, 'runs', 'action_generation')) {
      this.db.exec('ALTER TABLE runs ADD COLUMN action_generation INTEGER NOT NULL DEFAULT 1');
    }
    if (!hasColumn(this.db, 'runs', 'action_spec_hash')) {
      this.db.exec("ALTER TABLE runs ADD COLUMN action_spec_hash TEXT NOT NULL DEFAULT ''");
    }
    if (!hasColumn(this.db, 'runs', 'action_attempt')) {
      this.db.exec('ALTER TABLE runs ADD COLUMN action_attempt INTEGER NOT NULL DEFAULT 1');
    }
    if (!hasColumn(this.db, 'events', 'action_generation')) {
      this.db.exec('ALTER TABLE events ADD COLUMN action_generation INTEGER');
    }
    if (!hasColumn(this.db, 'runs', 'context_snapshot')) {
      this.db.exec('ALTER TABLE runs ADD COLUMN context_snapshot TEXT');
    }
    if (!hasColumn(this.db, 'runs', 'execution_manifest')) {
      this.db.exec('ALTER TABLE runs ADD COLUMN execution_manifest TEXT');
    }
    if (storedSchemaVersion < SCHEMA_VERSION) {
      withTransaction(this.db, () => {
        const updateIdentity = this.db.prepare(`UPDATE runs SET action_generation = ?,
          action_spec_hash = ?, action_attempt = ? WHERE id = ?`);
        const attempts = new Map();
        for (const row of this.db.prepare(`SELECT id, action_id, action_generation, action_spec_hash,
          execution_manifest, started_at FROM runs ORDER BY action_id, started_at, id`).all()) {
          const manifest = parseJson(row.execution_manifest, null);
          const generation = Math.max(1, Number(manifest?.actionGeneration) || Number(row.action_generation) || 1);
          const key = `${row.action_id}\u0000${generation}`;
          const attempt = (attempts.get(key) || 0) + 1;
          attempts.set(key, attempt);
          updateIdentity.run(
            generation,
            manifest?.actionSpecHash || row.action_spec_hash || '',
            attempt,
            row.id,
          );
        }
      });
    }
    this.db.prepare(`INSERT INTO schema_meta(key, value) VALUES('schema_version', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(String(SCHEMA_VERSION));
  }

  close() {
    this.db.close();
  }

  appendEvent(workItemId, type, data = {}, refs = {}) {
    const actionGeneration = refs.actionGeneration
      ?? (refs.actionId ? this.getAction(refs.actionId)?.generation : null)
      ?? null;
    const result = this.db.prepare(`INSERT INTO events
      (work_item_id, action_id, run_id, action_generation, type, data, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
      workItemId,
      refs.actionId || null,
      refs.runId || null,
      actionGeneration,
      type,
      stringify(data),
      this.now(),
    );
    return Number(result.lastInsertRowid);
  }

  addActionInput(id, input, expected, updateReadyAction, attachments = null, addedAttachments = []) {
    return withTransaction(this.db, () => {
      const workItem = this.getWorkItem(id);
      if (!workItem) return null;
      const graphMode = workItem.workflowSnapshot?.executionMode === 'graph';
      const inputStatuses = graphMode
        ? ['ready', 'running', 'waiting', 'needs_attention']
        : ['ready', 'running'];
      if (!inputStatuses.includes(workItem.status)) {
        throw new Error(`WorkItem in ${workItem.status} cannot accept Action input`);
      }
      const action = this.getAction(expected.actionId);
      const actionMatches = graphMode
        ? action?.workItemId === id && action.generation === expected.generation
          && ['ready', 'running'].includes(action.status)
        : action?.id === workItem.currentActionId && ['ready', 'running'].includes(action?.status);
      const activeRun = action?.currentRunId ? this.getRun(action.currentRunId) : null;
      if (!actionMatches || activeRun?.acceptingInput === false || workItem.revision !== expected.revision) {
        throw new Error('Action changed before input was applied; refresh and try again');
      }
      const now = this.now();
      const revision = workItem.revision + 1;
      const updated = updateReadyAction(workItem, action);
      const changedAction = this.db.prepare(`UPDATE actions SET context = ?, instruction = ?, updated_at = ?
        WHERE id = ? AND status = ? AND current_run_id IS ?`).run(
        stringify(updated.context || []),
        updated.instruction || action.instruction,
        now,
        action.id,
        action.status,
        action.currentRunId,
      );
      if (Number(changedAction.changes) !== 1) {
        throw new Error('Action changed before input was applied; refresh and try again');
      }
      this.db.prepare(`UPDATE work_items SET attachments = ?, revision = ?, updated_at = ?
        WHERE id = ?`).run(
        stringify(Array.isArray(attachments) ? attachments : workItem.attachments),
        revision,
        now,
        id,
      );
      const projectedAttachments = (Array.isArray(addedAttachments) ? addedAttachments : []).map(attachment => ({
        id: attachment.id,
        name: attachment.name,
        mimeType: attachment.mimeType,
        size: Math.max(0, Number(attachment.size) || 0),
        isImage: attachment.isImage === true,
      }));
      const eventId = this.appendEvent(id, 'action.input_added', {
        text: input,
        attachments: projectedAttachments,
      }, { actionId: action.id, runId: action.currentRunId });
      if (action.status === 'running') {
        this.db.prepare(`INSERT INTO pending_action_inputs
          (event_id, work_item_id, action_id, run_id, text, attachments, consumed_at)
          VALUES (?, ?, ?, ?, ?, ?, NULL)`).run(
          eventId,
          id,
          action.id,
          action.currentRunId,
          input,
          stringify(projectedAttachments),
        );
      }
      return this.getWorkItemDetail(id);
    });
  }

  listPendingActionInputs(actionId, runId, ownerBootId, leaseEpoch) {
    const active = this.#activeRunRow(runId, ownerBootId, leaseEpoch, true);
    if (!active || active.action_id !== actionId) return [];
    return this.db.prepare(`SELECT * FROM pending_action_inputs
      WHERE action_id = ? AND consumed_at IS NULL ORDER BY event_id`).all(actionId).map(row => ({
      id: String(row.event_id),
      text: row.text || '',
      attachments: parseJson(row.attachments, []),
    }));
  }

  acknowledgeActionInput(eventId, actionId, runId, ownerBootId, leaseEpoch) {
    return withTransaction(this.db, () => {
      const active = this.#activeRunRow(runId, ownerBootId, leaseEpoch, true);
      if (!active || active.action_id !== actionId) return false;
      const result = this.db.prepare(`UPDATE pending_action_inputs SET consumed_at = ?
        WHERE event_id = ? AND action_id = ? AND consumed_at IS NULL`).run(
        this.now(), Number(eventId), actionId,
      );
      return Number(result.changes) === 1;
    });
  }

  appendRunLoop(runId, ownerBootId, leaseEpoch, loop = {}) {
    return withTransaction(this.db, () => {
      const active = this.#activeRunRow(runId, ownerBootId, leaseEpoch, true);
      if (!active) return null;
      const response = normalizeRunResponse(loop.response).trim();
      if (response) {
        this.appendEvent(active.work_item_id, 'run.loop_output', {
          loopNumber: Math.max(0, Number(loop.loopNumber) || 0),
          response,
          stopReason: loop.stopReason || null,
        }, { actionId: active.action_id, runId });
      }
      return this.getWorkItemDetail(active.work_item_id);
    });
  }

  createPlanConflict(workItemId, input = {}) {
    const id = input.id || randomUUID();
    const now = this.now();
    this.db.prepare(`INSERT INTO plan_conflicts
      (id, work_item_id, action_id, generation, kind, status, details, created_at, updated_at, resolved_at)
      VALUES (?, ?, ?, ?, ?, 'open', ?, ?, ?, NULL)`).run(
      id,
      workItemId,
      input.actionId || null,
      Number.isInteger(input.generation) && input.generation > 0 ? input.generation : 1,
      input.kind || 'plan',
      stringify(input.details || {}),
      now,
      now,
    );
    return this.getPlanConflict(id);
  }

  getPlanConflict(id) {
    return mapPlanConflict(this.db.prepare('SELECT * FROM plan_conflicts WHERE id = ?').get(id));
  }

  listPlanConflicts(workItemId, options = {}) {
    const status = typeof options.status === 'string' && options.status ? options.status : null;
    return this.db.prepare(`SELECT * FROM plan_conflicts WHERE work_item_id = ?
      AND (? IS NULL OR status = ?) ORDER BY created_at, id`).all(workItemId, status, status).map(mapPlanConflict);
  }

  resolvePlanConflict(id, details = null) {
    const now = this.now();
    const changed = details && typeof details === 'object'
      ? this.db.prepare(`UPDATE plan_conflicts SET status = 'resolved', details = ?,
          updated_at = ?, resolved_at = ? WHERE id = ? AND status = 'open'`).run(stringify(details), now, now, id)
      : this.db.prepare(`UPDATE plan_conflicts SET status = 'resolved',
          updated_at = ?, resolved_at = ? WHERE id = ? AND status = 'open'`).run(now, now, id);
    return Number(changed.changes) === 1 ? this.getPlanConflict(id) : null;
  }

  deletePlanConflict(id) {
    return Number(this.db.prepare('DELETE FROM plan_conflicts WHERE id = ?').run(id).changes) === 1;
  }

  createWorkItem(input, firstAction) {
    return withTransaction(this.db, () => {
      const now = this.now();
      const id = input.id || randomUUID();
      const workspaceKey = canonicalWorkspaceKey(input.workDir);
      this.db.prepare(`INSERT INTO work_items
        (id, revision, execution_schema_version, ledger_revision, title, goal, acceptance_criteria, workflow_template, workflow_snapshot, status,
         current_action_id, current_run_id, work_dir, workspace_key, reuse_memory, origin, linked_session_ids,
         session_context, attachments, created_at, updated_at)
        VALUES (?, 1, 2, 0, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
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
        stringify(input.sessionContext || []),
        stringify(input.attachments || []),
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
      dependsOnStageIds: Array.isArray(input.dependsOnStageIds) ? input.dependsOnStageIds : [],
      workspaceMode: input.workspaceMode || 'shared',
      changesRequestedStageId: input.changesRequestedStageId || null,
      workspace: input.workspace || null,
      requiredRole: input.requiredRole || '',
      instruction: input.instruction || '',
      brief: input.brief && typeof input.brief === 'object' ? input.brief : null,
      context: Array.isArray(input.context) ? input.context : [],
      contractRevision: Number.isInteger(input.contractRevision) ? input.contractRevision : 1,
      generation: Number.isInteger(input.generation) && input.generation > 0 ? input.generation : 1,
      specHash: '',
      resultRunId: input.resultRunId || null,
      status: input.status || 'ready',
      attempt: Number.isInteger(input.attempt) ? input.attempt : 0,
      maxAttempts: Number.isInteger(input.maxAttempts) ? input.maxAttempts : 2,
      currentRunId: null,
      leaseEpoch: 0,
      replacesActionId: input.replacesActionId || null,
      createdAt: now,
      updatedAt: now,
    };
    action.specHash = actionSpecHash(action);
    this.db.prepare(`INSERT INTO actions
      (id, work_item_id, sequence, type, required_role, stage_id, assignment_policy, model_policy,
       depends_on_stage_ids, workspace_mode, changes_requested_stage_id, workspace, instruction, brief, context, contract_revision,
       generation, spec_hash, result_run_id, status, attempt, max_attempts, current_run_id, lease_epoch,
       replaces_action_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, ?, ?, ?)`).run(
      action.id,
      workItemId,
      action.sequence,
      action.type,
      action.requiredRole,
      action.stageId,
      stringify(action.assignmentPolicy),
      stringify(action.modelPolicy),
      stringify(action.dependsOnStageIds),
      action.workspaceMode,
      action.changesRequestedStageId,
      stringify(action.workspace),
      action.instruction,
      stringify(action.brief),
      stringify(action.context),
      action.contractRevision,
      action.generation,
      action.specHash,
      action.resultRunId,
      action.status,
      action.attempt,
      action.maxAttempts,
      action.replacesActionId,
      now,
      now,
    );
    return action;
  }

  #nextSequence(workItemId) {
    const row = this.db.prepare('SELECT COALESCE(MAX(sequence), 0) AS seq FROM actions WHERE work_item_id = ?').get(workItemId);
    return Number(row.seq) + 1;
  }

  #hasActiveIntegrationReservation(action, now = this.now()) {
    const reservation = action?.workspace?.integration?.reservation;
    return !!reservation && Number(reservation.expiresAt) > now;
  }

  #assertNoIntegrationReservation(actions, now = this.now()) {
    if (actions.some(action => this.#hasActiveIntegrationReservation(action, now))) {
      throw new Error('Work Center integration finalization currently owns the Action lease');
    }
  }

  #resetGraphFromStage(workItemId, targetStageId, replacement, reason, now) {
    const actions = this.db.prepare(`SELECT * FROM actions WHERE work_item_id = ?
      AND status NOT IN ('superseded', 'cancelled') ORDER BY sequence`).all(workItemId).map(mapAction);
    const target = actions.find(action => action.stageId === targetStageId);
    if (!target) throw new Error('Work Center graph reset target is missing');
    const affected = new Set([targetStageId]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const action of actions) {
        if (affected.has(action.stageId)) continue;
        if (action.dependsOnStageIds.some(stageId => affected.has(stageId))) {
          affected.add(action.stageId);
          changed = true;
        }
      }
    }
    const affectedActions = actions.filter(action => affected.has(action.stageId));
    this.#assertNoIntegrationReservation(affectedActions, now);
    const preservedTargetWorkspace = target.workspaceMode === 'integrate'
      && ['prepared', 'finalized'].includes(target.workspace?.integration?.status)
      && (!replacement || replacement.workspaceMode === 'integrate')
      ? target.workspace
      : null;
    const ids = affectedActions.map(action => action.id);
    const running = affectedActions.filter(action => action.status === 'running' && action.currentRunId);
    const nextEpoch = new Map(actions.map(action => [action.id, action.leaseEpoch]));
    for (const action of running) nextEpoch.set(action.id, action.leaseEpoch + 1);
    const placeholders = ids.map(() => '?').join(',');
    if (ids.length > 0) {
      this.db.prepare(`UPDATE runs SET status = 'superseded', ended_at = ?, error = ?
        WHERE action_id IN (${placeholders}) AND status = 'running'`).run(now, reason, ...ids);
      for (const action of affectedActions) {
        const workspace = action.id === target.id ? preservedTargetWorkspace : null;
        const nextAction = action.id === target.id && replacement
          ? { ...action, ...replacement, generation: action.generation + 1 }
          : { ...action, generation: action.generation + 1 };
        this.db.prepare(`UPDATE actions SET status = 'ready', attempt = 0, current_run_id = NULL,
          lease_epoch = ?, generation = generation + 1, spec_hash = ?, result_run_id = NULL,
          workspace = ?, updated_at = ? WHERE id = ?`).run(
          nextEpoch.get(action.id), actionSpecHash(nextAction), stringify(workspace), now, action.id,
        );
      }
    }
    if (replacement) {
      const replacementAction = {
        ...target,
        ...replacement,
        generation: target.generation + 1,
        contractRevision: replacement.contractRevision ?? target.contractRevision,
      };
      const specHash = actionSpecHash(replacementAction);
      this.db.prepare(`UPDATE actions SET type = ?, required_role = ?, assignment_policy = ?,
        model_policy = ?, depends_on_stage_ids = ?, workspace_mode = ?, changes_requested_stage_id = ?,
        instruction = ?, brief = ?, context = ?, max_attempts = ?, workspace = ?, spec_hash = ?, updated_at = ?
        WHERE id = ?`).run(
        replacement.type || target.type,
        replacement.requiredRole || '',
        stringify(replacement.assignmentPolicy || null),
        stringify(replacement.modelPolicy || null),
        stringify(Array.isArray(replacement.dependsOnStageIds) ? replacement.dependsOnStageIds : []),
        replacement.workspaceMode || 'shared',
        replacement.changesRequestedStageId || null,
        replacement.instruction || '',
        stringify(replacement.brief || null),
        stringify(Array.isArray(replacement.context) ? replacement.context : []),
        Number.isInteger(replacement.maxAttempts) ? replacement.maxAttempts : 2,
        stringify(preservedTargetWorkspace),
        specHash,
        now,
        target.id,
      );
    }
    return this.getAction(target.id);
  }

  createNextAction(workItemId, input) {
    return this.#insertAction(workItemId, input, this.#nextSequence(workItemId));
  }

  setActionWorkspace(actionId, workspace, workspaceMode = null) {
    return withTransaction(this.db, () => {
      const action = this.getAction(actionId);
      if (!action) return null;
      const nextWorkspaceMode = workspaceMode || action.workspaceMode;
      const specChanged = nextWorkspaceMode !== action.workspaceMode;
      const nextAction = { ...action, workspaceMode: nextWorkspaceMode };
      const changed = this.db.prepare(`UPDATE actions SET workspace = ?, workspace_mode = ?,
        generation = generation + ?, spec_hash = ?, result_run_id = CASE WHEN ? = 1 THEN NULL ELSE result_run_id END,
        updated_at = ? WHERE id = ? AND generation = ?`).run(
        stringify(workspace),
        nextWorkspaceMode,
        specChanged ? 1 : 0,
        specChanged ? actionSpecHash(nextAction) : action.specHash,
        specChanged ? 1 : 0,
        this.now(),
        actionId,
        action.generation,
      );
      return Number(changed.changes) === 1 ? this.getAction(actionId) : null;
    });
  }

  setActionWorkspaceForRun(
    actionId,
    runId,
    ownerBootId,
    leaseEpoch,
    expectedGeneration,
    workspace,
    workspaceMode = null,
  ) {
    return withTransaction(this.db, () => {
      const active = this.#activeRunRow(runId, ownerBootId, leaseEpoch, true);
      if (!active || active.action_id !== actionId) return null;
      const action = this.getAction(actionId);
      if (!action || action.generation !== expectedGeneration) return null;
      const nextWorkspaceMode = workspaceMode || action.workspaceMode;
      const specChanged = nextWorkspaceMode !== action.workspaceMode;
      const nextAction = { ...action, workspaceMode: nextWorkspaceMode };
      const nextGeneration = action.generation + (specChanged ? 1 : 0);
      const nextSpecHash = specChanged ? actionSpecHash(nextAction) : action.specHash;
      const now = this.now();
      if (action.workspaceMode === 'isolated-write' && nextWorkspaceMode === 'shared') {
        const workItem = this.getWorkItem(action.workItemId);
        const workspaceConflict = workItem?.workspaceKey
          ? this.db.prepare(`SELECT 1 FROM actions running
            JOIN work_items running_item ON running_item.id = running.work_item_id
            WHERE running.id != ? AND running.status = 'running'
              AND running_item.workspace_key = ? LIMIT 1`).get(action.id, workItem.workspaceKey)
          : null;
        if (workspaceConflict) {
          const error = new Error('Work Center cannot fall back to shared while the workspace has another running Action');
          error.workItemPrepareDeferred = true;
          throw error;
        }
      }
      const changed = this.db.prepare(`UPDATE actions SET workspace = ?, workspace_mode = ?,
        generation = generation + ?, spec_hash = ?, result_run_id = CASE WHEN ? = 1 THEN NULL ELSE result_run_id END,
        updated_at = ? WHERE id = ? AND status = 'running' AND current_run_id = ?
        AND lease_epoch = ? AND generation = ?`).run(
        stringify(workspace),
        nextWorkspaceMode,
        specChanged ? 1 : 0,
        nextSpecHash,
        specChanged ? 1 : 0,
        now,
        actionId,
        runId,
        leaseEpoch,
        expectedGeneration,
      );
      if (Number(changed.changes) !== 1) return null;
      if (specChanged) {
        const rebound = this.db.prepare(`UPDATE runs SET action_generation = ?, action_spec_hash = ?
          WHERE id = ? AND action_id = ? AND owner_boot_id = ? AND lease_epoch = ? AND status = 'running'
          AND action_generation = ? AND action_spec_hash = ?`).run(
          nextGeneration,
          nextSpecHash,
          runId,
          actionId,
          ownerBootId,
          leaseEpoch,
          action.generation,
          action.specHash,
        );
        if (Number(rebound.changes) !== 1) {
          throw new Error('Work Center could not rebind the owned Run after workspace fallback');
        }
      }

      if (action.workspaceMode === 'isolated-write' && nextWorkspaceMode === 'shared') {
        const pendingRows = this.db.prepare(`SELECT * FROM actions
          WHERE work_item_id = ? AND id != ? AND workspace_mode IN ('isolated-write', 'integrate')
          AND status = 'ready' AND current_run_id IS NULL`).all(action.workItemId, action.id);
        for (const row of pendingRows) {
          const pending = mapAction(row);
          const fallback = { ...pending, workspaceMode: 'shared', workspace: null };
          const repaired = this.db.prepare(`UPDATE actions SET workspace = NULL, workspace_mode = 'shared',
            generation = generation + 1, spec_hash = ?, result_run_id = NULL, updated_at = ?
            WHERE id = ? AND status = 'ready' AND current_run_id IS NULL
            AND generation = ? AND workspace_mode = ?`).run(
            actionSpecHash(fallback),
            now,
            pending.id,
            pending.generation,
            pending.workspaceMode,
          );
          if (Number(repaired.changes) !== 1) {
            throw new Error('Work Center could not serialize the pending Action graph after workspace fallback');
          }
        }
      }
      return this.getAction(actionId);
    });
  }

  #graphWorkItemState(workItemId) {
    const remaining = this.db.prepare(`SELECT id, status FROM actions WHERE work_item_id = ?
      AND status IN ('ready', 'running', 'waiting', 'failed') ORDER BY sequence`).all(workItemId);
    const blocked = remaining.find(candidate => candidate.status === 'waiting' || candidate.status === 'failed');
    const runnable = remaining.find(candidate => candidate.status === 'ready' || candidate.status === 'running');
    return {
      status: blocked ? (blocked.status === 'waiting' ? 'waiting' : 'needs_attention')
        : runnable ? (remaining.some(candidate => candidate.status === 'running') ? 'running' : 'ready')
          : 'done',
      currentActionId: blocked?.id || runnable?.id || null,
    };
  }

  deferRun(runId, ownerBootId, leaseEpoch, reason = 'Work Center resource is temporarily busy') {
    return withTransaction(this.db, () => {
      const active = this.#activeRunRow(runId, ownerBootId, leaseEpoch, true);
      if (!active) return null;
      const action = this.getAction(active.action_id);
      const workItem = this.getWorkItem(active.work_item_id);
      const now = this.now();
      const changedRun = this.db.prepare(`UPDATE runs SET status = 'interrupted', ended_at = ?, error = ?,
        failure_kind = 'resource_deferred', failure_code = 'workspace_busy'
        WHERE id = ? AND owner_boot_id = ? AND lease_epoch = ? AND status = 'running'`).run(
        now, reason, runId, ownerBootId, leaseEpoch,
      );
      if (Number(changedRun.changes) !== 1) return null;
      const changedAction = this.db.prepare(`UPDATE actions SET status = 'ready', attempt = MAX(attempt - 1, 0),
        current_run_id = NULL, updated_at = ? WHERE id = ? AND status = 'running'
        AND current_run_id = ? AND lease_epoch = ? AND generation = ?`).run(
        now, action.id, runId, leaseEpoch, action.generation,
      );
      if (Number(changedAction.changes) !== 1) {
        throw new Error('Work Center deferred Run lost the current Action fence');
      }
      const graphMode = isGraphWorkItem(workItem);
      const graphState = graphMode ? this.#graphWorkItemState(workItem.id) : null;
      const changedWorkItem = graphMode
        ? this.db.prepare(`UPDATE work_items SET status = ?, current_action_id = ?, current_run_id = NULL,
            updated_at = ? WHERE id = ? AND status IN ('ready', 'running', 'waiting', 'needs_attention')`).run(
            graphState.status, graphState.currentActionId, now, workItem.id,
          )
        : this.db.prepare(`UPDATE work_items SET status = 'ready', current_run_id = NULL, updated_at = ?
          WHERE id = ? AND status = 'running' AND current_action_id = ? AND current_run_id = ?`).run(
          now, workItem.id, action.id, runId,
        );
      if (Number(changedWorkItem.changes) !== 1) {
        throw new Error('Work Center deferred Run lost the WorkItem fence');
      }
      this.appendEvent(workItem.id, 'run.deferred', { reason }, { actionId: action.id, runId });
      return this.getWorkItemDetail(workItem.id);
    });
  }

  setIntegrationWorkspaceForRun(actionId, runId, ownerBootId, leaseEpoch, workspace) {
    return withTransaction(this.db, () => {
      const active = this.#activeRunRow(runId, ownerBootId, leaseEpoch, true);
      if (!active || active.action_id !== actionId) return null;
      const changed = this.db.prepare(`UPDATE actions SET workspace = ?, workspace_mode = 'integrate',
        updated_at = ? WHERE id = ? AND status = 'running' AND current_run_id = ? AND lease_epoch = ?`).run(
        stringify(workspace), this.now(), actionId, runId, leaseEpoch,
      );
      return Number(changed.changes) === 1 ? this.getAction(actionId) : null;
    });
  }

  acquireIntegrationFinalization(actionId, runId, ownerBootId, leaseEpoch, reservationMs = 300_000) {
    return withTransaction(this.db, () => {
      const active = this.#activeRunRow(runId, ownerBootId, leaseEpoch, true);
      if (!active || active.action_id !== actionId) return null;
      const action = this.getAction(actionId);
      if (action?.workspaceMode !== 'integrate' || action.workspace?.integration?.status !== 'prepared') return null;
      const now = this.now();
      const token = randomUUID();
      const expiresAt = now + Math.max(10_000, Number(reservationMs) || 300_000);
      const workspace = {
        ...action.workspace,
        integration: {
          ...action.workspace.integration,
          reservation: { token, runId, ownerBootId, leaseEpoch, expiresAt },
        },
      };
      const changed = this.db.prepare(`UPDATE actions SET workspace = ?, updated_at = ?
        WHERE id = ? AND status = 'running' AND current_run_id = ? AND lease_epoch = ?`).run(
        stringify(workspace), now, actionId, runId, leaseEpoch,
      );
      if (Number(changed.changes) !== 1) return null;
      this.db.prepare(`UPDATE runs SET expires_at = ? WHERE id = ? AND owner_boot_id = ?
        AND lease_epoch = ? AND status = 'running'`).run(expiresAt, runId, ownerBootId, leaseEpoch);
      return { action: this.getAction(actionId), token, expiresAt };
    });
  }

  finishIntegrationFinalization(actionId, runId, ownerBootId, leaseEpoch, token, workspace) {
    return withTransaction(this.db, () => {
      const active = this.#activeRunRow(runId, ownerBootId, leaseEpoch, false);
      if (!active || active.action_id !== actionId) return null;
      const action = this.getAction(actionId);
      const reservation = action?.workspace?.integration?.reservation;
      if (!reservation || reservation.token !== token || reservation.runId !== runId
          || reservation.ownerBootId !== ownerBootId || reservation.leaseEpoch !== leaseEpoch
          || Number(reservation.expiresAt) <= this.now()) return null;
      const changed = this.db.prepare(`UPDATE actions SET workspace = ?, workspace_mode = 'integrate',
        updated_at = ? WHERE id = ? AND status = 'running' AND current_run_id = ? AND lease_epoch = ?`).run(
        stringify(workspace), this.now(), actionId, runId, leaseEpoch,
      );
      return Number(changed.changes) === 1 ? this.getAction(actionId) : null;
    });
  }

  rollbackIntegrationFinalization(actionId, runId, ownerBootId, leaseEpoch, token) {
    return withTransaction(this.db, () => {
      const active = this.#activeRunRow(runId, ownerBootId, leaseEpoch, false);
      if (!active || active.action_id !== actionId) return null;
      const action = this.getAction(actionId);
      const reservation = action?.workspace?.integration?.reservation;
      if (!reservation || reservation.token !== token || reservation.runId !== runId
          || reservation.ownerBootId !== ownerBootId || reservation.leaseEpoch !== leaseEpoch
          || Number(reservation.expiresAt) <= this.now()) return null;
      const changed = this.db.prepare(`UPDATE actions SET workspace = NULL, workspace_mode = 'integrate',
        updated_at = ? WHERE id = ? AND status = 'running' AND current_run_id = ? AND lease_epoch = ?`).run(
        this.now(), actionId, runId, leaseEpoch,
      );
      return Number(changed.changes) === 1 ? this.getAction(actionId) : null;
    });
  }

  listActionDependencies(workItemId, stageIds) {
    if (!Array.isArray(stageIds) || stageIds.length === 0) return [];
    const placeholders = stageIds.map(() => '?').join(',');
    return this.db.prepare(`SELECT a.*, r.summary AS dependency_summary,
      r.evidence AS dependency_evidence, r.vp_snapshot AS dependency_vp_snapshot
      FROM actions a LEFT JOIN runs r ON r.id = (
        SELECT completed.id FROM runs completed WHERE completed.action_id = a.id
          AND completed.status = 'completed'
          ORDER BY completed.ended_at DESC LIMIT 1
      ) WHERE a.work_item_id = ? AND COALESCE(a.stage_id, a.type) IN (${placeholders})
        AND a.status != 'superseded'
      ORDER BY a.sequence`).all(workItemId, ...stageIds).map(row => ({
        ...mapAction(row),
        summary: row.dependency_summary || '',
        evidence: normalizeEvidence(parseJson(row.dependency_evidence, [])),
        vpId: parseJson(row.dependency_vp_snapshot, null)?.id || null,
      }));
  }

  getWorkItem(id) {
    const workItem = mapWorkItem(this.db.prepare('SELECT * FROM work_items WHERE id = ?').get(id));
    if (!isGraphWorkItem(workItem)) return workItem;
    const actions = this.db.prepare('SELECT * FROM actions WHERE work_item_id = ? ORDER BY sequence')
      .all(id).map(mapAction);
    return graphExecutionState(workItem, actions);
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
      where.push('w.status = ?');
      values.push(filters.status);
    }
    if (typeof filters.sessionId === 'string' && filters.sessionId.trim()) {
      const sessionId = filters.sessionId.trim();
      where.push('(instr(w.origin, ?) > 0 OR instr(w.linked_session_ids, ?) > 0)');
      values.push(`\"sessionId\":${JSON.stringify(sessionId)}`, JSON.stringify(sessionId));
    }
    const keyword = typeof filters.keyword === 'string' ? filters.keyword.trim()
      : typeof filters.search === 'string' ? filters.search.trim() : '';
    if (keyword) {
      where.push('(w.title LIKE ? OR w.goal LIKE ?)');
      const query = `%${keyword}%`;
      values.push(query, query);
    }
    const createdFrom = Number(filters.createdFrom);
    const createdTo = Number(filters.createdTo);
    const updatedFrom = Number(filters.updatedFrom);
    const updatedTo = Number(filters.updatedTo);
    if (Number.isFinite(createdFrom) && createdFrom > 0) { where.push('w.created_at >= ?'); values.push(createdFrom); }
    if (Number.isFinite(createdTo) && createdTo > 0) { where.push('w.created_at <= ?'); values.push(createdTo); }
    if (Number.isFinite(updatedFrom) && updatedFrom > 0) { where.push('w.updated_at >= ?'); values.push(updatedFrom); }
    if (Number.isFinite(updatedTo) && updatedTo > 0) { where.push('w.updated_at <= ?'); values.push(updatedTo); }
    if (typeof filters.workItemType === 'string' && filters.workItemType.trim()) {
      where.push('instr(w.workflow_snapshot, ?) > 0');
      values.push(`\"workItemType\":${JSON.stringify(filters.workItemType.trim())}`);
    }
    if (typeof filters.vpId === 'string' && filters.vpId.trim()) {
      where.push(`EXISTS (SELECT 1 FROM actions executor_action
        JOIN runs executor_run ON executor_run.id = (
          SELECT latest_executor_run.id FROM runs latest_executor_run
          WHERE latest_executor_run.action_id = executor_action.id
          ORDER BY latest_executor_run.started_at DESC, latest_executor_run.progress_revision DESC
          LIMIT 1)
        WHERE executor_action.work_item_id = w.id
          AND executor_action.status NOT IN ('superseded', 'cancelled')
          AND instr(executor_run.vp_snapshot, ?) > 0)`);
      values.push(`\"id\":${JSON.stringify(filters.vpId.trim())}`);
    }
    if (filters.lane === 'closed') {
      where.push("w.status IN ('done', 'cancelled')");
    } else if (filters.lane === 'needs_attention') {
      where.push(`w.status NOT IN ('done', 'cancelled') AND (
        w.status IN ('draft', 'waiting', 'needs_attention') OR EXISTS (
          SELECT 1 FROM actions attention_action WHERE attention_action.work_item_id = w.id
            AND attention_action.status IN ('waiting', 'failed')))`);
    } else if (filters.lane === 'active') {
      where.push(`w.status NOT IN ('done', 'cancelled', 'draft', 'waiting', 'needs_attention')
        AND NOT EXISTS (SELECT 1 FROM actions attention_action WHERE attention_action.work_item_id = w.id
          AND attention_action.status IN ('waiting', 'failed'))`);
    }
    const cursorUpdatedAt = Number(filters.cursorUpdatedAt);
    const cursorId = typeof filters.cursorId === 'string' ? filters.cursorId : '';
    if (Number.isFinite(cursorUpdatedAt) && cursorUpdatedAt >= 0 && cursorId) {
      where.push('(w.updated_at < ? OR (w.updated_at = ? AND w.id < ?))');
      values.push(cursorUpdatedAt, cursorUpdatedAt, cursorId);
    }
    const limit = Math.min(Math.max(Number(filters.limit) || 100, 1), 500);
    const sql = `SELECT w.*,
        current_action.type AS current_action_type,
        current_action.stage_id AS current_action_stage_id,
        current_action.status AS current_action_status,
        current_action.brief AS current_action_brief,
        (SELECT COUNT(*) FROM actions a WHERE a.work_item_id = w.id
          AND a.status NOT IN ('superseded', 'cancelled')) AS action_count,
        (SELECT COUNT(*) FROM actions a WHERE a.work_item_id = w.id
          AND a.status = 'completed') AS completed_action_count,
        COALESCE(SUM(r.llm_request_count), 0) AS usage_llm_request_count,
        COALESCE(SUM(r.loop_count), 0) AS usage_loop_count,
        COALESCE(SUM(r.tool_count), 0) AS usage_tool_count,
        COALESCE(SUM(r.input_tokens), 0) AS usage_input_tokens,
        COALESCE(SUM(r.output_tokens), 0) AS usage_output_tokens,
        COALESCE(SUM(r.cache_read_tokens), 0) AS usage_cache_read_tokens,
        COALESCE(SUM(r.cache_write_tokens), 0) AS usage_cache_write_tokens,
        COALESCE(SUM(r.total_tokens), 0) AS usage_total_tokens
      FROM work_items w
      LEFT JOIN actions current_action ON current_action.id = w.current_action_id
      LEFT JOIN runs r ON r.work_item_id = w.id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      GROUP BY w.id ORDER BY w.updated_at DESC, w.id DESC LIMIT ?`;
    const workItems = this.db.prepare(sql).all(...values, limit).map(mapWorkItem);
    if (workItems.length === 0) return [];
    const placeholders = workItems.map(() => '?').join(',');
    const ids = workItems.map(item => item.id);
    const actionsByWorkItem = new Map(ids.map(id => [id, []]));
    for (const row of this.db.prepare(`SELECT * FROM actions WHERE work_item_id IN (${placeholders})
      ORDER BY work_item_id, sequence`).all(...ids)) {
      actionsByWorkItem.get(row.work_item_id).push(mapAction(row));
    }
    const runsByWorkItem = new Map(ids.map(id => [id, []]));
    for (const row of this.db.prepare(`SELECT * FROM runs WHERE work_item_id IN (${placeholders})
      ORDER BY work_item_id, started_at DESC`).all(...ids)) {
      runsByWorkItem.get(row.work_item_id).push(mapRun(row));
    }
    return workItems.map(workItem => {
      const actions = actionsByWorkItem.get(workItem.id) || [];
      return graphExecutionState({ ...workItem, actions, runs: runsByWorkItem.get(workItem.id) || [] }, actions);
    });
  }

  getWorkItemDetail(id) {
    const workItem = this.getWorkItem(id);
    if (!workItem) return null;
    const detail = {
      ...workItem,
      actions: this.db.prepare('SELECT * FROM actions WHERE work_item_id = ? ORDER BY sequence').all(id).map(mapAction),
      runs: this.db.prepare('SELECT * FROM runs WHERE work_item_id = ? ORDER BY started_at DESC').all(id).map(mapRun),
      planConflicts: this.listPlanConflicts(id),
      events: this.db.prepare('SELECT * FROM events WHERE work_item_id = ? ORDER BY id DESC LIMIT 500').all(id).map(mapEvent),
    };
    return graphExecutionState(detail, detail.actions);
  }

  listActionEvents(actionId) {
    return this.db.prepare(`SELECT * FROM events WHERE action_id = ? ORDER BY id`).all(actionId).map(mapEvent);
  }

  addWorkItemMessage(id, text, expectedRevision, updateActionInstruction) {
    return withTransaction(this.db, () => {
      const workItem = this.getWorkItem(id);
      if (!workItem) return null;
      if (['done', 'cancelled'].includes(workItem.status)) {
        throw new Error(`WorkItem in ${workItem.status} cannot accept messages`);
      }
      if (workItem.revision !== expectedRevision) {
        throw new Error('WorkItem changed before the message was applied; refresh and try again');
      }
      const openActions = this.db.prepare(`SELECT * FROM actions WHERE work_item_id = ?
        AND status IN ('ready', 'running') ORDER BY sequence`).all(id).map(mapAction);
      for (const action of openActions.filter(candidate => candidate.status === 'running')) {
        const run = action.currentRunId ? this.getRun(action.currentRunId) : null;
        if (!run || run.status !== 'running' || run.acceptingInput === false) {
          throw new Error('A running Action closed its input window before the WorkItem message was applied; refresh and try again');
        }
      }
      const now = this.now();
      const revision = workItem.revision + 1;
      const message = { id: randomUUID(), text, createdAt: now };
      const messages = [...(workItem.messages || []), message].slice(-100);
      this.db.prepare(`UPDATE work_items SET messages = ?, revision = ?, updated_at = ? WHERE id = ?`)
        .run(stringify(messages), revision, now, id);
      const updatedWorkItem = { ...workItem, messages, revision };
      for (const action of openActions) {
        if (action.status === 'ready') {
          const instruction = updateActionInstruction(updatedWorkItem, action);
          this.db.prepare(`UPDATE actions SET instruction = ?, spec_hash = ?, updated_at = ?
            WHERE id = ? AND status = 'ready'`).run(
            instruction,
            actionSpecHash({ ...action, instruction }),
            now,
            action.id,
          );
          continue;
        }
        const run = this.getRun(action.currentRunId);
        const eventId = this.appendEvent(id, 'work_item.message_applied', { message }, {
          actionId: action.id,
          runId: action.currentRunId,
        });
        this.db.prepare(`INSERT INTO pending_action_inputs
          (event_id, work_item_id, action_id, run_id, text, attachments, consumed_at)
          VALUES (?, ?, ?, ?, ?, '[]', NULL)`).run(
          eventId,
          id,
          action.id,
          action.currentRunId,
          `WorkItem-level message: ${text}`,
        );
      }
      this.appendEvent(id, 'work_item.message_added', { message });
      return this.getWorkItemDetail(id);
    });
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

  addActionGuidance(id, guidance, expected, makeAction, attachments = null, addedAttachments = []) {
    return withTransaction(this.db, () => {
      const workItem = this.getWorkItem(id);
      if (!workItem) return null;
      const graphMode = isGraphWorkItem(workItem);
      const expectedAction = this.getAction(expected.actionId);
      const expectedMatches = graphMode
        ? expectedAction?.workItemId === id && expectedAction.generation === expected.generation
        : workItem.currentActionId === expected.actionId;
      if (!expectedMatches || workItem.revision !== expected.revision) {
        throw new Error('Action changed before guidance was applied; refresh and try again');
      }
      const guidanceStatuses = graphMode
        ? ['ready', 'running', 'waiting', 'needs_attention']
        : ['ready', 'running'];
      if (!guidanceStatuses.includes(workItem.status)) {
        throw new Error(`WorkItem in ${workItem.status} cannot accept Action guidance`);
      }
      const previous = graphMode ? expectedAction
        : (workItem.currentActionId ? this.getAction(workItem.currentActionId) : null);
      const actionableStatuses = graphMode
        ? ['ready', 'running', 'waiting', 'needs_attention']
        : ['ready', 'running'];
      if (!previous || !actionableStatuses.includes(previous.status)) {
        throw new Error('WorkItem has no active Action for guidance');
      }
      const now = this.now();
      const revision = workItem.revision + 1;
      const replacement = {
        ...makeAction(workItem, previous),
        contractRevision: previous.contractRevision,
      };
      let action;
      if (graphMode) {
        action = this.#resetGraphFromStage(
          id,
          previous.stageId,
          replacement,
          'Action restarted after user guidance',
          now,
        );
      } else {
        this.#invalidateExecution(
          workItem,
          'superseded',
          'superseded',
          'Action restarted after user guidance',
          now,
        );
        action = this.#insertAction(id, replacement, this.#nextSequence(id), now);
      }
      this.db.prepare(`UPDATE work_items SET status = 'ready', current_action_id = ?,
        current_run_id = NULL, attachments = ?, revision = ?, updated_at = ? WHERE id = ?`).run(
        action.id,
        stringify(Array.isArray(attachments) ? attachments : workItem.attachments),
        revision,
        now,
        id,
      );
      this.appendEvent(id, 'action.guidance_added', {
        guidance,
        attachments: (Array.isArray(addedAttachments) ? addedAttachments : []).map(attachment => ({
          id: attachment.id,
          name: attachment.name,
          mimeType: attachment.mimeType,
          size: Math.max(0, Number(attachment.size) || 0),
          isImage: attachment.isImage === true,
        })),
      }, { actionId: action.id });
      return this.getWorkItemDetail(id);
    });
  }

  #invalidateExecution(workItem, actionStatus, runStatus, reason, now) {
    const openActions = this.db.prepare(`SELECT * FROM actions WHERE work_item_id = ?
      AND status IN (${OPEN_ACTION_STATUSES})`).all(workItem.id).map(mapAction);
    this.#assertNoIntegrationReservation(openActions, now);
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

  retryWorkItemAtomic(id, makeAction, options = {}) {
    return withTransaction(this.db, () => {
      const workItem = this.getWorkItem(id);
      if (!workItem) return null;
      const graphMode = isGraphWorkItem(workItem);
      const retryableWorkItemStatuses = graphMode
        ? ['ready', 'running', 'waiting', 'needs_attention']
        : ['waiting', 'needs_attention'];
      if (!retryableWorkItemStatuses.includes(workItem.status)) {
        throw new Error(`WorkItem in ${workItem.status} does not need retry`);
      }
      let previous = workItem.currentActionId ? this.getAction(workItem.currentActionId) : null;
      if (options.expected) {
        const expectedAction = this.getAction(options.expected.actionId);
        const allowedExpectedStatuses = Array.isArray(options.expected.statuses)
          ? options.expected.statuses
          : ['waiting', 'failed'];
        const expectedMatches = graphMode
          ? expectedAction?.workItemId === id && expectedAction.generation === options.expected.generation
            && allowedExpectedStatuses.includes(expectedAction.status)
          : workItem.currentActionId === options.expected.actionId
            && allowedExpectedStatuses.includes(expectedAction?.status);
        if (!expectedMatches || workItem.revision !== options.expected.revision) {
          throw new Error('Action changed before input was applied; refresh and try again');
        }
        previous = expectedAction;
      }
      const previousRun = previous
        ? mapRun(this.db.prepare(`SELECT * FROM runs WHERE work_item_id = ? AND action_id = ?
            AND status != 'running' ORDER BY ended_at DESC, started_at DESC LIMIT 1`).get(id, previous.id))
        : null;
      const now = this.now();
      const revision = options.expected ? workItem.revision + 1 : workItem.revision;
      const replacement = {
        ...makeAction(workItem, previous, previousRun),
        contractRevision: previous?.contractRevision ?? workItem.revision,
      };
      if (graphMode) {
        if (!previous) throw new Error('WorkItem graph retry target is missing');
        const action = this.#resetGraphFromStage(
          id,
          previous.stageId,
          replacement,
          'Superseded by manual graph retry',
          now,
        );
        this.db.prepare(`UPDATE work_items SET status = 'ready', current_action_id = ?,
          current_run_id = NULL, attachments = ?, revision = ?, updated_at = ? WHERE id = ?`).run(
          action.id,
          stringify(Array.isArray(options.attachments) ? options.attachments : workItem.attachments),
          revision,
          now,
          id,
        );
        const inputEvent = options.inputEvent && typeof options.inputEvent === 'object'
          ? options.inputEvent
          : null;
        if (inputEvent) {
          this.appendEvent(id, 'action.input_added', inputEvent, { actionId: action.id });
        } else {
          this.appendEvent(id, 'work_item.retried', { targetStageId: action.stageId }, { actionId: action.id });
        }
        return this.getWorkItemDetail(id);
      }
      const action = this.#insertAction(id, replacement, this.#nextSequence(id), now);
      this.db.prepare(`UPDATE work_items SET status = 'ready', current_action_id = ?,
        current_run_id = NULL, attachments = ?, revision = ?, updated_at = ? WHERE id = ?`).run(
        action.id,
        stringify(Array.isArray(options.attachments) ? options.attachments : workItem.attachments),
        revision,
        now,
        id,
      );
      const inputEvent = options.inputEvent && typeof options.inputEvent === 'object'
        ? options.inputEvent
        : null;
      if (inputEvent) {
        this.appendEvent(id, 'action.input_added', inputEvent, { actionId: action.id });
      } else {
        this.appendEvent(id, 'work_item.retried', {}, { actionId: action.id });
      }
      return this.getWorkItemDetail(id);
    });
  }

  claimReadyAction(ownerBootId, leaseMs = 60_000) {
    return withTransaction(this.db, () => {
      const row = this.db.prepare(`SELECT a.* FROM actions a
        JOIN work_items w ON w.id = a.work_item_id
        WHERE a.status = 'ready' AND a.current_run_id IS NULL
          AND (
            (COALESCE(json_extract(w.workflow_snapshot, '$.executionMode'), 'linear') != 'graph'
              AND w.status = 'ready' AND w.current_action_id = a.id AND w.current_run_id IS NULL)
            OR
            (json_extract(w.workflow_snapshot, '$.executionMode') = 'graph'
              AND w.status IN ('ready', 'running', 'waiting', 'needs_attention')
              AND NOT EXISTS (
                SELECT 1 FROM json_each(a.depends_on_stage_ids) dependency
                LEFT JOIN actions required ON required.work_item_id = a.work_item_id
                  AND required.stage_id = dependency.value
                WHERE required.id IS NULL OR required.status != 'completed'
              )
              )
          )
          AND NOT EXISTS (
            SELECT 1 FROM actions running
            JOIN work_items running_item ON running_item.id = running.work_item_id
            WHERE running.status = 'running'
              AND running_item.workspace_key != ''
              AND running_item.workspace_key = w.workspace_key
              AND (a.workspace_mode IN ('shared', 'integrate')
                OR running.workspace_mode IN ('shared', 'integrate')
                OR (running.work_item_id != a.work_item_id
                  AND a.workspace_mode != 'read' AND running.workspace_mode != 'read'))
          )
          AND NOT EXISTS (
            SELECT 1 FROM runs deferred
            WHERE deferred.action_id = a.id
              AND deferred.failure_kind = 'resource_deferred'
              AND deferred.failure_code = 'workspace_busy'
              AND EXISTS (
                SELECT 1 FROM actions blocker
                JOIN work_items blocker_item ON blocker_item.id = blocker.work_item_id
                WHERE blocker.status = 'running' AND blocker.id != a.id
                  AND blocker_item.workspace_key != ''
                  AND blocker_item.workspace_key = w.workspace_key
              )
          )
        ORDER BY a.updated_at ASC, a.sequence ASC LIMIT 1`).get();
      if (!row) return null;
      const now = this.now();
      const runId = randomUUID();
      const leaseEpoch = Number(row.lease_epoch) + 1;
      const priorProgress = this.db.prepare(`SELECT MAX(progress_revision) AS value FROM runs
        WHERE action_id = ?`).get(row.id);
      const progressRevision = Math.max(0, Number(priorProgress?.value) || 0) + 1;
      const actionGeneration = Math.max(1, Number(row.generation) || 1);
      const priorAttempt = this.db.prepare(`SELECT MAX(action_attempt) AS value FROM runs
        WHERE action_id = ? AND action_generation = ?`).get(row.id, actionGeneration);
      const actionAttempt = Math.max(0, Number(priorAttempt?.value) || 0) + 1;
      const changedAction = this.db.prepare(`UPDATE actions SET status = 'running', attempt = attempt + 1,
        current_run_id = ?, lease_epoch = ?, updated_at = ?
        WHERE id = ? AND status = 'ready' AND current_run_id IS NULL`).run(
        runId, leaseEpoch, now, row.id,
      );
      if (Number(changedAction.changes) !== 1) return null;
      const workItem = this.getWorkItem(row.work_item_id);
      const graphMode = isGraphWorkItem(workItem);
      const changedWorkItem = graphMode
        ? this.db.prepare(`UPDATE work_items SET status = 'running', current_action_id = ?,
          current_run_id = NULL, updated_at = ? WHERE id = ?
          AND status IN ('ready', 'running', 'waiting', 'needs_attention')`).run(
          row.id, now, row.work_item_id,
        )
        : this.db.prepare(`UPDATE work_items SET status = 'running', current_run_id = ?, updated_at = ?
          WHERE id = ? AND status = 'ready' AND current_action_id = ? AND current_run_id IS NULL`).run(
          runId, now, row.work_item_id, row.id,
        );
      if (Number(changedWorkItem.changes) !== 1) throw new Error('WorkItem claim lost its Action fence');
      this.db.prepare(`INSERT INTO runs
        (id, action_id, work_item_id, owner_boot_id, lease_epoch, status, started_at,
         expires_at, evidence, progress_revision, action_generation, action_spec_hash, action_attempt)
        VALUES (?, ?, ?, ?, ?, 'running', ?, ?, '[]', ?, ?, ?, ?)`).run(
        runId,
        row.id,
        row.work_item_id,
        ownerBootId,
        leaseEpoch,
        now,
        now + leaseMs,
        progressRevision,
        actionGeneration,
        row.spec_hash || '',
        actionAttempt,
      );
      this.appendEvent(row.work_item_id, 'run.claimed', { ownerBootId, leaseEpoch }, {
        actionId: row.id, runId,
      });
      return {
        workItem: this.getWorkItem(row.work_item_id),
        action: this.getAction(row.id),
        run: this.getRun(runId),
      };
    });
  }

  #activeRunRow(runId, ownerBootId, leaseEpoch, requireUnexpired = true) {
    const row = this.db.prepare(`SELECT r.* FROM runs r
      JOIN actions a ON a.id = r.action_id
      JOIN work_items w ON w.id = r.work_item_id
      WHERE r.id = ? AND r.owner_boot_id = ? AND r.lease_epoch = ? AND r.status = 'running'
        AND a.status = 'running' AND a.current_run_id = r.id AND a.lease_epoch = r.lease_epoch
        AND w.status IN ('ready', 'running', 'waiting', 'needs_attention')
        ${requireUnexpired ? 'AND r.expires_at > ?' : ''}`).get(
      runId, ownerBootId, leaseEpoch, ...(requireUnexpired ? [this.now()] : []),
    );
    if (!row) return null;
    const workItem = this.getWorkItem(row.work_item_id);
    if (isGraphWorkItem(workItem)) return row;
    return workItem?.status === 'running' && workItem.currentActionId === row.action_id
      && workItem.currentRunId === row.id ? row : null;
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

  interruptRun(
    runId,
    ownerBootId,
    leaseEpoch,
    reason = 'Work Center watcher stopped',
    finalProgress = null,
  ) {
    return withTransaction(this.db, () => {
      const active = this.#activeRunRow(runId, ownerBootId, leaseEpoch, false);
      if (!active) return false;
      const action = this.getAction(active.action_id);
      const now = this.now();
      this.#assertNoIntegrationReservation([action], now);
      const retryable = action.type !== 'deliver' && action.attempt < action.maxAttempts;
      const hasFinalProgress = finalProgress && typeof finalProgress === 'object';
      const runChanged = hasFinalProgress
        ? this.db.prepare(`UPDATE runs SET status = 'interrupted', ended_at = ?, error = ?,
          response = ?, loop_count = ?, tool_count = ?, llm_request_count = ?, input_tokens = ?,
          output_tokens = ?, cache_read_tokens = ?, cache_write_tokens = ?, total_tokens = ?, checkpoint = ?,
          progress_revision = progress_revision + 1
          WHERE id = ? AND owner_boot_id = ? AND lease_epoch = ? AND status = 'running'`).run(
          now,
          reason,
          normalizeRunResponse(finalProgress.response),
          Math.max(0, Number(finalProgress.loopCount) || 0),
          Math.max(0, Number(finalProgress.toolCount) || 0),
          Math.max(0, Number(finalProgress.llmRequestCount) || 0),
          Math.max(0, Number(finalProgress.inputTokens) || 0),
          Math.max(0, Number(finalProgress.outputTokens) || 0),
          Math.max(0, Number(finalProgress.cacheReadTokens) || 0),
          Math.max(0, Number(finalProgress.cacheWriteTokens) || 0),
          Math.max(0, Number(finalProgress.totalTokens) || 0),
          stringify(normalizeActionCheckpoint(finalProgress.checkpoint)),
          runId,
          ownerBootId,
          leaseEpoch,
        )
        : this.db.prepare(`UPDATE runs SET status = 'interrupted', ended_at = ?, error = ?
          WHERE id = ? AND owner_boot_id = ? AND lease_epoch = ? AND status = 'running'`).run(
          now,
          reason,
          runId,
          ownerBootId,
          leaseEpoch,
        );
      if (Number(runChanged.changes) !== 1) return false;
      this.onTransitionStep?.('after_interrupt_run_update');
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
      const activeWorkItem = this.getWorkItem(active.work_item_id);
      const graphMode = isGraphWorkItem(activeWorkItem);
      const itemChanged = graphMode
        ? this.db.prepare(`UPDATE work_items SET status = ?, current_action_id = ?, current_run_id = NULL,
          updated_at = ? WHERE id = ? AND status = 'running'`).run(
          retryable ? 'ready' : 'needs_attention', action.id, now, active.work_item_id,
        )
        : this.db.prepare(`UPDATE work_items SET status = ?, current_run_id = NULL,
          updated_at = ? WHERE id = ? AND status = 'running' AND current_action_id = ?
          AND current_run_id = ?`).run(
          retryable ? 'ready' : 'needs_attention', now, active.work_item_id, action.id, runId,
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
        model_snapshot = ?, tool_policy_snapshot = ?, context_snapshot = ?, execution_manifest = ?
        WHERE id = ? AND status = 'running'
        AND role_snapshot IS NULL AND vp_snapshot IS NULL AND model_snapshot IS NULL
        AND tool_policy_snapshot IS NULL AND context_snapshot IS NULL AND execution_manifest IS NULL`).run(
        stringify(snapshots.roleSnapshot || null),
        stringify(snapshots.vpSnapshot || null),
        stringify(snapshots.modelSnapshot || null),
        stringify(snapshots.toolPolicySnapshot || null),
        stringify(snapshots.contextSnapshot || null),
        stringify(snapshots.executionManifest || null),
        runId,
      );
      return Number(result.changes) === 1;
    });
  }

  updateRunProgress(runId, ownerBootId, leaseEpoch, progress = {}) {
    return withTransaction(this.db, () => {
      const active = this.#activeRunRow(runId, ownerBootId, leaseEpoch, true);
      if (!active) return null;
      const checkpoint = normalizeActionCheckpoint(progress.checkpoint);
      const result = this.db.prepare(`UPDATE runs SET response = ?, loop_count = ?, tool_count = ?,
        llm_request_count = ?, input_tokens = ?, output_tokens = ?, cache_read_tokens = ?,
        cache_write_tokens = ?, total_tokens = ?, checkpoint = ?, progress_revision = progress_revision + 1
        WHERE id = ? AND owner_boot_id = ? AND lease_epoch = ? AND status = 'running'`).run(
        normalizeRunResponse(progress.response),
        Math.max(0, Number(progress.loopCount) || 0),
        Math.max(0, Number(progress.toolCount) || 0),
        Math.max(0, Number(progress.llmRequestCount) || 0),
        Math.max(0, Number(progress.inputTokens) || 0),
        Math.max(0, Number(progress.outputTokens) || 0),
        Math.max(0, Number(progress.cacheReadTokens) || 0),
        Math.max(0, Number(progress.cacheWriteTokens) || 0),
        Math.max(0, Number(progress.totalTokens) || 0),
        stringify(checkpoint),
        runId,
        ownerBootId,
        leaseEpoch,
      );
      if (Number(result.changes) !== 1) return null;
      return this.getWorkItemDetail(active.work_item_id);
    });
  }

  getActionResumeContext(actionId, excludeRunId = null) {
    const action = this.getAction(actionId);
    if (!action) return null;
    const runs = this.db.prepare(`SELECT * FROM runs
      WHERE action_id = ? AND id != ? AND status IN ('interrupted', 'retryable')
      ORDER BY ended_at DESC, started_at DESC`).all(actionId, excludeRunId || '')
      .map(mapRun)
      .filter(run => runMatchesActionIdentity(run, action));
    if (runs.length === 0) return null;
    const latest = runs[0];
    const response = runs.find(run => run.response)?.response || '';
    const checkpoint = normalizeActionCheckpoint({
      toolEvents: runs.slice().reverse().flatMap(run => run.checkpoint?.toolEvents || []),
    });
    if (!response && !latest.error && (checkpoint?.toolEvents.length || 0) === 0) return null;
    return {
      status: latest.status,
      response,
      error: latest.error,
      checkpoint,
    };
  }

  closeRunInput(runId, ownerBootId, leaseEpoch) {
    return withTransaction(this.db, () => {
      const active = this.#activeRunRow(runId, ownerBootId, leaseEpoch, true);
      if (!active) return false;
      const pendingInput = this.db.prepare(`SELECT event_id FROM pending_action_inputs
        WHERE action_id = ? AND consumed_at IS NULL LIMIT 1`).get(active.action_id);
      if (pendingInput) return false;
      const changed = this.db.prepare(`UPDATE runs SET accepting_input = 0
        WHERE id = ? AND owner_boot_id = ? AND lease_epoch = ? AND status = 'running'
        AND accepting_input = 1`).run(runId, ownerBootId, leaseEpoch);
      return Number(changed.changes) === 1;
    });
  }

  finalizeRun(runId, ownerBootId, leaseEpoch, result, makeTransition) {
    return withTransaction(this.db, () => {
      const active = this.#activeRunRow(runId, ownerBootId, leaseEpoch, true);
      if (!active || Number(active.accepting_input) !== 0) return null;
      const action = this.getAction(active.action_id);
      const workItem = this.getWorkItem(active.work_item_id);
      const pendingInput = this.db.prepare(`SELECT event_id FROM pending_action_inputs
        WHERE action_id = ? AND consumed_at IS NULL LIMIT 1`).get(action.id);
      if (pendingInput) throw new Error('Run has unconsumed Action input and cannot finish yet');
      const priorRuns = this.db.prepare(`SELECT * FROM runs
        WHERE work_item_id = ? AND id != ? AND status != 'running'
        ORDER BY started_at ASC`).all(workItem.id, runId).map(mapRun);
      const transition = makeTransition({ run: mapRun(active), action, workItem, priorRuns });
      if (!transition || !transition.actionStatus || !transition.workItemStatus) {
        throw new Error('Work Center transition plan is incomplete');
      }
      const now = this.now();
      const ledgerIncrement = workItem.executionSchemaVersion === 2
        && ['completed', 'failed', 'waiting'].includes(result.outcome) ? 1 : 0;
      this.db.prepare(`UPDATE runs SET status = ?, ended_at = ?, response = ?, summary = ?, evidence = ?,
        waiting_reason = ?, error = ?, failure_kind = ?, failure_code = ?, review_decision = ?, contract_patch = ?, checkpoint = ?,
        loop_count = ?, tool_count = ?, llm_request_count = ?, input_tokens = ?, output_tokens = ?,
        cache_read_tokens = ?, cache_write_tokens = ?, total_tokens = ?,
        progress_revision = progress_revision + 1 WHERE id = ?`).run(
        result.outcome,
        now,
        normalizeRunResponse(result.response),
        result.summary || '',
        stringify(normalizeEvidence(result.evidence)),
        result.waitingReason || null,
        result.error || null,
        result.failureKind || null,
        result.failureCode || null,
        result.reviewDecision || null,
        stringify(result.contractPatch || null),
        stringify(normalizeActionCheckpoint(result.checkpoint)),
        Math.max(0, Number(result.loopCount) || 0),
        Math.max(0, Number(result.toolCount) || 0),
        Math.max(0, Number(result.llmRequestCount) || 0),
        Math.max(0, Number(result.inputTokens) || 0),
        Math.max(0, Number(result.outputTokens) || 0),
        Math.max(0, Number(result.cacheReadTokens) || 0),
        Math.max(0, Number(result.cacheWriteTokens) || 0),
        Math.max(0, Number(result.totalTokens) || 0),
        runId,
      );
      this.onTransitionStep?.('after_run_update');

      const changedAction = this.db.prepare(`UPDATE actions SET status = ?, current_run_id = NULL,
        result_run_id = CASE WHEN ? = 'completed' THEN ? ELSE result_run_id END, updated_at = ?
        WHERE id = ? AND status = 'running' AND current_run_id = ? AND lease_epoch = ? AND generation = ?`).run(
        transition.actionStatus,
        result.outcome,
        runId,
        now,
        action.id,
        runId,
        leaseEpoch,
        action.generation,
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
      if (transition.workflowSnapshot) {
        const expectedPlanRevision = Number.isInteger(transition.expectedPlanRevision)
          ? transition.expectedPlanRevision
          : workItem.planRevision;
        const changedPlan = this.db.prepare(`UPDATE work_items SET workflow_template = ?, workflow_snapshot = ?,
          plan_revision = plan_revision + 1, updated_at = ? WHERE id = ? AND plan_revision = ?`).run(
          transition.workflowSnapshot.id,
          stringify(transition.workflowSnapshot),
          now,
          workItem.id,
          expectedPlanRevision,
        );
        if (Number(changedPlan.changes) !== 1) {
          throw new Error('Work Center plan revision changed before finalization');
        }
        nextWorkItem = this.getWorkItem(workItem.id);
      }

      for (const patch of Array.isArray(transition.dependencyPatches) ? transition.dependencyPatches : []) {
        const actionPatch = patch.action;
        const dependencies = [...new Set([
          ...(actionPatch.dependsOnStageIds || []),
          ...(patch.addDependsOnActionIds || []),
        ])];
        const changed = this.db.prepare(`UPDATE actions SET depends_on_stage_ids = ?, updated_at = ?
          WHERE id = ? AND work_item_id = ? AND status = 'ready' AND attempt = 0 AND current_run_id IS NULL`).run(
          stringify(dependencies), now, actionPatch.id, workItem.id,
        );
        if (Number(changed.changes) !== 1) {
          throw new Error('Work Center dependency patch lost its unattempted Action fence');
        }
      }

      let nextAction = null;
      if (transition.replanBarrier) {
        const barrier = transition.replanBarrier;
        if (barrier.basePlanRevision !== workItem.planRevision) {
          throw new Error('Work Center replan request has a stale basePlanRevision');
        }
        const activeActions = this.db.prepare(`SELECT * FROM actions WHERE work_item_id = ?
          AND status NOT IN ('superseded', 'cancelled') ORDER BY sequence`).all(workItem.id).map(mapAction);
        this.#assertNoIntegrationReservation(activeActions, now);
        const unfinished = activeActions.filter(candidate => candidate.id !== action.id && candidate.status !== 'completed');
        for (const candidate of unfinished) {
          if (candidate.status === 'running' && candidate.currentRunId) {
            this.db.prepare(`UPDATE runs SET status = 'superseded', ended_at = ?, error = ?
              WHERE id = ? AND status = 'running'`).run(now, 'Superseded by Work Center replan barrier', candidate.currentRunId);
          }
          this.db.prepare(`UPDATE actions SET status = 'superseded', current_run_id = NULL,
            lease_epoch = lease_epoch + 1, updated_at = ? WHERE id = ? AND status != 'completed'`).run(now, candidate.id);
        }
        const replanWorkflow = {
          ...nextWorkItem.workflowSnapshot,
          stages: [
            ...(nextWorkItem.workflowSnapshot?.stages || []).filter(stage => activeActions
              .some(candidate => candidate.stageId === stage.id && candidate.status === 'completed')),
            { ...(nextWorkItem.workflowSnapshot?.stages?.[0] || {}), id: barrier.action.stageId, type: 'triage', name: 'Replan' },
          ],
        };
        const changedPlan = this.db.prepare(`UPDATE work_items SET workflow_snapshot = ?, plan_revision = plan_revision + 1,
          updated_at = ? WHERE id = ? AND plan_revision = ?`).run(
          stringify(replanWorkflow), now, workItem.id, barrier.basePlanRevision,
        );
        if (Number(changedPlan.changes) !== 1) throw new Error('Work Center replan barrier lost its plan revision fence');
        nextWorkItem = this.getWorkItem(workItem.id);
        nextAction = this.#insertAction(workItem.id, {
          ...barrier.action,
          contractRevision: nextWorkItem.revision,
          status: 'ready',
        }, this.#nextSequence(workItem.id), now);
      }
      if (transition.graphResetStageId) {
        nextAction = this.#resetGraphFromStage(
          workItem.id,
          transition.graphResetStageId,
          transition.graphResetAction,
          'Superseded by review changes request',
          now,
        );
      }
      const nextActions = Array.isArray(transition.nextActions) ? transition.nextActions : [];
      for (const candidate of nextActions) {
        const inserted = this.#insertAction(workItem.id, {
          ...candidate,
          contractRevision: nextWorkItem.revision,
        }, this.#nextSequence(workItem.id), now);
        if (!nextAction) nextAction = inserted;
      }
      if (transition.nextAction) {
        nextAction = this.#insertAction(workItem.id, {
          ...transition.nextAction,
          contractRevision: nextWorkItem.revision,
        }, this.#nextSequence(workItem.id), now);
      }
      let workItemStatus = transition.workItemStatus;
      let currentActionId = nextAction?.id ?? (transition.keepCurrentAction ? action.id : null);
      let changedWorkItem;
      if (transition.graphAdvance) {
        const graphState = this.#graphWorkItemState(workItem.id);
        workItemStatus = graphState.status;
        currentActionId = graphState.currentActionId;
        changedWorkItem = this.db.prepare(`UPDATE work_items SET status = ?, current_action_id = ?,
          current_run_id = NULL, ledger_revision = ledger_revision + ?, updated_at = ?
          WHERE id = ? AND status IN ('ready', 'running', 'waiting', 'needs_attention')
          AND revision = ?`).run(
          workItemStatus, currentActionId, ledgerIncrement, now, workItem.id, nextWorkItem.revision,
        );
      } else {
        changedWorkItem = this.db.prepare(`UPDATE work_items SET status = ?, current_action_id = ?,
          current_run_id = NULL, ledger_revision = ledger_revision + ?, updated_at = ? WHERE id = ? AND current_run_id = ?
          AND current_action_id = ? AND status = 'running' AND revision = ?`).run(
          workItemStatus, currentActionId, ledgerIncrement, now, workItem.id, runId, action.id, nextWorkItem.revision,
        );
      }
      if (Number(changedWorkItem.changes) !== 1) {
        throw new Error('Work Center terminal transition lost the current WorkItem fence');
      }
      if (transition.workflowSnapshot || transition.replanBarrier) {
        const proposalId = transition.proposalId || transition.replanBarrier?.proposalId;
        if (!proposalId) throw new Error('Work Center plan mutation requires proposalId');
        try {
          this.db.prepare(`INSERT INTO plan_audits
            (work_item_id, proposal_id, base_plan_revision, plan_revision, kind, action_id, run_id, data, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
            workItem.id, proposalId, workItem.planRevision, nextWorkItem.planRevision,
            transition.replanBarrier ? 'replan' : (workItem.planRevision === 0 ? 'initial' : 'expand'),
            action.id, runId, stringify(transition.eventData || {}), now,
          );
        } catch (error) {
          if (String(error?.message || '').includes('UNIQUE constraint failed')) {
            throw new Error(`Work Center plan proposal was already applied: ${proposalId}`);
          }
          throw error;
        }
      }
      this.onTransitionStep?.('before_event');
      this.appendEvent(workItem.id, transition.eventType, {
        ...(transition.eventData || {}),
        ...((transition.workflowSnapshot || transition.replanBarrier) ? {
          proposalId: transition.proposalId || transition.replanBarrier?.proposalId || null,
          previousPlanRevision: workItem.planRevision,
          planRevision: nextWorkItem.planRevision,
        } : {}),
      }, {
        actionId: action.id,
        runId,
      });
      return this.getWorkItemDetail(workItem.id);
    });
  }

  #refreshGraphWorkItem(workItemId, now) {
    const remaining = this.db.prepare(`SELECT id, status FROM actions WHERE work_item_id = ?
      AND status IN ('ready', 'running', 'waiting', 'failed') ORDER BY sequence`).all(workItemId);
    const blocked = remaining.find(action => action.status === 'waiting' || action.status === 'failed');
    const runnable = remaining.find(action => action.status === 'ready' || action.status === 'running');
    const status = blocked ? (blocked.status === 'waiting' ? 'waiting' : 'needs_attention')
      : runnable ? (remaining.some(action => action.status === 'running') ? 'running' : 'ready')
        : 'done';
    const currentActionId = blocked?.id || runnable?.id || null;
    this.db.prepare(`UPDATE work_items SET status = ?, current_action_id = ?, current_run_id = NULL,
      updated_at = ? WHERE id = ?`).run(status, currentActionId, now, workItemId);
  }

  recoverInterruptedRuns(ownerBootId) {
    return withTransaction(this.db, () => {
      const now = this.now();
      const rows = this.db.prepare(`SELECT * FROM runs
        WHERE status = 'running' AND (owner_boot_id != ? OR expires_at <= ?)`).all(ownerBootId, now);
      let recovered = 0;
      for (const row of rows) {
        const action = this.getAction(row.action_id);
        if (this.#hasActiveIntegrationReservation(action, now)) continue;
        const workItem = this.getWorkItem(row.work_item_id);
        const graphMode = isGraphWorkItem(workItem);
        const isCurrent = action?.status === 'running'
          && action.currentRunId === row.id
          && action.leaseEpoch === row.lease_epoch
          && workItem?.status === 'running'
          && (graphMode || (workItem.currentActionId === action.id && workItem.currentRunId === row.id));
        if (!isCurrent) {
          const staleStatus = workItem?.status === 'cancelled' ? 'cancelled' : 'superseded';
          const stillOwnsAction = action?.status === 'running'
            && action.currentRunId === row.id
            && action.leaseEpoch === row.lease_epoch;
          if (stillOwnsAction) {
            const retryable = action.type !== 'deliver' && action.attempt < action.maxAttempts;
            this.db.prepare(`UPDATE actions SET status = ?, current_run_id = NULL, updated_at = ?
              WHERE id = ? AND status = 'running' AND current_run_id = ? AND lease_epoch = ?`).run(
              retryable ? 'ready' : 'failed', now, action.id, row.id, row.lease_epoch,
            );
          }
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
          if (graphMode && workItem) this.#refreshGraphWorkItem(workItem.id, now);
          recovered += 1;
          continue;
        }

        this.db.prepare(`UPDATE runs SET status = 'interrupted', ended_at = ?,
          error = 'Agent process or lease ended before the Run submitted a terminal outcome'
          WHERE id = ?`).run(now, row.id);
        const retryable = action.type !== 'deliver' && action.attempt < action.maxAttempts;
        this.db.prepare(`UPDATE actions SET status = ?, current_run_id = NULL, updated_at = ?
          WHERE id = ?`).run(retryable ? 'ready' : 'failed', now, action.id);
        if (graphMode) {
          this.#refreshGraphWorkItem(workItem.id, now);
        } else {
          this.db.prepare(`UPDATE work_items SET status = ?, current_action_id = ?,
            current_run_id = NULL, updated_at = ? WHERE id = ?`).run(
            retryable ? 'ready' : 'needs_attention',
            action.id,
            now,
            workItem.id,
          );
        }
        this.appendEvent(workItem.id, 'run.interrupted', { retryable }, {
          actionId: action.id,
          runId: row.id,
        });
        recovered += 1;
      }
      return recovered;
    });
  }
}
