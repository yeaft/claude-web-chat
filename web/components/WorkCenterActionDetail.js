import { renderMarkdown, renderMermaidIn } from '../utils/markdown.js';
import { workCenterRequestKey, workCenterRequestLoopKey } from '../utils/work-center-request-key.js';

export default {
  name: 'WorkCenterActionDetail',
  props: {
    action: { type: Object, default: null },
    selected: { type: Object, default: null },
    messages: { type: Array, default: () => [] },
    messagesNextCursor: { type: [String, Number], default: null },
    messagesLoading: { type: Boolean, default: false },
    messagesError: { type: String, default: '' },
    requests: { type: Array, default: () => [] },
    requestDetails: { type: Object, default: () => ({}) },
    requestDetailsLoading: { type: Object, default: () => ({}) },
    requestDetailsError: { type: Object, default: () => ({}) },
    requestsLoading: { type: Boolean, default: false },
    requestsError: { type: String, default: '' },
    composerText: { type: String, default: '' },
    composerAttachments: { type: Array, default: () => [] },
    uploading: { type: Boolean, default: false },
    sending: { type: Boolean, default: false },
    composerError: { type: String, default: '' },
    attachmentsSupported: { type: Boolean, default: false },
    coordinatorRequestedInput: { type: Boolean, default: false },
    previewingAttachmentId: { type: String, default: null },
    attachmentError: { type: String, default: '' },
  },
  emits: ['back', 'update:composerText', 'load-earlier-messages', 'select-request', 'refresh-requests', 'open-run', 'attachment-input', 'remove-attachment', 'open-attachment', 'send', 'retry'],
  data() {
    return {
      activeView: 'conversation',
      conversationScrollTop: 0,
      expandedRequestKey: null,
      requestSelectionTouched: false,
    };
  },
  computed: {
    executorName() {
      return this.action?.assignedVp?.name || this.action?.assignedVp?.id
        || this.action?.requiredRole || this.tr('workCenter.actionExecutorPending', 'Executor pending');
    },
    canCompose() {
      if (!this.action || ['done', 'cancelled'].includes(this.selected?.status)) return false;
      return ['waiting', 'failed'].includes(this.action.status);
    },
    canRetry() {
      return this.action?.status === 'failed' && !this.uploading && !this.sending;
    },
    composerHint() {
      if (this.coordinatorRequestedInput) {
        return this.tr('workCenter.actionInputCoordinatorHint', 'Your answer goes to the Work Item Coordinator, which may retry or replan the remaining Actions.');
      }
      if (this.action?.status === 'waiting') {
        return this.tr('workCenter.actionInputResumeHint', 'Your input resumes this Action with the additional context.');
      }
      if (this.action?.status === 'failed') {
        return this.tr('workCenter.actionInputRetryHint', 'Send corrected instructions or files to rerun this Action, or retry unchanged.');
      }
      return this.tr('workCenter.actionInputContinueHint', 'Direct intervention for this Action only.');
    },
    canSend() {
      return !this.uploading && !this.sending
        && (!!this.composerText.trim() || this.composerAttachments.length > 0);
    },
    hasMessages() {
      return this.messages.length > 0;
    },
    hasActionBrief() {
      return !!this.action?.brief?.approach || !!this.action?.brief?.expectedOutcome
        || !!this.action?.dependsOnStageIds?.length || !!this.action?.canonicalResult?.summary;
    },
    waitingQuestion() {
      if (this.action?.status !== 'waiting') return '';
      return String(this.action?.canonicalResult?.waitingReason || '').trim();
    },
    composerDescriptionIds() {
      return [this.waitingQuestion ? 'work-center-action-waiting-question' : null,
        'work-center-action-composer-hint'].filter(Boolean).join(' ');
    },
    currentGenerationRequests() {
      const generation = Math.max(1, Number(this.action?.generation) || 1);
      return this.requests.filter(request => Math.max(1, Number(request?.generation) || 1) === generation)
        .slice()
        .sort((left, right) => (Number(right?.attempt) || 0) - (Number(left?.attempt) || 0)
          || (Number(right?.openedAt) || 0) - (Number(left?.openedAt) || 0)
          || String(right?.id || '').localeCompare(String(left?.id || '')));
    },
  },
  watch: {
    'action.id'() {
      this.resetActionView();
    },
    'action.generation'(generation, previousGeneration) {
      const current = Math.max(1, Number(generation) || 1);
      const previous = Math.max(1, Number(previousGeneration) || 1);
      if (current !== previous) this.resetActionView();
    },
    composerText(value) {
      if (value) return;
      this.$nextTick(() => this.resizeComposerInput(this.$refs.composerInput, true));
    },
    messages: {
      deep: true,
      handler() { this.$nextTick(() => renderMermaidIn(this.$el)); },
    },
    requests() {
      if (this.activeView !== 'execution' || this.requestSelectionTouched) return;
      this.$nextTick(() => this.syncLatestRequest());
    },
  },
  mounted() {
    this.$nextTick(() => renderMermaidIn(this.$el));
  },
  methods: {
    tr(key, fallback) {
      const translated = this.$t ? this.$t(key) : key;
      return translated && translated !== key ? translated : fallback;
    },
    statusLabel(status) {
      return this.tr(`workCenter.status.${status}`, String(status || '').replace('_', ' '));
    },
    messageSpeaker(message) {
      if (message?.role === 'user') return this.tr('workCenter.you', 'You');
      return message?.speaker?.name || message?.speaker?.id || this.executorName;
    },
    time(value) {
      if (!value) return '';
      try { return new Date(Number(value)).toLocaleString(); } catch { return ''; }
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
    formatDuration(value) {
      const duration = Math.max(0, Number(value) || 0);
      if (duration < 1000) return `${duration}ms`;
      return `${(duration / 1000).toFixed(duration < 10_000 ? 1 : 0)}s`;
    },
    formatAttachmentSize(value) {
      const size = Math.max(0, Number(value) || 0);
      if (size < 1024) return `${size} B`;
      if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
      return `${(size / 1024 / 1024).toFixed(1)} MB`;
    },
    messageHtml(text) {
      return renderMarkdown(String(text || ''));
    },
    json(value) {
      if (value == null) return '';
      if (typeof value === 'string') return value;
      try { return JSON.stringify(value, null, 2); } catch { return String(value); }
    },
    requestKey(request) {
      return workCenterRequestKey(request);
    },
    requestLoopKey(request, loop) {
      return workCenterRequestLoopKey(request, loop);
    },
    requestDetail(request) {
      const detail = this.requestDetails[this.requestKey(request)] || null;
      return detail?.request || detail;
    },
    resetActionView() {
      this.activeView = 'conversation';
      this.conversationScrollTop = 0;
      this.expandedRequestKey = null;
      this.requestSelectionTouched = false;
      this.$nextTick(() => {
        if (this.$refs.conversationPanel) this.$refs.conversationPanel.scrollTop = 0;
        renderMermaidIn(this.$el);
      });
    },
    tabId(view) {
      return `work-center-action-${view}-tab`;
    },
    panelId(view) {
      return `work-center-action-${view}-panel`;
    },
    onTabKeydown(event, view) {
      const views = ['conversation', 'execution'];
      const index = views.indexOf(view);
      if (index < 0) return;
      let nextIndex;
      if (event.key === 'ArrowRight') nextIndex = (index + 1) % views.length;
      else if (event.key === 'ArrowLeft') nextIndex = (index - 1 + views.length) % views.length;
      else if (event.key === 'Home') nextIndex = 0;
      else if (event.key === 'End') nextIndex = views.length - 1;
      else return;
      event.preventDefault();
      const nextView = views[nextIndex];
      this.setActiveView(nextView);
      this.$nextTick(() => this.$refs[`${nextView}Tab`]?.focus());
    },
    async openRun(run) {
      const actionId = this.action?.id;
      const generation = this.action?.generation;
      const request = await new Promise(resolve => this.$emit('open-run', run, resolve));
      if (!request || this.action?.id !== actionId || this.action?.generation !== generation) return;
      this.activeView = 'execution';
      this.requestSelectionTouched = true;
      this.expandedRequestKey = this.requestKey(request);
      await this.$nextTick();
      this.$refs.requestsPanel?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
    },
    setActiveView(view) {
      if (view === this.activeView) return;
      if (this.activeView === 'conversation') {
        this.conversationScrollTop = this.$refs.conversationPanel?.scrollTop || 0;
      }
      this.activeView = view;
      if (view === 'execution') {
        this.refreshRequests();
        this.$nextTick(() => this.syncLatestRequest());
      }
      this.$nextTick(() => {
        if (view === 'conversation' && this.$refs.conversationPanel) {
          this.$refs.conversationPanel.scrollTop = this.conversationScrollTop;
        }
        renderMermaidIn(this.$el);
      });
    },
    async toggleRequest(request) {
      const key = this.requestKey(request);
      this.requestSelectionTouched = true;
      if (this.expandedRequestKey === key) {
        this.expandedRequestKey = null;
        return;
      }
      this.expandedRequestKey = key;
      if (!this.requestDetail(request)) this.$emit('select-request', request);
    },
    syncLatestRequest() {
      if (this.requestSelectionTouched) return;
      const request = this.currentGenerationRequests[0];
      if (!request) {
        this.expandedRequestKey = null;
        return;
      }
      const key = this.requestKey(request);
      if (this.expandedRequestKey === key) return;
      this.expandedRequestKey = key;
      if (!this.requestDetail(request)) this.$emit('select-request', request);
    },
    toolHasDetail(tool) {
      return tool?.input != null || tool?.output != null;
    },
    resizeComposerInput(input, reset = false) {
      if (!input) return;
      input.style.height = 'auto';
      if (!reset) input.style.height = `${Math.min(input.scrollHeight, 120)}px`;
    },
    onComposerInput(event) {
      this.$emit('update:composerText', event.target.value);
      this.resizeComposerInput(event.target, !event.target.value);
    },
    onComposerKeydown(event) {
      if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
      event.preventDefault();
      if (this.canSend) this.$emit('send');
    },
    refreshRequests() {
      this.$emit('refresh-requests');
    },
  },
  template: `
    <section class="work-center-action-detail-pane" v-if="action">
      <header class="work-center-action-detail-header">
        <div class="work-center-action-header-copy">
          <div class="work-center-action-header-meta">
            <span class="work-center-status" :data-status="action.status"><span aria-hidden="true"></span>{{ statusLabel(action.status) }}</span>
            <span class="work-center-action-executor"><span class="work-center-action-vp-presence" :data-status="action.status" aria-hidden="true"></span>{{ executorName }}</span>
          </div>
          <h2>{{ action.brief?.objective || tr('workCenter.actionDetails', 'Action details') }}</h2>
        </div>
        <button class="work-center-icon-button" type="button" @click="$emit('back')" :title="tr('common.close', 'Close')" :aria-label="tr('common.close', 'Close')">
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M18.3 5.71 12 12l6.3 6.29-1.41 1.42L10.59 13.4l-6.3 6.31-1.42-1.42L9.17 12l-6.3-6.29 1.42-1.42 6.3 6.31 6.3-6.31 1.41 1.42Z"/></svg>
        </button>
      </header>

      <nav class="work-center-action-view-switch" role="tablist" :aria-label="tr('workCenter.actionViews', 'Action views')">
        <button ref="conversationTab" :id="tabId('conversation')" type="button" role="tab"
                :tabindex="activeView === 'conversation' ? 0 : -1"
                :aria-selected="activeView === 'conversation' ? 'true' : 'false'"
                :aria-controls="panelId('conversation')"
                :class="{ active: activeView === 'conversation' }"
                @click="setActiveView('conversation')" @keydown="onTabKeydown($event, 'conversation')">{{ tr('workCenter.actionConversation', 'Conversation') }}</button>
        <button ref="executionTab" :id="tabId('execution')" type="button" role="tab"
                :tabindex="activeView === 'execution' ? 0 : -1"
                :aria-selected="activeView === 'execution' ? 'true' : 'false'"
                :aria-controls="panelId('execution')"
                :class="{ active: activeView === 'execution' }"
                @click="setActiveView('execution')" @keydown="onTabKeydown($event, 'execution')">{{ tr('workCenter.execution', 'Execution') }}</button>
      </nav>

      <div class="work-center-action-detail-scroll" :data-view="activeView">
        <div v-show="activeView === 'conversation'" ref="conversationPanel" :id="panelId('conversation')" class="work-center-action-transcript" role="tabpanel" :aria-labelledby="tabId('conversation')">
          <section v-if="waitingQuestion" id="work-center-action-waiting-question" class="work-center-action-waiting" role="status">
            <strong>{{ tr('workCenter.waitingQuestionTitle', 'Input required') }}</strong>
            <p>{{ waitingQuestion }}</p>
          </section>
          <section v-if="action.failure" class="work-center-action-failure" role="alert">
            <strong>{{ tr('workCenter.actionFailedTitle', 'Why this Action failed') }}</strong>
            <p v-if="action.failure.error">{{ action.failure.error }}</p>
            <p v-if="action.failure.summary && action.failure.summary !== action.failure.error">{{ action.failure.summary }}</p>
            <small v-if="action.failure.failedAt">{{ tr('workCenter.failedAt', 'Failed at') }} · {{ time(action.failure.failedAt) }}</small>
            <small v-if="canCompose">{{ tr('workCenter.actionFailureRecovery', 'Add corrected instructions or files below to rerun this Action. The Execution view shows retained tool evidence.') }}</small>
          </section>
          <details v-if="hasActionBrief" class="work-center-action-brief-disclosure">
            <summary>{{ tr('workCenter.actionBrief', 'Task brief') }}</summary>
            <dl class="work-center-action-context-list">
              <div v-if="action.brief?.approach"><dt>{{ tr('workCenter.actionApproach', 'How to do it') }}</dt><dd>{{ action.brief.approach }}</dd></div>
              <div v-if="action.brief?.expectedOutcome"><dt>{{ tr('workCenter.actionExpectedOutcome', 'Expected result') }}</dt><dd>{{ action.brief.expectedOutcome }}</dd></div>
              <div v-if="action.dependsOnStageIds?.length"><dt>{{ tr('workCenter.dependencies', 'Dependencies') }}</dt><dd>{{ action.dependsOnStageIds.join(', ') }}</dd></div>
              <div v-if="action.canonicalResult?.summary"><dt>{{ tr('workCenter.actionResult', 'Latest result') }}</dt><dd>{{ action.canonicalResult.summary }}</dd></div>
            </dl>
          </details>
          <button v-if="messagesNextCursor != null" class="btn-ghost" type="button" @click="$emit('load-earlier-messages')" :disabled="messagesLoading">
            {{ messagesLoading ? tr('workCenter.loadingEarlierMessages', 'Loading earlier messages…') : tr('workCenter.loadEarlierMessages', 'Load earlier messages') }}
          </button>
          <p v-if="messagesError" class="work-center-error">{{ messagesError }}</p>
          <div class="work-center-action-message-list">
            <article v-for="message in messages" :key="message.id" class="work-center-action-message" :class="'role-' + message.role" :data-status="message.status">
              <header>
                <strong>{{ messageSpeaker(message) }}</strong>
                <small>{{ time(message.updatedAt || message.createdAt) }}</small>
              </header>
              <div v-if="message.text" class="markdown-body" v-html="messageHtml(message.text)"></div>
              <div v-if="message.attachments?.length" class="work-center-attachment-list">
                <button v-for="attachment in message.attachments" :key="attachment.id" type="button"
                        class="work-center-attachment-chip work-center-attachment-preview"
                        :disabled="previewingAttachmentId === attachment.id"
                        :aria-label="$t('workCenter.openAttachmentNamed', { name: attachment.name })"
                        @click="$emit('open-attachment', attachment, $event.currentTarget)">
                  <span>{{ attachment.name }}</span><small>{{ previewingAttachmentId === attachment.id ? tr('workCenter.openingAttachment', 'Opening attachment…') : formatAttachmentSize(attachment.size) }}</small>
                </button>
              </div>
            </article>
          </div>
          <p v-if="attachmentError" class="work-center-error" role="alert">{{ attachmentError }}</p>
          <p v-if="!hasMessages" class="work-center-action-empty">{{ tr('workCenter.noActionMessages', 'No messages yet.') }}</p>
        </div>

        <section v-show="activeView === 'execution'" :id="panelId('execution')" class="work-center-action-execution" role="tabpanel" :aria-labelledby="tabId('execution')">
          <header class="work-center-action-execution-heading">
            <div class="work-center-action-metrics" :aria-label="tr('workCenter.executionSummary', 'Execution summary')">
              <span>{{ $t('workCenter.llmRequestCount', { count: formatCount(action.executionStats?.llmRequestCount) }) }}</span>
              <span>{{ $t('workCenter.loopCount', { count: formatCount(action.executionStats?.loopCount) }) }}</span>
              <span>{{ $t('workCenter.toolCount', { count: formatCount(action.executionStats?.toolCount) }) }}</span>
              <span>{{ $t('workCenter.tokenCount', { count: formatTokens(action.executionStats?.totalTokens) }) }}</span>
            </div>
            <button class="btn-ghost" type="button" @click="refreshRequests">{{ tr('workCenter.refresh', 'Refresh') }}</button>
          </header>
          <section ref="requestsPanel" class="work-center-action-requests">
            <p v-if="requestsError" class="work-center-error">{{ requestsError }}</p>
            <p v-if="requestsLoading && requests.length === 0" class="work-center-action-empty">{{ tr('workCenter.loadingRequests', 'Loading execution records…') }}</p>
            <p v-else-if="requests.length === 0" class="work-center-action-empty">{{ tr('workCenter.noRequestDetails', 'No execution records are available for this Action yet.') }}</p>
            <article v-for="(request, index) in requests" :key="requestKey(request)" class="work-center-request-card" :class="{ expanded: expandedRequestKey === requestKey(request) }">
              <button type="button" class="work-center-request-summary" @click="toggleRequest(request)" :aria-expanded="expandedRequestKey === requestKey(request)">
                <span class="work-center-request-index">{{ requests.length - index }}</span>
                <span class="work-center-request-title"><strong>{{ request.model || tr('workCenter.unknownModel', 'Unknown model') }}</strong><small>{{ request.vp?.name || request.vp?.id || '—' }} · {{ time(request.openedAt) }}</small></span>
                <span class="work-center-request-metrics"><span>{{ request.loopCount }}L</span><span>{{ formatTokens(request.totalTokens) }} tok</span><span>{{ formatDuration(request.totalMs) }}</span></span>
                <span class="work-center-action-chevron" aria-hidden="true"></span>
              </button>
              <div v-if="expandedRequestKey === requestKey(request)" class="work-center-request-detail">
                <p v-if="requestDetailsError[requestKey(request)]" class="work-center-error">{{ requestDetailsError[requestKey(request)] }}</p>
                <p v-else-if="requestDetailsLoading[requestKey(request)]" class="work-center-action-empty">{{ tr('workCenter.loadingRequestDetail', 'Loading tool evidence…') }}</p>
                <p v-else-if="!requestDetail(request)" class="work-center-action-empty">{{ tr('workCenter.requestDetailUnavailable', 'Tool evidence is unavailable. Try again.') }}</p>
                <p v-else-if="requestDetail(request).truncated" class="work-center-action-notice">{{ $t('workCenter.requestDetailTruncated', { summarized: formatCount(requestDetail(request).summarizedLoopCount), omitted: formatCount(requestDetail(request).omittedLoopCount) }) }}</p>
                <p v-else-if="(requestDetail(request).loops || []).length === 0" class="work-center-action-empty">{{ tr('workCenter.noRequestLoops', 'This request has no retained Loop details.') }}</p>
                <article v-for="loop in requestDetail(request)?.loops || []" :key="requestLoopKey(request, loop)" class="work-center-request-loop">
                  <header class="work-center-request-loop-summary">
                    <strong>{{ tr('workCenter.loop', 'Loop') }} {{ loop.loopNumber }}</strong>
                    <span>{{ $t('workCenter.toolCount', { count: loop.tools?.length || 0 }) }} · {{ formatDuration(loop.latencyMs) }}</span>
                  </header>
                  <div class="work-center-request-loop-body">
                    <p v-if="loop.detailTruncated" class="work-center-action-notice">{{ tr('workCenter.loopDetailTruncated', 'Large Loop: showing retained tool diagnostics.') }}</p>
                    <div v-if="loop.tools?.length" class="work-center-request-tools">
                      <template v-for="tool in loop.tools" :key="tool.id || tool.name">
                        <details v-if="toolHasDetail(tool)" class="work-center-request-tool" :data-status="tool.isError ? 'failed' : 'completed'">
                          <summary>
                            <span class="work-center-request-tool-name"><span aria-hidden="true"></span><strong>{{ tool.name }}</strong></span>
                            <span>{{ formatDuration(tool.durationMs) }} · {{ tool.isError ? tr('workCenter.status.failed', 'Failed') : tr('workCenter.status.completed', 'Completed') }}</span>
                          </summary>
                          <div class="work-center-request-tool-detail">
                            <section v-if="tool.input != null"><strong>{{ tr('workCenter.toolParameters', 'Parameters') }}</strong><pre>{{ json(tool.input) }}</pre></section>
                            <section v-if="tool.output != null"><strong>{{ tr('workCenter.toolResult', 'Result') }}</strong><pre>{{ json(tool.output) }}</pre></section>
                          </div>
                        </details>
                        <div v-else class="work-center-request-tool work-center-request-tool-static" :data-status="tool.isError ? 'failed' : 'completed'">
                          <span class="work-center-request-tool-name"><span aria-hidden="true"></span><strong>{{ tool.name }}</strong></span>
                          <span>{{ formatDuration(tool.durationMs) }} · {{ tool.isError ? tr('workCenter.status.failed', 'Failed') : tr('workCenter.status.completed', 'Completed') }}</span>
                        </div>
                      </template>
                    </div>
                    <p v-else class="work-center-request-tool-empty">{{ tr('workCenter.noToolCalls', 'No tool calls in this Loop.') }}</p>
                  </div>
                </article>
              </div>
            </article>
          </section>
        </section>
      </div>

      <footer v-if="canCompose" class="work-center-action-composer">
        <p v-if="composerError" class="work-center-error" role="alert">{{ composerError }}</p>
        <div v-if="composerAttachments.length" class="work-center-attachment-list">
          <span v-for="(attachment, index) in composerAttachments" :key="attachment.fileId" class="work-center-attachment-chip">
            <span>{{ attachment.name }}</span><small>{{ formatAttachmentSize(attachment.size) }}</small>
            <button type="button" @click="$emit('remove-attachment', index)" :aria-label="tr('workCenter.removeAttachment', 'Remove from draft')">×</button>
          </span>
        </div>
        <div class="input-wrapper work-center-action-input-wrapper">
          <label v-if="attachmentsSupported" class="attach-btn work-center-attachment-picker" :title="tr('workCenter.addAttachments', 'Add files')">
            <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M16.5 6v11.5c0 2.21-1.79 4-4 4s-4-1.79-4-4V5c0-1.38 1.12-2.5 2.5-2.5s2.5 1.12 2.5 2.5v10.5c0 .55-.45 1-1 1s-1-.45-1-1V6H10v9.5c0 1.38 1.12 2.5 2.5 2.5s2.5-1.12 2.5-2.5V5c0-2.21-1.79-4-4-4S7 2.79 7 5v12.5c0 3.04 2.46 5.5 5.5 5.5s5.5-2.46 5.5-5.5V6h-1.5z"/></svg>
            <input type="file" multiple :aria-label="tr('workCenter.addAttachments', 'Add files')" accept="image/png,image/jpeg,image/gif,image/webp,application/pdf,text/*,.md,.json,.js,.ts,.css,.html,.py,.yaml,.yml,.xml,.csv" @change="$emit('attachment-input', $event)">
          </label>
          <div class="textarea-wrapper">
            <textarea ref="composerInput" :value="composerText" rows="1" :placeholder="$t('workCenter.actionChatPlaceholder', { name: executorName })" :aria-describedby="composerDescriptionIds" @input="onComposerInput" @keydown="onComposerKeydown"></textarea>
          </div>
          <button class="send-btn" type="button" @click="$emit('send')" :disabled="!canSend" :title="sending ? tr('workCenter.sendingInput', 'Sending…') : (action.status === 'failed' ? tr('workCenter.sendAndRetryAction', 'Send and retry Action') : tr('workCenter.sendInput', 'Send input'))">
            <svg v-if="!sending" viewBox="0 0 24 24" aria-hidden="true"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>
            <span v-else class="work-center-send-spinner" aria-hidden="true"></span>
          </button>
        </div>
        <div class="work-center-action-composer-footer">
          <small id="work-center-action-composer-hint" class="work-center-action-composer-hint"><strong>{{ executorName }}</strong><span aria-hidden="true"> · </span>{{ uploading ? tr('workCenter.attachmentsUploading', 'Uploading…') : composerHint }}</small>
          <button v-if="canRetry" class="btn-secondary" type="button" @click="$emit('retry')">
            {{ tr('workCenter.retryAction', 'Retry Action') }}
          </button>
        </div>
      </footer>
    </section>
    <section v-else class="work-center-action-detail-pane work-center-detail-empty"><strong>{{ tr('workCenter.selectAction', 'Select an Action to inspect its execution') }}</strong></section>
  `,
};
