import MessageItem from './MessageItem.js';

export default {
  name: 'MessageList',
  components: { MessageItem },
  template: `
    <main class="chat-container" ref="containerRef">
      <!-- Session Loading Overlay - only covers message area -->
      <div class="session-loading-overlay" v-if="store.sessionLoading">
        <div class="session-loading-content">
          <div class="session-loading-spinner"></div>
          <div class="session-loading-text">{{ store.sessionLoadingText || $t('common.loading') }}</div>
        </div>
      </div>

      <!-- Welcome Screen when no conversation -->
      <div v-if="!store.currentConversation" class="welcome-screen">
        <div class="welcome-content">
          <div class="welcome-logo">
            <svg viewBox="0 0 48 48" width="64" height="64">
              <rect width="48" height="48" rx="12" fill="#d97706"/>
              <path d="M12 16l6 6-6 6" stroke="white" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
              <path d="M21 28h15" stroke="white" stroke-width="3.5" stroke-linecap="round"/>
            </svg>
          </div>
          <h1 class="welcome-title">Claude Web Chat</h1>
          <p class="welcome-subtitle">{{ $t('welcome.subtitle') }}</p>

          <!-- Agent Status -->
          <div class="welcome-status" v-if="onlineAgents.length > 0">
            <span class="status-dot online"></span>
            <span class="status-text">{{ $t('welcome.agentOnline', { count: onlineAgents.length }) }}</span>
          </div>

          <!-- No agents online -->
          <div class="welcome-section" v-else>
            <div class="welcome-empty">
              <div class="empty-icon">📡</div>
              <div class="empty-text">{{ $t('welcome.noAgent') }}</div>
              <div class="empty-hint">{{ $t('welcome.noAgentHint') }}</div>
            </div>
          </div>

          <!-- Quick Actions -->
          <div class="welcome-actions" v-if="onlineAgents.length > 0">
            <button class="welcome-btn primary" @click="$emit('new-conversation')">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
                <line x1="12" y1="8" x2="12" y2="14"/><line x1="9" y1="11" x2="15" y2="11"/>
              </svg>
              {{ $t('welcome.newConv') }}
            </button>
          </div>
        </div>
      </div>

      <!-- Messages when in conversation -->
      <div v-else class="messages">
        <div v-if="store.loadingMoreMessages" class="loading-more">{{ $t('message.loadingMore') }}</div>
        <div v-else-if="store.hasMoreMessages" class="load-more-hint" @click="store.loadMoreMessages()">{{ $t('message.loadMore') }}</div>
        <template v-for="msg in processedMessages" :key="msg.id">
          <MessageItem
            v-if="!msg.groupId || msg.isLastInGroup || expandedGroups[msg.groupId]"
            :message="msg"
            v-show="!msg.groupId || msg.isLastInGroup || expandedGroups[msg.groupId]"
          />
          <!-- Collapse/expand button after last tool in group -->
          <div v-if="msg.isLastInGroup && msg.groupSize > 1" class="tool-group-toggle" @click="toggleToolGroup(msg.groupId)">
            <svg v-if="!expandedGroups[msg.groupId]" viewBox="0 0 24 24" width="12" height="12"><path fill="currentColor" d="M7 10l5 5 5-5z"/></svg>
            <svg v-else viewBox="0 0 24 24" width="12" height="12"><path fill="currentColor" d="M7 14l5-5 5 5z"/></svg>
            <span>{{ expandedGroups[msg.groupId] ? '收起' : msg.groupSize + ' 个操作' }}</span>
          </div>
        </template>

        <!-- Minimal Status Indicator -->
        <div v-if="store.isProcessing" class="processing-hint">
          <span class="processing-icon">{{ statusIcon }}</span>
          <span class="processing-text">{{ statusText }}</span>
          <span v-if="statusDetail" class="processing-detail">· {{ statusDetail }}</span>
        </div>
      </div>
    </main>
  `,
  emits: ['new-conversation', 'resume-conversation'],
  setup() {
    const store = Pinia.useChatStore();
    const containerRef = Vue.ref(null);
    const t = Vue.inject('t');

    // Online agents
    const onlineAgents = Vue.computed(() => {
      return store.agents.filter(a => a.online);
    });

    // 处理消息列表：将 tool-result 合并到对应的 tool-use 中，标记 tool-use 序列位置，分配折叠分组
    const processedMessages = Vue.computed(() => {
      const messages = store.messages;
      const result = [];

      for (let i = 0; i < messages.length; i++) {
        const msg = messages[i];

        // 跳过 tool-result 类型的消息（它会被合并到 tool-use 中）
        if (msg.type === 'tool-result') {
          continue;
        }

        // 对于 tool-use 消息，检查下一条是否是 tool-result，并标记序列位置
        if (msg.type === 'tool-use') {
          const nextMsg = messages[i + 1];
          const hasResult = nextMsg && nextMsg.type === 'tool-result';

          // 检查前一条非 tool-result 消息是否也是 tool-use
          let prevIdx = i - 1;
          while (prevIdx >= 0 && messages[prevIdx].type === 'tool-result') prevIdx--;
          const prevIsToolUse = prevIdx >= 0 && messages[prevIdx].type === 'tool-use';

          // 检查下一条非 tool-result 消息是否也是 tool-use
          let nextIdx = hasResult ? i + 2 : i + 1;
          const nextIsToolUse = nextIdx < messages.length && messages[nextIdx].type === 'tool-use';

          result.push({
            ...msg,
            hasResult,
            isFirst: !prevIsToolUse,
            isLast: !nextIsToolUse,
            isRunning: !hasResult && !msg.isHistory,
            isCompleted: !!hasResult
          });
        } else {
          result.push(msg);
        }
      }

      // 第二遍：为连续 tool-use 分配折叠分组
      let groupId = 0;
      let groupStart = -1;
      for (let i = 0; i <= result.length; i++) {
        const msg = result[i];
        const isToolUse = msg && msg.type === 'tool-use';

        if (isToolUse && groupStart === -1) {
          // 新分组开始
          groupStart = i;
          groupId++;
        } else if (!isToolUse && groupStart !== -1) {
          // 分组结束
          const groupSize = i - groupStart;
          if (groupSize > 1) {
            const gid = 'tg-' + groupId;
            for (let j = groupStart; j < i; j++) {
              result[j].groupId = gid;
              result[j].groupSize = groupSize;
              result[j].isLastInGroup = j === i - 1;
            }
          }
          groupStart = -1;
        }
      }

      return result;
    });

    // Shorten path for display
    const shortenPath = (path) => {
      if (!path) return '-';
      if (path.length <= 30) return path;
      const parts = path.split(/[/\\]/);
      if (parts.length <= 2) return path;
      return '...' + parts.slice(-2).join('/');
    };

    // Track if user is at bottom (within threshold)
    const isAtBottom = Vue.ref(true);
    const SCROLL_THRESHOLD = 50; // pixels from bottom to consider "at bottom"

    // Tool group collapse state
    const expandedGroups = Vue.reactive({});
    const toggleToolGroup = (groupId) => {
      expandedGroups[groupId] = !expandedGroups[groupId];
    };

    const hasStreamingMessage = Vue.computed(() => {
      return store.messages.some(m => m.isStreaming);
    });

    // 执行状态相关
    const currentTool = Vue.computed(() => store.executionStatus.currentTool);

    const statusIcon = Vue.computed(() => {
      const tool = currentTool.value;
      if (!tool) return '💭';

      // 根据工具类型返回不同图标
      const iconMap = {
        'Read': '📖',
        'Write': '✍️',
        'Edit': '✏️',
        'Bash': '⚡',
        'Glob': '🔍',
        'Grep': '🔎',
        'Task': '🤖',
        'WebFetch': '🌐',
        'WebSearch': '🔍',
        'TodoWrite': '📝'
      };
      return iconMap[tool.name] || '⚙️';
    });

    const statusIconClass = Vue.computed(() => {
      return currentTool.value ? 'executing' : 'thinking';
    });

    const statusText = Vue.computed(() => {
      const tool = currentTool.value;
      if (!tool) return t('status.thinking');

      const textMap = {
        'Read': t('status.reading'),
        'Write': t('status.writing'),
        'Edit': t('status.editing'),
        'Bash': t('status.executing'),
        'Glob': t('status.searchingFiles'),
        'Grep': t('status.searchingContent'),
        'Task': t('status.executingTask'),
        'WebFetch': t('status.fetching'),
        'WebSearch': t('status.searching'),
        'TodoWrite': t('status.updatingTasks')
      };
      return textMap[tool.name] || t('status.executingTool', { name: tool.name });
    });

    const statusDetail = Vue.computed(() => {
      const tool = currentTool.value;
      if (!tool || !tool.input) return '';

      // 根据工具类型显示关键信息
      if (tool.name === 'Read' && tool.input.file_path) {
        return shortenPath(tool.input.file_path);
      }
      if (tool.name === 'Edit' && tool.input.file_path) {
        return shortenPath(tool.input.file_path);
      }
      if (tool.name === 'Write' && tool.input.file_path) {
        return shortenPath(tool.input.file_path);
      }
      if (tool.name === 'Bash' && tool.input.command) {
        const cmd = tool.input.command;
        return cmd.length > 30 ? cmd.slice(0, 30) + '...' : cmd;
      }
      if (tool.name === 'Glob' && tool.input.pattern) {
        return tool.input.pattern;
      }
      if (tool.name === 'Grep' && tool.input.pattern) {
        return tool.input.pattern;
      }
      return '';
    });

    // Check if scrolled to bottom
    const checkIfAtBottom = () => {
      if (!containerRef.value) return true;
      const { scrollTop, scrollHeight, clientHeight } = containerRef.value;
      return scrollHeight - scrollTop - clientHeight <= SCROLL_THRESHOLD;
    };

    // Handle scroll events to track user position
    const onScroll = () => {
      isAtBottom.value = checkIfAtBottom();

      // ★ 检测是否滚动到顶部，加载更多
      if (containerRef.value) {
        const { scrollTop } = containerRef.value;
        if (scrollTop < 100 && store.hasMoreMessages && !store.loadingMoreMessages) {
          const prevScrollHeight = containerRef.value.scrollHeight;
          store.loadMoreMessages();

          // 等新消息渲染后恢复滚动位置
          const unwatch = Vue.watch(
            () => store.loadingMoreMessages,
            (loading) => {
              if (!loading) {
                Vue.nextTick(() => {
                  if (containerRef.value) {
                    const newScrollHeight = containerRef.value.scrollHeight;
                    containerRef.value.scrollTop = newScrollHeight - prevScrollHeight + scrollTop;
                  }
                });
                unwatch();
              }
            }
          );
        }
      }
    };

    const scrollToBottom = () => {
      if (containerRef.value) {
        containerRef.value.scrollTop = containerRef.value.scrollHeight;
        isAtBottom.value = true;
      }
    };

    // Only auto-scroll if user is at bottom
    const smartScrollToBottom = () => {
      if (isAtBottom.value) {
        Vue.nextTick(scrollToBottom);
      }
    };

    // Auto-scroll when messages change (only if at bottom)
    Vue.watch(
      () => store.messages.length,
      smartScrollToBottom
    );

    // Also scroll when streaming content updates (only if at bottom)
    Vue.watch(
      () => store.messages[store.messages.length - 1]?.content,
      smartScrollToBottom
    );

    // When switching conversations, always scroll to bottom
    Vue.watch(
      () => store.currentConversation,
      () => {
        isAtBottom.value = true;
        Vue.nextTick(scrollToBottom);
      }
    );

    Vue.onMounted(() => {
      scrollToBottom();
      // Add scroll listener
      if (containerRef.value) {
        containerRef.value.addEventListener('scroll', onScroll);
      }
    });

    Vue.onUnmounted(() => {
      if (containerRef.value) {
        containerRef.value.removeEventListener('scroll', onScroll);
      }
    });

    return {
      store,
      containerRef,
      hasStreamingMessage,
      onlineAgents,
      shortenPath,
      processedMessages,
      expandedGroups,
      toggleToolGroup,
      statusIcon,
      statusIconClass,
      statusText,
      statusDetail
    };
  }
};
