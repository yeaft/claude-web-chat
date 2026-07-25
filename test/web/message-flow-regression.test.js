// @vitest-environment happy-dom
import { mount } from '@vue/test-utils';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Vue from 'vue';
import ChatInput from '../../web/components/ChatInput.js';
import {
  addMessageToConversation,
  appendToAssistantMessageForConversation,
} from '../../web/stores/helpers/messages.js';
import {
  buildYeaftMessageTurnSpans,
  hasHiddenYeaftMessageTurns,
  sliceYeaftMessagesByRecentTurns,
} from '../../web/stores/helpers/yeaft-message-window.js';

let chatInputStore;

function makeStore() {
  return {
    yeaftConversationId: 'conv-1',
    _currentYeaftSessionId: 'session-1',
    _currentYeaftVpId: 'vp-1',
    _currentYeaftTurnId: 'turn-1',
    messagesMap: { 'conv-1': [] },
    yeaftSessionHistoryState: {},
  };
}

function makeChatInputStore() {
  return Vue.reactive({
    activeConversationId: 'conversation-a',
    btwMode: false,
    cancelExecution: vi.fn(),
    compactStatus: null,
    currentAgent: 'agent-a',
    currentConversation: 'conversation-a',
    currentView: 'yeaft',
    customExpertRoles: [],
    expertSelections: [],
    inputDrafts: {},
    isProcessing: true,
    sendMessage: vi.fn(),
    slashCommandDescriptions: {},
    yeaftActiveSessionFilter: 'session-1',
  });
}

