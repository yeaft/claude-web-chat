function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) return resolve();
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = reject;
    document.head.appendChild(s);
  });
}

// ========================================
// 树操作辅助函数
// ========================================

function generateTerminalId(convId) {
  return convId + ':' + Math.random().toString(36).slice(2, 8);
}

function collectLeaves(node) {
  if (!node) return [];
  if (node.type === 'pane') return [node.terminalId];
  return [...collectLeaves(node.first), ...collectLeaves(node.second)];
}

function findFirstLeaf(node) {
  if (!node) return null;
  if (node.type === 'pane') return node.terminalId;
  return findFirstLeaf(node.first);
}

// 替换叶子节点（用于 split）— 返回新树
function replaceNode(tree, targetId, replacement) {
  if (!tree) return tree;
  if (tree.type === 'pane') {
    return tree.terminalId === targetId ? replacement : tree;
  }
  return {
    ...tree,
    first: replaceNode(tree.first, targetId, replacement),
    second: replaceNode(tree.second, targetId, replacement)
  };
}

// 移除叶子节点，提升兄弟 — 返回新树或 null
function removeNode(tree, targetId) {
  if (!tree) return null;
  if (tree.type === 'pane') {
    return tree.terminalId === targetId ? null : tree;
  }
  // 如果 first 是目标，返回 second
  if (tree.first?.type === 'pane' && tree.first.terminalId === targetId) {
    return tree.second;
  }
  // 如果 second 是目标，返回 first
  if (tree.second?.type === 'pane' && tree.second.terminalId === targetId) {
    return tree.first;
  }
  // 递归
  const newFirst = removeNode(tree.first, targetId);
  const newSecond = removeNode(tree.second, targetId);
  if (!newFirst) return newSecond;
  if (!newSecond) return newFirst;
  return { ...tree, first: newFirst, second: newSecond };
}

// ========================================
// PaneTree 递归组件
// ========================================

const PaneTree = {
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
      const isHorizontal = splitNode.direction === 'horizontal';
      const startPos = isHorizontal ? e.clientX : e.clientY;
      const containerRect = container.getBoundingClientRect();
      const totalSize = isHorizontal ? containerRect.width : containerRect.height;
      const startRatio = splitNode.ratio;

      document.body.style.cursor = isHorizontal ? 'col-resize' : 'row-resize';
      document.body.style.userSelect = 'none';

      const onMouseMove = (ev) => {
        const currentPos = isHorizontal ? ev.clientX : ev.clientY;
        const delta = currentPos - startPos;
        const newRatio = Math.max(0.1, Math.min(0.9, startRatio + delta / totalSize));
        splitNode.ratio = newRatio;
      };

      const onMouseUp = () => {
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
        // Fit all terminals after drag
        window.dispatchEvent(new CustomEvent('terminal-fit-all'));
      };

      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
    };

    return { firstStyle, secondStyle, startDrag };
  }
};

// ========================================
// TerminalTab 主组件
// ========================================

