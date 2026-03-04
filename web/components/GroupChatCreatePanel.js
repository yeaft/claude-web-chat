/**
 * GroupChatCreatePanel - 创建 Group Chat 频道的面板
 * 简洁的弹出面板，输入主题即可创建
 */

export default {
  name: 'GroupChatCreatePanel',
  template: `
    <div class="gc-create-overlay" @click.self="$emit('close')">
      <div class="gc-create-panel">
        <div class="gc-create-header">
          <h3>创建广播讨论频道</h3>
          <button class="gc-create-close" @click="$emit('close')">&times;</button>
        </div>

        <div class="gc-create-body">
          <!-- Existing sessions list -->
          <div v-if="existingSessions.length > 0" class="gc-existing-sessions">
            <div class="gc-section-label">现有频道</div>
            <div v-for="s in existingSessions" :key="s.id" class="gc-session-item" @click="$emit('select', s)">
              <div class="gc-session-topic">{{ s.topic }}</div>
              <div class="gc-session-meta">
                <span class="gc-session-status" :class="'gc-status-' + s.status">{{ statusLabel(s.status) }}</span>
                <span>{{ s.participantCount }} 位参与者</span>
                <span>{{ s.messageCount }} 条消息</span>
              </div>
            </div>
          </div>

          <!-- Create new -->
          <div class="gc-section-label">创建新频道</div>
          <div class="gc-form-group">
            <label>讨论主题</label>
            <textarea
              v-model="topic"
              class="gc-topic-input"
              placeholder="输入讨论主题，例如：讨论微服务架构 vs 单体架构的优劣"
              rows="3"
              @keydown.ctrl.enter="create"
              @keydown.meta.enter="create"
            ></textarea>
          </div>

          <div class="gc-form-hint">
            创建后，选择你的 Agent 加入频道。当 2 个以上 Agent 加入后，讨论将自动开始。
          </div>
        </div>

        <div class="gc-create-footer">
          <button class="gc-btn gc-btn-cancel" @click="$emit('close')">取消</button>
          <button class="gc-btn gc-btn-create" @click="create" :disabled="!topic.trim()">
            创建频道
          </button>
        </div>
      </div>
    </div>
  `,

  props: {
    sessions: {
      type: Array,
      default: () => []
    }
  },

  emits: ['close', 'create', 'select'],

  data() {
    return {
      topic: ''
    };
  },

  computed: {
    existingSessions() {
      return this.sessions.filter(s => s.status !== 'stopped');
    }
  },

  methods: {
    create() {
      const topic = this.topic.trim();
      if (!topic) return;
      this.$emit('create', { topic });
      this.topic = '';
    },

    statusLabel(status) {
      if (status === 'waiting') return '等待加入';
      if (status === 'discussing') return '讨论中';
      if (status === 'consensus') return '已达共识';
      if (status === 'stopped') return '已停止';
      return status;
    }
  }
};
