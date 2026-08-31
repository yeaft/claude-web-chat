import { confirmDialog } from '../utils/dialog.js';

const DEFAULT_TELEMETRY = Object.freeze({
  enabled: true,
  retentionDays: 3,
  flushIntervalMs: 1000,
  maxQueueSize: 5000,
  rawExchangeMaxBytes: 524288,
  traceTextMaxBytes: 262144,
});

export default {
  name: 'AgentSettingsPanel',
  props: {
    initialAgentId: { type: String, default: null },
  },
  emits: ['close'],
  template: `
    <div class="settings-overlay" @click.self="$emit('close')">
      <section class="agent-settings-dialog" role="dialog" aria-modal="true" :aria-label="$t('agentSettings.title')">
        <header class="agent-settings-header">
          <div>
            <p class="agent-settings-eyebrow">{{ $t('agentSettings.eyebrow') }}</p>
            <h2>{{ $t('agentSettings.title') }}</h2>
            <p>{{ $t('agentSettings.description') }}</p>
          </div>
          <button class="settings-close" type="button" :aria-label="$t('common.close')" @click="$emit('close')">&times;</button>
        </header>

        <div class="agent-settings-body">
          <aside class="agent-settings-list" :aria-label="$t('agentSettings.agentList')">
            <button
              v-for="agent in agents"
              :key="agent.id"
              type="button"
              class="agent-settings-agent"
              :class="{ active: agent.id === selectedAgentId }"
              @click="selectAgent(agent.id)"
            >
              <span class="status-dot" :class="{ online: agent.online }"></span>
              <span class="agent-settings-agent-copy">
                <strong>{{ agent.name || agent.id }}</strong>
                <small>{{ agent.online ? $t('agentSettings.online') : $t('agentSettings.offline') }}</small>
              </span>
              <span v-if="agent.version" class="agent-settings-version">v{{ agent.version }}</span>
            </button>
            <div v-if="agents.length === 0" class="agent-settings-empty">{{ $t('agentSettings.empty') }}</div>
          </aside>

          <main v-if="selectedAgent" class="agent-settings-content">
            <section class="agent-settings-hero">
              <div>
                <span class="agent-settings-kicker">{{ $t('agentSettings.selectedAgent') }}</span>
                <h3>{{ selectedAgent.name || selectedAgent.id }}</h3>
                <code>{{ selectedAgent.id }}</code>
              </div>
              <span class="agent-settings-status" :class="{ online: selectedAgent.online }">
                <span class="status-dot" :class="{ online: selectedAgent.online }"></span>
                {{ selectedAgent.online ? $t('agentSettings.online') : $t('agentSettings.offline') }}
              </span>
            </section>

            <section class="agent-settings-section">
              <div class="agent-settings-section-heading">
                <div>
                  <h4>{{ $t('agentSettings.runtime.title') }}</h4>
                  <p>{{ $t('agentSettings.runtime.description') }}</p>
                </div>
              </div>
              <div class="agent-settings-grid">
                <div class="agent-settings-field">
                  <span>{{ $t('agentSettings.runtime.version') }}</span>
                  <strong>{{ selectedAgent.version ? 'v' + selectedAgent.version : '—' }}</strong>
                  <small v-if="selectedAgent.upgradeAvailable">{{ $t('agentSettings.runtime.updateAvailable', { version: selectedAgent.upgradeAvailable }) }}</small>
                  <small v-else-if="selectedAgent.version">{{ $t('agentSettings.runtime.upToDate') }}</small>
                  <small v-else>{{ $t('agentSettings.runtime.updateUnknown') }}</small>
                </div>
                <div class="agent-settings-field">
                  <span>{{ $t('agentSettings.runtime.workDir') }}</span>
                  <strong :title="selectedAgent.workDir || ''">{{ selectedAgent.workDir || '—' }}</strong>
                </div>
              </div>
              <div class="agent-settings-row">
                <div>
                  <strong>{{ $t('chat.agent.dream') }}</strong>
                  <p>{{ $t('chat.agent.dreamHint') }}</p>
                </div>
                <label class="agent-settings-switch">
                  <input type="checkbox" :checked="selectedAgent.dreamEnabled !== false" :disabled="!selectedAgent.online || dreamState.pending" @change="setDreamEnabled($event.target.checked)">
                  <span aria-hidden="true"></span>
                </label>
              </div>
              <p v-if="dreamState.error" class="error">{{ dreamState.error }}</p>
            </section>

            <section class="agent-settings-section">
              <div class="agent-settings-section-heading">
                <div>
                  <h4>{{ $t('agentSettings.telemetry.title') }}</h4>
                  <p>{{ $t('settings.general.telemetryDesc') }}</p>
                </div>
                <button class="btn-ghost" type="button" :disabled="telemetryLoading || !selectedAgent.online" @click="loadTelemetry">
                  {{ $t('common.refresh') }}
                </button>
              </div>
              <div v-if="telemetryLoading" class="agent-settings-loading"><span class="spinner-mini"></span> {{ $t('common.loading') }}</div>
              <template v-else>
                <div class="agent-settings-row">
                  <div>
                    <strong>{{ $t('settings.general.telemetry') }}</strong>
                    <p>{{ telemetryDraft.enabled !== false ? $t('settings.general.telemetryOn') : $t('settings.general.telemetryOff') }}</p>
                  </div>
                  <label class="agent-settings-switch">
                    <input type="checkbox" v-model="telemetryDraft.enabled" :disabled="telemetrySaving || !selectedAgent.online">
                    <span aria-hidden="true"></span>
                  </label>
                </div>
                <div class="agent-settings-input-grid">
                  <label>
                    <span>{{ $t('settings.general.telemetryRawLimit') }}</span>
                    <input type="number" min="0" max="4194304" step="65536" v-model.number="telemetryDraft.rawExchangeMaxBytes" :disabled="telemetrySaving || !selectedAgent.online">
                  </label>
                  <label>
                    <span>{{ $t('settings.general.telemetryTraceTextLimit') }}</span>
                    <input type="number" min="0" max="4194304" step="65536" v-model.number="telemetryDraft.traceTextMaxBytes" :disabled="telemetrySaving || !selectedAgent.online">
                  </label>
                </div>
                <div class="agent-settings-save-row">
                  <span v-if="telemetryMessage" :class="{ error: telemetryError }">{{ telemetryMessage }}</span>
                  <button class="btn-primary" type="button" :disabled="telemetrySaving || !selectedAgent.online" @click="saveTelemetry">
                    {{ telemetrySaving ? $t('common.saving') : $t('common.save') }}
                  </button>
                </div>
              </template>
            </section>

            <section class="agent-settings-section agent-settings-danger">
              <div class="agent-settings-section-heading">
                <div>
                  <h4>{{ $t('agentSettings.maintenance.title') }}</h4>
                  <p>{{ $t('agentSettings.maintenance.description') }}</p>
                </div>
              </div>
              <div class="agent-settings-actions">
                <button class="btn-secondary" type="button" :disabled="busy || !selectedAgent.online || !selectedAgent.upgradeAvailable" @click="upgradeAgent">
                  {{ upgrading ? $t('chat.agent.upgrading') : $t('chat.agent.upgrade') }}
                </button>
                <button class="agent-settings-danger-button" type="button" :disabled="busy || !selectedAgent.online" @click="restartAgent">
                  {{ restarting ? $t('chat.agent.restarting') : $t('chat.agent.restart') }}
                </button>
              </div>
            </section>
          </main>
          <main v-else class="agent-settings-content agent-settings-empty">{{ $t('agentSettings.empty') }}</main>
        </div>
      </section>
    </div>
  `,
  data() {
    return {
      selectedAgentId: null,
      telemetryDraft: { ...DEFAULT_TELEMETRY },
      telemetryLoading: false,
      telemetrySaving: false,
      telemetryMessage: '',
      telemetryError: false,
      telemetryGeneration: 0,
    };
  },
  computed: {
    store() { return Pinia.useChatStore(); },
    agents() { return this.store.agents || []; },
    selectedAgent() { return this.agents.find(agent => agent.id === this.selectedAgentId) || null; },
    operations() { return this.store.agentOperations?.[this.selectedAgentId] || {}; },
    restarting() { return this.operations.restart?.pending === true; },
    upgrading() { return this.operations.upgrade?.pending === true; },
    dreamState() { return this.store.agentDreamState?.[this.selectedAgentId] || {}; },
    busy() { return this.restarting || this.upgrading; },
  },
  watch: {
    agents: {
      immediate: true,
      deep: true,
      handler(agents) {
        if (!agents.some(agent => agent.id === this.selectedAgentId)) {
          this.selectAgent(agents.find(agent => agent.id === this.initialAgentId)?.id || agents.find(agent => agent.id === this.store.currentAgent)?.id || agents[0]?.id || null);
        }
      },
    },
  },
  methods: {
    selectAgent(agentId) {
      if (this.selectedAgentId === agentId) return;
      this.selectedAgentId = agentId;
      this.telemetryGeneration += 1;
      this.telemetryLoading = false;
      this.telemetrySaving = false;
      this.telemetryDraft = { ...DEFAULT_TELEMETRY };
      this.telemetryMessage = '';
      this.telemetryError = false;
      if (agentId && this.agents.find(agent => agent.id === agentId)?.online) this.loadTelemetry();
    },
    async loadTelemetry() {
      const agentId = this.selectedAgentId;
      if (!agentId) return;
      const generation = ++this.telemetryGeneration;
      this.telemetryLoading = true;
      this.telemetryMessage = '';
      try {
        const settings = await this.store.loadTelemetrySettings(agentId);
        if (generation !== this.telemetryGeneration || agentId !== this.selectedAgentId) return;
        if (settings?.error) throw new Error(settings.error);
        this.telemetryDraft = { ...DEFAULT_TELEMETRY, ...settings };
      } catch (error) {
        if (generation !== this.telemetryGeneration || agentId !== this.selectedAgentId) return;
        this.telemetryError = true;
        this.telemetryMessage = error?.message || this.$t('agentSettings.telemetry.loadFailed');
      } finally {
        if (generation === this.telemetryGeneration && agentId === this.selectedAgentId) this.telemetryLoading = false;
      }
    },
    async saveTelemetry() {
      const agentId = this.selectedAgentId;
      if (!agentId) return;
      const generation = ++this.telemetryGeneration;
      this.telemetrySaving = true;
      this.telemetryMessage = '';
      try {
        const settings = await this.store.updateTelemetrySettings(this.telemetryDraft, agentId);
        if (generation !== this.telemetryGeneration || agentId !== this.selectedAgentId) return;
        if (settings?.error) throw new Error(settings.error);
        this.telemetryDraft = { ...DEFAULT_TELEMETRY, ...settings };
        this.telemetryError = false;
        this.telemetryMessage = this.$t('agentSettings.telemetry.saved');
      } catch (error) {
        if (generation !== this.telemetryGeneration || agentId !== this.selectedAgentId) return;
        this.telemetryError = true;
        this.telemetryMessage = error?.message || this.$t('agentSettings.telemetry.saveFailed');
      } finally {
        if (generation === this.telemetryGeneration && agentId === this.selectedAgentId) this.telemetrySaving = false;
      }
    },
    setDreamEnabled(enabled) {
      if (this.selectedAgentId) this.store.setDreamEnabled(this.selectedAgentId, enabled);
    },
    async restartAgent() {
      const agent = this.selectedAgent;
      if (!agent || !await confirmDialog(this.$t('chat.agent.restartConfirm', { name: agent.name || agent.id }))) return;
      this.store.restartAgent(agent.id);
    },
    async upgradeAgent() {
      const agent = this.selectedAgent;
      if (!agent || !await confirmDialog(this.$t('chat.agent.upgradeConfirm', { name: agent.name || agent.id }))) return;
      this.store.upgradeAgent(agent.id);
    },
  },
};
