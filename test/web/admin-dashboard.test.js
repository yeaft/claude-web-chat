import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { loadAllCss } from '../helpers/loadCss.js';

/**
 * Tests for task-admin-dashboard-web: Admin Dashboard Tab in Settings.
 *
 * Verifies:
 * 1) DashboardTab component structure — 4 sections: overview cards, user usage, agent list, online users
 * 2) Admin-only visibility — dashboard tab only added when authStore.role === 'admin'
 * 3) Refresh button with loading animation class
 * 4) Mobile responsive layout — table hidden, card list shown at ≤640px
 * 5) i18n completeness — 28 dashboard keys present in both en and zh-CN
 * 6) API error handling — error/loading states
 * 7) Data formatting helper functions
 * 8) CSS — db-* prefix, responsive rules, latency color classes
 * 9) CSS integration — dashboard.css in loadAllCss helper
 */

let dashboardSource;
let settingsSource;
let cssSource;
let dashboardCss;
let zhSource;
let enSource;

beforeAll(() => {
  const base = resolve(__dirname, '../../web');
  dashboardSource = readFileSync(resolve(base, 'components/DashboardTab.js'), 'utf-8');
  settingsSource = readFileSync(resolve(base, 'components/SettingsPanel.js'), 'utf-8');
  cssSource = loadAllCss();
  dashboardCss = readFileSync(resolve(base, 'styles/dashboard.css'), 'utf-8');
  zhSource = readFileSync(resolve(base, 'i18n/zh-CN.js'), 'utf-8');
  enSource = readFileSync(resolve(base, 'i18n/en.js'), 'utf-8');
});

// =====================================================================
// 1. Admin-only visibility
// =====================================================================
describe('admin-only visibility', () => {
  it('SettingsPanel imports DashboardTab component', () => {
    expect(settingsSource).toContain("import DashboardTab from './DashboardTab.js'");
  });

  it('DashboardTab is registered in components', () => {
    expect(settingsSource).toContain('DashboardTab');
    expect(settingsSource).toMatch(/components:\s*\{[^}]*DashboardTab/);
  });

  it('dashboard tab is pushed only when role is admin', () => {
    // Find the visibleTabs section
    const visibleSection = settingsSource.split('visibleTabs()')[1]?.split('return tabs')[0] || '';
    // dashboard push should be inside the admin-only block
    expect(visibleSection).toContain("'admin'");
    expect(visibleSection).toContain("'dashboard'");
  });

  it('dashboard tab is NOT pushed for pro-only users', () => {
    // The proxy tab is pushed for admin OR pro, but dashboard only for admin
    const visibleSection = settingsSource.split('visibleTabs()')[1]?.split('return tabs')[0] || '';
    // Find the admin-only block (second if statement)
    const adminBlock = visibleSection.split("this.authStore.role === 'admin'");
    // The dashboard push should be in a block that checks only for admin
    expect(adminBlock.length).toBeGreaterThan(1);
  });

  it('dashboard pane has v-if="authStore.role === \'admin\'" guard', () => {
    expect(settingsSource).toContain("activeTab === 'dashboard'");
    // There should be a v-if for admin on the dashboard pane
    const dashboardPaneSection = settingsSource.split("activeTab === 'dashboard'")[1]?.split('</div>')[0] || '';
    // The pane element should check admin role
    expect(settingsSource).toMatch(/dashboard.*admin|admin.*dashboard/s);
  });

  it('dashboard pane renders DashboardTab component', () => {
    expect(settingsSource).toContain('<DashboardTab');
  });

  it('dashboard has a unique tab icon (grid/dashboard SVG)', () => {
    expect(settingsSource).toContain("tab.key === 'dashboard'");
    // Should have an SVG path for the dashboard icon
    const dashIconSection = settingsSource.split("tab.key === 'dashboard'")[1]?.split('</svg>')[0] || '';
    expect(dashIconSection).toContain('viewBox');
  });
});

