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
      justification: 'Capture the controlled tab and validate the Browser Runtime WebRTC media path',
    }).finally(() => { offscreenCreation = null; });
  }
  await offscreenCreation;
}

async function runStartupProbe() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab?.id) throw new Error('active tab unavailable');
  const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
  await ensureOffscreenDocument();
  return chrome.runtime.sendMessage({
    target: 'browser_runtime_offscreen',
    type: 'browser_runtime_probe_media',
    streamId,
  });
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'browser_runtime_probe_start') return undefined;
  runStartupProbe().then(async result => {
    await chrome.storage.session.set({ browserRuntimeProbe: result });
    sendResponse(result);
  }, async error => {
    const result = {
      ok: false,
      code: 'capture_probe_failed',
      safeError: String(error?.message || error).slice(0, 500),
    };
    await chrome.storage.session.set({ browserRuntimeProbe: result });
    sendResponse(result);
  });
  return true;
});
