const queue = [];
let activeRequest = null;
let requestId = 0;

let state = null;

function getState() {
  if (!state) {
    state = Vue.reactive({
      open: false,
      id: 0,
      type: 'alert',
      title: '',
      message: '',
      value: '',
      confirmLabel: '',
      cancelLabel: '',
      destructive: false,
    });
  }
  return state;
}

function showNext() {
  if (activeRequest || queue.length === 0) return;
  activeRequest = queue.shift();
  Object.assign(getState(), {
    open: true,
    id: activeRequest.id,
    type: activeRequest.type,
    title: activeRequest.options.title || '',
    message: activeRequest.options.message || '',
    value: activeRequest.options.defaultValue || '',
    confirmLabel: activeRequest.options.confirmLabel || '',
    cancelLabel: activeRequest.options.cancelLabel || '',
    destructive: activeRequest.options.destructive === true,
  });
}

function request(type, message, options = {}) {
  return new Promise(resolve => {
    queue.push({
      id: ++requestId,
      type,
      options: { ...options, message: String(message || '') },
      resolve,
    });
    showNext();
  });
}

export function alertDialog(message, options) {
  return request('alert', message, options);
}

export function confirmDialog(message, options) {
  return request('confirm', message, options);
}

export function promptDialog(message, defaultValue = '', options = {}) {
  return request('prompt', message, { ...options, defaultValue });
}

export function resolveDialog(confirmed, value = '') {
  if (!activeRequest) return;
  const current = activeRequest;
  activeRequest = null;
  getState().open = false;
  if (current.type === 'alert') current.resolve(undefined);
  else if (current.type === 'confirm') current.resolve(confirmed === true);
  else current.resolve(confirmed ? value : null);
  Vue.nextTick(showNext);
}

export function useDialogState() {
  return getState();
}
