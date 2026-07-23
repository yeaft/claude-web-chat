import WorkCenterActionDetail from './WorkCenterActionDetail.js';
import WorkCenterSettingsModal from './WorkCenterSettingsModal.js';
import LlmTab from './LlmTab.js';
import folderPickerMixin from './mixins/folder-picker-mixin.js';
import { openImagePreview } from '../utils/imagePreview.js';
import { mergeActionMessages } from '../stores/helpers/work-center.js';
import { workCenterRequestKey } from '../utils/work-center-request-key.js';
import {
  clearOverlayPointerGesture,
  shouldDismissFromOverlayClick,
  trackOverlayPointerDown,
  trackOverlayPointerUp,
} from '../utils/overlay-dismiss.js';

export default {
  name: 'WorkCenterPage',
  components: { WorkCenterActionDetail, WorkCenterSettingsModal, LlmTab },
  mixins: [folderPickerMixin],
  data() {
    return {
      selectedId: null,
      selectedActionId: null,
      narrowPane: 'items',
      actionDetailTab: 'messages',
      actionInputSending: false,
      actionInputError: '',
      actionComposerGeneration: 0,
      workItemMessage: '',
      workItemMessageSending: false,
      workItemMessageError: '',
      workItemComposerGeneration: 0,
      detailLoading: false,
      detailError: '',
      createOpen: false,
      settingsOpen: false,
      saving: false,
      llmConfigOpen: false,
      filter: 'attention',
      search: '',
      actionGuidance: '',
      expandedActions: {},
      actionsExpanded: false,
      workDirTouched: false,
      startTouched: false,
      createAttachments: [],
      guidanceAttachments: [],
      attachmentsUploading: false,
      guidanceAttachmentsUploading: false,
      previewingAttachmentId: null,
      form: {
        title: '',
        goal: '',
        acceptanceCriteriaText: '',
        workItemType: 'auto',
        workDir: '',
        reuseMemory: true,
        start: true,
      },
    };
  },
  computed: {
    store() { return Pinia.useChatStore(); },
    chat() { return this.store; },
    agentId() { return this.store.workCenterAgentId || this.store.currentAgent; },
    agents() { return this.store.agents || []; },
    onlineAgents() {
      return this.agents.filter(agent => agent?.online
        && Array.isArray(agent.capabilities) && agent.capabilities.includes('work_center'));
    },
    watcher() { return this.store.workCenterWatcherByAgent[this.agentId] || null; },
    settings() { return this.store.workCenterSettingsByAgent[this.agentId] || null; },
    runtime() { return this.store.workCenterRuntimeByAgent[this.agentId] || null; },
    workItemTypes() { return Array.isArray(this.runtime?.workItemTypes) ? this.runtime.workItemTypes : []; },
    workItemAttachmentsSupported() { return this.runtime?.workItemAttachments === true; },
    createDefaultWorkDir() {
      return this.settings?.defaultWorkDir || this.runtime?.defaultWorkDir || '';
    },
    createDefaultStart() {
      return this.settings?.startImmediately !== false;
    },
    folderPickerAgentId() {
      return this.agentId || '';
    },
    defaultWorkDir() {
      return this.createDefaultWorkDir;
    },
    items() { return this.store.workCenterItemsByAgent[this.agentId] || []; },
    loading() { return !!this.store.workCenterLoadingByAgent[this.agentId]; },
    loaded() { return !!this.store.workCenterLoadedByAgent[this.agentId]; },
    error() { return this.store.workCenterErrorByAgent[this.agentId] || null; },
    detail() { return this.store.workCenterDetailByAgent[this.agentId] || null; },
    selected() {
      if (this.detail?.id === this.selectedId) return this.detail;
      return this.items.find(item => item.id === this.selectedId) || null;
    },
    selectedAction() {
      const actions = Array.isArray(this.selected?.actions) ? this.selected.actions : [];
      return actions.find(action => action.id === this.selectedActionId) || null;
    },
    actionRequestKey() {
      return this.selected?.id && this.selectedAction?.id
        ? `${this.agentId}:${this.selected.id}:${this.selectedAction.id}`
        : '';
    },
    actionComposerScope() {
      return this.selected?.id && this.selectedAction?.id
        ? `${this.agentId}:${this.selected.id}:${this.selectedAction.id}:${this.actionComposerGeneration}`
        : '';
    },
    workItemComposerScope() {
      return this.selected?.id
        ? `${this.agentId}:${this.selected.id}:${this.workItemComposerGeneration}`
        : '';
    },
    actionMessages() {
      const current = Array.isArray(this.selectedAction?.messages) ? this.selectedAction.messages : [];
      const earlier = this.store.workCenterActionMessages[this.actionRequestKey]?.messages || [];
      return mergeActionMessages(earlier, current, this.selectedAction?.liveMessage);
    },
    actionMessagesNextCursor() {
      const page = this.store.workCenterActionMessages[this.actionRequestKey];
      return page ? page.nextCursor : this.selectedAction?.messageCursor;
    },
    actionMessagesLoading() {
      return !!this.store.workCenterActionMessagesLoading[this.actionRequestKey];
    },
    actionMessagesError() {
      return this.store.workCenterActionMessagesError[this.actionRequestKey] || '';
    },
    actionRequests() {
      return this.store.workCenterActionRequests[this.actionRequestKey] || [];
    },
    actionRequestDetails() {
      if (!this.actionRequestKey) return {};
      return Object.fromEntries(this.actionRequests.map(request => {
        const requestKey = workCenterRequestKey(request);
        return [requestKey,
          this.store.workCenterActionRequestDetails[`${this.actionRequestKey}:${requestKey}`] || null];
      }));
    },
    actionRequestDetailsLoading() {
      if (!this.actionRequestKey) return {};
      return Object.fromEntries(this.actionRequests.map(request => {
        const requestKey = workCenterRequestKey(request);
        return [requestKey,
          !!this.store.workCenterActionRequestDetailsLoading[`${this.actionRequestKey}:${requestKey}`]];
      }));
    },
    actionRequestDetailsError() {
      if (!this.actionRequestKey) return {};
      return Object.fromEntries(this.actionRequests.map(request => {
        const requestKey = workCenterRequestKey(request);
        return [requestKey,
          this.store.workCenterActionRequestDetailsError[`${this.actionRequestKey}:${requestKey}`] || ''];
      }));
    },
    actionRequestsLoading() {
      return !!this.store.workCenterActionRequestsLoading[this.actionRequestKey];
    },
    actionRequestsError() {
      return this.store.workCenterActionRequestsError[this.actionRequestKey] || '';
    },
    visibleItems() {
      const q = this.search.trim().toLowerCase();
      return this.items.filter(item => {
        if (this.filter === 'attention' && !['waiting', 'needs_attention'].includes(item.status)) return false;
        if (this.filter === 'active' && !['draft', 'ready', 'running'].includes(item.status)) return false;
        if (this.filter === 'done' && item.status !== 'done') return false;
        if (!q) return true;
        return String(item.title || '').toLowerCase().includes(q)
          || String(item.goal || '').toLowerCase().includes(q);
      });
    },
    listHeading() {
      if (this.filter === 'attention') return this.tr('workCenter.attentionItems', 'Needs attention');
      if (this.filter === 'active') return this.tr('workCenter.activeItems', 'Active work');
      if (this.filter === 'done') return this.tr('workCenter.completedItems', 'Completed');
      return this.tr('workCenter.allItems', 'All work items');
    },
    emptyState() {
      if (this.search.trim()) {
        return {
          title: this.tr('workCenter.noMatchesTitle', 'No matching work items'),
          body: this.tr('workCenter.noMatchesBody', 'Try a different search or filter.'),
          canCreate: false,
        };
      }
      if (this.filter === 'done') {
        return {
          title: this.tr('workCenter.noCompletedTitle', 'No completed work items'),
          body: this.tr('workCenter.noCompletedBody', 'Completed work items will appear here.'),
          canCreate: false,
        };
      }
      if (this.filter === 'attention') {
        return {
          title: this.tr('workCenter.noAttentionTitle', 'Nothing needs attention'),
          body: this.tr('workCenter.noAttentionBody', 'Work Items waiting for you or needing recovery will appear here.'),
          canCreate: this.items.length === 0,
        };
      }
      if (this.filter === 'active') {
        return {
          title: this.tr('workCenter.noActiveTitle', 'No active work items'),
          body: this.tr('workCenter.noActiveBody', 'Draft, ready, and running Work Items will appear here.'),
          canCreate: true,
        };
      }
      return {
        title: this.tr('workCenter.emptyTitle', 'No work items yet'),
        body: this.tr('workCenter.emptyBody', 'Create a persistent task when work must continue beyond one conversation turn.'),
        canCreate: true,
      };
    },
  },
  watch: {
    agentId: {
      immediate: true,
      handler(id, previousId) {
        this.selectedId = null;
        this.selectedActionId = null;
        this.resetActionComposer?.();
        this.resetWorkItemComposer?.();
        this.narrowPane = 'items';
        if (previousId && id !== previousId) {
          this.closeFolderPicker();
          this.resetCreateExecutionContext(id);
        }
        if (id) {
          this.store.listWorkItems(id).catch(() => {});
          this.store.loadWorkCenterSettings(id).catch(() => {});
        }
      },
    },
    createDefaultWorkDir() {
      this.applyCreateDefaults();
    },
    createDefaultStart() {
      this.applyCreateDefaults();
    },
    detail: {
      deep: true,
      handler(detail) {
        if (!detail || detail.id !== this.selectedId) return;
        const actions = Array.isArray(detail.actions) ? detail.actions : [];
        if (!actions.some(action => action.id === this.selectedActionId)) {
          const nextActionId = detail.currentActionId || actions[0]?.id || null;
          if (nextActionId !== this.selectedActionId) this.resetActionComposer();
          this.selectedActionId = nextActionId;
        }
      },
    },
  },
  mounted() {
    const draft = this.store.workCenterCreateDraft;
    if (!draft) return;
    this.form = {
      title: draft.title || '',
      goal: draft.goal || '',
      acceptanceCriteriaText: '',
      workItemType: 'auto',
      workDir: draft.workDir || '',
      reuseMemory: true,
      start: this.settings?.startImmediately !== false,
    };
    this.createOpen = true;
    this.workDirTouched = !!String(draft.workDir || '').trim();
    this.startTouched = false;
    this.applyCreateDefaults();
  },
  methods: {
    trackOverlayPointerDown,
    trackOverlayPointerUp,
    clearOverlayPointerGesture,

    closeLlmConfigFromOverlay(event) {
      if (shouldDismissFromOverlayClick(event)) this.llmConfigOpen = false;
    },

    tr(key, fallback) {
      const translated = this.$t ? this.$t(key) : key;
      return translated && translated !== key ? translated : fallback;
    },
    agentName(agentId) {
      const agent = this.agents.find(item => item.id === agentId);
      return agent?.name || agentId || this.tr('workCenter.agent', 'Agent');
    },
    statusLabel(status) {
      return this.tr(`workCenter.status.${status}`, String(status || '').replace('_', ' '));
    },
    actionLabel(type) {
      return this.tr(`workCenter.action.${type}`, type || '—');
    },
    itemActionProgress(item) {
      const total = Math.max(0, Number(item?.actionCount) || 0);
      const completed = Math.min(total, Math.max(0, Number(item?.completedActionCount) || 0));
      return this.$t('workCenter.actionProgress', { completed, total });
    },
    time(value) {
      if (!value) return '';
      try { return new Date(Number(value)).toLocaleString(); } catch { return ''; }
    },
    refresh() {
      return this.store.listWorkItems(this.agentId).catch(() => {});
    },
    resetActionComposer() {
      this.actionComposerGeneration += 1;
      this.actionGuidance = '';
      this.actionInputError = '';
      this.guidanceAttachments = [];
      this.guidanceAttachmentsUploading = false;
      this.actionInputSending = false;
    },
    resetWorkItemComposer() {
      this.workItemComposerGeneration += 1;
      this.workItemMessage = '';
      this.workItemMessageError = '';
      this.workItemMessageSending = false;
    },
    openWorkItem(itemId) {
      this.selectedId = itemId;
      this.selectedActionId = null;
      this.narrowPane = 'actions';
      this.resetActionComposer();
      this.resetWorkItemComposer();
      this.expandedActions = {};
      this.actionsExpanded = false;
      this.detailError = '';
      this.detailLoading = false;
    },
    async selectItem(item) {
      this.openWorkItem(item.id);
      this.detailLoading = true;
      try {
        const detail = await this.store.getWorkItem(item.id, this.agentId);
        if (this.selectedId === item.id) {
          this.selectedActionId = detail?.currentActionId || detail?.actions?.[0]?.id || null;
        }
      } catch (error) {
        if (this.selectedId === item.id) this.detailError = error?.message || String(error);
      } finally {
        if (this.selectedId === item.id) this.detailLoading = false;
      }
    },
    selectAction(action) {
      if (this.selectedActionId !== action.id) this.resetActionComposer();
      this.selectedActionId = action.id;
      this.narrowPane = 'action';
      this.loadLatestActionMessages(action);
    },
    loadLatestActionMessages(action = this.selectedAction) {
      if (!this.selected?.id || !action?.id || Array.isArray(action.messages)) return null;
      const key = `${this.agentId}:${this.selected.id}:${action.id}`;
      if (this.store.workCenterActionMessages[key]) return null;
      return this.store.loadWorkItemActionMessages(
        this.selected.id,
        action.id,
        null,
        this.agentId,
      ).catch(() => null);
    },
    showItemsPane() {
      this.narrowPane = 'items';
    },
    showActionsPane() {
      this.narrowPane = 'actions';
    },
    loadEarlierActionMessages() {
      if (!this.selected?.id || !this.selectedAction?.id || this.actionMessagesNextCursor == null) return null;
      return this.store.loadWorkItemActionMessages(
        this.selected.id,
        this.selectedAction.id,
        this.actionMessagesNextCursor,
        this.agentId,
      ).catch(() => null);
    },
    async refreshActionRequests() {
      if (!this.selected?.id || !this.selectedAction?.id) return [];
      return this.store.loadWorkItemActionRequests(
        this.selected.id,
        this.selectedAction.id,
        this.agentId,
      ).catch(() => []);
    },
    loadActionRequest(request) {
      if (!this.selected?.id || !this.selectedAction?.id || !request?.id) return null;
      return this.store.loadWorkItemActionRequest(
        this.selected.id,
        this.selectedAction.id,
        request.runId,
        request.id,
        this.agentId,
      ).catch(() => null);
    },
    actionHasDetail(action) {
      return !!action?.brief || (Array.isArray(action?.messages) && action.messages.length > 0)
        || !!String(action?.response || '').trim() || !!String(action?.failureReason || '').trim();
    },
    actionExpanded(action) {
      return !!this.expandedActions[action?.id];
    },
    toggleAction(action) {
      if (!this.actionHasDetail(action)) return;
      this.expandedActions = {
        ...this.expandedActions,
        [action.id]: !this.expandedActions[action.id],
      };
    },
    actionResponseText(action) {
      return String(action?.response || '').trim();
    },
    actionExecutor(action) {
      return action?.assignedVp?.name || action?.assignedVp?.id
        || action?.requiredRole || action?.assignmentPolicy?.fixedVpId
        || action?.assignmentPolicy?.capability || this.tr('workCenter.assignment.auto', 'Auto');
    },
    actionContentSummary(action) {
      return String(action?.contentSummary || action?.response || action?.brief?.objective || '').trim();
    },
    executionStats(value) {
      return value?.executionStats || {};
    },
    formatCount(value) {
      return new Intl.NumberFormat().format(Math.max(0, Number(value) || 0));
    },
    formatTokens(value) {
      const tokens = Math.max(0, Number(value) || 0);
      if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}m`;
      if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`;
      return String(tokens);
    },
    resetCreateExecutionContext(agentId) {
      const hadUserExecutionInput = this.workDirTouched || this.startTouched;
      const draft = this.store.workCenterCreateDraft;
      if (draft) {
        this.store.workCenterCreateDraft = {
          sourceAgentId: agentId || null,
          title: draft.title || '',
          goal: draft.goal || '',
          workDir: '',
          origin: null,
          linkedSessionIds: [],
        };
      }
      this.form.workDir = '';
      this.form.start = true;
      this.workDirTouched = false;
      this.startTouched = false;
      if (hadUserExecutionInput) this.createOpen = false;
      this.applyCreateDefaults();
    },
    applyCreateDefaults() {
      if (!this.createOpen) return;
      if (!this.workDirTouched && !this.form.workDir.trim()) this.form.workDir = this.createDefaultWorkDir;
      if (!this.startTouched) this.form.start = this.createDefaultStart;
    },
    folderPickerInitialDir() {
      return this.form.workDir.trim() || this.createDefaultWorkDir;
    },
    folderPickerSetWorkDir(path) {
      this.form.workDir = path;
      this.workDirTouched = true;
    },
    onCreateWorkDirInput() {
      this.workDirTouched = true;
    },
    onCreateStartInput() {
      this.startTouched = true;
    },
    async onCreateAttachmentInput(event) {
      if (!this.workItemAttachmentsSupported) {
        event.target.value = '';
        throw new Error(this.tr('workCenter.attachmentsUnsupported', 'The selected Agent does not support Work Item attachments.'));
      }
      const files = Array.from(event.target.files || []);
      event.target.value = '';
      if (files.length === 0) return;
      const remaining = Math.max(0, 10 - this.createAttachments.length);
      const selected = files.slice(0, remaining);
      if (selected.length === 0) return;
      this.attachmentsUploading = true;
      try {
        const formData = new FormData();
        for (const file of selected) formData.append('files', file, file.name || 'attachment');
        const authStore = Pinia.useAuthStore();
        const token = authStore.getActiveToken?.() || authStore.token || null;
        const headers = token ? { Authorization: `Bearer ${token}` } : {};
        const response = await fetch('/api/upload', { method: 'POST', headers, body: formData });
        if (response.status === 401 || response.status === 403) {
          authStore.handleAuthFailure?.(undefined, token);
        }
        if (!response.ok) throw new Error(this.tr('workCenter.attachmentsUploadFailed', 'Attachment upload failed'));
        const result = await response.json();
        this.createAttachments = [
          ...this.createAttachments,
          ...(Array.isArray(result.files) ? result.files : []),
        ].slice(0, 10);
      } finally {
        this.attachmentsUploading = false;
      }
    },
    removeCreateAttachment(index) {
      this.createAttachments = this.createAttachments.filter((_attachment, itemIndex) => itemIndex !== index);
    },
    async onGuidanceAttachmentInput(event) {
      if (!this.workItemAttachmentsSupported) {
        event.target.value = '';
        throw new Error(this.tr('workCenter.attachmentsUnsupported', 'The selected Agent does not support Work Item attachments.'));
      }
      const files = Array.from(event.target.files || []);
      event.target.value = '';
      if (files.length === 0) return;
      const scope = this.actionComposerScope;
      if (!scope) return;
      const existingCount = Array.isArray(this.selected?.attachments) ? this.selected.attachments.length : 0;
      const remaining = Math.max(0, 10 - existingCount - this.guidanceAttachments.length);
      const selected = files.slice(0, remaining);
      if (selected.length === 0) return;
      this.guidanceAttachmentsUploading = true;
      this.actionInputError = '';
      try {
        const formData = new FormData();
        for (const file of selected) formData.append('files', file, file.name || 'attachment');
        const authStore = Pinia.useAuthStore();
        const token = authStore.getActiveToken?.() || authStore.token || null;
        const headers = token ? { Authorization: `Bearer ${token}` } : {};
        const response = await fetch('/api/upload', { method: 'POST', headers, body: formData });
        if (response.status === 401 || response.status === 403) {
          authStore.handleAuthFailure?.(undefined, token);
        }
        if (!response.ok) throw new Error(this.tr('workCenter.attachmentsUploadFailed', 'Attachment upload failed'));
        const result = await response.json();
        if (this.actionComposerScope !== scope) return;
        this.guidanceAttachments = [
          ...this.guidanceAttachments,
          ...(Array.isArray(result.files) ? result.files : []),
        ].slice(0, Math.max(0, 10 - existingCount));
      } catch (error) {
        if (this.actionComposerScope === scope) this.actionInputError = error?.message || String(error);
      } finally {
        if (this.actionComposerScope === scope) this.guidanceAttachmentsUploading = false;
      }
    },
    removeGuidanceAttachment(index) {
      this.guidanceAttachments = this.guidanceAttachments.filter((_attachment, itemIndex) => itemIndex !== index);
    },
    async previewAttachment(attachment) {
      if (!this.selected?.id || !attachment?.id || this.previewingAttachmentId) return;
      const previewWindow = attachment.isImage ? null : window.open('', '_blank');
      if (previewWindow) previewWindow.opener = null;
      this.previewingAttachmentId = attachment.id;
      try {
        const data = await this.store.previewWorkItemAttachment(this.selected.id, attachment.id, this.agentId);
        if (data?.preview && data.attachment?.isImage) openImagePreview(data.preview);
        else if (data?.preview && previewWindow) previewWindow.location.replace(data.preview);
        else previewWindow?.close();
      } catch (error) {
        previewWindow?.close();
        throw error;
      } finally {
        this.previewingAttachmentId = null;
      }
    },
    formatAttachmentSize(value) {
      const size = Math.max(0, Number(value) || 0);
      if (size < 1024) return `${size} B`;
      if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
      return `${(size / 1024 / 1024).toFixed(1)} MB`;
    },
    openCreate() {
      this.createOpen = true;
      this.workDirTouched = false;
      this.startTouched = false;
      this.applyCreateDefaults();
    },
    closeCreate() {
      if (this.saving) return;
      this.closeFolderPicker();
      this.createOpen = false;
      this.store.workCenterCreateDraft = null;
    },
    onLlmConfigSaved() {
      const agentId = this.agentId;
      if (!agentId) return;
      return this.store.refreshWorkCenterRuntime(agentId).catch(() => {});
    },
    async submitCreate() {
      if (!this.form.title.trim() || !this.form.goal.trim() || !this.form.workDir.trim()) return;
      this.saving = true;
      try {
        const draft = this.store.workCenterCreateDraft;
        const draftOwnedByAgent = draft?.sourceAgentId === this.agentId;
        const detail = await this.store.createWorkItem({
          title: this.form.title.trim(),
          goal: this.form.goal.trim(),
          acceptanceCriteria: this.form.acceptanceCriteriaText
            .split('\n').map(value => value.trim()).filter(Boolean),
          workItemType: this.form.workItemType || 'auto',
          workDir: this.form.workDir.trim(),
          origin: draftOwnedByAgent ? (draft.origin || null) : null,
          linkedSessionIds: draftOwnedByAgent ? (draft.linkedSessionIds || []) : [],
          attachments: this.workItemAttachmentsSupported
            ? (this.createAttachments || []).map(attachment => ({
            fileId: attachment.fileId,
            name: attachment.name,
            mimeType: attachment.mimeType,
            size: attachment.size,
          }))
            : [],
          reuseMemory: this.form.reuseMemory,
          start: this.form.start,
        }, this.agentId);
        this.openWorkItem(detail.id);
        this.selectedActionId = detail.currentActionId || detail.actions?.[0]?.id || null;
        this.form = {
          title: '',
          goal: '',
          acceptanceCriteriaText: '',
          workItemType: 'auto',
          workDir: '',
          reuseMemory: true,
          start: this.settings?.startImmediately !== false,
        };
        this.store.workCenterCreateDraft = null;
        this.createAttachments = [];
        this.workDirTouched = false;
        this.startTouched = false;
        this.createOpen = false;
      } finally {
        this.saving = false;
      }
    },
    async startSelected() {
      if (!this.selected) return;
      await this.store.startWorkItem(this.selected.id, this.agentId);
    },
    async sendSelectedWorkItemMessage() {
      if (!this.selected || !this.workItemMessage.trim() || this.workItemMessageSending) return;
      const scope = this.workItemComposerScope;
      const itemId = this.selected.id;
      const revision = this.selected.revision;
      const text = this.workItemMessage.trim();
      this.workItemMessageSending = true;
      this.workItemMessageError = '';
      try {
        await this.store.sendWorkItemMessage(itemId, text, revision, this.agentId);
        if (this.workItemComposerScope === scope && this.workItemMessage.trim() === text) {
          this.workItemMessage = '';
        }
      } catch (error) {
        if (this.workItemComposerScope === scope) this.workItemMessageError = error?.message || String(error);
      } finally {
        if (this.workItemComposerScope === scope) this.workItemMessageSending = false;
      }
    },
    async retrySelectedAction() {
      if (!this.selected || this.selectedAction?.status !== 'failed' || this.actionInputSending) return;
      const scope = this.actionComposerScope;
      this.actionInputSending = true;
      this.actionInputError = '';
      try {
        await this.store.retryWorkItemAction(
          this.selected.id, this.selectedAction.id, this.selected.revision,
          this.selectedAction.generation, this.agentId,
        );
      } catch (error) {
        if (this.actionComposerScope === scope) this.actionInputError = error?.message || String(error);
      } finally {
        if (this.actionComposerScope === scope) this.actionInputSending = false;
      }
    },
    async guideSelectedAction() {
      if (!this.selected || !this.selectedAction
        || (!this.actionGuidance.trim() && this.guidanceAttachments.length === 0)) return;
      if (!['ready', 'running', 'waiting', 'failed'].includes(this.selectedAction.status)) return;
      const scope = this.actionComposerScope;
      const itemId = this.selected.id;
      const actionId = this.selectedAction.id;
      const revision = this.selected.revision;
      const text = this.actionGuidance.trim();
      const attachments = this.guidanceAttachments.map(attachment => ({
        fileId: attachment.fileId,
        name: attachment.name,
        mimeType: attachment.mimeType,
        size: attachment.size,
      }));
      this.actionInputSending = true;
      this.actionInputError = '';
      try {
        const next = await this.store.sendWorkItemActionInput(
          itemId, text, actionId, revision, this.selectedAction.generation, attachments, this.agentId,
        );
        if (this.actionComposerScope !== scope) return;
        this.actionGuidance = '';
        this.guidanceAttachments = [];
        const targetStillExists = next?.actions?.some(action => action?.id === actionId);
        const nextActionId = targetStillExists ? actionId : (next?.currentActionId || this.selectedActionId);
        if (nextActionId !== this.selectedActionId) this.resetActionComposer();
        this.selectedActionId = nextActionId;
      } catch (error) {
        if (this.actionComposerScope === scope) this.actionInputError = error?.message || String(error);
      } finally {
        if (this.actionComposerScope === scope) this.actionInputSending = false;
      }
    },
    async cancelSelected() {
      if (!this.selected) return;
      await this.store.cancelWorkItem(this.selected.id, this.agentId);
    },
  },
  template: `
    <main class="work-center-main" :class="{ 'workbench-maximized': store.workbenchMaximized && store.workbenchExpanded }">
        <div class="work-center-shell">
          <header class="work-center-header">
            <div class="work-center-heading">
              <button class="work-center-sidebar-toggle" type="button" @click="store.toggleSessionSidebar()"
                      :title="tr('chat.sidebar.expand', 'Open sidebar')" :aria-label="tr('chat.sidebar.expand', 'Open sidebar')">
                <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M3 18h18v-2H3v2Zm0-5h18v-2H3v2Zm0-7v2h18V6H3Z"/></svg>
              </button>
              <h1>{{ tr('workCenter.title', 'Work Center') }}</h1>
              <span class="work-center-agent-context">
                <span class="work-center-agent-dot" aria-hidden="true"></span>
                {{ agentName(agentId) }}
              </span>
            </div>
            <div class="work-center-header-actions">
              <button class="work-center-icon-button" type="button" @click="settingsOpen = true"
                      :title="tr('workCenter.settings.title', 'Work Center settings')" :aria-label="tr('workCenter.settings.title', 'Work Center settings')">
                <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M19.43 12.98c.04-.32.07-.65.07-.98s-.03-.66-.08-.98l2.11-1.65a.5.5 0 0 0 .12-.64l-2-3.46a.5.5 0 0 0-.61-.22l-2.49 1a7.2 7.2 0 0 0-1.69-.98L14.5 2.42A.49.49 0 0 0 14 2h-4a.49.49 0 0 0-.49.42L9.13 5.07c-.61.25-1.17.59-1.69.98l-2.49-1a.49.49 0 0 0-.61.22l-2 3.46a.49.49 0 0 0 .12.64l2.11 1.65c-.04.32-.08.66-.08.98s.03.66.08.98l-2.11 1.65a.5.5 0 0 0-.12.64l2 3.46c.12.22.38.31.61.22l2.49-1c.52.4 1.08.73 1.69.98l.38 2.65c.04.24.24.42.49.42h4c.25 0 .46-.18.49-.42l.38-2.65c.61-.25 1.17-.58 1.69-.98l2.49 1c.23.08.49 0 .61-.22l2-3.46a.5.5 0 0 0-.12-.64l-2.11-1.65ZM12 15.5A3.5 3.5 0 1 1 12 8a3.5 3.5 0 0 1 0 7.5Z"/></svg>
              </button>
              <button class="work-center-icon-button" type="button" @click="refresh" :disabled="loading"
                      :title="tr('workCenter.refresh', 'Refresh')" :aria-label="tr('workCenter.refresh', 'Refresh')">
                <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M17.65 6.35A8 8 0 1 0 19.73 14h-2.08A6 6 0 1 1 16.22 7.78L13 11h7V4l-2.35 2.35Z"/></svg>
              </button>
              <button class="btn-primary work-center-header-create" type="button" @click="openCreate" :disabled="onlineAgents.length === 0"
                      :title="tr('workCenter.newWorkItem', 'New work item')" :aria-label="tr('workCenter.newWorkItem', 'New work item')">
                <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2Z"/></svg>
                <span>{{ tr('workCenter.new', 'New') }}</span>
              </button>
            </div>
          </header>

          <div v-if="narrowPane === 'items'" class="work-center-toolbar">
            <div class="work-center-filter" role="group" :aria-label="tr('workCenter.filter', 'Filter')">
              <button type="button" :class="{ active: filter === 'attention' }" @click="filter = 'attention'">{{ tr('workCenter.filterAttention', 'Needs attention') }}</button>
              <button type="button" :class="{ active: filter === 'active' }" @click="filter = 'active'">{{ tr('workCenter.filterActive', 'Active') }}</button>
              <button type="button" :class="{ active: filter === 'all' }" @click="filter = 'all'">{{ tr('workCenter.filterAll', 'All') }}</button>
              <button type="button" :class="{ active: filter === 'done' }" @click="filter = 'done'">{{ tr('workCenter.filterDone', 'Done') }}</button>
            </div>
            <label class="work-center-search">
              <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M9.5 3a6.5 6.5 0 1 0 4.02 11.61L19.91 21 21 19.91l-6.39-6.39A6.5 6.5 0 0 0 9.5 3Zm0 2a4.5 4.5 0 1 1 0 9 4.5 4.5 0 0 1 0-9Z"/></svg>
              <input v-model="search" type="search" :placeholder="tr('workCenter.search', 'Search work items')">
            </label>
            <span v-if="watcher && watcher.enabled" class="work-center-watcher active">
              <span aria-hidden="true"></span>{{ tr('workCenter.watcherActive', 'Watcher active') }}
            </span>
          </div>

          <p v-if="onlineAgents.length === 0" class="work-center-notice">
            {{ tr('workCenter.noAvailableAgents', 'No compatible online Agents') }}
          </p>
          <p v-if="error" class="work-center-error">{{ error }}</p>
          <div class="work-center-body" :class="{ 'is-empty': loaded && !loading && visibleItems.length === 0 }" :data-pane="narrowPane">
            <section class="work-center-list" :aria-busy="loading ? 'true' : 'false'">
              <div v-if="visibleItems.length > 0" class="work-center-list-heading">
                <span>{{ listHeading }}</span>
                <small>{{ visibleItems.length }}</small>
              </div>
              <button v-for="item in visibleItems" :key="item.id" type="button"
                      class="work-center-card" :class="{ active: selectedId === item.id }"
                      :aria-label="item.title || tr('workCenter.workItem', 'Work item')"
                      @click="selectItem(item)">
                <span class="work-center-card-state">
                  <span class="work-center-status" :data-status="item.status"><span aria-hidden="true"></span>{{ statusLabel(item.status) }}</span>
                </span>
                <span class="work-center-card-content">
                  <span class="work-center-card-title">{{ item.title }}</span>
                  <span class="work-center-card-goal">{{ item.goal }}</span>
                  <span v-if="item.currentAction" class="work-center-card-current-action">
                    {{ tr('workCenter.currentAction', 'Current Action') }}: {{ item.currentAction.objective || actionLabel(item.currentAction.type) }}
                  </span>
                </span>
                <span class="work-center-card-progress">{{ itemActionProgress(item) }}</span>
                <span class="work-center-card-updated">{{ time(item.updatedAt) || tr('workCenter.noTimestamp', 'No timestamp') }}</span>
                <span class="work-center-card-chevron" aria-hidden="true">›</span>
              </button>
              <div v-if="loading" class="work-center-loading">{{ tr('workCenter.loading', 'Loading work items…') }}</div>
              <div v-if="loaded && !loading && visibleItems.length === 0" class="work-center-empty-state">
                <h2>{{ emptyState.title }}</h2>
                <p>{{ emptyState.body }}</p>
                <button v-if="emptyState.canCreate" class="btn-ghost work-center-empty-create" type="button" @click="openCreate" :disabled="onlineAgents.length === 0">
                  <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path fill="currentColor" d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2Z"/></svg>
                  {{ tr('workCenter.createFirst', 'Create first work item') }}
                </button>
              </div>
            </section>

            <section class="work-center-detail">
              <template v-if="selected">
                <button class="work-center-pane-back btn-ghost" type="button" @click="showItemsPane">
                  <span aria-hidden="true">‹</span>{{ tr('workCenter.backToWorkItems', 'Work items') }}
                </button>
                <div v-if="detailLoading" class="work-center-detail-notice" aria-live="polite">{{ tr('workCenter.detailLoading', 'Loading full details…') }}</div>
                <div v-else-if="detailError" class="work-center-detail-notice work-center-detail-error" role="alert">
                  <strong>{{ tr('workCenter.detailLoadFailed', 'Could not load full details') }}</strong>
                  <span>{{ detailError }}</span>
                </div>
                <div class="work-center-detail-heading">
                  <div>
                    <span class="work-center-status" :data-status="selected.status"><span aria-hidden="true"></span>{{ statusLabel(selected.status) }}</span>
                    <h2>{{ selected.title }}</h2>
                  </div>
                  <div class="work-center-detail-actions">
                    <button v-if="selected.status === 'draft'" class="btn-primary" type="button" @click="startSelected">{{ tr('workCenter.start', 'Start') }}</button>
                    <button v-if="!['done','cancelled'].includes(selected.status)" class="btn-secondary" type="button" @click="cancelSelected">{{ tr('workCenter.cancel', 'Cancel') }}</button>
                  </div>
                </div>
                <dl class="work-center-detail-meta">
                  <div><dt>{{ tr('workCenter.updated', 'Updated') }}</dt><dd>{{ time(selected.updatedAt) || '—' }}</dd></div>
                  <div v-if="selected.workDir"><dt>{{ tr('workCenter.workDir', 'Working directory') }}</dt><dd>{{ selected.workDir }}</dd></div>
                  <div v-if="selected.workItemType"><dt>{{ tr('workCenter.workItemType', 'Type') }}</dt><dd>{{ selected.workItemType }}</dd></div>
                  <div v-else-if="selected.planningMode === 'ai'"><dt>{{ tr('workCenter.workItemType', 'Type') }}</dt><dd>{{ tr('workCenter.planning', 'Planning') }}</dd></div>
                </dl>
                <div class="work-center-usage-summary work-center-detail-usage">
                  <span>{{ $t('workCenter.llmRequestCount', { count: formatCount(executionStats(selected).llmRequestCount) }) }}</span>
                  <span>{{ $t('workCenter.loopCount', { count: formatCount(executionStats(selected).loopCount) }) }}</span>
                  <span>{{ $t('workCenter.toolCount', { count: formatCount(executionStats(selected).toolCount) }) }}</span>
                  <span :title="$t('workCenter.tokenBreakdown', { input: formatCount(executionStats(selected).inputTokens), output: formatCount(executionStats(selected).outputTokens), cache: formatCount((executionStats(selected).cacheReadTokens || 0) + (executionStats(selected).cacheWriteTokens || 0)) })">{{ $t('workCenter.tokenCount', { count: formatTokens(executionStats(selected).totalTokens) }) }}</span>
                </div>

                <div v-if="selected.failureReason" class="work-center-section work-center-failure" role="alert">
                  <h3>{{ tr('workCenter.failureReason', 'Failure reason') }}</h3>
                  <p>{{ selected.failureReason }}</p>
                </div>

                <div v-if="selected.status === 'waiting' && selected.waitingReason" class="work-center-section work-center-resume">
                  <h3>{{ tr('workCenter.resumeAnswer', 'Answer the waiting question') }}</h3>
                  <p>{{ selected.waitingReason }}</p>
                  <small class="work-center-muted">{{ tr('workCenter.answerInActionDetail', 'Open the current Action and respond in the input below.') }}</small>
                </div>

                <div class="work-center-section">
                  <h3>{{ tr('workCenter.goal', 'Goal') }}</h3>
                  <p>{{ selected.goal }}</p>
                </div>
                <div class="work-center-section work-center-item-messages">
                  <div class="work-center-item-message-heading">
                    <h3>{{ tr('workCenter.workItemMessages', 'Work Item messages') }}</h3>
                    <small>{{ tr('workCenter.workItemMessageScope', 'Applies to every unfinished Action at its next safe boundary.') }}</small>
                  </div>
                  <div v-if="selected.messages?.length" class="work-center-item-message-list">
                    <article v-for="message in selected.messages" :key="message.id">
                      <p>{{ message.text }}</p><small>{{ time(message.createdAt) }}</small>
                    </article>
                  </div>
                  <p v-if="workItemMessageError" class="work-center-error" role="alert">{{ workItemMessageError }}</p>
                  <div class="input-wrapper work-center-item-message-input">
                    <div class="textarea-wrapper">
                      <textarea v-model="workItemMessage" rows="1" :placeholder="tr('workCenter.workItemMessagePlaceholder', 'Add direction for the whole Work Item')" @keydown.enter.exact.prevent="sendSelectedWorkItemMessage"></textarea>
                    </div>
                    <button class="send-btn" type="button" @click="sendSelectedWorkItemMessage" :disabled="workItemMessageSending || !workItemMessage.trim()" :title="tr('workCenter.sendWorkItemMessage', 'Send to Work Item')">
                      <svg v-if="!workItemMessageSending" viewBox="0 0 24 24" aria-hidden="true"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>
                      <span v-else class="work-center-send-spinner" aria-hidden="true"></span>
                    </button>
                  </div>
                </div>
                <div class="work-center-section">
                  <h3>{{ tr('workCenter.acceptanceCriteria', 'Acceptance criteria') }}</h3>
                  <ul v-if="selected.acceptanceCriteria?.length">
                    <li v-for="criterion in selected.acceptanceCriteria" :key="criterion">{{ criterion }}</li>
                  </ul>
                  <p v-else class="work-center-muted">{{ tr('workCenter.noCriteria', 'No criteria provided') }}</p>
                </div>
                <div v-if="selected.attachments?.length" class="work-center-section">
                  <h3>{{ tr('workCenter.attachments', 'Attachments') }}</h3>
                  <div class="work-center-attachment-list">
                    <button v-for="attachment in selected.attachments" :key="attachment.id" type="button"
                            class="work-center-attachment-chip work-center-attachment-preview"
                            @click="previewAttachment(attachment)" :disabled="previewingAttachmentId === attachment.id"
                            :title="tr('workCenter.previewAttachment', 'Preview attachment')">
                      <span>{{ attachment.name }}</span>
                      <small>{{ formatAttachmentSize(attachment.size) }}</small>
                    </button>
                  </div>
                </div>
                <div class="work-center-section work-center-workflow" v-if="selected.actions?.length">
                  <div v-if="selected.mainline?.progress" class="work-center-mainline-progress" :data-attention="selected.mainline.progress.attentionState">
                    <strong>{{ tr('workCenter.currentProgress', 'Current progress') }}</strong>
                    <span>{{ statusLabel(selected.mainline.progress.lifecycle) }}</span>
                    <span>{{ selected.mainline.progress.counts.completed }} {{ tr('workCenter.status.completed', 'Completed') }}</span>
                    <span v-if="selected.mainline.progress.counts.running">{{ selected.mainline.progress.counts.running }} {{ tr('workCenter.status.running', 'Running') }}</span>
                    <span v-if="selected.mainline.progress.counts.ready">{{ selected.mainline.progress.counts.ready }} {{ tr('workCenter.status.ready', 'Ready') }}</span>
                    <span v-if="selected.mainline.progress.counts.waiting">{{ selected.mainline.progress.counts.waiting }} {{ tr('workCenter.status.waiting', 'Waiting') }}</span>
                    <span v-if="selected.mainline.progress.counts.failed">{{ selected.mainline.progress.counts.failed }} {{ tr('workCenter.status.failed', 'Failed') }}</span>
                  </div>
                  <div class="work-center-action-list-heading">
                    <h3>{{ tr('workCenter.workflow', 'Workflow') }}</h3>
                    <span>{{ $t('workCenter.actionCount', { count: selected.actionCount || selected.actions.length }) }}</span>
                    <small>{{ selected.actionSummary }}</small>
                  </div>
                  <div class="work-center-action-list">
                    <article v-for="action in selected.actions" :key="action.id" class="work-center-action-card" :data-status="action.status" :class="{ active: selectedActionId === action.id }">
                      <button class="work-center-action-summary" type="button" @click="selectAction(action)"
                              :aria-current="selectedActionId === action.id ? 'true' : undefined">
                        <span class="work-center-action-index">{{ action.sequence }}</span>
                        <span class="work-center-action-content">
                          <span class="work-center-action-primary">
                            <strong>{{ action.brief?.objective || actionLabel(action.type) }}</strong>
                            <span class="work-center-status" :data-status="action.status"><span aria-hidden="true"></span>{{ statusLabel(action.status) }}</span>
                          </span>
                          <span v-if="action.brief?.approach || action.canonicalResult?.summary" class="work-center-action-description">
                            {{ action.canonicalResult?.summary || action.brief?.approach }}
                          </span>
                          <span class="work-center-action-secondary">
                            <small class="work-center-action-vp">{{ actionExecutor(action) }}</small>
                            <span v-if="actionContentSummary(action)" class="work-center-action-content-summary" :title="actionContentSummary(action)">{{ actionContentSummary(action) }}</span>
                          </span>
                        </span>
                        <span class="work-center-action-chevron" aria-hidden="true"></span>
                      </button>

                    </article>
                  </div>
                </div>
              </template>
              <div v-else class="work-center-detail-empty">
                <strong>{{ tr('workCenter.selectTitle', 'Work item details') }}</strong>
              </div>
            </section>

            <WorkCenterActionDetail
              :action="selectedAction"
              :selected="selected"
              :messages="actionMessages"
              :messages-next-cursor="actionMessagesNextCursor"
              :messages-loading="actionMessagesLoading"
              :messages-error="actionMessagesError"
              :requests="actionRequests"
              :request-details="actionRequestDetails"
              :request-details-loading="actionRequestDetailsLoading"
              :request-details-error="actionRequestDetailsError"
              :requests-loading="actionRequestsLoading"
              :requests-error="actionRequestsError"
              :composer-text="actionGuidance"
              :composer-attachments="guidanceAttachments"
              :uploading="guidanceAttachmentsUploading"
              :sending="actionInputSending"
              :composer-error="actionInputError"
              :attachments-supported="workItemAttachmentsSupported"
              @back="showActionsPane"
              @update:composer-text="actionGuidance = $event"
              @load-earlier-messages="loadEarlierActionMessages"
              @refresh-requests="refreshActionRequests"
              @select-request="loadActionRequest"
              @attachment-input="onGuidanceAttachmentInput"
              @remove-attachment="removeGuidanceAttachment"
              @send="guideSelectedAction"
              @retry="retrySelectedAction"
            />
          </div>
        </div>
    </main>

      <WorkCenterSettingsModal v-if="settingsOpen" :key="agentId" :agent-id="agentId" @close="settingsOpen = false" @saved="refresh" @open-agent-models="settingsOpen = false; llmConfigOpen = true" />
      <div
        v-if="llmConfigOpen"
        class="modal-overlay yeaft-llm-config-overlay"
        @pointerdown="trackOverlayPointerDown"
        @pointerup="trackOverlayPointerUp"
        @pointercancel="clearOverlayPointerGesture"
        @click="closeLlmConfigFromOverlay"
      >
        <div class="modal-card yeaft-llm-config-modal" role="dialog" aria-modal="true" :aria-label="$t('settings.llm.configureAgent')">
          <div class="modal-header">
            <h3>{{ $t('settings.llm.configureAgent') }}</h3>
            <button class="modal-close" type="button" @click="llmConfigOpen = false" :aria-label="$t('common.close')">×</button>
          </div>
          <div class="yeaft-llm-config-body">
            <LlmTab context="yeaft" @saved="onLlmConfigSaved" />
          </div>
        </div>
      </div>

      <div v-if="createOpen" class="modal-overlay work-center-modal-overlay" @click.self="closeCreate">
        <form class="modal-card work-center-modal" role="dialog" aria-modal="true" aria-labelledby="work-center-create-title" @submit.prevent="submitCreate">
          <header class="work-center-modal-header">
            <div>
              <h2 id="work-center-create-title">{{ tr('workCenter.newWorkItem', 'New work item') }}</h2>
              <p>{{ tr('workCenter.createHint', 'Define a stable goal before the Agent starts execution.') }}</p>
            </div>
            <button class="modal-close" type="button" @click="closeCreate" :disabled="saving" :aria-label="tr('common.close', 'Close')">×</button>
          </header>
          <div class="work-center-modal-body">
            <section class="work-center-form-section">
              <label>{{ tr('workCenter.titleField', 'Title') }}<input v-model="form.title" type="text" required autofocus :placeholder="tr('workCenter.titleHint', 'A short, specific outcome')"></label>
              <label>{{ tr('workCenter.goal', 'Goal') }}<textarea v-model="form.goal" rows="3" required :placeholder="tr('workCenter.goalHint', 'Describe the result the Agent must deliver')"></textarea></label>
              <label>{{ tr('workCenter.acceptanceCriteria', 'Acceptance criteria') }}<textarea v-model="form.acceptanceCriteriaText" rows="3" :placeholder="tr('workCenter.criteriaHint', 'One criterion per line')"></textarea></label>
              <label>{{ tr('workCenter.workItemType', 'Type') }}
                <select v-model="form.workItemType">
                  <option value="auto">{{ tr('workCenter.typeAuto', 'Auto — let the LLM infer') }}</option>
                  <option v-for="type in workItemTypes" :key="type.id" :value="type.id">{{ type.name }}</option>
                </select>
                <small class="work-center-field-help">{{ tr('workCenter.typeHelp', 'Choose a task category, or use Auto for AI inference. AI still plans the concrete Actions.') }}</small>
              </label>
            </section>
            <section class="work-center-form-section work-center-create-attachments">
              <div class="work-center-form-section-heading">
                <h3>{{ tr('workCenter.attachments', 'Attachments') }}</h3>
                <p>{{ tr('workCenter.attachmentsHelp', 'Screenshots and files stay bound to this Work Item and are available to every Action.') }}</p>
              </div>
              <label v-if="workItemAttachmentsSupported" class="btn-secondary work-center-attachment-picker">
                <input type="file" multiple accept="image/png,image/jpeg,image/gif,image/webp,text/*,application/pdf,application/json,application/xml,.pdf,.json,.md,.py,.js,.ts,.css,.html,.xml,.yaml,.yml,.csv" @change="onCreateAttachmentInput">
                {{ attachmentsUploading ? tr('workCenter.attachmentsUploading', 'Uploading…') : tr('workCenter.addAttachments', 'Add files') }}
              </label>
              <p v-else class="work-center-muted">{{ tr('workCenter.attachmentsUnsupported', 'The selected Agent does not support Work Item attachments.') }}</p>
              <div v-if="workItemAttachmentsSupported && createAttachments.length" class="work-center-attachment-list">
                <span v-for="(attachment, index) in createAttachments" :key="attachment.fileId" class="work-center-attachment-chip">
                  <span>{{ attachment.name }}</span>
                  <small>{{ formatAttachmentSize(attachment.size) }}</small>
                  <button type="button" @click="removeCreateAttachment(index)" :aria-label="tr('workCenter.removeAttachment', 'Remove attachment')">×</button>
                </span>
              </div>
            </section>
            <section class="work-center-form-section work-center-execution-section">
              <div class="work-center-form-section-heading">
                <h3>{{ tr('workCenter.execution', 'Execution') }}</h3>
                <p>{{ tr('workCenter.executionHint', 'Choose where and how this work item starts.') }}</p>
              </div>
              <label>{{ tr('workCenter.workDir', 'Working directory') }}
                <div class="work-center-workdir-picker">
                  <input v-model="form.workDir" type="text" required @input="onCreateWorkDirInput" :placeholder="tr('workCenter.workDirHint', 'Choose an existing project directory')">
                  <button class="btn-secondary" type="button" @click="openFolderPicker" :disabled="!folderPickerAgentId">
                    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M10 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2Z"/></svg>
                    {{ tr('workCenter.chooseFolder', 'Choose folder') }}
                  </button>
                </div>
                <small class="work-center-field-help">{{ tr('workCenter.workDirPickerHelp', 'Select an existing folder on the chosen Agent.') }}</small>
              </label>
              <div class="work-center-create-options">
                <label class="work-center-checkbox"><input v-model="form.reuseMemory" type="checkbox"><span><strong>{{ tr('workCenter.reuseMemory', 'Use relevant Agent memory and completed work from this project') }}</strong><small>{{ tr('workCenter.reuseMemoryHelp', 'Uses scope-bounded Agent memory and structured results from completed WorkItems in the same project.') }}</small></span></label>
                <label class="work-center-checkbox"><input v-model="form.start" type="checkbox" @change="onCreateStartInput"><span><strong>{{ tr('workCenter.startImmediately', 'Start immediately') }}</strong><small>{{ tr('workCenter.startImmediatelyHint', 'Turn this off to create a draft you can review first.') }}</small></span></label>
              </div>
            </section>
            <section class="work-center-plan-preview">
              <div class="work-center-plan-preview-heading">
                <div><strong>{{ tr('workCenter.aiPlan', 'AI-planned execution') }}</strong><small>{{ tr('workCenter.aiPlanHelp', 'Triage will choose the task type, Actions, executors, and the smallest reliable flow. Work Center settings control the model and effort.') }}</small></div>
                <button type="button" class="btn-secondary" @click="settingsOpen = true">{{ tr('workCenter.settings.title', 'Settings') }}</button>
              </div>
            </section>
          </div>
          <footer class="work-center-modal-footer">
            <button class="btn-secondary" type="button" @click="closeCreate">{{ tr('common.cancel', 'Cancel') }}</button>
            <button class="btn-primary" type="submit" :disabled="saving || attachmentsUploading || !form.title.trim() || !form.goal.trim() || !form.workDir.trim()">
              {{ saving ? tr('workCenter.creating', 'Creating…') : tr('workCenter.create', 'Create') }}
            </button>
          </footer>

          <div class="work-center-directory-overlay" v-if="folderPickerOpen" @click.self="closeFolderPicker">
            <div class="work-center-directory-dialog" role="dialog" aria-modal="true" aria-labelledby="work-center-directory-title">
              <header class="work-center-directory-header">
                <div>
                  <h3 id="work-center-directory-title">{{ tr('modal.folderPicker.title', 'Select work directory') }}</h3>
                  <p>{{ tr('workCenter.folderPickerHint', 'Choose the project folder this Work Item can read and modify.') }}</p>
                </div>
                <button class="modal-close" type="button" @click="closeFolderPicker" :aria-label="tr('common.close', 'Close')">×</button>
              </header>
              <div class="work-center-directory-path">
                <button class="btn-ghost work-center-directory-up" type="button" @click="folderPickerNavigateUp" :disabled="!folderPickerPath" :aria-label="tr('modal.folderPicker.parentDir', 'Parent directory')">
                  <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2Z"/></svg>
                </button>
                <span class="work-center-directory-current" :title="folderPickerPath">{{ folderPickerPath || tr('common.rootDir', 'Root') }}</span>
              </div>
              <div class="work-center-directory-list" role="listbox" :aria-busy="folderPickerLoading">
                <div class="work-center-directory-state" v-if="folderPickerLoading"><span class="spinner-mini"></span><span>{{ tr('common.loading', 'Loading') }}</span></div>
                <template v-else>
                  <button
                    v-for="entry in folderPickerEntries"
                    :key="entry.name"
                    class="work-center-directory-item"
                    :class="{ selected: folderPickerSelected === entry.name }"
                    type="button"
                    role="option"
                    :aria-selected="folderPickerSelected === entry.name"
                    @click="folderPickerSelectItem(entry)"
                    @dblclick="folderPickerEnter(entry)"
                  >
                    <span class="work-center-directory-icon"><svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M10 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2Z"/></svg></span>
                    <span>{{ entry.name }}</span>
                  </button>
                  <div class="work-center-directory-state" v-if="folderPickerEntries.length === 0">{{ tr('common.noSubdirectories', 'No subdirectories') }}</div>
                </template>
              </div>
              <footer class="work-center-directory-footer">
                <span>{{ tr('workCenter.folderPickerSelectionHint', 'Double-click to open a folder, or select it and confirm.') }}</span>
                <div>
                  <button class="btn-secondary" type="button" @click="closeFolderPicker">{{ tr('common.cancel', 'Cancel') }}</button>
                  <button class="btn-primary" type="button" @click="confirmFolderPicker" :disabled="!folderPickerPath">{{ tr('common.confirm', 'Confirm') }}</button>
                </div>
              </footer>
            </div>
          </div>
        </form>
      </div>
  `,
};