function mountChatInput(props = {}) {
  return mount(ChatInput, {
    props,
    global: { mocks: { $t: key => key } },
    attachTo: document.body,
  });
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function writeControlledCopilotCli(root) {
  const controlDir = join(root, 'acp-control');
  mkdirSync(controlDir, { recursive: true });
  const scriptPath = join(root, 'copilot-test-cli.cjs');
  writeFileSync(scriptPath, `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const root = process.env.YEAFT_ACP_CONTROL_DIR;
function waitFor(name, done) {
  const file = path.join(root, name);
  const timer = setInterval(() => {
    if (!fs.existsSync(file)) return;
    clearInterval(timer);
    done(fs.readFileSync(file, 'utf8').trim());
  }, 5);
}
function send(payload) { process.stdout.write(JSON.stringify(payload) + '\\n'); }
readline.createInterface({ input: process.stdin }).on('line', line => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') {
    send({ jsonrpc: '2.0', id: msg.id, result: { agentCapabilities: {} } });
    return;
  }
  if (msg.method === 'session/new') {
    fs.writeFileSync(path.join(root, 'session-new.pending'), String(msg.id));
    waitFor('session-new', action => {
      if (action === 'reject') {
        send({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: 'controlled boot failure' } });
      } else {
        send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: action || 'controlled-session' } });
      }
    });
  }
});
`);
  chmodSync(scriptPath, 0o755);
  return { controlDir, scriptPath };
}

async function waitForPath(path, timeoutMs = 2000) {
  const started = Date.now();
  while (!existsSync(path)) {
    if (Date.now() - started > timeoutMs) throw new Error(`Timed out waiting for ${path}`);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

beforeAll(() => {
  globalThis.Vue = Vue;
  globalThis.Pinia = {
    defineStore: () => () => ({}),
    useAuthStore: () => ({ getActiveToken: () => null }),
    useChatStore: () => chatInputStore,
    useSessionsStore: () => ({
      activeSessionId: 'session-1',
      sessions: { 'session-1': { id: 'session-1', roster: ['omni'] } },
      sessionById: sessionId => (sessionId === 'session-1' ? { id: 'session-1', roster: ['omni'] } : null),
    }),
    useVpStore: () => ({
      vpList: [{ vpId: 'omni' }],
      vpDescription: () => '',
      vpTextColor: () => 'var(--text-primary)',
    }),
  };
  globalThis.window.Pinia = globalThis.Pinia;
});

beforeEach(() => {
  chatInputStore = makeChatInputStore();
});

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('message flow regressions', () => {
  it('keeps same-id streaming deltas and full snapshots on one assistant message', () => {
    const deltaStore = makeStore();

    appendToAssistantMessageForConversation(deltaStore, 'conv-1', 'hello ', {
      id: 'msg-1',
      sessionId: 'session-1',
      vpId: 'vp-1',
      turnId: 'turn-1',
    });
    appendToAssistantMessageForConversation(deltaStore, 'conv-1', 'world', {
      id: 'msg-1',
      sessionId: 'session-1',
      vpId: 'vp-1',
      turnId: 'turn-1',
    });

    expect(deltaStore.messagesMap['conv-1']).toHaveLength(1);
    expect(deltaStore.messagesMap['conv-1'][0]).toMatchObject({
      type: 'assistant',
      content: 'hello world',
      isStreaming: true,
      speakerVpId: 'vp-1',
      turnId: 'turn-1',
    });

    const snapshotStore = makeStore();
    appendToAssistantMessageForConversation(snapshotStore, 'conv-1', 'hello', { id: 'msg-1', turnId: 'turn-1' });
    appendToAssistantMessageForConversation(snapshotStore, 'conv-1', 'hello world', { id: 'msg-1', turnId: 'turn-1' });

    expect(snapshotStore.messagesMap['conv-1']).toHaveLength(1);
    expect(snapshotStore.messagesMap['conv-1'][0].content).toBe('hello world');
  });

  it('keeps stop and follow-up send controls available while a turn is running', async () => {
    const sendYeaft = vi.fn();
    const cancelYeaft = vi.fn();
    const yeaftInput = mountChatInput({ sendFn: sendYeaft, cancelFn: cancelYeaft, showStop: true });

    await yeaftInput.get('textarea').setValue('queued Yeaft follow-up');

    expect(yeaftInput.get('.stop-btn').attributes('aria-label')).toBe('chatInput.stop');
    expect(yeaftInput.get('.send-btn:not(.stop-btn)').attributes('disabled')).toBeUndefined();

    await yeaftInput.get('.send-btn:not(.stop-btn)').trigger('click');
    expect(sendYeaft).toHaveBeenCalledWith('queued Yeaft follow-up', undefined);
    await yeaftInput.get('.stop-btn').trigger('click');
    expect(cancelYeaft).toHaveBeenCalledOnce();
    yeaftInput.unmount();

    chatInputStore.currentView = 'chat';
    const chatInput = mountChatInput();
    await chatInput.get('textarea').setValue('queued Chat follow-up');
    await chatInput.get('.send-btn:not(.stop-btn)').trigger('click');

    expect(chatInputStore.sendMessage).toHaveBeenCalledWith('queued Chat follow-up', [], { expertSelections: [] });
    chatInput.unmount();

    await verifyCopilotFollowUpQueue();
  });

  async function verifyCopilotFollowUpQueue() {
    const workDir = mkdtempSync(join(tmpdir(), 'yeaft-copilot-follow-up-'));
    const { controlDir, scriptPath } = writeControlledCopilotCli(workDir);
    const previousCopilotBin = process.env.COPILOT_BIN;
    const previousControlDir = process.env.YEAFT_ACP_CONTROL_DIR;
    process.env.COPILOT_BIN = scriptPath;
    process.env.YEAFT_ACP_CONTROL_DIR = controlDir;
    const [
      { handleMessage },
      ctxModule,
      { keepQueuedFollowUpProcessing },
      { handleAssistantOutputFrame },
      copilotProvider,
    ] = await Promise.all([
      import('../../agent/connection/message-router.js'),
      import('../../agent/context.js'),
      import('../../web/stores/helpers/handlers/conversationHandler.js'),
      import('../../web/stores/helpers/assistantOutput.js'),
      import('../../agent/providers/copilot.js'),
    ]);
    const ctx = ctxModule.default;
    const previousConfig = ctx.CONFIG;
    const previousSendToServer = ctx.sendToServer;
    const previousConversations = ctx.conversations;
    const firstPrompt = deferred();
    const secondPrompt = deferred();
    const attachmentPrompt = deferred();
    const promptCalls = [];
    const cancelNotifications = [];
    const copilotChild = { kill: vi.fn() };
    const sent = [];
    const state = {
      providerName: 'copilot',
      conversationId: 'conversation-copilot',
      workDir,
      sessionId: 'copilot-session',
      claudeSessionId: 'copilot-session',
      initialized: true,
      turnActive: false,
      abortController: null,
      copilotChild,
      pendingPermissions: new Map(),
      acpClient: {
        request(method, params) {
          expect(method).toBe('session/prompt');
          promptCalls.push(params.prompt);
          return [firstPrompt.promise, secondPrompt.promise, attachmentPrompt.promise][promptCalls.length - 1];
        },
        notify(method, params) {
          cancelNotifications.push({ method, params });
        },
      },
      usage: { inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheCreation: 0, totalCostUsd: 0 },
    };

    ctx.CONFIG = { workDir };
    ctx.sendToServer = message => {
      sent.push(message);
      return true;
    };
    ctx.conversations = new Map([[state.conversationId, state]]);

    try {
      const firstRun = handleMessage({
        type: 'execute',
        conversationId: state.conversationId,
        provider: 'copilot',
        prompt: 'same',
        clientMessageId: 'cm_first',
      });
      const secondRun = handleMessage({
        type: 'execute',
        conversationId: state.conversationId,
        provider: 'copilot',
        prompt: 'same',
        clientMessageId: 'cm_second',
      });
      const attachmentRun = handleMessage({
        type: 'transfer_files',
        conversationId: state.conversationId,
        provider: 'copilot',
        prompt: 'third',
        workDir,
        files: [{ name: 'pixel.png', mimeType: 'image/png', data: 'aW1hZ2U=' }],
      });

      await vi.waitFor(() => expect(promptCalls).toHaveLength(1));
      expect(promptCalls[0]).toEqual([{ type: 'text', text: 'same' }]);
      expect(sent.filter(message => message.data?.type === 'user').map(message => message.data.clientMessageId))
        .toEqual(['cm_first', 'cm_second', undefined]);
      const activeAbortController = state.abortController;
      expect(activeAbortController).toBeInstanceOf(AbortController);
      expect(state.turnActive).toBe(true);

      await handleMessage({
        type: 'cancel_execution',
        conversationId: state.conversationId,
      });
      expect(activeAbortController.signal.aborted).toBe(true);
      const fallbackTimer = state._abortKillTimer;
      expect(fallbackTimer).toBeTruthy();
      const fallbackCallback = fallbackTimer._onTimeout;
      clearTimeout(fallbackTimer);
      expect(cancelNotifications).toEqual([
        { method: 'session/cancel', params: { sessionId: 'copilot-session' } },
      ]);
      expect(promptCalls).toHaveLength(1);
      expect(sent.find(message => message.type === 'execution_cancelled')?.hasQueuedFollowUp).toBe(true);
      state.turnActive = false;
      fallbackCallback();
      expect(copilotChild.kill).toHaveBeenCalledWith('SIGTERM');

      firstPrompt.reject(new Error('cancelled'));
      await vi.waitFor(() => expect(promptCalls).toHaveLength(2));
      const firstCompletion = sent.find(message => message.type === 'turn_completed');
      expect(firstCompletion?.hasQueuedFollowUp).toBe(true);
      const firstResult = sent.find(message => message.type === 'claude_output' && message.data?.type === 'result');
      expect(firstResult?.data.hasQueuedFollowUp).toBe(true);
      const webStore = {
        processingConversations: { [state.conversationId]: true },
        executionStatusMap: {},
        messagesMap: { [state.conversationId]: [] },
        conversations: [{ id: state.conversationId }],
        _processingWatchdogs: {},
        _closedAt: {},
        _turnCompletedConvs: new Set(),
        finishStreamingForConversation: vi.fn(),
        sweepStaleStreamingForConversation: vi.fn(),
        appendToAssistantMessageForConversation: vi.fn(),
        saveOpenSessions: vi.fn(),
        sendWsMessage: vi.fn(),
      };
      handleAssistantOutputFrame(webStore, state.conversationId, firstResult.data);
      expect(webStore.processingConversations[state.conversationId]).toBe(true);
      keepQueuedFollowUpProcessing(webStore, state.conversationId, firstCompletion.hasQueuedFollowUp);
      expect(webStore.processingConversations[state.conversationId]).toBe(true);
      expect(webStore._turnCompletedConvs.has(state.conversationId)).toBe(false);
      expect(promptCalls[1]).toEqual([{ type: 'text', text: 'same' }]);
      expect(state.abortController).not.toBe(activeAbortController);
      expect(state.turnActive).toBe(true);

      secondPrompt.resolve({ stopReason: 'end_turn' });
      await vi.waitFor(() => expect(promptCalls).toHaveLength(3));
      expect(promptCalls[2]).toEqual([
        { type: 'text', text: 'third' },
        { type: 'image', data: 'aW1hZ2U=', mimeType: 'image/png' },
      ]);
      expect(state.turnActive).toBe(true);

      attachmentPrompt.resolve({ stopReason: 'end_turn' });
      await Promise.all([firstRun, secondRun, attachmentRun]);

      const outputFrames = sent.filter(message => message.type === 'claude_output');
      const resultFrames = outputFrames.filter(message => message.data?.type === 'result');
      expect(resultFrames).toHaveLength(3);
      expect(resultFrames.map(message => message.data.hasQueuedFollowUp)).toEqual([true, true, false]);
      const completions = sent.filter(message => message.type === 'turn_completed');
      expect(completions).toHaveLength(3);
      expect(completions.map(message => message.hasQueuedFollowUp)).toEqual([true, true, false]);

      for (const outcome of ['resolve', 'reject']) {
        const conversationId = `stale-clear-${outcome}`;
        const clearRequest = deferred();
        const oldClearState = {
          providerName: 'copilot',
          providerGeneration: `old-${outcome}`,
          conversationId,
          workDir,
          sessionId: 'old-clear-session',
          claudeSessionId: 'old-clear-session',
          initialized: true,
          turnActive: false,
          abortController: null,
          copilotChild: { kill: vi.fn() },
          pendingPermissions: new Map(),
          tools: [],
          acpClient: {
            request: vi.fn((method) => {
              expect(method).toBe('session/new');
              return clearRequest.promise;
            }),
            notify: vi.fn(),
          },
          usage: { inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheCreation: 0, totalCostUsd: 0 },
        };
        ctx.conversations.set(conversationId, oldClearState);
        const clearRun = handleMessage({
          type: 'execute',
          conversationId,
          provider: 'copilot',
          prompt: '/clear',
        });
        await vi.waitFor(() => expect(oldClearState.acpClient.request).toHaveBeenCalledOnce());
        await handleMessage({ type: 'delete_conversation', conversationId });
        const replacement = {
          providerName: 'copilot',
          providerGeneration: `replacement-${outcome}`,
          conversationId,
          sessionId: 'replacement-session',
          turnActive: true,
        };
        ctx.conversations.set(conversationId, replacement);
        const outputStart = sent.length;
        if (outcome === 'resolve') clearRequest.resolve({ sessionId: 'stale-clear-session' });
        else clearRequest.reject(new Error('same-id replacement'));
        await clearRun;

        expect(sent.slice(outputStart).filter(message => message.conversationId === conversationId
          && (message.type === 'turn_completed'
            || message.type === 'session_id_update'
            || message.data?.type === 'result'
            || message.data?.type === 'system'))).toEqual([]);
        expect(replacement).toMatchObject({
          sessionId: 'replacement-session',
          turnActive: true,
        });
        expect(oldClearState.chatProviderRetired).toBe(true);
        ctx.conversations.delete(conversationId);
      }

      for (const outcome of ['resolve', 'reject']) {
        rmSync(join(controlDir, 'session-new'), { force: true });
        rmSync(join(controlDir, 'session-new.pending'), { force: true });
        const conversationId = `stale-boot-${outcome}`;
        const oldBootState = await copilotProvider.start({
          conversationId,
          workDir,
          resumeSessionId: 'old-resume-session',
          deferBoot: true,
        });
        const bootPromise = oldBootState._bootPromise;
        await waitForPath(join(controlDir, 'session-new.pending'));

        await handleMessage({ type: 'delete_conversation', conversationId });
        const replacement = {
          providerName: 'copilot',
          providerGeneration: `replacement-boot-${outcome}`,
          conversationId,
          sessionId: 'replacement-session',
          turnActive: true,
        };
        ctx.conversations.set(conversationId, replacement);
        const outputStart = sent.length;
        writeFileSync(join(controlDir, 'session-new'), outcome === 'resolve' ? 'stale-boot-session' : 'reject');
        await bootPromise.catch(() => {});
        await new Promise(resolve => setTimeout(resolve, 10));

        expect(sent.slice(outputStart).filter(message => message.conversationId === conversationId
          && (message.type === 'turn_completed'
            || message.type === 'session_id_update'
            || message.data?.type === 'result'
            || message.data?.type === 'system'))).toEqual([]);
        expect(oldBootState.sessionId).toBe('old-resume-session');
        expect(oldBootState.chatProviderRetired).toBe(true);
        expect(replacement).toMatchObject({
          sessionId: 'replacement-session',
          turnActive: true,
        });
        copilotProvider.dispose(oldBootState, 'test cleanup');
        ctx.conversations.delete(conversationId);
      }

      const terminalCount = resultFrames.length + completions.length;
      const stalePrompt = deferred();
      state.acpClient.request = () => stalePrompt.promise;
      const staleRun = handleMessage({
        type: 'execute',
        conversationId: state.conversationId,
        provider: 'copilot',
        prompt: 'stale',
      });
      await vi.waitFor(() => expect(state.turnActive).toBe(true));
      await handleMessage({
        type: 'resume_conversation',
        conversationId: state.conversationId,
        provider: 'copilot',
        claudeSessionId: 'replacement-session',
        workDir,
      });
      const replacementState = ctx.conversations.get(state.conversationId);
      expect(replacementState).not.toBe(state);
      replacementState.turnActive = true;
      stalePrompt.resolve({ stopReason: 'end_turn' });
      await staleRun;
      expect(sent.filter(message => message.data?.type === 'result'
        || message.type === 'turn_completed')).toHaveLength(terminalCount);

      delete webStore.processingConversations[state.conversationId];
      webStore._turnCompletedConvs.add(state.conversationId);
      keepQueuedFollowUpProcessing(webStore, state.conversationId, completions[2].hasQueuedFollowUp);
      expect(webStore.processingConversations[state.conversationId]).toBeUndefined();
      expect(webStore._turnCompletedConvs.has(state.conversationId)).toBe(true);
      expect(state.chatProviderRetired).toBe(true);
      expect(replacementState.turnActive).toBe(true);
      for (const timer of Object.values(webStore._processingWatchdogs)) clearTimeout(timer);
    } finally {
      ctx.CONFIG = previousConfig;
      ctx.sendToServer = previousSendToServer;
      ctx.conversations = previousConversations;
      if (previousCopilotBin === undefined) delete process.env.COPILOT_BIN;
      else process.env.COPILOT_BIN = previousCopilotBin;
      if (previousControlDir === undefined) delete process.env.YEAFT_ACP_CONTROL_DIR;
      else process.env.YEAFT_ACP_CONTROL_DIR = previousControlDir;
      rmSync(workDir, { recursive: true, force: true });
    }
  }

  it('stamps background agent messages without promoting that conversation', () => {
    const store = makeStore();
    store.yeaftConversationIdsByAgent = {
      'agent-1': 'conv-1',
      'agent-2': 'conv-2',
    };
    store.messagesMap['conv-2'] = [];
    store._currentYeaftSessionId = 'session-2';
    store._currentYeaftVpId = 'vp-2';
    store._currentYeaftTurnId = 'turn-2';

    addMessageToConversation(store, 'conv-2', {
      id: 'msg-2',
      type: 'assistant',
      content: 'background',
    });

    expect(store.yeaftConversationId).toBe('conv-1');
    expect(store.messagesMap['conv-2'][0]).toMatchObject({
      sessionId: 'session-2',
      vpId: 'vp-2',
      turnId: 'turn-2',
      speakerVpId: 'vp-2',
    });
  });

  it('counts hyphenated tool-use/tool-result events as part of Yeaft assistant turns', () => {
    const messages = [
      { type: 'user', content: 'u1' },
      { type: 'tool-use', toolName: 'Bash', turnId: 'a', speakerVpId: 'vp-1' },
      { type: 'tool-result', toolUseId: 't1', turnId: 'a', speakerVpId: 'vp-1' },
      { type: 'assistant', content: 'a1', turnId: 'a', speakerVpId: 'vp-1' },
      { type: 'user', content: 'u2' },
      { type: 'assistant', content: 'a2', turnId: 'b', speakerVpId: 'vp-1' },
    ];

    expect(buildYeaftMessageTurnSpans(messages).map(s => s.kind)).toEqual([
      'user',
      'user',
    ]);
    expect(hasHiddenYeaftMessageTurns(messages, 1)).toBe(true);
    expect(sliceYeaftMessagesByRecentTurns(messages, 1)).toEqual(messages.slice(4));
  });
});
