const OFFSCREEN_PATH = 'offscreen.html';
let offscreenCreation = null;

async function ensureOffscreenDocument() {
  const documentUrl = chrome.runtime.getURL(OFFSCREEN_PATH);
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [documentUrl],
  });
  if (contexts.length > 0) return;
  if (!offscreenCreation) {
    offscreenCreation = chrome.offscreen.createDocument({
      url: OFFSCREEN_PATH,
      reasons: ['USER_MEDIA', 'WEB_RTC'],
      justification: 'Capture the Agent-owned tab and provide the Browser Runtime WebRTC endpoint',
    }).finally(() => { offscreenCreation = null; });
  }
  await offscreenCreation;
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab?.id) throw new Error('active tab unavailable');
  return tab;
}

async function runStartupProbe() {
  const tab = await activeTab();
  const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
  await ensureOffscreenDocument();
  return chrome.runtime.sendMessage({
    target: 'browser_runtime_offscreen',
    type: 'browser_runtime_probe_media',
    streamId,
  });
}

async function startRuntime(browserRuntimeLaunch) {
  if (!browserRuntimeLaunch?.browserSessionId || !browserRuntimeLaunch?.bridgeUrl) {
    throw new Error('Browser Runtime launch authorization missing');
  }
  const tab = await activeTab();
  const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
  await ensureOffscreenDocument();
  const response = await chrome.runtime.sendMessage({
    target: 'browser_runtime_offscreen',
    type: 'browser_runtime_start',
    browserSessionId: browserRuntimeLaunch.browserSessionId,
    bridgeUrl: browserRuntimeLaunch.bridgeUrl,
    streamId,
  });
  await chrome.storage.session.remove('browserRuntimeLaunch');
  return response;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'browser_runtime_bootstrap') {
    sendResponse({ ok: true });
    return undefined;
  }
  if (message?.type !== 'browser_runtime_probe_start'
      && message?.type !== 'browser_runtime_action') return undefined;
  let runningProbe = message.type === 'browser_runtime_probe_start';
  const operation = async () => {
    if (runningProbe) return runStartupProbe();
    const { browserRuntimeLaunch } = await chrome.storage.session.get('browserRuntimeLaunch');
    if (browserRuntimeLaunch) return startRuntime(browserRuntimeLaunch);
    runningProbe = true;
    return runStartupProbe();
  };
  operation().then(async result => {
    if (runningProbe) {
      await chrome.storage.session.set({ browserRuntimeProbe: result });
    }
    sendResponse(result);
  }, async error => {
    const result = {
      ok: false,
      code: message.type === 'browser_runtime_probe_start' ? 'capture_probe_failed' : 'browser_runtime_start_failed',
      safeError: String(error?.message || error).slice(0, 500),
    };
    if (runningProbe) {
      await chrome.storage.session.set({ browserRuntimeProbe: result });
    }
    sendResponse(result);
  });
  return true;
});
