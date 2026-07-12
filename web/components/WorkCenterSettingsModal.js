const ACTION_TYPES = ['triage', 'implement', 'test', 'review', 'deliver', 'research', 'write', 'custom'];

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
    modelPolicy: { mode: 'inherit', model: null, effort: null },
    actionInstructions: Object.fromEntries(ACTION_TYPES.map(type => [type, ''])),
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

export function supportsDynamicSettings(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  if (!value.modelPolicy || typeof value.modelPolicy !== 'object' || Array.isArray(value.modelPolicy)) return false;
  if (!value.actionInstructions || typeof value.actionInstructions !== 'object' || Array.isArray(value.actionInstructions)) return false;
  return ACTION_TYPES.every(type => typeof value.actionInstructions[type] === 'string');
}

function dynamicSettingsMatch(actual, expected) {
  if (!supportsDynamicSettings(actual)) return false;
  const instructionsMatch = ACTION_TYPES.every(type => (
    actual.actionInstructions[type].trim() === String(expected.actionInstructions[type] || '').trim()
  ));
  const actualPolicy = actual.modelPolicy;
  const expectedPolicy = expected.modelPolicy || {};
  return instructionsMatch
    && actualPolicy.mode === expectedPolicy.mode
    && (actualPolicy.model || null) === (expectedPolicy.model || null)
    && (actualPolicy.effort || null) === (expectedPolicy.effort || null);
}

export function normalizeSettingsDraft(value, defaultStageInstructions = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? clone(value) : {};
  const workflows = Array.isArray(source.workflows) && source.workflows.length > 0
    ? source.workflows
    : defaultSettingsDraft().workflows;
  const defaultWorkflow = workflows.find(workflow => workflow?.id === source.defaultWorkflowId)
    || workflows[0]
    || null;
  const stages = Array.isArray(defaultWorkflow?.stages) ? defaultWorkflow.stages : [];
  const stageInstructions = Object.fromEntries(stages
    .filter(stage => ACTION_TYPES.includes(stage?.type) && typeof stage.instruction === 'string')
    .map(stage => [stage.type, stage.instruction]));
  const sourceInstructions = source.actionInstructions && typeof source.actionInstructions === 'object'
    && !Array.isArray(source.actionInstructions)
    ? source.actionInstructions
    : {};
  const migratedModelPolicy = stages.find(stage => stage?.type === 'triage')?.modelPolicy
    || stages[0]?.modelPolicy;

  return {
    ...defaultSettingsDraft(),
    ...source,
    modelPolicy: {
      mode: 'inherit',
      model: null,
      effort: null,
      ...(migratedModelPolicy || {}),
      ...(source.modelPolicy || {}),
    },
    actionInstructions: Object.fromEntries(ACTION_TYPES.map(type => [
      type,
      typeof sourceInstructions[type] === 'string'
        ? sourceInstructions[type]
        : (stageInstructions[type] || defaultStageInstructions[type] || ''),
    ])),
    workflows,
  };
}

