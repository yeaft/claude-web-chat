import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const component = readFileSync(join(root, 'web/components/SettingsPanel.js'), 'utf8');
const en = readFileSync(join(root, 'web/i18n/en.js'), 'utf8');
const zh = readFileSync(join(root, 'web/i18n/zh-CN.js'), 'utf8');
const css = readFileSync(join(root, 'web/styles/settings.css'), 'utf8');

describe('Sandbox Settings contract', () => {
  it('keeps the entry visible and gates create from server capability', () => {
    expect(component).toContain("{ key: 'sandbox', label: this.$t('settings.tabs.sandbox') }");
    expect(component).toContain('v-if="!sandboxCapability.available"');
    expect(component).toContain('if (!this.sandboxCapability.available || this.sandboxSubmitting) return;');
    expect(component).toContain("fetch('/api/sandbox/capability',");
    expect(component).toContain("fetch('/api/sandbox',");
    expect(component).toContain("requestSandboxAction('stop')");
    expect(component).toContain("requestSandboxAction('start')");
    expect(component).toContain("requestSandboxAction('retry')");
    expect(component).toContain('confirmRemoveSandbox');
    expect(component).toContain('window.confirm');
    expect(component).toContain('<button class="btn-secondary" @click="confirmRemoveSandbox"');
    expect(component).not.toContain("sandboxSnapshot.observedState !== 'recovery_required'");
  });

  it('polls persisted operations while Settings remains on the Sandbox tab', () => {
    expect(component).toContain("snapshot?.operation?.status === 'pending'");
    expect(component).toContain("snapshot?.operation?.status === 'running'");
    expect(component).toContain('await this.loadSandbox({ background: true })');
    expect(component).toContain("if (this.activeTab === 'sandbox') this.loadSandbox()");
    expect(component).toContain('beforeUnmount()');
    expect(component).toContain('this.stopSandboxPolling()');
    expect(component).not.toMatch(/sandboxSnapshot\s*=\s*\{[^}]*observedState/s);
  });

  it('reuses idempotency keys while a lifecycle response is uncertain', () => {
    expect(component).toContain('sandboxIdempotencyKeys: {}');
    expect(component).toContain("this.sandboxIdempotencyKey('create')");
    expect(component).toContain('this.sandboxIdempotencyKey(action)');
    expect(component).toContain("this.clearSandboxIdempotencyKey('create')");
    expect(component).toContain('this.clearSandboxIdempotencyKey(action)');
    expect(component).not.toContain("'Idempotency-Key': crypto.randomUUID()");
  });

  it('explains that Sandbox creates a separate managed Agent', () => {
    expect(en).toContain("'settings.sandbox.description': 'Create a separate, persistent managed Yeaft Agent on a qualified dedicated Sandbox Host.'");
    expect(zh).toContain("'settings.sandbox.description': '在合格的专用 Sandbox Host 上创建一个独立、持久化的托管 Yeaft Agent。'");
    expect(en).toContain("'settings.sandbox.unavailable.disabled': 'The server-side managed Sandbox service is not enabled for this deployment. Updating an existing Agent does not enable it.'");
    expect(zh).toContain("'settings.sandbox.unavailable.disabled': '此部署尚未启用服务器端托管 Sandbox 服务；升级现有 Agent 不会启用它。'");
  });

  it('uses stable, non-sensitive unavailable messages in both locales', () => {
    for (const locale of [en, zh]) {
      expect(locale).toContain("'settings.sandbox.unavailable.disabled'");
      expect(locale).toContain("'settings.sandbox.unavailable.notEntitled'");
      expect(locale).toContain("'settings.sandbox.unavailable.capacityUnavailable'");
    }
    const template = component.slice(component.indexOf('template: `'), component.indexOf('directives:'));
    expect(template).not.toMatch(/hostId|host_id|reservedCount|other users/i);
  });

  it('renders a dedicated Sandbox navigation icon like the other settings tabs', () => {
    expect(component).toContain("v-else-if=\"tab.key === 'sandbox'\"");
    expect(component).toContain('M7 2h10');
  });

  it('covers loading, empty, disabled, error, and long-name states', () => {
    expect(component).toContain('v-if="sandboxLoading"');
    expect(component).toContain('v-else-if="sandboxLoadError"');
    expect(component).toContain('v-else-if="sandboxSnapshot"');
    expect(component).toContain('v-if="!sandboxCapability.available"');
    expect(component).toContain('sp-label sp-text-wrap');
    expect(css).toContain('.sp-text-wrap');
    expect(css).toContain('overflow-wrap: anywhere');
    for (const locale of [en, zh]) {
      expect(locale).toContain("'settings.sandbox.error.SANDBOX_LOAD_FAILED'");
      expect(locale).toContain("'settings.sandbox.state.recovery_required'");
      expect(locale).toContain("'settings.sandbox.state.waiting_for_agent'");
      expect(locale).toContain("'settings.sandbox.state.removed'");
      expect(locale).toContain("'settings.sandbox.stage.dispatching'");
      expect(locale).toContain("'settings.sandbox.stage.capacity_rejected'");
    }
  });
});
