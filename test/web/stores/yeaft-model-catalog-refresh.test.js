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

function ready(models) {
  return {
    agentId: AGENT_ID,
    sessionId: ACTIVE_SESSION_ID,
    event: {
      type: 'session_ready',
      conversationId: 'yeaft-current',
      model: models[0]?.ref || null,
      availableModels: models,
      skills: [],
      mcpServers: [],
      tools: [],
    },
  };
}

describe('Yeaft Session model catalog refresh', () => {
  it('does not let session_ready replace an Agent config catalog', () => {
    const store = makeStore();
    const freshModels = [{ id: 'gpt-new', ref: 'github-copilot/gpt-new', provider: 'github-copilot' }];
    const staleModels = [{ id: 'gpt-default', ref: 'github-copilot/gpt-default', provider: 'github-copilot' }];

    store.cacheYeaftAgentStatus(AGENT_ID, {
      type: 'yeaft_status',
      model: freshModels[0].ref,
      availableModels: freshModels,
    });
    store.handleYeaftOutput(ready(staleModels));

    expect(store.yeaftModel).toBe(freshModels[0].ref);
    expect(store.yeaftAvailableModels).toEqual(freshModels);
    expect(store.yeaftStatusByAgent[AGENT_ID].availableModels).toEqual(freshModels);
  });

  it('lets a later Agent config refresh replace the previous config catalog', () => {
    const store = makeStore();
    const oldModels = [{ id: 'gpt-old', ref: 'github-copilot/gpt-old', provider: 'github-copilot' }];
    const newModels = [{ id: 'gpt-new', ref: 'github-copilot/gpt-new', provider: 'github-copilot' }];

    store.cacheYeaftAgentStatus(AGENT_ID, { type: 'yeaft_status', model: oldModels[0].ref, availableModels: oldModels });
    store.cacheYeaftAgentStatus(AGENT_ID, { type: 'yeaft_status', model: newModels[0].ref, availableModels: newModels });

    expect(store.yeaftModel).toBe(newModels[0].ref);
    expect(store.yeaftAvailableModels).toEqual(newModels);
  });

  it('does not reset the Yeaft runtime after an LLM config save', () => {
    const source = readFileSync(new URL('../../../web/components/YeaftPage.js', import.meta.url), 'utf8');
    const handler = source.match(/const onLlmConfigSaved = \(\) => \{([\s\S]*?)\n    \};/);

    expect(handler?.[1]).toContain('showLlmConfig.value = false');
    expect(handler?.[1]).not.toContain('yeaft_reset');
  });
});
