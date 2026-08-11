import { resolveDialog, useDialogState } from '../utils/dialog.js';

const FOCUSABLE_SELECTOR = [
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'a[href]',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

export default {
  name: 'AppDialog',
  setup() {
    const state = useDialogState();
    const dialog = Vue.ref(null);
    const input = Vue.ref(null);
    let previousFocus = null;
    let backgroundElements = [];

    const setBackgroundInert = inert => {
      if (inert) {
        backgroundElements = Array.from(document.body.children).filter(element => (
          element !== dialog.value?.closest('.app-dialog-overlay')
          && !element.classList.contains('app-dialog-overlay')
        ));
        backgroundElements.forEach(element => { element.inert = true; });
        return;
      }
      backgroundElements.forEach(element => { element.inert = false; });
      backgroundElements = [];
    };

    const focusPrimaryControl = () => {
      Vue.nextTick(() => {
        if (state.type === 'prompt') input.value?.focus?.();
        else dialog.value?.querySelector('.app-dialog-confirm')?.focus?.();
      });
    };

    Vue.watch(() => state.open, (open, wasOpen) => {
      if (open && !wasOpen) {
        previousFocus = document.activeElement;
        Vue.nextTick(() => setBackgroundInert(true));
      } else if (!open && wasOpen) {
        setBackgroundInert(false);
        Vue.nextTick(() => {
          if (previousFocus?.isConnected) previousFocus.focus?.();
          previousFocus = null;
        });
      }
    });
    Vue.watch(() => state.id, focusPrimaryControl);

    const cancel = () => {
      if (state.type === 'alert') resolveDialog(true);
      else resolveDialog(false);
    };
    const confirm = () => resolveDialog(true, state.value);
    const trapFocus = event => {
      const controls = Array.from(dialog.value?.querySelectorAll(FOCUSABLE_SELECTOR) || []);
      if (controls.length === 0) {
        event.preventDefault();
        dialog.value?.focus?.();
        return;
      }
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    const onKeydown = event => {
      if (event.key === 'Escape') {
        event.preventDefault();
        cancel();
      } else if (event.key === 'Tab') {
        trapFocus(event);
      }
    };
    const onDocumentKeydown = event => {
      if (state.open) onKeydown(event);
    };

    Vue.onMounted(() => document.addEventListener('keydown', onDocumentKeydown));
    Vue.onBeforeUnmount(() => {
      document.removeEventListener('keydown', onDocumentKeydown);
      setBackgroundInert(false);
    });

    return { state, dialog, input, cancel, confirm, onKeydown };
  },
  template: `
    <Teleport to="body">
      <div v-if="state.open" class="modal-overlay app-dialog-overlay" @click.self="cancel">
        <section ref="dialog" class="modal app-dialog" role="dialog" aria-modal="true" tabindex="-1" :aria-labelledby="'app-dialog-title-' + state.id" :aria-describedby="'app-dialog-message-' + state.id">
          <header class="app-dialog-header">
            <h2 :id="'app-dialog-title-' + state.id">{{ state.title || 'Yeaft' }}</h2>
          </header>
          <div class="app-dialog-body">
            <p :id="'app-dialog-message-' + state.id">{{ state.message }}</p>
            <input
              v-if="state.type === 'prompt'"
              ref="input"
              v-model="state.value"
              class="app-dialog-input"
              type="text"
              @keydown.enter.prevent="confirm"
            >
          </div>
          <footer class="app-dialog-footer">
            <button v-if="state.type !== 'alert'" type="button" class="btn btn-secondary" @click="cancel">
              {{ state.cancelLabel || $t('common.cancel') }}
            </button>
            <button type="button" class="btn btn-primary app-dialog-confirm" :class="{ 'app-dialog-destructive': state.destructive }" @click="confirm">
              {{ state.confirmLabel || $t('common.confirm') }}
            </button>
          </footer>
        </section>
      </div>
    </Teleport>
  `,
};