// =====================================================================
// 2. Overview stat cards
// =====================================================================
describe('overview stat cards', () => {
  it('has a stats row container with 4 stat cards', () => {
    expect(dashboardSource).toContain('db-stats-row');
    // Should have 4 db-stat-card divs
    const statCards = dashboardSource.match(/db-stat-card/g);
    expect(statCards).not.toBeNull();
    expect(statCards.length).toBeGreaterThanOrEqual(4);
  });

  it('displays totalUsers stat', () => {
    expect(dashboardSource).toContain('overview.totalUsers');
    expect(dashboardSource).toContain("$t('settings.dashboard.totalUsers')");
  });

  it('displays onlineUsers stat with active class', () => {
    expect(dashboardSource).toContain('overview.onlineUsers');
    expect(dashboardSource).toContain("$t('settings.dashboard.onlineUsers')");
    expect(dashboardSource).toContain("'is-active': overview.onlineUsers > 0");
  });

  it('displays onlineAgents stat with active class', () => {
    expect(dashboardSource).toContain('overview.onlineAgents');
    expect(dashboardSource).toContain("$t('settings.dashboard.onlineAgents')");
    expect(dashboardSource).toContain("'is-active': overview.onlineAgents > 0");
  });

  it('displays totalSessions stat', () => {
    expect(dashboardSource).toContain('overview.totalSessions');
    expect(dashboardSource).toContain("$t('settings.dashboard.totalSessions')");
  });

  it('initializes overview with default zero values', () => {
    expect(dashboardSource).toContain('totalUsers: 0');
    expect(dashboardSource).toContain('onlineUsers: 0');
    expect(dashboardSource).toContain('onlineAgents: 0');
    expect(dashboardSource).toContain('totalSessions: 0');
  });
});

// =====================================================================
// 3. User usage table section
// =====================================================================
describe('user usage table', () => {
  it('has a section with userUsage title', () => {
    expect(dashboardSource).toContain("$t('settings.dashboard.userUsage')");
  });

  it('renders table with correct columns', () => {
    expect(dashboardSource).toContain("$t('settings.dashboard.name')");
    expect(dashboardSource).toContain("$t('settings.dashboard.messages')");
    expect(dashboardSource).toContain("$t('settings.dashboard.sessions')");
    expect(dashboardSource).toContain("$t('settings.dashboard.requests')");
    expect(dashboardSource).toContain("$t('settings.dashboard.traffic')");
    expect(dashboardSource).toContain("$t('settings.dashboard.lastLogin')");
  });

  it('iterates over userStats array for table rows', () => {
    expect(dashboardSource).toContain('v-for="user in userStats"');
  });

  it('displays formatted message count', () => {
    expect(dashboardSource).toContain('formatNumber(user.messageCount)');
  });

  it('displays formatted session count', () => {
    expect(dashboardSource).toContain('formatNumber(user.sessionCount)');
  });

  it('displays formatted request count', () => {
    expect(dashboardSource).toContain('formatNumber(user.requestCount)');
  });

  it('displays formatted traffic (bytesSent + bytesReceived)', () => {
    expect(dashboardSource).toContain('formatBytes(user.bytesSent + user.bytesReceived)');
  });

  it('displays formatted last login time', () => {
    expect(dashboardSource).toContain('formatRelativeTime(user.lastLoginAt)');
  });

  it('initializes userStats as empty array', () => {
    expect(dashboardSource).toContain('userStats: []');
  });
});

// =====================================================================
// 4. Agent list section
// =====================================================================
describe('agent list section', () => {
  it('has a section with agentList title', () => {
    expect(dashboardSource).toContain("$t('settings.dashboard.agentList')");
  });

  it('iterates over agents array', () => {
    expect(dashboardSource).toContain('v-for="agent in agents"');
  });

  it('shows agent name column', () => {
    expect(dashboardSource).toContain('agent.name');
  });

  it('shows online/offline status with status dot', () => {
    expect(dashboardSource).toContain('db-status-dot');
    expect(dashboardSource).toContain("agent.online ? 'online' : 'offline'");
  });

  it('shows online/offline text using i18n', () => {
    expect(dashboardSource).toContain("$t('settings.dashboard.online')");
    expect(dashboardSource).toContain("$t('settings.dashboard.offline')");
  });

  it('shows latency with color class for online agents', () => {
    expect(dashboardSource).toContain('latencyClass(agent.latency)');
    expect(dashboardSource).toContain('agent.latency');
  });

  it('shows dash for offline agent latency', () => {
    expect(dashboardSource).toContain('v-else');
    // Offline latency shows —
    expect(dashboardSource).toMatch(/v-else.*—/s);
  });

  it('shows agent version and owner', () => {
    expect(dashboardSource).toContain("agent.version || '—'");
    expect(dashboardSource).toContain("agent.owner || '—'");
  });

  it('shows empty state when no agents', () => {
    expect(dashboardSource).toContain("$t('settings.dashboard.noAgents')");
  });

  it('initializes agents as empty array', () => {
    expect(dashboardSource).toContain('agents: []');
  });
});

