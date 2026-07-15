function formatResultTime(value) {
  const timestamp = typeof value === 'number' ? value : Date.parse(value || '');
  if (!Number.isFinite(timestamp)) return '';
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(timestamp));
}

export default {
  name: 'YeaftTranscriptSearch',
  props: {
    state: { type: Object, required: true },
    activeIndex: { type: Number, default: 0 },
  },
  emits: ['query', 'select', 'move', 'load-more', 'close'],
  template: `
    <section id="yeaft-transcript-search" class="yeaft-transcript-search" :aria-label="$t('yeaft.historySearch.label')">
      <div class="yeaft-transcript-search-bar">
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>
        <input
          ref="inputRef"
          type="search"
          :value="state.query"
          :placeholder="$t('yeaft.historySearch.placeholder')"
          :aria-label="$t('yeaft.historySearch.label')"
          @input="$emit('query', $event.target.value)"
          @keydown="onKeyDown"
        />
        <span class="yeaft-transcript-search-status" aria-live="polite">
          <template v-if="state.loading">{{ $t('yeaft.historySearch.searching') }}</template>
          <template v-else-if="state.query && state.results.length">{{ activeIndex + 1 }} / {{ state.results.length }}{{ state.hasMore ? '+' : '' }}</template>
        </span>
        <button type="button" class="yeaft-transcript-search-close" @click="$emit('close')" :aria-label="$t('common.close')">×</button>
      </div>
      <div v-if="state.query.length === 1" class="yeaft-transcript-search-empty">{{ $t('yeaft.historySearch.minChars') }}</div>
      <div v-else-if="state.error === 'unsupported'" class="yeaft-transcript-search-empty is-error">{{ $t('yeaft.historySearch.unsupported') }}</div>
      <div v-else-if="state.error" class="yeaft-transcript-search-empty is-error">{{ $t('yeaft.historySearch.error') }}</div>
      <div v-else-if="state.query.length >= 2 && !state.loading && !state.results.length" class="yeaft-transcript-search-empty">{{ $t('yeaft.historySearch.empty') }}</div>
      <div v-if="state.results.length" class="yeaft-transcript-search-results" role="listbox">
        <button
          v-for="(result, index) in state.results"
          :key="result.messageId"
          type="button"
          class="yeaft-transcript-search-result"
          :class="{ active: index === activeIndex }"
          role="option"
          :aria-selected="index === activeIndex ? 'true' : 'false'"
          @mouseenter="$emit('move', index)"
          @click="$emit('select', result)"
        >
          <span class="yeaft-transcript-search-result-meta">
            <span>{{ result.role === 'user' ? $t('yeaft.historySearch.you') : (result.speakerVpId || $t('yeaft.historySearch.assistant')) }}</span>
            <time v-if="result.timestamp">{{ formatResultTime(result.timestamp) }}</time>
          </span>
          <span class="yeaft-transcript-search-result-snippet">{{ result.snippet }}</span>
        </button>
        <button v-if="state.hasMore" type="button" class="yeaft-transcript-search-more" :disabled="state.loading" @click="$emit('load-more')">{{ $t('yeaft.historySearch.more') }}</button>
      </div>
    </section>
  `,
  setup(props, { emit, expose }) {
    const inputRef = Vue.ref(null);
    const focus = () => Vue.nextTick(() => {
      inputRef.value?.focus?.();
      inputRef.value?.select?.();
    });
    const onKeyDown = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        emit('close');
      } else if (event.key === 'ArrowDown') {
        event.preventDefault();
        emit('move', Math.min(props.state.results.length - 1, props.activeIndex + 1));
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        emit('move', Math.max(0, props.activeIndex - 1));
      } else if (event.key === 'Enter' && props.state.results.length) {
        event.preventDefault();
        const delta = event.shiftKey ? -1 : 1;
        const index = (props.activeIndex + delta + props.state.results.length) % props.state.results.length;
        emit('move', index);
        emit('select', props.state.results[index]);
      }
    };
    expose({ focus });
    Vue.onMounted(focus);
    return { inputRef, focus, onKeyDown, formatResultTime };
  },
};
