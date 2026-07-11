function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function defaultAssignmentPolicy(capability, separateFromStageTypes = []) {
  return {
    mode: 'auto',
    capability,
    candidateVpIds: [],
    fixedVpId: null,
    separateFromStageTypes,
  };
}

function defaultStage(id, name, type, extra = {}) {
  return {
    id,
    name,
    type,
    instruction: '',
    assignmentPolicy: defaultAssignmentPolicy(type, extra.separateFromStageTypes),
    modelPolicy: { mode: 'inherit', model: null, effort: null },
    maxAttempts: 2,
    ...(extra.changesRequestedStageId ? { changesRequestedStageId: extra.changesRequestedStageId } : {}),
  };
}

function defaultSettingsDraft() {
  return {
    version: 1,
    revision: 1,
    defaultWorkflowId: 'software-change',
    startImmediately: true,
    defaultWorkDir: '',
    workflows: [{
      version: 1,
      id: 'software-change',
      name: 'Software change',
      stages: [
        defaultStage('triage', 'Triage', 'triage'),
        defaultStage('implement', 'Implement', 'implement'),
        defaultStage('review', 'Review', 'review', {
          separateFromStageTypes: ['implement'],
          changesRequestedStageId: 'implement',
        }),
        defaultStage('deliver', 'Deliver', 'deliver'),
      ],
    }],
  };
}

function isUnsupportedSettingsError(error) {
  return /Unsupported Work Center operation:\s*get_settings/i.test(error?.message || String(error));
}

