import { describe, expect, it, vi } from 'vitest';
import LlmTab from '../../web/components/LlmTab.js';
import en from '../../web/i18n/en.js';
import zhCN from '../../web/i18n/zh-CN.js';
import { PROTOCOL_PRESET_MODELS } from '../../web/utils/protocolPresets.js';

function withSaveLifecycle(ctx) {
  return Object.assign(ctx, {
    cancelPendingSave: LlmTab.methods.cancelPendingSave,
  });
}

describe('LlmTab editable model refs', () => {
  it('uses unsaved local providers so discovered models appear before save', () => {
    const computed = LlmTab.computed.allModelRefs;
    const ctx = {
      currentConfig: {
        effectiveConfig: {
          providers: [{ name: 'old', models: ['old-model'] }],
        },
      },
      localProviders: [{
        name: 'github-copilot',
        models: [{ id: 'claude-sonnet-4.5', protocol: 'anthropic' }, 'gpt-5'],
      }],
      parseModelsFromProvider: LlmTab.methods.parseModelsFromProvider,
      _modelId: LlmTab.methods._modelId,
      isManagedProvider: LlmTab.methods.isManagedProvider,
      fallbackCopilotModels: LlmTab.methods.fallbackCopilotModels,
    };

    expect(computed.call(ctx)).toEqual([
      'github-copilot/claude-sonnet-4.5',
      'github-copilot/gpt-5',
    ]);
  });

  it('uses fallback catalog refs for minimal managed Copilot providers', () => {
    const computed = LlmTab.computed.allModelRefs;
    const ctx = {
      currentConfig: { effectiveConfig: { providers: [] } },
      localProviders: [{ name: 'github-copilot', credentialProvider: 'github-copilot' }],
      parseModelsFromProvider: LlmTab.methods.parseModelsFromProvider,
      _modelId: LlmTab.methods._modelId,
      isManagedProvider: LlmTab.methods.isManagedProvider,
      fallbackCopilotModels: LlmTab.methods.fallbackCopilotModels,
    };

    expect(computed.call(ctx)).toContain('github-copilot/gpt-5.5');
    expect(computed.call(ctx)).toContain('github-copilot/claude-opus-4.8');
    expect(computed.call(ctx)).toContain('github-copilot/gpt-5-mini');
  });

  it('hides custom provider fields for managed Copilot but keeps custom providers key-only', () => {
    expect(LlmTab.template).toContain('v-if="!isManagedProvider(provider)" class="llm-field"');
    expect(LlmTab.template).toContain('settings.llm.protocol');
    expect(LlmTab.template).toContain('settings.llm.managedCopilotDesc');
    expect(LlmTab.template).not.toContain('settings.llm.autoAuthGithubCopilot');
    expect(LlmTab.template).not.toContain('toggleAutoAuth');
  });

  it('replaces a removed Copilot Agent default with the discovered catalog default', () => {
    const ctx = {
      localProviders: [{ name: 'github-copilot', credentialProvider: 'github-copilot', models: ['gpt-old'] }],
      localPrimaryModel: 'github-copilot/gpt-old',
      localFastModel: 'github-copilot/gpt-old',
      refreshProviderModelsText() {},
      parseModelsFromProvider: LlmTab.methods.parseModelsFromProvider,
      isManagedProvider: LlmTab.methods.isManagedProvider,
      _modelId: LlmTab.methods._modelId,
      markDirty() { this.isDirty = true; },
      isDirty: false,
    };

    LlmTab.methods.applyDiscoveredProvider.call(ctx, {
      provider: { name: 'github-copilot', credentialProvider: 'github-copilot' },
      providerModels: [{ id: 'gpt-new', protocol: 'openai-responses' }],
    });

    expect(ctx.localPrimaryModel).toBe('github-copilot/gpt-new');
    expect(ctx.localFastModel).toBe('github-copilot/gpt-new');
    expect(ctx.isDirty).toBe(true);

    const sent = [];
    Object.assign(ctx, {
      effectiveAgentId: 'agent-1',
      saving: false,
      context: 'yeaft',
      editableProviders: ctx.localProviders,
      currentConfig: { effectiveConfig: { language: 'en' } },
      chatStore: { sendWsMessage: msg => sent.push(msg) },
      $watch: () => () => {},
      $emit: () => {},
    });
    LlmTab.methods.saveConfig.call(withSaveLifecycle(ctx));

    expect(sent[0].config.primaryModel).toBe('github-copilot/gpt-new');
    expect(sent[0].config.providers[0].models).toEqual([
      { id: 'gpt-new', protocol: 'openai-responses' },
    ]);
  });

  it('saves the GitHub Copilot catalog for the Session model menu', () => {
    const sent = [];
    const ctx = {
      effectiveAgentId: 'agent-1',
      saving: false,
      editableProviders: [{
        name: 'github-copilot',
        baseUrl: 'https://api.githubcopilot.com',
        credentialProvider: 'github-copilot',
        protocol: 'openai-responses',
        models: [{ id: 'claude-opus-4.8', protocol: 'anthropic' }, { id: 'gpt-5', protocol: 'openai-responses' }],
      }],
      localPrimaryModel: 'github-copilot/claude-opus-4.8',
      localFastModel: 'github-copilot/gpt-5',
      currentConfig: { effectiveConfig: { language: 'en' } },
      chatStore: { sendWsMessage: msg => sent.push(msg) },
      $watch: () => () => {},
      $emit: () => {},
      isManagedProvider: LlmTab.methods.isManagedProvider,
      _modelId: LlmTab.methods._modelId,
    };

    LlmTab.methods.saveConfig.call(withSaveLifecycle(ctx));
    expect(sent[0].config.providers).toEqual([{
      name: 'github-copilot',
      credentialProvider: 'github-copilot',
      managed: 'github-copilot',
      models: [
        { id: 'claude-opus-4.8', protocol: 'anthropic' },
        { id: 'gpt-5', protocol: 'openai-responses' },
      ],
    }]);
  });

  it('reports a live refresh warning as a partial save success', () => {
    vi.useFakeTimers();
    try {
      const sent = [];
      const emitted = [];
      let configWatcher = null;
      const ctx = {
        effectiveAgentId: 'agent-warning',
        saving: false,
        saveRefreshWarning: null,
        isDirty: true,
        context: 'yeaft',
        editableProviders: [{ name: 'p1', baseUrl: 'http://p1/v1', models: ['gpt-new'] }],
        localPrimaryModel: 'p1/gpt-new',
        localFastModel: null,
        currentConfig: { loaded: false },
        chatStore: { sendWsMessage: msg => sent.push(msg) },
        isManagedProvider: LlmTab.methods.isManagedProvider,
        _modelId: LlmTab.methods._modelId,
        $t(key, params = {}) {
          if (key === 'settings.llm.savedRefreshWarning') return `saved with warning: ${params.error}`;
          return key;
        },
        $emit: (...args) => emitted.push(args),
        $watch(_key, callback) {
          configWatcher = callback;
          return () => {};
        },
      };

      LlmTab.methods.saveConfig.call(withSaveLifecycle(ctx));
      configWatcher({
        loaded: true,
        requestId: sent[0].requestId,
        error: null,
        statusRefreshError: 'runtime refresh failed',
      });

      expect(sent).toHaveLength(1);
      expect(ctx.saving).toBe(false);
      expect(ctx.isDirty).toBe(false);
      expect(ctx.saveRefreshWarning).toBe('saved with warning: runtime refresh failed');
      expect(emitted).toContainEqual(['message', 'saved with warning: runtime refresh failed', true]);
      expect(emitted).toContainEqual(['saved', { warning: 'saved with warning: runtime refresh failed' }]);
      expect(emitted.some(args => args[1] === 'settings.llm.saveFailed')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('ignores a discovery result after the active Agent changes', async () => {
    let resolveDiscovery;
    const discovery = new Promise(resolve => { resolveDiscovery = resolve; });
    const sent = [];
    const applyDiscoveredProvider = vi.fn();
    const ctx = {
      effectiveAgentId: 'agent-a',
      agentOnline: true,
      discoveringModels: false,
      modelDiscoveryWarning: null,
      modelDiscoveryError: null,
      chatStore: { sendWsMessage: message => sent.push(message) },
      cancelPendingDiscovery: LlmTab.methods.cancelPendingDiscovery,
      waitForModelDiscovery: () => discovery,
      applyDiscoveredProvider,
    };

    const pending = LlmTab.methods.useGitHubCopilotPreset.call(ctx);
    expect(sent[0]).toMatchObject({
      type: 'discover_llm_models',
      agentId: 'agent-a',
    });
    ctx.effectiveAgentId = 'agent-b';
    resolveDiscovery({
      requestId: sent[0].requestId,
      provider: { name: 'github-copilot' },
      providerModels: ['gpt-new'],
    });
    await pending;

    expect(applyDiscoveredProvider).not.toHaveBeenCalled();
    expect(ctx.modelDiscoveryWarning).toBeNull();
    expect(ctx.modelDiscoveryError).toBeNull();
  });

  it('ignores a save acknowledgement after the active Agent changes', () => {
    vi.useFakeTimers();
    try {
      const sent = [];
      const emitted = [];
      let configWatcher = null;
      const ctx = withSaveLifecycle({
        effectiveAgentId: 'agent-a',
        saving: false,
        saveRefreshWarning: null,
        isDirty: true,
        context: 'yeaft',
        editableProviders: [{ name: 'p1', baseUrl: 'http://p1/v1', models: ['gpt-new'] }],
        localPrimaryModel: 'p1/gpt-new',
        localFastModel: null,
        currentConfig: { effectiveConfig: { language: 'en' } },
        chatStore: { sendWsMessage: message => sent.push(message) },
        isManagedProvider: LlmTab.methods.isManagedProvider,
        _modelId: LlmTab.methods._modelId,
        $t: key => key,
        $emit: (...args) => emitted.push(args),
        $watch(_key, callback) {
          configWatcher = callback;
          return () => {};
        },
      });

      LlmTab.methods.saveConfig.call(ctx);
      ctx.effectiveAgentId = 'agent-b';
      configWatcher({ loaded: true, requestId: sent[0].requestId, error: null });

      expect(ctx.isDirty).toBe(true);
      expect(emitted.some(args => args[0] === 'saved')).toBe(false);
      expect(ctx._pendingSave).toEqual({ agentId: 'agent-a', requestId: sent[0].requestId });
    } finally {
      vi.useRealTimers();
    }
  });

  it('offers Claude Opus 4.8 in Anthropic presets', () => {
    expect(PROTOCOL_PRESET_MODELS.anthropic).toContain('claude-opus-4-8');
    expect(PROTOCOL_PRESET_MODELS.anthropic).toContain('claude-opus-4.8');
  });

  it('keeps Agent install commands out of the Yeaft LLM tab', () => {
    expect(LlmTab.template).not.toContain('class="llm-agent-install"');
    expect(LlmTab.template).not.toContain('settings.llm.agentInstallCommands');
    expect(LlmTab.template).not.toContain('{{ agentInstallCommand }}');
    expect(LlmTab.template).not.toContain('{{ copilotUseCommand }}');
    expect(LlmTab.template).not.toContain('copyText(agentInstallCommand)');
    expect(LlmTab.template).not.toContain('copyText(copilotUseCommand)');
    expect(LlmTab.template).not.toContain('copilotInstructionsDesc');
    expect(LlmTab.template).not.toContain('copilotStepVerifyDesc');
    expect(LlmTab.template).not.toContain('yeaft-agent llm show');
    expect(LlmTab.computed.agentInstallCommand).toBeUndefined();
    expect(LlmTab.computed.copilotUseCommand).toBeUndefined();
  });

  it('has translations for every LLM tab template key in both locales', () => {
    const keys = Array.from(LlmTab.template.matchAll(/settings\.llm\.[A-Za-z0-9_.-]+/g), m => m[0]);
    for (const key of new Set(keys)) {
      expect(Object.prototype.hasOwnProperty.call(en, key), `missing en translation for ${key}`).toBe(true);
      expect(Object.prototype.hasOwnProperty.call(zhCN, key), `missing zh-CN translation for ${key}`).toBe(true);
    }
  });

  it('hides the fast/secondary model field in the Yeaft context', () => {
    expect(LlmTab.template).toContain('class="llm-model-select-field" v-if="context !== \'yeaft\'"');
    expect(LlmTab.template).toContain('settings.llm.fastModel');
  });

  it('omits fastModel when saving in the Yeaft context but keeps it elsewhere', () => {
    const baseCtx = () => {
      const sent = [];
      return {
        sent,
        ctx: {
          effectiveAgentId: 'agent-1',
          saving: false,
          editableProviders: [{ name: 'p1', baseUrl: 'http://x/v1', models: [{ id: 'gpt-5' }] }],
          localPrimaryModel: 'p1/gpt-5',
          localFastModel: 'p1/gpt-5-mini',
          currentConfig: { effectiveConfig: { language: 'en' } },
          chatStore: { sendWsMessage: msg => sent.push(msg) },
          $watch: () => () => {},
          $emit: () => {},
          isManagedProvider: LlmTab.methods.isManagedProvider,
          _modelId: LlmTab.methods._modelId,
        },
      };
    };

    const yeaft = baseCtx();
    yeaft.ctx.context = 'yeaft';
    LlmTab.methods.saveConfig.call(withSaveLifecycle(yeaft.ctx));
    expect(yeaft.sent[0].config.primaryModel).toBe('p1/gpt-5');
    expect('fastModel' in yeaft.sent[0].config).toBe(false);

    const settings = baseCtx();
    settings.ctx.context = 'settings';
    LlmTab.methods.saveConfig.call(withSaveLifecycle(settings.ctx));
    expect(settings.sent[0].config.fastModel).toBe('p1/gpt-5-mini');
  });
});