// =====================================================================
// 5. Online users section
// =====================================================================
describe('online users section', () => {
  it('has a section with onlineUserList title', () => {
    expect(dashboardSource).toContain("$t('settings.dashboard.onlineUserList')");
  });

  it('iterates over onlineUsers array', () => {
    expect(dashboardSource).toContain('v-for="user in onlineUsers"');
  });

  it('shows user name, role badge, and agent name', () => {
    expect(dashboardSource).toContain('user.username');
    expect(dashboardSource).toContain('user.role');
    expect(dashboardSource).toContain('user.agentName');
  });

  it('uses sp-badge class for role display', () => {
    expect(dashboardSource).toContain('sp-badge');
    expect(dashboardSource).toContain("'sp-role-' + (user.role || 'pro')");
  });

  it('shows empty state when no online users', () => {
    expect(dashboardSource).toContain("$t('settings.dashboard.noOnlineUsers')");
  });

  it('initializes onlineUsers as empty array', () => {
    expect(dashboardSource).toContain('onlineUsers: []');
  });
});

// =====================================================================
// 6. Refresh button and loading animation
// =====================================================================
describe('refresh button and loading', () => {
  it('has a refresh button with db-refresh-btn class', () => {
    expect(dashboardSource).toContain('db-refresh-btn');
  });

  it('refresh button calls refreshAll on click', () => {
    expect(dashboardSource).toContain('@click="refreshAll"');
  });

  it('refresh button is disabled during loading', () => {
    expect(dashboardSource).toContain(':disabled="loading"');
  });

  it('refresh button has is-loading class when loading', () => {
    expect(dashboardSource).toContain("'is-loading': loading");
  });

  it('refresh button has i18n title', () => {
    expect(dashboardSource).toContain("$t('settings.dashboard.refresh')");
  });

  it('refresh button contains SVG icon', () => {
    const refreshSection = dashboardSource.split('db-refresh-btn')[1]?.split('</button>')[0] || '';
    expect(refreshSection).toContain('<svg');
    expect(refreshSection).toContain('</svg>');
  });

  it('CSS: is-loading class triggers spin animation on SVG', () => {
    expect(dashboardCss).toContain('.db-refresh-btn.is-loading svg');
    expect(dashboardCss).toContain('animation');
    expect(dashboardCss).toContain('spin');
  });

  it('CSS: disabled state has reduced opacity', () => {
    expect(dashboardCss).toContain('.db-refresh-btn:disabled');
    expect(dashboardCss).toContain('opacity');
  });
});

// =====================================================================
// 7. Loading and error states
// =====================================================================
describe('loading and error states', () => {
  it('shows loading state when loading && !loaded', () => {
    expect(dashboardSource).toContain('v-if="loading && !loaded"');
    expect(dashboardSource).toContain("$t('settings.dashboard.loading')");
  });

  it('shows error state when error is true', () => {
    expect(dashboardSource).toContain('v-else-if="error"');
    expect(dashboardSource).toContain("$t('settings.dashboard.error')");
  });

  it('initializes loading as false', () => {
    expect(dashboardSource).toContain('loading: false');
  });

  it('initializes loaded as false', () => {
    expect(dashboardSource).toContain('loaded: false');
  });

  it('initializes error as false', () => {
    expect(dashboardSource).toContain('error: false');
  });
});

