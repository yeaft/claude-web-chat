// @vitest-environment happy-dom
import { mount } from '@vue/test-utils';
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import * as Vue from 'vue';
import AgentSettingsPanel from '../../web/components/AgentSettingsPanel.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const panel = readFileSync(join(root, 'web/components/AgentSettingsPanel.js'), 'utf8');
const llmTab = readFileSync(join(root, 'web/components/LlmTab.js'), 'utf8');
const header = readFileSync(join(root, 'web/components/SidebarAgentHeader.js'), 'utf8');
const chatPage = readFileSync(join(root, 'web/components/ChatPage.js'), 'utf8');
const yeaftPage = readFileSync(join(root, 'web/components/YeaftPage.js'), 'utf8');
const workCenterPage = readFileSync(join(root, 'web/components/WorkCenterPage.js'), 'utf8');
const chatStore = readFileSync(join(root, 'web/stores/chat.js'), 'utf8');
const messageHandler = readFileSync(join(root, 'web/stores/helpers/messageHandler.js'), 'utf8');
const css = readFileSync(join(root, 'web/styles/agent-settings.css'), 'utf8');
const en = readFileSync(join(root, 'web/i18n/en.js'), 'utf8');
const zh = readFileSync(join(root, 'web/i18n/zh-CN.js'), 'utf8');

describe('Agent settings surface', () => {
  it('replaces cramped dropdown controls with one dedicated entry', () => {
    expect(header).toContain("emits: ['open-agent-settings']");
    expect(header).toContain("$emit('open-agent-settings', agent.id)");
    expect(header).not.toContain("$emit('upgrade-agent'");
    expect(header).not.toContain("$emit('set-dream-enabled'");
  });

  it('is reachable from both Chat and Yeaft sidebars', () => {
    expect(chatPage).toContain('<AgentSettingsPanel v-if="showAgentSettings"');
    expect(chatPage).toContain('@open-agent-settings="openAgentSettings"');
    expect(yeaftPage).toContain('<AgentSettingsPanel v-if="showAgentSettings"');
    expect(yeaftPage).toContain('@open-agent-settings="openAgentSettings"');
  });

  it('keeps per-Agent telemetry requests correlated by request and agent', () => {
    expect(chatStore).toContain("this._telemetryPending[requestId] = { resolve, reject, timer, agentId, operation, requestId }");
    expect(messageHandler).toContain("pending: store._telemetryPending?.[msg.requestId]");
    expect(messageHandler).toContain('A response without request identity has no provenance');
    expect(messageHandler).not.toContain('isUniqueLegacyAgentRequest');
    expect(panel).toContain('this.store.loadTelemetrySettings(agentId)');
    expect(panel).toContain('this.store.updateTelemetrySettings(this.telemetryDraft, agentId)');
  });

  it('treats the pushed Agent version as a hint and keeps manual registry checks available', () => {
    expect(panel).toContain('selectedAgent.upgradeAvailable');
    expect(panel).toContain("$t('agentSettings.runtime.updateUnknown')");
    expect(panel).not.toContain("$t('agentSettings.runtime.upToDate')");
    expect(panel).toContain(':disabled="busy || !selectedAgent.online"');
    expect(en).toContain("'agentSettings.runtime.updateAvailable': 'Update available: v{version}'");
    expect(zh).toContain("'agentSettings.runtime.updateAvailable': '可更新至 v{version}'");
  });

  it('uses one Agent picker and category navigation without a large header', () => {
    expect(panel).toContain('class="agent-settings-agent-picker"');
    expect(panel).toContain("activeCategory === 'operations'");
    expect(panel).toContain("activeCategory === 'trace'");
    expect(panel).toContain("activeCategory === 'llm'");
    expect(panel).not.toContain('agent-settings-header');
    expect(panel).not.toContain('agent-settings-list');
    expect(en).toContain("'agentSettings.categories.operations': 'Operations'");
    expect(zh).toContain("'agentSettings.categories.llm': 'LLM 配置'");
  });

  it('reuses LlmTab with an explicit selected-Agent target', () => {
    expect(panel).toContain("import LlmTab from './LlmTab.js'");
    expect(panel).toContain('<LlmTab context="yeaft" :agent-id="selectedAgentId"');
    expect(panel).toContain("initialCategory: { type: String, default: 'operations' }");
    expect(llmTab).toContain("agentId: { type: String, default: null }");
    expect(llmTab).toContain('return this.agentId || this.chatStore.currentAgent');
  });

  it('routes existing model configuration entry points into Agent Settings', () => {
    expect(yeaftPage).toContain("openAgentSettings(store.currentAgent || null, 'llm')");
    expect(yeaftPage).not.toContain('yeaft-llm-config-modal');
    expect(workCenterPage).toContain('<AgentSettingsPanel v-if="llmConfigOpen" :initial-agent-id="agentId" initial-category="llm"');
    expect(workCenterPage).not.toContain('<LlmTab context="yeaft"');
  });

  it('propagates a successful LLM save with the exact selected Agent', async () => {
    const store = Vue.reactive({
      agents: [{ id: 'agent-a', name: 'Agent A', online: true }],
      currentAgent: 'agent-a',
      agentOperations: {},
      agentDreamState: {},
      loadTelemetrySettings: vi.fn(() => Promise.resolve({})),
    });
    globalThis.Pinia = { useChatStore: () => store };
    globalThis.Vue = Vue;
    const wrapper = mount(AgentSettingsPanel, {
      props: { initialAgentId: 'agent-a', initialCategory: 'llm' },
      global: {
        mocks: { $t: key => key },
        stubs: { LlmTab: { template: '<button class="save-llm" @click="$emit(\'saved\')">save</button>' } },
      },
    });
    await Vue.nextTick();
    await wrapper.get('.save-llm').trigger('click');
    expect(wrapper.emitted('saved')).toEqual([['agent-a']]);
    wrapper.unmount();
  });

  it('keeps content scroll inside the fixed shell and adapts navigation on mobile', () => {
    expect(css).toContain('height: min(820px, 92vh)');
    expect(css).toContain('.agent-settings-content { min-width: 0; overflow-y: auto;');
    expect(css).toContain('@media (max-height: 680px) and (min-width: 681px)');
    expect(css).toContain('@media (max-width: 680px)');
    expect(css).toContain('.agent-settings-nav nav { flex-direction: row; overflow-x: auto; }');
  });
});
