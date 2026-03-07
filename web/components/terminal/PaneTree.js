/**
 * PaneTree — recursive split pane rendering component.
 */

export default {
  name: 'PaneTree',
  props: {
    node: Object,
    terminals: Object,
    activePane: String,
    onActivate: Function,
    onClosePane: Function,
    setMountRef: Function
  },
  template: `
    <div v-if="node.type === 'pane'"
      class="terminal-pane"
      :class="{ active: node.terminalId === activePane }"
      @click.stop="onActivate(node.terminalId)"
    >
      <div class="xterm-mount" :ref="el => setMountRef(node.terminalId, el)"></div>
    </div>
    <div v-else-if="node.type === 'split'"
      class="terminal-split"
      :class="'split-' + node.direction"
    >
      <div class="split-child" :style="firstStyle">
        <PaneTree
          :node="node.first"
          :terminals="terminals"
          :activePane="activePane"
          :onActivate="onActivate"
          :onClosePane="onClosePane"
          :setMountRef="setMountRef"
        />
      </div>
      <div
        class="split-divider"
        :class="'divider-' + node.direction"
        @mousedown.prevent="startDrag($event, node)"
        @touchstart.prevent="startDrag($event, node)"
      ></div>
      <div class="split-child" :style="secondStyle">
        <PaneTree
          :node="node.second"
          :terminals="terminals"
          :activePane="activePane"
          :onActivate="onActivate"
          :onClosePane="onClosePane"
          :setMountRef="setMountRef"
        />
      </div>
    </div>
  `,
  setup(props) {
    const firstStyle = Vue.computed(() => {
      if (props.node.type !== 'split') return {};
      const pct = (props.node.ratio * 100).toFixed(2) + '%';
      return { flexBasis: pct, flexGrow: 0, flexShrink: 0 };
    });
    const secondStyle = Vue.computed(() => {
      if (props.node.type !== 'split') return {};
      const pct = ((1 - props.node.ratio) * 100).toFixed(2) + '%';
      return { flexBasis: pct, flexGrow: 0, flexShrink: 0 };
    });

    const startDrag = (e, splitNode) => {
      const container = e.target.closest('.terminal-split');
      if (!container) return;
      const isTouch = e.type === 'touchstart';
      const isHorizontal = splitNode.direction === 'horizontal';
      const startPos = isHorizontal
        ? (isTouch ? e.touches[0].clientX : e.clientX)
        : (isTouch ? e.touches[0].clientY : e.clientY);
      const containerRect = container.getBoundingClientRect();
      const totalSize = isHorizontal ? containerRect.width : containerRect.height;
      const startRatio = splitNode.ratio;

      document.body.style.cursor = isHorizontal ? 'col-resize' : 'row-resize';
      document.body.style.userSelect = 'none';

      const onMove = (ev) => {
        const currentPos = isHorizontal
          ? (isTouch ? ev.touches[0].clientX : ev.clientX)
          : (isTouch ? ev.touches[0].clientY : ev.clientY);
        const delta = currentPos - startPos;
        const newRatio = Math.max(0.1, Math.min(0.9, startRatio + delta / totalSize));
        splitNode.ratio = newRatio;
      };

      const onEnd = () => {
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onEnd);
        document.removeEventListener('touchmove', onMove);
        document.removeEventListener('touchend', onEnd);
        window.dispatchEvent(new CustomEvent('terminal-fit-all'));
      };

      document.addEventListener(isTouch ? 'touchmove' : 'mousemove', onMove);
      document.addEventListener(isTouch ? 'touchend' : 'mouseup', onEnd);
    };

    return { firstStyle, secondStyle, startDrag };
  }
};
