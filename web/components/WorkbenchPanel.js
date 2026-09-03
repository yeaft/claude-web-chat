import WorkbenchCapabilityHost from './WorkbenchCapabilityHost.js';
import BrowserPanel from './BrowserPanel.js';
import {
  workbenchConversationId,
  workbenchRouteKey,
  workbenchWorkspaceGeneration,
} from '../utils/workbench-route.js';

export default {
  name: 'WorkbenchPanel',
  components: { WorkbenchCapabilityHost, BrowserPanel },
  template: `
    <div ref="panelRoot" class="workbench-panel" :class="{ expanded: store.workbenchExpanded, maximized: store.workbenchMaximized }" :style="panelStyle">
      <div class="workbench-content" v-show="store.workbenchExpanded">
        <header class="workbench-header">
          <div class="workbench-tabs" role="tablist" :aria-label="$t('workbench.openItems')">
            <div
              v-for="item in workbenchItems"
              :key="item.id"
              class="workbench-item-tab"
              :class="{ active: item.id === activeWorkbenchItemId }"
            >
              <button
                type="button"
                class="workbench-item-select"
                role="tab"
                :aria-selected="item.id === activeWorkbenchItemId"
                :aria-controls="'workbench-item-panel'"
                :tabindex="item.id === activeWorkbenchItemId ? 0 : -1"
                :title="item.title || item.label"
                @click="selectWorkbenchItem(item)"
                @keydown="handleWorkbenchTabKeydown($event, item)"
              >
                <span v-if="item.dirty" class="workbench-item-dirty" aria-hidden="true">●</span>
                <span class="workbench-item-label">{{ item.label }}</span>
              </button>
              <button
                type="button"
                class="workbench-item-close"
                :aria-label="$t('workbench.closeItem', { name: item.label })"
                @click="closeWorkbenchItem(item)"
              >×</button>
            </div>
          </div>
          <div ref="launcherRoot" class="workbench-add-wrap">
            <button
              type="button"
              class="workbench-header-action workbench-add-btn"
              :aria-label="$t('workbench.addItem')"
              :title="$t('workbench.addItem')"
              ref="launcherTrigger"
              :aria-expanded="launcherOpen"
              aria-haspopup="menu"
              @click.stop="toggleLauncher"
              @keydown="handleLauncherButtonKeydown"
            >
              <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>
            </button>
            <div v-if="launcherOpen" ref="launcherMenu" class="workbench-add-menu" role="menu">
              <button
                v-for="capability in capabilityCards"
                :key="capability.id"
                type="button"
                role="menuitem"
                class="workbench-add-menu-item"
                :data-workbench-capability="capability.id"
                @click="openCapability(capability.id)"
                @keydown="handleLauncherMenuKeydown"
              >
                <span>{{ $t(capability.titleKey) }}</span>
                <small>{{ $t(capability.statusKey) }}</small>
              </button>
            </div>
          </div>
          <div class="workbench-header-spacer"></div>
          <button
            type="button"
            class="workbench-header-action workbench-maximize-btn"
            @click="store.toggleWorkbenchMaximized()"
            :title="store.workbenchMaximized ? $t('workbench.restore') : $t('workbench.maximize')"
            :aria-label="store.workbenchMaximized ? $t('workbench.restore') : $t('workbench.maximize')"
          >
            <svg v-if="!store.workbenchMaximized" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M7 14H5v5h5v-2H7v-3zM5 10h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z"/></svg>
            <svg v-else viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm6 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z"/></svg>
          </button>
          <button
            type="button"
            class="workbench-header-action workbench-panel-close"
            @click="store.toggleWorkbench()"
            :title="$t('workbench.collapse')"
            :aria-label="$t('workbench.collapse')"
          >
            <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
          </button>
        </header>

        <div id="workbench-item-panel" class="workbench-view-content workbench-tab-content" role="tabpanel">
          <section v-if="!activeCapability" class="workbench-empty-state">
            <p>{{ $t('workbench.addItemHint') }}</p>
          </section>

          <WorkbenchCapabilityHost
            :key="workbenchContextKey"
            :active-capability="activeToolCapability"
            :retained-capabilities="openCapabilities"
            :route-props="routeProps"
          />

          <section
            v-if="activeCapability && activeCapability !== 'browser' && activeCapabilityUnavailable"
            class="workbench-capability-empty"
          >
            <h2>{{ $t(activeCapabilityTitleKey) }}</h2>
            <p>{{ $t('workbench.capabilityUnavailable') }}</p>
            <button type="button" class="btn-secondary" @click="closeCapability">{{ $t('workbench.backToCapabilities') }}</button>
          </section>

          <BrowserPanel
            v-if="activeCapability === 'browser' && canOpenBrowser"
            :key="'browser:' + workbenchContextKey"
            v-bind="routeProps"
            :runtime-ready="hasBrowser"
          />

          <section v-else-if="activeCapability === 'browser'" class="workbench-capability-empty workbench-browser-view">
            <span class="workbench-capability-icon workbench-capability-empty-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24"><path fill="currentColor" d="M20 4H4a2 2 0 00-2 2v12a2 2 0 002 2h16a2 2 0 002-2V6a2 2 0 00-2-2zm0 14H4V9h16v9zM4 7V6h16v1H4zm2-1h2v1H6V6z"/></svg>
            </span>
            <h2>{{ $t('workbench.browser') }}</h2>
            <p>{{ $t('workbench.browserUnavailable') }}</p>
            <button type="button" class="btn-secondary" @click="closeCapability">{{ $t('workbench.backToCapabilities') }}</button>
          </section>
        </div>
      </div>

      <div class="resize-handle" @mousedown="startResize" @touchstart.prevent="startResize" v-if="store.workbenchExpanded"></div>
    </div>
  `,
  setup() {
    const store = Pinia.useChatStore();
    const panelRoot = Vue.ref(null);
    const launcherRoot = Vue.ref(null);
    const launcherOpen = Vue.ref(false);
    const launcherTrigger = Vue.ref(null);
    const launcherMenu = Vue.ref(null);
    const t = (key, params) => Vue.getCurrentInstance()?.proxy?.$t?.(key, params) || key;

    const activeRoute = Vue.computed(() => store.activeSessionRoute || null);
    const activeRouteKey = Vue.computed(() => workbenchRouteKey(activeRoute.value));
    const activeWorkDir = Vue.computed(() => store.effectiveWorkDir || '');
    const activeWorkspaceGeneration = Vue.computed(() => (
      workbenchWorkspaceGeneration(activeRouteKey.value, activeWorkDir.value)
    ));
    const workbenchContextKey = Vue.computed(() => `${activeRouteKey.value}\u0000${activeWorkspaceGeneration.value}`);
    const routeProps = Vue.computed(() => ({
      routeKey: activeRouteKey.value,
      runtimeProvider: activeRoute.value?.runtimeProvider || '',
      agentId: activeRoute.value?.agentId || '',
      sessionId: activeRoute.value?.sessionId || '',
      conversationId: workbenchConversationId(activeRouteKey.value),
      workDir: activeWorkDir.value,
      workspaceGeneration: activeWorkspaceGeneration.value,
    }));

    const hasSessionRoutes = Vue.computed(() => (
      store.workbenchRouteProtocolSupported === true
      && store.hasCapability('workbench_session_routes')
    ));
    const hasTerminal = Vue.computed(() => hasSessionRoutes.value && store.hasCapability('terminal'));
    const hasExplorer = Vue.computed(() => hasSessionRoutes.value && store.hasCapability('file_editor'));
    const canSetupBrowser = Vue.computed(() => (
      store.browserRuntimeServerEnabled === true
      && store.browserRuntimeProtocolSupported === true
      && store.browserRuntimeSetupProtocolSupported === true
      && store.hasCapability('browser_runtime_setup')
    ));
    const hasBrowser = Vue.computed(() => (
      store.browserRuntimeServerEnabled === true
      && store.browserRuntimeProtocolSupported === true
      && store.hasCapability('browser_runtime')
      && store.hasCapability('browser_webrtc')
      && (store.hasCapability('browser_capture_tab') || store.hasCapability('browser_capture_cdp'))
    ));
    const canOpenBrowser = Vue.computed(() => hasBrowser.value || canSetupBrowser.value);

    const capabilityCard = (id, titleKey, descriptionKey, available, ready = available) => ({
      id,
      titleKey,
      descriptionKey,
      available,
      ready,
      statusKey: !available ? 'workbench.unavailable'
        : ready ? 'workbench.available'
          : 'workbench.enableRequired',
    });
    const capabilityCards = Vue.computed(() => [
      capabilityCard('terminal', 'workbench.terminal', 'workbench.terminalDescription', hasTerminal.value),
      capabilityCard('git', 'workbench.git', 'workbench.gitDescription', hasExplorer.value),
      capabilityCard('files', 'workbench.files', 'workbench.filesDescription', hasExplorer.value),
      capabilityCard(
        'browser',
        'workbench.browser',
        'workbench.browserDescription',
        canOpenBrowser.value,
        hasBrowser.value,
      ),
    ]);

    const activeCapability = Vue.ref(null);
    const activatedCapabilities = Vue.reactive(new Set());
    const openCapabilities = Vue.reactive([]);
    const openFileItems = Vue.ref([]);
    const activeFilePath = Vue.ref('');
    const capabilityState = new Map();
    const activeCapabilityDefinition = Vue.computed(() => (
      capabilityCards.value.find(capability => capability.id === activeCapability.value) || null
    ));
    const activeCapabilityTitleKey = Vue.computed(() => (
      activeCapabilityDefinition.value?.titleKey || 'workbench.title'
    ));
    const activeCapabilityUnavailable = Vue.computed(() => (
      activeCapabilityDefinition.value?.available === false
    ));
    const activeToolCapability = Vue.computed(() => {
      if (!activeCapabilityDefinition.value?.available) return null;
      return ['terminal', 'git', 'files'].includes(activeCapability.value)
        && isCapabilityActivated(activeCapability.value)
        ? activeCapability.value
        : null;
    });

    const capabilityActivationKey = capabilityId => `${workbenchContextKey.value}\u0000${capabilityId}`;
    const isCapabilityActivated = capabilityId => activatedCapabilities.has(capabilityActivationKey(capabilityId));
    const ensureOpenCapability = capabilityId => {
      if (!openCapabilities.includes(capabilityId)) openCapabilities.push(capabilityId);
    };
    const capabilityLabel = capabilityId => {
      const definition = capabilityCards.value.find(capability => capability.id === capabilityId);
      return definition ? t(definition.titleKey) : capabilityId;
    };
    const fileItemId = path => `file:${path}`;
    const workbenchItems = Vue.computed(() => {
      const items = [];
      for (const capabilityId of openCapabilities) {
        if (capabilityId === 'files') {
          for (const file of openFileItems.value) {
            items.push({
              id: fileItemId(file.path),
              capabilityId: 'files',
              path: file.path,
              label: file.name,
              title: file.path,
              dirty: file.isDirty,
            });
          }
          if (openFileItems.value.length === 0) {
            items.push({ id: 'files', capabilityId: 'files', label: capabilityLabel('files') });
          }
          continue;
        }
        items.push({ id: capabilityId, capabilityId, label: capabilityLabel(capabilityId) });
      }
      return items;
    });
    const activeWorkbenchItemId = Vue.computed(() => (
      activeCapability.value === 'files' && activeFilePath.value
        ? fileItemId(activeFilePath.value)
        : activeCapability.value
    ));
    const rememberCapability = () => {
      if (!workbenchContextKey.value) return;
      capabilityState.set(workbenchContextKey.value, {
        activeCapability: activeCapability.value,
        openCapabilities: [...openCapabilities],
      });
    };
    const restoreCapability = () => {
      const saved = capabilityState.get(workbenchContextKey.value);
      openCapabilities.splice(0, openCapabilities.length, ...(saved?.openCapabilities || ['files']));
      const next = saved?.activeCapability || openCapabilities[0] || null;
      if (!next || !capabilityCards.value.some(capability => capability.id === next)) {
        activeCapability.value = null;
        return;
      }
      activatedCapabilities.add(capabilityActivationKey(next));
      activeCapability.value = next;
    };

    const launcherItems = () => (
      [...(launcherMenu.value?.querySelectorAll('.workbench-add-menu-item') || [])]
    );
    const focusLauncherItem = (index = 0) => Vue.nextTick(() => {
      const items = launcherItems();
      items[Math.max(0, Math.min(index, items.length - 1))]?.focus();
    });
    const updateLauncherMenuPosition = async () => {
      await Vue.nextTick();
      const triggerRect = launcherTrigger.value?.getBoundingClientRect();
      const menu = launcherMenu.value;
      if (!triggerRect || !menu) return;
      const margin = 8;
      const menuWidth = menu.getBoundingClientRect().width;
      const targetLeft = Math.max(margin, Math.min(triggerRect.left, window.innerWidth - menuWidth - margin));
      const currentLeft = menu.getBoundingClientRect().left;
      const declaredLeft = Number.parseFloat(menu.style.left) || 0;
      menu.style.left = `${declaredLeft + targetLeft - currentLeft}px`;
      menu.style.top = '40px';
    };
    const openLauncher = (focusIndex = 0) => {
      launcherOpen.value = true;
      updateLauncherMenuPosition();
      focusLauncherItem(focusIndex);
    };
    const closeLauncher = (restoreFocus = false) => {
      launcherOpen.value = false;
      if (restoreFocus) Vue.nextTick(() => launcherTrigger.value?.focus());
    };
    const toggleLauncher = () => {
      if (launcherOpen.value) closeLauncher();
      else openLauncher();
    };
    const handleLauncherButtonKeydown = event => {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        openLauncher(0);
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        openLauncher(capabilityCards.value.length - 1);
      } else if (event.key === 'Escape' && launcherOpen.value) {
        event.preventDefault();
        closeLauncher(true);
      }
    };
    const handleLauncherMenuKeydown = event => {
      const items = launcherItems();
      const currentIndex = items.indexOf(document.activeElement);
      let nextIndex = currentIndex;
      if (event.key === 'ArrowDown') nextIndex = (currentIndex + 1) % items.length;
      else if (event.key === 'ArrowUp') nextIndex = (currentIndex - 1 + items.length) % items.length;
      else if (event.key === 'Home') nextIndex = 0;
      else if (event.key === 'End') nextIndex = items.length - 1;
      else if (event.key === 'Escape') {
        event.preventDefault();
        closeLauncher(true);
        return;
      } else if (event.key === 'Tab') {
        closeLauncher();
        return;
      } else return;
      event.preventDefault();
      items[nextIndex]?.focus();
    };

    const openCapability = capabilityId => {
      if (!capabilityCards.value.some(capability => capability.id === capabilityId)) return false;
      if (['terminal', 'git', 'files'].includes(capabilityId) && !activeRouteKey.value) return false;
      ensureOpenCapability(capabilityId);
      activatedCapabilities.add(capabilityActivationKey(capabilityId));
      activeCapability.value = capabilityId;
      closeLauncher();
      rememberCapability();
      return true;
    };

    const confirmFilesCapabilityClose = () => new Promise(resolve => {
      window.dispatchEvent(new CustomEvent('workbench-close-files-capability', {
        detail: {
          routeKey: activeRouteKey.value,
          workspaceGeneration: activeWorkspaceGeneration.value,
          resolve,
        },
      }));
    });
    const closeCapability = async capabilityId => {
      const target = capabilityId || activeCapability.value;
      const index = openCapabilities.indexOf(target);
      if (index < 0) return false;
      if (target === 'files' && hasExplorer.value && isCapabilityActivated(target)
        && !await confirmFilesCapabilityClose()) return false;
      if (activeCapability.value === target) {
        activeCapability.value = openCapabilities[index + 1] || openCapabilities[index - 1] || null;
      }
      openCapabilities.splice(index, 1);
      activatedCapabilities.delete(capabilityActivationKey(target));
      if (target === 'files') {
        openFileItems.value = [];
        activeFilePath.value = '';
      }
      rememberCapability();
      return true;
    };

    const selectWorkbenchItem = item => {
      openCapability(item.capabilityId);
      if (item.path) {
        window.dispatchEvent(new CustomEvent('workbench-select-file-item', {
          detail: {
            routeKey: activeRouteKey.value,
            workspaceGeneration: activeWorkspaceGeneration.value,
            path: item.path,
          },
        }));
      }
    };

    const closeWorkbenchItem = item => {
      if (item.path) {
        window.dispatchEvent(new CustomEvent('workbench-close-file-item', {
          detail: {
            routeKey: activeRouteKey.value,
            workspaceGeneration: activeWorkspaceGeneration.value,
            path: item.path,
          },
        }));
        return;
      }
      closeCapability(item.capabilityId);
    };
    const focusWorkbenchItem = index => Vue.nextTick(() => {
      panelRoot.value?.querySelectorAll('.workbench-item-select')[index]?.focus();
    });
    const handleWorkbenchTabKeydown = (event, item) => {
      const items = workbenchItems.value;
      const currentIndex = items.findIndex(candidate => candidate.id === item.id);
      let nextIndex = currentIndex;
      if (event.key === 'ArrowLeft') nextIndex = Math.max(0, currentIndex - 1);
      else if (event.key === 'ArrowRight') nextIndex = Math.min(items.length - 1, currentIndex + 1);
      else if (event.key === 'Home') nextIndex = 0;
      else if (event.key === 'End') nextIndex = items.length - 1;
      else return;
      event.preventDefault();
      const nextItem = items[nextIndex];
      if (!nextItem) return;
      selectWorkbenchItem(nextItem);
      focusWorkbenchItem(nextIndex);
    };

    Vue.watch(
      workbenchContextKey,
      (contextKey, previousContextKey) => {
        if (contextKey === previousContextKey) return;
        if (previousContextKey) {
          capabilityState.set(previousContextKey, {
            activeCapability: activeCapability.value,
            openCapabilities: [...openCapabilities],
          });
          store.rememberWorkbenchPanelState(previousContextKey.split('\u0000', 1)[0]);
        }
        store.restoreWorkbenchPanelState(activeRoute.value);
        openFileItems.value = [];
        activeFilePath.value = '';
        restoreCapability();
      },
      { flush: 'sync', immediate: true },
    );

    const panelWidth = Vue.ref(0);
    const isResizing = Vue.ref(false);
    const hasCustomWidth = Vue.ref(false);

    const panelStyle = Vue.computed(() => {
      if (!store.workbenchExpanded) return {};
      if (store.workbenchMaximized) return {};
      if (window.innerWidth <= 768) return {};
      if (!hasCustomWidth.value) {
        if (isResizing.value) return { transition: 'none' };
        return {};
      }
      const style = { width: panelWidth.value + 'px' };
      if (isResizing.value) style.transition = 'none';
      return style;
    });

    const startResize = (e) => {
      e.preventDefault();
      const isTouch = e.type === 'touchstart';
      const startX = isTouch ? e.touches[0].clientX : e.clientX;
      isResizing.value = true;
      if (!hasCustomWidth.value) {
        const el = e.target.closest('.workbench-panel');
        if (el) panelWidth.value = el.offsetWidth;
        hasCustomWidth.value = true;
      }
      const startWidth = panelWidth.value;
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';

      const onMove = (moveEvent) => {
        const clientX = isTouch ? moveEvent.touches[0].clientX : moveEvent.clientX;
        const delta = startX - clientX;
        const maxWidth = Math.max(900, window.innerWidth - 100);
        panelWidth.value = Math.max(280, Math.min(maxWidth, startWidth + delta));
      };

      const onEnd = () => {
        isResizing.value = false;
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onEnd);
        document.removeEventListener('touchmove', onMove);
        document.removeEventListener('touchend', onEnd);
      };

      document.addEventListener(isTouch ? 'touchmove' : 'mousemove', onMove);
      document.addEventListener(isTouch ? 'touchend' : 'mouseup', onEnd);
    };

    const handleOpenFile = (event) => {
      if (!hasExplorer.value || !activeRouteKey.value) return;
      const eventRouteKey = event.detail?.workbenchRoute
        ? workbenchRouteKey(event.detail.workbenchRoute)
        : activeRouteKey.value;
      if (eventRouteKey !== activeRouteKey.value) return;
      if (!openCapability('files')) return;
      Vue.nextTick(() => {
        window.dispatchEvent(new CustomEvent('workbench-open-file-in-active-view', {
          detail: {
            ...(event.detail || {}),
            agentId: routeProps.value.agentId,
            conversationId: routeProps.value.conversationId,
            workDir: routeProps.value.workDir,
            workbenchRouteKey: activeRouteKey.value,
          },
        }));
      });
    };

    const handleFileItemsChanged = event => {
      if (event.detail?.routeKey !== activeRouteKey.value
        || event.detail?.workspaceGeneration !== activeWorkspaceGeneration.value) return;
      openFileItems.value = Array.isArray(event.detail.files) ? event.detail.files : [];
      activeFilePath.value = event.detail.activePath || '';
      if (openFileItems.value.length > 0) ensureOpenCapability('files');
    };
    const handleDocumentClick = event => {
      if (launcherOpen.value
        && !launcherRoot.value?.contains(event.target)
        && !launcherMenu.value?.contains(event.target)) closeLauncher();
    };

    Vue.onMounted(() => {
      window.addEventListener('open-file-in-explorer', handleOpenFile);
      window.addEventListener('workbench-file-items-changed', handleFileItemsChanged);
      document.addEventListener('click', handleDocumentClick);
    });

    Vue.onUnmounted(() => {
      window.removeEventListener('open-file-in-explorer', handleOpenFile);
      window.removeEventListener('workbench-file-items-changed', handleFileItemsChanged);
      document.removeEventListener('click', handleDocumentClick);
    });

    return {
      store,
      panelRoot,
      launcherRoot,
      launcherTrigger,
      launcherMenu,
      launcherOpen,
      activeCapability,
      activeCapabilityTitleKey,
      activeCapabilityUnavailable,
      activeToolCapability,
      openCapabilities,
      activeWorkbenchItemId,
      workbenchItems,
      capabilityCards,
      routeProps,
      workbenchContextKey,
      openCapability,
      closeCapability,
      toggleLauncher,
      handleLauncherButtonKeydown,
      handleLauncherMenuKeydown,
      closeWorkbenchItem,
      selectWorkbenchItem,
      handleWorkbenchTabKeydown,
      isCapabilityActivated,
      hasTerminal,
      hasExplorer,
      canOpenBrowser,
      hasBrowser,
      panelStyle,
      startResize,
    };
  }
};
