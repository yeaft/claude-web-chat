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
    // ★ Phase 6: 消息分页状态
    hasMoreMessages: false,
    loadingMoreMessages: false,
    // 可用的 slash commands 列表（从 Claude SDK init 消息获取）
    slashCommands: [],
    // 输入框草稿（按 conversationId 保存，切换时不丢失）
    inputDrafts: {},

    // =====================
    // Crew (multi-agent) 状态 — 按 sessionId 存储，融入 conversation 体系
    // =====================
    crewSessions: {},             // { [sessionId]: { id, projectDir, sharedDir, goal, roles, decisionMaker, maxRounds } }
    crewMessagesMap: {},          // { [sessionId]: messages[] }
    crewStatuses: {},             // { [sessionId]: { status, currentRole, round, maxRounds, costUsd, activeRoles } }
    crewSessionsList: [],         // 从索引加载的所有 crew sessions（含已停止的）
    crewConfigOpen: false,        // crew 配置面板是否打开
    crewConfigMode: 'create',    // 'create' | 'edit'

    // =====================
    // Group Chat (broadcast discussion channel) 状态
    // =====================
    groupChatSessions: {},        // { [sessionId]: { id, topic, status, participants, conclusion, round, ... } }
    groupChatMessagesMap: {},     // { [sessionId]: messages[] }
    groupChatSessionsList: [],    // 从 server 获取的频道列表
    groupChatConfigOpen: false,   // 创建面板是否打开
    groupChatStreaming: null,     // { sessionId, agentName, text } 当前流式输出
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
    // 当前 conversation 是否是 Crew
    currentConversationIsCrew: (state) => {
      if (!state.currentConversation) return false;
      const conv = state.conversations.find(c => c.id === state.currentConversation);
      return conv?.type === 'crew';
    },
    // 当前 Crew session 信息
    currentCrewSession: (state) => {
      if (!state.currentConversation) return null;
      return state.crewSessions[state.currentConversation] || null;
    },
    // 当前 Crew 状态
    currentCrewStatus: (state) => {
      if (!state.currentConversation) return null;
      return state.crewStatuses[state.currentConversation] || null;
    },
    // 当前 Crew 消息列表
    currentCrewMessages: (state) => {
      if (!state.currentConversation) return [];
      return state.crewMessagesMap[state.currentConversation] || [];
    },
    // 当前 conversation 是否是 Group Chat
    currentConversationIsGroupChat: (state) => {
      if (!state.currentConversation) return false;
      const conv = state.conversations.find(c => c.id === state.currentConversation);
      return conv?.type === 'group_chat';
    },
    // 当前 Group Chat session 信息
    currentGroupChatSession: (state) => {
      if (!state.currentConversation) return null;
      return state.groupChatSessions[state.currentConversation] || null;
    },
    // 当前 Group Chat 消息列表
    currentGroupChatMessages: (state) => {
      if (!state.currentConversation) return [];
      return state.groupChatMessagesMap[state.currentConversation] || [];
    }
  },

  actions: {
    // =====================
    // WebSocket helpers
    // =====================
    sendWsMessage(msg) { return wsHelpers.sendWsMessage(this, msg); },
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
    deleteConversation(conversationId, agentId) { convHelpers.deleteConversation(this, conversationId, agentId); },
    sendMessage(text, attachments = []) { convHelpers.sendMessage(this, text, attachments); },
    cancelExecution() { convHelpers.cancelExecution(this); },
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
      this.crewConfigMode = 'create';
      this.crewConfigOpen = true;
      // 加载持久化的 crew sessions 列表
      this.listCrewSessions();
    },

    listCrewSessions() {
      if (!this.currentAgent) return;
      this.sendWsMessage({
        type: 'list_crew_sessions',
        agentId: this.currentAgent
      });
    },

    openCrewConfig() {
      this.crewConfigMode = 'edit';
      this.crewConfigOpen = true;
    },

    createCrewSession(config) {
      const sessionId = 'crew_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      const agentId = config.agentId || this.currentAgent;
      // 初始化 crew 消息存储
      this.crewMessagesMap[sessionId] = [];
      this.sendWsMessage({
        type: 'create_crew_session',
        sessionId,
        projectDir: config.projectDir,
        sharedDir: config.sharedDir || '.crew',
        goal: config.goal,
        name: config.name || '',
        sharedKnowledge: config.sharedKnowledge || '',
        roles: config.roles,
        maxRounds: config.maxRounds || 20,
        agentId
      });
      this.crewConfigOpen = false;
    },

    resumeCrewSession(sessionId, agentId) {
      // 初始化 crew 消息存储
      if (!this.crewMessagesMap[sessionId]) this.crewMessagesMap[sessionId] = [];
      this.sendWsMessage({
        type: 'resume_crew_session',
        sessionId,
        agentId: agentId || this.currentAgent
      });
    },

    sendCrewMessage(content, targetRole = null, attachments = undefined) {
      const sessionId = this.currentConversation;
      // 添加人的消息到本地显示
      if (!this.crewMessagesMap[sessionId]) this.crewMessagesMap[sessionId] = [];
      this.crewMessagesMap[sessionId].push({
        id: Date.now(),
        role: 'human',
        roleIcon: 'H',
        roleName: '你',
        type: 'text',
        content,
        attachments,
        timestamp: Date.now()
      });
      // 发送到 server
      const msg = {
        type: 'crew_human_input',
        sessionId,
        content,
        targetRole,
        agentId: this.currentAgent
      };
      if (attachments && attachments.length > 0) {
        msg.attachments = attachments;
      }
      const sent = this.sendWsMessage(msg);
      if (!sent) {
        // Mark the message as failed so user knows it didn't send
        const messages = this.crewMessagesMap[sessionId];
        if (messages && messages.length > 0) {
          messages[messages.length - 1]._sendFailed = true;
        }
      }
    },

    sendCrewControl(action, targetRole = null) {
      const sessionId = this.currentConversation;
      this.sendWsMessage({
        type: 'crew_control',
        sessionId,
        action,
        targetRole,
        agentId: this.currentAgent
      });
    },

    addCrewRole(role) {
      const sessionId = this.currentConversation;
      this.sendWsMessage({
        type: 'crew_add_role',
        sessionId,
        role,
        agentId: this.currentAgent
      });
    },

    removeCrewRole(roleName) {
      const sessionId = this.currentConversation;
      this.sendWsMessage({
        type: 'crew_remove_role',
        sessionId,
        roleName,
        agentId: this.currentAgent
      });
    },

    handleCrewOutput(msg) {
      if (!msg) return;
      const sid = msg.sessionId;

      // 确保消息数组存在
      const ensureMessages = (sessionId) => {
        if (!this.crewMessagesMap[sessionId]) this.crewMessagesMap[sessionId] = [];
        return this.crewMessagesMap[sessionId];
      };

      if (msg.type === 'crew_session_created') {
        this.crewSessions[sid] = {
          id: sid,
          projectDir: msg.projectDir,
          sharedDir: msg.sharedDir,
          goal: msg.goal,
          name: msg.name || '',
          sharedKnowledge: msg.sharedKnowledge || '',
          roles: msg.roles,
          decisionMaker: msg.decisionMaker,
          maxRounds: msg.maxRounds
        };
        ensureMessages(sid).push({
          id: Date.now(),
          role: 'system',
          roleIcon: 'S',
          roleName: '系统',
          type: 'system',
          content: `Crew Session 已创建，目标: ${msg.goal}`,
          timestamp: Date.now()
        });
        // 创建或更新 conversation
        let conv = this.conversations.find(c => c.id === sid);
        if (!conv) {
          const agent = this.agents.find(a => a.id === this.currentAgent);
          conv = {
            id: sid,
            agentId: this.currentAgent,
            agentName: agent?.name || this.currentAgent,
            workDir: msg.projectDir,
            claudeSessionId: null,
            createdAt: Date.now(),
            processing: false,
            type: 'crew',
            goal: msg.goal,
            name: msg.name || ''
          };
          this.conversations.push(conv);
        } else {
          conv.type = 'crew';
          conv.goal = msg.goal;
          conv.name = msg.name || '';
        }
        // 缓存当前消息，切换到 crew conversation
        if (this.currentConversation && this.messages.length > 0) {
          this.messagesCache[this.currentConversation] = this.messages;
        }
        this.currentConversation = sid;
        this.currentWorkDir = msg.projectDir;
        this.messages = [];
        this.saveOpenSessions();
        return;
      }

      if (msg.type === 'crew_session_restored') {
        // 恢复时只重建 session 数据，不添加系统消息，不强制切换
        this.crewSessions[sid] = {
          id: sid,
          projectDir: msg.projectDir,
          sharedDir: msg.sharedDir,
          goal: msg.goal,
          name: msg.name || '',
          sharedKnowledge: msg.sharedKnowledge || '',
          roles: msg.roles,
          decisionMaker: msg.decisionMaker,
          maxRounds: msg.maxRounds
        };
        // 恢复 UI 消息历史
        if (msg.uiMessages && msg.uiMessages.length > 0) {
          this.crewMessagesMap[sid] = msg.uiMessages.map(m => ({
            id: m.timestamp || Date.now() + Math.random(),
            role: m.role,
            roleIcon: m.roleIcon,
            roleName: m.roleName,
            type: m.type,
            content: m.content,
            routeTo: m.routeTo,
            routeSummary: m.routeSummary || '',
            toolName: m.toolName || null,
            toolId: m.toolId || null,
            toolInput: m.toolInput || null,
            toolResult: null,
            hasResult: m.hasResult || false,
            taskId: m.taskId || null,
            taskTitle: m.taskTitle || null,
            timestamp: m.timestamp || Date.now()
            // 显式不包含 _streaming — 恢复的消息不应有 streaming 状态
          }));
        } else {
          ensureMessages(sid);
        }
        // 确保 conversation 存在
        let conv = this.conversations.find(c => c.id === sid);
        if (!conv) {
          const agent = this.agents.find(a => a.id === this.currentAgent);
          conv = {
            id: sid,
            agentId: this.currentAgent,
            agentName: agent?.name || this.currentAgent,
            workDir: msg.projectDir,
            claudeSessionId: null,
            createdAt: Date.now(),
            processing: false,
            type: 'crew',
            goal: msg.goal,
            name: msg.name || ''
          };
          this.conversations.push(conv);
        } else {
          conv.type = 'crew';
          conv.goal = msg.goal;
          conv.name = msg.name || '';
        }
        this.saveOpenSessions();
        return;
      }

      if (msg.type === 'crew_output') {
        const messages = ensureMessages(sid);
        const crewMsg = {
          id: Date.now() + Math.random(),
          role: msg.role,
          roleIcon: msg.roleIcon,
          roleName: msg.roleName,
          type: msg.outputType,
          taskId: msg.taskId || null,
          taskTitle: msg.taskTitle || null,
          timestamp: Date.now()
        };

        if (msg.outputType === 'text') {
          // 反向搜索该角色的最后一条 _streaming 消息（并发安全）
          let streamMsg = null;
          for (let i = messages.length - 1; i >= 0; i--) {
            if (messages[i].role === msg.role && messages[i].type === 'text' && messages[i]._streaming) {
              streamMsg = messages[i];
              break;
            }
          }
          // 如果没有 _streaming 消息，查找同角色最后一条 text（可能被 tool_use 关闭了 _streaming）
          // 如果中间只隔了 tool/tool_result（同角色），说明在同一 turn 内，重新 append
          if (!streamMsg) {
            for (let i = messages.length - 1; i >= 0; i--) {
              const m = messages[i];
              if (m.role !== msg.role) break; // 碰到其他角色的消息，停止
              if (m.type === 'text') { streamMsg = m; break; }
              if (m.type !== 'tool') break; // 碰到非 tool 类型（如 route/system），停止
            }
            if (streamMsg) streamMsg._streaming = true;
          }
          if (streamMsg) {
            const content = msg.data?.message?.content;
            if (content) {
              if (typeof content === 'string') {
                streamMsg.content += content;
              } else if (Array.isArray(content)) {
                for (const block of content) {
                  if (block.type === 'text') {
                    streamMsg.content += block.text;
                  }
                }
              }
            }
            return;
          }
          const content = msg.data?.message?.content;
          let text = '';
          if (typeof content === 'string') {
            text = content;
          } else if (Array.isArray(content)) {
            text = content.filter(b => b.type === 'text').map(b => b.text).join('');
          }
          crewMsg.content = text;
          crewMsg._streaming = true;
          messages.push(crewMsg);
          return;
        }

        if (msg.outputType === 'tool_use') {
          // 先结束该角色的 streaming 文本（tool_use 意味着文本部分结束）
          for (let i = messages.length - 1; i >= 0; i--) {
            if (messages[i].role === msg.role && messages[i].type === 'text' && messages[i]._streaming) {
              messages[i]._streaming = false;
              break;
            }
          }
          const content = msg.data?.message?.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (block.type === 'tool_use') {
                messages.push({
                  ...crewMsg,
                  type: 'tool',
                  toolName: block.name,
                  toolId: block.id,
                  toolInput: block.input,
                  hasResult: false,
                  toolResult: null,
                  content: `${block.name} ${block.input?.file_path || block.input?.command?.substring(0, 60) || ''}`
                });
              }
            }
          }
          return;
        }

        if (msg.outputType === 'tool_result') {
          const resultContent = msg.data?.message?.content;
          if (Array.isArray(resultContent)) {
            for (const block of resultContent) {
              if (block.type === 'tool_result' && block.tool_use_id) {
                for (let i = messages.length - 1; i >= 0; i--) {
                  if (messages[i].type === 'tool' && messages[i].toolId === block.tool_use_id) {
                    messages[i].hasResult = true;
                    messages[i].toolResult = block.content;
                    break;
                  }
                }
              }
            }
          }
          return;
        }

        if (msg.outputType === 'route') {
          messages.push({
            ...crewMsg,
            type: 'route',
            routeTo: msg.routeTo,
            routeSummary: msg.routeSummary || '',
            round: this.crewStatuses[sid]?.round || 0,
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
          messages.push({
            ...crewMsg,
            type: 'system',
            content: text
          });
          return;
        }
      }

      if (msg.type === 'crew_image') {
        const messages = ensureMessages(sid);
        messages.push({
          id: Date.now() + Math.random(),
          role: msg.role,
          roleIcon: msg.roleIcon,
          roleName: msg.roleName,
          type: 'image',
          fileId: msg.fileId,
          previewToken: msg.previewToken,
          mimeType: msg.mimeType,
          toolId: msg.toolId,
          taskId: msg.taskId || null,
          taskTitle: msg.taskTitle || null,
          timestamp: Date.now()
        });
        return;
      }

      if (msg.type === 'crew_status') {
        this.crewStatuses[sid] = {
          status: msg.status,
          currentRole: msg.currentRole,
          round: msg.round,
          maxRounds: msg.maxRounds,
          costUsd: msg.costUsd,
          totalInputTokens: msg.totalInputTokens || 0,
          totalOutputTokens: msg.totalOutputTokens || 0,
          activeRoles: msg.activeRoles || [],
          currentToolByRole: msg.currentToolByRole || {}
        };
        if (msg.roles && this.crewSessions[sid]) {
          this.crewSessions[sid].roles = msg.roles;
        }
        // 根据 activeRoles 同步 _streaming 标记
        const messages = this.crewMessagesMap[sid];
        if (messages) {
          const activeSet = new Set(msg.activeRoles || []);
          if (activeSet.size === 0) {
            for (const m of messages) {
              if (m._streaming) m._streaming = false;
            }
          } else {
            for (const m of messages) {
              if (m._streaming && !activeSet.has(m.role)) {
                m._streaming = false;
              }
            }
          }
        }
        return;
      }

      if (msg.type === 'crew_turn_completed') {
        const messages = ensureMessages(sid);
        for (let i = messages.length - 1; i >= 0; i--) {
          if (messages[i].role === msg.role && messages[i]._streaming) {
            messages[i]._streaming = false;
            if (msg.interrupted) {
              messages[i].interrupted = true;
            }
            break;
          }
        }
        return;
      }

      if (msg.type === 'crew_message_queued') {
        ensureMessages(sid).push({
          id: Date.now() + Math.random(),
          role: 'system',
          type: 'system',
          content: `消息已排队，等待 ${msg.target} 完成当前任务（队列: ${msg.queueLength}）`,
          timestamp: Date.now()
        });
        return;
      }

      if (msg.type === 'crew_human_needed') {
        ensureMessages(sid).push({
          id: Date.now(),
          role: 'system',
          roleIcon: 'S',
          roleName: '系统',
          type: 'human_needed',
          fromRole: msg.fromRole,
          content: `${msg.fromRole} 需要人工介入: ${msg.message}`,
          timestamp: Date.now()
        });
        return;
      }

      if (msg.type === 'crew_role_added') {
        if (this.crewSessions[sid]) {
          this.crewSessions[sid].roles = [...(this.crewSessions[sid].roles || []), msg.role];
          if (msg.decisionMaker) {
            this.crewSessions[sid].decisionMaker = msg.decisionMaker;
          }
        }
        return;
      }

      if (msg.type === 'crew_role_removed') {
        if (this.crewSessions[sid]) {
          this.crewSessions[sid].roles = (this.crewSessions[sid].roles || []).filter(r => r.name !== msg.roleName);
          if (msg.decisionMaker !== undefined) {
            this.crewSessions[sid].decisionMaker = msg.decisionMaker;
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

    // =====================
    // Group Chat (broadcast discussion channel) actions
    // =====================
    enterGroupChatMode() {
      this.groupChatConfigOpen = true;
      this.listGroupChats();
    },

    listGroupChats() {
      this.sendWsMessage({ type: 'list_group_chats' });
    },

    createGroupChat(config) {
      this.sendWsMessage({
        type: 'create_group_chat',
        topic: config.topic
      });
      this.groupChatConfigOpen = false;
    },

    joinGroupChat(sessionId, agentId) {
      this.sendWsMessage({
        type: 'join_group_chat',
        sessionId,
        agentId
      });
    },

    leaveGroupChat(sessionId, agentId) {
      this.sendWsMessage({
        type: 'leave_group_chat',
        sessionId,
        agentId
      });
    },

    stopGroupChat(sessionId) {
      this.sendWsMessage({
        type: 'stop_group_chat',
        sessionId
      });
    },

    deleteGroupChat(sessionId) {
      this.sendWsMessage({
        type: 'delete_group_chat',
        sessionId
      });
      delete this.groupChatSessions[sessionId];
      delete this.groupChatMessagesMap[sessionId];
      // 从 conversations 移除
      this.conversations = this.conversations.filter(c => c.id !== sessionId);
      if (this.currentConversation === sessionId) {
        this.currentConversation = null;
      }
    },

    selectGroupChat(sessionId, sessionData) {
      // 确保 session 数据存在
      if (!this.groupChatSessions[sessionId]) {
        this.groupChatSessions[sessionId] = sessionData
          ? { id: sessionId, topic: sessionData.topic, status: sessionData.status, participants: sessionData.participants || [], conclusion: sessionData.conclusion, round: sessionData.round || 0, createdAt: sessionData.createdAt }
          : { id: sessionId, status: 'unknown' };
      }
      if (!this.groupChatMessagesMap[sessionId]) {
        this.groupChatMessagesMap[sessionId] = [];
      }

      // 确保在 conversations 列表中
      const existing = this.conversations.find(c => c.id === sessionId);
      if (!existing) {
        const session = this.groupChatSessions[sessionId];
        this.conversations.push({
          id: sessionId,
          type: 'group_chat',
          topic: session.topic || '',
          createdAt: session.createdAt || Date.now()
        });
      }

      this.currentConversation = sessionId;
    },

    handleGroupChatOutput(msg) {
      const sid = msg.sessionId;

      switch (msg.type) {
        case 'group_chat_created': {
          // 创建 session
          this.groupChatSessions[sid] = {
            id: sid,
            topic: msg.topic,
            status: msg.status || 'waiting',
            participants: [],
            conclusion: null,
            round: 0,
            createdAt: msg.createdAt
          };
          this.groupChatMessagesMap[sid] = [];

          // 添加到 conversations 并切换
          this.conversations.push({
            id: sid,
            type: 'group_chat',
            topic: msg.topic,
            createdAt: msg.createdAt
          });
          this.currentConversation = sid;

          // 添加系统消息
          this.groupChatMessagesMap[sid].push({
            id: 'sys_' + Date.now(),
            type: 'system',
            content: `讨论频道已创建，主题: "${msg.topic}"`,
            timestamp: Date.now()
          });
          break;
        }

        case 'group_chat_member_joined': {
          const session = this.groupChatSessions[sid];
          if (session) {
            session.participants = msg.participants || [];
          }

          // 添加系统消息
          if (this.groupChatMessagesMap[sid]) {
            this.groupChatMessagesMap[sid].push({
              id: 'sys_' + Date.now() + '_join',
              type: 'system',
              content: `${msg.agentName} 加入了讨论 (${msg.participantCount} 位参与者)`,
              timestamp: Date.now()
            });
          }
          break;
        }

        case 'group_chat_member_left': {
          const session = this.groupChatSessions[sid];
          if (session && msg.participants) {
            session.participants = msg.participants;
          }

          if (this.groupChatMessagesMap[sid]) {
            this.groupChatMessagesMap[sid].push({
              id: 'sys_' + Date.now() + '_leave',
              type: 'system',
              content: `${msg.agentName} 退出了讨论${msg.reason === 'disconnected' ? ' (断开连接)' : ''}`,
              timestamp: Date.now()
            });
          }
          break;
        }

        case 'group_chat_status': {
          const session = this.groupChatSessions[sid];
          if (session) {
            session.status = msg.status;
            if (msg.round !== undefined) session.round = msg.round;
            if (msg.currentSpeaker) session.currentSpeaker = msg.currentSpeaker;
            if (msg.currentSpeakerAgentId) session.currentSpeakerAgentId = msg.currentSpeakerAgentId;

            // 更新参与者中的发言状态
            if (msg.currentSpeakerAgentId && session.participants) {
              session.participants = session.participants.map(p => ({
                ...p,
                status: p.agentId === msg.currentSpeakerAgentId ? 'speaking' : (p.status === 'speaking' ? 'idle' : p.status)
              }));
            }
          }

          if (msg.status === 'discussing' && msg.round && this.groupChatMessagesMap[sid]) {
            // 讨论开始/新轮次的系统消息只在第一轮加
            if (msg.round === 1) {
              this.groupChatMessagesMap[sid].push({
                id: 'sys_round_' + msg.round,
                type: 'system',
                content: `讨论开始！第 1 轮`,
                timestamp: Date.now()
              });
            }
          }
          break;
        }

        case 'group_chat_output': {
          // 流式输出
          if (msg.streaming) {
            if (!this.groupChatStreaming || this.groupChatStreaming.sessionId !== sid) {
              this.groupChatStreaming = { sessionId: sid, agentName: msg.agentName, text: '' };
            }
            this.groupChatStreaming.text += msg.content || '';
            this.groupChatStreaming.agentName = msg.agentName;
          }
          break;
        }

        case 'group_chat_message': {
          // 完整发言消息
          if (this.groupChatMessagesMap[sid]) {
            this.groupChatMessagesMap[sid].push({
              id: msg.message.id,
              type: 'text',
              agentId: msg.message.agentId,
              agentName: msg.message.agentName,
              content: msg.message.content,
              round: msg.message.round,
              timestamp: msg.message.timestamp
            });
          }
          // 清除流式输出
          if (this.groupChatStreaming?.sessionId === sid) {
            this.groupChatStreaming = null;
          }
          // 重置发言者状态
          const sessionForMsg = this.groupChatSessions[sid];
          if (sessionForMsg?.participants) {
            sessionForMsg.participants = sessionForMsg.participants.map(p => ({
              ...p,
              status: p.agentId === msg.message.agentId ? 'done' : p.status
            }));
          }
          break;
        }

        case 'group_chat_consensus': {
          const session = this.groupChatSessions[sid];
          if (session) {
            session.status = 'consensus';
            session.conclusion = msg.conclusion;
          }

          if (this.groupChatMessagesMap[sid]) {
            this.groupChatMessagesMap[sid].push({
              id: 'consensus_' + Date.now(),
              type: 'system',
              content: `讨论达成共识！经过 ${msg.round} 轮讨论。`,
              timestamp: Date.now()
            });
          }
          // 清除流式输出
          if (this.groupChatStreaming?.sessionId === sid) {
            this.groupChatStreaming = null;
          }
          break;
        }

        case 'group_chat_list': {
          this.groupChatSessionsList = msg.sessions || [];
          break;
        }
      }
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
      // Group Chat cleanup
      this.groupChatSessions = {};
      this.groupChatMessagesMap = {};
      this.groupChatSessionsList = [];
      this.groupChatConfigOpen = false;
      this.groupChatStreaming = null;
      if (this.ws) {
        this.ws.close();
      }
    }
  }
});
