import { useAuthStore } from '../stores/auth.js';

export default {
  name: 'DashboardTab',
  template: `
    <div class="db-container">
      <!-- Loading state -->
      <div v-if="loading && !loaded" class="db-loading">{{ $t('settings.dashboard.loading') }}</div>

      <!-- Error state -->
      <div v-else-if="error" class="db-empty">{{ $t('settings.dashboard.error') }}</div>

      <!-- Data loaded -->
      <template v-else>
        <!-- Overview stat cards -->
        <div class="db-stats-row">
          <div class="db-stat-card">
            <div class="db-stat-value">{{ overview.totalUsers }}</div>
            <div class="db-stat-label">{{ $t('settings.dashboard.totalUsers') }}</div>
          </div>
          <div class="db-stat-card">
            <div class="db-stat-value" :class="{ 'is-active': overview.onlineUsers > 0 }">{{ overview.onlineUsers }}</div>
            <div class="db-stat-label">{{ $t('settings.dashboard.onlineUsers') }}</div>
          </div>
          <div class="db-stat-card">
            <div class="db-stat-value" :class="{ 'is-active': overview.onlineAgents > 0 }">{{ overview.onlineAgents }}</div>
            <div class="db-stat-label">{{ $t('settings.dashboard.onlineAgents') }}</div>
          </div>
          <div class="db-stat-card">
            <div class="db-stat-value">{{ overview.totalSessions }}</div>
            <div class="db-stat-label">{{ $t('settings.dashboard.totalSessions') }}</div>
          </div>
        </div>

        <!-- User usage section -->
        <div class="db-section">
          <div class="db-section-header">
            <div class="db-section-title">{{ $t('settings.dashboard.userUsage') }}</div>
            <button class="db-refresh-btn" :class="{ 'is-loading': loading }" @click="refreshAll" :disabled="loading" :title="$t('settings.dashboard.refresh')">
              <svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M17.65 6.35C16.2 4.9 14.21 4 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08c-.82 2.33-3.04 4-5.65 4-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/></svg>
            </button>
          </div>

          <!-- Desktop table -->
          <div class="db-table-wrap">
            <table class="db-table">
              <thead>
                <tr>
                  <th>{{ $t('settings.dashboard.name') }}</th>
                  <th class="db-cell-num">{{ $t('settings.dashboard.messages') }}</th>
                  <th class="db-cell-num">{{ $t('settings.dashboard.sessions') }}</th>
                  <th class="db-cell-num">{{ $t('settings.dashboard.requests') }}</th>
                  <th class="db-cell-num">{{ $t('settings.dashboard.traffic') }}</th>
                  <th>{{ $t('settings.dashboard.lastLogin') }}</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="user in userStats" :key="user.username">
                  <td class="db-cell-name">{{ user.username }}</td>
                  <td class="db-cell-num">{{ formatNumber(user.messageCount) }}</td>
                  <td class="db-cell-num">{{ formatNumber(user.sessionCount) }}</td>
                  <td class="db-cell-num">{{ formatNumber(user.requestCount) }}</td>
                  <td class="db-cell-num">{{ formatBytes(user.bytesSent + user.bytesReceived) }}</td>
                  <td class="db-cell-time">{{ formatRelativeTime(user.lastLoginAt) }}</td>
                </tr>
              </tbody>
            </table>
          </div>

          <!-- Mobile cards -->
          <div class="db-card-list">
            <div class="db-user-card" v-for="user in userStats" :key="'m-' + user.username">
              <div class="db-user-card-name">{{ user.username }}</div>
              <div class="db-user-card-stats">
                <span>{{ $t('settings.dashboard.messages') }} {{ formatNumber(user.messageCount) }}</span>
                <span>·</span>
                <span>{{ $t('settings.dashboard.sessions') }} {{ formatNumber(user.sessionCount) }}</span>
              </div>
              <div class="db-user-card-stats">
                <span>{{ $t('settings.dashboard.requests') }} {{ formatNumber(user.requestCount) }}</span>
                <span>·</span>
                <span>{{ formatBytes(user.bytesSent + user.bytesReceived) }}</span>
              </div>
              <div class="db-user-card-meta">{{ $t('settings.dashboard.lastLogin') }}: {{ formatRelativeTime(user.lastLoginAt) }}</div>
            </div>
            <div v-if="userStats.length === 0" class="db-empty">{{ $t('settings.dashboard.noOnlineUsers') }}</div>
          </div>
        </div>

        <!-- Agent list section -->
        <div class="db-section">
          <div class="db-section-header">
            <div class="db-section-title">{{ $t('settings.dashboard.agentList') }}</div>
          </div>

          <template v-if="agents.length > 0">
            <!-- Desktop table -->
            <div class="db-table-wrap">
              <table class="db-table">
                <thead>
                  <tr>
                    <th>{{ $t('settings.dashboard.name') }}</th>
                    <th>{{ $t('settings.dashboard.status') }}</th>
                    <th class="db-cell-num">{{ $t('settings.dashboard.latency') }}</th>
                    <th>{{ $t('settings.dashboard.version') }}</th>
                    <th>{{ $t('settings.dashboard.owner') }}</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="agent in agents" :key="agent.name">
                    <td class="db-cell-name">{{ agent.name }}</td>
                    <td>
                      <span class="db-status-dot" :class="agent.online ? 'online' : 'offline'"></span>
                      {{ agent.online ? $t('settings.dashboard.online') : $t('settings.dashboard.offline') }}
                    </td>
                    <td class="db-cell-num">
                      <span v-if="agent.online" :class="latencyClass(agent.latency)">{{ agent.latency }}ms</span>
                      <span v-else class="db-cell-time">—</span>
                    </td>
                    <td>{{ agent.version || '—' }}</td>
                    <td>{{ agent.owner || '—' }}</td>
                  </tr>
                </tbody>
              </table>
            </div>

            <!-- Mobile cards -->
            <div class="db-card-list">
              <div class="db-agent-card" v-for="agent in agents" :key="'m-' + agent.name">
                <div class="db-agent-card-name">
                  <span class="db-status-dot" :class="agent.online ? 'online' : 'offline'"></span>
                  {{ agent.name }}
                </div>
                <div class="db-agent-card-stats" v-if="agent.online">
                  <span>{{ $t('settings.dashboard.latency') }} <span :class="latencyClass(agent.latency)">{{ agent.latency }}ms</span></span>
                  <span>·</span>
                  <span>v{{ agent.version || '?' }}</span>
                </div>
                <div class="db-agent-card-meta">{{ $t('settings.dashboard.owner') }}: {{ agent.owner || '—' }}</div>
              </div>
            </div>
          </template>
          <div v-else class="db-empty">{{ $t('settings.dashboard.noAgents') }}</div>
        </div>

        <!-- Online users section -->
        <div class="db-section">
          <div class="db-section-header">
            <div class="db-section-title">{{ $t('settings.dashboard.onlineUserList') }}</div>
          </div>

          <template v-if="onlineUsers.length > 0">
            <!-- Desktop table -->
            <div class="db-table-wrap">
              <table class="db-table">
                <thead>
                  <tr>
                    <th>{{ $t('settings.dashboard.name') }}</th>
                    <th>{{ $t('settings.dashboard.role') }}</th>
                    <th>{{ $t('settings.dashboard.agent') }}</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="user in onlineUsers" :key="user.username">
                    <td class="db-cell-name">{{ user.username }}</td>
                    <td>
                      <span class="sp-badge" :class="'sp-role-' + (user.role || 'pro')">{{ user.role || 'pro' }}</span>
                    </td>
                    <td>{{ user.agentName || '—' }}</td>
                  </tr>
                </tbody>
              </table>
            </div>

            <!-- Mobile cards -->
            <div class="db-card-list">
              <div class="db-online-card" v-for="user in onlineUsers" :key="'m-' + user.username">
                <div class="db-online-card-name">
                  {{ user.username }}
                  <span class="sp-badge" :class="'sp-role-' + (user.role || 'pro')">{{ user.role || 'pro' }}</span>
                </div>
                <div class="db-agent-card-meta" v-if="user.agentName">{{ $t('settings.dashboard.agent') }}: {{ user.agentName }}</div>
              </div>
            </div>
          </template>
          <div v-else class="db-empty">{{ $t('settings.dashboard.noOnlineUsers') }}</div>
        </div>
      </template>
    </div>
  `,
  data() {
    return {
      loading: false,
      loaded: false,
      error: false,
      overview: { totalUsers: 0, onlineUsers: 0, onlineAgents: 0, totalSessions: 0 },
      userStats: [],
      agents: [],
      onlineUsers: []
    };
  },
  mounted() {
    this.fetchAll();
  },
  methods: {
    getHeaders() {
      const authStore = useAuthStore();
      const h = { 'Content-Type': 'application/json' };
      if (authStore.token) {
        h['Authorization'] = `Bearer ${authStore.token}`;
      }
      return h;
    },

    async fetchAll() {
      this.loading = true;
      this.error = false;
      try {
        const headers = this.getHeaders();
        const [dashboardRes, userStatsRes, agentsRes, onlineUsersRes] = await Promise.all([
          fetch('/api/admin/dashboard', { headers }),
          fetch('/api/admin/user-stats', { headers }),
          fetch('/api/admin/agents', { headers }),
          fetch('/api/admin/online-users', { headers })
        ]);

        if (!dashboardRes.ok || !userStatsRes.ok || !agentsRes.ok || !onlineUsersRes.ok) {
          this.error = true;
          return;
        }

        const [dashboard, userStats, agents, onlineUsers] = await Promise.all([
          dashboardRes.json(),
          userStatsRes.json(),
          agentsRes.json(),
          onlineUsersRes.json()
        ]);

        this.overview = {
          totalUsers: dashboard.totalUsers ?? 0,
          onlineUsers: dashboard.onlineUsers ?? 0,
          onlineAgents: dashboard.onlineAgents ?? 0,
          totalSessions: dashboard.totalSessions ?? 0
        };
        this.userStats = userStats.users ?? [];
        this.agents = agents.agents ?? [];
        this.onlineUsers = onlineUsers.users ?? [];
        this.loaded = true;
      } catch {
        this.error = true;
      } finally {
        this.loading = false;
      }
    },

    async refreshAll() {
      await this.fetchAll();
    },

    latencyClass(latency) {
      if (latency < 100) return 'db-latency-good';
      if (latency <= 500) return 'db-latency-warn';
      return 'db-latency-bad';
    },

    formatNumber(n) {
      if (n == null) return '0';
      return n.toLocaleString();
    },

    formatBytes(bytes) {
      if (!bytes || bytes === 0) return '0 B';
      const units = ['B', 'KB', 'MB', 'GB'];
      let i = 0;
      let size = bytes;
      while (size >= 1024 && i < units.length - 1) {
        size /= 1024;
        i++;
      }
      return `${size < 10 && i > 0 ? size.toFixed(1) : Math.round(size)} ${units[i]}`;
    },

    formatRelativeTime(ts) {
      if (!ts) return '—';
      const now = Date.now();
      const diff = now - new Date(ts).getTime();
      if (diff < 0) return '—';

      const seconds = Math.floor(diff / 1000);
      if (seconds < 60) return this.$t('settings.dashboard.ago', { time: `${seconds}s` });

      const minutes = Math.floor(seconds / 60);
      if (minutes < 60) return this.$t('settings.dashboard.ago', { time: `${minutes}m` });

      const hours = Math.floor(minutes / 60);
      if (hours < 24) return this.$t('settings.dashboard.ago', { time: `${hours}h` });

      const days = Math.floor(hours / 24);
      return this.$t('settings.dashboard.ago', { time: `${days}d` });
    }
  }
};
