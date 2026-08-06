import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { Engine } from './engine.js';
import { createRouter } from './routing/router.js';
import { createCoordinator } from './sessions/coordinator.js';
import { resolveMemberId } from './sessions/roster.js';
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
  configureEngine = null,
} = {}) {
  if (!loaded || !sessionId) return null;
  const sessionDir = join(sessionsRoot(loaded.yeaftDir), sessionId);
  if (!loadSessionMeta(sessionDir)) return null;

  const handle = openSession(sessionsRoot(loaded.yeaftDir), sessionId);
  const engines = new Map();
  const tails = new Map();
  const pending = new Set();
  // Root turns are accepted synchronously but execute on per-VP promise tails.
  // Durable rows therefore cannot use append order as their causal boundary: a
  // later root user row may be written before an earlier VP starts, while the
  // earlier VP's assistant rows may be written after that later user row. Every
  // new row carries one durable causalRootId; the legacy ids remain fallbacks
  // for rows produced before that field existed.
  const rootOrderByIdentity = new Map();
  let nextRootOrder = 0;
  let closed = false;

  const engineFor = (vpId) => {
    let engine = engines.get(vpId);
    if (!engine) {
      engine = engineFactory(loaded, sessionId, vpId);
      if (typeof configureEngine === 'function') configureEngine(engine, vpId);
      engines.set(vpId, engine);
    }
    return engine;
  };

  let coordinator;

  const runEnvelope = async (vpId, envelope, options) => {
    const meta = handle.getMeta();
    const engine = engineFor(vpId);
    const prompt = envelope?.msg?.text || '';
    const persistedUserClientMessageId = typeof envelope?._persistedUserClientMessageId === 'string'
      ? envelope._persistedUserClientMessageId
      : null;
    const causalRootId = typeof envelope?._cliCausalRootId === 'string' && envelope._cliCausalRootId
      ? envelope._cliCausalRootId
      : null;
    const rootOrder = Number.isInteger(envelope?._cliRootOrder)
      ? envelope._cliRootOrder
      : null;
    // Engine.query() appends `prompt` itself. Exclude this root's durable user
    // row and every later root turn, regardless of where their assistant/tool
    // rows landed in the globally sequenced transcript. This preserves rows
    // completed by earlier accepted roots while preventing future prompts from
    // entering an earlier provider request.
    const messages = loaded.conversationStore
      .loadSessionHistoryForVp(sessionId, vpId)
      .filter((message) => {
        if (persistedUserClientMessageId
            && message?.role === 'user'
            && message.clientMessageId === persistedUserClientMessageId) return false;
        if (rootOrder === null) return true;
        let messageRootOrder = null;
        if (typeof message?.causalRootId === 'string' && message.causalRootId) {
          // A durable causal root is authoritative. Do not reinterpret a row by
          // its role-specific legacy ids when this field is present.
          messageRootOrder = rootOrderByIdentity.get(message.causalRootId);
        } else if (message?.role === 'user' && typeof message.clientMessageId === 'string') {
          messageRootOrder = rootOrderByIdentity.get(message.clientMessageId);
        } else if (typeof message?.turnId === 'string') {
          messageRootOrder = rootOrderByIdentity.get(message.turnId);
        }
        return !Number.isInteger(messageRootOrder) || messageRootOrder < rootOrder;
      });
    const todos = [];
    let resultText = '';
    let failed = null;
    const scopedCoordinator = {
      group: coordinator.group,
      ingest(input, opts) {
        const report = coordinator.ingest({
          ...input,
          _cliRootOrder: envelope._cliRootOrder,
          _cliCausalRootId: envelope._cliCausalRootId,
          _cliTurnContext: envelope._cliTurnContext,
        }, opts);
        if (rootOrder !== null && typeof report?.message?.id === 'string') {
          rootOrderByIdentity.set(report.message.id, rootOrder);
        }
        return report;
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
      causalRootId,
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
        ? request => options.askUser(request, vpId, queryOptions.vpTurnId, queryOptions.threadId)
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
    if (turnContext.claimedVpIds.has(vpId)) {
      return { ok: false, error: 'target_already_claimed' };
    }
    turnContext.claimedVpIds.add(vpId);
    const previous = tails.get(vpId) || Promise.resolve();
    const task = previous.catch(() => {}).then(() => runEnvelope(vpId, envelope, turnContext.options));
    tails.set(vpId, task);
    pending.add(task);
    turnContext.tasks.push(task);
    task.finally(() => {
      pending.delete(task);
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
      let routingIntent = options.routingIntent && typeof options.routingIntent === 'object'
        ? options.routingIntent
        : null;
      if (routingIntent) {
        const meta = handle.getMeta();
        const rawTargets = Array.isArray(routingIntent.targetVpIds)
          ? routingIntent.targetVpIds
          : [];
        const targetVpIds = [];
        for (const rawTarget of rawTargets) {
          const target = typeof rawTarget === 'string' ? rawTarget.trim() : '';
          const resolved = resolveMemberId(meta, target);
          if (!resolved) throw new Error(`Unknown stream-json target VP ${target || String(rawTarget)}: not in roster`);
          if (!targetVpIds.includes(resolved)) targetVpIds.push(resolved);
        }
        if (routingIntent.broadcast === true) {
          for (const vpId of meta.roster) {
            if (!targetVpIds.includes(vpId)) targetVpIds.push(vpId);
          }
        }
        if (targetVpIds.length === 0) throw new Error('stream-json routing intent requires at least one target VP');
        routingIntent = Object.freeze({
          targetVpIds: Object.freeze(targetVpIds),
          broadcast: routingIntent.broadcast === true,
          explicit: routingIntent.explicit === true,
        });
      }
      const turnContext = Object.freeze({
        options: Object.freeze({ ...options }),
        tasks: [],
        claimedVpIds: new Set(),
      });
      const messageId = randomUUID();
      const rootOrder = nextRootOrder++;
      rootOrderByIdentity.set(messageId, rootOrder);
      // The shared user row is the durability boundary. Validate structured
      // routing above before this append so malformed machine selectors never
      // enter the transcript or reach a provider.
      let persistedUserClientMessageId = null;
      if (!options.internal) {
        const persistedUser = loaded.conversationStore.append({
          role: 'user',
          content: prompt,
          sessionId,
          threadId: 'main',
          clientMessageId: messageId,
          causalRootId: messageId,
          userAuthored: true,
        });
        persistedUserClientMessageId = persistedUser?.clientMessageId || messageId;
      }
      const report = coordinator.ingest({
        id: messageId,
        from: options.internal ? 'tool' : 'user',
        role: options.internal ? 'assistant' : 'user',
        text: prompt,
        ...(options.internal ? {
          internal: true,
          taskId: options.taskId || null,
          meta: {
            ...(options.meta || {}),
            injectedBy: 'task_result',
            ...(routingIntent?.targetVpIds?.[0]
              ? { routeTargetVpId: routingIntent.targetVpIds[0] }
              : {}),
          },
        } : {}),
        ...(routingIntent ? { _routingIntent: routingIntent } : {}),
        ...(persistedUserClientMessageId ? { _persistedUserClientMessageId: persistedUserClientMessageId } : {}),
        _cliRootOrder: rootOrder,
        _cliCausalRootId: messageId,
        _cliTurnContext: turnContext,
      });
      const results = [];
      let cursor = 0;
      while (cursor < turnContext.tasks.length) {
        const batch = turnContext.tasks.slice(cursor);
        cursor += batch.length;
        results.push(...await Promise.all(batch));
        await Promise.resolve();
      }
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