export default {
  name: 'WorkCenterSettingsModal',
  emits: ['close', 'saved', 'open-agent-models'],
  props: {
    agentId: { type: String, required: true },
  },
  data() {
    return {
      section: 'workflow',
      draft: null,
      loading: true,
      saving: false,
      error: '',
      conflict: false,
      settingsUnsupported: false,
      draftAgentId: null,
      loadGeneration: 0,
    };
  },
  computed: {
    store() { return Pinia.useChatStore(); },
    runtime() { return this.store.workCenterRuntimeByAgent[this.agentId] || {}; },
    vps() { return Array.isArray(this.runtime.vps) ? this.runtime.vps : []; },
    models() { return Array.isArray(this.runtime.models) ? this.runtime.models : []; },
    workflows() { return Array.isArray(this.draft?.workflows) ? this.draft.workflows : []; },
    defaultWorkflow() {
      return this.workflows.find(workflow => workflow.id === this.draft?.defaultWorkflowId)
        || this.workflows[0]
        || null;
    },
    sections() {
      return [
        { id: 'workflow', label: this.$t('workCenter.settings.workflow') },
        { id: 'models', label: this.$t('workCenter.settings.models') },
        { id: 'general', label: this.$t('workCenter.settings.general') },
      ];
    },
  },
  async mounted() {
    window.addEventListener('keydown', this.onKeydown);
    const cached = this.store.workCenterSettingsByAgent[this.agentId];
    if (cached) {
      this.draft = clone(cached);
      this.draftAgentId = this.agentId;
      this.loading = false;
    }
    await this.load();
  },
  beforeUnmount() {
    window.removeEventListener('keydown', this.onKeydown);
  },
  methods: {
    async load() {
      const target = this.agentId;
      const generation = ++this.loadGeneration;
      this.loading = true;
      this.error = '';
      try {
        const data = await this.store.loadWorkCenterSettings(target);
        if (generation !== this.loadGeneration || target !== this.agentId) return;
        this.draft = clone(data.settings);
        this.draftAgentId = target;
        this.conflict = false;
        this.settingsUnsupported = false;
      } catch (error) {
        if (generation !== this.loadGeneration || target !== this.agentId) return;
        if (isUnsupportedSettingsError(error)) {
          this.draft = defaultSettingsDraft();
          this.draftAgentId = target;
          this.settingsUnsupported = true;
          this.error = this.$t('workCenter.settings.upgradeRequired');
        } else {
          this.error = error?.message || String(error);
        }
      } finally {
        if (generation === this.loadGeneration && target === this.agentId) this.loading = false;
      }
    },
    onKeydown(event) {
      if (event.key === 'Escape' && !this.saving) this.$emit('close');
    },
    close() {
      if (!this.saving) this.$emit('close');
    },
    vpLabel(vp) {
      return (this.$i18n?.locale === 'zh-CN' && vp.nameZh) ? vp.nameZh : (vp.name || vp.id);
    },
    setAssignmentMode(stage, mode) {
      stage.assignmentPolicy.mode = mode;
      if (mode === 'fixed' && !stage.assignmentPolicy.fixedVpId) {
        stage.assignmentPolicy.fixedVpId = this.vps[0]?.id || null;
      }
      if (mode === 'pool' && stage.assignmentPolicy.candidateVpIds.length === 0 && this.vps[0]) {
        stage.assignmentPolicy.candidateVpIds = [this.vps[0].id];
      }
    },
    addWorkflow() {
      const index = this.workflows.length + 1;
      const source = this.defaultWorkflow || this.workflows[0];
      const workflow = source ? clone(source) : { version: 1, stages: [] };
      workflow.id = `workflow-${Date.now()}`;
      workflow.name = this.$t('workCenter.settings.newWorkflow', { index });
      this.draft.workflows.push(workflow);
      this.draft.defaultWorkflowId = workflow.id;
    },
    removeWorkflow() {
      if (this.workflows.length <= 1 || !this.defaultWorkflow) return;
      this.draft.workflows = this.workflows.filter(workflow => workflow.id !== this.defaultWorkflow.id);
      this.draft.defaultWorkflowId = this.draft.workflows[0].id;
    },
    addStage() {
      if (!this.defaultWorkflow) return;
      const stageId = `stage-${Date.now()}`;
      this.defaultWorkflow.stages.push({
        id: stageId,
        name: this.$t('workCenter.settings.newStage'),
        type: 'custom',
        instruction: '',
        assignmentPolicy: { mode: 'auto', capability: 'custom', candidateVpIds: [], fixedVpId: null, separateFromStageTypes: [] },
        modelPolicy: { mode: 'inherit', model: null, effort: null },
        maxAttempts: 2,
      });
    },
    moveStage(index, direction) {
      const stages = this.defaultWorkflow?.stages;
      const target = index + direction;
      if (!stages || target < 0 || target >= stages.length) return;
      const [stage] = stages.splice(index, 1);
      stages.splice(target, 0, stage);
    },
    reviewReturnCandidates(stage) {
      const stages = this.defaultWorkflow?.stages || [];
      const reviewIndex = stages.findIndex(item => item.id === stage.id);
      if (reviewIndex <= 0) return [];
      return stages.slice(0, reviewIndex)
        .filter(candidate => candidate.type !== 'review' && candidate.type !== 'deliver');
    },
    canRemoveStage(index) {
      const stages = this.defaultWorkflow?.stages;
      if (!stages || stages.length <= 1) return false;
      const removed = stages[index];
      const remaining = stages.filter((_, candidateIndex) => candidateIndex !== index);
      return remaining.every((stage, stageIndex) => {
        if (stage.type !== 'review' || stage.changesRequestedStageId !== removed.id) return true;
        return remaining.slice(0, stageIndex)
          .some(candidate => candidate.type !== 'review' && candidate.type !== 'deliver');
      });
    },
    removeStage(index) {
      const stages = this.defaultWorkflow?.stages;
      if (!stages || !this.canRemoveStage(index)) return false;
      const [removed] = stages.splice(index, 1);
      for (const [stageIndex, stage] of stages.entries()) {
        if (stage.type !== 'review' || stage.changesRequestedStageId !== removed.id) continue;
        const candidates = stages.slice(0, stageIndex)
          .filter(candidate => candidate.type !== 'review' && candidate.type !== 'deliver');
        stage.changesRequestedStageId = candidates.at(-1).id;
      }
      return true;
    },
    toggleCandidate(stage, vpId, checked) {
      const current = new Set(stage.assignmentPolicy.candidateVpIds || []);
      if (checked) current.add(vpId);
      else current.delete(vpId);
      stage.assignmentPolicy.candidateVpIds = [...current];
    },
    modelRefForStage(stage) {
      if (stage.modelPolicy.mode === 'specific') return stage.modelPolicy.model;
      if (stage.modelPolicy.mode === 'primary') return this.runtime.primaryModel || null;
      if (stage.modelPolicy.mode === 'fast') return this.runtime.fastModel || null;
      return null;
    },
    effortOptionsForStage(stage) {
      const ref = this.modelRefForStage(stage);
      if (!ref) return [];
      const model = this.models.find(item => (item.ref || item.id) === ref);
      return Array.isArray(model?.effortOptions) ? model.effortOptions : [];
    },
    normalizeStageEffort(stage) {
      const options = this.effortOptionsForStage(stage);
      if (!stage.modelPolicy.effort || options.includes(stage.modelPolicy.effort)) return;
      stage.modelPolicy.effort = null;
    },
    setModelMode(stage, mode) {
      stage.modelPolicy.mode = mode;
      if (mode === 'specific' && !stage.modelPolicy.model) {
        stage.modelPolicy.model = this.models[0]?.ref || this.models[0]?.id || null;
      }
      this.normalizeStageEffort(stage);
    },
    setStageModel(stage, model) {
      stage.modelPolicy.model = model || null;
      this.normalizeStageEffort(stage);
    },
    async save() {
      if (!this.draft || this.saving || this.settingsUnsupported) return;
      const target = this.agentId;
      if (this.draftAgentId !== target) {
        this.conflict = true;
        this.error = this.$t('workCenter.settings.conflict');
        return;
      }
      this.saving = true;
      this.error = '';
      this.conflict = false;
      try {
        const data = await this.store.saveWorkCenterSettings(this.draft, target);
        if (target !== this.agentId || this.draftAgentId !== target) return;
        this.draft = clone(data.settings);
        this.$emit('saved', data.settings);
        this.$emit('close');
      } catch (error) {
        if (target !== this.agentId) return;
        const message = error?.message || String(error);
        this.conflict = /changed elsewhere|reload before saving/i.test(message);
        this.error = this.conflict ? this.$t('workCenter.settings.conflict') : message;
      } finally {
        if (target === this.agentId) this.saving = false;
      }
    },
  },
  template: `
    <Teleport to="body">
      <div class="modal-overlay work-center-settings-overlay" @click.self="close">
        <section class="modal-card work-center-settings-card" role="dialog" aria-modal="true" :aria-label="$t('workCenter.settings.title')">
          <header class="work-center-settings-header">
            <div>
              <h2>{{ $t('workCenter.settings.title') }}</h2>
              <p>{{ $t('workCenter.settings.subtitle') }}</p>
            </div>
            <button class="work-center-settings-close" type="button" @click="close" :aria-label="$t('common.close')">×</button>
          </header>

          <div class="work-center-settings-body">
            <nav class="work-center-settings-nav" :aria-label="$t('workCenter.settings.title')">
              <button v-for="item in sections" :key="item.id" type="button"
                      :class="{ active: section === item.id }" @click="section = item.id">{{ item.label }}</button>
            </nav>

            <main class="work-center-settings-pane">
              <p v-if="loading && !draft" class="work-center-muted">{{ $t('common.loading') }}</p>
              <p v-else-if="!draft" class="work-center-settings-error" role="alert">{{ error }}</p>

              <template v-else-if="section === 'workflow'">
                <div class="work-center-settings-section-heading">
                  <div>
                    <h3>{{ $t('workCenter.settings.workflow') }}</h3>
                    <p>{{ $t('workCenter.settings.workflowHelp') }}</p>
                  </div>
                  <div class="work-center-workflow-actions">
                    <select v-model="draft.defaultWorkflowId">
                      <option v-for="workflow in workflows" :key="workflow.id" :value="workflow.id">{{ workflow.name }}</option>
                    </select>
                    <button class="btn-secondary" type="button" @click="addWorkflow">{{ $t('workCenter.settings.addWorkflow') }}</button>
                    <button class="btn-ghost" type="button" @click="removeWorkflow" :disabled="workflows.length <= 1">{{ $t('workCenter.settings.removeWorkflow') }}</button>
                  </div>
                </div>
                <label class="work-center-settings-field">{{ $t('workCenter.settings.workflowName') }}
                  <input v-model="defaultWorkflow.name" type="text">
                </label>
                <article v-for="(stage, index) in defaultWorkflow?.stages || []" :key="stage.id" class="work-center-policy-stage">
                  <header>
                    <span>{{ index + 1 }}</span>
                    <div><input v-model="stage.name" type="text"><small>{{ stage.id }}</small></div>
                    <div class="work-center-stage-actions">
                      <button type="button" @click="moveStage(index, -1)" :disabled="index === 0" :aria-label="$t('workCenter.settings.moveUp')">↑</button>
                      <button type="button" @click="moveStage(index, 1)" :disabled="index === defaultWorkflow.stages.length - 1" :aria-label="$t('workCenter.settings.moveDown')">↓</button>
                      <button type="button" @click="removeStage(index)" :disabled="!canRemoveStage(index)" :aria-label="$t('workCenter.settings.removeStage')">×</button>
                    </div>
                  </header>
                  <label>{{ $t('workCenter.settings.stageType') }}
                    <select v-model="stage.type">
                      <option v-for="type in ['triage','implement','test','review','deliver','research','write','custom']" :key="type" :value="type">{{ type }}</option>
                    </select>
                  </label>
                  <label>{{ $t('workCenter.settings.assignment') }}
                    <select :value="stage.assignmentPolicy.mode" @change="setAssignmentMode(stage, $event.target.value)">
                      <option value="auto">{{ $t('workCenter.settings.assignment.auto') }}</option>
                      <option value="pool">{{ $t('workCenter.settings.assignment.pool') }}</option>
                      <option value="fixed">{{ $t('workCenter.settings.assignment.fixed') }}</option>
                    </select>
                  </label>
                  <label v-if="stage.assignmentPolicy.mode === 'auto'">{{ $t('workCenter.settings.capability') }}
                    <input v-model="stage.assignmentPolicy.capability" type="text">
                  </label>
                  <label v-if="stage.assignmentPolicy.mode === 'fixed'">{{ $t('workCenter.settings.vp') }}
                    <select v-model="stage.assignmentPolicy.fixedVpId">
                      <option v-for="vp in vps" :key="vp.id" :value="vp.id">{{ vpLabel(vp) }} · {{ vp.role }}</option>
                    </select>
                  </label>
                  <label v-if="stage.type === 'review'">{{ $t('workCenter.settings.reviewReturnStage') }}
                    <select v-model="stage.changesRequestedStageId">
                      <option v-for="candidate in reviewReturnCandidates(stage)" :key="candidate.id" :value="candidate.id">{{ candidate.name }}</option>
                    </select>
                  </label>
                  <label class="work-center-stage-instruction">{{ $t('workCenter.settings.instruction') }}
                    <textarea v-model="stage.instruction" rows="3" :placeholder="$t('workCenter.settings.instructionHint')"></textarea>
                  </label>
                  <fieldset v-if="stage.assignmentPolicy.mode === 'pool'" class="work-center-vp-pool">
                    <legend>{{ $t('workCenter.settings.poolMembers') }}</legend>
                    <label v-for="vp in vps" :key="vp.id">
                      <input type="checkbox" :checked="stage.assignmentPolicy.candidateVpIds.includes(vp.id)"
                             @change="toggleCandidate(stage, vp.id, $event.target.checked)">
                      <span>{{ vpLabel(vp) }}</span><small>{{ vp.role }}</small>
                    </label>
                  </fieldset>
                </article>
                <button class="btn-secondary work-center-add-stage" type="button" @click="addStage">{{ $t('workCenter.settings.addStage') }}</button>
              </template>

              <template v-else-if="section === 'models'">
                <div class="work-center-settings-section-heading">
                  <div><h3>{{ $t('workCenter.settings.models') }}</h3><p>{{ $t('workCenter.settings.modelsHelp') }}</p></div>
                  <button class="btn-secondary" type="button" @click="$emit('open-agent-models')">{{ $t('workCenter.settings.manageProviders') }}</button>
                </div>
                <article v-for="stage in defaultWorkflow?.stages || []" :key="stage.id" class="work-center-model-stage">
                  <strong>{{ stage.name }}</strong>
                  <label>{{ $t('workCenter.settings.modelPolicy') }}
                    <select :value="stage.modelPolicy.mode" @change="setModelMode(stage, $event.target.value)">
                      <option value="inherit">{{ $t('workCenter.settings.model.inherit') }}</option>
                      <option value="primary">{{ $t('workCenter.settings.model.primary') }}</option>
                      <option value="fast">{{ $t('workCenter.settings.model.fast') }}</option>
                      <option value="specific">{{ $t('workCenter.settings.model.specific') }}</option>
                    </select>
                  </label>
                  <label v-if="stage.modelPolicy.mode === 'specific'">{{ $t('workCenter.settings.model') }}
                    <select :value="stage.modelPolicy.model" @change="setStageModel(stage, $event.target.value)">
                      <option v-for="model in models" :key="model.ref || model.id" :value="model.ref || model.id">{{ model.provider }} · {{ model.label || model.id }}</option>
                    </select>
                  </label>
                  <label v-if="effortOptionsForStage(stage).length">{{ $t('workCenter.settings.effort') }}
                    <select v-model="stage.modelPolicy.effort">
                      <option :value="null">{{ $t('workCenter.settings.effortDefault') }}</option>
                      <option v-for="effort in effortOptionsForStage(stage)" :key="effort" :value="effort">{{ effort }}</option>
                    </select>
                  </label>
                </article>
              </template>

              <template v-else>
                <div class="work-center-settings-section-heading">
                  <div><h3>{{ $t('workCenter.settings.general') }}</h3><p>{{ $t('workCenter.settings.generalHelp') }}</p></div>
                </div>
                <label class="work-center-settings-field">{{ $t('workCenter.workDir') }}
                  <input v-model="draft.defaultWorkDir" type="text" :placeholder="$t('workCenter.workDirHint')">
                </label>
                <label class="work-center-settings-checkbox">
                  <input v-model="draft.startImmediately" type="checkbox">
                  <span>{{ $t('workCenter.startImmediately') }}</span>
                </label>
              </template>
            </main>
          </div>

          <p v-if="error && draft" class="work-center-settings-error" role="alert">{{ error }}</p>
          <footer class="work-center-settings-footer">
            <button v-if="conflict" class="btn-secondary" type="button" @click="load" :disabled="saving || loading">{{ $t('workCenter.settings.reload') }}</button>
            <span class="work-center-settings-footer-spacer"></span>
            <button class="btn-secondary" type="button" @click="close">{{ $t('common.cancel') }}</button>
            <button class="btn-primary" type="button" @click="save" :disabled="saving || loading || conflict || settingsUnsupported">{{ saving ? $t('workCenter.settings.saving') : $t('common.save') }}</button>
          </footer>
        </section>
      </div>
    </Teleport>
  `,
};
