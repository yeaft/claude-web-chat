/**
 * BtwOverlay — Ephemeral overlay for /btw side questions.
 * Shows question + streaming answer in a centered card with backdrop.
 * Closes on Esc / Enter / Space.
 */

export default {
  name: 'BtwOverlay',
  template: `
    <Teleport to="body">
      <div v-if="store.btwVisible" class="btw-overlay" @click.self="close" @keydown="onKeydown" tabindex="-1" ref="overlayRef">
        <div class="btw-card">
          <div class="btw-question">{{ store.btwQuestion }}</div>
          <div class="btw-divider"></div>
          <div class="btw-answer" ref="answerRef">
            <div v-if="renderedAnswer" v-html="renderedAnswer" class="btw-answer-content markdown-body"></div>
            <span v-if="store.btwLoading && !store.btwAnswer" class="btw-loading-dots">
              <span></span><span></span><span></span>
            </span>
            <span v-if="store.btwLoading && store.btwAnswer" class="btw-cursor"></span>
          </div>
          <div class="btw-footer">
            <span class="btw-hint">Press Esc to close</span>
          </div>
        </div>
      </div>
    </Teleport>
  `,
  setup() {
    const store = Pinia.useChatStore();
    const overlayRef = Vue.ref(null);
    const answerRef = Vue.ref(null);

    const renderedAnswer = Vue.computed(() => {
      if (!store.btwAnswer) return '';
      try {
        return marked.parse(store.btwAnswer);
      } catch {
        return store.btwAnswer;
      }
    });

    // Auto-scroll answer area as content streams in
    Vue.watch(() => store.btwAnswer, () => {
      Vue.nextTick(() => {
        if (answerRef.value) {
          answerRef.value.scrollTop = answerRef.value.scrollHeight;
        }
      });
    });

    // Focus overlay on mount for keyboard events
    Vue.watch(() => store.btwVisible, (visible) => {
      if (visible) {
        Vue.nextTick(() => {
          overlayRef.value?.focus();
        });
      }
    });

    function close() {
      store.closeBtw();
    }

    function onKeydown(e) {
      if (e.key === 'Escape' || (!store.btwLoading && (e.key === 'Enter' || e.key === ' '))) {
        e.preventDefault();
        close();
      }
    }

    return {
      store,
      overlayRef,
      answerRef,
      renderedAnswer,
      close,
      onKeydown
    };
  }
};
