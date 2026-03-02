import { useAuthStore } from './auth.js';
import { setLocale, getLocale } from '../utils/i18n.js';

// Helper modules
import * as wsHelpers from './helpers/websocket.js';
import * as msgHelpers from './helpers/messages.js';
import * as claudeHelpers from './helpers/claudeOutput.js';
import * as handlerHelpers from './helpers/messageHandler.js';
import * as convHelpers from './helpers/conversation.js';
import * as sessionHelpers from './helpers/session.js';
import * as watchdogHelpers from './helpers/watchdog.js';

const { defineStore } = Pinia;

export const useChatStore = defineStore('chat', {
  state: () => ({
    ws: null,
    authenticated: false,
    sessionKey: null, // Uint8Array for encryption
    // 连接状态
    connectionState: 'disconnected', // 'disconnected' | 'connecting' | 'connected' | 'reconnecting'
    reconnectAttempts: 0,
    maxReconnectAttempts: 10,
    reconnectTimer: null,
    agents: [],
    currentAgent: null,
    currentAgentInfo: null,
    // 所有活跃的 conversations（跨所有 agents）
    // 每个 conversation 包含 { id, agentId, agentName, workDir, claudeSessionId, createdAt, processing }
    conversations: [],
    currentConversation: null,
    currentWorkDir: null,
    // 当前会话的消息
    messages: [],
    // 消息缓存：conversationId -> messages[] (使用对象而非 Map 以确保响应式)
    messagesCache: {},
    // 会话标题缓存：conversationId -> title (最新用户消息，使用对象而非 Map 以确保响应式)
    conversationTitles: {},
    // Per-conversation 处理状态：conversationId -> true (使用对象而非 Set 以确保响应式)
    processingConversations: {},
    theme: localStorage.getItem('theme') || 'dark',
    locale: localStorage.getItem('locale') || 'zh-CN',
    // Per-conversation 执行状态追踪：conversationId -> { currentTool, toolHistory, lastActivity }
    executionStatusMap: {},
    // 历史会话列表 (用于恢复对话框)
    historySessions: [],
    historySessionsLoading: false,
    // 可用的工作目录列表
    folders: [],
    foldersLoading: false,
    // Context 用量
    contextUsage: null,
    // 上次使用的 agent 和 session（持久化）
    lastUsedAgent: localStorage.getItem('lastUsedAgent') || null,
    lastUsedSession: JSON.parse(localStorage.getItem('lastUsedSession') || 'null'),
    // 所有打开的会话信息（持久化）
    lastViewedConversation: localStorage.getItem('lastViewedConversation') || null,
    // 会话恢复状态
    pendingRecovery: null,  // 待恢复的会话信息
    recoveryDismissed: false,  // 用户是否已拒绝恢复
    // Loading 状态
    sessionLoading: false,  // 创建/恢复会话时的 loading
    sessionLoadingText: '',  // loading 时显示的文字
    agentSwitching: false,  // 切换 agent 时的 loading
    // 临时保存恢复会话时的标题
    _pendingSessionTitle: null,
    // Workbench 面板是否展开（替代 backgroundPanelExpanded）
    workbenchExpanded: false,
    // Workbench 面板是否最大化（隐藏 conversation）
    workbenchMaximized: false,
    // 左侧侧边栏是否收起
    sidebarCollapsed: false,
    // Context compact 状态: { conversationId, status: 'compacting'|'completed', message }
    compactStatus: null,
    // 代理端口映射: agentId → [{port, label, enabled}]
    proxyPorts: {},
    // 消息排队: conversationId → [{id, prompt, queuedAt}]
    messageQueues: {},
    // ★ Phase 6: 消息分页状态
    hasMoreMessages: false,
    loadingMoreMessages: false,
    // 可用的 slash commands 列表（从 Claude SDK init 消息获取）
    slashCommands: [],

    // =====================
    // Crew (multi-agent) 状态
    // =====================
    crewMode: false,              // 是否处于 crew 模式
    crewSession: null,            // 当前 crew session 信息
    crewMessages: [],             // crew 群聊消息
    crewStatus: null,             // crew 状态 { status, currentRole, round, maxRounds, costUsd }
    crewConfigOpen: false,        // crew 配置面板是否打开
  }),

  getters: {
    // 当前会话是否在处理中
    isProcessing: (state) => {
      return state.currentConversation ? !!state.processingConversations[state.currentConversation] : false;
    },
    canSend: (state) => {
      if (!state.currentAgent || !state.currentConversation) return false;
      return true; // 始终允许发送（排队机制支持）
    },
    // 当前会话的排队消息列表
    currentQueue: (state) => {
      if (!state.currentConversation) return [];
      return state.messageQueues[state.currentConversation] || [];
    },
    currentAgentName: (state) => {
      return state.currentAgentInfo?.name || '选择 Agent';
    },
    currentAgentWorkDir: (state) => {
      return state.currentAgentInfo?.workDir || '';
    },
    // 当前 Agent 的能力列表
    currentAgentCapabilities: (state) => {
      return state.currentAgentInfo?.capabilities || ['terminal', 'file_editor', 'background_tasks'];
    },
    // 检查当前 Agent 是否支持指定能力
    hasCapability: (state) => (capability) => {
      const caps = state.currentAgentInfo?.capabilities || ['terminal', 'file_editor', 'background_tasks'];
      return caps.includes(capability);
    },
    // 获取会话标题
    getConversationTitle: (state) => (conversationId) => {
      return state.conversationTitles[conversationId] || null;
    },
    // 获取当前会话的执行状态
    executionStatus: (state) => {
      if (!state.currentConversation) {
        return { currentTool: null, toolHistory: [], lastActivity: null };
      }
      return state.executionStatusMap[state.currentConversation] || { currentTool: null, toolHistory: [], lastActivity: null };
    },
    // 检查某个会话是否在处理中
    isConversationProcessing: (state) => (conversationId) => {
      return !!state.processingConversations[conversationId];
    },
    // 是否显示恢复提示
    showRecoveryBanner: (state) => {
      return state.pendingRecovery && !state.recoveryDismissed && !state.currentConversation;
    },
    // 当前会话的后台任务列表（保留接口兼容）
    currentBackgroundTasks: () => {
      return [];
    },
    // 是否有正在运行的后台任务
    hasRunningBackgroundTasks: () => {
      return false;
    },
    // 当前选中的后台任务详情
    selectedTaskInfo: () => {
      return null;
    },
    // 当前会话的 MCP 是否启用（disallowedTools 不包含 mcp__*）
    currentMcpEnabled: (state) => {
      if (!state.currentConversation) return false;
      const conv = state.conversations.find(c => c.id === state.currentConversation);
      if (!conv) return false;
      if (conv.disallowedTools === null || conv.disallowedTools === undefined) return false;
      if (conv.disallowedTools.length === 0) return true;
      return !conv.disallowedTools.some(t => t === 'mcp__*');
    }
  },

  actions: {
    // =====================
    // WebSocket helpers
    // =====================
    sendWsMessage(msg) { wsHelpers.sendWsMessage(this, msg); },
    parseWsMessage(data) { return wsHelpers.parseWsMessage(this, data); },
    connect() { wsHelpers.connect(this); },
    scheduleReconnect() { wsHelpers.scheduleReconnect(this); },
    manualReconnect() { wsHelpers.manualReconnect(this); },
    startHeartbeat() { wsHelpers.startHeartbeat(this); },
    stopHeartbeat() { wsHelpers.stopHeartbeat(this); },
    setupVisibilityHandler() { wsHelpers.setupVisibilityHandler(this); },

    // =====================
    // Message dispatcher
    // =====================
    handleMessage(msg) { handlerHelpers.handleMessage(this, msg); },

    // =====================
    // Claude output processing
    // =====================
    getOrCreateExecutionStatus(conversationId) { return claudeHelpers.getOrCreateExecutionStatus(this, conversationId); },
    handleClaudeOutput(conversationId, data) { claudeHelpers.handleClaudeOutput(this, conversationId, data); },

    // =====================
    // Message CRUD
    // =====================
    addMessageToConversation(conversationId, msg) { msgHelpers.addMessageToConversation(this, conversationId, msg); },
    appendToAssistantMessageForConversation(conversationId, text) { msgHelpers.appendToAssistantMessageForConversation(this, conversationId, text); },
    finishStreamingForConversation(conversationId) { msgHelpers.finishStreamingForConversation(this, conversationId); },
    appendToAssistantMessage(text) { this.appendToAssistantMessageForConversation(this.currentConversation, text); },
    finishStreaming() { this.finishStreamingForConversation(this.currentConversation); },
    addMessage(msg) { this.addMessageToConversation(this.currentConversation, msg); },
    loadHistoryMessages(historyMessages) { msgHelpers.loadHistoryMessages(this, historyMessages); },
    formatDbMessage(dbMsg) { return msgHelpers.formatDbMessage(dbMsg); },

    // =====================
    // Conversation lifecycle
    // =====================
    selectAgent(agentId) { convHelpers.selectAgent(this, agentId); },
    createConversation(workDir, agentId = null, disallowedTools = null) { convHelpers.createConversation(this, workDir, agentId, disallowedTools); },
    resumeConversation(claudeSessionId, workDir, agentId = null, disallowedTools = null) { convHelpers.resumeConversation(this, claudeSessionId, workDir, agentId, disallowedTools); },
    selectConversation(conversationId, agentId) { convHelpers.selectConversation(this, conversationId, agentId); },
    updateConversationSettings(conversationId, settings) { convHelpers.updateConversationSettings(this, conversationId, settings); },
    toggleMcp() { convHelpers.toggleMcp(this); },
    deleteConversation(conversationId, agentId) { convHelpers.deleteConversation(this, conversationId, agentId); },
    sendMessage(text, attachments = []) { convHelpers.sendMessage(this, text, attachments); },
    cancelExecution() { convHelpers.cancelExecution(this); },
    cancelQueuedMessage(queueId) { convHelpers.cancelQueuedMessage(this, queueId); },
    answerUserQuestion(requestId, answers) { convHelpers.answerUserQuestion(this, requestId, answers); },
    refreshAgents() { convHelpers.refreshAgents(this); },
    refreshConversation() { convHelpers.refreshConversation(this); },
    restartAgent(agentId) { convHelpers.restartAgent(this, agentId); },
    upgradeAgent(agentId) { convHelpers.upgradeAgent(this, agentId); },

    // ★ Phase 6.1: 分页加载（基于 turn，统一走 DB）
    loadMoreMessages() {
      if (this.loadingMoreMessages || !this.hasMoreMessages || !this.currentConversation) return;
      this.loadingMoreMessages = true;

      const firstMsgWithId = this.messages.find(m => m.dbMessageId);
      this.sendWsMessage({
        type: 'sync_messages',
        conversationId: this.currentConversation,
        turns: 5,
        ...(firstMsgWithId ? { beforeId: firstMsgWithId.dbMessageId } : {})
      });
    },

    // =====================
    // Session persistence
    // =====================
    checkPendingRecovery() { sessionHelpers.checkPendingRecovery(this); },
    performRecovery() { sessionHelpers.performRecovery(this); },
    dismissRecovery() { sessionHelpers.dismissRecovery(this); },
    autoRestoreConversation(conversationId) { sessionHelpers.autoRestoreConversation(this, conversationId); },
    saveOpenSessions() { sessionHelpers.saveOpenSessions(this); },
    getLastSession() { return sessionHelpers.getLastSession(this); },
    clearLastSession() { sessionHelpers.clearLastSession(this); },
    listHistorySessions(workDir) { sessionHelpers.listHistorySessions(this, workDir); },
    listFolders() { return sessionHelpers.listFolders(this); },
    listFoldersForAgent(agentId) { return sessionHelpers.listFoldersForAgent(this, agentId); },
    listHistorySessionsForAgent(agentId, workDir) { sessionHelpers.listHistorySessionsForAgent(this, agentId, workDir); },
    async loadGlobalSessions(limit = 20) { return sessionHelpers.loadGlobalSessions(this, limit); },
    async deleteGlobalSession(sessionId) { return sessionHelpers.deleteGlobalSession(this, sessionId); },
    findAgentForSession(session) { return sessionHelpers.findAgentForSession(this, session); },
    isSessionResumable(session) { return sessionHelpers.isSessionResumable(this, session); },

    // =====================
    // Watchdog
    // =====================
    _isRecentlyClosed(conversationId) { return watchdogHelpers.isRecentlyClosed(this, conversationId); },
    _startProcessingWatchdog(conversationId) { watchdogHelpers.startProcessingWatchdog(this, conversationId); },
    _resetProcessingWatchdog(conversationId) { watchdogHelpers.resetProcessingWatchdog(this, conversationId); },
    _stopProcessingWatchdog(conversationId) { watchdogHelpers.stopProcessingWatchdog(this, conversationId); },

    // =====================
    // UI helpers
    // =====================
    toggleTheme() {
      this.theme = this.theme === 'dark' ? 'light' : 'dark';
      localStorage.setItem('theme', this.theme);
      document.documentElement.setAttribute('data-theme', this.theme);
      document.documentElement.classList.toggle('light', this.theme === 'light');
    },

    initTheme() {
      document.documentElement.setAttribute('data-theme', this.theme);
      document.documentElement.classList.toggle('light', this.theme === 'light');
    },

    changeLocale(locale) {
      this.locale = locale;
      setLocale(locale);
    },

    toggleWorkbench() {
      this.workbenchExpanded = !this.workbenchExpanded;
      if (!this.workbenchExpanded) {
        this.workbenchMaximized = false;
      }
    },

    toggleSidebar() {
      this.sidebarCollapsed = !this.sidebarCollapsed;
    },

    toggleWorkbenchMaximized() {
      this.workbenchMaximized = !this.workbenchMaximized;
    },

    // =====================
    // Crew (multi-agent) actions
    // =====================
    enterCrewMode() {
      this.crewMode = true;
      this.crewConfigOpen = true;
      this.crewMessages = [];
      this.crewSession = null;
      this.crewStatus = null;
    },

    exitCrewMode() {
      this.crewMode = false;
      this.crewConfigOpen = false;
      this.crewSession = null;
      this.crewMessages = [];
      this.crewStatus = null;
    },

    createCrewSession(config) {
      const sessionId = 'crew_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      this.sendWsMessage({
        type: 'create_crew_session',
        sessionId,
        projectDir: config.projectDir,
        sharedDir: config.sharedDir || '.crew',
        goal: config.goal,
        roles: config.roles,
        maxRounds: config.maxRounds || 20,
        agentId: this.currentAgent
      });
      this.crewConfigOpen = false;
    },

    sendCrewMessage(content, targetRole = null) {
      if (!this.crewSession) return;
      // 添加人的消息到本地显示
      this.crewMessages.push({
        id: Date.now(),
        role: 'human',
        roleIcon: '👤',
        roleName: '你',
        type: 'text',
        content,
        timestamp: Date.now()
      });
      // 发送到 server
      this.sendWsMessage({
        type: 'crew_human_input',
        sessionId: this.crewSession.id,
        content,
        targetRole,
        agentId: this.currentAgent
      });
    },

    sendCrewControl(action, targetRole = null) {
      if (!this.crewSession) return;
      this.sendWsMessage({
        type: 'crew_control',
        sessionId: this.crewSession.id,
        action,
        targetRole,
        agentId: this.currentAgent
      });
    },

    addCrewRole(role) {
      if (!this.crewSession) return;
      this.sendWsMessage({
        type: 'crew_add_role',
        sessionId: this.crewSession.id,
        role,
        agentId: this.currentAgent
      });
    },

    removeCrewRole(roleName) {
      if (!this.crewSession) return;
      this.sendWsMessage({
        type: 'crew_remove_role',
        sessionId: this.crewSession.id,
        roleName,
        agentId: this.currentAgent
      });
    },

    handleCrewOutput(msg) {
      if (!msg) return;

      if (msg.type === 'crew_session_created') {
        this.crewSession = {
          id: msg.sessionId,
          projectDir: msg.projectDir,
          sharedDir: msg.sharedDir,
          goal: msg.goal,
          roles: msg.roles,
          decisionMaker: msg.decisionMaker,
          maxRounds: msg.maxRounds
        };
        this.crewMessages.push({
          id: Date.now(),
          role: 'system',
          roleIcon: '⚙️',
          roleName: '系统',
          type: 'system',
          content: `Crew Session 已创建，目标: ${msg.goal}`,
          timestamp: Date.now()
        });
        return;
      }

      if (msg.type === 'crew_output') {
        const crewMsg = {
          id: Date.now() + Math.random(),
          role: msg.role,
          roleIcon: msg.roleIcon,
          roleName: msg.roleName,
          type: msg.outputType,
          timestamp: Date.now()
        };

        if (msg.outputType === 'text') {
          // 流式文本：追加到最后一条同角色的消息
          const lastMsg = this.crewMessages.length > 0 ? this.crewMessages[this.crewMessages.length - 1] : null;
          if (lastMsg && lastMsg.role === msg.role && lastMsg.type === 'text' && lastMsg._streaming) {
            // 追加文本
            const content = msg.data?.message?.content;
            if (content) {
              if (typeof content === 'string') {
                lastMsg.content += content;
              } else if (Array.isArray(content)) {
                for (const block of content) {
                  if (block.type === 'text') {
                    lastMsg.content += block.text;
                  }
                }
              }
            }
            return;
          }
          // 新消息
          const content = msg.data?.message?.content;
          let text = '';
          if (typeof content === 'string') {
            text = content;
          } else if (Array.isArray(content)) {
            text = content.filter(b => b.type === 'text').map(b => b.text).join('');
          }
          crewMsg.content = text;
          crewMsg._streaming = true;
          this.crewMessages.push(crewMsg);
          return;
        }

        if (msg.outputType === 'tool_use') {
          const content = msg.data?.message?.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (block.type === 'tool_use') {
                this.crewMessages.push({
                  ...crewMsg,
                  type: 'tool',
                  toolName: block.name,
                  toolInput: block.input,
                  content: `${block.name} ${block.input?.file_path || block.input?.command?.substring(0, 60) || ''}`
                });
              }
            }
          }
          return;
        }

        if (msg.outputType === 'route') {
          this.crewMessages.push({
            ...crewMsg,
            type: 'route',
            routeTo: msg.routeTo,
            content: `→ @${msg.routeTo} ${msg.routeSummary || ''}`
          });
          return;
        }

        if (msg.outputType === 'system') {
          const content = msg.data?.message?.content;
          let text = '';
          if (typeof content === 'string') {
            text = content;
          } else if (Array.isArray(content)) {
            text = content.filter(b => b.type === 'text').map(b => b.text).join('');
          }
          this.crewMessages.push({
            ...crewMsg,
            type: 'system',
            content: text
          });
          return;
        }
      }

      if (msg.type === 'crew_status') {
        this.crewStatus = {
          status: msg.status,
          currentRole: msg.currentRole,
          round: msg.round,
          maxRounds: msg.maxRounds,
          costUsd: msg.costUsd,
          activeRoles: msg.activeRoles || []
        };
        // 同步 roles 列表（角色变动后 status 会携带最新列表）
        if (msg.roles && this.crewSession) {
          this.crewSession.roles = msg.roles;
        }
        return;
      }

      if (msg.type === 'crew_turn_completed') {
        // 标记最后一条该角色的消息为非流式
        for (let i = this.crewMessages.length - 1; i >= 0; i--) {
          if (this.crewMessages[i].role === msg.role && this.crewMessages[i]._streaming) {
            this.crewMessages[i]._streaming = false;
            break;
          }
        }
        return;
      }

      if (msg.type === 'crew_human_needed') {
        this.crewMessages.push({
          id: Date.now(),
          role: 'system',
          roleIcon: '🔔',
          roleName: '系统',
          type: 'human_needed',
          fromRole: msg.fromRole,
          content: `${msg.fromRole} 需要人工介入: ${msg.message}`,
          timestamp: Date.now()
        });
        return;
      }

      if (msg.type === 'crew_role_added') {
        // 更新 session 的 roles 列表
        if (this.crewSession) {
          this.crewSession.roles = [...(this.crewSession.roles || []), msg.role];
          if (msg.decisionMaker) {
            this.crewSession.decisionMaker = msg.decisionMaker;
          }
        }
        return;
      }

      if (msg.type === 'crew_role_removed') {
        // 更新 session 的 roles 列表
        if (this.crewSession) {
          this.crewSession.roles = (this.crewSession.roles || []).filter(r => r.name !== msg.roleName);
          if (msg.decisionMaker !== undefined) {
            this.crewSession.decisionMaker = msg.decisionMaker;
          }
        }
        return;
      }
    },

    openFileInExplorer(filePath) {
      if (!this.currentConversation) return;
      this.workbenchExpanded = true;
      window.dispatchEvent(new CustomEvent('open-file-in-explorer', {
        detail: { filePath, conversationId: this.currentConversation }
      }));
    },

    logout() {
      const authStore = useAuthStore();
      authStore.logout();
      this.authenticated = false;
      this.sessionKey = null;
      this.agents = [];
      this.currentAgent = null;
      this.currentAgentInfo = null;
      this.conversations = [];
      this.currentConversation = null;
      this.messages = [];
      this.messagesCache = {};
      this.conversationTitles = {};
      this.processingConversations = {};
      this.executionStatusMap = {};
      this.workbenchExpanded = false;
      if (this.ws) {
        this.ws.close();
      }
    }
  }
});
