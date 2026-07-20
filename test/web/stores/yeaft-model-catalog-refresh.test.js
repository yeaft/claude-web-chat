import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

globalThis.Pinia = globalThis.Pinia || {};
globalThis.Pinia.defineStore = globalThis.Pinia.defineStore || ((_id, options) => () => options);
globalThis.window = globalThis.window || globalThis;
globalThis.window.Pinia = globalThis.Pinia;
globalThis.localStorage = globalThis.localStorage || {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
};

const { useChatStore } = await import('../../../web/stores/chat.js');
const { handleAgentSelected } = await import('../../../web/stores/helpers/handlers/agentHandler.js');

const AGENT_ID = 'user-1:agent-1';
const ACTIVE_SESSION_ID = 'session-active';

function makeStore() {
  const schema = useChatStore();
  const store = { ...schema.state() };
  for (const [name, action] of Object.entries(schema.actions)) {
    store[name] = action.bind(store);
  }
  store.currentView = 'yeaft';
  store.currentAgent = AGENT_ID;
  store.yeaftActiveSessionFilter = ACTIVE_SESSION_ID;
  store.yeaftConversationId = 'yeaft-current';
  store.yeaftConversationIdsByAgent = { [AGENT_ID]: 'yeaft-current' };
  store.messagesMap = { 'yeaft-current': [] };
  store.activeConversations = ['yeaft-current'];
  store.sendWsMessage = () => {};
  return store;
}

function status(models, refreshedAt, revision = refreshedAt, digest = `digest-${revision}`, epoch = 'epoch-a') {
  return {
    type: 'yeaft_status',
    model: models[0]?.ref || null,
    availableModels: models,
    refreshedAt,
    catalogRefreshedAt: refreshedAt,
    catalogEpoch: epoch,
    catalogRevision: revision,
    catalogDigest: digest,
    refreshReason: 'llm_config_updated',
  };
}

function ready(models, sessionId = ACTIVE_SESSION_ID, refreshedAt = null) {
  return {
    agentId: AGENT_ID,
    sessionId,
    event: {
      type: 'session_ready',
      conversationId: 'yeaft-current',
      model: models[0]?.ref || null,
      availableModels: models,
      ...(refreshedAt ? { refreshedAt } : {}),
      skills: [],
      mcpServers: [],
      tools: [],
    },
  };
}

