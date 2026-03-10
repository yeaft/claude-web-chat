/**
 * RolePlayConfigPanel — Role Play creation panel.
 *
 * Simplified version of CrewConfigPanel:
 *   - Agent selection (any online agent, no crew capability required)
 *   - Work directory selection (with folder picker browse button)
 *   - Team template selection (dev / custom)
 *   - Role preview & editing (add/remove/edit claudeMd)
 *   - Language follows user settings (store.locale)
 *   - "Start" button → store.createRolePlaySession
 *
 * Extras (vs CrewConfigPanel):
 *   - Auto-detects .crew directory via check_crew_context WS message
 *   - Imports roles/teamType from .crew/session.json when found
 */

import { getRolePlayTemplate } from '../crew-templates/index.js';

export default {
  name: 'RolePlayConfigPanel',
  template: `
    <div class="crew-config-overlay" @click.self="$emit('close')">
      <div class="crew-config-panel">
        <div class="crew-config-header">
          <h2>{{ $t('roleplay.configTitle') }}</h2>
          <button class="crew-config-close" @click="$emit('close')">&times;</button>
        </div>

        <div class="crew-config-body">
          <!-- Agent -->
          <div class="crew-config-section">
            <label class="crew-config-label">Agent</label>
            <div class="crew-select-wrapper">
              <select class="crew-config-select" v-model="selectedAgent">
                <option value="">{{ $t('crewConfig.selectAgent') }}</option>
                <option v-for="agent in onlineAgents" :key="agent.id" :value="agent.id">
                  {{ agent.name }}{{ agent.latency ? ' (' + agent.latency + 'ms)' : '' }}
                </option>
              </select>
              <svg class="select-arrow" viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M7 10l5 5 5-5z"/></svg>
            </div>
          </div>

          <!-- Work Directory -->
          <div class="crew-config-section" v-if="selectedAgent">
            <label class="crew-config-label">{{ $t('crewConfig.workspace') }}</label>
            <div class="crew-workdir-group">
              <input class="crew-config-input" v-model="projectDir"
                     :placeholder="selectedAgentWorkDir || '/home/user/projects/app'" />
              <button class="workdir-browse-btn" @click="$emit('browse')" :title="$t('modal.newConv.browse')">
                <svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M10 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/></svg>
              </button>
            </div>
          </div>

          <!-- Crew Context Detected -->
          <div class="crew-config-section crew-import-hint" v-if="crewDetected">
            <div class="crew-import-banner">
              <svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/></svg>
              <span>{{ $t('roleplay.crewDetected') }}</span>
            </div>
          </div>

          <!-- Team Template -->
          <div class="crew-config-section" v-if="selectedAgent">
            <label class="crew-config-label">{{ $t('crewConfig.teamTemplate') }}</label>
            <div class="crew-template-btns">
              <button class="crew-template-btn" @click="loadTemplate('dev')" :class="{ active: currentTemplate === 'dev' }">{{ $t('crewConfig.tplDev') }}</button>
              <button class="crew-template-btn" @click="loadTemplate('custom')" :class="{ active: currentTemplate === 'custom' }">{{ $t('crewConfig.tplCustom') }}</button>
            </div>
          </div>

          <!-- Role Configuration -->
          <div class="crew-config-section" v-if="selectedAgent && roles.length > 0">
            <label class="crew-config-label">{{ $t('roleplay.rolePreview') }}</label>
            <div class="crew-roles-list">
              <div v-for="(role, idx) in roles" :key="idx" class="crew-role-item">
                <div class="crew-role-header">
                  <input class="crew-role-icon-input" v-model="role.icon" maxlength="4" />
                  <input class="crew-role-name-input" v-model="role.displayName"
                         :placeholder="$t('crewConfig.roleName')" />
                  <button class="crew-role-remove" @click="removeRole(idx)" :disabled="roles.length <= 1">&times;</button>
                </div>
                <input class="crew-role-desc-input" v-model="role.description"
                       :placeholder="$t('crewConfig.roleDesc')" />
                <details class="crew-role-advanced">
                  <summary>{{ $t('crewConfig.advancedSettings') }}</summary>
                  <textarea class="crew-config-textarea" v-model="role.claudeMd"
                            :placeholder="$t('crewConfig.customPrompt')" rows="3"></textarea>
                </details>
              </div>
            </div>
            <button class="crew-add-role-btn" @click="addCustomRole" v-if="roles.length < 6">
              {{ $t('crewConfig.addRoleBtn') }}
            </button>
          </div>

          <!-- No agent hint -->
          <div class="crew-empty-state" v-if="!selectedAgent">
            <div class="crew-empty-icon">
              <svg viewBox="0 0 24 24" width="40" height="40"><path fill="currentColor" d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z"/></svg>
            </div>
            <div class="crew-empty-text" v-if="onlineAgents.length === 0">{{ $t('roleplay.noAgents') }}</div>
            <div class="crew-empty-text" v-else>{{ $t('crewConfig.selectAgentHint') }}</div>
          </div>
        </div>

        <div class="crew-config-footer" v-if="selectedAgent">
          <button class="modern-btn" @click="$emit('close')">{{ $t('common.cancel') }}</button>
          <button class="modern-btn" @click="startSession" :disabled="!canStart">
            <svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M8 5v14l11-7z"/></svg>
            {{ $t('roleplay.start') }}
          </button>
        </div>
      </div>
    </div>
  `,

  emits: ['close', 'start', 'browse'],

  setup() {
    const store = Pinia.useChatStore();
    return { store };
  },

  data() {
    return {
      selectedAgent: '',
      projectDir: '',
      currentTemplate: 'dev',
      roles: [],
      crewDetected: false,
      _crewCheckRequestId: null,
    };
  },

  computed: {
    onlineAgents() {
      return this.store.agents.filter(a => a.online);
    },
    selectedAgentWorkDir() {
      if (!this.selectedAgent) return '';
      const agent = this.store.agents.find(a => a.id === this.selectedAgent);
      return agent?.workDir || '';
    },
    language() {
      return this.store.locale || 'zh-CN';
    },
    canStart() {
      return this.selectedAgent && this.projectDir.trim() && this.roles.length > 0;
    },
  },

  watch: {
    selectedAgent(newVal) {
      if (newVal && !this.projectDir) {
        this.projectDir = this.selectedAgentWorkDir;
      }
    },
    projectDir(newVal) {
      // Debounce to avoid spamming WS on every keystroke
      clearTimeout(this._crewCheckTimer);
      this._crewCheckTimer = setTimeout(() => this.checkCrewContext(newVal), 400);
    },
    language() {
      // Reload template with new language
      if (this.currentTemplate !== 'custom') {
        this.loadTemplate(this.currentTemplate);
      }
    },
  },

  created() {
    // Load default template
    this.loadTemplate('dev');
    // Auto-select current or first online agent
    if (this.store.currentAgent) {
      const current = this.store.agents.find(a => a.id === this.store.currentAgent);
      if (current?.online) {
        this.selectedAgent = current.id;
      }
    }
    if (!this.selectedAgent && this.onlineAgents.length > 0) {
      this.selectedAgent = this.onlineAgents[0].id;
    }

    // Listen for crew context result
    this._onCrewContextResult = (e) => this.handleCrewContextResult(e.detail);
    window.addEventListener('crew-context-result', this._onCrewContextResult);
  },

  beforeUnmount() {
    if (this._onCrewContextResult) {
      window.removeEventListener('crew-context-result', this._onCrewContextResult);
    }
    clearTimeout(this._crewCheckTimer);
  },

  methods: {
    loadTemplate(type) {
      this.currentTemplate = type;
      if (type === 'custom') {
        this.roles = [];
        return;
      }
      const template = getRolePlayTemplate(type, this.language);
      if (template) {
        this.roles = template.map(r => ({ ...r }));
      }
    },

    removeRole(idx) {
      if (this.roles.length <= 1) return;
      this.roles.splice(idx, 1);
    },

    addCustomRole() {
      const idx = this.roles.length + 1;
      this.roles.push({
        name: 'role' + idx,
        displayName: 'Role ' + idx,
        icon: '🤖',
        description: '',
        claudeMd: '',
      });
    },

    startSession() {
      if (!this.canStart) return;
      const roles = this.roles.map(r => ({
        name: r.name || r.displayName.toLowerCase().replace(/\s+/g, '_'),
        displayName: r.displayName,
        icon: r.icon,
        description: r.description,
        claudeMd: r.claudeMd || '',
      }));
      this.$emit('start', {
        agentId: this.selectedAgent,
        projectDir: this.projectDir.trim(),
        roles,
        teamType: this.currentTemplate === 'custom' ? 'custom' : this.currentTemplate,
        language: this.language,
      });
    },

    checkCrewContext(dir) {
      this.crewDetected = false;
      if (!dir || !dir.trim() || !this.selectedAgent) return;
      const requestId = 'crew_' + Date.now().toString(36);
      this._crewCheckRequestId = requestId;
      this.store.sendWsMessage({
        type: 'check_crew_context',
        agentId: this.selectedAgent,
        projectDir: dir.trim(),
        requestId,
      });
    },

    handleCrewContextResult(msg) {
      if (msg.requestId !== this._crewCheckRequestId) return;
      if (!msg.found) {
        this.crewDetected = false;
        return;
      }
      this.crewDetected = true;

      // Map teamType to template
      const templateMap = { dev: 'dev', writing: 'custom', trading: 'custom', video: 'custom', custom: 'custom' };
      this.currentTemplate = templateMap[msg.teamType] || 'dev';

      // Import roles from .crew context
      if (msg.roles && msg.roles.length > 0) {
        this.roles = msg.roles.map(r => ({
          name: r.name,
          displayName: r.displayName,
          icon: r.icon || '',
          description: r.description || '',
          claudeMd: '',  // claudeMd is loaded server-side, not sent to frontend for size
        }));
      }
    },
  },
};
