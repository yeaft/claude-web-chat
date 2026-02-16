import TerminalTab from './TerminalTab.js';
import GitStatusTab from './GitStatusTab.js';
import FilesTab from './FilesTab.js';

export default {
  name: 'WorkbenchPanel',
  components: { TerminalTab, GitStatusTab, FilesTab },
  template: `
    <div class="workbench-panel" :class="{ expanded: store.workbenchExpanded, maximized: store.workbenchMaximized }" :style="panelStyle">
      <!-- 展开时的完整面板 -->
      <div class="workbench-content" v-if="store.workbenchExpanded">
        <!-- Tab 栏 -->
        <div class="workbench-tabs">
          <button
            v-if="hasTerminal"
            class="wb-tab"
            :class="{ active: activeTab === 'terminal' }"
            @click="setTab('terminal')"
          >
            <svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M20 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 14H4V8h16v12zM7 17l4-4-4-4 1.4-1.4L13.8 13l-5.4 5.4L7 17zm5 0h6v-2h-6v2z"/></svg>
            Terminal
          </button>
          <button
            v-if="hasExplorer"
            class="wb-tab"
            :class="{ active: activeTab === 'git' }"
            @click="setTab('git')"
          >
            <svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M21.62 11.11l-8.73-8.73a1.32 1.32 0 00-1.87 0L8.89 4.51l2.35 2.35a1.57 1.57 0 012 2l2.27 2.27a1.57 1.57 0 11-.94.88l-2.12-2.12v5.57a1.57 1.57 0 11-1.29 0V9.72a1.57 1.57 0 01-.85-2.06L8 5.34 2.38 11a1.32 1.32 0 000 1.87l8.73 8.73a1.32 1.32 0 001.87 0l8.64-8.64a1.32 1.32 0 000-1.85z"/></svg>
            Git
          </button>
          <button
            v-if="hasExplorer"
            class="wb-tab"
            :class="{ active: activeTab === 'files' }"
            @click="setTab('files')"
          >
            <svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M10 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/></svg>
            Files
          </button>
          <div class="wb-tab-spacer"></div>
          <button class="wb-tab-action" @click="store.toggleWorkbenchMaximized()" :title="store.workbenchMaximized ? $t('workbench.restore') : $t('workbench.maximize')">
            <svg v-if="!store.workbenchMaximized" viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M3 8.41L6.58 12 3 15.59 4.41 17l5-5-5-5L3 8.41zM8 6h13v2H8V6zm3 5h10v2H11v-2zm-3 5h13v2H8v-2z"/></svg>
            <svg v-else viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M21 15.59L17.42 12 21 8.41 19.59 7l-5 5 5 5L21 15.59zM3 6h13v2H3V6zm0 5h10v2H3v-2zm0 5h13v2H3v-2z"/></svg>
          </button>
          <button class="wb-tab-action" @click="store.toggleWorkbench()" :title="$t('workbench.collapse')">
            <svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
          </button>
        </div>

        <!-- Tab 内容 -->
        <div class="workbench-tab-content">
          <TerminalTab v-if="hasTerminal" v-show="activeTab === 'terminal'" />
          <GitStatusTab v-if="hasExplorer" v-show="activeTab === 'git'" />
          <FilesTab v-if="hasExplorer" v-show="activeTab === 'files'" />
        </div>
      </div>

      <!-- 拖拽调整宽度手柄 -->
      <div class="resize-handle" @mousedown="startResize" v-if="store.workbenchExpanded"></div>
    </div>
  `,
  setup() {
    const store = Pinia.useChatStore();

    // Capability checks
    const hasTerminal = Vue.computed(() => store.hasCapability('terminal'));
    const hasExplorer = Vue.computed(() => store.hasCapability('file_editor'));
    const hasTasks = Vue.computed(() => false);

    // Per-conversation active tab tracking
    const tabMap = Vue.reactive({});

    const getFirstAvailableTab = () => {
      if (hasExplorer.value) return 'files';
      if (hasTerminal.value) return 'terminal';
      return 'files';
    };

    const activeTab = Vue.computed(() => {
      const convId = store.currentConversation;
      const tab = (convId && tabMap[convId]) || 'files';
      if (tab === 'terminal' && !hasTerminal.value) return getFirstAvailableTab();
      if ((tab === 'git' || tab === 'files' || tab === 'explorer') && !hasExplorer.value) return getFirstAvailableTab();
      // Migrate old 'explorer' tab to 'git'
      if (tab === 'explorer') return 'git';
      return tab;
    });

    const setTab = (tab) => {
      const convId = store.currentConversation;
      if (convId) tabMap[convId] = tab;
    };

    // Resize logic
    const panelWidth = Vue.ref(0);
    const isResizing = Vue.ref(false);
    const hasCustomWidth = Vue.ref(false);

    const panelStyle = Vue.computed(() => {
      if (!store.workbenchExpanded) return {};
      // When maximized, don't set inline width — CSS handles it
      if (store.workbenchMaximized) return {};
      // On mobile (<=768px), don't set inline width — CSS handles it with !important
      if (window.innerWidth <= 768) return {};
      // Only set inline width if user has dragged to resize
      if (!hasCustomWidth.value) {
        if (isResizing.value) return { transition: 'none' };
        return {};
      }
      const style = { width: panelWidth.value + 'px' };
      // Disable transition during drag to avoid jittery animation
      if (isResizing.value) style.transition = 'none';
      return style;
    });

    const startResize = (e) => {
      e.preventDefault();
      isResizing.value = true;
      const startX = e.clientX;
      // If no custom width yet, use current computed width
      if (!hasCustomWidth.value) {
        const el = e.target.closest('.workbench-panel');
        if (el) panelWidth.value = el.offsetWidth;
        hasCustomWidth.value = true;
      }
      const startWidth = panelWidth.value;
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';

      const onMouseMove = (e) => {
        const delta = e.clientX - startX;
        // Allow workbench to grow up to window width minus sidebar (~48-260px) minus a small margin
        const maxWidth = Math.max(900, window.innerWidth - 100);
        panelWidth.value = Math.max(280, Math.min(maxWidth, startWidth + delta));
      };

      const onMouseUp = () => {
        isResizing.value = false;
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
      };

      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
    };

    // Auto-switch to explorer tab when a file is opened from chat
    const handleOpenFile = () => {
      const convId = store.currentConversation;
      if (convId && hasExplorer.value) tabMap[convId] = 'files';
    };

    // 清理已删除会话的 tabMap 条目
    const handleConversationDeleted = (event) => {
      const { conversationId } = event.detail;
      if (conversationId) {
        delete tabMap[conversationId];
      }
    };

    Vue.onMounted(() => {
      window.addEventListener('open-file-in-explorer', handleOpenFile);
      window.addEventListener('conversation-deleted', handleConversationDeleted);
    });

    Vue.onUnmounted(() => {
      window.removeEventListener('open-file-in-explorer', handleOpenFile);
      window.removeEventListener('conversation-deleted', handleConversationDeleted);
    });

    return {
      store,
      activeTab,
      setTab,
      hasTerminal,
      hasExplorer,
      hasTasks,
      panelStyle,
      startResize
    };
  }
};