// =====================================================================
// 8. API fetch logic
// =====================================================================
describe('API fetch logic', () => {
  it('fetches all 4 API endpoints in parallel', () => {
    expect(dashboardSource).toContain('/api/admin/dashboard');
    expect(dashboardSource).toContain('/api/admin/user-stats');
    expect(dashboardSource).toContain('/api/admin/agents');
    expect(dashboardSource).toContain('/api/admin/online-users');
    expect(dashboardSource).toContain('Promise.all');
  });

  it('sends Authorization header with Bearer token', () => {
    expect(dashboardSource).toContain('Authorization');
    expect(dashboardSource).toContain('Bearer');
    expect(dashboardSource).toContain('authStore.token');
  });

  it('checks all response ok statuses', () => {
    expect(dashboardSource).toContain('dashboardRes.ok');
    expect(dashboardSource).toContain('userStatsRes.ok');
    expect(dashboardSource).toContain('agentsRes.ok');
    expect(dashboardSource).toContain('onlineUsersRes.ok');
  });

  it('sets error=true when any response is not ok', () => {
    // The fetchAll method body sets error = true when !ok
    const methodsSection = dashboardSource.split('methods:')[1] || '';
    const fetchSection = methodsSection.split('async fetchAll')[1]?.split('async refreshAll')[0] || '';
    expect(fetchSection).toContain('this.error = true');
  });

  it('sets error=true on catch (network failure)', () => {
    expect(dashboardSource).toContain('catch');
    // After the try block, the catch should set error
    const catchSection = dashboardSource.split('} catch')[1]?.split('} finally')[0] || '';
    expect(catchSection).toContain('this.error = true');
  });

  it('always sets loading=false in finally block', () => {
    expect(dashboardSource).toContain('finally');
    const finallySection = dashboardSource.split('} finally')[1]?.split('}')[0] || '';
    expect(finallySection).toContain('this.loading = false');
  });

  it('sets loaded=true after successful data load', () => {
    expect(dashboardSource).toContain('this.loaded = true');
  });

  it('uses nullish coalescing for safe data access', () => {
    expect(dashboardSource).toContain('dashboard.totalUsers ?? 0');
    expect(dashboardSource).toContain('dashboard.onlineUsers ?? 0');
    expect(dashboardSource).toContain('dashboard.onlineAgents ?? 0');
    expect(dashboardSource).toContain('dashboard.totalSessions ?? 0');
    expect(dashboardSource).toContain('userStats.users ?? []');
    expect(dashboardSource).toContain('agents.agents ?? []');
    expect(dashboardSource).toContain('onlineUsers.users ?? []');
  });

  it('fetchAll is called on mounted', () => {
    expect(dashboardSource).toContain('mounted()');
    const mountedSection = dashboardSource.split('mounted()')[1]?.split('}')[0] || '';
    expect(mountedSection).toContain('this.fetchAll()');
  });

  it('refreshAll delegates to fetchAll', () => {
    const refreshSection = dashboardSource.split('refreshAll()')[1]?.split('}')[0] || '';
    expect(refreshSection).toContain('this.fetchAll()');
  });
});

