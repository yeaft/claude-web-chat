import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  __testDrainVpDrivers,
  __testEnqueueForVp,
  __testResetVpState,
  __testSetSession,
  __testWaitForRoutePromises,
  installYeaftRuntimeBridge,
} from '../../../agent/yeaft/web-bridge.js';
import { NullTrace } from '../../../agent/yeaft/debug-trace.js';
import { ToolRegistry } from '../../../agent/yeaft/tools/registry.js';
import { TaskManager } from '../../../agent/yeaft/tasks/manager.js';
import { TASK_RESULT_DELIVERY } from '../../../agent/yeaft/tasks/store.js';
import bashTool from '../../../agent/yeaft/tools/bash.js';

class RecordingAdapter {
  constructor(responses = []) {
    this.responses = responses;
    this.streamCalls = [];
  }

  async *stream(params) {
    this.streamCalls.push({
      system: params.system,
      messages: JSON.parse(JSON.stringify(params.messages || [])),
    });
    const response = this.responses.shift();
    if (!response) throw new Error('RecordingAdapter: no response queued');
    for (const event of response) yield event;
  }

  async call() {
    return { text: 'ok', usage: {} };
  }
}

function makeTaskManagerStub({ yeaftDir }) {
  let sink = null;
  const started = [];
  const persisted = new TaskManager({ yeaftDir });
  return {
    started,
    setEventSink(fn) {
      sink = fn;
      persisted.setEventSink(fn);
    },
    startShellTask(input) {
      const task = {
        id: 'task_service_1',
        sessionId: input.sessionId,
        ownerVpId: input.ownerVpId,
        kind: 'shell',
        title: input.title,
        status: 'running',
        resultDelivery: 'status_only',
        source: input.source || {},
        runtime: { command: input.command, cwd: input.cwd },
        result: {},
        log: { path: '/tmp/task_service_1.log', preview: '' },
      };
      started.push(task);
      sink?.({ type: 'yeaft_task_event', event: 'started', task });
      return task;
    },
    emit(event) {
      if (!sink) throw new Error('task event sink not installed');
      sink(event);
    },
    startTask(input) { return persisted.startTask(input); },
    startLegacyTask(input) {
      const task = persisted.startTask({
        ...input,
        resultDelivery: TASK_RESULT_DELIVERY.MODEL_REENTRY,
      });
      const stored = persisted.store.readTask(task.sessionId, task.id);
      delete stored.resultDelivery;
      persisted.store.writeTask(stored);
      persisted.active.delete(`${task.sessionId}::${task.id}`);
      return task;
    },
    completeTask(sessionId, taskId, opts) { return persisted.completeTask(sessionId, taskId, opts); },
    getTask(sessionId, taskId) { return persisted.getTask(sessionId, taskId); },
    listActiveTasks() { return persisted.listActiveTasks(); },
    renderActiveTasksForPrompt() { return ''; },
  };
}

