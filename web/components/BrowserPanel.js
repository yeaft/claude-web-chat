import { useBrowserStore } from '../stores/browser.js';
import { t } from '../utils/i18n.js';

function formatBytes(value) {
  const bytes = Math.max(0, Number(value) || 0);
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${bytes} B`;
}

export default {
  name: 'BrowserPanel',
  props: {
    routeKey: { type: String, default: '' },
    runtimeProvider: { type: String, default: '' },
    agentId: { type: String, required: true },
    sessionId: { type: String, default: '' },
    runtimeReady: { type: Boolean, default: false },
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

      <div v-if="!runtimeStatus && setupError" class="browser-stage browser-stage-placeholder" role="alert">
        <p>{{ setupError }}</p>
        <button type="button" class="btn-secondary" @click="refreshRuntime">{{ $t('common.retry') }}</button>
      </div>

      <div v-else-if="!runtimeStatus" class="browser-stage browser-stage-placeholder" aria-busy="true">
        <span class="session-loading-spinner"></span>
        <p>{{ $t('workbench.browserChecking') }}</p>
      </div>

      <div v-else-if="runtimeStatus && !runtimeStatus.supported" class="browser-stage browser-stage-placeholder" role="alert">
        <span class="workbench-capability-icon workbench-capability-empty-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24"><path fill="currentColor" d="M20 4H4a2 2 0 00-2 2v12a2 2 0 002 2h16a2 2 0 002-2V6a2 2 0 00-2-2zm0 14H4V9h16v9zM4 7V6h16v1H4z"/></svg>
        </span>
        <h2 id="browser-panel-title">{{ $t('workbench.browser') }}</h2>
        <p>{{ $t('workbench.browserPlatformUnsupported') }}</p>
      </div>

      <div v-else-if="runtimeStatus && !runtimeStatus.ready" class="browser-stage browser-stage-placeholder browser-setup-stage">
        <span class="workbench-capability-icon workbench-capability-empty-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24"><path fill="currentColor" d="M20 4H4a2 2 0 00-2 2v12a2 2 0 002 2h16a2 2 0 002-2V6a2 2 0 00-2-2zm0 14H4V9h16v9zM4 7V6h16v1H4z"/></svg>
        </span>
        <h2 id="browser-panel-title">{{ $t('workbench.browserSetupTitle') }}</h2>

        <template v-if="runtimeInstalling">
          <p>{{ $t('workbench.browserInstalling', { build: runtimeStatus.buildId || '' }) }}</p>
          <div class="browser-install-progress" role="progressbar" :aria-valuenow="progressPercent" aria-valuemin="0" aria-valuemax="100">
            <span :style="{ width: progressPercent + '%' }"></span>
          </div>
          <p class="browser-install-meta">{{ progressText }}</p>
          <p class="browser-install-note">{{ $t('workbench.browserInstallKeepOpen') }}</p>
        </template>

        <template v-else-if="!runtimeStatus.installed">
          <p>{{ $t('workbench.browserOptionalInstall', {
            build: runtimeStatus.buildId || '',
            size: downloadSize,
          }) }}</p>
          <p class="browser-install-note">{{ $t('workbench.browserInstallDiskNote') }}</p>
          <p v-if="setupError || runtimeStatus.safeError" class="browser-setup-error" role="alert">
            {{ setupError || runtimeStatus.safeError }}
          </p>
          <button
            type="button"
            class="btn-primary"
            :disabled="installing || runtimeLoading"
            @click="install"
          >{{ $t('workbench.browserInstallAction', { size: downloadSize }) }}</button>
        </template>

        <template v-else>
          <p>{{ $t('workbench.browserInstalledEnable', { build: runtimeStatus.buildId || '' }) }}</p>
          <p v-if="setupError || runtimeStatus.safeError" class="browser-setup-error" role="alert">
            {{ setupError || runtimeStatus.safeError }}
          </p>
          <button
            type="button"
            class="btn-primary"
            :disabled="enabling || runtimeLoading"
            @click="enable"
          >{{ $t(enabling ? 'workbench.browserEnabling' : 'workbench.browserEnableAction') }}</button>
        </template>
      </div>

      <div v-else-if="viewerLoading" class="browser-stage browser-stage-placeholder" aria-busy="true">
        <span class="session-loading-spinner"></span>
        <p>{{ $t('workbench.browserStarting') }}</p>
      </div>

      <div v-else-if="displayError" class="browser-stage browser-stage-placeholder" role="alert">
        <p>{{ displayError }}</p>
        <button type="button" class="btn-secondary" @click="startViewer">{{ $t('common.retry') }}</button>
      </div>

      <div v-else-if="!snapshot" class="browser-stage browser-stage-placeholder">
        <span class="workbench-capability-icon workbench-capability-empty-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24"><path fill="currentColor" d="M20 4H4a2 2 0 00-2 2v12a2 2 0 002 2h16a2 2 0 002-2V6a2 2 0 00-2-2zm0 14H4V9h16v9zM4 7V6h16v1H4zm2-1h2v1H6V6z"/></svg>
        </span>
        <h2 id="browser-panel-title">{{ $t('workbench.browser') }}</h2>
        <p>{{ $t('workbench.browserReadyHint') }}</p>
        <button type="button" class="btn-primary" @click="startViewer">{{ $t('workbench.browserStart') }}</button>
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
    const runtimeLoading = Vue.ref(false);
    const installing = Vue.ref(false);
    const enabling = Vue.ref(false);
    const viewerLoading = Vue.ref(false);
    const closing = Vue.ref(false);
    const setupError = Vue.ref('');
    const viewerError = Vue.ref('');
    const browserSessionId = Vue.ref(null);
    let statusPollTimer = null;
    let disposed = false;

    browser.installMessageListener();

    const runtimeStatus = Vue.computed(() => (
      browser.runtimeStatus[props.agentId]
      || (props.runtimeReady ? { supported: true, installed: true, enabled: true, ready: true, state: 'ready' } : null)
    ));
    const installProgress = Vue.computed(() => browser.installProgress[props.agentId] || null);
    const runtimeInstalling = Vue.computed(() => (
      installing.value || runtimeStatus.value?.state === 'installing'
    ));
    const downloadSize = Vue.computed(() => formatBytes(runtimeStatus.value?.downloadBytes));
    const progressPercent = Vue.computed(() => {
      const downloaded = Number(installProgress.value?.downloadedBytes
        ?? runtimeStatus.value?.downloadedBytes) || 0;
      const total = Number(installProgress.value?.totalBytes
        ?? runtimeStatus.value?.totalBytes
        ?? runtimeStatus.value?.downloadBytes) || 0;
      if (total <= 0) return 0;
      return Math.min(100, Math.max(0, Math.round(downloaded * 100 / total)));
    });
    const progressText = Vue.computed(() => {
      const downloaded = Number(installProgress.value?.downloadedBytes
        ?? runtimeStatus.value?.downloadedBytes) || 0;
      const total = Number(installProgress.value?.totalBytes
        ?? runtimeStatus.value?.totalBytes
        ?? runtimeStatus.value?.downloadBytes) || 0;
      return t('workbench.browserInstallProgress', {
        downloaded: formatBytes(downloaded),
        total: formatBytes(total),
      });
    });

    const key = Vue.computed(() => `${props.agentId || ''}\0${browserSessionId.value || ''}`);
    const snapshot = Vue.computed(() => browserSessionId.value ? browser.sessions[key.value] || null : null);
    const peer = Vue.computed(() => browserSessionId.value ? browser.peers[key.value] || null : null);
    const connected = Vue.computed(() => peer.value?.state === 'connected');
    const peerError = Vue.computed(() => browser.errors[key.value] || '');
    const displayError = Vue.computed(() => viewerError.value || peerError.value);
    const connectionClass = Vue.computed(() => (
      connected.value ? 'connected'
        : (displayError.value || setupError.value || runtimeStatus.value?.safeError) ? 'failed'
          : 'connecting'
    ));
    const displayUrl = Vue.computed(() => snapshot.value?.activeUrl || 'about:blank');
    const statusText = Vue.computed(() => {
      if (runtimeInstalling.value) return t('workbench.browserStatusInstalling');
      if (enabling.value || runtimeStatus.value?.state === 'probing') return t('workbench.browserStatusProbing');
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

    const clearStatusPoll = () => {
      clearTimeout(statusPollTimer);
      statusPollTimer = null;
    };

    const scheduleStatusPoll = () => {
      clearStatusPoll();
      if (disposed || installing.value || runtimeStatus.value?.state !== 'installing') return;
      statusPollTimer = setTimeout(() => {
        void refreshRuntime({ startWhenReady: true });
      }, 2_000);
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

    const startViewer = async () => {
      if (viewerLoading.value || !props.agentId || runtimeStatus.value?.ready !== true) return;
      viewerLoading.value = true;
      viewerError.value = '';
      try {
        const sessions = await browser.listSessions(props.agentId);
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
        viewerLoading.value = false;
        await Vue.nextTick();
        await attach();
      } catch (cause) {
        viewerError.value = cause?.message || String(cause);
      } finally {
        viewerLoading.value = false;
      }
    };

    const refreshRuntime = async ({ startWhenReady = false, preserveError = false } = {}) => {
      if (runtimeLoading.value || !props.agentId || browser.protocolSupported !== true) return;
      runtimeLoading.value = true;
      if (!preserveError) setupError.value = '';
      try {
        const status = await browser.getRuntimeStatus(props.agentId);
        if (disposed) return;
        if (status.state === 'installing') scheduleStatusPoll();
        else clearStatusPoll();
        if (startWhenReady && status.ready === true && !snapshot.value) await startViewer();
      } catch (cause) {
        if (!preserveError || !setupError.value) {
          setupError.value = cause?.message || String(cause);
        }
      } finally {
        runtimeLoading.value = false;
      }
    };

    const install = async () => {
      if (installing.value || !runtimeStatus.value) return;
      installing.value = true;
      setupError.value = '';
      clearStatusPoll();
      try {
        const status = await browser.installRuntime(props.agentId, runtimeStatus.value);
        if (!disposed && status.ready === true) await startViewer();
      } catch (cause) {
        setupError.value = cause?.message || String(cause);
        await refreshRuntime({ preserveError: true });
      } finally {
        installing.value = false;
        scheduleStatusPoll();
      }
    };

    const enable = async () => {
      if (enabling.value) return;
      enabling.value = true;
      setupError.value = '';
      try {
        const status = await browser.enableRuntime(props.agentId);
        if (!disposed && status.ready === true) await startViewer();
      } catch (cause) {
        setupError.value = cause?.message || String(cause);
        await refreshRuntime({ preserveError: true });
      } finally {
        enabling.value = false;
      }
    };

    const closeBrowser = async () => {
      if (!snapshot.value || closing.value) return;
      closing.value = true;
      viewerError.value = '';
      const id = browserSessionId.value;
      try {
        browser.detach(props.agentId, id, { notify: false });
        await browser.closeSession(props.agentId, id, snapshot.value.revision);
        browserSessionId.value = null;
      } catch (cause) {
        viewerError.value = cause?.message || String(cause);
      } finally {
        closing.value = false;
      }
    };

    Vue.onMounted(() => {
      if (browser.protocolSupported !== true) return;
      if (props.runtimeReady && !browser.runtimeStatus[props.agentId]) void startViewer();
      else void refreshRuntime({ startWhenReady: true });
    });

    Vue.watch(() => browser.protocolSupported, (supported, previous) => {
      if (supported === true && previous !== true) {
        if (props.runtimeReady && !browser.runtimeStatus[props.agentId]) void startViewer();
        else void refreshRuntime({ startWhenReady: true });
      }
      if (supported === false) setupError.value = t('workbench.browserProtocolUnavailable');
    });

    Vue.watch(() => props.runtimeReady, (ready, previous) => {
      if (!ready || previous === true || disposed) return;
      delete browser.runtimeStatus[props.agentId];
      void startViewer();
    });

    Vue.watch(() => runtimeStatus.value?.state, state => {
      if (state === 'installing') scheduleStatusPoll();
      else clearStatusPoll();
    });

    Vue.onUnmounted(() => {
      disposed = true;
      clearStatusPoll();
      if (browserSessionId.value) browser.detach(props.agentId, browserSessionId.value, { notify: true });
    });

    return {
      video,
      runtimeLoading,
      installing,
      enabling,
      viewerLoading,
      closing,
      setupError,
      displayError,
      runtimeStatus,
      runtimeInstalling,
      downloadSize,
      progressPercent,
      progressText,
      snapshot,
      connected,
      connectionClass,
      displayUrl,
      statusText,
      refreshRuntime,
      install,
      enable,
      startViewer,
      closeBrowser,
    };
  },
};
