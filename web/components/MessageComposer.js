export default {
  name: 'MessageComposer',
  props: {
    modelValue: { type: String, default: '' },
    placeholder: { type: String, default: '' },
    disabled: { type: Boolean, default: false },
    canSend: { type: Boolean, default: false },
    sending: { type: Boolean, default: false },
    showStop: { type: Boolean, default: false },
    rows: { type: Number, default: 2 },
    inputId: { type: String, default: '' },
    sendLabel: { type: String, default: '' },
    stopLabel: { type: String, default: '' },
    ariaAutocomplete: { type: String, default: null },
    ariaHaspopup: { type: String, default: null },
    ariaControls: { type: String, default: null },
    ariaActivedescendant: { type: String, default: null },
  },
  emits: ['update:modelValue', 'input', 'keydown', 'paste', 'blur', 'send', 'stop'],
  setup(props, { emit }) {
    const textareaRef = Vue.ref(null);
    const textareaScrollable = Vue.ref(false);
    const maxTextareaHeight = 120;

    const autoResize = () => {
      const textarea = textareaRef.value;
      if (!textarea) return;
      textarea.style.height = 'auto';
      const nextHeight = Math.min(textarea.scrollHeight, maxTextareaHeight);
      textarea.style.height = `${nextHeight}px`;
      textareaScrollable.value = textarea.scrollHeight > maxTextareaHeight;
    };

    const resetTextareaSize = () => {
      const textarea = textareaRef.value;
      if (!textarea) return;
      textarea.style.height = 'auto';
      textareaScrollable.value = false;
    };

    const onInput = (event) => {
      emit('update:modelValue', event.target.value);
      emit('input', event);
      autoResize();
    };

    const focusInput = () => Vue.nextTick(() => textareaRef.value?.focus());
    const getTextarea = () => textareaRef.value;

    Vue.watch(() => props.modelValue, (value) => {
      Vue.nextTick(() => {
        if (value) autoResize();
        else resetTextareaSize();
      });
    });

    Vue.onMounted(autoResize);

    return {
      textareaRef,
      textareaScrollable,
      autoResize,
      resetTextareaSize,
      focusInput,
      getTextarea,
      onInput,
      emit,
    };
  },
  template: `
    <div class="input-wrapper chat-composer" data-message-composer>
      <div class="textarea-wrapper">
        <slot name="overlays"></slot>
        <textarea
          ref="textareaRef"
          :value="modelValue"
          :id="inputId || null"
          :rows="rows"
          :class="{ 'is-scrollable': textareaScrollable }"
          :placeholder="placeholder"
          :disabled="disabled"
          :aria-autocomplete="ariaAutocomplete"
          :aria-haspopup="ariaHaspopup"
          :aria-controls="ariaControls"
          :aria-activedescendant="ariaActivedescendant"
          @input="onInput"
          @keydown="$emit('keydown', $event)"
          @paste="$emit('paste', $event)"
          @blur="$emit('blur', $event)"
        ></textarea>
      </div>
      <div class="chat-composer-actions">
        <div class="chat-composer-actions-start"><slot name="start-actions"></slot></div>
        <div class="chat-composer-actions-end">
          <slot name="end-actions-before"></slot>
          <button
            v-if="showStop"
            type="button"
            class="send-btn stop-btn"
            @click="$emit('stop')"
            :title="stopLabel"
            :aria-label="stopLabel"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>
          </button>
          <button
            type="button"
            class="send-btn"
            @click="$emit('send')"
            :disabled="!canSend"
            :title="sendLabel"
            :aria-label="sendLabel"
          >
            <span v-if="sending" class="message-composer-spinner" aria-hidden="true"></span>
            <svg v-else viewBox="0 0 24 24" aria-hidden="true"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>
          </button>
        </div>
      </div>
    </div>
  `,
};
