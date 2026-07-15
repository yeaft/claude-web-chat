import { renderMarkdown, renderMermaidIn } from '../utils/markdown.js';

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
  },
  emits: ['back', 'update:composerText', 'load-earlier-messages', 'select-request', 'refresh-requests', 'attachment-input', 'remove-attachment', 'send'],
  data() {
    return {
      activeTab: 'messages',
      expandedRequestId: null,
      expandedLoops: {},
    };
  },
  computed: {
    canCompose() {
      return this.selected?.currentActionId === this.action?.id
        && ['ready', 'running', 'waiting', 'needs_attention'].includes(this.selected?.status);
    },
    composerHint() {
      if (this.selected?.status === 'waiting') {
        return this.tr('workCenter.actionInputResumeHint', 'Your input resumes this Action with the additional context.');
      }
      if (this.selected?.status === 'needs_attention') {
        return this.tr('workCenter.actionInputRetryHint', 'Add instructions or files, then rerun this Action with the new context.');
      }
      return this.tr('workCenter.actionInputRestartHint', 'New input restarts the active Action so it can apply the updated context safely.');
    },
  },
  watch: {
    action() {
      this.activeTab = 'messages';
      this.expandedRequestId = null;
      this.expandedLoops = {};
      this.$nextTick(() => renderMermaidIn(this.$el));
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
    requestDetail(request) {
      return this.requestDetails[request.id] || null;
    },
    async toggleRequest(request) {
      if (this.expandedRequestId === request.id) {
        this.expandedRequestId = null;
        return;
      }
      this.expandedRequestId = request.id;
      if (!this.requestDetail(request)) this.$emit('select-request', request);
    },
    toggleLoop(requestId, loopNumber) {
      const key = `${requestId}:${loopNumber}`;
      this.expandedLoops = { ...this.expandedLoops, [key]: !this.expandedLoops[key] };
    },
    loopExpanded(requestId, loopNumber) {
      return !!this.expandedLoops[`${requestId}:${loopNumber}`];
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
        <button class="work-center-pane-back btn-ghost" type="button" @click="$emit('back')">
          <span aria-hidden="true">‹</span>{{ tr('workCenter.backToActions', 'Actions') }}
        </button>
        <div>
          <span class="work-center-status" :data-status="action.status"><span aria-hidden="true"></span>{{ statusLabel(action.status) }}</span>
          <h2>{{ tr('workCenter.actionDetails', 'Action details') }} · {{ tr('workCenter.action.' + action.type, action.type) }}</h2>
        </div>
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
          </dl>
          <article v-for="message in messages" :key="message.id" class="work-center-action-message" :class="'role-' + message.role" :data-status="message.status">
            <header>
              <strong>{{ message.role === 'user' ? tr('workCenter.you', 'You') : tr('workCenter.aiResponse', 'AI response') }}</strong>
              <small>{{ time(message.updatedAt || message.createdAt) }}</small>
            </header>
            <div v-if="message.text" class="markdown-body" v-html="messageHtml(message.text)"></div>
            <div v-if="message.attachments?.length" class="work-center-attachment-list">
              <span v-for="attachment in message.attachments" :key="attachment.id" class="work-center-attachment-chip">
                <span>{{ attachment.name }}</span><small>{{ formatAttachmentSize(attachment.size) }}</small>
              </span>
            </div>
          </article>
          <p v-if="messages.length === 0" class="work-center-action-empty">{{ tr('workCenter.noActionMessages', 'No execution messages yet.') }}</p>
        </div>

        <div v-else id="work-center-action-requests-panel" role="tabpanel" aria-labelledby="work-center-action-requests-tab" class="work-center-action-requests">
          <p v-if="requestsError" class="work-center-error">{{ requestsError }}</p>
          <p v-if="requestsLoading && requests.length === 0" class="work-center-action-empty">{{ tr('workCenter.loadingRequests', 'Loading requests…') }}</p>
          <p v-else-if="requests.length === 0" class="work-center-action-empty">{{ tr('workCenter.noRequestDetails', 'No request details are available for this Action yet.') }}</p>
          <article v-for="(request, index) in requests" :key="request.id" class="work-center-request-card" :class="{ expanded: expandedRequestId === request.id }">
            <button type="button" class="work-center-request-summary" @click="toggleRequest(request)" :aria-expanded="expandedRequestId === request.id">
              <span class="work-center-request-index">{{ requests.length - index }}</span>
              <span class="work-center-request-title"><strong>{{ request.model || tr('workCenter.unknownModel', 'Unknown model') }}</strong><small>{{ request.vp?.name || request.vp?.id || '—' }} · {{ time(request.openedAt) }}</small></span>
              <span class="work-center-request-metrics"><span>{{ request.loopCount }}L</span><span>{{ formatTokens(request.totalTokens) }} tok</span><span>{{ formatDuration(request.totalMs) }}</span></span>
              <span class="work-center-action-chevron" aria-hidden="true"></span>
            </button>
            <div v-if="expandedRequestId === request.id" class="work-center-request-detail">
              <p v-if="requestDetailsError[request.id]" class="work-center-error">{{ requestDetailsError[request.id] }}</p>
              <p v-else-if="requestDetailsLoading[request.id]" class="work-center-action-empty">{{ tr('workCenter.loadingRequestDetail', 'Loading request detail…') }}</p>
              <p v-else-if="!requestDetail(request)" class="work-center-action-empty">{{ tr('workCenter.requestDetailUnavailable', 'Request detail is unavailable. Try again.') }}</p>
              <article v-for="loop in requestDetail(request)?.loops || []" :key="loop.id" class="work-center-request-loop">
                <button type="button" @click="toggleLoop(request.id, loop.loopNumber)" :aria-expanded="loopExpanded(request.id, loop.loopNumber)">
                  <strong>{{ tr('workCenter.loop', 'Loop') }} {{ loop.loopNumber }}</strong>
                  <span>{{ loop.model || request.model }} · {{ formatTokens(loop.usage?.totalTokens) }} tok · {{ formatDuration(loop.latencyMs) }}</span>
                </button>
                <div v-if="loopExpanded(request.id, loop.loopNumber)" class="work-center-request-loop-body">
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
        <textarea :value="composerText" rows="3" :placeholder="tr('workCenter.actionInputPlaceholder', 'Add context, answer a question, or redirect this Action')" @input="$emit('update:composerText', $event.target.value)"></textarea>
        <div v-if="composerAttachments.length" class="work-center-attachment-list">
          <span v-for="(attachment, index) in composerAttachments" :key="attachment.fileId" class="work-center-attachment-chip">
            <span>{{ attachment.name }}</span><small>{{ formatAttachmentSize(attachment.size) }}</small>
            <button type="button" @click="$emit('remove-attachment', index)" :aria-label="tr('workCenter.removeAttachment', 'Remove attachment')">×</button>
          </span>
        </div>
        <div class="work-center-action-composer-footer">
          <div>
            <label v-if="attachmentsSupported" class="btn-ghost work-center-attachment-picker">
              {{ tr('workCenter.addAttachments', 'Add files') }}
              <input type="file" multiple accept="image/png,image/jpeg,image/gif,image/webp,application/pdf,text/*,.md,.json,.js,.ts,.css,.html,.py,.yaml,.yml,.xml,.csv" @change="$emit('attachment-input', $event)">
            </label>
            <small>{{ uploading ? tr('workCenter.attachmentsUploading', 'Uploading…') : composerHint }}</small>
          </div>
          <button class="btn-primary" type="button" @click="$emit('send')" :disabled="uploading || sending || (!composerText.trim() && composerAttachments.length === 0)">
            {{ sending ? tr('workCenter.sendingInput', 'Sending…') : tr('workCenter.sendInput', 'Send input') }}
          </button>
        </div>
      </footer>
    </section>
    <section v-else class="work-center-action-detail-pane work-center-detail-empty"><strong>{{ tr('workCenter.selectAction', 'Select an Action to inspect its execution') }}</strong></section>
  `,
};
