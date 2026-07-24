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
    previewingAttachmentId: { type: String, default: null },
    attachmentError: { type: String, default: '' },
  },
  emits: ['back', 'update:composerText', 'load-earlier-messages', 'select-request', 'refresh-requests', 'open-run', 'attachment-input', 'remove-attachment', 'open-attachment', 'send', 'retry'],
  data() {
    return {
      activeTab: 'messages',
      expandedRequestKey: null,
      expandedLoops: {},
    };
  },
  computed: {
    canCompose() {
      if (!this.action || ['done', 'cancelled'].includes(this.selected?.status)) return false;
      return ['ready', 'running', 'waiting', 'failed'].includes(this.action.status);
    },
    canRetry() {
      return this.action?.status === 'failed' && !this.uploading && !this.sending;
    },
    composerHint() {
      if (this.selected?.status === 'waiting') {
        return this.tr('workCenter.actionInputResumeHint', 'Your input resumes this Action with the additional context.');
      }
      if (this.selected?.status === 'needs_attention') {
        return this.tr('workCenter.actionInputRetryHint', 'Add instructions or files, then rerun this Action with the new context.');
      }
      return this.tr('workCenter.actionInputContinueHint', 'New input joins this Action and is applied at the next safe execution loop.');
    },
    canSend() {
      return !this.uploading && !this.sending
        && (!!this.composerText.trim() || this.composerAttachments.length > 0);
    },
    actionThread() {
      const thread = Array.isArray(this.action?.thread) ? this.action.thread : [];
      if (thread.length === 0) return [{
        generation: Math.max(1, Number(this.action?.generation) || 1),
        canonical: true,
        messages: this.messages,
        runs: [],
      }];
      return thread.map(entry => entry.canonical ? { ...entry, messages: this.messages } : entry);
    },
  },
  watch: {
    'action.id'() {
      this.activeTab = 'messages';
      this.expandedRequestKey = null;
      this.expandedLoops = {};
      this.$nextTick(() => renderMermaidIn(this.$el));
    },
    composerText(value) {
      if (value) return;
      this.$nextTick(() => this.resizeComposerInput(this.$refs.composerInput, true));
    },
    messages: {
      deep: true,
      handler() { this.$nextTick(() => renderMermaidIn(this.$el)); },
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
    async openRun(run) {
      const actionId = this.action?.id;
      const generation = this.action?.generation;
      const request = await new Promise(resolve => this.$emit('open-run', run, resolve));
      if (!request || this.action?.id !== actionId || this.action?.generation !== generation) return;
      this.switchTab('requests');
      this.expandedRequestKey = this.requestKey(request);
    },
    async toggleRequest(request) {
      const key = this.requestKey(request);
      if (this.expandedRequestKey === key) {
        this.expandedRequestKey = null;
        return;
      }
      this.expandedRequestKey = key;
      if (!this.requestDetail(request)) this.$emit('select-request', request);
    },
    toggleLoop(request, loop) {
      const key = this.requestLoopKey(request, loop);
      this.expandedLoops = { ...this.expandedLoops, [key]: !this.expandedLoops[key] };
    },
    loopExpanded(request, loop) {
      return !!this.expandedLoops[this.requestLoopKey(request, loop)];
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
    switchTab(tab) {
      this.activeTab = tab;
      if (tab === 'requests') this.$emit('refresh-requests');
    },
    onTabKeydown(event) {
      const tabs = ['messages', 'requests'];
      const current = tabs.indexOf(this.activeTab);
      let next = current;
      if (['ArrowRight', 'ArrowDown'].includes(event.key)) next = (current + 1) % tabs.length;
      else if (['ArrowLeft', 'ArrowUp'].includes(event.key)) next = (current - 1 + tabs.length) % tabs.length;
      else if (event.key === 'Home') next = 0;
      else if (event.key === 'End') next = tabs.length - 1;
      else return;
      event.preventDefault();
      const tab = tabs[next];
      this.switchTab(tab);
      this.$nextTick(() => this.$refs[`${tab}Tab`]?.focus());
    },
  },
  template: `
    <section class="work-center-action-detail-pane" v-if="action">
      <header class="work-center-action-detail-header">
        <div>
          <span class="work-center-status" :data-status="action.status"><span aria-hidden="true"></span>{{ statusLabel(action.status) }}</span>
          <h2>{{ action.brief?.objective || tr('workCenter.actionDetails', 'Action details') }}</h2>
        </div>
        <button class="work-center-icon-button" type="button" @click="$emit('back')" :title="tr('common.close', 'Close')" :aria-label="tr('common.close', 'Close')">
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M18.3 5.71 12 12l6.3 6.29-1.41 1.42L10.59 13.4l-6.3 6.31-1.42-1.42L9.17 12l-6.3-6.29 1.42-1.42 6.3 6.31 6.3-6.31 1.41 1.42Z"/></svg>
        </button>
      </header>

      <div class="work-center-action-detail-stats">
        <span>{{ $t('workCenter.llmRequestCount', { count: formatCount(action.executionStats?.llmRequestCount) }) }}</span>
        <span>{{ $t('workCenter.loopCount', { count: formatCount(action.executionStats?.loopCount) }) }}</span>
        <span>{{ $t('workCenter.toolCount', { count: formatCount(action.executionStats?.toolCount) }) }}</span>
        <span>{{ $t('workCenter.tokenCount', { count: formatTokens(action.executionStats?.totalTokens) }) }}</span>
      </div>

      <nav class="work-center-action-tabs" role="tablist" :aria-label="tr('workCenter.actionDetails', 'Action details')">
        <button ref="messagesTab" id="work-center-action-messages-tab" type="button" role="tab" aria-controls="work-center-action-messages-panel" :tabindex="activeTab === 'messages' ? 0 : -1" :aria-selected="activeTab === 'messages'" :class="{ active: activeTab === 'messages' }" @click="switchTab('messages')" @keydown="onTabKeydown">
          {{ tr('workCenter.actionMessages', 'Messages') }}
        </button>
        <button ref="requestsTab" id="work-center-action-requests-tab" type="button" role="tab" aria-controls="work-center-action-requests-panel" :tabindex="activeTab === 'requests' ? 0 : -1" :aria-selected="activeTab === 'requests'" :class="{ active: activeTab === 'requests' }" @click="switchTab('requests')" @keydown="onTabKeydown">
          {{ tr('workCenter.requestDetails', 'Request details') }}
          <span v-if="requests.length">{{ requests.length }}</span>
        </button>
      </nav>

      <div class="work-center-action-detail-scroll">
        <div v-if="activeTab === 'messages'" id="work-center-action-messages-panel" role="tabpanel" aria-labelledby="work-center-action-messages-tab" class="work-center-action-transcript">
          <section v-if="action.failure" class="work-center-action-failure" role="alert">
            <strong>{{ tr('workCenter.actionFailedTitle', 'Why this Action failed') }}</strong>
            <p v-if="action.failure.error">{{ action.failure.error }}</p>
            <p v-if="action.failure.summary && action.failure.summary !== action.failure.error">{{ action.failure.summary }}</p>
            <small v-if="action.failure.failedAt">{{ tr('workCenter.failedAt', 'Failed at') }} · {{ time(action.failure.failedAt) }}</small>
            <small v-if="canCompose">{{ tr('workCenter.actionFailureRecovery', 'Add corrected instructions or files below to rerun this Action. Request details contain the exact model and loop trace.') }}</small>
          </section>
          <button v-if="messagesNextCursor != null" class="btn-ghost" type="button" @click="$emit('load-earlier-messages')" :disabled="messagesLoading">
            {{ messagesLoading ? tr('workCenter.loadingEarlierMessages', 'Loading earlier messages…') : tr('workCenter.loadEarlierMessages', 'Load earlier messages') }}
          </button>
          <p v-if="messagesError" class="work-center-error">{{ messagesError }}</p>
          <dl v-if="action.brief" class="work-center-action-brief work-center-action-detail-brief">
            <div><dt>{{ tr('workCenter.actionObjective', 'What to do') }}</dt><dd>{{ action.brief.objective }}</dd></div>
            <div><dt>{{ tr('workCenter.actionApproach', 'How to do it') }}</dt><dd>{{ action.brief.approach }}</dd></div>
            <div><dt>{{ tr('workCenter.actionExpectedOutcome', 'Expected result') }}</dt><dd>{{ action.brief.expectedOutcome }}</dd></div>
            <div v-if="action.dependencies?.length"><dt>{{ tr('workCenter.dependencies', 'Dependencies') }}</dt><dd>{{ action.dependencies.join(', ') }}</dd></div>
          </dl>
          <section v-if="action.canonicalResult" class="work-center-action-result">
            <strong>{{ tr('workCenter.actionResult', 'Latest result') }}</strong>
            <p v-if="action.canonicalResult.summary">{{ action.canonicalResult.summary }}</p>
            <p v-if="action.canonicalResult.waitingReason" class="work-center-muted">{{ action.canonicalResult.waitingReason }}</p>
            <ul v-if="action.canonicalResult.evidence?.length">
              <li v-for="(evidence, index) in action.canonicalResult.evidence" :key="index">{{ typeof evidence === 'string' ? evidence : (evidence.label || evidence.ref || evidence.kind) }}</li>
            </ul>
          </section>
          <section v-for="generation in actionThread" :key="generation.generation" class="work-center-action-generation" :class="{ canonical: generation.canonical }">
            <header class="work-center-action-generation-header">
              <strong>{{ tr('workCenter.generation', 'Generation') }} {{ generation.generation }}</strong>
              <span>{{ generation.canonical ? tr('workCenter.currentExecution', 'Current execution') : tr('workCenter.previousExecution', 'Previous execution') }}</span>
            </header>
            <div v-if="generation.runs?.length" class="work-center-action-runs">
              <button v-for="run in generation.runs" :key="run.id" type="button" class="work-center-action-run" @click="openRun(run)">
                <span><strong>{{ tr('workCenter.attempt', 'Attempt') }} {{ run.attempt }}</strong><small>{{ statusLabel(run.status) }} · {{ time(run.startedAt) }}</small></span>
                <span>{{ formatCount(run.loopCount) }} {{ tr('workCenter.loops', 'loops') }} · {{ formatCount(run.toolCount) }} {{ tr('workCenter.tools', 'tools') }}</span>
              </button>
            </div>
            <article v-for="message in generation.messages" :key="message.id" class="work-center-action-message" :class="'role-' + message.role" :data-status="message.status">
              <header>
                <strong>{{ message.role === 'user' ? tr('workCenter.you', 'You') : tr('workCenter.aiResponse', 'AI response') }}</strong>
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
          </section>
          <p v-if="attachmentError" class="work-center-error" role="alert">{{ attachmentError }}</p>
          <p v-if="messages.length === 0" class="work-center-action-empty">{{ tr('workCenter.noActionMessages', 'No execution messages yet.') }}</p>
        </div>

        <div v-else id="work-center-action-requests-panel" role="tabpanel" aria-labelledby="work-center-action-requests-tab" class="work-center-action-requests">
          <p v-if="requestsError" class="work-center-error">{{ requestsError }}</p>
          <p v-if="requestsLoading && requests.length === 0" class="work-center-action-empty">{{ tr('workCenter.loadingRequests', 'Loading requests…') }}</p>
          <p v-else-if="requests.length === 0" class="work-center-action-empty">{{ tr('workCenter.noRequestDetails', 'No request details are available for this Action yet.') }}</p>
          <article v-for="(request, index) in requests" :key="requestKey(request)" class="work-center-request-card" :class="{ expanded: expandedRequestKey === requestKey(request) }">
            <button type="button" class="work-center-request-summary" @click="toggleRequest(request)" :aria-expanded="expandedRequestKey === requestKey(request)">
              <span class="work-center-request-index">{{ requests.length - index }}</span>
              <span class="work-center-request-title"><strong>{{ request.model || tr('workCenter.unknownModel', 'Unknown model') }}</strong><small>{{ request.vp?.name || request.vp?.id || '—' }} · {{ time(request.openedAt) }}</small></span>
              <span class="work-center-request-metrics"><span>{{ request.loopCount }}L</span><span>{{ formatTokens(request.totalTokens) }} tok</span><span>{{ formatDuration(request.totalMs) }}</span></span>
              <span class="work-center-action-chevron" aria-hidden="true"></span>
            </button>
            <div v-if="expandedRequestKey === requestKey(request)" class="work-center-request-detail">
              <p v-if="requestDetailsError[requestKey(request)]" class="work-center-error">{{ requestDetailsError[requestKey(request)] }}</p>
              <p v-else-if="requestDetailsLoading[requestKey(request)]" class="work-center-action-empty">{{ tr('workCenter.loadingRequestDetail', 'Loading request detail…') }}</p>
              <p v-else-if="!requestDetail(request)" class="work-center-action-empty">{{ tr('workCenter.requestDetailUnavailable', 'Request detail is unavailable. Try again.') }}</p>
              <p v-else-if="(requestDetail(request).loops || []).length === 0" class="work-center-action-empty">{{ tr('workCenter.noRequestLoops', 'This request has no retained loop details.') }}</p>
              <p v-else-if="requestDetail(request).truncated" class="work-center-action-notice">{{ $t('workCenter.requestDetailTruncated', { summarized: formatCount(requestDetail(request).summarizedLoopCount), omitted: formatCount(requestDetail(request).omittedLoopCount) }) }}</p>
              <article v-for="loop in requestDetail(request)?.loops || []" :key="requestLoopKey(request, loop)" class="work-center-request-loop">
                <button type="button" @click="toggleLoop(request, loop)" :aria-expanded="loopExpanded(request, loop)">
                  <strong>{{ tr('workCenter.loop', 'Loop') }} {{ loop.loopNumber }}</strong>
                  <span>{{ loop.model || request.model }} · {{ formatTokens(loop.usage?.totalTokens) }} tok · {{ formatDuration(loop.latencyMs) }}</span>
                </button>
                <div v-if="loopExpanded(request, loop)" class="work-center-request-loop-body">
                  <p v-if="loop.detailTruncated" class="work-center-action-notice">{{ tr('workCenter.loopDetailTruncated', 'Large Loop: showing a diagnostic summary.') }}</p>
                  <details v-if="loop.systemPrompt"><summary>{{ tr('workCenter.systemPrompt', 'System prompt') }}</summary><pre>{{ loop.systemPrompt }}</pre></details>
                  <details v-if="loop.messages?.length"><summary>{{ tr('workCenter.requestMessages', 'Request messages') }}</summary><pre>{{ json(loop.messages) }}</pre></details>
                  <details v-if="loop.response"><summary>{{ tr('workCenter.aiResponse', 'AI response') }}</summary><pre>{{ loop.response }}</pre></details>
                  <details v-if="loop.tools?.length"><summary>{{ tr('workCenter.toolCalls', 'Tool calls') }} · {{ loop.tools.length }}</summary><div class="work-center-request-tools"><article v-for="tool in loop.tools" :key="tool.id || tool.name"><strong>{{ tool.name }}</strong><small>{{ formatDuration(tool.durationMs) }} · {{ tool.isError ? tr('workCenter.status.failed', 'Failed') : tr('workCenter.status.completed', 'Completed') }}</small><pre>{{ json(tool.input) }}</pre><pre v-if="tool.output != null">{{ json(tool.output) }}</pre></article></div></details>
                  <details v-if="loop.rawRequest"><summary>{{ tr('workCenter.rawRequest', 'Raw request') }}</summary><pre>{{ json(loop.rawRequest) }}</pre></details>
                  <details v-if="loop.rawResponse"><summary>{{ tr('workCenter.rawResponse', 'Raw response') }}</summary><pre>{{ json(loop.rawResponse) }}</pre></details>
                </div>
              </article>
            </div>
          </article>
        </div>
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
            <textarea ref="composerInput" :value="composerText" rows="1" :placeholder="tr('workCenter.actionInputPlaceholder', 'Add context, answer a question, or redirect this Action')" @input="onComposerInput" @keydown="onComposerKeydown"></textarea>
          </div>
          <button class="send-btn" type="button" @click="$emit('send')" :disabled="!canSend" :title="sending ? tr('workCenter.sendingInput', 'Sending…') : tr('workCenter.sendInput', 'Send input')">
            <svg v-if="!sending" viewBox="0 0 24 24" aria-hidden="true"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>
            <span v-else class="work-center-send-spinner" aria-hidden="true"></span>
          </button>
        </div>
        <div class="work-center-action-composer-footer">
          <small class="work-center-action-composer-hint">{{ uploading ? tr('workCenter.attachmentsUploading', 'Uploading…') : composerHint }}</small>
          <button v-if="canRetry" class="btn-secondary" type="button" @click="$emit('retry')">
            {{ tr('workCenter.retryAction', 'Retry Action') }}
          </button>
        </div>
      </footer>
    </section>
    <section v-else class="work-center-action-detail-pane work-center-detail-empty"><strong>{{ tr('workCenter.selectAction', 'Select an Action to inspect its execution') }}</strong></section>
  `,
};
