import { Engine } from '../engine.js';
import { ToolRegistry } from '../tools/registry.js';
import { allTools } from '../tools/index.js';
import { defaultRegistry } from '../vp/registry.js';
import { NullTrace } from '../debug-trace.js';
import { isPathInsideOrEqual } from '../tools/path-safety.js';
import path from 'node:path';

const WORK_ITEM_TOOL_ALLOWLIST = new Set([
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
  if (!vp) return null;
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

function assertToolInput(toolName, input, workDir) {
  if (toolName === 'Bash') {
    if (input?.background === true) throw new Error('Work Center does not allow background Bash jobs');
    if (input?.cwd && path.resolve(input.cwd) !== path.resolve(workDir)) {
      throw new Error('Work Center Bash cwd is fixed to the WorkItem workDir');
    }
    return { ...input, cwd: workDir, background: false };
  }
  const pathKeys = ['file_path', 'notebook_path', 'output_path', 'path'];
  const next = { ...(input || {}) };
  for (const key of pathKeys) {
    if (typeof next[key] !== 'string' || !next[key]) continue;
    const resolved = path.resolve(workDir, next[key]);
    if (!isPathInsideOrEqual(workDir, resolved)) {
      throw new Error(`${toolName} path escapes the WorkItem workDir`);
    }
    next[key] = resolved;
  }
  if (toolName === 'ApplyPatch' && typeof next.patch === 'string') {
    const headers = [...next.patch.matchAll(/^\+\+\+\s+([^\t\r\n]+)$/gm)].map(match => match[1]);
    for (const header of headers) {
      if (header === '/dev/null') continue;
      const patchPath = header.replace(/^[ab]\//, '');
      const resolved = path.resolve(workDir, patchPath);
      if (!isPathInsideOrEqual(workDir, resolved)) {
        throw new Error('ApplyPatch target escapes the WorkItem workDir');
      }
    }
  }
  return next;
}

export function createWorkItemToolRegistry({ workDir, isRunActive }) {
  const registry = new ToolRegistry();
  for (const tool of allTools) {
    if (!WORK_ITEM_TOOL_ALLOWLIST.has(tool.name)) continue;
    registry.register({
      ...tool,
      async execute(input, ctx) {
        if (!isRunActive()) throw new Error('Work Center Run lease is no longer active');
        const output = await tool.execute(assertToolInput(tool.name, input, workDir), {
          ...ctx,
          cwd: workDir,
          workDir,
        });
        if (!isRunActive()) throw new Error('Work Center Run lease was lost during tool execution');
        return output;
      },
    });
  }
  return registry;
}

function parseStructuredResult(text, actionType) {
  const fenced = String(text || '').match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = [fenced?.[1], String(text || '')].filter(Boolean);
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate.trim());
      if (['completed', 'waiting', 'retryable', 'failed'].includes(parsed.outcome)) {
        return {
          outcome: parsed.outcome,
          summary: String(parsed.summary || ''),
          evidence: Array.isArray(parsed.evidence) ? parsed.evidence : [],
          waitingReason: parsed.waitingReason ? String(parsed.waitingReason) : null,
          error: parsed.error ? String(parsed.error) : null,
          reviewDecision: actionType === 'review' && ['approved', 'changes_requested'].includes(parsed.reviewDecision)
            ? parsed.reviewDecision
            : null,
        };
      }
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
  return `\n\nYou are executing one Work Center Action. End your response with exactly one JSON object, preferably in a json code fence:\n{
  "outcome": "completed|waiting|retryable|failed",
  "summary": "short result",
  "evidence": ["test, PR, file, or other verifiable evidence"],
  "waitingReason": null,
  "error": null${action.type === 'review' ? ',\n  "reviewDecision": "approved|changes_requested"' : ''}
}\nA model turn ending is not completion. Use waiting when user or external input is required. Use retryable only for a transient failure. Do not start background jobs or delegate this Action.`;
}

export class WorkItemRunner {
  constructor(options) {
    this.runtimeProvider = options.runtimeProvider;
    this.store = options.store;
    this.registry = options.registry || defaultRegistry;
  }

  async run({ workItem, action, run, signal, ownerBootId }) {
    const runtime = await this.runtimeProvider();
    const workDir = workItem.workDir || runtime.defaultWorkDir || process.cwd();
    const vp = copyVp(this.registry.getVp(action.requiredRole) || this.registry.getVp('omni'));
    const isRunActive = () => !signal.aborted
      && this.store.isActiveRun(run.id, ownerBootId, run.leaseEpoch);
    const toolRegistry = createWorkItemToolRegistry({ workDir, isRunActive });
    const config = {
      ...runtime.config,
      _readOnly: true,
      serverMode: true,
    };
    if (vp?.modelHint === 'fast' && runtime.config.fastModel) {
      config.model = runtime.config.fastModel;
    } else if (vp?.modelHint === 'primary' && runtime.config.primaryModel) {
      config.model = runtime.config.primaryModel;
    }
    const engine = new Engine({
      adapter: runtime.adapter,
      // WorkItem execution must not appear in a Session debug timeline.
      // Run/Event evidence is persisted by Work Center itself.
      trace: new NullTrace(),
      config,
      conversationStore: null,
      memoryIndex: null,
      amsRegistry: null,
      toolRegistry,
      skillManager: null,
      mcpManager: null,
      yeaftDir: runtime.yeaftDir,
      toolStats: runtime.toolStats || null,
      taskManager: null,
      vpId: vp?.id || action.requiredRole,
    });

    let text = '';
    const toolEvidence = [];
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
        if (event?.type === 'tool_end') {
          toolEvidence.push({
            tool: event.name,
            isError: !!event.isError,
            output: String(event.output || '').slice(0, 2_000),
          });
        }
      }
    } finally {
      try { engine.abort?.('work_item_run_finished'); } catch {}
    }
    const result = parseStructuredResult(text, action.type);
    result.evidence = [...result.evidence, ...toolEvidence].slice(-100);
    return result;
  }
}
