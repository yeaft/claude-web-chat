// @vitest-environment happy-dom
import { mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Vue from 'vue';
import VirtualTranscript from '../../web/components/VirtualTranscript.js';

function turns(count, prefix = 'turn') {
  return Array.from({ length: count }, (_, index) => ({
    id: `${prefix}-${index}`,
    type: 'assistant-turn',
    text: `assistant response ${index}`,
    toolMsgs: [],
  }));
}

function createScroller({ viewportHeight = 300, scrollHeight = 100000 } = {}) {
  const el = document.createElement('div');
  el.className = 'chat-container';
  let scrollTop = 0;
  Object.defineProperties(el, {
    clientHeight: { configurable: true, get: () => viewportHeight },
    scrollHeight: { configurable: true, get: () => scrollHeight },
    scrollTop: {
      configurable: true,
      get: () => scrollTop,
      set: value => { scrollTop = Math.max(0, Number(value) || 0); },
    },
  });
  document.body.appendChild(el);
  return el;
}

function renderedIds(wrapper) {
  return wrapper.findAll('[data-turn-id]').map(node => node.attributes('data-turn-id'));
}

async function flushAnimationFrame(rounds = 1) {
  for (let round = 0; round < rounds; round += 1) {
    await new Promise(resolve => setTimeout(resolve, 5));
    await Vue.nextTick();
  }
}

function stubVirtualRowHeight(height) {
  const original = HTMLElement.prototype.getBoundingClientRect;
  let measurementCalls = 0;
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function getBoundingClientRect() {
    if (this.classList?.contains('virtual-transcript-item')) {
      measurementCalls += 1;
      return {
        x: 0,
        y: 0,
        top: 0,
        right: 100,
        bottom: height,
        left: 0,
        width: 100,
        height,
        toJSON: () => ({}),
      };
    }
    return original.call(this);
  });
  return () => measurementCalls;
}

describe('VirtualTranscript DOM windowing', () => {
  let rafTimers;
  let rafSequence;

  beforeEach(() => {
    globalThis.Vue = Vue;
    rafTimers = new Map();
    rafSequence = 0;
    vi.stubGlobal('ResizeObserver', undefined);
    vi.stubGlobal('requestAnimationFrame', (callback) => {
      const id = ++rafSequence;
      const timer = setTimeout(() => {
        rafTimers.delete(id);
        callback(performance.now());
      }, 0);
      rafTimers.set(id, timer);
      return id;
    });
    vi.stubGlobal('cancelAnimationFrame', (id) => {
      const timer = rafTimers.get(id);
      if (timer) clearTimeout(timer);
      rafTimers.delete(id);
    });
  });

  afterEach(() => {
    for (const timer of rafTimers.values()) clearTimeout(timer);
    document.body.innerHTML = '';
    delete globalThis.Vue;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });





  it('fences stale bottom work and keeps a tall targeted row aligned to its first line', async () => {
    const scroller = createScroller({ viewportHeight: 300, scrollHeight: 10000 });
    scroller.scrollTop = 9700;
    let rowHeight = 90;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function getBoundingClientRect() {
      if (this.classList?.contains('virtual-transcript-item')) {
        return { x: 0, y: 0, top: 0, right: 100, bottom: rowHeight, left: 0, width: 100, height: rowHeight, toJSON: () => ({}) };
      }
      return { x: 0, y: 0, top: 0, right: 0, bottom: 0, left: 0, width: 0, height: 0, toJSON: () => ({}) };
    });

    const rafCallbacks = new Map();
    let nextRafId = 0;
    vi.stubGlobal('requestAnimationFrame', (callback) => {
      const id = ++nextRafId;
      rafCallbacks.set(id, callback);
      return id;
    });
    vi.stubGlobal('cancelAnimationFrame', id => rafCallbacks.delete(id));
    let resizeCallback;
    vi.stubGlobal('ResizeObserver', class ResizeObserver {
      constructor(callback) { resizeCallback = callback; }
      observe() {}
      unobserve() {}
      disconnect() {}
    });
    const flushRafs = async () => {
      const callbacks = Array.from(rafCallbacks.values());
      rafCallbacks.clear();
      callbacks.forEach(callback => callback(performance.now()));
      await Vue.nextTick();
    };

    const wrapper = mount(VirtualTranscript, {
      props: { items: turns(20), estimateHeight: () => 90, initialAlign: 'end', itemGap: 0, overscan: 1 },
      slots: { default: ({ item }) => Vue.h('div', { 'data-turn-id': item.id }, item.id) },
      attachTo: scroller,
    });
    await Vue.nextTick();
    await flushRafs();
    await flushRafs();

    const row = wrapper.get('.virtual-transcript-item').element;
    rowHeight = 120;
    resizeCallback([{ target: row }]);
    const queuedMeasurement = Array.from(rafCallbacks.values()).at(-1);
    rafCallbacks.clear();
    queuedMeasurement(performance.now());
    wrapper.vm.cancelPendingBottomFollow();
    scroller.scrollTop = 3000;
    await Vue.nextTick();
    await flushRafs();
    expect(scroller.scrollTop).toBe(3000);

    wrapper.vm.setBottomFollowEnabled(false);
    scroller.scrollTop = 9700;
    rowHeight = 150;
    resizeCallback([{ target: row }]);
    await flushRafs();
    await Vue.nextTick();
    await flushRafs();
    // The measured row sits above the visible window, so preserving the same
    // content anchor adds its 30px height delta rather than pinning the tail.
    expect(scroller.scrollTop).toBe(9730);

    wrapper.vm.setBottomFollowEnabled(true);
    rowHeight = 180;
    resizeCallback([{ target: row }]);
    await flushRafs();
    await Vue.nextTick();
    await flushRafs();
    expect(scroller.scrollTop).toBe(10000);

    // Targeted search owns the viewport even when the block is taller than it.
    // The rendered message row is aligned to the viewport start, then re-aligned
    // after a later layout shift instead of leaving the first line above view.
    scroller.getBoundingClientRect = () => ({
      x: 0, y: 0, top: 100, right: 800, bottom: 400, left: 0, width: 800, height: 300, toJSON: () => ({}),
    });
    let targetTop = 650;
    const target = wrapper.get('.virtual-transcript-item').element;
    vi.spyOn(target, 'getBoundingClientRect').mockImplementation(() => ({
      x: 0, y: targetTop, top: targetTop, right: 100, bottom: targetTop + 1200, left: 0, width: 100, height: 1200, toJSON: () => ({}),
    }));
    expect(wrapper.vm.anchorTarget(target.dataset.virtualId, target, { align: 'start' })).toBe(true);
    const afterFirstAlignment = scroller.scrollTop;
    expect(afterFirstAlignment).toBe(10550);

    targetTop = 180;
    expect(wrapper.vm.anchorTarget(target.dataset.virtualId, target, { align: 'start' })).toBe(true);
    expect(scroller.scrollTop).toBe(afterFirstAlignment + 80);
    wrapper.unmount();
  });




});
