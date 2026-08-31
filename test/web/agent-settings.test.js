import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const panel = readFileSync(join(root, 'web/components/AgentSettingsPanel.js'), 'utf8');
const header = readFileSync(join(root, 'web/components/SidebarAgentHeader.js'), 'utf8');
const chatPage = readFileSync(join(root, 'web/components/ChatPage.js'), 'utf8');
const yeaftPage = readFileSync(join(root, 'web/components/YeaftPage.js'), 'utf8');
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
    expect(chatStore).toContain("this._telemetryPending[requestId] = { resolve, reject, timer, agentId, operation }");
    expect(messageHandler).toContain("uniquePending(store._telemetryPending, pending => pending.agentId === msg.agentId && pending.operation === expectedOperation)");
    expect(panel).toContain('this.store.loadTelemetrySettings(agentId)');
    expect(panel).toContain('this.store.updateTelemetrySettings(this.telemetryDraft, agentId)');
  });

  it('shows the authoritative Agent update state', () => {
    expect(panel).toContain('selectedAgent.upgradeAvailable');
    expect(panel).toContain("$t('agentSettings.runtime.upToDate')");
    expect(en).toContain("'agentSettings.runtime.updateAvailable': 'Update available: v{version}'");
    expect(zh).toContain("'agentSettings.runtime.updateAvailable': '可更新至 v{version}'");
  });

  it('uses the fixed settings shell, responsive layout, and bilingual copy', () => {
    expect(css).toContain('height: min(760px, 92vh)');
    expect(css).toContain('.agent-settings-content { min-width: 0; overflow-y: auto;');
    expect(css).toContain('@media (max-width: 680px)');
    expect(en).toContain("'agentSettings.title': 'Agent settings'");
    expect(zh).toContain("'agentSettings.title': 'Agent 设置'");
  });
});
