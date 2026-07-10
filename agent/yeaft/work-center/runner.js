import { Engine } from '../engine.js';
import { ToolRegistry } from '../tools/registry.js';
import { allTools } from '../tools/index.js';
import { parsePatch } from '../tools/apply-patch.js';
import { defaultRegistry } from '../vp/registry.js';
import { NullTrace } from '../debug-trace.js';
import { isPathInsideOrEqual } from '../tools/path-safety.js';
import { existsSync, lstatSync, realpathSync } from 'node:fs';
import path from 'node:path';

const WORK_ITEM_TOOL_NAMES = Object.freeze([
  'FileRead',
  'FileWrite',
  'FileEdit',
  'ApplyPatch',
  'Glob',
  'Grep',
  'ListDir',
  'Bash',
  'WebSearch',
  'WebFetch',
]);
const WORK_ITEM_TOOL_ALLOWLIST = new Set(WORK_ITEM_TOOL_NAMES);

function copyVp(vp) {
  if (!vp) return null;
  return {
    id: vp.id,
    name: vp.name,
    nameZh: vp.nameZh || '',
    role: vp.role,
    roleZh: vp.roleZh || '',
    traits: Array.isArray(vp.traits) ? [...vp.traits] : [],
    modelHint: vp.modelHint || null,
    persona: vp.persona || '',
    personaHash: vp.personaHash || null,
  };
}

function personaFor(vp) {
  return {
    vpId: vp.id,
    displayName: vp.name || vp.id,
    displayNameZh: vp.nameZh || vp.name || vp.id,
    role: vp.role || '',
    roleZh: vp.roleZh || vp.role || '',
    persona: vp.persona || '',
    planInstruction: '',
  };
}

function canonicalWorkDir(workDir) {
  if (!existsSync(workDir)) throw new Error(`WorkItem workDir does not exist: ${workDir}`);
  return realpathSync(workDir);
}

function assertPathInside(toolName, workDir, value) {
  const resolved = path.resolve(workDir, value);
  if (!isPathInsideOrEqual(workDir, resolved)) {
    throw new Error(`${toolName} path escapes the WorkItem workDir`);
  }

  const relative = path.relative(workDir, resolved);
  let current = workDir;
  for (const component of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    try {
      if (lstatSync(current).isSymbolicLink()) {
        throw new Error(`${toolName} path escapes the WorkItem workDir through a symbolic link`);
      }
    } catch (error) {
      if (error?.code === 'ENOENT') break;
      throw error;
    }
  }
  return resolved;
}

function assertToolInput(toolName, input, workDir) {
  if (toolName === 'Bash') {
    if (input?.background === true) throw new Error('Work Center does not allow background Bash jobs');
    if (input?.cwd && canonicalWorkDir(path.resolve(input.cwd)) !== workDir) {
      throw new Error('Work Center Bash cwd is fixed to the WorkItem workDir');
    }
    // fixedCwd is process setup, not a shell sandbox. The WorkItem role is
    // trusted; containers are required before running untrusted shell input.
    return { ...input, cwd: workDir, background: false };
  }
  const pathKeys = ['file_path', 'notebook_path', 'output_path', 'path'];
  const next = { ...(input || {}) };
  for (const key of pathKeys) {
    if (typeof next[key] !== 'string' || !next[key]) continue;
    next[key] = assertPathInside(toolName, workDir, next[key]);
  }
  if (toolName === 'ApplyPatch' && typeof next.patch === 'string') {
    for (const fileDiff of parsePatch(next.patch)) {
      assertPathInside('ApplyPatch', workDir, fileDiff.file);
    }
  }
  return next;
}

export function workItemToolPolicySnapshot(workDir) {
  return {
    policyVersion: 1,
    allowedToolNames: [...WORK_ITEM_TOOL_NAMES],
    readRoots: [workDir],
    writeRoots: [workDir],
    shell: { enabled: true, fixedCwd: workDir, background: false, sandboxed: false },
    async: false,
    mcpTools: [],
  };
}

export function createWorkItemToolRegistry({ workDir, isRunActive }) {
  const canonicalDir = canonicalWorkDir(path.resolve(workDir));
  const registry = new ToolRegistry();
  for (const tool of allTools) {
    if (!WORK_ITEM_TOOL_ALLOWLIST.has(tool.name)) continue;
    registry.register({
      ...tool,
      async execute(input, ctx) {
        if (!isRunActive()) throw new Error('Work Center Run lease is no longer active');
        const output = await tool.execute(assertToolInput(tool.name, input, canonicalDir), {
          ...ctx,
          cwd: canonicalDir,
          workDir: canonicalDir,
        });
        if (!isRunActive()) throw new Error('Work Center Run lease was lost during tool execution');
        return output;
      },
    });
  }
  return registry;
}

