import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { loadSandboxState } from '../../web/utils/sandbox-api.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const component = readFileSync(join(root, 'web/components/SettingsPanel.js'), 'utf8');
const sandboxApi = readFileSync(join(root, 'web/utils/sandbox-api.js'), 'utf8');
const en = readFileSync(join(root, 'web/i18n/en.js'), 'utf8');
const zh = readFileSync(join(root, 'web/i18n/zh-CN.js'), 'utf8');
const css = readFileSync(join(root, 'web/styles/settings.css'), 'utf8');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function jsonResponse(body, ok = true) {
  return { ok, json: vi.fn(async () => body) };
}

describe('Sandbox Settings contract', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('keeps the entry visible and gates create from server capability', () => {
    expect(component).toContain("{ key: 'sandbox', label: this.$t('settings.tabs.sandbox') }");
    expect(component).toContain('v-if="!sandboxCapability.available"');
    expect(component).toContain('if (!this.sandboxCapability.available || this.sandboxSubmitting) return;');
    expect(component).toContain('loadSandboxState({ headers: this.getHeaders() })');
    expect(sandboxApi).toContain("fetchImpl('/api/sandbox/capability'");
    expect(sandboxApi).toContain("fetchImpl('/api/sandbox'");
    expect(component).toContain("requestSandboxAction('stop')");
    expect(component).toContain("requestSandboxAction('start')");
    expect(component).toContain("requestSandboxAction('retry')");
    expect(component).toContain('confirmRemoveSandbox');
    expect(component).toContain("confirmDialog(this.$t('settings.sandbox.removeConfirm')");
    expect(component).toContain('<button class="btn-secondary" @click="confirmRemoveSandbox"');
    expect(component).not.toContain("sandboxSnapshot.observedState !== 'recovery_required'");
  });

  it('does not request the Docker-backed snapshot when capability is unavailable', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      available: false,
      reasonCode: 'SANDBOX_DISABLED',
      catalog: [],
    }));

    await expect(loadSandboxState({ headers: { Authorization: 'Bearer token' }, fetchImpl }))
      .resolves.toEqual({
        capability: { available: false, reasonCode: 'SANDBOX_DISABLED', catalog: [] },
        sandbox: null,
      });
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(fetchImpl).toHaveBeenCalledWith('/api/sandbox/capability', {
      headers: { Authorization: 'Bearer token' },
    });
  });

  it('loads the owner snapshot only after the Server reports an available runtime', async () => {
    const snapshot = { id: 'sandbox-user-1', observedState: 'running' };
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ available: true, reasonCode: null, catalog: [{ id: 'standard' }] }))
      .mockResolvedValueOnce(jsonResponse({ sandbox: snapshot }));

    await expect(loadSandboxState({ fetchImpl })).resolves.toEqual({
      capability: { available: true, reasonCode: null, catalog: [{ id: 'standard' }] },
      sandbox: snapshot,
    });
    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([
      '/api/sandbox/capability',
      '/api/sandbox',
    ]);
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

  it('ignores an older Sandbox load that completes after a newer request', async () => {
    const olderSnapshot = deferred();
    let capabilityCalls = 0;
    let snapshotCalls = 0;
    vi.stubGlobal('Pinia', {
      defineStore: vi.fn(() => () => ({})),
      useChatStore: vi.fn(() => ({})),
    });
    vi.stubGlobal('fetch', vi.fn(async url => {
      if (url === '/api/sandbox/capability') {
        capabilityCalls += 1;
        return jsonResponse({
          available: true,
          reasonCode: null,
          catalog: [{ id: 'standard' }],
          generation: capabilityCalls === 1 ? 'old' : 'new',
        });
      }
      snapshotCalls += 1;
      if (snapshotCalls === 1) return olderSnapshot.promise;
      return jsonResponse({ sandbox: { generation: 'new', observedState: 'stopped' } });
    }));
    const { default: SettingsPanel } = await import('../../web/components/SettingsPanel.js');
    const context = {
      sandboxLoading: false,
      sandboxLoadError: false,
      sandboxCapability: null,
      sandboxSnapshot: null,
      visible: false,
      activeTab: 'sandbox',
      getHeaders: () => ({}),
      stopSandboxPolling: vi.fn(),
      syncSandboxPolling: vi.fn(),
    };

    const olderLoad = SettingsPanel.methods.loadSandbox.call(context);
    await vi.waitFor(() => expect(snapshotCalls).toBe(1));
    const newerLoad = SettingsPanel.methods.loadSandbox.call(context);
    await newerLoad;
    expect(context.sandboxSnapshot).toEqual({ generation: 'new', observedState: 'stopped' });

    olderSnapshot.resolve(jsonResponse({
      sandbox: { generation: 'old', observedState: 'running' },
    }));
    await olderLoad;

    expect(context.sandboxSnapshot).toEqual({ generation: 'new', observedState: 'stopped' });
    expect(context.sandboxCapability.generation).toBe('new');
  });

  it('invalidates an in-flight Sandbox load when the panel closes', async () => {
    const pendingCapability = deferred();
    vi.stubGlobal('Pinia', {
      defineStore: vi.fn(() => () => ({})),
      useChatStore: vi.fn(() => ({})),
    });
    vi.stubGlobal('fetch', vi.fn(() => pendingCapability.promise));
    const { default: SettingsPanel } = await import('../../web/components/SettingsPanel.js');
    const context = {
      sandboxLoading: false,
      sandboxLoadError: false,
      sandboxCapability: { available: false, reasonCode: 'SANDBOX_DISABLED', catalog: [] },
      sandboxSnapshot: null,
      visible: false,
      activeTab: 'sandbox',
      getHeaders: () => ({}),
      stopSandboxPolling: vi.fn(),
      syncSandboxPolling: vi.fn(),
    };

    const loading = SettingsPanel.methods.loadSandbox.call(context);
    SettingsPanel.methods.invalidateSandboxLoads.call(context);
    pendingCapability.resolve(jsonResponse({
      available: true,
      reasonCode: null,
      catalog: [{ id: 'standard' }],
    }));
    await loading;

    expect(context.sandboxCapability).toEqual({
      available: false,
      reasonCode: 'SANDBOX_DISABLED',
      catalog: [],
    });
    expect(context.sandboxSnapshot).toBeNull();
    expect(context.sandboxLoading).toBe(false);
    expect(context.syncSandboxPolling).not.toHaveBeenCalled();
  });

  it('reuses idempotency keys while a lifecycle response is uncertain', () => {
    expect(component).toContain('sandboxIdempotencyKeys: {}');
    expect(component).toContain("this.sandboxIdempotencyKey('create')");
    expect(component).toContain('this.sandboxIdempotencyKey(action)');
    expect(component).toContain("this.clearSandboxIdempotencyKey('create')");
    expect(component).toContain('this.clearSandboxIdempotencyKey(action)');
    expect(component).toContain("body.code === 'SANDBOX_OWNER_INACTIVE'");
    expect(component).not.toContain("'Idempotency-Key': crypto.randomUUID()");
  });

  it('explains the simple Server-managed container boundary', () => {
    expect(en).toContain("'settings.sandbox.description': 'Run a persistent Yeaft Agent in a Docker container managed by this Server.'");
    expect(zh).toContain("'settings.sandbox.description': '在本 Server 管理的 Docker 容器中运行一个持久化 Yeaft Agent。'");
    expect(en).toContain('The Server manages only this container’s start, stop, and removal.');
    expect(zh).toContain('Server 只管理此容器的启动、停止和删除');
    expect(en).not.toContain('qualified dedicated Sandbox Host');
    expect(zh).not.toContain('合格的专用 Sandbox Host');
  });

  it('uses stable, non-sensitive unavailable messages in both locales', () => {
    for (const locale of [en, zh]) {
      expect(locale).toContain("'settings.sandbox.unavailable.disabled'");
      expect(locale).toContain("'settings.sandbox.unavailable.dockerUnavailable'");
      expect(locale).toContain("'settings.sandbox.unavailable.notEntitled'");
      expect(locale).toContain("'settings.sandbox.unavailable.capacityUnavailable'");
    }
    const template = component.slice(component.indexOf('template: `'), component.indexOf('directives:'));
    expect(template).not.toMatch(/hostId|host_id|reservedCount|other users/i);
  });

  it('renders a dedicated Sandbox navigation icon like the other settings tabs', () => {
    expect(component).toContain('v-else-if="tab.key === \'sandbox\'"');
    expect(component).toContain('M7 2h10');
  });

  it('covers loading, empty, disabled, retryable error, and long-name states', () => {
    expect(component).toContain('v-if="sandboxLoading"');
    expect(component).toContain('v-else-if="sandboxLoadError"');
    expect(component).toContain('@click="loadSandbox"');
    expect(component).toContain('v-else-if="sandboxSnapshot"');
    expect(component).toContain('v-if="!sandboxCapability.available"');
    expect(component).toContain('sp-label sp-text-wrap');
    expect(css).toContain('.sp-text-wrap');
    expect(css).toContain('overflow-wrap: anywhere');
    for (const locale of [en, zh]) {
      expect(locale).toContain("'settings.sandbox.error.SANDBOX_LOAD_FAILED'");
      expect(locale).toContain("'settings.sandbox.retryLoad'");
      expect(locale).toContain("'settings.sandbox.state.recovery_required'");
      expect(locale).toContain("'settings.sandbox.state.waiting_for_agent'");
      expect(locale).toContain("'settings.sandbox.state.removed'");
      expect(locale).toContain("'settings.sandbox.stage.dispatching'");
      expect(locale).toContain("'settings.sandbox.stage.capacity_rejected'");
    }
  });
});
