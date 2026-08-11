import { useBrowserStore } from '../stores/browser.js';
import { t } from '../utils/i18n.js';

function formatBytes(value) {
  const bytes = Math.max(0, Number(value) || 0);
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${bytes} B`;
}

export function normalizeBrowserAddress(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const candidate = /^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`;
  try {
    const url = new URL(candidate);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    return url.href;
  } catch {
    return null;
  }
}

export function browserPointerPosition(event, element, viewport) {
  const rect = element?.getBoundingClientRect?.();
  const width = Number(viewport?.width) || 1280;
  const height = Number(viewport?.height) || 720;
  if (!rect?.width || !rect?.height) return null;
  const scale = Math.min(rect.width / width, rect.height / height);
  const renderedWidth = width * scale;
  const renderedHeight = height * scale;
  const left = rect.left + (rect.width - renderedWidth) / 2;
  const top = rect.top + (rect.height - renderedHeight) / 2;
  const x = (Number(event.clientX) - left) / scale;
  const y = (Number(event.clientY) - top) / scale;
  if (x < 0 || y < 0 || x > width || y > height) return null;
  return { x: Math.round(x), y: Math.round(y) };
}

export function createBrowserInputController(sendControl) {
  const pressedButtons = new Set();
  const pressedModifiers = new Set();
  let composing = false;
  const send = action => sendControl(action) === true;
  return {
    pointerDown(button, position) {
      if (!position || !send({ type: 'mouse', event: 'down', button, ...position })) return false;
      pressedButtons.add(button);
      return true;
    },
    pointerUp(button, position) {
      if (!pressedButtons.has(button)) return false;
      const sent = send({ type: 'mouse', event: 'up', button, ...(position || {}) });
      if (sent) pressedButtons.delete(button);
      return sent;
    },
    keyDown(event) {
      if (composing || event.isComposing) return false;
      if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
        return send({ type: 'text', text: event.key });
      }
      const modifier = ['Alt', 'Control', 'Meta', 'Shift'].includes(event.key);
      const sent = send({ type: 'key', event: modifier ? 'down' : 'press', key: event.key });
      if (sent && modifier) pressedModifiers.add(event.key);
      return sent;
    },
    keyUp(key) {
      if (!pressedModifiers.has(key)) return false;
      const sent = send({ type: 'key', event: 'up', key });
      if (sent) pressedModifiers.delete(key);
      return sent;
    },
    compositionStart() { composing = true; },
    compositionEnd(text) {
      composing = false;
      return typeof text === 'string' && text ? send({ type: 'text', text }) : false;
    },
    reset() {
      if (pressedButtons.size === 0 && pressedModifiers.size === 0) return false;
      const sent = send({ type: 'resetInput' });
      if (sent) {
        pressedButtons.clear();
        pressedModifiers.clear();
      }
      return sent;
    },
    snapshot() {
      return { buttons: [...pressedButtons], modifiers: [...pressedModifiers], composing };
    },
  };
}