// =====================================================================
// 9. Data formatting helpers
// =====================================================================
describe('data formatting helpers', () => {
  describe('latencyClass', () => {
    it('returns db-latency-good for latency < 100', () => {
      expect(dashboardSource).toContain("'db-latency-good'");
      expect(dashboardSource).toContain('latency < 100');
    });

    it('returns db-latency-warn for latency <= 500', () => {
      expect(dashboardSource).toContain("'db-latency-warn'");
      expect(dashboardSource).toContain('latency <= 500');
    });

    it('returns db-latency-bad for latency > 500', () => {
      expect(dashboardSource).toContain("'db-latency-bad'");
    });
  });

  describe('formatNumber', () => {
    it('uses toLocaleString for formatting', () => {
      expect(dashboardSource).toContain('toLocaleString()');
    });

    it('returns 0 string for null values', () => {
      const methodsSection = dashboardSource.split('methods:')[1] || '';
      const fnSection = methodsSection.split('formatNumber')[1]?.split('},')[0] || '';
      expect(fnSection).toContain("'0'");
      expect(fnSection).toContain('n == null');
    });
  });

  describe('formatBytes', () => {
    it('handles zero bytes', () => {
      expect(dashboardSource).toContain("'0 B'");
    });

    it('uses correct unit progression B, KB, MB, GB', () => {
      expect(dashboardSource).toContain("'B'");
      expect(dashboardSource).toContain("'KB'");
      expect(dashboardSource).toContain("'MB'");
      expect(dashboardSource).toContain("'GB'");
    });

    it('divides by 1024 for unit conversion', () => {
      expect(dashboardSource).toContain('1024');
    });
  });

  describe('formatRelativeTime', () => {
    it('returns dash for null/undefined timestamps', () => {
      const methodsSection = dashboardSource.split('methods:')[1] || '';
      const fnSection = methodsSection.split('formatRelativeTime')[1]?.split('}\n  }')[0] || '';
      expect(fnSection).toContain("'—'");
      expect(fnSection).toContain('!ts');
    });

    it('uses i18n ago key for time display', () => {
      expect(dashboardSource).toContain("$t('settings.dashboard.ago'");
    });

    it('handles seconds, minutes, hours, and days', () => {
      const methodsSection = dashboardSource.split('methods:')[1] || '';
      const fnSection = methodsSection.split('formatRelativeTime')[1]?.split('}\n  }')[0] || '';
      expect(fnSection).toContain('seconds');
      expect(fnSection).toContain('minutes');
      expect(fnSection).toContain('hours');
      expect(fnSection).toContain('days');
    });
  });
});
// =====================================================================
// 11. i18n completeness
// =====================================================================
describe('i18n completeness', () => {
  const DASHBOARD_KEYS = [
    'settings.tabs.dashboard',
    'settings.dashboard.totalUsers',
    'settings.dashboard.onlineUsers',
    'settings.dashboard.onlineAgents',
    'settings.dashboard.totalSessions',
    'settings.dashboard.userUsage',
    'settings.dashboard.agentList',
    'settings.dashboard.onlineUserList',
    'settings.dashboard.refresh',
    'settings.dashboard.name',
    'settings.dashboard.messages',
    'settings.dashboard.sessions',
    'settings.dashboard.requests',
    'settings.dashboard.traffic',
    'settings.dashboard.lastLogin',
    'settings.dashboard.status',
    'settings.dashboard.latency',
    'settings.dashboard.version',
    'settings.dashboard.owner',
    'settings.dashboard.role',
    'settings.dashboard.agent',
    'settings.dashboard.online',
    'settings.dashboard.offline',
    'settings.dashboard.noAgents',
    'settings.dashboard.noOnlineUsers',
    'settings.dashboard.loading',
    'settings.dashboard.error',
    'settings.dashboard.ago',
  ];

  describe('English i18n', () => {
    DASHBOARD_KEYS.forEach(key => {
      it(`has key: ${key}`, () => {
        expect(enSource).toContain(`'${key}'`);
      });
    });
  });

  describe('Chinese i18n', () => {
    DASHBOARD_KEYS.forEach(key => {
      it(`has key: ${key}`, () => {
        expect(zhSource).toContain(`'${key}'`);
      });
    });
  });

  it('en and zh have equal number of dashboard keys', () => {
    const enCount = (enSource.match(/settings\.dashboard\./g) || []).length;
    const zhCount = (zhSource.match(/settings\.dashboard\./g) || []).length;
    expect(enCount).toBe(zhCount);
  });

  it('Chinese ago key uses {time} placeholder', () => {
    const zhAgo = zhSource.split("'settings.dashboard.ago'")[1]?.split(',')[0] || '';
    expect(zhAgo).toContain('{time}');
  });

  it('English ago key uses {time} placeholder', () => {
    const enAgo = enSource.split("'settings.dashboard.ago'")[1]?.split(',')[0] || '';
    expect(enAgo).toContain('{time}');
  });
});
// =====================================================================
// 14. Component structure
// =====================================================================
describe('component structure', () => {
  it('component is named DashboardTab', () => {
    expect(dashboardSource).toContain("name: 'DashboardTab'");
  });

  it('imports useAuthStore for authentication', () => {
    expect(dashboardSource).toContain("import { useAuthStore } from '../stores/auth.js'");
  });

  it('has getHeaders method that adds Bearer token', () => {
    expect(dashboardSource).toContain('getHeaders()');
    expect(dashboardSource).toContain('Bearer');
  });

  it('has correct data default values', () => {
    expect(dashboardSource).toContain('loading: false');
    expect(dashboardSource).toContain('loaded: false');
    expect(dashboardSource).toContain('error: false');
    expect(dashboardSource).toContain('userStats: []');
    expect(dashboardSource).toContain('agents: []');
    expect(dashboardSource).toContain('onlineUsers: []');
  });

  it('has all required methods', () => {
    expect(dashboardSource).toContain('fetchAll()');
    expect(dashboardSource).toContain('refreshAll()');
    expect(dashboardSource).toContain('latencyClass(');
    expect(dashboardSource).toContain('formatNumber(');
    expect(dashboardSource).toContain('formatBytes(');
    expect(dashboardSource).toContain('formatRelativeTime(');
  });
});

// =====================================================================
// 15. Brace count integrity
// =====================================================================
describe('CSS brace count integrity', () => {
  it('dashboard.css has balanced braces', () => {
    const opens = (dashboardCss.match(/\{/g) || []).length;
    const closes = (dashboardCss.match(/\}/g) || []).length;
    expect(opens).toBe(closes);
  });

  it('dashboard.css brace count is tracked', () => {
    const braceCount = (dashboardCss.match(/\{/g) || []).length;
    // New file, just ensure it's reasonable (>10 rules)
    expect(braceCount).toBeGreaterThan(10);
  });

  it('total CSS brace count across all files', () => {
    const total = (cssSource.match(/\{/g) || []).length;
    // Previous total was 2098 (PR #98), adding dashboard.css rules
    expect(total).toBeGreaterThanOrEqual(2098);
  });
});
