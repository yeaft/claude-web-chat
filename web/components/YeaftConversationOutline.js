function formatOutlineTime(value) {
  const timestamp = typeof value === 'number' ? value : Date.parse(value || '');
  if (!Number.isFinite(timestamp)) return '';
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(timestamp));
}

export default {
  name: 'YeaftConversationOutline',
  props: {
    outlineState: { type: Object, required: true },
    searchState: { type: Object, required: true },
    activeIndex: { type: Number, default: 0 },
  },
  emits: ['query', 'select', 'move', 'load-older', 'load-more-search', 'close'],
  template: `
    <section id="yeaft-conversation-outline" class="yeaft-conversation-outline" :aria-label="$t('yeaft.outline.label')">
      <div class="yeaft-conversation-outline-header">
        <div>
          <strong>{{ $t('yeaft.outline.title') }}</strong>
          <span class="yeaft-conversation-outline-count">{{ countLabel }}</span>
        </div>
        <button type="button" class="yeaft-conversation-outline-close" @click="$emit('close')" :aria-label="$t('common.close')">×</button>
      </div>
      <div class="yeaft-conversation-outline-search">
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>
        <input
          ref="inputRef"
          type="search"
          :value="searchState.query"
          :placeholder="$t('yeaft.outline.placeholder')"
          :aria-label="$t('yeaft.outline.placeholder')"
          @input="$emit('query', $event.target.value)"
          @keydown="onKeyDown"
        />
        <span v-if="searchState.loading" class="yeaft-conversation-outline-status">{{ $t('yeaft.outline.searching') }}</span>
      </div>
      <div
        ref="listRef"
        class="yeaft-conversation-outline-list"
        role="listbox"
        @scroll="onScroll"
      >
        <button
          v-if="!isSearching && outlineState.hasMore"
          type="button"
          class="yeaft-conversation-outline-more"
          :disabled="outlineState.loading"
          @click="loadOlder"
        >{{ outlineState.loading ? $t('yeaft.outline.loading') : $t('yeaft.outline.older') }}</button>
        <div v-if="errorKey" class="yeaft-conversation-outline-empty is-error">{{ $t(errorKey) }}</div>
        <div v-else-if="searchState.query.length === 1" class="yeaft-conversation-outline-empty">{{ $t('yeaft.outline.minChars') }}</div>
        <div v-else-if="!visibleResults.length && !isLoading" class="yeaft-conversation-outline-empty">{{ $t(isSearching ? 'yeaft.outline.noMatches' : 'yeaft.outline.empty') }}</div>
        <button
          v-for="(result, index) in visibleResults"
          :key="result.messageId"
          type="button"
          class="yeaft-conversation-outline-item"
          :class="{ active: index === activeIndex }"
          role="option"
          :aria-selected="index === activeIndex ? 'true' : 'false'"
          @mouseenter="$emit('move', index)"
          @click="$emit('select', result)"
        >
          <span class="yeaft-conversation-outline-meta">
            <span>{{ result.role === 'user' ? $t('yeaft.outline.you') : (result.speakerVpId || $t('yeaft.outline.assistant')) }}</span>
            <time v-if="result.timestamp">{{ formatOutlineTime(result.timestamp) }}</time>
          </span>
          <span class="yeaft-conversation-outline-snippet">{{ result.snippet || $t('yeaft.outline.nonText') }}</span>
        </button>
        <button
          v-if="isSearching && searchState.hasMore"
          type="button"
          class="yeaft-conversation-outline-more"
          :disabled="searchState.loading"
          @click="$emit('load-more-search')"
        >{{ $t('yeaft.outline.moreMatches') }}</button>
      </div>
    </section>
  `,
  setup(props, { emit, expose }) {
    const inputRef = Vue.ref(null);
    const listRef = Vue.ref(null);
    const isSearching = Vue.computed(() => String(props.searchState.query || '').trim().length >= 2);
    const visibleResults = Vue.computed(() => isSearching.value ? props.searchState.results : props.outlineState.results);
    const isLoading = Vue.computed(() => isSearching.value ? props.searchState.loading : props.outlineState.loading);
    const countLabel = Vue.computed(() => {
      if (isSearching.value) return `${props.searchState.results.length}${props.searchState.hasMore ? '+' : ''}`;
      const total = props.outlineState.totalCount;
      return Number.isFinite(total) ? String(total) : String(props.outlineState.results.length || '');
    });
    const errorKey = Vue.computed(() => {
      const error = isSearching.value ? props.searchState.error : props.outlineState.error;
      if (!error) return '';
      return error === 'unsupported' ? 'yeaft.outline.unsupported' : 'yeaft.outline.error';
    });
    const focus = () => Vue.nextTick(() => {
      inputRef.value?.focus?.();
      if (!isSearching.value && listRef.value) listRef.value.scrollTop = listRef.value.scrollHeight;
    });
    const loadOlder = () => {
      const list = listRef.value;
      emit('load-older', {
        scrollHeight: list?.scrollHeight || 0,
        scrollTop: list?.scrollTop || 0,
      });
    };
    const onScroll = () => {
      if (isSearching.value || props.outlineState.loading || !props.outlineState.hasMore) return;
      if ((listRef.value?.scrollTop || 0) <= 40) loadOlder();
    };
    const onKeyDown = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        emit('close');
      } else if (event.key === 'ArrowDown') {
        event.preventDefault();
        emit('move', Math.min(visibleResults.value.length - 1, props.activeIndex + 1));
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        emit('move', Math.max(0, props.activeIndex - 1));
      } else if (event.key === 'Enter' && visibleResults.value.length) {
        event.preventDefault();
        emit('select', visibleResults.value[props.activeIndex] || visibleResults.value[0]);
      }
    };
    Vue.watch(() => props.outlineState.results.length, (next, previous) => {
      if (previous !== 0 || next === 0 || isSearching.value) return;
      Vue.nextTick(() => {
        if (listRef.value) listRef.value.scrollTop = listRef.value.scrollHeight;
      });
    });
    const restoreOlderScroll = ({ scrollHeight = 0, scrollTop = 0 } = {}) => Vue.nextTick(() => {
      if (!listRef.value) return;
      listRef.value.scrollTop = scrollTop + Math.max(0, listRef.value.scrollHeight - scrollHeight);
    });
    expose({ focus, restoreOlderScroll });
    Vue.onMounted(focus);
    return { inputRef, listRef, isSearching, visibleResults, isLoading, countLabel, errorKey, focus, loadOlder, onScroll, onKeyDown, formatOutlineTime };
  },
};