describe('Yeaft Session model catalog refresh', () => {
  it('does not let a stale session_ready replace a newer Agent config catalog', () => {
    const store = makeStore();
    const freshModels = [{ id: 'gpt-new', ref: 'github-copilot/gpt-new', provider: 'github-copilot' }];
    const staleModels = [{ id: 'gpt-default', ref: 'github-copilot/gpt-default', provider: 'github-copilot' }];

    store.cacheYeaftAgentStatus(AGENT_ID, status(freshModels, 200));
    store.handleYeaftOutput(ready(staleModels));

    expect(store.yeaftAvailableModels).toEqual(freshModels);
    expect(store.yeaftStatusByAgent[AGENT_ID].availableModels).toEqual(freshModels);
  });

  it('accepts a newer Agent config catalog after an older one', () => {
    const store = makeStore();
    const oldModels = [{ id: 'gpt-old', ref: 'github-copilot/gpt-old', provider: 'github-copilot' }];
    const newModels = [{ id: 'gpt-new', ref: 'github-copilot/gpt-new', provider: 'github-copilot' }];

    store.cacheYeaftAgentStatus(AGENT_ID, status(oldModels, 100));
    store.cacheYeaftAgentStatus(AGENT_ID, status(newModels, 200));

    expect(store.yeaftAvailableModels).toEqual(newModels);
    expect(store.yeaftStatusByAgent[AGENT_ID].availableModels).toEqual(newModels);
  });

  it('does not let a background Session change the visible Agent model catalog', () => {
    const store = makeStore();
    const activeModels = [{ id: 'gpt-active', ref: 'github-copilot/gpt-active', provider: 'github-copilot' }];
    const backgroundModels = [{ id: 'gpt-background', ref: 'github-copilot/gpt-background', provider: 'github-copilot' }];

    store.cacheYeaftAgentStatus(AGENT_ID, status(activeModels, 300));
    store.handleYeaftOutput(ready(backgroundModels, 'session-background'));

    expect(store.yeaftModel).toBe('github-copilot/gpt-active');
    expect(store.yeaftAvailableModels).toEqual(activeModels);
    expect(store.yeaftStatusByAgent[AGENT_ID].model).toBe('github-copilot/gpt-active');
    expect(store.yeaftStatusByAgent[AGENT_ID].availableModels).toEqual(activeModels);
  });

  it('ignores an older delayed Agent catalog', () => {
    const store = makeStore();
    const oldModels = [{ id: 'gpt-old', ref: 'github-copilot/gpt-old', provider: 'github-copilot' }];
    const newModels = [{ id: 'gpt-new', ref: 'github-copilot/gpt-new', provider: 'github-copilot' }];

    store.cacheYeaftAgentStatus(AGENT_ID, status(newModels, 200));
    store.cacheYeaftAgentStatus(AGENT_ID, status(oldModels, 100));

    expect(store.yeaftModel).toBe('github-copilot/gpt-new');
    expect(store.yeaftAvailableModels).toEqual(newModels);
    expect(store.yeaftStatusByAgent[AGENT_ID].model).toBe('github-copilot/gpt-new');
    expect(store.yeaftStatusByAgent[AGENT_ID].availableModels).toEqual(newModels);
  });

  it('does not let a cold background session_ready bootstrap Agent catalog ownership', () => {
    const store = makeStore();
    const backgroundModels = [{ id: 'gpt-background', ref: 'github-copilot/gpt-background', provider: 'github-copilot' }];

    store.handleYeaftOutput(ready(backgroundModels, 'session-background'));

    expect(store.yeaftAvailableModels).toEqual([]);
    expect(store.yeaftStatusByAgent[AGENT_ID]?.availableModels).toBeUndefined();
  });

  it('does not let an unversioned yeaft_status bootstrap Agent catalog ownership', () => {
    const store = makeStore();
    const staleModels = [{ id: 'gpt-stale', ref: 'github-copilot/gpt-stale', provider: 'github-copilot' }];

    store.cacheYeaftAgentStatus(AGENT_ID, {
      type: 'yeaft_status',
      model: staleModels[0].ref,
      availableModels: staleModels,
    });

    expect(store.yeaftAvailableModels).toEqual([]);
    expect(store.yeaftStatusByAgent[AGENT_ID]?.availableModels).toBeUndefined();
  });

  it('accepts an equal revision only when its catalog digest matches', () => {
    const store = makeStore();
    const currentModels = [{ id: 'gpt-current', ref: 'github-copilot/gpt-current', provider: 'github-copilot' }];
    const conflictingModels = [{ id: 'gpt-conflict', ref: 'github-copilot/gpt-conflict', provider: 'github-copilot' }];

    store.cacheYeaftAgentStatus(AGENT_ID, status(currentModels, 200, 2, 'digest-current'));
    store.cacheYeaftAgentStatus(AGENT_ID, {
      ...status(currentModels, 200, 2, 'digest-current'),
      refreshing: true,
    });
    expect(store.yeaftModelsRefreshing).toBe(true);

    store.cacheYeaftAgentStatus(AGENT_ID, status(conflictingModels, 200, 2, 'digest-conflict'));
    expect(store.yeaftAvailableModels).toEqual(currentModels);
    expect(store.yeaftStatusByAgent[AGENT_ID].catalogDigest).toBe('digest-current');
  });

  it('accepts a new Agent catalog epoch after restart even when its revision resets', () => {
    const store = makeStore();
    const oldModels = [{ id: 'gpt-old', ref: 'github-copilot/gpt-old', provider: 'github-copilot' }];
    const restartedModels = [{ id: 'gpt-restarted', ref: 'github-copilot/gpt-restarted', provider: 'github-copilot' }];

    store.cacheYeaftAgentStatus(AGENT_ID, status(oldModels, 500, 10, 'digest-old', 'epoch-old'));
    store.cacheYeaftAgentStatus(AGENT_ID, status(restartedModels, 100, 1, 'digest-restarted', 'epoch-new'));

    expect(store.yeaftAvailableModels).toEqual(restartedModels);
    expect(store.yeaftStatusByAgent[AGENT_ID]).toMatchObject({
      catalogEpoch: 'epoch-new',
      catalogRevision: 1,
      catalogDigest: 'digest-restarted',
    });
  });

  it('does not let a retired Agent epoch reclaim catalog ownership', () => {
    const store = makeStore();
    const oldModels = [{ id: 'gpt-old', ref: 'github-copilot/gpt-old', provider: 'github-copilot' }];
    const restartedModels = [{ id: 'gpt-restarted', ref: 'github-copilot/gpt-restarted', provider: 'github-copilot' }];
    const delayedOldModels = [{ id: 'gpt-stale-old-process', ref: 'github-copilot/gpt-stale-old-process', provider: 'github-copilot' }];

    store.cacheYeaftAgentStatus(AGENT_ID, status(oldModels, 500, 10, 'digest-old', 'epoch-old'));
    store.cacheYeaftAgentStatus(AGENT_ID, status(restartedModels, 100, 1, 'digest-restarted', 'epoch-new'));
    store.cacheYeaftAgentStatus(AGENT_ID, status(delayedOldModels, 600, 11, 'digest-stale-old', 'epoch-old'));

    expect(store.yeaftAvailableModels).toEqual(restartedModels);
    expect(store.yeaftStatusByAgent[AGENT_ID]).toMatchObject({
      catalogEpoch: 'epoch-new',
      catalogRevision: 1,
      catalogDigest: 'digest-restarted',
    });
  });

  it('uses visible session_ready as the initial catalog before any Agent status exists', () => {
    const store = makeStore();
    const initialModels = [{ id: 'gpt-initial', ref: 'github-copilot/gpt-initial', provider: 'github-copilot' }];

    store.handleYeaftOutput(ready(initialModels));

    expect(store.yeaftAvailableModels).toEqual(initialModels);
    expect(store.yeaftStatusByAgent[AGENT_ID].availableModels).toEqual(initialModels);
  });

  it('projects the selected Agent cached catalog when agent_selected arrives in Yeaft', () => {
    const store = makeStore();
    const agentB = 'user-1:agent-2';
    const modelsA = [{ id: 'gpt-a', ref: 'provider-a/gpt-a' }];
    const modelsB = [{ id: 'gpt-b', ref: 'provider-b/gpt-b' }];
    store.agents = [{ id: AGENT_ID }, { id: agentB }];
    store.yeaftStatusByAgent = {
      [AGENT_ID]: { model: modelsA[0].ref, availableModels: modelsA },
      [agentB]: { model: modelsB[0].ref, availableModels: modelsB },
    };
    store.yeaftAvailableModels = modelsA;
    store.conversations = [];
    store.processingConversations = {};
    store.panels = [];
    store.sendWsMessage = () => {};

    handleAgentSelected(store, {
      agentId: agentB,
      agentName: 'Agent B',
      workDir: '/tmp/b',
      conversations: [],
    });

    expect(store.currentAgent).toBe(agentB);
    expect(store.yeaftModel).toBe('provider-b/gpt-b');
    expect(store.yeaftAvailableModels).toEqual(modelsB);
  });

  it('fails closed when agent_selected targets an Agent without a cached catalog', () => {
    const store = makeStore();
    const agentB = 'user-1:agent-2';
    store.yeaftAvailableModels = [{ id: 'gpt-a', ref: 'provider-a/gpt-a' }];
    store.conversations = [];
    store.processingConversations = {};
    store.panels = [];
    store.sendWsMessage = () => {};

    handleAgentSelected(store, { agentId: agentB, agentName: 'Agent B', conversations: [] });

    expect(store.yeaftAvailableModels).toEqual([]);
    expect(store.yeaftModelsRefreshing).toBe(true);
  });

  it('passes the clicked Session Agent identity into the activation action', () => {
    const source = readFileSync(new URL('../../../web/components/YeaftPage.js', import.meta.url), 'utf8');

    expect(source).toContain('store.setActiveSessionFilter(id, { agentId: g.agentId || null });');
  });

  it('does not reset the Yeaft runtime after an LLM config save', () => {
    const source = readFileSync(new URL('../../../web/components/YeaftPage.js', import.meta.url), 'utf8');
    const handler = source.match(/const onLlmConfigSaved = \(\) => \{([\s\S]*?)\n    \};/);

    expect(handler).not.toBeNull();
    expect(handler[1]).not.toContain("type: 'yeaft_reset'");
  });
});
