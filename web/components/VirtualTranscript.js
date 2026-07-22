import {
  buildVirtualOffsets,
  computeVirtualWindowFromLayout,
  estimateVirtualItemHeight,
  getVirtualItemKey,
  shouldFollowTranscriptBottom,
  virtualScrollTopForIndex,
  virtualTranscriptDefaults,
} from '../utils/virtual-transcript.js';

const HEIGHT_CHANGE_THRESHOLD = 2;

export default {
  name: 'VirtualTranscript',
  props: {
    items: { type: Array, default: () => [] },
    overscan: { type: Number, default: virtualTranscriptDefaults.overscan },
    itemGap: { type: Number, default: virtualTranscriptDefaults.itemGap },
    estimateHeight: { type: Function, default: estimateVirtualItemHeight },
    initialAlign: { type: String, default: 'start' },
  },
  emits: ['scroll-state'],
  template: `
    <div class="virtual-transcript" ref="rootRef">
      <div
        v-if="topSpacerHeight > 0"
        class="virtual-transcript-spacer"
        :style="{ height: topSpacerHeight + 'px' }"
        aria-hidden="true"
      ></div>
      <div class="virtual-transcript-window" :style="{ gap: itemGap + 'px' }">
        <div
          v-for="entry in visibleEntries"
          :key="entry.key"
          class="virtual-transcript-item"
          :data-virtual-index="entry.index"
          :data-virtual-id="entry.key"
          :ref="el => setItemRef(entry.key, entry.index, el)"
        >
          <slot :item="entry.item" :index="entry.index"></slot>
        </div>
      </div>
      <div
        v-if="bottomSpacerHeight > 0"
        class="virtual-transcript-spacer"
        :style="{ height: bottomSpacerHeight + 'px' }"
        aria-hidden="true"
      ></div>
    </div>
  `,
  setup(props, { emit, expose }) {
    const rootRef = Vue.ref(null);
    const scrollEl = Vue.ref(null);
    let initialEndPending = props.initialAlign === 'end';
    const scrollTop = Vue.ref(initialEndPending ? Number.MAX_SAFE_INTEGER : 0);
    const viewportHeight = Vue.ref(virtualTranscriptDefaults.viewportHeight);
    const heightCache = Vue.reactive({});
    const itemIndexByKey = new Map();
    const itemEls = new Map();
    const pendingMeasurements = new Map();
    let resizeObserver = null;
    let rafId = null;
    let measureRafId = null;
    let scrollAdjustRafId = null;
    let pendingScrollDelta = 0;
    let pendingScrollToBottom = false;

    // Item offsets only change when the items, estimates, or measured heights
    // change. Keep them out of the scroll-dependent computed so wheel/touch
    // events only do binary range lookup plus a small visible slice.
    const virtualLayout = Vue.computed(() => buildVirtualOffsets(props.items, heightCache, {
      itemGap: props.itemGap,
      estimateHeight: props.estimateHeight,
    }));
    const virtualWindow = Vue.computed(() => computeVirtualWindowFromLayout(props.items, virtualLayout.value, {
      scrollTop: scrollTop.value,
      viewportHeight: viewportHeight.value,
      overscan: props.overscan,
    }));

    const visibleEntries = Vue.computed(() => virtualWindow.value.items);
    const topSpacerHeight = Vue.computed(() => virtualWindow.value.topSpacerHeight);
    const bottomSpacerHeight = Vue.computed(() => virtualWindow.value.bottomSpacerHeight);

    function emitScrollState(el) {
      if (!el) return;
      emit('scroll-state', {
        scrollTop: el.scrollTop || 0,
        scrollHeight: el.scrollHeight || 0,
        clientHeight: el.clientHeight || 0,
      });
    }

    function readScrollState() {
      const el = scrollEl.value;
      if (!el) return;
      viewportHeight.value = Math.max(1, el.clientHeight || virtualTranscriptDefaults.viewportHeight);
      // Preserve the synthetic tail position until the first non-empty item
      // set is mounted. Otherwise an async history response briefly mounts the
      // oldest Markdown/Mermaid rows before MessageList scrolls to the latest.
      if (!(initialEndPending && props.items.length === 0)) {
        scrollTop.value = Math.max(0, el.scrollTop || 0);
      }
      emitScrollState(el);
    }

    function alignInitialEnd() {
      const el = scrollEl.value;
      if (!initialEndPending || props.initialAlign !== 'end' || props.items.length === 0 || !el) {
        return false;
      }
      el.scrollTop = el.scrollHeight;
      initialEndPending = false;
      readScrollState();
      return true;
    }

    function syncInitialPosition() {
      if (!alignInitialEnd()) readScrollState();
    }

    function scheduleReadScrollState() {
      if (rafId) return;
      rafId = requestAnimationFrame(() => {
        rafId = null;
        readScrollState();
      });
    }

    function isNearBottom(el) {
      if (!el) return true;
      return shouldFollowTranscriptBottom({
        scrollTop: el.scrollTop,
        scrollHeight: el.scrollHeight,
        clientHeight: el.clientHeight,
        threshold: virtualTranscriptDefaults.bottomThreshold,
      });
    }

    function scheduleScrollAdjustment({ delta = 0, toBottom = false } = {}) {
      if (Math.abs(delta) >= HEIGHT_CHANGE_THRESHOLD) pendingScrollDelta += delta;
      if (toBottom) pendingScrollToBottom = true;
      if (scrollAdjustRafId) return;
      scrollAdjustRafId = requestAnimationFrame(() => {
        scrollAdjustRafId = null;
        const scroller = scrollEl.value;
        if (!scroller) {
          pendingScrollDelta = 0;
          pendingScrollToBottom = false;
          return;
        }
        if (pendingScrollToBottom) {
          scroller.scrollTop = scroller.scrollHeight;
        } else if (Math.abs(pendingScrollDelta) >= HEIGHT_CHANGE_THRESHOLD) {
          scroller.scrollTop += pendingScrollDelta;
        }
        pendingScrollDelta = 0;
        pendingScrollToBottom = false;
        readScrollState();
      });
    }

    function scheduleMeasureElement(key, index, el) {
      if (!key || !el) return;
      pendingMeasurements.set(key, { index, el });
      if (measureRafId) return;
      measureRafId = requestAnimationFrame(() => {
        measureRafId = null;
        const entries = Array.from(pendingMeasurements.entries());
        pendingMeasurements.clear();
        commitMeasurements(entries);
      });
    }

    function commitMeasurements(entries) {
      // Read every DOM height before touching reactive state. Each cache write
      // invalidates virtualLayout, so reading virtualWindow between writes would
      // rebuild all offsets once per mounted row.
      const measurements = [];
      for (const [key, entry] of entries) {
        const el = entry?.el;
        if (!el) continue;
        const nextHeight = Math.ceil(el.getBoundingClientRect?.().height || el.offsetHeight || 0);
        if (!Number.isFinite(nextHeight) || nextHeight <= 0) continue;
        const previousHeight = heightCache[key];
        if (previousHeight === nextHeight) continue;
        const mappedIndex = itemIndexByKey.get(key);
        measurements.push({
          key,
          nextHeight,
          previousHeight,
          itemIndex: Number.isFinite(mappedIndex) ? mappedIndex : entry.index,
        });
      }
      if (!measurements.length) return;

      const scroller = scrollEl.value;
      const wasNearBottom = isNearBottom(scroller);
      const windowStart = virtualWindow.value.visibleStart;
      let anchorDelta = 0;
      let shouldScrollToBottom = false;

      // Do not read virtualWindow or virtualLayout in this loop. Vue can then
      // collapse all cache invalidations into one render/layout recomputation.
      for (const measurement of measurements) {
        const {
          key,
          nextHeight,
          previousHeight,
          itemIndex,
        } = measurement;
        heightCache[key] = nextHeight;
        if (!scroller || !Number.isFinite(previousHeight)) continue;

        const delta = nextHeight - previousHeight;
        if (Math.abs(delta) < HEIGHT_CHANGE_THRESHOLD) continue;
        if (Number.isFinite(itemIndex) && itemIndex < windowStart) {
          anchorDelta += delta;
        } else if (wasNearBottom) {
          shouldScrollToBottom = true;
        }
      }

      const hasAnchorAdjustment = Math.abs(anchorDelta) >= HEIGHT_CHANGE_THRESHOLD;
      if (!hasAnchorAdjustment && !shouldScrollToBottom) return;
      const adjustment = { delta: anchorDelta, toBottom: shouldScrollToBottom };
      if (shouldScrollToBottom) {
        Vue.nextTick(() => scheduleScrollAdjustment(adjustment));
      } else {
        scheduleScrollAdjustment(adjustment);
      }
    }

    function observeItem(key, index, el) {
      itemIndexByKey.set(key, index);
      if (!el) return;
      itemEls.set(key, el);
      if (resizeObserver) resizeObserver.observe(el);
      Vue.nextTick(() => scheduleMeasureElement(key, index, el));
    }

    function setItemRef(key, index, el) {
      if (!key) return;
      const previousEl = itemEls.get(key);
      if (previousEl && previousEl !== el && resizeObserver) resizeObserver.unobserve(previousEl);
      if (!el) {
        itemEls.delete(key);
        return;
      }
      observeItem(key, index, el);
    }

    async function scrollToIndex(index, { align = 'center' } = {}) {
      const safeIndex = Number.isFinite(index) ? Math.floor(index) : -1;
      const scroller = scrollEl.value;
      if (!scroller || safeIndex < 0 || safeIndex >= props.items.length) return false;
      const key = getVirtualItemKey(props.items[safeIndex], safeIndex);
      scroller.scrollTop = virtualScrollTopForIndex(props.items, safeIndex, heightCache, {
        itemGap: props.itemGap,
        estimateHeight: props.estimateHeight,
        viewportHeight: scroller.clientHeight || viewportHeight.value,
        align,
      });
      readScrollState();
      await Vue.nextTick();
      const target = itemEls.get(key);
      if (target?.scrollIntoView) target.scrollIntoView({ block: align, inline: 'nearest' });
      readScrollState();
      return true;
    }

    function scrollToKey(key, options = {}) {
      const index = itemIndexByKey.get(String(key));
      return Number.isFinite(index) ? scrollToIndex(index, options) : Promise.resolve(false);
    }

    expose({ scrollToKey, scrollToIndex });

    Vue.watch(
      () => props.items.map((item, index) => getVirtualItemKey(item, index)).join('\n'),
      () => {
        itemIndexByKey.clear();
        props.items.forEach((item, index) => itemIndexByKey.set(getVirtualItemKey(item, index), index));
        Vue.nextTick(syncInitialPosition);
      },
      { immediate: true },
    );

    Vue.onMounted(() => {
      scrollEl.value = rootRef.value?.closest?.('.chat-container') || rootRef.value?.parentElement || null;
      syncInitialPosition();
      scrollEl.value?.addEventListener('scroll', scheduleReadScrollState, { passive: true });
      window.addEventListener('resize', scheduleReadScrollState);

      if (typeof ResizeObserver !== 'undefined') {
        resizeObserver = new ResizeObserver((entries) => {
          for (const entry of entries) {
            const key = entry.target?.dataset?.virtualId;
            const index = Number(entry.target?.dataset?.virtualIndex);
            if (key) scheduleMeasureElement(key, index, entry.target);
          }
        });
        for (const [key, el] of itemEls.entries()) {
          const index = itemIndexByKey.get(key) ?? Number(el.dataset?.virtualIndex || 0);
          observeItem(key, index, el);
        }
      }
    });

    Vue.onBeforeUnmount(() => {
      scrollEl.value?.removeEventListener('scroll', scheduleReadScrollState);
      window.removeEventListener('resize', scheduleReadScrollState);
      if (resizeObserver) resizeObserver.disconnect();
      if (rafId) cancelAnimationFrame(rafId);
      if (measureRafId) cancelAnimationFrame(measureRafId);
      if (scrollAdjustRafId) cancelAnimationFrame(scrollAdjustRafId);
      pendingMeasurements.clear();
      pendingScrollDelta = 0;
      pendingScrollToBottom = false;
    });

    return {
      rootRef,
      visibleEntries,
      topSpacerHeight,
      bottomSpacerHeight,
      setItemRef,
    };
  },
};