async function drainVpDriversWithin(timeoutMs = 2000) {
  let timer = null;
  try {
    await Promise.race([
      __testDrainVpDrivers(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('VP turn did not finish')), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

describe('task result re-entry', () => {
  let tempDir = null;

  afterEach(async () => {
    vi.restoreAllMocks();
    __testSetSession(null);
    await __testResetVpState();
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  });

  it('detaches persistent shell tasks while preserving explicit model result delivery', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'yeaft-task-reentry-'));
    const adapter = new RecordingAdapter([
      [
        {
          type: 'tool_call',
          id: 'call_service_1',
          name: 'Bash',
          input: {
            command: 'node server.js',
            cwd: tempDir,
            background: true,
            taskTitle: 'Dev server',
          },
        },
        { type: 'stop', stopReason: 'tool_use' },
      ],
      [
        { type: 'text_delta', text: 'The service is ready.' },
        { type: 'stop', stopReason: 'end_turn' },
      ],
      [
        { type: 'text_delta', text: 'This is a separate user turn.' },
        { type: 'stop', stopReason: 'end_turn' },
      ],
      [
        { type: 'text_delta', text: 'The delegated result was received.' },
        { type: 'stop', stopReason: 'end_turn' },
      ],
      [
        { type: 'text_delta', text: 'The legacy delegated result was received.' },
        { type: 'stop', stopReason: 'end_turn' },
      ],
    ]);
    const taskManager = makeTaskManagerStub({ yeaftDir: tempDir });
    const persisted = [];
    const toolRegistry = new ToolRegistry();
    toolRegistry.register(bashTool);
    const sessionLike = {
      adapter,
      trace: new NullTrace(),
      config: {
        model: 'test-model',
        maxOutputTokens: 1024,
        _readOnly: true,
        language: 'en',
      },
      conversationStore: {
        append(record) {
          persisted.push(record);
          return { id: `persisted-${persisted.length}`, ...record };
        },
        loadRecentBySession() { return []; },
        readCompactSummary() { return ''; },
      },
      memoryIndex: null,
      amsRegistry: null,
      toolRegistry,
      skillManager: null,
      mcpManager: null,
      yeaftDir: tempDir,
      taskManager,
      toolStats: null,
    };

    __testSetSession(sessionLike);
    installYeaftRuntimeBridge(sessionLike);

    const sessionId = 'session-task-result';
    const vpId = 'vp-owner';
    const firstMessageId = 'msg-start-service';
    __testEnqueueForVp(sessionId, vpId, {
      sessionId,
      trigger: 'fallback',
      msg: {
        id: firstMessageId,
        from: 'user',
        role: 'user',
        text: 'Start the service and tell me when it is ready.',
        meta: {},
      },
    });
    await __testWaitForRoutePromises(firstMessageId);
    await drainVpDriversWithin();

    expect(taskManager.started).toHaveLength(1);
    expect(taskManager.started[0]).toMatchObject({
      id: 'task_service_1',
      resultDelivery: 'status_only',
      status: 'running',
    });
    expect(adapter.streamCalls).toHaveLength(2);

    // Stopping a detached service updates task state only. It must not wake the
    // completed engine turn or create a synthetic model turn of its own.
    const legacyShellCompletion = {
      ...taskManager.started[0],
      status: 'cancelled',
      result: { signal: 'SIGTERM' },
    };
    delete legacyShellCompletion.resultDelivery;
    taskManager.emit({
      type: 'yeaft_task_event',
      event: 'completed',
      task: legacyShellCompletion,
    });

    await new Promise(resolve => setTimeout(resolve, 0));
    await drainVpDriversWithin();
    expect(adapter.streamCalls).toHaveLength(2);
    expect(persisted.filter(row => row.internal === true)).toHaveLength(0);

    // The next user input owns a clean new turn. It is not fused with the task
    // cancellation event and receives no hidden <task-result> prompt.
    const secondMessageId = 'msg-after-service-stop';
    __testEnqueueForVp(sessionId, vpId, {
      sessionId,
      trigger: 'fallback',
      msg: {
        id: secondMessageId,
        from: 'user',
        role: 'user',
        text: 'Now explain the next step.',
        meta: {},
      },
    });
    await __testWaitForRoutePromises(secondMessageId);
    await drainVpDriversWithin();

    expect(adapter.streamCalls).toHaveLength(3);
    const userTurnWire = JSON.stringify(adapter.streamCalls[2].messages);
    expect(userTurnWire).toContain('Now explain the next step.');
    expect(userTurnWire).not.toContain('<task-result');

    // Result-producing async work remains opt-in. Sub-agent completion keeps
    // the existing re-entry path instead of being treated like a service task.
    taskManager.emit({
      type: 'yeaft_task_event',
      event: 'completed',
      task: {
        id: 'task_delegate_1',
        sessionId,
        ownerVpId: vpId,
        kind: 'sub_agent',
        title: 'Review implementation',
        status: 'succeeded',
        resultDelivery: 'model_reentry',
        source: { threadId: 'main' },
        runtime: { subAgentId: 'agent-reviewer' },
        result: { summary: 'Review passed' },
        log: { path: '/tmp/task_delegate_1.log', preview: 'APPROVE' },
      },
    });

    await new Promise(resolve => setTimeout(resolve, 0));
    await drainVpDriversWithin();

    expect(adapter.streamCalls).toHaveLength(4);
    const rendered = JSON.stringify(adapter.streamCalls[3].messages);
    expect(rendered).toContain('<task-result id=\\"task_delegate_1\\" kind=\\"sub_agent\\" status=\\"succeeded\\">');
    expect(rendered).toContain('Review passed');
    expect(rendered).toContain('This is an asynchronous tool result from a background task, not a user message');

    const internalRows = persisted.filter(row => row.internal === true);
    expect(internalRows).toHaveLength(1);
    expect(internalRows[0]).toMatchObject({
      role: 'assistant',
      threadId: 'main',
      sessionId,
    });
    expect(internalRows[0].content).toContain('task_delegate_1');

    // A persisted legacy sub-agent without the field keeps the compatibility
    // fallback and still opens exactly one rescue turn.
    const legacyTask = taskManager.startLegacyTask({
      sessionId,
      ownerVpId: vpId,
      kind: 'sub_agent',
      title: 'Legacy delegate',
      source: { threadId: 'main' },
    });
    taskManager.completeTask(sessionId, legacyTask.id, {
      status: 'succeeded',
      summary: 'Legacy review passed',
    });
    await new Promise(resolve => setTimeout(resolve, 0));
    await drainVpDriversWithin();
    expect(taskManager.getTask(sessionId, legacyTask.id)).toMatchObject({
      status: 'succeeded',
      resultDelivery: TASK_RESULT_DELIVERY.MODEL_REENTRY,
    });
    expect(adapter.streamCalls).toHaveLength(5);
    expect(JSON.stringify(adapter.streamCalls[4].messages)).toContain('Legacy review passed');

    // Unknown kinds and explicit unknown delivery modes are status-only.
    // Drive them through the real TaskManager persistence/completion path and
    // prove neither gains the side effect of starting an adapter turn.
    const invalidTask = taskManager.startTask({
      sessionId,
      ownerVpId: vpId,
      kind: 'sub_agent',
      title: 'Invalid delivery',
      resultDelivery: 'future_delivery_mode',
      source: { threadId: 'main' },
    });
    expect(invalidTask.resultDelivery).toBe(TASK_RESULT_DELIVERY.STATUS_ONLY);
    taskManager.completeTask(sessionId, invalidTask.id, {
      status: 'succeeded',
      summary: 'Must not re-enter',
    });

    const unknownKindTask = taskManager.startTask({
      sessionId,
      ownerVpId: vpId,
      kind: 'future_task_kind',
      title: 'Unknown task kind',
      source: { threadId: 'main' },
    });
    expect(unknownKindTask.resultDelivery).toBe(TASK_RESULT_DELIVERY.STATUS_ONLY);
    taskManager.completeTask(sessionId, unknownKindTask.id, {
      status: 'succeeded',
      summary: 'Must not re-enter',
    });

    await new Promise(resolve => setTimeout(resolve, 0));
    await drainVpDriversWithin();
    expect(taskManager.getTask(sessionId, invalidTask.id)).toMatchObject({
      status: 'succeeded',
      resultDelivery: TASK_RESULT_DELIVERY.STATUS_ONLY,
    });
    expect(taskManager.getTask(sessionId, unknownKindTask.id)).toMatchObject({
      status: 'succeeded',
      resultDelivery: TASK_RESULT_DELIVERY.STATUS_ONLY,
    });
    expect(adapter.streamCalls).toHaveLength(5);
    expect(persisted.filter(row => row.internal === true)).toHaveLength(2);
  });
});