export function parseStructuredResult(text, actionType) {
  const fenced = String(text || '').match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = [fenced?.[1], String(text || '')].filter(Boolean);
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate.trim());
      if (!['completed', 'waiting', 'retryable', 'failed'].includes(parsed.outcome)) continue;
      const result = {
        outcome: parsed.outcome,
        summary: String(parsed.summary || ''),
        evidence: Array.isArray(parsed.evidence) ? parsed.evidence : [],
        waitingReason: parsed.waitingReason ? String(parsed.waitingReason) : null,
        error: parsed.error ? String(parsed.error) : null,
        reviewDecision: ['approved', 'changes_requested'].includes(parsed.reviewDecision)
          ? parsed.reviewDecision
          : null,
        contractPatch: actionType === 'triage' && parsed.contractPatch && typeof parsed.contractPatch === 'object'
          ? parsed.contractPatch
          : null,
      };
      if (actionType === 'review' && result.outcome === 'completed' && !result.reviewDecision) {
        return {
          ...result,
          outcome: 'failed',
          error: 'Completed review requires approved or changes_requested',
        };
      }
      return result;
    } catch {}
  }
  return {
    outcome: 'failed',
    summary: String(text || '').trim(),
    evidence: [],
    error: 'Agent did not submit the required structured Work Center outcome',
  };
}

function completionContract(action) {
  const reviewField = action.type === 'review'
    ? ',\n  "reviewDecision": "approved|changes_requested"'
    : '';
  const triageField = action.type === 'triage'
    ? ',\n  "contractPatch": { "goal": "optional refined goal", "acceptanceCriteria": ["optional refined criterion"] }'
    : '';
  return `\n\nYou are executing one Work Center Action. End your response with exactly one JSON object, preferably in a json code fence:\n{
  "outcome": "completed|waiting|retryable|failed",
  "summary": "short result",
  "evidence": ["test, PR, file, or other verifiable evidence"],
  "waitingReason": null,
  "error": null${reviewField}${triageField}
}\nA model turn ending is not completion. Use waiting when user or external input is required. Use retryable only for a transient failure. Do not start background jobs or delegate this Action.`;
}

function resolveModel(config, vp) {
  if (vp.modelHint === 'fast' && config.fastModel) return config.fastModel;
  if (vp.modelHint === 'primary' && config.primaryModel) return config.primaryModel;
  return config.model || config.primaryModel || null;
}

export class WorkItemRunner {
  constructor(options) {
    this.runtimeProvider = options.runtimeProvider;
    this.store = options.store;
    this.registry = options.registry || defaultRegistry;
  }

  async run({ workItem, action, run, signal, ownerBootId }) {
    const runtime = await this.runtimeProvider();
    const rawWorkDir = workItem.workDir || runtime.defaultWorkDir || process.cwd();
    const workDir = canonicalWorkDir(path.resolve(rawWorkDir));
    const vp = copyVp(this.registry.getVp(action.requiredRole));
    if (!vp) {
      const error = new Error(`Required Work Center role is unavailable: ${action.requiredRole}`);
      error.retryable = false;
      throw error;
    }
    const isRunActive = () => !signal.aborted
      && this.store.isActiveRun(run.id, ownerBootId, run.leaseEpoch);
    const toolPolicySnapshot = workItemToolPolicySnapshot(workDir);
    const toolRegistry = createWorkItemToolRegistry({ workDir, isRunActive });
    const model = resolveModel(runtime.config, vp);
    const config = {
      ...runtime.config,
      model,
      _readOnly: true,
      serverMode: true,
      // WorkItem messages live in the Work Center DB. Never archive their
      // transient tool bodies into the user memory tree.
      archive: { ...(runtime.config.archive || {}), toolResults: false },
    };
    if (!this.store || typeof this.store.setRunExecutionSnapshots !== 'function') {
      throw new Error('Work Center Runner requires a persistent Run store');
    }
    const snapshotsWritten = this.store.setRunExecutionSnapshots(
      run.id,
      ownerBootId,
      run.leaseEpoch,
      {
        roleSnapshot: { id: action.requiredRole, actionType: action.type },
        vpSnapshot: vp,
        modelSnapshot: { id: model, provider: runtime.config.provider || null },
        toolPolicySnapshot,
      },
    );
    if (!snapshotsWritten) throw new Error('Work Center Run lost its lease before execution');

    const engine = new Engine({
      adapter: runtime.adapter,
      trace: new NullTrace(),
      config,
      conversationStore: null,
      memoryIndex: null,
      amsRegistry: null,
      toolRegistry,
      skillManager: null,
      mcpManager: null,
      // WorkItem execution has its own durable Run/Event record. Do not let
      // the Engine create Session exec logs, archives, or shared tool stats.
      yeaftDir: null,
      toolStats: null,
      taskManager: null,
      vpId: vp.id,
    });

    let text = '';
    try {
      for await (const event of engine.query({
        prompt: `${action.instruction}${completionContract(action)}`,
        messages: [],
        signal,
        scenario: 'work-item',
        vpPersona: personaFor(vp),
        workDir,
        userAlreadyPersisted: true,
        collabToolPolicy: 'single-vp',
      })) {
        if (typeof event?.text === 'string') text += event.text;
        else if (typeof event?.delta === 'string') text += event.delta;
        else if (typeof event?.content === 'string' && event.type === 'assistant') text += event.content;
      }
    } finally {
      try { engine.abort?.('work_item_run_finished'); } catch {}
    }
    return parseStructuredResult(text, action.type);
  }
}
