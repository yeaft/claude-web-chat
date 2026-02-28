import ChatHeader from './ChatHeader.js';
import MessageList from './MessageList.js';
import ChatInput from './ChatInput.js';
import WorkbenchPanel from './WorkbenchPanel.js';
import ProxyTab from './ProxyTab.js';
import SettingsPanel from './SettingsPanel.js';
import { useAuthStore } from '../stores/auth.js';

export default {
  name: 'ChatPage',
  components: { ChatHeader, MessageList, ChatInput, WorkbenchPanel, ProxyTab, SettingsPanel },
  template: `
    <div class="chat-page" :class="{ 'show-sidebar': showMobileSidebar }">
      <!-- Mobile Menu Button -->
      <button class="mobile-menu-btn" @click="showMobileSidebar = !showMobileSidebar">
        <svg viewBox="0 0 24 24"><path d="M3 18h18v-2H3v2zm0-5h18v-2H3v2zm0-7v2h18V6H3z"/></svg>
      </button>

      <!-- Sidebar Overlay -->
      <div class="sidebar-overlay" v-if="showMobileSidebar" @click="showMobileSidebar = false"></div>

      <!-- Left Sidebar -->
      <aside class="sidebar" :class="{ collapsed: store.sidebarCollapsed }">
        <!-- Collapsed Icon Bar -->
        <div class="sidebar-collapsed-bar" v-if="store.sidebarCollapsed">
          <button class="collapsed-icon-btn" @click="store.toggleSidebar()" :title="$t('chat.sidebar.expand')">
            <svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M3 18h18v-2H3v2zm0-5h18v-2H3v2zm0-7v2h18V6H3z"/></svg>
          </button>
          <button v-if="canUseWorkbench" class="collapsed-icon-btn" :class="{ 'has-enabled': totalEnabledPorts > 0 }" @click="proxyOpen = !proxyOpen" :title="$t('chat.sidebar.portProxy')">
            <svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z"/></svg>
          </button>
          <button v-if="canUseWorkbench" class="collapsed-icon-btn" :class="{ active: store.workbenchExpanded }" @click="store.toggleWorkbench()" :title="$t('chat.sidebar.workbench')">
            <svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M20 3H4c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 16H4V5h16v14zM6 7h5v2H6V7zm0 4h5v2H6v-2zm0 4h5v2H6v-2zm7-8h5v10h-5V7z"/></svg>
          </button>
          <button class="collapsed-icon-btn" @click="openNewConversationModal" :disabled="onlineAgentCount === 0" :title="$t('chat.sidebar.newConv')">
            <svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>
          </button>
          <button class="collapsed-icon-btn" @click="openResumeModal" :disabled="onlineAgentCount === 0" :title="$t('chat.sidebar.resumeConv')">
            <svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M12 5V1L7 6l5 5V7c3.31 0 6 2.69 6 6s-2.69 6-6 6-6-2.69-6-6H4c0 4.42 3.58 8 8 8s8-3.58 8-8-3.58-8-8-8z"/></svg>
          </button>
          <div class="collapsed-spacer"></div>
          <button class="collapsed-icon-btn" @click="store.toggleTheme()" :title="store.theme === 'dark' ? $t('chat.sidebar.lightMode') : $t('chat.sidebar.darkMode')">
            <svg v-if="store.theme === 'dark'" viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M12 7c-2.76 0-5 2.24-5 5s2.24 5 5 5 5-2.24 5-5-2.24-5-5-5zM2 13h2c.55 0 1-.45 1-1s-.45-1-1-1H2c-.55 0-1 .45-1 1s.45 1 1 1zm18 0h2c.55 0 1-.45 1-1s-.45-1-1-1h-2c-.55 0-1 .45-1 1s.45 1 1 1zM11 2v2c0 .55.45 1 1 1s1-.45 1-1V2c0-.55-.45-1-1-1s-1 .45-1 1zm0 18v2c0 .55.45 1 1 1s1-.45 1-1v-2c0-.55-.45-1-1-1s-1 .45-1 1zM5.99 4.58c-.39-.39-1.03-.39-1.41 0-.39.39-.39 1.03 0 1.41l1.06 1.06c.39.39 1.03.39 1.41 0s.39-1.03 0-1.41L5.99 4.58zm12.37 12.37c-.39-.39-1.03-.39-1.41 0-.39.39-.39 1.03 0 1.41l1.06 1.06c.39.39 1.03.39 1.41 0 .39-.39.39-1.03 0-1.41l-1.06-1.06zm1.06-10.96c.39-.39.39-1.03 0-1.41-.39-.39-1.03-.39-1.41 0l-1.06 1.06c-.39.39-.39 1.03 0 1.41s1.03.39 1.41 0l1.06-1.06zM7.05 18.36c.39-.39.39-1.03 0-1.41-.39-.39-1.03-.39-1.41 0l-1.06 1.06c-.39.39-.39 1.03 0 1.41s1.03.39 1.41 0l1.06-1.06z"/></svg>
            <svg v-else viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M12 3c-4.97 0-9 4.03-9 9s4.03 9 9 9 9-4.03 9-9c0-.46-.04-.92-.1-1.36-.98 1.37-2.58 2.26-4.4 2.26-2.98 0-5.4-2.42-5.4-5.4 0-1.81.89-3.42 2.26-4.4-.44-.06-.9-.1-1.36-.1z"/></svg>
          </button>
        </div>
        <!-- Mobile Sidebar Header -->
        <div class="sidebar-header-mobile">
          <span class="sidebar-title">Claude Web Chat</span>
          <button class="sidebar-close-btn" @click="showMobileSidebar = false">
            <svg viewBox="0 0 24 24" width="20" height="20"><path fill="currentColor" d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
          </button>
        </div>

        <!-- Agent Status -->
        <div class="sidebar-top">
          <!-- Header Row: Agent status + action icons (Copilot style) -->
          <div class="sidebar-header-row">
            <div class="sidebar-brand agent-dropdown-trigger" @click.stop="agentManagerOpen = !agentManagerOpen" style="cursor: pointer;" :title="$t('chat.agent.manage')">
              <span class="status-dot" :class="{ online: onlineAgentCount > 0 }"></span>
              <span class="brand-label">{{ onlineAgentCount }} Agent</span>
              <span class="latency-indicator" v-if="currentAgentLatency" :class="getLatencyClass(currentAgentLatency)" :title="currentAgentLatency + 'ms'">
                <svg viewBox="0 0 24 24" width="10" height="10"><circle cx="12" cy="12" r="5" fill="currentColor"/></svg>
                {{ currentAgentLatency }}ms
              </span>
              <svg class="dropdown-chevron" :class="{ open: agentManagerOpen }" viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M7.41 8.59L12 13.17l4.59-4.58L18 10l-6 6-6-6z"/></svg>
              <!-- Agent Dropdown Menu -->
              <div class="agent-dropdown" v-if="agentManagerOpen" @click.stop>
                <div v-for="agent in store.agents" :key="agent.id" class="agent-dropdown-item" :class="{ offline: !agent.online && !upgradingAgents[agent.id] && !restartingAgents[agent.id] }">
                  <span class="status-dot" :class="{ online: agent.online, restarting: restartingAgents[agent.id], upgrading: upgradingAgents[agent.id] }"></span>
                  <span class="agent-dropdown-name">{{ agent.name }}</span>
                  <span class="agent-dropdown-version" v-if="agent.version">v{{ agent.version }}</span>
                  <span class="agent-dropdown-latency" v-if="agent.online && agent.latency" :class="getLatencyClass(agent.latency)">{{ agent.latency }}ms</span>
                  <span class="agent-dropdown-status" v-if="restartingAgents[agent.id]">{{ $t('chat.agent.restarting') }}</span>
                  <span class="agent-dropdown-status" v-else-if="upgradingAgents[agent.id]">{{ $t('chat.agent.upgrading') }}</span>
                  <button
                    class="agent-dropdown-upgrade-btn"
                    @click.stop="upgradeAgent(agent.id)"
                    :disabled="!agent.online || restartingAgents[agent.id] || upgradingAgents[agent.id]"
                    :title="$t('chat.agent.upgrade')"
                  >
                    <span v-if="upgradingAgents[agent.id]" class="spinner-mini"></span>
                    <svg v-else viewBox="0 0 24 24" width="13" height="13"><path fill="currentColor" d="M4 12l1.41 1.41L11 7.83V20h2V7.83l5.58 5.59L20 12l-8-8-8 8z"/></svg>
                  </button>
                  <button
                    class="agent-dropdown-restart-btn"
                    @click.stop="restartAgent(agent.id)"
                    :disabled="!agent.online || restartingAgents[agent.id] || upgradingAgents[agent.id]"
                    :title="$t('chat.agent.restart')"
                  >
                    <span v-if="restartingAgents[agent.id]" class="spinner-mini"></span>
                    <svg v-else viewBox="0 0 24 24" width="13" height="13"><path fill="currentColor" d="M17.65 6.35A7.958 7.958 0 0012 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08A5.99 5.99 0 0112 18c-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/></svg>
                  </button>
                </div>
                <div v-if="store.agents.length === 0" class="agent-dropdown-empty">{{ $t('chat.agent.none') }}</div>
              </div>
            </div>
            <div class="sidebar-header-actions">
              <button class="sidebar-icon-btn" @click="store.toggleSidebar()" :title="$t('chat.sidebar.collapse')">
                <svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M3 18h13v-2H3v2zm0-5h10v-2H3v2zm0-7v2h13V6H3zm18 9.59L17.42 12 21 8.41 19.59 7l-5 5 5 5L21 15.59z"/></svg>
              </button>
              <button v-if="canUseWorkbench" class="sidebar-icon-btn" :class="{ active: proxyOpen, 'has-enabled': totalEnabledPorts > 0 }" @click="proxyOpen = !proxyOpen" :title="$t('chat.sidebar.portProxy')">
                  <svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z"/></svg>
                  <span class="action-badge" v-if="totalEnabledPorts > 0">{{ totalEnabledPorts }}</span>
                </button>
              <button v-if="canUseWorkbench" class="sidebar-icon-btn" :class="{ active: store.workbenchExpanded }" @click="store.toggleWorkbench()" :title="$t('chat.sidebar.workbench')">
                <svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M20 3H4c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 16H4V5h16v14zM6 7h5v2H6V7zm0 4h5v2H6v-2zm0 4h5v2H6v-2zm7-8h5v10h-5V7z"/></svg>
                <span class="action-badge" v-if="store.currentBackgroundTasks.length > 0">{{ store.currentBackgroundTasks.length }}</span>
              </button>
            </div>
          </div>

          <!-- Connection warning -->
          <div v-if="store.connectionState !== 'connected'" class="connection-status" :class="store.connectionState">
            <span v-if="store.connectionState === 'updating'" class="status-text">
              <span class="spinner-mini"></span> {{ $t('chat.connection.updating') }}
            </span>
            <span v-else-if="store.connectionState === 'connecting'" class="status-text">
              <span class="spinner-mini"></span> {{ $t('chat.connection.connecting') }}
            </span>
            <span v-else-if="store.connectionState === 'reconnecting'" class="status-text">
              <span class="spinner-mini"></span> {{ $t('chat.connection.reconnecting', { current: store.reconnectAttempts, max: store.maxReconnectAttempts }) }}
            </span>
            <span v-else class="status-text">
              {{ $t('chat.connection.disconnected') }}
              <button class="reconnect-btn" @click="store.manualReconnect()">{{ $t('chat.connection.reconnect') }}</button>
            </span>
          </div>

          <!-- Menu items (Copilot style) -->
          <nav class="sidebar-nav">
            <button class="sidebar-nav-item" @click="openNewConversationModal" :disabled="onlineAgentCount === 0">
              <svg viewBox="0 0 24 24" width="20" height="20"><path fill="currentColor" d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>
              <span>{{ $t('chat.sidebar.newConv') }}</span>
            </button>
            <button class="sidebar-nav-item" @click="openResumeModal" :disabled="onlineAgentCount === 0">
              <svg viewBox="0 0 24 24" width="20" height="20"><path fill="currentColor" d="M12 5V1L7 6l5 5V7c3.31 0 6 2.69 6 6s-2.69 6-6 6-6-2.69-6-6H4c0 4.42 3.58 8 8 8s8-3.58 8-8-3.58-8-8-8z"/></svg>
              <span>{{ $t('chat.sidebar.resumeConv') }}</span>
            </button>
          </nav>
        </div>

        <!-- Conversation List -->
        <div class="session-list">
          <!-- 活跃会话（显示 agent 名称） -->
          <div
            v-for="conv in store.conversations"
            :key="conv.id"
            class="session-item"
            :class="{ active: conv.id === store.currentConversation, processing: store.isConversationProcessing(conv.id) }"
            @click="selectConversation(conv.id, conv.agentId)"
          >
            <div class="session-item-header">
              <div class="title" :title="getConversationFullTitle(conv)">
                <span v-if="store.isConversationProcessing(conv.id)" class="processing-dot"></span>
                {{ getConversationTitle(conv) }}
              </div>
              <span class="session-time">{{ getConversationTime(conv) }}</span>
              <button class="session-delete-btn" @click.stop="deleteConversation(conv.id, conv.agentId)" :title="$t('chat.sidebar.closeConv')">
                <svg viewBox="0 0 24 24"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
              </button>
            </div>
            <div class="session-info">
              <span class="session-path">{{ shortenPath(conv.workDir) }}</span>
              <span class="session-agent" v-if="conv.agentName">{{ conv.agentName }}</span>
              <span class="latency-indicator" v-if="getAgentLatency(conv.agentId)" :class="getLatencyClass(getAgentLatency(conv.agentId))" :title="getAgentLatency(conv.agentId) + 'ms'">
                <svg viewBox="0 0 24 24" width="10" height="10"><circle cx="12" cy="12" r="5" fill="currentColor"/></svg>
                {{ getAgentLatency(conv.agentId) }}ms
              </span>
            </div>
          </div>

          <div v-if="store.conversations.length === 0" class="empty-hint">
            {{ $t('chat.sidebar.emptyHint') }}
          </div>
        </div>

        <!-- User/Settings at Bottom -->
        <div class="sidebar-bottom">
          <button class="sidebar-nav-item" @click="store.toggleTheme()">
            <svg v-if="store.theme === 'dark'" viewBox="0 0 24 24" width="20" height="20"><path d="M12 7c-2.76 0-5 2.24-5 5s2.24 5 5 5 5-2.24 5-5-2.24-5-5-5zM2 13h2c.55 0 1-.45 1-1s-.45-1-1-1H2c-.55 0-1 .45-1 1s.45 1 1 1zm18 0h2c.55 0 1-.45 1-1s-.45-1-1-1h-2c-.55 0-1 .45-1 1s.45 1 1 1zM11 2v2c0 .55.45 1 1 1s1-.45 1-1V2c0-.55-.45-1-1-1s-1 .45-1 1zm0 18v2c0 .55.45 1 1 1s1-.45 1-1v-2c0-.55-.45-1-1-1s-1 .45-1 1zM5.99 4.58c-.39-.39-1.03-.39-1.41 0-.39.39-.39 1.03 0 1.41l1.06 1.06c.39.39 1.03.39 1.41 0s.39-1.03 0-1.41L5.99 4.58zm12.37 12.37c-.39-.39-1.03-.39-1.41 0-.39.39-.39 1.03 0 1.41l1.06 1.06c.39.39 1.03.39 1.41 0 .39-.39.39-1.03 0-1.41l-1.06-1.06zm1.06-10.96c.39-.39.39-1.03 0-1.41-.39-.39-1.03-.39-1.41 0l-1.06 1.06c-.39.39-.39 1.03 0 1.41s1.03.39 1.41 0l1.06-1.06zM7.05 18.36c.39-.39.39-1.03 0-1.41-.39-.39-1.03-.39-1.41 0l-1.06 1.06c-.39.39-.39 1.03 0 1.41s1.03.39 1.41 0l1.06-1.06z" fill="currentColor"/></svg>
            <svg v-else viewBox="0 0 24 24" width="20" height="20"><path d="M12 3c-4.97 0-9 4.03-9 9s4.03 9 9 9 9-4.03 9-9c0-.46-.04-.92-.1-1.36-.98 1.37-2.58 2.26-4.4 2.26-2.98 0-5.4-2.42-5.4-5.4 0-1.81.89-3.42 2.26-4.4-.44-.06-.9-.1-1.36-.1z" fill="currentColor"/></svg>
            <span>{{ store.theme === 'dark' ? $t('chat.sidebar.lightMode') : $t('chat.sidebar.darkMode') }}</span>
          </button>
          <button class="sidebar-nav-item" @click="showSettingsPanel = true">
            <svg viewBox="0 0 24 24" width="20" height="20"><path d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.07.62-.07.94s.02.64.07.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z" fill="currentColor"/></svg>
            <span>{{ $t('chat.sidebar.settings') }}</span>
          </button>
        </div>
      </aside>

      <!-- Sidebar / Workbench 分隔线 -->
      <div class="sidebar-workbench-divider" v-if="canUseWorkbench && store.workbenchExpanded && !store.sidebarCollapsed"></div>

      <!-- Workbench Panel (Middle) -->
      <WorkbenchPanel v-if="canUseWorkbench" />

      <!-- Main Chat Area (Right) -->
      <main class="main-content" :class="{ 'workbench-active': canUseWorkbench && store.workbenchExpanded, 'workbench-maximized': canUseWorkbench && store.workbenchMaximized && store.workbenchExpanded }">
        <ChatHeader />
        <MessageList
          @new-conversation="openNewConversationModal"
          @resume-conversation="openResumeModal"
        />
        <ChatInput />
      </main>

      <!-- Settings (floating modal) -->
      <SettingsPanel :visible="showSettingsPanel" @close="showSettingsPanel = false" />

      <!-- New Conversation Modal - Same style as Resume Modal -->
      <div class="modal-overlay" v-if="showNewConversationModal" @click.self="closeNewConvModal">
        <div class="modal resume-modal">
          <!-- Top Controls -->
          <div class="resume-modal-controls">
            <button class="resume-close-btn" @click="closeNewConvModal">
              <svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
            </button>
            <div class="resume-control-row">
              <label class="resume-control-label">Agent</label>
              <div class="resume-select-wrapper">
                <select v-model="newConvAgent" @change="onNewConvAgentChange" class="resume-select">
                  <option value="">{{ $t('chat.agent.select') }}</option>
                  <option v-for="agent in store.agents.filter(a => a.online)" :key="agent.id" :value="agent.id">
                    {{ agent.name }}{{ agent.latency ? ' (' + agent.latency + 'ms)' : '' }}
                  </option>
                </select>
                <svg class="select-arrow" viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M7 10l5 5 5-5z"/></svg>
              </div>
            </div>
            <div class="resume-control-row" v-if="newConvAgent">
              <label class="resume-control-label">{{ $t('modal.newConv.workDir') }}</label>
              <div class="workdir-input-group">
                <input
                  type="text"
                  v-model="newConversationWorkDir"
                  :placeholder="selectedNewAgentWorkDir || $t('modal.newConv.inputOrSelect')"
                  @keypress.enter="createNewConversation"
                  class="resume-input"
                >
                <button class="workdir-browse-btn" @click="openFolderPicker('newConv')" :title="$t('modal.newConv.browse')">
                  <svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M10 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/></svg>
                </button>
              </div>
            </div>
          </div>

          <!-- Content Area -->
          <div class="resume-modal-content" v-if="newConvAgent">
            <div class="resume-panel">
              <div class="resume-panel-header">
                <span>{{ $t('modal.newConv.folderLabel') }}</span>
                <button class="refresh-btn-mini" @click="loadNewConvFolders" :disabled="store.foldersLoading" :title="$t('common.refresh')">
                  <svg v-if="!store.foldersLoading" viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M17.65 6.35A7.958 7.958 0 0012 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08A5.99 5.99 0 0112 18c-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/></svg>
                  <span v-else class="mini-spinner"></span>
                </button>
              </div>
              <div class="resume-panel-list">
                <div
                  v-for="folder in store.folders"
                  :key="folder.name"
                  class="resume-list-item folder-item-compact"
                  :class="{ selected: newConversationWorkDir === folder.path }"
                  @click="newConversationWorkDir = folder.path"
                >
                  <div class="item-path">{{ folder.path }}</div>
                  <span class="item-badge">{{ folder.sessionCount }}</span>
                </div>
                <div class="resume-panel-empty" v-if="store.folders.length === 0 && !store.foldersLoading">
                  {{ $t('modal.newConv.noWorkDirs') }}
                </div>
              </div>
            </div>
          </div>

          <!-- Empty state when no agent -->
          <div class="resume-modal-empty" v-else>
            <div class="empty-icon">🤖</div>
            <div class="empty-text">{{ $t('modal.newConv.selectAgent') }}</div>
          </div>

          <!-- Footer with action button -->
          <div class="resume-modal-footer" v-if="newConvAgent">
            <button
              class="modern-btn primary full-width"
              @click="createNewConversation"
              :disabled="!newConvAgent"
            >
              <svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>
              {{ $t('modal.newConv.create') }}
            </button>
          </div>
        </div>
      </div>

      <!-- Resume Conversation Modal - Compact Design -->
      <div class="modal-overlay" v-if="showResumeModal" @click.self="closeResumeModal">
        <div class="modal resume-modal">
          <!-- Top Controls: Agent + Work Directory with close button -->
          <div class="resume-modal-controls">
            <button class="resume-close-btn" @click="closeResumeModal">
              <svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
            </button>
            <div class="resume-control-row">
              <label class="resume-control-label">Agent</label>
              <div class="resume-select-wrapper">
                <select v-model="resumeAgent" @change="onResumeAgentChange" class="resume-select">
                  <option value="">{{ $t('chat.agent.select') }}</option>
                  <option v-for="agent in store.agents.filter(a => a.online)" :key="agent.id" :value="agent.id">
                    {{ agent.name }}{{ agent.latency ? ' (' + agent.latency + 'ms)' : '' }}
                  </option>
                </select>
                <svg class="select-arrow" viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M7 10l5 5 5-5z"/></svg>
              </div>
            </div>
            <div class="resume-control-row" v-if="resumeAgent">
              <label class="resume-control-label">{{ $t('modal.resume.workDir') }}</label>
              <div class="workdir-input-group">
                <input
                  type="text"
                  v-model="resumeWorkDir"
                  @input="onResumeWorkDirInput"
                  :placeholder="selectedResumeAgentWorkDir || $t('modal.resume.inputOrSelect')"
                  class="resume-input"
                >
                <button class="workdir-browse-btn" @click="openFolderPicker('resume')" :title="$t('modal.resume.browse')">
                  <svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M10 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/></svg>
                </button>
              </div>
            </div>
          </div>

          <!-- Tab Navigation -->
          <div class="resume-modal-tabs" v-if="resumeAgent">
            <button
              class="resume-tab"
              :class="{ active: mobileTab === 'folders' }"
              @click="mobileTab = 'folders'"
            >
              {{ $t('modal.resume.tabFolders') }}
              <span class="tab-badge" v-if="store.folders.length">{{ store.folders.length }}</span>
            </button>
            <button
              class="resume-tab"
              :class="{ active: mobileTab === 'sessions' }"
              @click="mobileTab = 'sessions'"
            >
              {{ $t('modal.resume.tabSessions') }}
              <span class="tab-badge" v-if="store.historySessions.length">{{ store.historySessions.length }}</span>
            </button>
          </div>

          <!-- Content Area -->
          <div class="resume-modal-content" v-if="resumeAgent">
            <!-- Folders Panel -->
            <div class="resume-panel" v-show="mobileTab === 'folders'">
              <div class="resume-panel-header">
                <span>{{ $t('modal.resume.folderLabel') }}</span>
                <button class="refresh-btn-mini" @click="loadResumeFolders" :disabled="store.foldersLoading" :title="$t('common.refresh')">
                  <svg v-if="!store.foldersLoading" viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M17.65 6.35A7.958 7.958 0 0012 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08A5.99 5.99 0 0112 18c-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/></svg>
                  <span v-else class="mini-spinner"></span>
                </button>
              </div>
              <div class="resume-panel-list">
                <div
                  v-for="folder in store.folders"
                  :key="folder.name"
                  class="resume-list-item folder-item-compact"
                  :class="{ selected: resumeWorkDir === folder.path }"
                  @click="selectResumeFolder(folder); mobileTab = 'sessions'"
                >
                  <div class="item-path">{{ folder.path }}</div>
                  <span class="item-badge">{{ folder.sessionCount }}</span>
                </div>
                <div class="resume-panel-empty" v-if="store.folders.length === 0 && !store.foldersLoading">
                  {{ $t('modal.resume.noWorkDirs') }}
                </div>
              </div>
            </div>

            <!-- Sessions Panel -->
            <div class="resume-panel" v-show="mobileTab === 'sessions'">
              <div class="resume-panel-header">
                <span>{{ $t('modal.resume.sessionLabel') }} <span class="header-tag" v-if="resumeWorkDir">{{ getLastPathSegment(resumeWorkDir) }}</span></span>
                <button class="refresh-btn-mini" @click="loadHistorySessions" :disabled="store.historySessionsLoading || !resumeWorkDir" :title="$t('common.refresh')">
                  <svg v-if="!store.historySessionsLoading" viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M17.65 6.35A7.958 7.958 0 0012 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08A5.99 5.99 0 0112 18c-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/></svg>
                  <span v-else class="mini-spinner"></span>
                </button>
              </div>
              <div class="resume-panel-list">
                <div
                  v-for="session in store.historySessions"
                  :key="session.sessionId"
                  class="resume-list-item session-item-compact"
                  @click="resumeSessionDirectly(session)"
                >
                  <div class="item-name">{{ session.title || $t('modal.resume.untitled') }}</div>
                  <div class="item-time">{{ formatDate(session.lastModified) }}</div>
                </div>
                <div class="resume-panel-empty" v-if="!resumeWorkDir">
                  {{ $t('modal.resume.selectWorkDir') }}
                </div>
                <div class="resume-panel-empty" v-else-if="store.historySessions.length === 0 && !store.historySessionsLoading && historyLoaded">
                  {{ $t('modal.resume.noSessions') }}
                </div>
              </div>
            </div>
          </div>

          <!-- Empty state when no agent -->
          <div class="resume-modal-empty" v-else>
            <div class="empty-icon">🤖</div>
            <div class="empty-text">{{ $t('modal.resume.selectAgent') }}</div>
          </div>
        </div>
      </div>

      <!-- Port Proxy Modal -->
      <div class="modal-overlay" v-if="canUseWorkbench && proxyOpen" @click.self="proxyOpen = false">
        <div class="modal proxy-modal">
          <button class="resume-close-btn" @click="proxyOpen = false">
            <svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
          </button>
          <ProxyTab />
        </div>
      </div>

      <!-- Settings Panel -->

      <!-- Folder Picker Dialog -->
      <div class="folder-picker-overlay" v-if="folderPickerOpen" @click.self="folderPickerOpen = false">
        <div class="folder-picker-dialog">
          <div class="folder-picker-header">
            <span>{{ $t('modal.folderPicker.title') }}</span>
            <button class="wb-btn-sm" @click="folderPickerOpen = false">&times;</button>
          </div>
          <div class="folder-picker-path">
            <button class="wb-btn-sm" @click="folderPickerNavigateUp" :disabled="!folderPickerPath" :title="$t('modal.folderPicker.parentDir')">
              <svg viewBox="0 0 24 24" width="12" height="12"><path fill="currentColor" d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z"/></svg>
            </button>
            <span class="folder-picker-current">{{ folderPickerPath || $t('common.rootDir') }}</span>
          </div>
          <div class="folder-picker-list">
            <div class="git-loading" v-if="folderPickerLoading" style="padding:12px"><span class="spinner-mini"></span> {{ $t('common.loading') }}</div>
            <template v-else>
              <div
                v-for="entry in folderPickerEntries"
                :key="entry.name"
                class="tree-item tree-dir folder-picker-item"
                :class="{ 'folder-picker-selected': folderPickerSelected === entry.name }"
                @click="folderPickerSelectItem(entry)"
                @dblclick="folderPickerEnter(entry)"
              >
                <span class="tree-icon"><svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M10 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/></svg></span>
                <span class="tree-name">{{ entry.name }}</span>
              </div>
              <div class="tree-empty" v-if="folderPickerEntries.length === 0">{{ $t('common.noSubdirectories') }}</div>
            </template>
          </div>
          <div class="folder-picker-footer">
            <button class="modern-btn primary" @click="confirmFolderPicker" :disabled="!folderPickerPath">{{ $t('common.confirm') }}</button>
          </div>
        </div>
      </div>
  `,
  data() {
    return {
      showAgentDropdown: false,
      showNewConversationModal: false,
      showResumeModal: false,
      showMobileSidebar: false,
      showSettingsPanel: false,
      proxyOpen: false,
      agentManagerOpen: false,
      restartingAgents: {},
      upgradingAgents: {},
      newConversationWorkDir: '',
      newConvAgent: '',
      newConvMobileTab: 'config',
      resumeSessionId: '',
      resumeWorkDir: '',
      resumeAgent: '',
      historyLoaded: false,
      mobileTab: 'folders',
      windowWidth: window.innerWidth,
      // Folder picker state
      folderPickerOpen: false,
      folderPickerPath: '',
      folderPickerEntries: [],
      folderPickerLoading: false,
      folderPickerSelected: '',
      folderPickerTarget: '' // 'newConv' or 'resume'
    };
  },
  computed: {
    store() {
      return Pinia.useChatStore();
    },
    canUseWorkbench() {
      const role = useAuthStore().role;
      return role === 'admin' || role === 'pro';
    },
    selectedNewAgentWorkDir() {
      if (!this.newConvAgent) return '';
      const agent = this.store.agents.find(a => a.id === this.newConvAgent);
      return agent?.workDir || '';
    },
    selectedResumeAgentWorkDir() {
      if (!this.resumeAgent) return '';
      const agent = this.store.agents.find(a => a.id === this.resumeAgent);
      return agent?.workDir || '';
    },
    onlineAgentCount() {
      return this.store.agents.filter(a => a.online).length;
    },
    currentAgentLatency() {
      if (!this.store.currentAgent) return null;
      const agent = this.store.agents.find(a => a.id === this.store.currentAgent);
      return agent?.latency || null;
    },
    defaultNewFolder() {
      // 从 folders 列表中获取第一个作为默认值
      if (this.store.folders.length > 0) {
        return this.store.folders[0].path;
      }
      return this.selectedNewAgentWorkDir;
    },
    defaultResumeFolder() {
      // 从 folders 列表中获取第一个作为默认值
      if (this.store.folders.length > 0) {
        return this.store.folders[0].path;
      }
      return this.selectedResumeAgentWorkDir;
    },
    isMobileView() {
      return this.windowWidth < 640;
    },
    totalEnabledPorts() {
      let count = 0;
      for (const agentId of Object.keys(this.store.proxyPorts)) {
        const ports = this.store.proxyPorts[agentId] || [];
        count += ports.filter(p => p.enabled).length;
      }
      return count;
    }
  },
  methods: {
    openNewConversationModal() {
      this.showNewConversationModal = true;
      this.newConvAgent = '';
      this.newConversationWorkDir = '';
      // 优先选择当前 agent（如果在线），否则选第一个在线 agent
      const onlineAgents = this.store.agents.filter(a => a.online);
      const currentAgentOnline = onlineAgents.find(a => a.id === this.store.currentAgent);
      const selectedAgent = currentAgentOnline || onlineAgents[0];
      if (selectedAgent) {
        this.newConvAgent = selectedAgent.id;
        // Load folders for the selected agent without switching current agent
        this.store.listFoldersForAgent(this.newConvAgent).then(() => {
          if (this.store.folders.length > 0) {
            this.newConversationWorkDir = this.store.folders[0].path;
          }
        });
      }
    },
    openResumeModal() {
      this.showResumeModal = true;
      this.resumeAgent = '';
      this.resumeWorkDir = '';
      this.resumeSessionId = '';
      this.historyLoaded = false;
      // 优先选择当前 agent（如果在线），否则选第一个在线 agent
      const onlineAgents = this.store.agents.filter(a => a.online);
      const currentAgentOnline = onlineAgents.find(a => a.id === this.store.currentAgent);
      const selectedAgent = currentAgentOnline || onlineAgents[0];
      if (selectedAgent) {
        this.resumeAgent = selectedAgent.id;
        // Load folders for the selected agent without switching current agent
        this.store.listFoldersForAgent(this.resumeAgent).then(() => {
          if (this.store.folders.length > 0) {
            this.resumeWorkDir = this.store.folders[0].path;
            this.store.listHistorySessionsForAgent(this.resumeAgent, this.resumeWorkDir);
            this.historyLoaded = true;
          }
        });
      }
    },
    closeNewConvModal() {
      this.showNewConversationModal = false;
      this.newConvAgent = '';
      this.newConversationWorkDir = '';
      this.newConvMobileTab = 'config';
    },
    onResumeWorkDirInput() {
      // Load sessions based on user input after debounce (using specified agent)
      this.historyLoaded = false;
      if (this._workDirInputTimer) {
        clearTimeout(this._workDirInputTimer);
      }
      this._workDirInputTimer = setTimeout(() => {
        if (this.resumeWorkDir.trim() && this.resumeAgent) {
          this.store.listHistorySessionsForAgent(this.resumeAgent, this.resumeWorkDir.trim());
          this.historyLoaded = true;
        }
      }, 500);
    },
    toggleAgentDropdown() {
      this.showAgentDropdown = !this.showAgentDropdown;
      if (this.showAgentDropdown) {
        this.store.refreshAgents();
      }
    },
    selectAgent(agentId) {
      this.store.selectAgent(agentId);
      this.showAgentDropdown = false;
    },
    createNewConversation() {
      if (!this.newConvAgent) return;
      // Select the agent and create conversation with explicit agentId
      this.store.selectAgent(this.newConvAgent);
      const workDir = this.newConversationWorkDir.trim() || this.selectedNewAgentWorkDir;
      // Pass agentId to ensure the request goes to the correct agent
      this.store.createConversation(workDir, this.newConvAgent);
      this.showNewConversationModal = false;
      this.newConversationWorkDir = '';
      this.newConvAgent = '';
    },
    onNewConvAgentChange() {
      // When agent changes, load folders and reset workDir (without switching current agent)
      if (this.newConvAgent) {
        this.newConversationWorkDir = '';
        this.store.listFoldersForAgent(this.newConvAgent).then(() => {
          if (this.store.folders.length > 0) {
            this.newConversationWorkDir = this.store.folders[0].path;
          }
        });
      }
    },
    loadNewConvFolders() {
      if (this.newConvAgent) {
        this.store.listFoldersForAgent(this.newConvAgent);
      }
    },
    resumeConversation() {
      if (!this.resumeAgent || !this.resumeSessionId.trim()) return;
      // First select the agent
      this.store.selectAgent(this.resumeAgent);
      // Then resume conversation with explicit agentId to avoid race condition
      const workDir = this.resumeWorkDir.trim() || this.selectedResumeAgentWorkDir;
      this.store.resumeConversation(this.resumeSessionId.trim(), workDir, this.resumeAgent);
      this.closeResumeModal();
    },
    onResumeAgentChange() {
      // When agent changes, load folders and reset state (without switching current agent)
      if (this.resumeAgent) {
        this.resumeWorkDir = '';
        this.resumeSessionId = '';
        this.historyLoaded = false;
        this.store.listFoldersForAgent(this.resumeAgent).then(() => {
          if (this.store.folders.length > 0) {
            this.resumeWorkDir = this.store.folders[0].path;
            this.store.listHistorySessionsForAgent(this.resumeAgent, this.resumeWorkDir);
            this.historyLoaded = true;
          }
        });
      }
    },
    loadResumeFolders() {
      if (this.resumeAgent) {
        this.store.listFoldersForAgent(this.resumeAgent);
      }
    },
    selectResumeFolder(folder) {
      this.resumeWorkDir = folder.path;
      // Auto-load history sessions when folder selected (using specified agent)
      this.store.listHistorySessionsForAgent(this.resumeAgent, folder.path);
      this.historyLoaded = true;
    },
    loadHistorySessions() {
      const workDir = this.resumeWorkDir.trim() || this.store.currentAgentWorkDir;
      if (!workDir) {
        alert(this.$t('chat.delete.enterWorkDir'));
        return;
      }
      // Use specified agent instead of current agent
      this.store.listHistorySessionsForAgent(this.resumeAgent, workDir);
      this.historyLoaded = true;
    },
    selectHistorySession(session) {
      this.resumeSessionId = session.sessionId;
      this.resumeWorkDir = session.workDir;
    },
    resumeSessionDirectly(session) {
      // 直接恢复会话并关闭模态框
      if (!this.resumeAgent) return;
      this.store.selectAgent(this.resumeAgent);
      // 预先保存会话标题
      this.store._pendingSessionTitle = session.title;
      const workDir = session.workDir || this.resumeWorkDir.trim() || this.selectedResumeAgentWorkDir;
      this.store.resumeConversation(session.sessionId, workDir, this.resumeAgent);
      this.closeResumeModal();
    },
    closeResumeModal() {
      this.showResumeModal = false;
      this.resumeSessionId = '';
      this.resumeWorkDir = '';
      this.resumeAgent = '';
      this.historyLoaded = false;
    },
    formatDate(timestamp) {
      if (!timestamp) return '';
      const date = new Date(timestamp);
      const now = new Date();
      const diffDays = Math.floor((now - date) / (1000 * 60 * 60 * 24));

      if (diffDays === 0) {
        return this.$t('chat.time.today') + ' ' + date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
      } else if (diffDays === 1) {
        return this.$t('chat.time.yesterday') + ' ' + date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
      } else if (diffDays < 7) {
        return this.$t('chat.time.daysAgo', { count: diffDays });
      } else {
        return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
      }
    },
    selectConversation(conversationId, agentId) {
      this.store.selectConversation(conversationId, agentId);
      // Close mobile sidebar after selecting
      this.showMobileSidebar = false;
    },
    deleteConversation(conversationId, agentId) {
      if (confirm(this.$t('chat.delete.confirm'))) {
        this.store.deleteConversation(conversationId, agentId);
      }
    },
    getConversationTitle(conv) {
      // 优先使用 store 中缓存的标题（最新用户消息）
      const cachedTitle = this.store.getConversationTitle(conv.id);
      if (cachedTitle) {
        return cachedTitle.length > 30 ? cachedTitle.slice(0, 30) + '...' : cachedTitle;
      }
      // 其次显示简短的 session ID
      if (conv.claudeSessionId) {
        return conv.claudeSessionId.slice(0, 8) + '...';
      }
      return conv.id.slice(0, 8) + '...';
    },
    getConversationFullTitle(conv) {
      const cachedTitle = this.store.getConversationTitle(conv.id);
      if (cachedTitle && cachedTitle.length > 30) {
        return cachedTitle;
      }
      return undefined;
    },
    getConversationTime(conv) {
      // 优先显示最后活动时间，其次创建时间
      const execStatus = this.store.executionStatusMap[conv.id];
      const ts = execStatus?.lastActivity || conv.createdAt;
      if (!ts) return '';
      const date = new Date(ts);
      const now = new Date();
      const diffMs = now - date;
      if (diffMs < 60000) return this.$t('chat.time.justNow');
      if (diffMs < 3600000) return this.$t('chat.time.minutesAgo', { count: Math.floor(diffMs / 60000) });
      // 今天内显示时间
      if (date.toDateString() === now.toDateString()) {
        return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
      }
      return date.toLocaleDateString(undefined, { month: 'numeric', day: 'numeric' });
    },
    shortenPath(path) {
      if (!path) return '-';
      if (path.length <= 25) return path;
      const parts = path.split(/[/\\]/);
      if (parts.length <= 2) return path;
      return '...' + parts.slice(-2).join('/');
    },
    formatTime(timestamp) {
      if (!timestamp) return '';
      const date = new Date(timestamp);
      return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    },
    getLastPathSegment(path) {
      if (!path) return '';
      const parts = path.split(/[/\\]/);
      return parts[parts.length - 1] || parts[parts.length - 2] || path;
    },
    getParentPath(path) {
      if (!path) return '';
      const parts = path.split(/[/\\]/);
      if (parts.length <= 2) return '';
      return parts.slice(0, -1).join('/');
    },
    handleResize() {
      this.windowWidth = window.innerWidth;
    },
    getAgentLatency(agentId) {
      if (!agentId) return null;
      const agent = this.store.agents.find(a => a.id === agentId);
      return agent?.latency || null;
    },
    getLatencyClass(latency) {
      if (!latency) return '';
      if (latency < 100) return 'latency-good';
      if (latency < 300) return 'latency-warn';
      return 'latency-bad';
    },
    restartAgent(agentId) {
      const agent = this.store.agents.find(a => a.id === agentId);
      const name = agent?.name || agentId;
      if (!confirm(this.$t('chat.agent.restartConfirm', { name }))) return;
      this.restartingAgents[agentId] = true;
      this.store.restartAgent(agentId);
    },
    upgradeAgent(agentId) {
      const agent = this.store.agents.find(a => a.id === agentId);
      const name = agent?.name || agentId;
      if (!confirm(this.$t('chat.agent.upgradeConfirm', { name }))) return;
      this.upgradingAgents[agentId] = { since: Date.now(), oldVersion: agent?.version || null };
      this.store.upgradeAgent(agentId);
    },
    // Folder picker methods
    openFolderPicker(target) {
      const agentId = target === 'newConv' ? this.newConvAgent : this.resumeAgent;
      if (!agentId) return;
      console.log('[FolderPicker] Opening, target:', target, 'agentId:', agentId);
      this.folderPickerTarget = target;
      this.folderPickerOpen = true;
      this.folderPickerSelected = '';
      this.folderPickerLoading = true;
      const currentWorkDir = target === 'newConv' ? this.newConversationWorkDir : this.resumeWorkDir;
      const agent = this.store.agents.find(a => a.id === agentId);
      const defaultDir = currentWorkDir || agent?.workDir || '';
      this.folderPickerPath = defaultDir;
      this.folderPickerEntries = [];
      this.store.sendWsMessage({
        type: 'list_directory',
        conversationId: '_workdir_picker',
        agentId: agentId,
        dirPath: defaultDir,
        workDir: agent?.workDir || '',
        _clientId: this.store.clientId
      });
      // Timeout: if no response in 10s, stop loading
      clearTimeout(this._folderPickerTimeout);
      this._folderPickerTimeout = setTimeout(() => {
        if (this.folderPickerLoading) {
          console.warn('[FolderPicker] Timeout waiting for directory listing');
          this.folderPickerLoading = false;
        }
      }, 10000);
    },
    loadFolderPickerDir(dirPath) {
      const agentId = this.folderPickerTarget === 'newConv' ? this.newConvAgent : this.resumeAgent;
      if (!agentId) return;
      this.folderPickerLoading = true;
      this.folderPickerSelected = '';
      const agent = this.store.agents.find(a => a.id === agentId);
      this.store.sendWsMessage({
        type: 'list_directory',
        conversationId: '_workdir_picker',
        agentId: agentId,
        dirPath: dirPath,
        workDir: agent?.workDir || '',
        _clientId: this.store.clientId
      });
      // Timeout
      clearTimeout(this._folderPickerTimeout);
      this._folderPickerTimeout = setTimeout(() => {
        if (this.folderPickerLoading) {
          console.warn('[FolderPicker] Timeout waiting for directory listing');
          this.folderPickerLoading = false;
        }
      }, 10000);
    },
    folderPickerNavigateUp() {
      if (!this.folderPickerPath) return;
      const isWin = this.folderPickerPath.includes('\\');
      const sep = isWin ? '\\' : '/';
      const parts = this.folderPickerPath.replace(/[/\\]$/, '').split(/[/\\]/);
      parts.pop();
      if (parts.length === 0) {
        this.folderPickerPath = '';
        this.loadFolderPickerDir('');
      } else if (isWin && parts.length === 1 && /^[A-Za-z]:$/.test(parts[0])) {
        this.folderPickerPath = parts[0] + '\\';
        this.loadFolderPickerDir(parts[0] + '\\');
      } else {
        const parent = parts.join(sep);
        this.folderPickerPath = parent;
        this.loadFolderPickerDir(parent);
      }
    },
    folderPickerSelectItem(entry) {
      this.folderPickerSelected = entry.name;
    },
    folderPickerEnter(entry) {
      const sep = this.folderPickerPath.includes('\\') || /^[A-Z]:/.test(entry.name) ? '\\' : '/';
      let newPath;
      if (!this.folderPickerPath) {
        newPath = entry.name + (entry.name.endsWith('\\') ? '' : '\\');
      } else {
        newPath = this.folderPickerPath.replace(/[/\\]$/, '') + sep + entry.name;
      }
      this.folderPickerPath = newPath;
      this.loadFolderPickerDir(newPath);
    },
    confirmFolderPicker() {
      let path = this.folderPickerPath;
      if (!path) return;
      if (this.folderPickerSelected) {
        const sep = path.includes('\\') ? '\\' : '/';
        path = path.replace(/[/\\]$/, '') + sep + this.folderPickerSelected;
      }
      if (this.folderPickerTarget === 'newConv') {
        this.newConversationWorkDir = path;
      } else {
        this.resumeWorkDir = path;
        // Auto-load history sessions
        if (this.resumeAgent) {
          this.store.listHistorySessionsForAgent(this.resumeAgent, path);
          this.historyLoaded = true;
        }
      }
      this.folderPickerOpen = false;
    },
    handleFolderPickerMessage(event) {
      const msg = event.detail;
      if (!msg) return;
      if (msg.type === 'directory_listing') {
        console.log('[FolderPicker] Received directory_listing, conversationId:', msg.conversationId, 'entries:', msg.entries?.length, 'error:', msg.error);
      }
      if (msg.type !== 'directory_listing' || msg.conversationId !== '_workdir_picker') return;
      console.log('[FolderPicker] Processing _workdir_picker response, entries:', msg.entries?.length, 'dirPath:', msg.dirPath);
      clearTimeout(this._folderPickerTimeout);
      this.folderPickerLoading = false;
      this.folderPickerEntries = (msg.entries || [])
        .filter(e => e.type === 'directory')
        .sort((a, b) => a.name.localeCompare(b.name));
      if (msg.dirPath != null) this.folderPickerPath = msg.dirPath;
    }
  },
  mounted() {
    this._clickOutsideHandler = (e) => {
      if (!e.target.closest('.agent-selector')) {
        this.showAgentDropdown = false;
      }
      if (!e.target.closest('.agent-dropdown-trigger') && !e.target.closest('.agent-dropdown')) {
        this.agentManagerOpen = false;
      }
    };
    document.addEventListener('click', this._clickOutsideHandler);
    window.addEventListener('resize', this.handleResize);
    window.addEventListener('workbench-message', this.handleFolderPickerMessage);

    // 监听 agent 重启确认
    this._agentRestartAckHandler = (e) => {
      const { agentId } = e.detail;
      // ack 已收到，agent 即将退出，保持 restarting 状态
      // 等 agent 重新上线后再清除
    };
    window.addEventListener('agent-restart-ack', this._agentRestartAckHandler);

    // 监听 agent 升级结果
    this._agentUpgradeAckHandler = (e) => {
      const { agentId, success, error, alreadyLatest, version } = e.detail;
      if (!success) {
        delete this.upgradingAgents[agentId];
        alert(`Agent upgrade failed: ${error || 'Unknown error'}`);
      } else if (alreadyLatest) {
        delete this.upgradingAgents[agentId];
        alert(this.$t('chat.agent.alreadyLatest', { version: version || '' }));
      }
      // success && !alreadyLatest 时 agent 会重启，等上线后由 watcher 清除状态
    };
    window.addEventListener('agent-upgrade-ack', this._agentUpgradeAckHandler);

    // 监听 agent 列表更新，检查重启中的 agent 是否已恢复
    this._checkRestartingAgents = this.$watch(
      () => this.store.agents.map(a => a.id + ':' + a.online),
      () => {
        for (const agentId of Object.keys(this.restartingAgents)) {
          const agent = this.store.agents.find(a => a.id === agentId);
          if (agent?.online) {
            delete this.restartingAgents[agentId];
          }
        }
        for (const agentId of Object.keys(this.upgradingAgents)) {
          const agent = this.store.agents.find(a => a.id === agentId);
          if (agent?.online) {
            // Agent came back online — delay clearing to ensure user sees the status
            const info = this.upgradingAgents[agentId];
            const elapsed = Date.now() - (info?.since || 0);
            const minDisplayMs = 3000;
            if (elapsed < minDisplayMs) {
              setTimeout(() => {
                const ag = this.store.agents.find(a => a.id === agentId);
                if (ag?.online) delete this.upgradingAgents[agentId];
              }, minDisplayMs - elapsed);
            } else {
              delete this.upgradingAgents[agentId];
            }
          }
        }
      }
    );
  },
  beforeUnmount() {
    document.removeEventListener('click', this._clickOutsideHandler);
    window.removeEventListener('resize', this.handleResize);
    window.removeEventListener('workbench-message', this.handleFolderPickerMessage);
    window.removeEventListener('agent-restart-ack', this._agentRestartAckHandler);
    window.removeEventListener('agent-upgrade-ack', this._agentUpgradeAckHandler);
    clearTimeout(this._folderPickerTimeout);
    if (this._checkRestartingAgents) this._checkRestartingAgents();
  }
};