export default {
  name: 'TerminalTab',
  components: { PaneTree },
  template: `
    <div class="terminal-tab">
      <div class="terminal-toolbar">
        <button class="wb-btn" @click="splitPane('horizontal')" :disabled="!hasActivePane" :title="$t('terminal.splitH')">
          <svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M3 3h8v18H3V3zm10 0h8v18h-8V3z"/></svg>
          <span>Split ─</span>
        </button>
        <button class="wb-btn" @click="splitPane('vertical')" :disabled="!hasActivePane" :title="$t('terminal.splitV')">
          <svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M3 3h18v8H3V3zm0 10h18v8H3v-8z"/></svg>
          <span>Split │</span>
        </button>
        <button class="wb-btn" @click="closeActivePane" :disabled="!hasActivePane" :title="$t('terminal.close')">
          <svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
          <span>Close</span>
        </button>
        <span class="terminal-status-text" v-if="terminalError">{{ terminalError }}</span>
      </div>
      <div class="terminal-instances" v-if="currentTree">
        <PaneTree
          :node="currentTree"
          :terminals="terminals"
          :activePane="currentActivePane"
          :onActivate="activatePane"
          :onClosePane="closePane"
          :setMountRef="setMountRef"
        />
      </div>
      <div v-if="!currentTree" class="terminal-placeholder">
        <div class="placeholder-icon">
          <svg viewBox="0 0 24 24" width="48" height="48"><path fill="currentColor" opacity="0.3" d="M20 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 14H4V8h16v12z"/><path fill="currentColor" d="M7 17l4-4-4-4 1.4-1.4L13.8 13l-5.4 5.4L7 17zm5 0h6v-2h-6v2z"/></svg>
        </div>
        <div class="placeholder-text">{{ $t('terminal.autoCreate') }}</div>
      </div>
    </div>
  `,
  setup() {
    const store = Pinia.useChatStore();
    const t = Vue.inject('t');

    // terminalId -> { created, connected, terminal, fitAddon }
    const terminals = Vue.reactive({});
    // convId -> layout tree root node (reactive)
    const layoutTrees = Vue.reactive({});
    // convId -> active terminalId
    const activePanes = Vue.reactive({});

    const terminalError = Vue.ref('');
    const mountRefs = {};
    let xtermLoaded = false;

    // 当前 conversation 的布局树
    const currentTree = Vue.computed(() => {
      const convId = store.currentConversation;
      return convId ? layoutTrees[convId] || null : null;
    });

    const currentActivePane = Vue.computed(() => {
      const convId = store.currentConversation;
      return convId ? activePanes[convId] || '' : '';
    });

    const hasActivePane = Vue.computed(() => !!currentActivePane.value);

    const setMountRef = (terminalId, el) => {
      if (el) {
        const oldEl = mountRefs[terminalId];
        mountRefs[terminalId] = el;

        // 如果 DOM 元素变了（split 后 Vue 重建了 DOM），重新附加 xterm
        if (oldEl && oldEl !== el) {
          const info = terminals[terminalId];
          if (info?.terminal?.element) {
            el.innerHTML = '';
            el.appendChild(info.terminal.element);
            // 布局变了后需要重新 fit
            Vue.nextTick(() => {
              try { info.fitAddon?.fit(); } catch {}
            });
          }
        }
      }
    };

    const activatePane = (terminalId) => {
      const convId = store.currentConversation;
      if (convId) activePanes[convId] = terminalId;
    };

    // ========================================
    // xterm.js 加载
    // ========================================

    async function ensureXterm() {
      if (xtermLoaded) return true;
      let TermClass = (typeof Terminal !== 'undefined') ? (Terminal.Terminal || Terminal) : null;
      let FitClass = (typeof FitAddon !== 'undefined') ? (FitAddon.FitAddon || FitAddon) : null;
      if (!TermClass || !FitClass) {
        try {
          await loadScript('vendor/xterm.min.js');
          await loadScript('vendor/xterm-addon-fit.min.js');
          TermClass = (typeof Terminal !== 'undefined') ? (Terminal.Terminal || Terminal) : null;
          FitClass = (typeof FitAddon !== 'undefined') ? (FitAddon.FitAddon || FitAddon) : null;
        } catch {}
      }
      if (!TermClass || !FitClass) {
        terminalError.value = t('terminal.xtermNotLoaded');
        return false;
      }
      xtermLoaded = true;
      return true;
    }

    // ========================================
    // 终端主题
    // ========================================

    function getTermTheme() {
      const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
      const s = getComputedStyle(document.documentElement);
      const bgMain = s.getPropertyValue('--bg-main').trim() || (isDark ? '#212121' : '#ffffff');
      return isDark ? {
        background: bgMain,
        foreground: '#d4d4d4',
        cursor: '#a0a0a0',
        selectionBackground: 'rgba(255,255,255,0.12)',
        black: '#3a3a3a', red: '#f48771', green: '#89d185', yellow: '#e5c07b',
        blue: '#6cb6ff', magenta: '#d670d6', cyan: '#56d4dd', white: '#cccccc',
        brightBlack: '#555555', brightRed: '#f48771', brightGreen: '#89d185', brightYellow: '#e5c07b',
        brightBlue: '#6cb6ff', brightMagenta: '#d670d6', brightCyan: '#56d4dd', brightWhite: '#e8e8e8'
      } : {
        background: bgMain,
        foreground: '#383a42',
        cursor: '#526fff',
        selectionBackground: 'rgba(0,0,0,0.07)',
        black: '#383a42', red: '#e45649', green: '#50a14f', yellow: '#c18401',
        blue: '#4078f2', magenta: '#a626a4', cyan: '#0184bc', white: '#a0a1a7',
        brightBlack: '#4f525e', brightRed: '#e45649', brightGreen: '#50a14f', brightYellow: '#c18401',
        brightBlue: '#4078f2', brightMagenta: '#a626a4', brightCyan: '#0184bc', brightWhite: '#fafafa'
      };
    }

    // ========================================
    // 创建单个终端 pane（仅创建 xterm 实例，不挂载）
    // ========================================

    async function createPane(convId) {
      if (!convId || !store.currentAgent) return null;
      if (!(await ensureXterm())) return null;

      const terminalId = generateTerminalId(convId);
      const TermClass = Terminal.Terminal || Terminal;
      const FitClass = FitAddon.FitAddon || FitAddon;

      const term = new TermClass({
        cursorBlink: true,
        fontSize: 13,
        fontFamily: "'SF Mono', 'Fira Code', 'Consolas', monospace",
        theme: getTermTheme(),
        allowProposedApi: true
      });
      const fitAddon = new FitClass();
      term.loadAddon(fitAddon);

      // 让 Ctrl+V / Ctrl+C（有选区时复制）/ Ctrl+Shift+V 交给浏览器处理
      term.attachCustomKeyEventHandler((e) => {
        // Ctrl+V 或 Ctrl+Shift+V：让浏览器处理粘贴
        if ((e.ctrlKey || e.metaKey) && e.key === 'v') return false;
        // Ctrl+C 且有选区：让浏览器处理复制（无选区时发送 SIGINT）
        if ((e.ctrlKey || e.metaKey) && e.key === 'c' && term.hasSelection()) return false;
        return true;
      });

      terminals[terminalId] = {
        created: true,
        connected: false,
        terminal: term,
        fitAddon: fitAddon
      };

      // Terminal 输入 → agent
      term.onData((data) => {
        store.sendWsMessage({
          type: 'terminal_input',
          conversationId: convId,
          terminalId,
          data,
          _clientId: store.clientId
        });
      });

      return terminalId;
    }

    // 挂载终端到 DOM 并发送 create 消息
    async function mountPane(convId, terminalId) {
      const info = terminals[terminalId];
      if (!info) return false;

      // 等待 DOM 更新（布局树已设置后调用，PaneTree 会渲染出 xterm-mount）
      // 递归组件可能需要多个渲染周期才能完成
      let el = null;
      for (let attempt = 0; attempt < 10; attempt++) {
        await Vue.nextTick();
        el = mountRefs[terminalId];
        if (el) break;
        // 额外等待一小段时间让递归组件完成渲染
        if (attempt >= 2) {
          await new Promise(r => setTimeout(r, 50));
          el = mountRefs[terminalId];
          if (el) break;
        }
      }

      if (el) {
        info.terminal.open(el);
        info.fitAddon.fit();
        store.sendWsMessage({
          type: 'terminal_create',
          conversationId: convId,
          terminalId,
          cols: info.terminal.cols,
          rows: info.terminal.rows,
          _clientId: store.clientId
        });
        return true;
      } else {
        terminalError.value = t('terminal.mountFailed');
        info.terminal.dispose();
        delete terminals[terminalId];
        return false;
      }
    }

    // ========================================
    // 自动创建 — 当 terminal tab 可见且无布局树时
    // ========================================

    let autoCreatePending = false;

    async function autoCreateIfNeeded() {
      const convId = store.currentConversation;
      if (!convId || !store.currentAgent) return;
      if (layoutTrees[convId]) return; // 已有布局
      if (autoCreatePending) return;

      autoCreatePending = true;
      terminalError.value = '';

      const terminalId = await createPane(convId);
      if (!terminalId) { autoCreatePending = false; return; }

      // 先设置布局树，让 PaneTree 渲染出 DOM
      layoutTrees[convId] = Vue.reactive({ type: 'pane', terminalId });
      activePanes[convId] = terminalId;

      // 再挂载 xterm 到 DOM
      const ok = await mountPane(convId, terminalId);
      if (!ok) {
        // 挂载失败，清理布局树
        delete layoutTrees[convId];
        delete activePanes[convId];
      }
      autoCreatePending = false;
    }

    // ========================================
    // Split / Close
    // ========================================

    async function splitPane(direction) {
      const convId = store.currentConversation;
      if (!convId || !activePanes[convId]) return;

      const activeId = activePanes[convId];
      const newTerminalId = await createPane(convId);
      if (!newTerminalId) return;

      // 替换活跃 pane 为 split 节点（先更新布局树让 DOM 渲染）
      const splitNode = Vue.reactive({
        type: 'split',
        direction,
        ratio: 0.5,
        first: { type: 'pane', terminalId: activeId },
        second: { type: 'pane', terminalId: newTerminalId }
      });

      const newTree = replaceNode(layoutTrees[convId], activeId, splitNode);
      layoutTrees[convId] = Vue.reactive(newTree);
      activePanes[convId] = newTerminalId;

      // 布局树更新后，Vue 重新渲染 PaneTree，setMountRef 会自动
      // 检测旧 pane 的 DOM 变化并重新附加 xterm 实例

      // 挂载新 pane
      const ok = await mountPane(convId, newTerminalId);
      if (!ok) {
        // 挂载失败，回滚 split：移除新 pane，恢复旧结构
        const rollbackTree = removeNode(layoutTrees[convId], newTerminalId);
        if (rollbackTree) {
          layoutTrees[convId] = Vue.reactive(rollbackTree);
        }
        activePanes[convId] = activeId;
        return;
      }

      // fit 所有 pane（包括被分割的旧 pane，它的尺寸变了）
      await Vue.nextTick();
      fitAllPanes(convId);
    }

    function closePane(terminalId) {
      const convId = store.currentConversation;
      if (!convId) return;

      // 发送关闭消息给 agent
      const info = terminals[terminalId];
      if (info) {
        store.sendWsMessage({
          type: 'terminal_close',
          conversationId: convId,
          terminalId,
          _clientId: store.clientId
        });
        info.terminal?.dispose();
        delete terminals[terminalId];
        delete mountRefs[terminalId];
      }

      // 从布局树中移除
      const newTree = removeNode(layoutTrees[convId], terminalId);
      if (newTree) {
        layoutTrees[convId] = Vue.reactive(newTree);
        // 如果关闭的是活跃 pane，切换到第一个叶子
        if (activePanes[convId] === terminalId) {
          activePanes[convId] = findFirstLeaf(layoutTrees[convId]) || '';
        }
        Vue.nextTick(() => fitAllPanes(convId));
      } else {
        // 没有 pane 了，清理布局
        delete layoutTrees[convId];
        delete activePanes[convId];
        // 自动重新创建终端（下一个 tick 让 UI 先更新）
        Vue.nextTick(() => autoCreateIfNeeded());
      }
    }

    function closeActivePane() {
      const convId = store.currentConversation;
      if (!convId || !activePanes[convId]) return;
      closePane(activePanes[convId]);
    }

    // ========================================
    // Fit all panes
    // ========================================

    function fitAllPanes(convId) {
      if (!convId) convId = store.currentConversation;
      if (!convId || !layoutTrees[convId]) return;
      const leaves = collectLeaves(layoutTrees[convId]);
      for (const tid of leaves) {
        const info = terminals[tid];
        if (info?.fitAddon && info.connected) {
          try {
            info.fitAddon.fit();
            store.sendWsMessage({
              type: 'terminal_resize',
              conversationId: convId,
              terminalId: tid,
              cols: info.terminal.cols,
              rows: info.terminal.rows,
              _clientId: store.clientId
            });
          } catch {}
        }
      }
    }

    // ========================================
    // 消息处理
    // ========================================

    function handleWorkbenchMessage(event) {
      const msg = event.detail;
      if (!msg) return;

      switch (msg.type) {
        case 'terminal_created': {
          const tid = msg.terminalId || msg.conversationId;
          const info = terminals[tid];
          if (info) {
            if (msg.success) {
              info.connected = true;
              terminalError.value = '';
            } else {
              terminalError.value = msg.error || t('terminal.createFailed');
              info.terminal?.dispose();
              delete terminals[tid];
              // 从布局树移除
              const convId = msg.conversationId;
              if (convId && layoutTrees[convId]) {
                const newTree = removeNode(layoutTrees[convId], tid);
                if (newTree) {
                  layoutTrees[convId] = Vue.reactive(newTree);
                } else {
                  delete layoutTrees[convId];
                  delete activePanes[convId];
                }
              }
            }
          }
          break;
        }
        case 'terminal_output': {
          const tid = msg.terminalId || msg.conversationId;
          const info = terminals[tid];
          if (info?.terminal) {
            info.terminal.write(msg.data);
          }
          break;
        }
        case 'terminal_closed': {
          const tid = msg.terminalId || msg.conversationId;
          const info = terminals[tid];
          if (info) {
            info.terminal?.dispose();
            delete terminals[tid];
            delete mountRefs[tid];
            // 从布局树移除
            const convId = msg.conversationId;
            if (convId && layoutTrees[convId]) {
              const newTree = removeNode(layoutTrees[convId], tid);
              if (newTree) {
                layoutTrees[convId] = Vue.reactive(newTree);
                if (activePanes[convId] === tid) {
                  activePanes[convId] = findFirstLeaf(layoutTrees[convId]) || '';
                }
              } else {
                delete layoutTrees[convId];
                delete activePanes[convId];
              }
            }
          }
          break;
        }
        case 'terminal_error': {
          terminalError.value = msg.message || t('terminal.error');
          const tid = msg.terminalId;
          if (tid && terminals[tid] && !terminals[tid].connected) {
            terminals[tid].terminal?.dispose();
            delete terminals[tid];
            const convId = msg.conversationId;
            if (convId && layoutTrees[convId]) {
              const newTree = removeNode(layoutTrees[convId], tid);
              if (newTree) {
                layoutTrees[convId] = Vue.reactive(newTree);
              } else {
                delete layoutTrees[convId];
                delete activePanes[convId];
              }
            }
          }
          break;
        }
      }
    }

    // ========================================
    // Resize handler
    // ========================================

    let resizeTimer = null;
    function handleResize() {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => fitAllPanes(), 100);
    }

    function handleFitAll() {
      fitAllPanes();
    }

    // ========================================
    // 清理已删除会话
    // ========================================

    function handleConversationDeleted(event) {
      const { conversationId } = event.detail;
      if (!conversationId) return;
      // 清理所有该 conversation 的终端
      if (layoutTrees[conversationId]) {
        const leaves = collectLeaves(layoutTrees[conversationId]);
        for (const tid of leaves) {
          const info = terminals[tid];
          if (info) {
            info.terminal?.dispose();
            delete terminals[tid];
            delete mountRefs[tid];
          }
        }
        delete layoutTrees[conversationId];
        delete activePanes[conversationId];
      }
    }

    // ========================================
    // 生命周期
    // ========================================

    Vue.onMounted(() => {
      window.addEventListener('workbench-message', handleWorkbenchMessage);
      window.addEventListener('resize', handleResize);
      window.addEventListener('terminal-fit-all', handleFitAll);
      window.addEventListener('conversation-deleted', handleConversationDeleted);
    });

    Vue.onUnmounted(() => {
      window.removeEventListener('workbench-message', handleWorkbenchMessage);
      window.removeEventListener('resize', handleResize);
      window.removeEventListener('terminal-fit-all', handleFitAll);
      window.removeEventListener('conversation-deleted', handleConversationDeleted);
      clearTimeout(resizeTimer);
      // 清理所有终端
      for (const tid of Object.keys(terminals)) {
        terminals[tid]?.terminal?.dispose();
      }
    });

    // 自动创建：监听 conversation 切换 + workbench 状态
    // 使用 watch 检测 terminal tab 可见时自动创建
    Vue.watch(
      () => [store.currentConversation, store.workbenchExpanded],
      () => {
        Vue.nextTick(() => {
          const convId = store.currentConversation;
          if (!convId || !store.workbenchExpanded) return;
          // 只在 terminal tab 被选中时自动创建
          // WorkbenchPanel 通过 activeTab 控制显示，这里检查组件是否可见
          const tabEl = document.querySelector('.terminal-tab');
          if (tabEl && tabEl.offsetParent !== null) {
            autoCreateIfNeeded();
          }
        });
      },
      { immediate: true }
    );

    // WebSocket 重连时清理所有旧终端（agent 端的 PTY 已失效）
    Vue.watch(
      () => store.connectionState,
      (newState, oldState) => {
        if (newState === 'connected' && oldState && oldState !== 'connected') {
          console.log('[Terminal] WebSocket reconnected, cleaning up stale terminals');
          for (const tid of Object.keys(terminals)) {
            terminals[tid]?.terminal?.dispose();
            delete terminals[tid];
            delete mountRefs[tid];
          }
          for (const convId of Object.keys(layoutTrees)) {
            delete layoutTrees[convId];
            delete activePanes[convId];
          }
          // 重连后自动创建终端
          Vue.nextTick(() => autoCreateIfNeeded());
        }
      }
    );

    // 当 conversation 切换时 fit 终端
    Vue.watch(() => store.currentConversation, () => {
      Vue.nextTick(() => fitAllPanes());
    });

    // 监听 MutationObserver 来检测 terminal-tab 可见性变化
    let visibilityObserver = null;
    Vue.onMounted(() => {
      // 检查 terminal tab 是否从隐藏变为可见（v-show 切换）
      const checkVisibility = () => {
        const tabEl = document.querySelector('.terminal-tab');
        if (tabEl && tabEl.offsetParent !== null) {
          autoCreateIfNeeded();
          fitAllPanes();
        }
      };

      // 使用 MutationObserver 监听 display 变化
      visibilityObserver = new MutationObserver(() => {
        setTimeout(checkVisibility, 50);
      });

      const workbenchContent = document.querySelector('.workbench-tab-content');
      if (workbenchContent) {
        visibilityObserver.observe(workbenchContent, { attributes: true, subtree: true, attributeFilter: ['style'] });
      }
    });

    Vue.onUnmounted(() => {
      if (visibilityObserver) visibilityObserver.disconnect();
    });

    return {
      store,
      terminals,
      currentTree,
      currentActivePane,
      hasActivePane,
      terminalError,
      setMountRef,
      activatePane,
      splitPane,
      closeActivePane,
      closePane
    };
  }
};
