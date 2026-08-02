import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { Engine } from './engine.js';
import { createRouter } from './routing/router.js';
import { createCoordinator } from './sessions/coordinator.js';
import { sessionsRoot } from './sessions/session-crud.js';
import { openSession, loadSessionMeta } from './sessions/session-store.js';
import { loadSessionConfig, resolveSessionConfig } from './sessions/session-config.js';
import { readVp } from './vp/vp-crud.js';
import { COLLAB_TOOL_POLICY } from './tools/registry.js';

function buildVpPersona(vpId, loaded) {
  const vp = readVp(vpId, { libDir: join(loaded.yeaftDir, 'virtual-persons') });
  if (!vp) return null;
  return {
    vpId,
    displayName: vp.displayName || vpId,
    displayNameZh: vp.displayNameZh || '',
    role: vp.role || '',
    roleZh: vp.roleZh || '',
    persona: vp.persona || '',
    planInstruction: vp.planInstruction || '',
  };
}

export function createCliVpEngine(loaded, sessionId, vpId) {
  const effectiveConfig = resolveSessionConfig(
    loaded.config,
    loadSessionConfig(loaded.yeaftDir, sessionId),
  );
  return new Engine({
    adapter: loaded.adapter,
    trace: loaded.trace,
    config: effectiveConfig,
    conversationStore: loaded.conversationStore,
    memoryIndex: loaded.memoryIndex || null,
    amsRegistry: loaded.amsRegistry || null,
    toolRegistry: loaded.toolRegistry,
    skillManager: loaded.skillManager,
    mcpManager: loaded.mcpManager,
    yeaftDir: loaded.yeaftDir,
    toolStats: loaded.toolStats || null,
    taskManager: loaded.taskManager || null,
    managedCliReady: loaded.managedCliReady || null,
    sessionId,
    vpId,
  });
}

/**
 * Open a transport-neutral multi-VP runtime for an existing Yeaft Session.
 * Different VPs run concurrently; each VP owns one serial promise tail and
 * one Engine, matching the WebSocket runtime's state-isolation rule.
 *
 * Returns null when session metadata does not exist so legacy one-engine CLI
 * invocations can keep their existing behavior.
 */
export function createCliSessionRunner({
  loaded,
  sessionId,
  workDir = process.cwd(),
  engineFactory = createCliVpEngine,
  personaFactory = buildVpPersona,
} = {}) {
  if (!loaded || !sessionId) return null;
  const sessionDir = join(sessionsRoot(loaded.yeaftDir), sessionId);
  if (!loadSessionMeta(sessionDir)) return null;

  const handle = openSession(sessionsRoot(loaded.yeaftDir), sessionId);
  const engines = new Map();
  const tails = new Map();
  const pending = new Set();
  let closed = false;

  const engineFor = (vpId) => {
    let engine = engines.get(vpId);
    if (!engine) {
      engine = engineFactory(loaded, sessionId, vpId);
      engines.set(vpId, engine);
    }
    return engine;
  };

  let coordinator;

  const runEnvelope = async (vpId, envelope, options) => {
    const meta = handle.getMeta();
    const engine = engineFor(vpId);
    const promptText = envelope?.msg?.text || '';
    const prompt = `@vp-${vpId} ${promptText}`;
    const messages = loaded.conversationStore.loadSessionHistoryForVp(sessionId, vpId);
    const todos = [];
    let resultText = '';
    let failed = null;
    const scopedCoordinator = {
      group: coordinator.group,
      ingest(input, opts) {
        return coordinator.ingest({ ...input, _cliTurnContext: envelope._cliTurnContext }, opts);
      },
    };
    const queryOptions = {
      prompt,
      messages,
      sessionId,
      workDir: meta.workDir || workDir,
      senderVpId: vpId,
      sessionMembers: meta.roster.slice(),
      sessionAnnouncement: meta.announcement || '',
      vpPersona: personaFactory(vpId, loaded),
      router: createRouter({ coordinator: scopedCoordinator }),
      inboundEnvelope: envelope,
      userAlreadyPersisted: true,
      threadId: 'main',
      vpTurnId: envelope?.msg?.id || randomUUID(),
      collabToolPolicy: meta.roster.length > 1
        ? COLLAB_TOOL_POLICY.MULTI_VP
        : COLLAB_TOOL_POLICY.SINGLE_VP,
      getCurrentTodos: () => todos.slice(),
      setCurrentTodos: (next) => {
        todos.splice(0, todos.length, ...(Array.isArray(next) ? next : []));
      },
      askUser: options.askUser
        ? request => options.askUser(request, vpId, queryOptions.vpTurnId)
        : null,
      userEffort: options.modelEffort || null,
    };

    try {
      for await (const event of engine.query(queryOptions)) {
        if (event.type === 'text_delta') resultText += event.text || '';
        else if (event.type === 'error' && !failed) {
          failed = event.error instanceof Error
            ? event.error
            : new Error(String(event.error?.message || event.error || 'Unknown Engine error'));
        }
        await options.onEvent?.({ vpId, event, sessionId, turnId: queryOptions.vpTurnId });
      }
    } catch (error) {
      failed = error;
      await options.onEvent?.({
        vpId,
        sessionId,
        turnId: queryOptions.vpTurnId,
        event: { type: 'error', error, retryable: false },
      });
    }
    return { vpId, result: resultText, error: failed };
  };

  const enqueue = (vpId, envelope) => {
    if (closed) throw new Error('CLI Session runner is closed');
    const turnContext = envelope?._cliTurnContext;
    if (!turnContext) throw new Error('CLI Session envelope is missing its turn context');
    const previous = tails.get(vpId) || Promise.resolve();
    const task = previous.catch(() => {}).then(() => runEnvelope(vpId, envelope, turnContext.options));
    tails.set(vpId, task);
    pending.add(task);
    turnContext.pending.add(task);
    task.finally(() => {
      pending.delete(task);
      turnContext.pending.delete(task);
      if (tails.get(vpId) === task) tails.delete(vpId);
    }).catch(() => {});
    return task;
  };

  coordinator = createCoordinator(handle, { deliver: enqueue });

  async function drain(tasks = pending) {
    const results = [];
    while (tasks.size > 0) {
      const batch = Array.from(tasks);
      results.push(...await Promise.all(batch));
      await Promise.resolve();
    }
    return results;
  }

  return {
    sessionId,
    get meta() { return handle.getMeta(); },
    async run(prompt, options = {}) {
      if (closed) throw new Error('CLI Session runner is closed');
      const turnContext = Object.freeze({ options: Object.freeze({ ...options }), pending: new Set() });
      const messageId = randomUUID();
      // The shared user row is the durability boundary. Every VP Engine skips
      // its own user append, preventing @all from duplicating the prompt N times.
      loaded.conversationStore.append({
        role: 'user',
        content: prompt,
        sessionId,
        threadId: 'main',
        clientMessageId: messageId,
        userAuthored: true,
      });
      const report = coordinator.ingest({
        id: messageId,
        from: 'user',
        role: 'user',
        text: prompt,
        _cliTurnContext: turnContext,
      });
      const results = await drain(turnContext.pending);
      return { report, results };
    },
    abort(reason = 'user') {
      let count = 0;
      for (const engine of engines.values()) {
        if (engine.abort?.(reason)) count += 1;
      }
      return count;
    },
    async close() {
      closed = true;
      await drain();
      handle.close();
    },
  };
}
