import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCoordinator } from '../../../agent/yeaft/sessions/coordinator.js';
import { createRouter } from '../../../agent/yeaft/routing/router.js';
import { createLoopGuard, MAX_CHAIN_DEPTH } from '../../../agent/yeaft/routing/loop-guard.js';
import { NullTrace } from '../../../agent/yeaft/debug-trace.js';
import { ToolRegistry } from '../../../agent/yeaft/tools/registry.js';
import routeForwardTool from '../../../agent/yeaft/tools/route-forward.js';
import {
  __testEnqueueForVp,
  __testGetVpThreads,
  __testSeedVpThread,
  __testSetVpThreadEngine,
  __testSetSession,
  __testSetThreadClassifier,
  __testWaitForRoutePromises,
  buildVpQueryOpts,
  visibleInboundThreadId,
  __testHooks,
} from '../../../agent/yeaft/web-bridge.js';

describe('route_forward thread ownership', () => {
  it('describes route_forward as the required multi-VP hand-off tool', () => {
    expect(routeForwardTool.description.en).toContain('required hand-off mechanism');
    expect(routeForwardTool.description.en).toContain('VP-authored @mentions');
    expect(routeForwardTool.description.en).toContain('call RouteForward');
    expect(routeForwardTool.description.en).toContain('same session');
  });

  it('allows 30 causedBy hops and rejects the 31st', () => {
    const guard = createLoopGuard();
    const allowed = Array.from({ length: MAX_CHAIN_DEPTH }, (_, i) => `msg-${i}`);
    const blocked = [...allowed, 'msg-overflow'];

    expect(MAX_CHAIN_DEPTH).toBe(30);
    expect(guard.check({
      sessionId: 'session-route-depth',
      targetVpId: 'vp-martin',
      chain: allowed,
    })).toEqual({ ok: true });
    expect(guard.check({
      sessionId: 'session-route-depth',
      targetVpId: 'vp-martin',
      chain: blocked,
    })).toEqual({
      ok: false,
      reason: 'chain_depth_exceeded',
      detail: { depth: 31, limit: 30 },
    });
    expect(routeForwardTool.description.en).toContain('deeper than 30 hops');
    expect(routeForwardTool.description.zh).toContain('超过 30 跳');
  });

  afterEach(() => {
    __testSetSession(null);
    __testSetThreadClassifier(null);
  });

  function makeCoordinator() {
    const stored = [];
    const delivered = [];
    const group = {
      getMeta() {
        return {
          id: 'session-route-thread',
          roster: ['vp-linus', 'vp-martin'],
          defaultVpId: 'vp-linus',
        };
      },
      appendMessage(record) {
        const msg = {
          id: `msg-${stored.length + 1}`,
          ts: '2026-06-12T00:00:00.000Z',
          ...record,
        };
        stored.push(msg);
        return msg;
      },
    };
    const coordinator = createCoordinator(group, {
      deliver(vpId, envelope) {
        delivered.push({ vpId, envelope });
      },
    });
    return { coordinator, stored, delivered };
  }

  it('delivers user text with unknown @ tokens to the default VP', () => {
    const { coordinator, stored, delivered } = makeCoordinator();

    const result = coordinator.ingest({
      from: 'user',
      role: 'user',
      text: 'send updates to example@company.com and keep @nobody in the sample',
    });

    expect(result).toMatchObject({
      dispatched: ['vp-linus'],
      fallback: 'vp-linus',
      errors: [],
    });
    expect(stored[0].mentions).toEqual(['nobody']);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatchObject({
      vpId: 'vp-linus',
      envelope: { trigger: 'fallback' },
    });
  });

  it('stamps the sender thread on synthetic route_forward messages', () => {
    const { coordinator, stored, delivered } = makeCoordinator();
    const router = createRouter({ coordinator });

    const result = router.forward({
      from: 'vp-linus',
      to: 'vp-martin',
      text: 'please review this PR',
      reason: 'review',
      inboundEnvelope: {
        sessionId: 'session-route-thread',
        vpId: 'vp-linus',
        threadId: 'thr-source',
        msg: { id: 'msg-user-1', from: 'user', meta: {} },
      },
      sourceThreadId: 'thr-source',
    });

    expect(result.ok).toBe(true);
    expect(result.dispatched).toEqual(['vp-martin']);
    expect(stored).toHaveLength(1);
    expect(stored[0].internal).toBe(true);
    expect(stored[0].meta).toMatchObject({
      injectedBy: 'route_forward',
      senderVpId: 'vp-linus',
      sourceThreadId: 'thr-source',
    });
    expect(delivered[0].envelope.msg.meta.sourceThreadId).toBe('thr-source');
  });

  it('uses sourceThreadId for visible route_forward rows', () => {
    const envelope = {
      msg: {
        meta: {
          injectedBy: 'route_forward',
          sourceThreadId: '  thr-source  ',
        },
      },
    };

    expect(visibleInboundThreadId(envelope, 'thr-target')).toBe('thr-source');
    expect(visibleInboundThreadId({ msg: { meta: {} } }, 'thr-target')).toBe('thr-target');
  });

  it('persists related route_forward rows under the source thread while queuing target work', async () => {
    const persisted = [];
    const sessionId = 'session-route-thread-related';
    const targetVpId = 'vp-martin';
    __testSetSession({
      config: {},
      conversationStore: {
        append(record) {
          persisted.push(record);
          return { id: `persisted-${persisted.length}`, ...record };
        },
      },
    });
    __testSeedVpThread({
      sessionId,
      vpId: targetVpId,
      threadId: 'thr-target',
      status: 'typing',
    });
    __testSetVpThreadEngine({
      sessionId,
      vpId: targetVpId,
      threadId: 'thr-target',
      engine: { wakeForPendingUserMessage: () => true },
    });
    __testSetThreadClassifier(async () => ({
      decision: 'related',
      targetThreadId: 'thr-target',
      title: 'target work',
    }));

    const envelope = {
      sessionId,
      vpId: targetVpId,
      threadId: 'thr-target',
      trigger: 'mention',
      msg: {
        id: 'msg-forward-related',
        from: 'vp-linus',
        role: 'assistant',
        text: '@vp-martin please review this PR',
        meta: {
          injectedBy: 'route_forward',
          senderVpId: 'vp-linus',
          sourceThreadId: 'thr-source',
        },
      },
    };

    __testEnqueueForVp(sessionId, targetVpId, envelope);
    await __testWaitForRoutePromises('msg-forward-related');

    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toMatchObject({
      role: 'assistant',
      speakerVpId: 'vp-linus',
      threadId: 'thr-source',
      sessionId,
    });
    const targetThread = __testGetVpThreads(sessionId, targetVpId)
      .find(thread => thread.threadId === 'thr-target');
    expect(targetThread?.pendingQueries).toHaveLength(1);
  });

  it('wakes a running thread when user input arrives during a background-task wait', async () => {
    const persisted = [];
    const sessionId = 'session-user-append-wake';
    const vpId = 'vp-linus';
    const wakeForPendingUserMessage = vi.fn(() => true);
    __testSetSession({
      config: {},
      conversationStore: {
        append(record) {
          persisted.push(record);
          return { id: `persisted-${persisted.length}`, ...record };
        },
      },
    });
    __testSeedVpThread({ sessionId, vpId, threadId: 'thr-running', status: 'tool' });
    __testSetVpThreadEngine({
      sessionId,
      vpId,
      threadId: 'thr-running',
      engine: { wakeForPendingUserMessage },
    });
    __testSetThreadClassifier(async () => ({
      decision: 'related',
      targetThreadId: 'thr-running',
      title: 'background work',
    }));

    __testEnqueueForVp(sessionId, vpId, {
      sessionId,
      trigger: 'fallback',
      msg: {
        id: 'msg-user-during-task',
        from: 'user',
        role: 'user',
        text: 'please answer this while the task keeps running',
        meta: {},
      },
    });
    await __testWaitForRoutePromises('msg-user-during-task');

    expect(wakeForPendingUserMessage).toHaveBeenCalledTimes(1);
    expect(__testGetVpThreads(sessionId, vpId)[0].pendingQueries).toHaveLength(1);
    expect(persisted[0]).toMatchObject({
      role: 'user',
      sessionId,
      threadId: 'thr-running',
    });
  });

  it('falls back to a normal queued turn when a stale thread has no running engine', async () => {
    const sessionId = 'session-stale-thread';
    const vpId = 'vp-linus';
    __testSetSession({
      config: { _readOnly: true },
      conversationStore: {
        append: record => record,
        loadRecentBySession: () => [],
        readCompactSummary: () => '',
      },
      toolRegistry: new ToolRegistry(),
      trace: new NullTrace(),
      adapter: {
        async *stream() { yield { type: 'stop', stopReason: 'end_turn' }; },
        async call() { return { text: '', usage: {} }; },
      },
    });
    __testSeedVpThread({ sessionId, vpId, threadId: 'thr-stale', status: 'tool' });
    __testSetThreadClassifier(async () => ({
      decision: 'related',
      targetThreadId: 'thr-stale',
      title: 'stale work',
    }));

    __testEnqueueForVp(sessionId, vpId, {
      sessionId,
      trigger: 'fallback',
      msg: { id: 'msg-stale-fallback', from: 'user', role: 'user', text: 'new input', meta: {} },
    });
    await __testWaitForRoutePromises('msg-stale-fallback');

    const stale = __testGetVpThreads(sessionId, vpId).find(thread => thread.threadId === 'thr-stale');
    expect(stale?.pendingQueries).toHaveLength(0);
  });

  it('passes the active engine thread id into the route_forward tool context', async () => {
    const { coordinator, stored } = makeCoordinator();
    const queryOpts = buildVpQueryOpts({
      vpId: 'vp-linus',
      sessionId: 'session-route-thread',
      sessionCoordinator: coordinator,
      envelope: {
        sessionId: 'session-route-thread',
        vpId: 'vp-linus',
        threadId: 'thr-source',
        msg: { id: 'msg-user-1', from: 'user', meta: {} },
      },
      threadId: 'thr-source',
    });

    const output = await routeForwardTool.execute(
      { to: 'vp-martin', text: 'please review this PR', reason: 'review' },
      queryOpts,
    );

    expect(JSON.parse(output)).toMatchObject({ ok: true, dispatched: ['vp-martin'] });
    expect(stored[0].meta.sourceThreadId).toBe('thr-source');
  });

  it('preserves route_forward internal provenance when rescuing pending queries', () => {
    const envelope = __testHooks.buildPendingRescueEnvelope({
      sessionId: 'session-route-thread',
      taskId: null,
      threadId: 'thr-target',
      followUpId: 'followup-route-forward',
      replayText: '@vp-martin please review this PR',
      replayParts: null,
      leftover: {
        internal: true,
        injectedBy: 'route_forward',
        senderVpId: 'vp-linus',
        sourceThreadId: 'thr-source',
      },
    });

    expect(envelope).toMatchObject({
      sessionId: 'session-route-thread',
      trigger: 'pending_rescue',
      msg: {
        id: 'followup-route-forward',
        from: 'vp-linus',
        role: 'assistant',
        text: '@vp-martin please review this PR',
        meta: {
          rescuedFrom: 'pendingQueries',
          threadId: 'thr-target',
          injectedBy: 'route_forward',
          senderVpId: 'vp-linus',
          sourceThreadId: 'thr-source',
        },
      },
    });
  });

  it('keeps explicit user @mentions visible when rescuing pending queries', () => {
    const envelope = __testHooks.buildPendingRescueEnvelope({
      sessionId: 'session-route-thread',
      taskId: null,
      threadId: 'thr-target',
      followUpId: 'followup-user-mention',
      replayText: '@vp-martin please review this PR',
      replayParts: null,
      leftover: {
        internal: false,
      },
    });

    expect(envelope).toMatchObject({
      sessionId: 'session-route-thread',
      trigger: 'pending_rescue',
      msg: {
        id: 'followup-user-mention',
        from: 'user',
        role: 'user',
        text: '@vp-martin please review this PR',
        meta: {
          rescuedFrom: 'pendingQueries',
          threadId: 'thr-target',
        },
      },
    });
    expect(envelope.msg.meta.injectedBy).toBeUndefined();
    expect(envelope.msg.meta.senderVpId).toBeUndefined();
    expect(envelope.msg.meta.sourceThreadId).toBeUndefined();
  });
});