function isUnsupportedSettingsError(error) {
  const message = error?.message || String(error);
  return /^Unsupported Work Center operation:\s*get_settings$/i.test(message.trim());
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
    defaultStageInstructions() {
      return this.runtime.defaultStageInstructions || {};
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
      this.draft = normalizeSettingsDraft(cached, this.defaultStageInstructions);
      this.draftAgentId = this.agentId;
      this.settingsUnsupported = !supportsDynamicSettings(cached);
      if (this.settingsUnsupported) this.error = this.$t('workCenter.settings.upgradeRequired');
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
      this.error = this.settingsUnsupported && this.draft
        ? this.$t('workCenter.settings.upgradeRequired')
        : '';
      try {
        const data = await this.store.loadWorkCenterSettings(target);
        if (generation !== this.loadGeneration || target !== this.agentId) return;
        this.draft = normalizeSettingsDraft(data.settings, this.defaultStageInstructions);
        this.draftAgentId = target;
        this.conflict = false;
        this.settingsUnsupported = !supportsDynamicSettings(data.settings);
        this.error = this.settingsUnsupported ? this.$t('workCenter.settings.upgradeRequired') : '';
      } catch (error) {
        if (generation !== this.loadGeneration || target !== this.agentId) return;
        if (isUnsupportedSettingsError(error)) {
          this.draft = normalizeSettingsDraft(null, this.defaultStageInstructions);
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
        instruction: this.defaultStageInstructions.custom || '',
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
    defaultInstructionForStage(stage) {
      return this.defaultStageInstructions[stage.type]
        || this.defaultStageInstructions.custom
        || '';
    },
    resetStageInstruction(stage) {
      stage.instruction = this.defaultInstructionForStage(stage);
    },
    setStageType(stage, type) {
      const previousDefault = this.defaultInstructionForStage(stage);
      const shouldReplaceInstruction = !stage.instruction || stage.instruction === previousDefault;
      stage.type = type;
      if (shouldReplaceInstruction) this.resetStageInstruction(stage);
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
        const submitted = clone(this.draft);
        const data = await this.store.saveWorkCenterSettings(submitted, target);
        if (target !== this.agentId || this.draftAgentId !== target) return;
        if (!dynamicSettingsMatch(data.settings, submitted)) {
          this.settingsUnsupported = !supportsDynamicSettings(data.settings);
          this.error = this.$t(this.settingsUnsupported
            ? 'workCenter.settings.upgradeRequired'
            : 'workCenter.settings.saveNotConfirmed');
          return;
        }
        this.draft = normalizeSettingsDraft(data.settings, this.defaultStageInstructions);
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
                    <p>{{ $t('workCenter.settings.aiWorkflowHelp') }}</p>
                  </div>
                </div>
                <article v-for="type in ['triage','implement','test','review','deliver','research','write','custom']" :key="type" class="work-center-policy-stage">
                  <header><strong>{{ $t('workCenter.action.' + type) }}</strong></header>
                  <div class="work-center-stage-instruction">
                    <div class="work-center-stage-instruction-heading">
                      <span>{{ $t('workCenter.settings.instruction') }}</span>
                      <button class="btn-ghost" type="button" @click="draft.actionInstructions[type] = defaultStageInstructions[type] || ''"
                              :disabled="settingsUnsupported || draft.actionInstructions[type] === (defaultStageInstructions[type] || '')">{{ $t('workCenter.settings.instructionReset') }}</button>
                    </div>
                    <textarea v-model="draft.actionInstructions[type]" rows="5" :placeholder="$t('workCenter.settings.instructionHint')" :disabled="settingsUnsupported"></textarea>
                    <small>{{ $t('workCenter.settings.dynamicInstructionHelp') }}</small>
                  </div>
                </article>
              </template>

              <template v-else-if="section === 'models'">
                <div class="work-center-settings-section-heading">
                  <div><h3>{{ $t('workCenter.settings.models') }}</h3><p>{{ $t('workCenter.settings.dynamicModelsHelp') }}</p></div>
                  <button class="btn-secondary" type="button" @click="$emit('open-agent-models')">{{ $t('workCenter.settings.manageProviders') }}</button>
                </div>
                <article class="work-center-model-stage">
                  <strong>{{ $t('workCenter.settings.allActions') }}</strong>
                  <label>{{ $t('workCenter.settings.modelPolicy') }}
                    <select :value="draft.modelPolicy.mode" :disabled="settingsUnsupported" @change="setModelMode({ modelPolicy: draft.modelPolicy }, $event.target.value)">
                      <option value="inherit">{{ $t('workCenter.settings.model.inherit') }}</option>
                      <option value="primary">{{ $t('workCenter.settings.model.primary') }}</option>
                      <option value="fast">{{ $t('workCenter.settings.model.fast') }}</option>
                      <option value="specific">{{ $t('workCenter.settings.model.specific') }}</option>
                    </select>
                  </label>
                  <label v-if="draft.modelPolicy.mode === 'specific'">{{ $t('workCenter.settings.model') }}
                    <select :value="draft.modelPolicy.model" :disabled="settingsUnsupported" @change="setStageModel({ modelPolicy: draft.modelPolicy }, $event.target.value)">
                      <option v-for="model in models" :key="model.ref || model.id" :value="model.ref || model.id">{{ model.provider }} · {{ model.label || model.id }}</option>
                    </select>
                  </label>
                  <label v-if="effortOptionsForStage({ modelPolicy: draft.modelPolicy }).length">{{ $t('workCenter.settings.effort') }}
                    <select v-model="draft.modelPolicy.effort" :disabled="settingsUnsupported">
                      <option :value="null">{{ $t('workCenter.settings.effortDefault') }}</option>
                      <option v-for="effort in effortOptionsForStage({ modelPolicy: draft.modelPolicy })" :key="effort" :value="effort">{{ effort }}</option>
                    </select>
                  </label>
                </article>
              </template>

              <template v-else>
                <div class="work-center-settings-section-heading">
                  <div><h3>{{ $t('workCenter.settings.general') }}</h3><p>{{ $t('workCenter.settings.generalHelp') }}</p></div>
                </div>
                <label class="work-center-settings-field">{{ $t('workCenter.workDir') }}
                  <input v-model="draft.defaultWorkDir" type="text" :placeholder="$t('workCenter.workDirHint')" :disabled="settingsUnsupported">
                </label>
                <label class="work-center-settings-checkbox">
                  <input v-model="draft.startImmediately" type="checkbox" :disabled="settingsUnsupported">
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
