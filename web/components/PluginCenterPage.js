export default {
  name: 'PluginCenterPage',
  emits: ['close'],
  data() {
    return {
      saving: false,
      error: '',
      selection: null,
    };
  },
  computed: {
    store() {
      try { return window.Pinia?.useChatStore?.() || null; } catch (_) { return null; }
    },
    agents() {
      return (this.store?.agents || []).filter(agent => agent?.online);
    },
    agentId() {
      return this.store?.pluginCenterAgentId || this.store?.currentAgent || null;
    },
    selectedAgent() {
      return this.agents.find(agent => agent.id === this.agentId) || null;
    },
    configRecord() {
      return this.store?.pluginConfigByAgent?.[this.agentId] || null;
    },
    catalogRecord() {
      const key = this.store?.pluginCatalogKey?.(this.agentId, '');
      return key ? this.store?.pluginCatalogByKey?.[key] || null : null;
    },
    catalog() {
      return this.catalogRecord?.catalog || { tools: [], skills: [], mcpServers: [] };
    },
    loading() {
      return !this.catalogRecord || !!this.catalogRecord.loading;
    },
    hasCatalog() {
      return this.catalog.tools.length + this.catalog.skills.length + this.catalog.mcpServers.length > 0;
    },
    hasExplicitSelection() {
      return !!this.selection && Object.keys(this.selection).length > 0;
    },
    enabledCount() {
      if (!this.hasExplicitSelection) return this.catalog.tools.length + this.catalog.skills.length + this.catalog.mcpServers.length;
      return ['tools', 'skills', 'mcpServers'].reduce((count, field) => (
        count + (Array.isArray(this.selection[field])
          ? this.selection[field].length
          : this.catalog[field].length)
      ), 0);
    },
  },
  watch: {
    agentId: {
      immediate: true,
      handler(next) {
        this.selection = null;
        this.error = '';
        if (!next) return;
        this.store?.loadPluginConfig?.(next).catch(() => {});
        this.store?.loadPluginCatalog?.(next).catch(() => {});
      },
    },
    configRecord: {
      immediate: true,
      deep: true,
      handler(record) {
        if (this.selection || !record?.loaded) return;
        this.selection = this.copySelection(record.plugins);
      },
    },
  },
  methods: {
    copySelection(plugins = {}) {
      const copy = {};
      for (const field of ['tools', 'skills', 'mcpServers']) {
        if (Array.isArray(plugins?.[field])) copy[field] = [...plugins[field]];
      }
      return copy;
    },
    enabled(field, id) {
      if (!this.selection || !Array.isArray(this.selection[field])) return true;
      return this.selection[field].includes(id);
    },
    toggle(field, id, checked) {
      const selection = this.selection || {};
      const current = new Set(Array.isArray(selection[field])
        ? selection[field]
        : this.catalog[field].map(item => item.id));
      if (checked) current.add(id);
      else current.delete(id);
      this.selection = { ...selection, [field]: [...current] };
    },
    useAll() {
      this.selection = {};
      this.error = '';
    },
    async refresh() {
      if (!this.agentId) return;
      this.error = '';
      const result = await this.store?.loadPluginCatalog?.(this.agentId);
      if (result?.error) this.error = result.error;
    },
    async save() {
      if (this.saving || !this.agentId) return;
      this.saving = true;
      this.error = '';
      try {
        const result = await this.store?.savePluginConfig?.(this.selection || {}, this.agentId);
        if (result?.error) this.error = result.error;
        else this.selection = this.copySelection(result?.plugins ?? this.selection ?? {});
      } catch (err) {
        this.error = err?.message || String(err);
      } finally {
        this.saving = false;
      }
    },
    selectAgent(agentId) {
      if (!agentId || agentId === this.agentId) return;
      this.store.pluginCenterAgentId = agentId;
    },
  },
  template: `
    <section class="plugin-center-page" :aria-label="$t('yeaft.plugins.title')">
      <header class="plugin-center-header">
        <div>
          <h1>{{ $t('yeaft.plugins.title') }}</h1>
          <p>{{ $t('yeaft.plugins.subtitle') }}</p>
        </div>
        <div class="plugin-center-header-actions">
          <button type="button" class="btn-ghost" @click="refresh" :disabled="loading" :title="$t('common.refresh')">
            {{ $t('common.refresh') }}
          </button>
          <button type="button" class="btn-ghost" @click="$emit('close')">{{ $t('common.close') }}</button>
        </div>
      </header>

      <div class="plugin-center-body">
        <aside class="plugin-center-agent-list" :aria-label="$t('yeaft.plugins.agentLabel')">
          <span class="plugin-center-side-label">{{ $t('yeaft.plugins.agentLabel') }}</span>
          <button
            v-for="agent in agents"
            :key="agent.id"
            type="button"
            class="plugin-center-agent"
            :class="{ 'is-active': agent.id === agentId }"
            @click="selectAgent(agent.id)"
          >{{ agent.name || agent.id }}</button>
        </aside>

        <main class="plugin-center-content">
          <div class="plugin-center-summary">
            <div>
              <strong>{{ selectedAgent?.name || selectedAgent?.id || $t('yeaft.plugins.noAgent') }}</strong>
              <p>{{ hasExplicitSelection
                ? $t('yeaft.plugins.selectedSummary', { count: enabledCount })
                : $t('yeaft.plugins.allAvailable') }}</p>
            </div>
            <button type="button" class="btn-secondary" @click="useAll" :disabled="!hasExplicitSelection">
              {{ $t('yeaft.plugins.useAll') }}
            </button>
          </div>

          <div v-if="loading" class="plugin-center-state">{{ $t('yeaft.plugins.loading') }}</div>
          <div v-else-if="catalogRecord?.error" class="plugin-center-state is-error">
            {{ $t('yeaft.plugins.loadError', { error: catalogRecord.error }) }}
            <button type="button" class="btn-secondary" @click="refresh">{{ $t('yeaft.plugins.retry') }}</button>
          </div>
          <div v-else-if="!hasCatalog" class="plugin-center-state">{{ $t('yeaft.plugins.empty') }}</div>

          <template v-else>
            <section class="plugin-center-section">
              <h2>{{ $t('yeaft.plugins.tools') }}</h2>
              <label v-for="item in catalog.tools" :key="item.id" class="plugin-center-row">
                <input type="checkbox" :checked="enabled('tools', item.id)" @change="toggle('tools', item.id, $event.target.checked)">
                <span class="plugin-center-copy"><strong>{{ item.label }}</strong></span>
              </label>
            </section>

            <section class="plugin-center-section">
              <h2>{{ $t('yeaft.plugins.skills') }}</h2>
              <label v-for="item in catalog.skills" :key="item.id" class="plugin-center-row">
                <input type="checkbox" :checked="enabled('skills', item.id)" @change="toggle('skills', item.id, $event.target.checked)">
                <span class="plugin-center-copy">
                  <strong>{{ item.label }}</strong>
                  <small v-if="item.description">{{ item.description }}</small>
                </span>
              </label>
            </section>

            <section class="plugin-center-section">
              <h2>{{ $t('yeaft.plugins.mcpServers') }}</h2>
              <label v-for="item in catalog.mcpServers" :key="item.id" class="plugin-center-row">
                <input type="checkbox" :checked="enabled('mcpServers', item.id)" @change="toggle('mcpServers', item.id, $event.target.checked)">
                <span class="plugin-center-copy">
                  <strong>{{ item.label }}</strong>
                  <small>{{ item.toolCount }} {{ $t('yeaft.plugins.toolsCount') }}</small>
                </span>
              </label>
            </section>
          </template>
        </main>
      </div>

      <footer class="plugin-center-footer">
        <span v-if="error" class="plugin-center-error" role="alert">{{ error }}</span>
        <span class="plugin-center-footer-spacer"></span>
        <button type="button" class="btn-primary" @click="save" :disabled="saving || loading || !agentId">
          {{ saving ? $t('common.saving') : $t('common.save') }}
        </button>
      </footer>
    </section>
  `,
};
