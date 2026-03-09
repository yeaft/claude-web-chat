export default {
  name: 'ProxyTab',
  template: `
    <div class="proxy-tab">
      <div class="proxy-header">
        <span class="proxy-title">Port Proxy</span>
      </div>

      <!-- Add port form: agent + host + port in one row -->
      <div class="proxy-add-form">
        <div class="proxy-add-row">
          <div class="proxy-select-wrapper proxy-agent-inline">
            <select v-model="selectedAgent" class="proxy-select">
              <option value="">Agent</option>
              <option v-for="agent in onlineAgents" :key="agent.id" :value="agent.id">
                {{ agent.name }}
              </option>
            </select>
            <svg class="select-arrow" viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M7 10l5 5 5-5z"/></svg>
          </div>
          <div class="proxy-select-wrapper proxy-scheme-inline">
            <select v-model="newScheme" class="proxy-select">
              <option value="http">http</option>
              <option value="https">https</option>
            </select>
            <svg class="select-arrow" viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M7 10l5 5 5-5z"/></svg>
          </div>
          <input
            type="text"
            class="proxy-input proxy-input-host"
            v-model="newHost"
            placeholder="host"
          />
          <span class="proxy-separator">:</span>
          <input
            ref="portInput"
            type="number"
            class="proxy-input proxy-input-port"
            v-model.number="newPort"
            :placeholder="$t('proxy.port')"
            min="1"
            max="65535"
            @keydown.enter="addPort"
          />
          <input
            type="text"
            class="proxy-input proxy-input-label"
            v-model="newLabel"
            :placeholder="$t('proxy.label')"
            @keydown.enter="addPort"
          />
          <button class="proxy-add-btn" @click="addPort" :disabled="!selectedAgent || !newPort" :title="$t('proxy.addPort')">
            <svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>
          </button>
        </div>
      </div>

      <!-- Port list -->
      <div class="proxy-list" v-if="ports.length > 0">
        <div
          class="proxy-port-item"
          v-for="(p, index) in ports"
          :key="p.port"
          :class="{ enabled: p.enabled }"
        >
          <div class="proxy-port-row">
            <label class="proxy-switch" @click="togglePort(index)" :title="p.enabled ? $t('proxy.clickDisable') : $t('proxy.clickEnable')">
              <span class="proxy-switch-track" :class="{ on: p.enabled }">
                <span class="proxy-switch-thumb"></span>
              </span>
            </label>
            <span class="proxy-port-num">{{ p.port }}</span>
            <span class="proxy-port-label" v-if="p.label">{{ p.label }}</span>
            <span class="proxy-port-host">{{ p.scheme === 'https' ? 'https' : 'http' }}://{{ p.host || 'localhost' }}</span>
            <div class="proxy-port-actions">
              <button
                class="proxy-action-btn"
                @click="openInBrowser(p)"
                :disabled="!p.enabled"
                :title="$t('proxy.openInBrowser')"
              >
                <svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M19 19H5V5h7V3H5c-1.11 0-2 .9-2 2v14c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2v-7h-2v7zM14 3v2h3.59l-9.83 9.83 1.41 1.41L19 6.41V10h2V3h-7z"/></svg>
              </button>
              <button class="proxy-action-btn proxy-delete-btn" @click="removePort(index)" :title="$t('common.delete')">
                <svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
              </button>
            </div>
          </div>
          <div class="proxy-port-url" v-if="p.enabled" @click="copyUrl(p)">
            <code>{{ getProxyUrl(p) }}</code>
            <svg class="proxy-copy-icon" viewBox="0 0 24 24" width="12" height="12"><path fill="currentColor" d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/></svg>
          </div>
        </div>
      </div>

      <!-- Empty state -->
      <div class="proxy-empty" v-else-if="selectedAgent">
        <p>{{ $t('proxy.noPorts') }}</p>
        <p class="proxy-hint">{{ $t('proxy.noPortsHint') }}</p>
      </div>

      <!-- No agent selected -->
      <div class="proxy-empty" v-else>
        <p>{{ $t('proxy.selectAgent') }}</p>
      </div>
    </div>
  `,
  setup() {
    const store = Pinia.useChatStore();

    const newPort = Vue.ref(null);
    const newLabel = Vue.ref('');
    const newHost = Vue.ref('localhost');
    const newScheme = Vue.ref('http');
    const portInput = Vue.ref(null);

    // 默认选中当前 agent
    const selectedAgent = Vue.ref(store.currentAgent || '');

    // 当 currentAgent 变化时同步（仅在当前无选择时）
    Vue.watch(() => store.currentAgent, (val) => {
      if (val && !selectedAgent.value) {
        selectedAgent.value = val;
      }
    });

    const onlineAgents = Vue.computed(() => {
      return store.agents.filter(a => a.online);
    });

    const selectedAgentName = Vue.computed(() => {
      if (!selectedAgent.value) return '';
      const agent = store.agents.find(a => a.id === selectedAgent.value);
      return agent?.name || selectedAgent.value;
    });

    const ports = Vue.computed(() => {
      if (!selectedAgent.value) return [];
      return store.proxyPorts[selectedAgent.value] || [];
    });

    const baseUrl = Vue.computed(() => {
      return window.location.origin;
    });

    const getProxyUrl = (p) => {
      return `${baseUrl.value}/agent/${selectedAgentName.value}/${p.port}/`;
    };

    const syncPorts = (updatedPorts) => {
      if (!selectedAgent.value) return;
      store.proxyPorts[selectedAgent.value] = [...updatedPorts];
      store.sendWsMessage({
        type: 'proxy_update_ports',
        agentId: selectedAgent.value,
        ports: updatedPorts
      });
    };

    const addPort = () => {
      if (!newPort.value || newPort.value < 1 || newPort.value > 65535) return;
      const currentPorts = [...(ports.value)];
      if (currentPorts.some(p => p.port === newPort.value)) {
        return;
      }
      currentPorts.push({
        port: newPort.value,
        label: newLabel.value || '',
        host: newHost.value || 'localhost',
        scheme: newScheme.value || 'http',
        enabled: false
      });
      syncPorts(currentPorts);
      newPort.value = null;
      newLabel.value = '';
      Vue.nextTick(() => portInput.value?.focus());
    };

    const removePort = (index) => {
      const currentPorts = [...(ports.value)];
      currentPorts.splice(index, 1);
      syncPorts(currentPorts);
    };

    const togglePort = (index) => {
      const currentPorts = [...(ports.value)];
      currentPorts[index] = { ...currentPorts[index], enabled: !currentPorts[index].enabled };
      syncPorts(currentPorts);
    };

    const openInBrowser = (p) => {
      const url = getProxyUrl(p);
      window.open(url, '_blank');
    };

    const copyUrl = (p) => {
      const url = getProxyUrl(p);
      navigator.clipboard.writeText(url).catch(() => {});
    };

    return {
      store,
      newPort,
      newLabel,
      newHost,
      newScheme,
      portInput,
      selectedAgent,
      onlineAgents,
      selectedAgentName,
      ports,
      baseUrl,
      getProxyUrl,
      addPort,
      removePort,
      togglePort,
      openInBrowser,
      copyUrl
    };
  }
};