export function browserSessionMatchesSource(snapshot, expected) {
  const actual = snapshot?.sourceRef;
  if (!actual || !expected || actual.kind !== expected.kind) return false;
  if (expected.kind === 'yeaft-session') return actual.sessionId === expected.sessionId;
  if (expected.kind === 'chat-conversation') return actual.conversationId === expected.conversationId;
  return false;
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
        <form class="browser-location" @submit.prevent="navigate">
          <span class="browser-connection-dot" :class="connectionClass" aria-hidden="true"></span>
          <input
            v-model="address"
            type="text"
            inputmode="url"
            autocomplete="url"
            spellcheck="false"
            :aria-label="$t('workbench.browserAddressLabel')"
            :placeholder="$t('workbench.browserAddressPlaceholder')"
          >
          <button type="submit" class="btn-ghost browser-go-button" :disabled="navigating">
            {{ $t('workbench.browserGo') }}
          </button>
        </form>
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
          <div class="browser-install-progress-row">
            <div
              class="browser-install-progress"
              role="progressbar"
              :aria-label="$t('workbench.browserInstallProgressLabel')"
              :aria-valuenow="progressPercent"
              :aria-valuetext="progressText"
              aria-valuemin="0"
              aria-valuemax="100"
            >
              <span :style="{ width: progressPercent + '%' }"></span>
            </div>
            <strong class="browser-install-percent">{{ progressPercent }}%</strong>
          </div>
          <p class="browser-install-meta">{{ progressText }}</p>
          <p class="browser-install-note">{{ $t('workbench.browserInstallKeepOpen') }}</p>
        </template>

        <template v-else-if="enabling || runtimeStatus.state === 'probing'">
          <template v-if="setupError">
            <p class="browser-setup-error" role="alert">{{ setupError }}</p>
            <button type="button" class="btn-secondary" @click="refreshRuntime">{{ $t('common.retry') }}</button>
          </template>
          <template v-else>
            <span class="session-loading-spinner"></span>
            <p>{{ $t('workbench.browserEnabling') }}</p>
          </template>
        </template>

        <template v-else>
          <p>{{ $t(runtimeStatus.installed
            ? 'workbench.browserInstalledEnable'
            : 'workbench.browserOptionalInstall', {
              build: runtimeStatus.buildId || '',
              size: downloadSize,
            }) }}</p>
          <p v-if="!runtimeStatus.installed" class="browser-install-note">
            {{ $t('workbench.browserInstallDiskNote') }}
          </p>
          <p v-if="setupError || runtimeStatus.safeError" class="browser-setup-error" role="alert">
            {{ setupError || runtimeStatus.safeError }}
          </p>
          <button
            type="button"
            class="btn-primary"
            :disabled="setupInProgress || runtimeLoading"
            @click="setupRuntime"
          >{{ $t(runtimeStatus.installed
            ? 'workbench.browserEnableAction'
            : 'workbench.browserInstallAction', { size: downloadSize }) }}</button>
        </template>
      </div>

      <div v-else-if="viewerLoading" class="browser-stage browser-stage-placeholder" aria-busy="true">
        <span class="session-loading-spinner"></span>
        <p>{{ $t('workbench.browserStarting') }}</p>
      </div>

      <div v-else-if="displayError" class="browser-stage browser-stage-placeholder" role="alert">
        <p>{{ displayError }}</p>
        <button type="button" class="btn-secondary" @click="snapshot ? attach() : navigate()">{{ $t('common.retry') }}</button>
      </div>

      <div v-else-if="!snapshot" class="browser-stage browser-stage-placeholder">
        <span class="workbench-capability-icon workbench-capability-empty-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24"><path fill="currentColor" d="M20 4H4a2 2 0 00-2 2v12a2 2 0 002 2h16a2 2 0 002-2V6a2 2 0 00-2-2zm0 14H4V9h16v9zM4 7V6h16v1H4zm2-1h2v1H6V6z"/></svg>
        </span>
        <h2 id="browser-panel-title">{{ $t('workbench.browser') }}</h2>
        <p>{{ $t('workbench.browserReadyHint') }}</p>
        <form class="browser-start-form" @submit.prevent="navigate">
          <input
            v-model="address"
            type="text"
            inputmode="url"
            autocomplete="url"
            spellcheck="false"
            :aria-label="$t('workbench.browserAddressLabel')"
            :placeholder="$t('workbench.browserAddressPlaceholder')"
          >
          <button type="submit" class="btn-primary">{{ $t('workbench.browserStart') }}</button>
        </form>
      </div>

      <div v-else class="browser-stage">
        <video
          ref="video"
          class="browser-video"
          autoplay
          muted
          playsinline
          tabindex="0"
          :aria-label="$t('workbench.browserVideoLabel')"
          @pointermove="onPointerMove"
          @pointerdown="onPointerDown"
          @pointerup="onPointerUp"
          @pointercancel="releaseInput"
          @lostpointercapture="releaseInput"
          @wheel.prevent="onWheel"
          @keydown="onKeyDown"
          @keyup="onKeyUp"
          @compositionstart="onCompositionStart"
          @compositionend="onCompositionEnd"
          @contextmenu.prevent
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
    const navigating = Vue.ref(false);
    const address = Vue.ref('');
    const setupError = Vue.ref('');
    const viewerError = Vue.ref('');
    const browserSessionId = Vue.ref(null);
    let statusPollTimer = null;
    let disposed = false;
    const input = createBrowserInputController(action => (
      browser.sendControl(props.agentId, browserSessionId.value, action)
    ));

    browser.installMessageListener();

    const runtimeStatus = Vue.computed(() => (
      browser.runtimeStatus[props.agentId]
      || (props.runtimeReady ? { supported: true, installed: true, enabled: true, ready: true, state: 'ready' } : null)
    ));
    const installProgress = Vue.computed(() => browser.installProgress[props.agentId] || null);
    const runtimeInstalling = Vue.computed(() => (
      installing.value || runtimeStatus.value?.state === 'installing'
    ));
    const setupInProgress = Vue.computed(() => (
      runtimeInstalling.value || enabling.value || runtimeStatus.value?.state === 'probing'
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
    const peerError = Vue.computed(() => {
      const code = browser.errorCodes[key.value];
      if (code === 'browser_ice_servers_missing') return t('workbench.browserIceServersMissing');
      if (code === 'browser_ice_connection_failed') return t('workbench.browserIceConnectionFailed');
      if (code === 'browser_peer_attach_timeout') return t('workbench.browserPeerAttachTimeout');
      return browser.errors[key.value] || '';
    });
    const displayError = Vue.computed(() => viewerError.value || peerError.value);
    const connectionClass = Vue.computed(() => (
      connected.value ? 'connected'
        : (displayError.value || setupError.value || runtimeStatus.value?.safeError) ? 'failed'
          : 'connecting'
    ));
    const displayUrl = Vue.computed(() => snapshot.value?.activeUrl || '');
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
      if (disposed || installing.value
          || !['installing', 'probing'].includes(runtimeStatus.value?.state)) return;
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

    const startViewer = async (initialUrl = null) => {
      if (viewerLoading.value || !props.agentId || runtimeStatus.value?.ready !== true) return;
      viewerLoading.value = true;
      viewerError.value = '';
      try {
        const expectedSource = sourceRef();
        const sessions = await browser.listSessions(props.agentId);
        let selected = sessions.find(item => (
          item.state === 'ready' && browserSessionMatchesSource(item, expectedSource)
        )) || null;
        if (!selected) {
          selected = await browser.createSession({
            agentId: props.agentId,
            sourceRef: expectedSource,
            initialUrl: initialUrl || 'about:blank',
            locale: document.documentElement.lang || 'en-US',
            viewport: { width: 1280, height: 720, deviceScaleFactor: 1 },
          });
        }
        browserSessionId.value = selected.browserSessionId;
        address.value = initialUrl || (selected.activeUrl === 'about:blank' ? '' : selected.activeUrl);
        viewerLoading.value = false;
        await Vue.nextTick();
        await attach();
        if (initialUrl && selected.activeUrl !== initialUrl) {
          const deadline = Date.now() + 10_000;
          while (!browser.interactiveReady(props.agentId, selected.browserSessionId)) {
            if (Date.now() >= deadline) throw new Error(t('workbench.browserInteractionUnavailable'));
            await new Promise(resolve => setTimeout(resolve, 50));
          }
          browser.sendControl(props.agentId, selected.browserSessionId, { type: 'navigate', url: initialUrl });
        }
      } catch (cause) {
        viewerError.value = cause?.message || String(cause);
      } finally {
        viewerLoading.value = false;
      }
    };

    const navigate = async () => {
      const url = normalizeBrowserAddress(address.value);
      if (!url) {
        viewerError.value = t('workbench.browserAddressInvalid');
        return;
      }
      viewerError.value = '';
      if (!snapshot.value) {
        await startViewer(url);
        return;
      }
      navigating.value = true;
      try {
        if (!browser.sendControl(props.agentId, browserSessionId.value, { type: 'navigate', url })) {
          throw new Error(t('workbench.browserInteractionUnavailable'));
        }
        address.value = url;
      } catch (cause) {
        viewerError.value = cause?.message || String(cause);
      } finally {
        navigating.value = false;
      }
    };

    const pointerPosition = event => browserPointerPosition(event, video.value, snapshot.value?.viewport);
    const onPointerMove = event => {
      const position = pointerPosition(event);
      if (position) browser.sendPointer(props.agentId, browserSessionId.value, { type: 'pointerMove', ...position });
    };
    const buttonName = button => ['left', 'middle', 'right'][button] || 'left';
    const onPointerDown = event => {
      const position = pointerPosition(event);
      if (!position) return;
      video.value?.focus?.();
      video.value?.setPointerCapture?.(event.pointerId);
      input.pointerDown(buttonName(event.button), position);
    };
    const onPointerUp = event => {
      input.pointerUp(buttonName(event.button), pointerPosition(event));
    };
    const onWheel = event => browser.sendControl(props.agentId, browserSessionId.value, {
      type: 'wheel', deltaX: event.deltaX, deltaY: event.deltaY,
    });
    const onKeyDown = event => {
      if (input.keyDown(event)) event.preventDefault();
    };
    const onKeyUp = event => {
      if (input.keyUp(event.key)) event.preventDefault();
    };
    const onCompositionStart = () => input.compositionStart();
    const onCompositionEnd = event => input.compositionEnd(event.data);
    const releaseInput = () => input.reset();

    const refreshRuntime = async ({ startWhenReady = false, preserveError = false } = {}) => {
      if (runtimeLoading.value || !props.agentId || browser.protocolSupported !== true) return;
      runtimeLoading.value = true;
      if (!preserveError) setupError.value = '';
      try {
        const status = await browser.getRuntimeStatus(props.agentId);
        if (disposed) return;
        if (['installing', 'probing'].includes(status.state)) scheduleStatusPoll();
        else clearStatusPoll();
        if (startWhenReady && status.ready === true && snapshot.value) await attach();
      } catch (cause) {
        if (!preserveError || !setupError.value) {
          setupError.value = cause?.message || String(cause);
        }
      } finally {
        runtimeLoading.value = false;
      }
    };

    const setupRuntime = async () => {
      const current = runtimeStatus.value;
      if (setupInProgress.value || !current) return;
      const needsInstall = !current.installed;
      if (needsInstall) installing.value = true;
      else enabling.value = true;
      setupError.value = '';
      clearStatusPoll();
      try {
        await browser.setupRuntime(props.agentId, current);
      } catch (cause) {
        setupError.value = cause?.message || String(cause);
        await refreshRuntime({ preserveError: true });
      } finally {
        installing.value = false;
        enabling.value = false;
        scheduleStatusPoll();
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

    const onWindowBlur = () => releaseInput();
    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') releaseInput();
    };

    Vue.onMounted(() => {
      window.addEventListener('blur', onWindowBlur);
      document.addEventListener('visibilitychange', onVisibilityChange);
      if (browser.protocolSupported !== true) return;
      void refreshRuntime();
    });

    Vue.watch(() => browser.protocolSupported, (supported, previous) => {
      if (supported === true && previous !== true) void refreshRuntime();
      if (supported === false) setupError.value = t('workbench.browserProtocolUnavailable');
    });

    Vue.watch(() => props.runtimeReady, (ready, previous) => {
      if (!ready || previous === true || disposed) return;
      delete browser.runtimeStatus[props.agentId];
      void refreshRuntime();
    });

    Vue.watch(() => runtimeStatus.value?.state, state => {
      if (['installing', 'probing'].includes(state)) scheduleStatusPoll();
      else clearStatusPoll();
    });

    Vue.watch(displayUrl, url => {
      if (url && url !== 'about:blank' && document.activeElement?.closest?.('.browser-location') == null) {
        address.value = url;
      }
    });

    Vue.onUnmounted(() => {
      disposed = true;
      clearStatusPoll();
      window.removeEventListener('blur', onWindowBlur);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      releaseInput();
      if (browserSessionId.value) browser.detach(props.agentId, browserSessionId.value, { notify: true });
    });

    return {
      video,
      runtimeLoading,
      installing,
      enabling,
      viewerLoading,
      closing,
      navigating,
      address,
      setupError,
      displayError,
      runtimeStatus,
      runtimeInstalling,
      setupInProgress,
      downloadSize,
      progressPercent,
      progressText,
      snapshot,
      connected,
      connectionClass,
      displayUrl,
      statusText,
      refreshRuntime,
      setupRuntime,
      attach,
      startViewer,
      navigate,
      onPointerMove,
      onPointerDown,
      onPointerUp,
      onWheel,
      onKeyDown,
      onKeyUp,
      onCompositionStart,
      onCompositionEnd,
      releaseInput,
      closeBrowser,
    };
  },
};
