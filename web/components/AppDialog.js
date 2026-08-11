import { resolveDialog, useDialogState } from '../utils/dialog.js';

export default {
  name: 'AppDialog',
  setup() {
    const state = useDialogState();
    const input = Vue.ref(null);

    const focusPrimaryControl = () => {
      Vue.nextTick(() => {
        if (state.type === 'prompt') input.value?.focus?.();
        else document.querySelector('.app-dialog-confirm')?.focus?.();
      });
    };

    Vue.watch(() => state.id, focusPrimaryControl);

    const cancel = () => {
      if (state.type === 'alert') resolveDialog(true);
      else resolveDialog(false);
    };
    const confirm = () => resolveDialog(true, state.value);
    const onKeydown = event => {
      if (event.key === 'Escape') {
        event.preventDefault();
        cancel();
      }
    };
    const onDocumentKeydown = event => {
      if (state.open) onKeydown(event);
    };

    Vue.onMounted(() => document.addEventListener('keydown', onDocumentKeydown));
    Vue.onBeforeUnmount(() => document.removeEventListener('keydown', onDocumentKeydown));

    return { state, input, cancel, confirm, onKeydown };
  },
  template: `
    <Teleport to="body">
      <div v-if="state.open" class="modal-overlay app-dialog-overlay" @keydown="onKeydown" @click.self="cancel">
        <section class="modal app-dialog" role="dialog" aria-modal="true" :aria-labelledby="'app-dialog-title-' + state.id" :aria-describedby="'app-dialog-message-' + state.id">
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
