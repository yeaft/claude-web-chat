import { useBrowserStore } from '../stores/browser.js';
import { t } from '../utils/i18n.js';

export default {
  name: 'BrowserPanel',
  props: {
    routeKey: { type: String, default: '' },
    runtimeProvider: { type: String, default: '' },
    agentId: { type: String, required: true },
    sessionId: { type: String, default: '' },
  },
  template: `
    <section class="browser-panel" aria-labelledby="browser-panel-title">
      <div class="browser-toolbar">
        <div class="browser-location" :title="snapshot?.activeUrl || ''">
          <span class="browser-connection-dot" :class="connectionClass" aria-hidden="true"></span>
          <span>{{ displayUrl }}</span>
        </div>
        <span class="browser-status" role="status">{{ statusText }}</span>
        <button
          v-if="snapshot"
          type="button"
          class="btn-ghost browser-end-button"
          :disabled="closing"
          @click="closeBrowser"
        >{{ $t('workbench.browserEnd') }}</button>
      </div>

      <div v-if="loading" class="browser-stage browser-stage-placeholder" aria-busy="true">
        <span class="session-loading-spinner"></span>
        <p>{{ $t('workbench.browserStarting') }}</p>
      </div>

      <div v-else-if="displayError" class="browser-stage browser-stage-placeholder" role="alert">
        <p>{{ displayError }}</p>
        <button type="button" class="btn-secondary" @click="start">{{ $t('common.retry') }}</button>
      </div>

      <div v-else-if="!snapshot" class="browser-stage browser-stage-placeholder">
        <span class="workbench-capability-icon workbench-capability-empty-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24"><path fill="currentColor" d="M20 4H4a2 2 0 00-2 2v12a2 2 0 002 2h16a2 2 0 002-2V6a2 2 0 00-2-2zm0 14H4V9h16v9zM4 7V6h16v1H4zm2-1h2v1H6V6z"/></svg>
        </span>
        <h2 id="browser-panel-title">{{ $t('workbench.browser') }}</h2>
        <p>{{ $t('workbench.browserReadyHint') }}</p>
        <button type="button" class="btn-primary" @click="start">{{ $t('workbench.browserStart') }}</button>
      </div>

      <div v-else class="browser-stage">
        <video
          ref="video"
          class="browser-video"
          autoplay
          muted
          playsinline
          :aria-label="$t('workbench.browserVideoLabel')"
        ></video>
        <div v-if="!connected" class="browser-video-overlay" aria-live="polite">
          <span class="session-loading-spinner"></span>
          <span>{{ $t('workbench.browserConnecting') }}</span>
        </div>
      </div>
    </section>
  `,
  setup(props) {
    const browser = useBrowserStore();
    const video = Vue.ref(null);
    const loading = Vue.ref(false);
    const closing = Vue.ref(false);
    const error = Vue.ref('');
    const browserSessionId = Vue.ref(null);

    browser.installMessageListener();

    const key = Vue.computed(() => `${props.agentId || ''}\0${browserSessionId.value || ''}`);
    const snapshot = Vue.computed(() => browserSessionId.value ? browser.sessions[key.value] || null : null);
    const peer = Vue.computed(() => browserSessionId.value ? browser.peers[key.value] || null : null);
    const connected = Vue.computed(() => peer.value?.state === 'connected');
    const peerError = Vue.computed(() => browser.errors[key.value] || '');
    const displayError = Vue.computed(() => error.value || peerError.value);
    const connectionClass = Vue.computed(() => connected.value ? 'connected' : (displayError.value ? 'failed' : 'connecting'));
    const displayUrl = Vue.computed(() => snapshot.value?.activeUrl || 'about:blank');
    const statusText = Vue.computed(() => {
      if (displayError.value) return displayError.value;
      if (connected.value) return browserSessionId.value ? 'WebRTC' : '';
      if (snapshot.value) return t('workbench.browserStatusConnecting');
      return '';
    });

    const sourceRef = () => {
      if (props.runtimeProvider === 'yeaft' && props.sessionId) {
        return { kind: 'yeaft-session', sessionId: props.sessionId };
      }
      if (props.sessionId) return { kind: 'chat-conversation', conversationId: props.sessionId };
      return null;
    };

    const attach = async () => {
      if (!browserSessionId.value || !video.value) return;
      browser.detach(props.agentId, browserSessionId.value, { notify: true });
      await browser.attach({
        agentId: props.agentId,
        browserSessionId: browserSessionId.value,
        videoElement: video.value,
      });
    };

    const start = async () => {
      if (loading.value || !props.agentId) return;
      loading.value = true;
      error.value = '';
      try {
        let sessions = await browser.listSessions(props.agentId);
        let selected = sessions.find(item => item.state === 'ready') || null;
        if (!selected) {
          selected = await browser.createSession({
            agentId: props.agentId,
            sourceRef: sourceRef(),
            locale: document.documentElement.lang || 'en-US',
            viewport: { width: 1280, height: 720, deviceScaleFactor: 1 },
          });
        }
        browserSessionId.value = selected.browserSessionId;
        // The video element is behind the loading branch. Leave the creation
        // state before nextTick so the ref exists when peer attachment starts.
        loading.value = false;
        await Vue.nextTick();
        await attach();
      } catch (cause) {
        error.value = cause?.message || String(cause);
      } finally {
        loading.value = false;
      }
    };

    const closeBrowser = async () => {
      if (!snapshot.value || closing.value) return;
      closing.value = true;
      error.value = '';
      const id = browserSessionId.value;
      try {
        // Closing the whole Browser Session owns peer cleanup. Sending a detach
        // first would advance the Agent revision and make expectedRevision stale.
        browser.detach(props.agentId, id, { notify: false });
        await browser.closeSession(props.agentId, id, snapshot.value.revision);
        browserSessionId.value = null;
      } catch (cause) {
        error.value = cause?.message || String(cause);
      } finally {
        closing.value = false;
      }
    };

    Vue.onMounted(() => {
      if (browser.protocolSupported === true) void start();
    });

    Vue.watch(() => browser.protocolSupported, (supported, previous) => {
      if (supported === true && !loading.value) {
        if (previous !== true || !peer.value) void start();
      }
      if (supported === false) error.value = t('workbench.browserProtocolUnavailable');
    });

    Vue.onUnmounted(() => {
      if (browserSessionId.value) browser.detach(props.agentId, browserSessionId.value, { notify: true });
    });

    return {
      video,
      loading,
      closing,
      error,
      displayError,
      snapshot,
      connected,
      connectionClass,
      displayUrl,
      statusText,
      start,
      closeBrowser,
    };
  },
};
