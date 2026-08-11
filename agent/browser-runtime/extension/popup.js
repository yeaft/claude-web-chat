const bootstrap = new URLSearchParams(location.search).get('bootstrap') === '1';
chrome.runtime.sendMessage({
  type: bootstrap ? 'browser_runtime_bootstrap' : 'browser_runtime_action',
}).catch(() => {});
