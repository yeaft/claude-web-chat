/**
 * GroupChatView - Group Chat 广播讨论频道观看视图
 * 人类只能观看，不能参与讨论
 * 可以控制自己的 agent 加入/退出频道
 */
import { renderMarkdown } from '../utils/markdown.js';

const ICONS = {
  group: '<svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z"/></svg>',
  stop: '<svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M6 6h12v12H6z"/></svg>',
  join: '<svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M15 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm-9-2V7H4v3H1v2h3v3h2v-3h3v-2H6zm9 4c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/></svg>',
  leave: '<svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M10.09 15.59L11.5 17l5-5-5-5-1.41 1.41L12.67 11H3v2h9.67l-2.58 2.59zM19 3H5c-1.11 0-2 .9-2 2v4h2V5h14v14H5v-4H3v4c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2z"/></svg>',
  consensus: '<svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>',
};

export default {
  name: 'GroupChatView',
  template: `
    <div class="group-chat-view">
      <!-- Status Bar -->
      <div class="gc-status-bar">
        <div class="gc-status-left">
          <span class="gc-status-icon" v-html="icons.group"></span>
          <span class="gc-topic">{{ session?.topic || '未知主题' }}</span>
          <span class="gc-status-badge" :class="'gc-status-' + (session?.status || 'waiting')">
            {{ statusLabel }}
          </span>
          <span v-if="session?.status === 'discussing'" class="gc-round">
            第 {{ session.round || 1 }} 轮
          </span>
        </div>
        <div class="gc-status-right">
          <span class="gc-participant-count">{{ participantCount }} 位参与者</span>
        </div>
      </div>

      <!-- Participants -->
      <div class="gc-participants">
        <div v-for="p in participants" :key="p.agentId" class="gc-participant" :class="{ 'is-speaking': p.status === 'speaking' }">
          <span class="gc-participant-dot" :class="'gc-dot-' + p.status"></span>
          <span class="gc-participant-name">{{ p.agentName }}</span>
          <span v-if="p.status === 'speaking'" class="gc-speaking-indicator">发言中...</span>
        </div>
      </div>

      <!-- Agent Controls -->
      <div class="gc-controls">
        <template v-if="availableAgents.length > 0">
          <div v-for="agent in availableAgents" :key="agent.id" class="gc-agent-control">
            <span class="gc-agent-name">{{ agent.name }}</span>
            <button v-if="isAgentInSession(agent.id)" class="gc-btn gc-btn-leave" @click="leaveAgent(agent.id)" :disabled="session?.status === 'stopped' || session?.status === 'consensus'">
              <span v-html="icons.leave"></span> 退出
            </button>
            <button v-else class="gc-btn gc-btn-join" @click="joinAgent(agent.id)" :disabled="session?.status === 'stopped' || session?.status === 'consensus'">
              <span v-html="icons.join"></span> 加入
            </button>
          </div>
        </template>
        <button v-if="session?.status === 'discussing'" class="gc-btn gc-btn-stop" @click="stopDiscussion">
          <span v-html="icons.stop"></span> 停止讨论
        </button>
      </div>

      <!-- Messages -->
      <div class="gc-messages" ref="messagesRef" @scroll="onScroll">
        <div v-if="messages.length === 0" class="gc-empty">
          <div class="gc-empty-icon" v-html="icons.group.replace(/16/g, '48')"></div>
          <div class="gc-empty-text">
            {{ session?.status === 'waiting' ? '等待至少 2 位 Agent 加入后自动开始讨论...' : '讨论即将开始...' }}
          </div>
        </div>

        <template v-for="(msg, idx) in messages" :key="msg.id || idx">
          <!-- Round Divider -->
          <div v-if="idx > 0 && msg.round !== messages[idx - 1].round" class="gc-round-divider">
            <div class="gc-round-line"></div>
            <span class="gc-round-label">第 {{ msg.round }} 轮</span>
            <div class="gc-round-line"></div>
          </div>

          <!-- Message -->
          <div class="gc-message" :class="{ 'gc-msg-system': msg.type === 'system' }">
            <div v-if="msg.type !== 'system'" class="gc-msg-header">
              <span class="gc-msg-avatar" :style="getAvatarStyle(msg.agentName)">{{ getInitial(msg.agentName) }}</span>
              <span class="gc-msg-name">{{ msg.agentName }}</span>
              <span class="gc-msg-time">{{ formatTime(msg.timestamp) }}</span>
            </div>
            <div v-if="msg.type === 'system'" class="gc-msg-system-text">{{ msg.content }}</div>
            <div v-else class="gc-msg-content markdown-body" v-html="mdRender(msg.content)"></div>
          </div>
        </template>

        <!-- Streaming message (current speaker) -->
        <div v-if="streamingText" class="gc-message gc-msg-streaming">
          <div class="gc-msg-header">
            <span class="gc-msg-avatar" :style="getAvatarStyle(streamingSpeaker)">{{ getInitial(streamingSpeaker) }}</span>
            <span class="gc-msg-name">{{ streamingSpeaker }}</span>
            <span class="gc-typing-indicator">
              <span class="gc-typing-dot"></span>
              <span class="gc-typing-dot"></span>
              <span class="gc-typing-dot"></span>
            </span>
          </div>
          <div class="gc-msg-content markdown-body" v-html="mdRender(streamingText)"></div>
        </div>
      </div>

      <!-- Conclusion -->
      <div v-if="session?.status === 'consensus' && session?.conclusion" class="gc-conclusion">
        <div class="gc-conclusion-header">
          <span v-html="icons.consensus"></span>
          <span>讨论结论</span>
        </div>
        <div class="gc-conclusion-body markdown-body" v-html="mdRender(session.conclusion)"></div>
        <div class="gc-conclusion-meta">
          经过 {{ session.round }} 轮讨论，{{ participantCount }} 位参与者达成共识
        </div>
      </div>

      <!-- No Input Area (humans cannot speak) -->
      <div class="gc-footer">
        <div class="gc-observer-notice">
          <svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z"/></svg>
          观看模式 — 你无法参与讨论，只能观看 Agent 之间的自动讨论
        </div>
      </div>
    </div>
  `,

  setup() {
    const chatStore = Pinia.useChatStore();
    return { chatStore };
  },

  data() {
    return {
      icons: ICONS,
      autoScroll: true
    };
  },

  computed: {
    session() {
      return this.chatStore.currentGroupChatSession;
    },
    messages() {
      return this.chatStore.currentGroupChatMessages || [];
    },
    streamingText() {
      return this.chatStore.groupChatStreaming?.text || '';
    },
    streamingSpeaker() {
      return this.chatStore.groupChatStreaming?.agentName || '';
    },
    participants() {
      return this.session?.participants || [];
    },
    participantCount() {
      return this.participants.length;
    },
    statusLabel() {
      const s = this.session?.status;
      if (s === 'waiting') return '等待加入';
      if (s === 'discussing') return '讨论中';
      if (s === 'consensus') return '已达共识';
      if (s === 'stopped') return '已停止';
      return s || '未知';
    },
    availableAgents() {
      return this.chatStore.agents || [];
    }
  },

  methods: {
    mdRender(text) {
      if (!text) return '';
      return renderMarkdown(text);
    },

    formatTime(ts) {
      if (!ts) return '';
      const d = new Date(ts);
      return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    },

    getAvatarStyle(name) {
      const colors = ['#4A90D9', '#D94A4A', '#4AD94A', '#D9D94A', '#9B4AD9', '#4AD9D9', '#D9904A', '#904AD9'];
      const idx = (name || '').split('').reduce((a, c) => a + c.charCodeAt(0), 0) % colors.length;
      return { backgroundColor: colors[idx], color: '#fff' };
    },

    getInitial(name) {
      if (!name) return '?';
      return name.charAt(0).toUpperCase();
    },

    isAgentInSession(agentId) {
      return this.participants.some(p => p.agentId === agentId);
    },

    joinAgent(agentId) {
      if (!this.session) return;
      this.chatStore.joinGroupChat(this.session.id, agentId);
    },

    leaveAgent(agentId) {
      if (!this.session) return;
      this.chatStore.leaveGroupChat(this.session.id, agentId);
    },

    stopDiscussion() {
      if (!this.session) return;
      this.chatStore.stopGroupChat(this.session.id);
    },

    onScroll() {
      const el = this.$refs.messagesRef;
      if (!el) return;
      const threshold = 50;
      this.autoScroll = el.scrollHeight - el.scrollTop - el.clientHeight < threshold;
    },

    scrollToBottom() {
      if (!this.autoScroll) return;
      this.$nextTick(() => {
        const el = this.$refs.messagesRef;
        if (el) el.scrollTop = el.scrollHeight;
      });
    }
  },

  watch: {
    messages: {
      handler() { this.scrollToBottom(); },
      deep: true
    },
    streamingText() {
      this.scrollToBottom();
    }
  },

  mounted() {
    this.scrollToBottom();
  }
};
