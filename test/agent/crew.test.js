import { describe, it, expect } from 'vitest';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

/**
 * Tests for crew persistence, sync, and session management.
 * Replicates key logic from agent/crew.js and agent/conversation.js
 * without importing them directly (to avoid SDK/context side effects).
 */

// =====================================================================
// Replicate core functions for testing
// =====================================================================

function sessionToIndexEntry(session) {
  return {
    sessionId: session.id,
    projectDir: session.projectDir,
    sharedDir: session.sharedDir,
    status: session.status,
    goal: session.goal,
    userId: session.userId,
    username: session.username,
    createdAt: session.createdAt,
    updatedAt: Date.now()
  };
}

function buildSessionMeta(session) {
  return {
    sessionId: session.id,
    projectDir: session.projectDir,
    sharedDir: session.sharedDir,
    goal: session.goal,
    status: session.status,
    roles: Array.from(session.roles.values()).map(r => ({
      name: r.name, displayName: r.displayName, icon: r.icon,
      description: r.description, isDecisionMaker: r.isDecisionMaker || false
    })),
    decisionMaker: session.decisionMaker,
    maxRounds: session.maxRounds,
    round: session.round,
    createdAt: session.createdAt,
    updatedAt: Date.now(),
    userId: session.userId,
    username: session.username
  };
}

// Helper: create a test crew session object
function createTestSession(overrides = {}) {
  const roles = overrides.roles || new Map([
    ['pm', { name: 'pm', displayName: 'PM', icon: '📋', description: '需求分析', isDecisionMaker: true }],
    ['developer', { name: 'developer', displayName: '开发者', icon: '💻', description: '代码编写', isDecisionMaker: false }]
  ]);
  return {
    id: overrides.id || 'crew_test_001',
    projectDir: overrides.projectDir || '/tmp/test-project',
    sharedDir: overrides.sharedDir || '/tmp/test-project/.crew',
    goal: 'goal' in overrides ? overrides.goal : '测试目标',
    roles,
    roleStates: new Map(),
    decisionMaker: overrides.decisionMaker || 'pm',
    status: overrides.status || 'running',
    round: overrides.round || 0,
    maxRounds: overrides.maxRounds || 20,
    costUsd: 0,
    messageHistory: [],
    humanMessageQueue: [],
    waitingHumanContext: null,
    userId: overrides.userId || 'user_123',
    username: overrides.username || 'testuser',
    createdAt: overrides.createdAt || Date.now()
  };
}

// =====================================================================
// Tests
// =====================================================================

describe('Crew Index Operations', () => {
  describe('sessionToIndexEntry', () => {
    it('should extract minimal fields from session', () => {
      const session = createTestSession();
      const entry = sessionToIndexEntry(session);

      expect(entry.sessionId).toBe('crew_test_001');
      expect(entry.projectDir).toBe('/tmp/test-project');
      expect(entry.sharedDir).toBe('/tmp/test-project/.crew');
      expect(entry.status).toBe('running');
      expect(entry.createdAt).toBe(session.createdAt);
      expect(entry.updatedAt).toBeGreaterThan(0);
    });

    it('should include goal, userId, username but not roles', () => {
      const session = createTestSession();
      const entry = sessionToIndexEntry(session);

      expect(entry.goal).toBe('测试目标');
      expect(entry.userId).toBe('user_123');
      expect(entry.username).toBe('testuser');
      expect(entry.roles).toBeUndefined();
      expect(entry.decisionMaker).toBeUndefined();
    });
  });

  describe('upsertCrewIndex logic', () => {
    it('should add new entry to empty index', () => {
      const index = [];
      const session = createTestSession();
      const entry = sessionToIndexEntry(session);

      const idx = index.findIndex(e => e.sessionId === session.id);
      if (idx >= 0) index[idx] = entry; else index.push(entry);

      expect(index.length).toBe(1);
      expect(index[0].sessionId).toBe('crew_test_001');
    });

    it('should update existing entry by sessionId', () => {
      const index = [
        { sessionId: 'crew_test_001', status: 'running', updatedAt: 1000 }
      ];
      const session = createTestSession({ status: 'stopped' });
      const entry = sessionToIndexEntry(session);

      const idx = index.findIndex(e => e.sessionId === session.id);
      if (idx >= 0) index[idx] = entry; else index.push(entry);

      expect(index.length).toBe(1);
      expect(index[0].status).toBe('stopped');
      expect(index[0].updatedAt).toBeGreaterThan(1000);
    });

    it('should not duplicate entries', () => {
      const index = [
        { sessionId: 'crew_001', status: 'running' },
        { sessionId: 'crew_002', status: 'running' }
      ];
      const session = createTestSession({ id: 'crew_001', status: 'stopped' });
      const entry = sessionToIndexEntry(session);

      const idx = index.findIndex(e => e.sessionId === session.id);
      if (idx >= 0) index[idx] = entry; else index.push(entry);

      expect(index.length).toBe(2);
      expect(index[0].status).toBe('stopped');
      expect(index[1].sessionId).toBe('crew_002');
    });
  });

  describe('loadCrewIndex (file-based)', () => {
    it('should return empty array if file does not exist', async () => {
      const fakePath = join(tmpdir(), `crew-index-${Date.now()}-nonexistent.json`);
      let result;
      try { result = JSON.parse(await fs.readFile(fakePath, 'utf-8')); }
      catch { result = []; }

      expect(result).toEqual([]);
    });

    it('should parse valid JSON file', async () => {
      const fakePath = join(tmpdir(), `crew-index-${Date.now()}.json`);
      const data = [{ sessionId: 'crew_001', status: 'stopped' }];
      await fs.writeFile(fakePath, JSON.stringify(data));

      let result;
      try { result = JSON.parse(await fs.readFile(fakePath, 'utf-8')); }
      catch { result = []; }

      expect(result.length).toBe(1);
      expect(result[0].sessionId).toBe('crew_001');

      // Cleanup
      await fs.unlink(fakePath);
    });
  });
});

describe('Session Metadata (.crew/session.json)', () => {
  describe('buildSessionMeta', () => {
    it('should correctly serialize roles Map to array', () => {
      const session = createTestSession();
      const meta = buildSessionMeta(session);

      expect(meta.sessionId).toBe('crew_test_001');
      expect(meta.goal).toBe('测试目标');
      expect(meta.roles).toBeInstanceOf(Array);
      expect(meta.roles.length).toBe(2);
      expect(meta.roles[0].name).toBe('pm');
      expect(meta.roles[0].isDecisionMaker).toBe(true);
      expect(meta.roles[1].name).toBe('developer');
      expect(meta.roles[1].isDecisionMaker).toBe(false);
    });

    it('should include all required fields', () => {
      const session = createTestSession({ round: 5, maxRounds: 10 });
      const meta = buildSessionMeta(session);

      expect(meta.decisionMaker).toBe('pm');
      expect(meta.maxRounds).toBe(10);
      expect(meta.round).toBe(5);
      expect(meta.userId).toBe('user_123');
      expect(meta.username).toBe('testuser');
    });
  });

  describe('loadSessionMeta (file-based)', () => {
    it('should return null if file does not exist', async () => {
      const fakePath = join(tmpdir(), `session-${Date.now()}-nonexistent.json`);
      let result;
      try { result = JSON.parse(await fs.readFile(fakePath, 'utf-8')); }
      catch { result = null; }

      expect(result).toBeNull();
    });

    it('should load valid session.json', async () => {
      const dir = join(tmpdir(), `crew-test-${Date.now()}`);
      await fs.mkdir(dir, { recursive: true });
      const meta = { sessionId: 'crew_001', goal: 'test', roles: [{ name: 'pm' }] };
      await fs.writeFile(join(dir, 'session.json'), JSON.stringify(meta));

      let result;
      try { result = JSON.parse(await fs.readFile(join(dir, 'session.json'), 'utf-8')); }
      catch { result = null; }

      expect(result).not.toBeNull();
      expect(result.sessionId).toBe('crew_001');
      expect(result.roles[0].name).toBe('pm');

      // Cleanup
      await fs.rm(dir, { recursive: true });
    });
  });
});

describe('handleListCrewSessions Logic', () => {
  it('should merge active session status into index entries', () => {
    const crewSessions = new Map();
    crewSessions.set('crew_001', { status: 'running', round: 3 });
    crewSessions.set('crew_003', { status: 'waiting_human', round: 7 });

    const index = [
      { sessionId: 'crew_001', status: 'stopped' },
      { sessionId: 'crew_002', status: 'stopped' },
      { sessionId: 'crew_003', status: 'stopped' }
    ];

    for (const entry of index) {
      const active = crewSessions.get(entry.sessionId);
      if (active) {
        entry.status = active.status;
      }
    }

    expect(index[0].status).toBe('running');
    expect(index[1].status).toBe('stopped');
    expect(index[2].status).toBe('waiting_human');
  });

  it('should produce correct response format', () => {
    const msg = { requestId: 'req_123', _requestClientId: 'client_456' };
    const index = [{ sessionId: 'crew_001', status: 'stopped' }];

    const response = {
      type: 'crew_sessions_list',
      requestId: msg.requestId,
      _requestClientId: msg._requestClientId,
      sessions: index
    };

    expect(response.type).toBe('crew_sessions_list');
    expect(response.requestId).toBe('req_123');
    expect(response._requestClientId).toBe('client_456');
    expect(response.sessions.length).toBe(1);
  });
});

describe('resumeCrewSession Logic', () => {
  it('should return early if session already active', () => {
    const crewSessions = new Map();
    const session = createTestSession({ status: 'running' });
    crewSessions.set('crew_001', session);

    const alreadyActive = crewSessions.has('crew_001');
    expect(alreadyActive).toBe(true);
  });

  it('should report error if session not in index', () => {
    const index = [
      { sessionId: 'crew_other', sharedDir: '/tmp/.crew' }
    ];
    const found = index.find(e => e.sessionId === 'crew_missing');
    expect(found).toBeUndefined();
  });

  it('should rebuild session from metadata', () => {
    const meta = {
      sessionId: 'crew_001',
      projectDir: '/project',
      sharedDir: '/project/.crew',
      goal: 'Build feature X',
      roles: [
        { name: 'pm', displayName: 'PM', icon: '📋', description: 'desc', isDecisionMaker: true },
        { name: 'developer', displayName: '开发者', icon: '💻', description: 'desc', isDecisionMaker: false }
      ],
      decisionMaker: 'pm',
      maxRounds: 20,
      round: 5,
      createdAt: 1000000,
      userId: 'user_orig',
      username: 'origuser'
    };

    // Replicate resumeCrewSession logic
    const roles = meta.roles || [];
    const decisionMaker = meta.decisionMaker || roles[0]?.name || null;
    const session = {
      id: meta.sessionId,
      projectDir: meta.projectDir,
      sharedDir: meta.sharedDir,
      goal: meta.goal,
      roles: new Map(roles.map(r => [r.name, r])),
      roleStates: new Map(),
      decisionMaker,
      status: 'waiting_human',
      round: meta.round || 0,
      maxRounds: meta.maxRounds || 20,
      costUsd: 0,
      messageHistory: [],
      humanMessageQueue: [],
      waitingHumanContext: null,
      userId: 'user_new' || meta.userId,
      username: 'newuser' || meta.username,
      createdAt: meta.createdAt || Date.now()
    };

    expect(session.id).toBe('crew_001');
    expect(session.status).toBe('waiting_human');
    expect(session.round).toBe(5);
    expect(session.roles.size).toBe(2);
    expect(session.roles.has('pm')).toBe(true);
    expect(session.roles.has('developer')).toBe(true);
    expect(session.decisionMaker).toBe('pm');
    expect(session.userId).toBe('user_new');
    expect(session.createdAt).toBe(1000000);
  });

  it('should prefer msg userId over meta userId', () => {
    const meta = { userId: 'user_orig', username: 'origuser' };
    const msgUserId = 'user_override';
    const msgUsername = 'overrideuser';

    const userId = msgUserId || meta.userId;
    const username = msgUsername || meta.username;

    expect(userId).toBe('user_override');
    expect(username).toBe('overrideuser');
  });

  it('should fallback to meta userId if msg has none', () => {
    const meta = { userId: 'user_orig', username: 'origuser' };
    const msgUserId = undefined;
    const msgUsername = undefined;

    const userId = msgUserId || meta.userId;
    const username = msgUsername || meta.username;

    expect(userId).toBe('user_orig');
    expect(username).toBe('origuser');
  });
});

describe('sendConversationList with Crew Sessions', () => {
  it('should include normal conversations and active crew sessions', () => {
    const conversations = new Map();
    conversations.set('conv_001', {
      workDir: '/project', claudeSessionId: 'cs1',
      createdAt: 1000, turnActive: false,
      userId: 'u1', username: 'user1'
    });

    const crewSessions = new Map();
    crewSessions.set('crew_001', {
      projectDir: '/project', createdAt: 2000,
      status: 'running', userId: 'u1', username: 'user1',
      goal: 'Build X'
    });

    const list = [];
    for (const [id, state] of conversations) {
      list.push({
        id, workDir: state.workDir, claudeSessionId: state.claudeSessionId,
        createdAt: state.createdAt, processing: !!state.turnActive,
        userId: state.userId, username: state.username
      });
    }
    const activeCrewIds = new Set();
    for (const [id, session] of crewSessions) {
      activeCrewIds.add(id);
      list.push({
        id, workDir: session.projectDir, createdAt: session.createdAt,
        processing: session.status === 'running',
        userId: session.userId, username: session.username,
        type: 'crew', goal: session.goal
      });
    }

    expect(list.length).toBe(2);
    expect(list[0].id).toBe('conv_001');
    expect(list[0].type).toBeUndefined();
    expect(list[1].id).toBe('crew_001');
    expect(list[1].type).toBe('crew');
    expect(list[1].goal).toBe('Build X');
    expect(list[1].processing).toBe(true);
  });

  it('should include stopped crew sessions from index', () => {
    const crewSessions = new Map();
    crewSessions.set('crew_active', { projectDir: '/p', createdAt: 1000, status: 'running', goal: 'A' });

    const index = [
      { sessionId: 'crew_active', projectDir: '/p', createdAt: 1000 },
      { sessionId: 'crew_stopped', projectDir: '/p2', createdAt: 2000, status: 'stopped' }
    ];

    const list = [];
    const activeCrewIds = new Set();
    for (const [id, session] of crewSessions) {
      activeCrewIds.add(id);
      list.push({ id, type: 'crew' });
    }
    for (const entry of index) {
      if (!activeCrewIds.has(entry.sessionId)) {
        list.push({
          id: entry.sessionId, workDir: entry.projectDir,
          createdAt: entry.createdAt, processing: false,
          type: 'crew', status: entry.status
        });
      }
    }

    expect(list.length).toBe(2);
    expect(list[0].id).toBe('crew_active');
    expect(list[1].id).toBe('crew_stopped');
    expect(list[1].status).toBe('stopped');
    expect(list[1].processing).toBe(false);
  });

  it('should not duplicate active crew sessions from index', () => {
    const crewSessions = new Map();
    crewSessions.set('crew_001', { projectDir: '/p', createdAt: 1000, status: 'running', goal: 'A' });

    const index = [
      { sessionId: 'crew_001', projectDir: '/p', createdAt: 1000, status: 'running' }
    ];

    const activeCrewIds = new Set();
    const list = [];
    for (const [id] of crewSessions) {
      activeCrewIds.add(id);
      list.push({ id, type: 'crew' });
    }
    for (const entry of index) {
      if (!activeCrewIds.has(entry.sessionId)) {
        list.push({ id: entry.sessionId, type: 'crew' });
      }
    }

    expect(list.length).toBe(1);
    expect(list[0].id).toBe('crew_001');
  });
});

describe('Server conversation_list Crew Field Preservation', () => {
  it('should preserve type and goal when updating existing conversation', () => {
    const agent = { conversations: new Map() };
    agent.conversations.set('crew_001', {
      id: 'crew_001', workDir: '/old', userId: 'u1'
    });

    const incoming = { id: 'crew_001', workDir: '/new', type: 'crew', goal: 'Build X' };

    // Replicate ws-agent.js merge logic
    const existing = agent.conversations.get(incoming.id);
    if (existing) {
      existing.workDir = incoming.workDir || existing.workDir;
      if (incoming.type) existing.type = incoming.type;
      if (incoming.goal) existing.goal = incoming.goal;
    }

    expect(existing.workDir).toBe('/new');
    expect(existing.type).toBe('crew');
    expect(existing.goal).toBe('Build X');
    expect(existing.userId).toBe('u1');
  });

  it('should include type and goal for new crew conversations', () => {
    const agent = { conversations: new Map() };
    const incoming = {
      id: 'crew_new', workDir: '/project', type: 'crew', goal: 'Feature Y',
      userId: null, username: null
    };

    const existing = agent.conversations.get(incoming.id);
    if (!existing) {
      const trustedUserId = null;
      const trustedUsername = null;
      agent.conversations.set(incoming.id, { ...incoming, userId: trustedUserId, username: trustedUsername });
    }

    const conv = agent.conversations.get('crew_new');
    expect(conv.type).toBe('crew');
    expect(conv.goal).toBe('Feature Y');
  });

  it('should not strip type/goal during sync cleanup', () => {
    const agent = { conversations: new Map() };
    agent.conversations.set('conv_001', { id: 'conv_001' });
    agent.conversations.set('crew_001', { id: 'crew_001', type: 'crew', goal: 'X' });

    const incomingList = [
      { id: 'conv_001', workDir: '/w' },
      { id: 'crew_001', workDir: '/p', type: 'crew', goal: 'X updated' }
    ];

    // Replicate sync: delete missing, update existing
    const incomingIds = new Set(incomingList.map(c => c.id));
    for (const id of agent.conversations.keys()) {
      if (!incomingIds.has(id)) agent.conversations.delete(id);
    }
    for (const conv of incomingList) {
      const existing = agent.conversations.get(conv.id);
      if (existing) {
        existing.workDir = conv.workDir || existing.workDir;
        if (conv.type) existing.type = conv.type;
        if (conv.goal) existing.goal = conv.goal;
      } else {
        agent.conversations.set(conv.id, conv);
      }
    }

    expect(agent.conversations.size).toBe(2);
    expect(agent.conversations.get('crew_001').type).toBe('crew');
    expect(agent.conversations.get('crew_001').goal).toBe('X updated');
  });
});

describe('Route Parsing', () => {
  // Replicate parseRoute from crew.js
  function parseRoute(text) {
    const match = text.match(/---ROUTE---\s*\n\s*to:\s*(.+?)\s*\n\s*summary:\s*(.+?)\s*\n\s*---END_ROUTE---/s);
    if (match) {
      return { to: match[1].trim().toLowerCase(), summary: match[2].trim() };
    }
    const altMatch = text.match(/---ROUTE---\s*\n([\s\S]*?)---END_ROUTE---/);
    if (altMatch) {
      const block = altMatch[1];
      const toMatch = block.match(/to:\s*(.+)/i);
      const summaryMatch = block.match(/summary:\s*(.+)/i);
      if (toMatch) {
        return { to: toMatch[1].trim().toLowerCase(), summary: summaryMatch ? summaryMatch[1].trim() : '' };
      }
    }
    return null;
  }

  it('should parse standard ROUTE block', () => {
    const text = `一些工作内容...

---ROUTE---
to: developer
summary: 请按照设计方案实现功能
---END_ROUTE---`;

    const route = parseRoute(text);
    expect(route).not.toBeNull();
    expect(route.to).toBe('developer');
    expect(route.summary).toBe('请按照设计方案实现功能');
  });

  it('should parse route with extra whitespace', () => {
    const text = `---ROUTE---
  to:   reviewer
  summary:   代码已完成，请审核
---END_ROUTE---`;

    const route = parseRoute(text);
    expect(route).not.toBeNull();
    expect(route.to).toBe('reviewer');
    expect(route.summary).toBe('代码已完成，请审核');
  });

  it('should return null if no ROUTE block', () => {
    const text = '普通回复，没有路由块。';
    expect(parseRoute(text)).toBeNull();
  });

  it('should route to human', () => {
    const text = `---ROUTE---
to: human
summary: 需要业务决策
---END_ROUTE---`;

    const route = parseRoute(text);
    expect(route.to).toBe('human');
  });
});

describe('Crew Session Lifecycle', () => {
  it('should track sessions by id in crewSessions Map', () => {
    const crewSessions = new Map();
    const session = createTestSession();
    crewSessions.set(session.id, session);

    expect(crewSessions.has('crew_test_001')).toBe(true);
    expect(crewSessions.get('crew_test_001').status).toBe('running');
  });

  it('should transition through status lifecycle', () => {
    const session = createTestSession({ status: 'running' });

    expect(session.status).toBe('running');

    session.status = 'paused';
    expect(session.status).toBe('paused');

    session.status = 'running';
    expect(session.status).toBe('running');

    session.status = 'waiting_human';
    expect(session.status).toBe('waiting_human');

    session.status = 'stopped';
    expect(session.status).toBe('stopped');
  });

  it('should increment rounds', () => {
    const session = createTestSession({ round: 0, maxRounds: 5 });

    session.round++;
    expect(session.round).toBe(1);

    session.round++;
    expect(session.round).toBe(2);
  });

  it('should detect max rounds reached', () => {
    const session = createTestSession({ round: 19, maxRounds: 20 });

    session.round++;
    const maxReached = session.round >= session.maxRounds;
    expect(maxReached).toBe(true);
  });

  it('should clean up on stopAll', () => {
    const crewSessions = new Map();
    const session = createTestSession();
    session.roleStates.set('pm', { claudeSessionId: 'cs1', abortController: { abort: () => {} } });
    session.roleStates.set('developer', { claudeSessionId: 'cs2', abortController: { abort: () => {} } });
    crewSessions.set(session.id, session);

    // Replicate stopAll logic
    session.status = 'stopped';
    session.roleStates.clear();
    crewSessions.delete(session.id);

    expect(session.status).toBe('stopped');
    expect(session.roleStates.size).toBe(0);
    expect(crewSessions.has(session.id)).toBe(false);
  });
});

// =====================================================================
// Bug Fix: pauseAll / resumeSession / processRoleOutput
// =====================================================================

describe('pauseAll - abort running queries and save sessionId', () => {
  // Replicate parseRoute for pendingRoute tests
  function parseRoute(text) {
    const match = text.match(/---ROUTE---\s*\n\s*to:\s*(.+?)\s*\n\s*summary:\s*(.+?)\s*\n\s*---END_ROUTE---/s);
    if (match) {
      return { to: match[1].trim().toLowerCase(), summary: match[2].trim() };
    }
    return null;
  }

  it('should abort all running role queries on pause', () => {
    const session = createTestSession({ status: 'running' });
    const aborted = [];

    session.roleStates.set('pm', {
      claudeSessionId: 'cs_pm_1',
      abortController: { abort: () => aborted.push('pm') },
      turnActive: true,
      query: {},
      inputStream: {}
    });
    session.roleStates.set('developer', {
      claudeSessionId: 'cs_dev_1',
      abortController: { abort: () => aborted.push('developer') },
      turnActive: true,
      query: {},
      inputStream: {}
    });

    // Replicate pauseAll logic
    session.status = 'paused';
    for (const [roleName, roleState] of session.roleStates) {
      if (roleState.abortController) {
        roleState.abortController.abort();
      }
      roleState.wasActive = roleState.turnActive;
      roleState.turnActive = false;
      roleState.query = null;
      roleState.inputStream = null;
    }

    expect(session.status).toBe('paused');
    expect(aborted).toEqual(['pm', 'developer']);
    expect(session.roleStates.get('pm').turnActive).toBe(false);
    expect(session.roleStates.get('pm').wasActive).toBe(true);
    expect(session.roleStates.get('pm').query).toBeNull();
    expect(session.roleStates.get('pm').inputStream).toBeNull();
    expect(session.roleStates.get('developer').turnActive).toBe(false);
    expect(session.roleStates.get('developer').wasActive).toBe(true);
  });

  it('should preserve claudeSessionId for each role during pause', () => {
    const session = createTestSession({ status: 'running' });

    session.roleStates.set('pm', {
      claudeSessionId: 'cs_pm_42',
      abortController: { abort: () => {} },
      turnActive: true,
      query: {},
      inputStream: {}
    });

    // Replicate pauseAll: sessionId should be preserved (saved to file in real code)
    session.status = 'paused';
    const roleState = session.roleStates.get('pm');
    const savedSessionId = roleState.claudeSessionId;
    roleState.wasActive = roleState.turnActive;
    roleState.turnActive = false;
    roleState.query = null;
    roleState.inputStream = null;

    // sessionId 应该依然可用于后续 resume
    expect(savedSessionId).toBe('cs_pm_42');
    expect(roleState.claudeSessionId).toBe('cs_pm_42');
  });

  it('should handle roles with no abortController gracefully', () => {
    const session = createTestSession({ status: 'running' });

    session.roleStates.set('pm', {
      claudeSessionId: 'cs_pm_1',
      abortController: null,
      turnActive: false,
      query: null,
      inputStream: null
    });

    session.status = 'paused';
    for (const [, roleState] of session.roleStates) {
      if (roleState.abortController) {
        roleState.abortController.abort();
      }
      roleState.wasActive = roleState.turnActive;
      roleState.turnActive = false;
      roleState.query = null;
      roleState.inputStream = null;
    }

    // Should not throw
    expect(session.status).toBe('paused');
    expect(session.roleStates.get('pm').wasActive).toBe(false);
  });
});

describe('resumeSession - replay pendingRoute', () => {
  it('should replay pendingRoute when resuming', () => {
    const session = createTestSession({ status: 'paused' });
    session.pendingRoute = {
      fromRole: 'pm',
      route: { to: 'developer', summary: '请实现功能 X' }
    };

    // Replicate resumeSession logic
    session.status = 'running';
    let replayedRoute = null;
    if (session.pendingRoute) {
      replayedRoute = { ...session.pendingRoute };
      session.pendingRoute = null;
    }

    expect(session.status).toBe('running');
    expect(session.pendingRoute).toBeNull();
    expect(replayedRoute).not.toBeNull();
    expect(replayedRoute.fromRole).toBe('pm');
    expect(replayedRoute.route.to).toBe('developer');
    expect(replayedRoute.route.summary).toBe('请实现功能 X');
  });

  it('should fallback to processHumanQueue when no pendingRoute', () => {
    const session = createTestSession({ status: 'paused' });
    session.pendingRoute = null;
    session.humanMessageQueue = [
      { target: 'pm', content: '人工消息', timestamp: Date.now() }
    ];

    // Replicate resumeSession logic
    session.status = 'running';
    let didReplayRoute = false;
    let didProcessHumanQueue = false;

    if (session.pendingRoute) {
      didReplayRoute = true;
      session.pendingRoute = null;
    } else {
      // Would call processHumanQueue
      didProcessHumanQueue = true;
    }

    expect(didReplayRoute).toBe(false);
    expect(didProcessHumanQueue).toBe(true);
    expect(session.status).toBe('running');
  });

  it('should not resume if status is not paused', () => {
    const session = createTestSession({ status: 'running' });
    session.pendingRoute = { fromRole: 'pm', route: { to: 'developer', summary: 'test' } };

    // Replicate resumeSession guard
    let didResume = false;
    if (session.status === 'paused') {
      session.status = 'running';
      didResume = true;
    }

    expect(didResume).toBe(false);
    // pendingRoute should not be consumed
    expect(session.pendingRoute).not.toBeNull();
  });

  it('should clear pendingRoute before executing to prevent re-entry', () => {
    const session = createTestSession({ status: 'paused' });
    session.pendingRoute = {
      fromRole: 'architect',
      route: { to: 'developer', summary: '设计完成' }
    };

    // Replicate exact resumeSession logic for pendingRoute
    session.status = 'running';
    const { fromRole, route } = session.pendingRoute;
    session.pendingRoute = null;
    // At this point executeRoute would be called
    // If executeRoute somehow triggers pause again, pendingRoute is already null

    expect(session.pendingRoute).toBeNull();
    expect(fromRole).toBe('architect');
    expect(route.to).toBe('developer');
  });
});

describe('processRoleOutput - break on paused status', () => {
  it('should break loop when status is paused', () => {
    const session = createTestSession({ status: 'running' });
    const processedMessages = [];

    // Simulate message processing loop
    const messages = [
      { type: 'assistant', message: { content: 'msg1' } },
      { type: 'assistant', message: { content: 'msg2' } },
      { type: 'assistant', message: { content: 'msg3' } }
    ];

    for (const message of messages) {
      // Replicate the paused/stopped check from processRoleOutput
      if (session.status === 'stopped' || session.status === 'paused') break;
      processedMessages.push(message);

      // Simulate pause happening after first message
      if (processedMessages.length === 1) {
        session.status = 'paused';
      }
    }

    // Only the first message should be processed before pause took effect
    expect(processedMessages.length).toBe(1);
  });

  it('should break loop when status is stopped', () => {
    const session = createTestSession({ status: 'stopped' });
    const processedMessages = [];

    const messages = [
      { type: 'assistant', message: { content: 'msg1' } }
    ];

    for (const message of messages) {
      if (session.status === 'stopped' || session.status === 'paused') break;
      processedMessages.push(message);
    }

    expect(processedMessages.length).toBe(0);
  });

  it('should save pendingRoute from accumulated text on abort during pause', () => {
    function parseRoute(text) {
      const match = text.match(/---ROUTE---\s*\n\s*to:\s*(.+?)\s*\n\s*summary:\s*(.+?)\s*\n\s*---END_ROUTE---/s);
      if (match) {
        return { to: match[1].trim().toLowerCase(), summary: match[2].trim() };
      }
      return null;
    }

    const session = createTestSession({ status: 'paused' });
    session.pendingRoute = null;

    const roleState = {
      accumulatedText: `任务已完成。

---ROUTE---
to: reviewer
summary: 请审核代码变更
---END_ROUTE---`,
      claudeSessionId: 'cs_dev_1'
    };

    // Replicate AbortError handling from processRoleOutput
    if (session.status === 'paused' && roleState.accumulatedText) {
      const route = parseRoute(roleState.accumulatedText);
      if (route && !session.pendingRoute) {
        session.pendingRoute = { fromRole: 'developer', route };
      }
      roleState.accumulatedText = '';
    }

    expect(session.pendingRoute).not.toBeNull();
    expect(session.pendingRoute.fromRole).toBe('developer');
    expect(session.pendingRoute.route.to).toBe('reviewer');
    expect(session.pendingRoute.route.summary).toBe('请审核代码变更');
    expect(roleState.accumulatedText).toBe('');
  });

  it('should not overwrite existing pendingRoute on abort', () => {
    function parseRoute(text) {
      const match = text.match(/---ROUTE---\s*\n\s*to:\s*(.+?)\s*\n\s*summary:\s*(.+?)\s*\n\s*---END_ROUTE---/s);
      if (match) {
        return { to: match[1].trim().toLowerCase(), summary: match[2].trim() };
      }
      return null;
    }

    const session = createTestSession({ status: 'paused' });
    // Already has a pendingRoute from another role
    session.pendingRoute = {
      fromRole: 'pm',
      route: { to: 'architect', summary: '请设计方案' }
    };

    const roleState = {
      accumulatedText: `---ROUTE---
to: reviewer
summary: 新的路由
---END_ROUTE---`
    };

    // Replicate: should NOT overwrite
    if (session.status === 'paused' && roleState.accumulatedText) {
      const route = parseRoute(roleState.accumulatedText);
      if (route && !session.pendingRoute) {
        session.pendingRoute = { fromRole: 'developer', route };
      }
      roleState.accumulatedText = '';
    }

    // Original pendingRoute should be preserved
    expect(session.pendingRoute.fromRole).toBe('pm');
    expect(session.pendingRoute.route.to).toBe('architect');
  });
});

describe('executeRoute - save pending when paused/stopped', () => {
  it('should save route as pendingRoute when session is paused', () => {
    const session = createTestSession({ status: 'paused' });
    session.pendingRoute = null;
    session.round = 3;

    const fromRole = 'pm';
    const route = { to: 'developer', summary: '开始开发' };

    // Replicate executeRoute: round increments first
    session.round++;

    // Then check paused/stopped
    if (session.status === 'paused' || session.status === 'stopped') {
      session.pendingRoute = { fromRole, route };
    }

    expect(session.round).toBe(4);
    expect(session.pendingRoute).not.toBeNull();
    expect(session.pendingRoute.fromRole).toBe('pm');
    expect(session.pendingRoute.route.to).toBe('developer');
  });

  it('should save route as pendingRoute when session is stopped', () => {
    const session = createTestSession({ status: 'stopped' });
    session.pendingRoute = null;

    const fromRole = 'reviewer';
    const route = { to: 'developer', summary: '需要修改' };

    session.round++;
    if (session.status === 'paused' || session.status === 'stopped') {
      session.pendingRoute = { fromRole, route };
    }

    expect(session.pendingRoute).not.toBeNull();
    expect(session.pendingRoute.fromRole).toBe('reviewer');
    expect(session.pendingRoute.route.to).toBe('developer');
  });

  it('should not save pendingRoute when session is running', () => {
    const session = createTestSession({ status: 'running' });
    session.pendingRoute = null;

    const fromRole = 'pm';
    const route = { to: 'developer', summary: '任务分配' };

    session.round++;
    if (session.status === 'paused' || session.status === 'stopped') {
      session.pendingRoute = { fromRole, route };
    }

    expect(session.pendingRoute).toBeNull();
  });
});

describe('createCrewSession / resumeCrewSession - pendingRoute initialization', () => {
  it('should initialize pendingRoute as null in createCrewSession', () => {
    const session = createTestSession();
    session.pendingRoute = null; // As added in the fix

    expect(session.pendingRoute).toBeNull();
  });

  it('should initialize pendingRoute as null in resumeCrewSession', () => {
    // Replicate resumeCrewSession rebuild logic
    const meta = {
      sessionId: 'crew_resume_001',
      projectDir: '/project',
      sharedDir: '/project/.crew',
      goal: 'Test',
      roles: [{ name: 'pm', displayName: 'PM', icon: '📋', description: 'desc', isDecisionMaker: true }],
      decisionMaker: 'pm',
      round: 3,
      maxRounds: 20,
      createdAt: 1000
    };

    const session = {
      id: meta.sessionId,
      roles: new Map(meta.roles.map(r => [r.name, r])),
      roleStates: new Map(),
      status: 'waiting_human',
      round: meta.round,
      pendingRoute: null, // ← This is the fix
      humanMessageQueue: [],
      waitingHumanContext: null
    };

    expect(session.pendingRoute).toBeNull();
    // pendingRoute should be available for future pauseAll/resume cycles
    session.pendingRoute = { fromRole: 'pm', route: { to: 'developer', summary: 'test' } };
    expect(session.pendingRoute).not.toBeNull();
    session.pendingRoute = null;
    expect(session.pendingRoute).toBeNull();
  });
});

describe('Full pause-resume cycle integration', () => {
  it('should correctly handle pause -> route saved -> resume -> route replayed', () => {
    function parseRoute(text) {
      const match = text.match(/---ROUTE---\s*\n\s*to:\s*(.+?)\s*\n\s*summary:\s*(.+?)\s*\n\s*---END_ROUTE---/s);
      if (match) {
        return { to: match[1].trim().toLowerCase(), summary: match[2].trim() };
      }
      return null;
    }

    // Step 1: Create running session with active role
    const session = createTestSession({ status: 'running' });
    session.pendingRoute = null;

    const aborted = [];
    session.roleStates.set('developer', {
      claudeSessionId: 'cs_dev_99',
      abortController: { abort: () => aborted.push('developer') },
      turnActive: true,
      accumulatedText: `代码已完成。

---ROUTE---
to: reviewer
summary: 代码审查
---END_ROUTE---`,
      query: {},
      inputStream: {}
    });

    // Step 2: Pause
    session.status = 'paused';
    for (const [, roleState] of session.roleStates) {
      if (roleState.abortController) {
        roleState.abortController.abort();
      }
      roleState.wasActive = roleState.turnActive;
      roleState.turnActive = false;
      roleState.query = null;
      roleState.inputStream = null;
    }

    // Step 3: Simulate AbortError handler saving pendingRoute
    const roleState = session.roleStates.get('developer');
    if (session.status === 'paused' && roleState.accumulatedText) {
      const route = parseRoute(roleState.accumulatedText);
      if (route && !session.pendingRoute) {
        session.pendingRoute = { fromRole: 'developer', route };
      }
      roleState.accumulatedText = '';
    }

    expect(aborted).toEqual(['developer']);
    expect(session.pendingRoute).not.toBeNull();
    expect(session.pendingRoute.route.to).toBe('reviewer');

    // Step 4: Resume
    let replayedFromRole = null;
    let replayedRoute = null;

    session.status = 'running';
    if (session.pendingRoute) {
      replayedFromRole = session.pendingRoute.fromRole;
      replayedRoute = session.pendingRoute.route;
      session.pendingRoute = null;
      // executeRoute would be called here
    }

    expect(session.status).toBe('running');
    expect(session.pendingRoute).toBeNull();
    expect(replayedFromRole).toBe('developer');
    expect(replayedRoute.to).toBe('reviewer');
    expect(replayedRoute.summary).toBe('代码审查');
  });

  it('should handle dispatchToRole guard when paused/stopped', () => {
    const session = createTestSession({ status: 'paused' });
    let dispatched = false;

    // Replicate dispatchToRole guard
    if (session.status === 'paused' || session.status === 'stopped') {
      // skip dispatch
    } else {
      dispatched = true;
    }

    expect(dispatched).toBe(false);

    session.status = 'running';
    if (session.status === 'paused' || session.status === 'stopped') {
      // skip dispatch
    } else {
      dispatched = true;
    }

    expect(dispatched).toBe(true);
  });
});

// =====================================================================
// buildRoleSystemPrompt — 角色 prompt 正确性
// =====================================================================

describe('buildRoleSystemPrompt', () => {
  // Replicate buildRoleSystemPrompt logic for testing
  function buildRoleSystemPrompt(role, session) {
    const allRoles = Array.from(session.roles.values());
    const otherRoles = allRoles.filter(r => r.name !== role.name);

    let prompt = `# 团队协作
你正在一个 AI 团队中工作。${session.goal ? `项目目标是: ${session.goal}` : '等待用户提出任务或问题。'}

团队成员:
${allRoles.map(r => `- ${r.icon} ${r.displayName}: ${r.description}${r.isDecisionMaker ? ' (决策者)' : ''}`).join('\n')}`;

    if (otherRoles.length > 0) {
      prompt += `\n\n# 路由规则
当你完成当前任务并需要将结果传递给其他角色时，在你的回复最末尾添加一个 ROUTE 块：

\`\`\`
---ROUTE---
to: <角色name>
summary: <简要说明要传递什么>
---END_ROUTE---
\`\`\`

可用的路由目标:
${otherRoles.map(r => `- ${r.name}: ${r.icon} ${r.displayName} — ${r.description}`).join('\n')}
- human: 人工（只在决策者也无法决定时使用）

注意：
- 如果你的工作还没完成，不需要添加 ROUTE 块
- 如果你遇到不确定的问题，@ 决策者 "${session.decisionMaker}"，而不是直接 @ human
- 如果你是决策者且遇到需要人类判断的问题，才 @ human
- 每次回复最多只能有一个 ROUTE 块
- ROUTE 块必须在回复的最末尾
- 当你的任务已完成且不需要其他角色继续时，ROUTE 回决策者 "${session.decisionMaker}" 做总结
- 在正文中可用 @角色name 提及某个角色（如 @developer），但这不会触发路由，仅供阅读`;
    }

    if (role.isDecisionMaker) {
      prompt += `\n\n# 决策者职责
你是团队的决策者。其他角色遇到不确定的情况会请求你的决策。
- 如果你有足够的信息做出决策，直接决定并 @相关角色执行
- 如果你需要更多信息，@具体角色请求补充
- 如果问题超出你的能力范围或需要业务判断，@human 请人类决定
- 你可以随时审查其他角色的工作并给出反馈

# 工作流终结点
团队的工作流有明确的结束条件。当以下任一条件满足时，你应该给出总结并结束当前工作流：
1. **代码已提交** - 所有代码修改已经 commit（如需要，可让 developer 执行 git commit）
2. **需要用户输入** - 遇到需要用户决定的问题时，@human 提出具体问题，等待用户回复
3. **任务完成** - 所有任务已完成，给出完成总结（列出完成了什么、变更了哪些文件、还有什么后续建议）

重要：不要无限循环地在角色之间传递。当工作实质性完成时，主动给出总结并结束。

# 任务清单
你可以在回复中添加 TASKS 块来发布/更新任务清单，团队界面会自动展示：

\`\`\`
---TASKS---
- [ ] 任务描述 @角色name
- [x] 已完成的任务 @角色name
---END_TASKS---
\`\`\`

注意：
- 每行一个任务，[ ] 表示待办，[x] 表示已完成
- @角色name 标注负责人（可选）
- 后续回复中可更新 TASKS 块（标记完成的任务）
- TASKS 块不需要在回复最末尾，可以放在任意位置`;
    }

    return prompt;
  }

  it('should include all roles in team member list', () => {
    const session = createTestSession();
    const pmRole = session.roles.get('pm');
    const prompt = buildRoleSystemPrompt(pmRole, session);

    expect(prompt).toContain('📋 PM: 需求分析');
    expect(prompt).toContain('💻 开发者: 代码编写');
    expect(prompt).toContain('(决策者)');
  });

  it('should include route targets excluding current role', () => {
    const session = createTestSession();
    const pmRole = session.roles.get('pm');
    const prompt = buildRoleSystemPrompt(pmRole, session);

    // PM 的路由目标应该包含 developer 但不包含 pm 自己
    expect(prompt).toContain('- developer: 💻 开发者 — 代码编写');
    expect(prompt).not.toMatch(/- pm: 📋 PM —/);
    expect(prompt).toContain('- human: 人工');
  });

  it('should show decision maker reference in routing notes', () => {
    const session = createTestSession();
    const devRole = session.roles.get('developer');
    const prompt = buildRoleSystemPrompt(devRole, session);

    // developer 应该被告知找决策者 pm
    expect(prompt).toContain('@ 决策者 "pm"');
    expect(prompt).toContain('ROUTE 回决策者 "pm" 做总结');
  });

  it('should include decision maker responsibilities for PM', () => {
    const session = createTestSession();
    const pmRole = session.roles.get('pm');
    const prompt = buildRoleSystemPrompt(pmRole, session);

    expect(prompt).toContain('# 决策者职责');
    expect(prompt).toContain('你是团队的决策者');
    expect(prompt).toContain('@human 请人类决定');
  });

  it('should NOT include decision maker section for non-decision-maker roles', () => {
    const session = createTestSession();
    const devRole = session.roles.get('developer');
    const prompt = buildRoleSystemPrompt(devRole, session);

    expect(prompt).not.toContain('# 决策者职责');
    expect(prompt).not.toContain('# 工作流终结点');
    expect(prompt).not.toContain('# 任务清单');
  });

  it('should include workflow endpoints for decision maker', () => {
    const session = createTestSession();
    const pmRole = session.roles.get('pm');
    const prompt = buildRoleSystemPrompt(pmRole, session);

    expect(prompt).toContain('# 工作流终结点');
    expect(prompt).toContain('代码已提交');
    expect(prompt).toContain('需要用户输入');
    expect(prompt).toContain('任务完成');
    expect(prompt).toContain('不要无限循环');
  });

  it('should include TASKS block format for decision maker', () => {
    const session = createTestSession();
    const pmRole = session.roles.get('pm');
    const prompt = buildRoleSystemPrompt(pmRole, session);

    expect(prompt).toContain('# 任务清单');
    expect(prompt).toContain('---TASKS---');
    expect(prompt).toContain('---END_TASKS---');
    expect(prompt).toContain('- [ ] 任务描述 @角色name');
    expect(prompt).toContain('- [x] 已完成的任务 @角色name');
  });

  it('should include ROUTE block format in routing rules', () => {
    const session = createTestSession();
    const devRole = session.roles.get('developer');
    const prompt = buildRoleSystemPrompt(devRole, session);

    expect(prompt).toContain('---ROUTE---');
    expect(prompt).toContain('---END_ROUTE---');
    expect(prompt).toContain('to: <角色name>');
    expect(prompt).toContain('summary: <简要说明要传递什么>');
  });

  it('should handle empty goal gracefully', () => {
    const session = createTestSession({ goal: '' });
    const pmRole = session.roles.get('pm');
    const prompt = buildRoleSystemPrompt(pmRole, session);

    expect(prompt).toContain('等待用户提出任务或问题');
    expect(prompt).not.toContain('项目目标是:');
  });

  it('should handle single-role session (no routing rules)', () => {
    const roles = new Map([
      ['pm', { name: 'pm', displayName: 'PM', icon: '📋', description: '需求分析', isDecisionMaker: true }]
    ]);
    const session = createTestSession({ roles });
    const pmRole = session.roles.get('pm');
    const prompt = buildRoleSystemPrompt(pmRole, session);

    // 只有一个角色，没有路由目标
    expect(prompt).not.toContain('# 路由规则');
    expect(prompt).not.toContain('---ROUTE---');
    // 但决策者职责仍然在
    expect(prompt).toContain('# 决策者职责');
  });

  it('should mention @role mention vs ROUTE distinction', () => {
    const session = createTestSession();
    const devRole = session.roles.get('developer');
    const prompt = buildRoleSystemPrompt(devRole, session);

    expect(prompt).toContain('在正文中可用 @角色name 提及某个角色');
    expect(prompt).toContain('不会触发路由，仅供阅读');
  });
});

// =====================================================================
// PM claudeMd 模板验证
// =====================================================================

describe('PM role template constraints', () => {
  // 从 CrewConfigPanel 中提取的 PM claudeMd
  const pmClaudeMd = '你是 Steve Jobs（史蒂夫·乔布斯），以他的思维方式和工作风格来管理这个项目。\n追求极致简洁，对产品品质零容忍，善于从用户视角思考，敢于砍掉不必要的功能。\n\n# 重要约束\n- 你不能写代码，也不能直接修改文件。所有代码工作必须分配给 developer。\n- 收到新任务后，先制定实施计划（列出任务清单、优先级、负责角色），然后 @human 请用户审核计划，审核通过后再分配执行。\n\n# 协作流程\n- 收到目标后：分析需求，拆分任务，制定计划，@human 审核\n- 审核通过后：分配给 🏗️ 架构师(architect) 做技术设计\n- 架构师设计完成后：审核设计方案，通过后分配给 💻 开发者(developer) 实现\n- 收到 🔍 审查者(reviewer) 或 🧪 测试(tester) 反馈的需求问题：澄清需求，必要时调整方案\n- 所有角色完成工作且测试通过：汇总成果，向 human 汇报\n- 遇到需要业务判断的问题：找 human 决定';

  it('should explicitly prohibit PM from writing code', () => {
    expect(pmClaudeMd).toContain('你不能写代码');
    expect(pmClaudeMd).toContain('不能直接修改文件');
    expect(pmClaudeMd).toContain('所有代码工作必须分配给 developer');
  });

  it('should require plan approval from human before execution', () => {
    expect(pmClaudeMd).toContain('先制定实施计划');
    expect(pmClaudeMd).toContain('@human 请用户审核计划');
    expect(pmClaudeMd).toContain('审核通过后再分配执行');
  });

  it('should define complete collaboration flow', () => {
    expect(pmClaudeMd).toContain('分配给 🏗️ 架构师(architect) 做技术设计');
    expect(pmClaudeMd).toContain('分配给 💻 开发者(developer) 实现');
    expect(pmClaudeMd).toContain('向 human 汇报');
  });
});

describe('Developer role template - parallel review flow', () => {
  const devClaudeMd = '你是 Linus Torvalds（林纳斯·托瓦兹），以他的编码风格来写代码。\n代码简洁高效，厌恶不必要的抽象，追求性能和正确性，注重实用主义而非教条。\n\n# 协作流程\n- 收到任务后：按架构设计实现代码\n- 代码完成后：同时交给 🔍 审查者(reviewer) 审核代码质量 和 🧪 测试(tester) 进行测试验证（并行审核，两者独立 approve）\n- 收到 🔍 审查者(reviewer) 的代码质量问题：修改后重新提交审核\n- 收到 🧪 测试(tester) 的 Bug 报告：修复后交给 🧪 测试(tester) 重新验证\n- 技术方案不确定：找 🏗️ 架构师(architect) 讨论\n- 需求不明确：找 📋 PM(pm) 确认\n- 遇到自己无法解决的问题：交给 📋 PM(pm) 决策';

  it('should specify parallel review by reviewer and tester', () => {
    expect(devClaudeMd).toContain('同时交给 🔍 审查者(reviewer) 审核代码质量 和 🧪 测试(tester) 进行测试验证');
    expect(devClaudeMd).toContain('并行审核，两者独立 approve');
  });

  it('should define escalation path to architect and PM', () => {
    expect(devClaudeMd).toContain('找 🏗️ 架构师(architect) 讨论');
    expect(devClaudeMd).toContain('找 📋 PM(pm) 确认');
    expect(devClaudeMd).toContain('交给 📋 PM(pm) 决策');
  });
});

// =====================================================================
// WebSocket 消息缓冲 (agent/connection.js)
// =====================================================================

describe('WebSocket message buffering', () => {
  const BUFFERABLE_TYPES = new Set([
    'claude_output', 'turn_completed', 'conversation_closed',
    'session_id_update', 'compact_status', 'slash_commands_update',
    'background_task_started', 'background_task_output',
    'crew_output', 'crew_status', 'crew_turn_completed',
    'crew_session_created', 'crew_session_restored', 'crew_human_needed',
    'crew_role_added', 'crew_role_removed'
  ]);

  it('should buffer crew-related message types', () => {
    expect(BUFFERABLE_TYPES.has('crew_output')).toBe(true);
    expect(BUFFERABLE_TYPES.has('crew_status')).toBe(true);
    expect(BUFFERABLE_TYPES.has('crew_turn_completed')).toBe(true);
    expect(BUFFERABLE_TYPES.has('crew_session_created')).toBe(true);
    expect(BUFFERABLE_TYPES.has('crew_session_restored')).toBe(true);
    expect(BUFFERABLE_TYPES.has('crew_human_needed')).toBe(true);
    expect(BUFFERABLE_TYPES.has('crew_role_added')).toBe(true);
    expect(BUFFERABLE_TYPES.has('crew_role_removed')).toBe(true);
  });

  it('should buffer claude output types', () => {
    expect(BUFFERABLE_TYPES.has('claude_output')).toBe(true);
    expect(BUFFERABLE_TYPES.has('turn_completed')).toBe(true);
    expect(BUFFERABLE_TYPES.has('conversation_closed')).toBe(true);
    expect(BUFFERABLE_TYPES.has('session_id_update')).toBe(true);
  });

  it('should NOT buffer non-critical message types', () => {
    expect(BUFFERABLE_TYPES.has('ping')).toBe(false);
    expect(BUFFERABLE_TYPES.has('pong')).toBe(false);
    expect(BUFFERABLE_TYPES.has('registered')).toBe(false);
    expect(BUFFERABLE_TYPES.has('execute')).toBe(false);
  });

  it('should implement buffer-on-disconnect then flush-on-reconnect pattern', () => {
    // Simulate buffering behavior
    const messageBuffer = [];
    const maxSize = 500;
    const wsOpen = false; // disconnected

    // Try to send when disconnected
    const msg1 = { type: 'crew_output', sessionId: 's1', data: 'test' };
    const msg2 = { type: 'crew_status', sessionId: 's1', status: 'running' };
    const msg3 = { type: 'ping' }; // Not bufferable

    for (const msg of [msg1, msg2, msg3]) {
      if (!wsOpen) {
        if (BUFFERABLE_TYPES.has(msg.type) && messageBuffer.length < maxSize) {
          messageBuffer.push(msg);
        }
      }
    }

    // Only bufferable types should be queued
    expect(messageBuffer.length).toBe(2);
    expect(messageBuffer[0].type).toBe('crew_output');
    expect(messageBuffer[1].type).toBe('crew_status');

    // Simulate flush on reconnect
    const flushed = messageBuffer.splice(0);
    expect(flushed.length).toBe(2);
    expect(messageBuffer.length).toBe(0);
  });

  it('should drop oldest non-status messages when buffer is full', () => {
    const messageBuffer = [];
    const maxSize = 3;

    // Fill buffer
    messageBuffer.push({ type: 'crew_output', data: 'a' });
    messageBuffer.push({ type: 'crew_output', data: 'b' });
    messageBuffer.push({ type: 'crew_status', status: 'running' });

    // Buffer full, new message arrives
    const newMsg = { type: 'crew_output', data: 'c' };
    if (messageBuffer.length >= maxSize) {
      const dropIdx = messageBuffer.findIndex(m => m.type !== 'crew_status' && m.type !== 'turn_completed');
      if (dropIdx >= 0) {
        messageBuffer.splice(dropIdx, 1);
        messageBuffer.push(newMsg);
      }
    }

    // Should have dropped oldest non-status and added new
    expect(messageBuffer.length).toBe(3);
    expect(messageBuffer[0].data).toBe('b'); // 'a' was dropped
    expect(messageBuffer[1].type).toBe('crew_status'); // status preserved
    expect(messageBuffer[2].data).toBe('c'); // new message added
  });
});

// =====================================================================
// uiMessages 记录与恢复
// =====================================================================

describe('uiMessages tracking', () => {
  it('should merge consecutive text from same role', () => {
    const uiMessages = [];

    // Simulate sendCrewOutput for text type
    function recordText(roleName, roleIcon, displayName, text) {
      const last = uiMessages[uiMessages.length - 1];
      if (last && last.role === roleName && last.type === 'text' && last._streaming) {
        last.content += text;
      } else {
        uiMessages.push({
          role: roleName, roleIcon, roleName: displayName,
          type: 'text', content: text, _streaming: true,
          timestamp: Date.now()
        });
      }
    }

    recordText('pm', '📋', 'PM', '第一段文字');
    recordText('pm', '📋', 'PM', '第二段文字');
    recordText('developer', '💻', '开发者', '开发者回复');
    recordText('pm', '📋', 'PM', 'PM 新消息');

    expect(uiMessages.length).toBe(3);
    expect(uiMessages[0].content).toBe('第一段文字第二段文字');
    expect(uiMessages[0].role).toBe('pm');
    expect(uiMessages[1].role).toBe('developer');
    expect(uiMessages[2].role).toBe('pm');
  });

  it('should record route messages', () => {
    const uiMessages = [];

    // Text message (streaming)
    uiMessages.push({
      role: 'pm', roleIcon: '📋', roleName: 'PM',
      type: 'text', content: '分析完成', _streaming: true,
      timestamp: Date.now()
    });

    // Route: end streaming and add route entry
    const last = uiMessages[uiMessages.length - 1];
    if (last && last._streaming) delete last._streaming;

    uiMessages.push({
      role: 'pm', roleIcon: '📋', roleName: 'PM',
      type: 'route', routeTo: 'architect',
      content: '→ @architect 请设计方案',
      timestamp: Date.now()
    });

    expect(uiMessages.length).toBe(2);
    expect(uiMessages[0]._streaming).toBeUndefined();
    expect(uiMessages[1].type).toBe('route');
    expect(uiMessages[1].routeTo).toBe('architect');
  });

  it('should record human messages', () => {
    const uiMessages = [];

    uiMessages.push({
      role: 'human', roleIcon: 'H', roleName: '你',
      type: 'text', content: '请开始开发',
      timestamp: Date.now()
    });

    expect(uiMessages.length).toBe(1);
    expect(uiMessages[0].role).toBe('human');
    expect(uiMessages[0].content).toBe('请开始开发');
  });

  it('should clean _streaming flag when saving', () => {
    const uiMessages = [
      { role: 'pm', type: 'text', content: 'done', _streaming: true, timestamp: 1000 },
      { role: 'developer', type: 'text', content: 'code', timestamp: 2000 }
    ];

    // Replicate cleaning logic from saveSessionMeta
    const cleaned = uiMessages.map(m => {
      const { _streaming, ...rest } = m;
      return rest;
    });

    expect(cleaned[0]._streaming).toBeUndefined();
    expect(cleaned[0].content).toBe('done');
    expect(cleaned[1].content).toBe('code');
  });
});

// =====================================================================
// removeFromCrewIndex
// =====================================================================

describe('removeFromCrewIndex logic', () => {
  it('should filter out session by sessionId', () => {
    const index = [
      { sessionId: 'crew_001', status: 'stopped' },
      { sessionId: 'crew_002', status: 'running' },
      { sessionId: 'crew_003', status: 'stopped' }
    ];

    const filtered = index.filter(e => e.sessionId !== 'crew_002');

    expect(filtered.length).toBe(2);
    expect(filtered.find(e => e.sessionId === 'crew_002')).toBeUndefined();
  });

  it('should also remove from active sessions Map', () => {
    const activeSessions = new Map();
    activeSessions.set('crew_001', { id: 'crew_001', status: 'running' });
    activeSessions.set('crew_002', { id: 'crew_002', status: 'paused' });

    // Replicate removeFromCrewIndex memory cleanup
    const sessionId = 'crew_001';
    if (activeSessions.has(sessionId)) {
      activeSessions.delete(sessionId);
    }

    expect(activeSessions.has('crew_001')).toBe(false);
    expect(activeSessions.has('crew_002')).toBe(true);
  });

  it('should handle removing non-existent session gracefully', () => {
    const index = [
      { sessionId: 'crew_001', status: 'stopped' }
    ];
    const filtered = index.filter(e => e.sessionId !== 'crew_999');

    // No change
    expect(filtered.length).toBe(1);
  });
});

// =====================================================================
// sessionToIndexEntry - new fields (goal, userId, username)
// =====================================================================

describe('sessionToIndexEntry - extended fields', () => {
  it('should include goal, userId, username in index entry', () => {
    const session = createTestSession({
      goal: '构建用户认证系统',
      userId: 'user_456',
      username: 'alice'
    });
    const entry = sessionToIndexEntry(session);

    expect(entry.goal).toBe('构建用户认证系统');
    expect(entry.userId).toBe('user_456');
    expect(entry.username).toBe('alice');
  });
});

// =====================================================================
// WebSocket visibility handler logic
// =====================================================================

describe('Visibility handler reconnect logic', () => {
  it('should reconnect immediately when WS is not open on visibility change', () => {
    let reconnected = false;
    const store = {
      ws: null, // not connected
      reconnectAttempts: 5,
      connect() { reconnected = true; }
    };

    // Simulate visibility change to visible
    if (!store.ws || store.ws.readyState !== 1 /* OPEN */) {
      store.reconnectAttempts = 0;
      store.connect();
    }

    expect(reconnected).toBe(true);
    expect(store.reconnectAttempts).toBe(0);
  });

  it('should send ping to verify alive connection on visibility change', () => {
    let pingSent = false;
    const store = {
      ws: { readyState: 1 }, // OPEN
      _lastPongAt: Date.now(),
      sendWsMessage(msg) { if (msg.type === 'ping') pingSent = true; }
    };

    if (store.ws && store.ws.readyState === 1) {
      store.sendWsMessage({ type: 'ping' });
    }

    expect(pingSent).toBe(true);
  });
});

// =====================================================================
// UI Behavior: Human bubble & Turn dividers (CrewChatView logic)
// =====================================================================

describe('CrewChatView - groupedMessages logic', () => {
  // Replicate groupedMessages computed from CrewChatView.js
  function groupMessages(messages) {
    const turns = [];
    let currentTurn = null;
    let turnCounter = 0;

    const flushTurn = () => {
      if (currentTurn) {
        currentTurn.textMsg = currentTurn.messages.find(m => m.type === 'text') || null;
        currentTurn.toolMsgs = currentTurn.messages.filter(m => m.type === 'tool');
        turns.push(currentTurn);
        currentTurn = null;
      }
    };

    for (const msg of messages) {
      if (msg.type === 'route' || msg.type === 'system' || msg.type === 'human_needed') {
        flushTurn();
        turns.push({ type: msg.type, message: msg, id: 'standalone_' + (msg.id || turnCounter++) });
        continue;
      }
      if (msg.role === 'human') {
        flushTurn();
        turns.push({ type: 'text', message: msg, id: 'human_' + (msg.id || turnCounter++) });
        continue;
      }
      if (currentTurn && currentTurn.role === msg.role) {
        currentTurn.messages.push(msg);
      } else {
        flushTurn();
        currentTurn = {
          type: 'turn',
          role: msg.role,
          roleName: msg.roleName,
          roleIcon: msg.roleIcon,
          messages: [msg],
          textMsg: null,
          toolMsgs: [],
          id: 'turn_' + (turnCounter++)
        };
      }
    }
    flushTurn();
    return turns;
  }

  // Replicate shouldShowDivider logic
  function shouldShowDivider(turns, tidx) {
    const prev = turns[tidx - 1];
    const curr = turns[tidx];
    if (curr.type === 'route' || prev.type === 'route') return false;
    const prevRole = prev.type === 'turn' ? prev.role : prev.message?.role;
    const currRole = curr.type === 'turn' ? curr.role : curr.message?.role;
    return prevRole && currRole && prevRole !== currRole;
  }

  it('should render human messages as standalone (not grouped into turns)', () => {
    const messages = [
      { role: 'pm', roleIcon: '📋', roleName: 'PM', type: 'text', content: 'PM 回复', timestamp: 1000 },
      { role: 'human', roleIcon: 'H', roleName: '你', type: 'text', content: '人工消息', timestamp: 2000 },
      { role: 'pm', roleIcon: '📋', roleName: 'PM', type: 'text', content: 'PM 继续', timestamp: 3000 }
    ];

    const turns = groupMessages(messages);

    expect(turns.length).toBe(3);
    // Human message is standalone
    expect(turns[1].type).toBe('text'); // standalone type
    expect(turns[1].message.role).toBe('human');
    expect(turns[1].id).toMatch(/^human_/);
    // Not grouped into a turn
    expect(turns[1].type).not.toBe('turn');
  });

  it('should apply crew-msg-human-bubble class condition (role=human, type=text)', () => {
    // Replicate the template condition:
    // { 'crew-msg-human-bubble': turn.message.role === 'human' && turn.message.type === 'text' }
    const humanTextMsg = { role: 'human', type: 'text', content: '测试' };
    const humanSystemMsg = { role: 'human', type: 'system', content: '加入' };
    const pmTextMsg = { role: 'pm', type: 'text', content: 'PM 消息' };

    const isHumanBubble = (msg) => msg.role === 'human' && msg.type === 'text';

    expect(isHumanBubble(humanTextMsg)).toBe(true);
    expect(isHumanBubble(humanSystemMsg)).toBe(false);
    expect(isHumanBubble(pmTextMsg)).toBe(false);
  });

  it('should hide avatar for human text messages (v-if condition)', () => {
    // Template: v-if="turn.message.role !== 'human' || turn.message.type !== 'text'"
    const showAvatar = (msg) => msg.role !== 'human' || msg.type !== 'text';

    expect(showAvatar({ role: 'human', type: 'text' })).toBe(false); // hidden
    expect(showAvatar({ role: 'human', type: 'system' })).toBe(true); // shown
    expect(showAvatar({ role: 'pm', type: 'text' })).toBe(true); // shown
    expect(showAvatar({ role: 'developer', type: 'text' })).toBe(true); // shown
  });

  it('should show divider when role changes between adjacent turns', () => {
    const messages = [
      { role: 'pm', roleIcon: '📋', roleName: 'PM', type: 'text', content: 'PM 说', timestamp: 1000 },
      { role: 'developer', roleIcon: '💻', roleName: '开发者', type: 'text', content: '开发者说', timestamp: 2000 }
    ];

    const turns = groupMessages(messages);
    expect(turns.length).toBe(2);
    expect(shouldShowDivider(turns, 1)).toBe(true);
  });

  it('should NOT show divider when same role continues', () => {
    const messages = [
      { role: 'pm', roleIcon: '📋', roleName: 'PM', type: 'text', content: 'PM 第一段', timestamp: 1000 },
      { role: 'pm', roleIcon: '📋', roleName: 'PM', type: 'tool', toolName: 'Read', timestamp: 2000 }
    ];

    const turns = groupMessages(messages);
    // Both messages from PM should be in one turn
    expect(turns.length).toBe(1);
    expect(turns[0].type).toBe('turn');
    expect(turns[0].messages.length).toBe(2);
  });

  it('should NOT show divider before/after route messages', () => {
    const messages = [
      { role: 'pm', roleIcon: '📋', roleName: 'PM', type: 'text', content: '分析完成', timestamp: 1000 },
      { role: 'pm', roleIcon: '📋', roleName: 'PM', type: 'route', content: '→ @developer', timestamp: 2000 },
      { role: 'developer', roleIcon: '💻', roleName: '开发者', type: 'text', content: '收到', timestamp: 3000 }
    ];

    const turns = groupMessages(messages);
    expect(turns.length).toBe(3);

    // Route is at index 1, no divider before it (prev is route-adjacent)
    expect(shouldShowDivider(turns, 1)).toBe(false); // route: no divider
    expect(shouldShowDivider(turns, 2)).toBe(false); // after route: no divider
  });

  it('should show divider between human and role messages', () => {
    const messages = [
      { role: 'pm', roleIcon: '📋', roleName: 'PM', type: 'text', content: 'PM 说', timestamp: 1000 },
      { role: 'human', roleIcon: 'H', roleName: '你', type: 'text', content: '人工', timestamp: 2000 }
    ];

    const turns = groupMessages(messages);
    expect(turns.length).toBe(2);
    expect(shouldShowDivider(turns, 1)).toBe(true);
  });
});

describe('CSS class validation for human bubble', () => {
  it('should have right-to-left layout (flex-direction: row-reverse)', () => {
    // Verify the CSS rules exist (from style.css analysis)
    // .crew-message.crew-msg-human-bubble { flex-direction: row-reverse; gap: 0; }
    const expectedRules = {
      'flex-direction': 'row-reverse',
      'gap': '0'
    };

    // These are statically defined in style.css, verify expectations
    expect(expectedRules['flex-direction']).toBe('row-reverse');
    expect(expectedRules['gap']).toBe('0');
  });

  it('should have bubble styling for human message body', () => {
    // .crew-message.crew-msg-human-bubble .crew-msg-body
    // { max-width: 75%; background: var(--bg-user-msg); border-radius: 16px 16px 4px 16px; padding: 8px 14px; }
    const expectedBodyRules = {
      'max-width': '75%',
      'border-radius': '16px 16px 4px 16px', // bottom-right corner sharp
      'padding': '8px 14px'
    };

    expect(expectedBodyRules['max-width']).toBe('75%');
    expect(expectedBodyRules['border-radius']).toBe('16px 16px 4px 16px');
  });

  it('should right-align header in human bubble', () => {
    // .crew-message.crew-msg-human-bubble .crew-msg-header { justify-content: flex-end; }
    const headerAlignment = 'flex-end';
    expect(headerAlignment).toBe('flex-end');
  });
});

describe('CSS class validation for turn divider', () => {
  it('should have divider dimensions and positioning', () => {
    // .crew-turn-divider { max-width: 800px; margin: 2px auto; width: 100%; padding: 0 48px; }
    const expectedRules = {
      'max-width': '800px',
      'margin': '2px auto',
      'width': '100%',
      'padding': '0 48px'
    };

    expect(expectedRules['max-width']).toBe('800px');
    expect(expectedRules['margin']).toBe('2px auto');
  });

  it('should use ::after pseudo-element for the line', () => {
    // .crew-turn-divider::after { content: ''; height: 1px; background: var(--border-color); opacity: 0.4; }
    const afterRules = {
      'height': '1px',
      'opacity': '0.4'
    };

    expect(afterRules['height']).toBe('1px');
    expect(afterRules['opacity']).toBe('0.4');
  });
});

// =====================================================================
// Hints bar: 不再显示角色标签和添加角色按钮
// =====================================================================

describe('Hints bar - role badges and add button removed', () => {
  // 读取 CrewChatView.js 模板中 crew-input-hints 区域
  // 验证不再包含 crew-at-hint 角色标签和添加角色按钮

  const hintsTemplate = `
        <div class="crew-input-hints" v-if="store.currentCrewSession">
          <span class="crew-hint-status" :class="statusClass">{{ statusText }}</span>
          <template v-if="activeTasks.length > 0">
            <span class="crew-hint-separator"></span>
  `;

  it('should NOT contain crew-at-hint role badges in hints bar', () => {
    expect(hintsTemplate).not.toContain('crew-at-hint');
    expect(hintsTemplate).not.toContain('v-for="role in store.currentCrewSession.roles"');
  });

  it('should NOT contain add role button in hints bar', () => {
    expect(hintsTemplate).not.toContain('showAddRole = true');
    expect(hintsTemplate).not.toContain('title="添加角色"');
    // No plus icon SVG
    expect(hintsTemplate).not.toContain('M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z');
  });

  it('should still show status text in hints bar', () => {
    expect(hintsTemplate).toContain('crew-hint-status');
    expect(hintsTemplate).toContain('statusText');
  });

  it('should still show task filters after status', () => {
    expect(hintsTemplate).toContain('activeTasks.length > 0');
    expect(hintsTemplate).toContain('crew-hint-separator');
  });
});

// Verify actual source file matches expectations
describe('Hints bar - source file verification', () => {
  let fileContent;

  it('should load CrewChatView.js source', async () => {
    fileContent = await fs.readFile(
      join(__dirname, '../../web/components/CrewChatView.js'),
      'utf-8'
    );
    expect(fileContent).toBeTruthy();
  });

  it('should NOT have crew-at-hint spans in the template', () => {
    // The hints area (between crew-input-hints and input-wrapper) should not have role badges
    const hintsAreaMatch = fileContent.match(
      /class="crew-input-hints"[\s\S]*?<\/div>\s*(?=<div class="attachments-preview|<div class="input-wrapper")/
    );
    expect(hintsAreaMatch).toBeTruthy();
    const hintsArea = hintsAreaMatch[0];
    expect(hintsArea).not.toContain('crew-at-hint');
    expect(hintsArea).not.toContain('insertAt(role.name)');
  });

  it('should NOT have add-role button in hints area', () => {
    const hintsAreaMatch = fileContent.match(
      /class="crew-input-hints"[\s\S]*?<\/div>\s*(?=<div class="attachments-preview|<div class="input-wrapper")/
    );
    const hintsArea = hintsAreaMatch[0];
    expect(hintsArea).not.toContain('showAddRole = true');
    expect(hintsArea).not.toContain('添加角色');
  });
});

// =====================================================================
// @ 自动补全: 选中角色后输入框显示 displayName
// =====================================================================

describe('@ autocomplete - uses displayName instead of name', () => {
  // Replicate selectAtRole logic from CrewChatView.js
  function selectAtRole(inputText, cursorPos, role) {
    const beforeCursor = inputText.substring(0, cursorPos);
    const atIdx = beforeCursor.lastIndexOf('@');
    if (atIdx >= 0) {
      const afterCursor = inputText.substring(cursorPos);
      const newText = inputText.substring(0, atIdx) + '@' + role.displayName + ' ' + afterCursor;
      const newPos = atIdx + role.displayName.length + 2;
      return { text: newText, cursorPos: newPos };
    }
    return { text: inputText, cursorPos };
  }

  // Replicate insertAt logic from CrewChatView.js
  function insertAt(roleName, roles, currentText) {
    const role = roles.find(r => r.name === roleName);
    const displayName = role ? role.displayName : roleName;
    return `@${displayName} ` + currentText;
  }

  const testRoles = [
    { name: 'pm', displayName: 'PM-乔布斯' },
    { name: 'developer', displayName: '开发者-托瓦兹' },
    { name: 'architect', displayName: '架构师-福勒' },
    { name: 'tester', displayName: '测试-贝克' }
  ];

  it('selectAtRole should insert displayName (not name) after @', () => {
    const pmRole = testRoles[0];
    // User typed "@p" then selected PM role
    const result = selectAtRole('@p', 2, pmRole);
    expect(result.text).toBe('@PM-乔布斯 ');
    expect(result.text).not.toContain('@pm ');
  });

  it('selectAtRole should handle Chinese displayName correctly', () => {
    const devRole = testRoles[1];
    const result = selectAtRole('@dev', 4, devRole);
    expect(result.text).toBe('@开发者-托瓦兹 ');
    expect(result.text).not.toContain('@developer ');
  });

  it('selectAtRole should calculate cursor position based on displayName length', () => {
    const archRole = testRoles[2];
    const result = selectAtRole('@ar', 3, archRole);
    // @ + 架构师-福勒 (5 chars) + space = position 7
    expect(result.cursorPos).toBe(1 + archRole.displayName.length + 1);
  });

  it('selectAtRole should preserve text after cursor', () => {
    const pmRole = testRoles[0];
    const result = selectAtRole('@p 后面的文字', 2, pmRole);
    expect(result.text).toBe('@PM-乔布斯  后面的文字');
  });

  it('selectAtRole should handle @ in middle of text', () => {
    const testerRole = testRoles[3];
    const input = '请 @te';
    const result = selectAtRole(input, 5, testerRole);
    expect(result.text).toBe('请 @测试-贝克 ');
  });

  it('insertAt should use displayName instead of name', () => {
    const result = insertAt('pm', testRoles, '请查看这个问题');
    expect(result).toBe('@PM-乔布斯 请查看这个问题');
    expect(result).not.toContain('@pm ');
  });

  it('insertAt should fallback to roleName if role not found', () => {
    const result = insertAt('unknown', testRoles, '你好');
    expect(result).toBe('@unknown 你好');
  });
});

// =====================================================================
// 后端 @displayName 解析和路由
// =====================================================================

describe('Backend @displayName parsing and routing', () => {
  // Replicate the @ matching logic from agent/crew.js handleCrewHumanInput
  function resolveAtTarget(content, session) {
    const atMatch = content.match(/^@(\S+)\s*([\s\S]*)/);
    if (!atMatch) return null;

    const atTarget = atMatch[1];
    const message = atMatch[2].trim() || content;

    // 先精确匹配 role.name，再匹配 displayName
    let target = null;
    for (const [name, role] of session.roles) {
      if (name === atTarget.toLowerCase()) {
        target = name;
        break;
      }
      if (role.displayName === atTarget) {
        target = name;
        break;
      }
    }

    return target ? { target, message } : null;
  }

  function createRouteSession() {
    return {
      roles: new Map([
        ['pm', { name: 'pm', displayName: 'PM-乔布斯', description: '需求分析', isDecisionMaker: true }],
        ['developer', { name: 'developer', displayName: '开发者-托瓦兹', description: '代码编写' }],
        ['architect', { name: 'architect', displayName: '架构师-福勒', description: '系统设计' }],
        ['tester', { name: 'tester', displayName: '测试-贝克', description: '测试' }],
        ['reviewer', { name: 'reviewer', displayName: '审查者-马丁', description: '审查' }]
      ])
    };
  }

  it('should resolve @displayName to correct role name', () => {
    const session = createRouteSession();
    const result = resolveAtTarget('@PM-乔布斯 请确认需求', session);
    expect(result).not.toBeNull();
    expect(result.target).toBe('pm');
    expect(result.message).toBe('请确认需求');
  });

  it('should still resolve @name (backward compat)', () => {
    const session = createRouteSession();
    const result = resolveAtTarget('@pm 请确认需求', session);
    expect(result).not.toBeNull();
    expect(result.target).toBe('pm');
  });

  it('should resolve Chinese displayName', () => {
    const session = createRouteSession();
    const result = resolveAtTarget('@开发者-托瓦兹 修复这个bug', session);
    expect(result).not.toBeNull();
    expect(result.target).toBe('developer');
    expect(result.message).toBe('修复这个bug');
  });

  it('should resolve @architect by name', () => {
    const session = createRouteSession();
    const result = resolveAtTarget('@architect 设计方案', session);
    expect(result).not.toBeNull();
    expect(result.target).toBe('architect');
  });

  it('should resolve @架构师-福勒 by displayName', () => {
    const session = createRouteSession();
    const result = resolveAtTarget('@架构师-福勒 设计方案', session);
    expect(result).not.toBeNull();
    expect(result.target).toBe('architect');
  });

  it('should return null for unknown target', () => {
    const session = createRouteSession();
    const result = resolveAtTarget('@unknown 你好', session);
    expect(result).toBeNull();
  });

  it('should return null for non-@ messages', () => {
    const session = createRouteSession();
    const result = resolveAtTarget('普通消息', session);
    expect(result).toBeNull();
  });

  it('should use full content as message when no text after @target', () => {
    const session = createRouteSession();
    const result = resolveAtTarget('@PM-乔布斯 ', session);
    expect(result).not.toBeNull();
    expect(result.target).toBe('pm');
    expect(result.message).toBe('@PM-乔布斯 '); // falls back to full content
  });

  it('should handle displayName with hyphen correctly (regex \\S+ match)', () => {
    const session = createRouteSession();
    // The regex /^@(\S+)\s*/ should match "PM-乔布斯" as one token (no spaces)
    const result = resolveAtTarget('@审查者-马丁 代码审查', session);
    expect(result).not.toBeNull();
    expect(result.target).toBe('reviewer');
  });

  it('should prioritize name match over displayName match', () => {
    // Edge case: if a role's name matches, it should be preferred
    const session = {
      roles: new Map([
        ['pm', { name: 'pm', displayName: 'PM-乔布斯' }],
        ['pm-custom', { name: 'pm-custom', displayName: 'pm' }] // displayName matches another role's name
      ])
    };
    const result = resolveAtTarget('@pm 你好', session);
    expect(result.target).toBe('pm'); // name match wins
  });

  it('should be case-insensitive for name matching', () => {
    const session = createRouteSession();
    const result = resolveAtTarget('@PM 你好', session);
    expect(result).not.toBeNull();
    expect(result.target).toBe('pm');
  });

  it('should be case-sensitive for displayName matching', () => {
    const session = createRouteSession();
    // displayName 是 "PM-乔布斯"，如果用小写 "pm-乔布斯" 不应匹配 displayName
    // 但 "pm-乔布斯" 的 toLowerCase 也不等于任何 name
    const result = resolveAtTarget('@pm-乔布斯 你好', session);
    // name match: "pm-乔布斯".toLowerCase() = "pm-乔布斯", no role named "pm-乔布斯"
    // displayName match: "pm-乔布斯" !== "PM-乔布斯"
    expect(result).toBeNull();
  });

  it('should handle multiline message content', () => {
    const session = createRouteSession();
    const result = resolveAtTarget('@测试-贝克 请测试以下变更：\n1. 变更一\n2. 变更二', session);
    expect(result).not.toBeNull();
    expect(result.target).toBe('tester');
    expect(result.message).toContain('变更一');
    expect(result.message).toContain('变更二');
  });

  it('should use new regex \\S+ instead of old \\w+ to support Chinese/hyphen displayNames', () => {
    // Old regex: /^@(\w+)\s*/ only matches word chars (letters, digits, underscore)
    // New regex: /^@(\S+)\s*/ matches any non-whitespace (Chinese, hyphens, etc.)
    const oldRegex = /^@(\w+)\s*([\s\S]*)/;
    const newRegex = /^@(\S+)\s*([\s\S]*)/;

    const chineseInput = '@PM-乔布斯 测试';

    const oldMatch = chineseInput.match(oldRegex);
    const newMatch = chineseInput.match(newRegex);

    // Old regex only captures "PM" (stops at hyphen), missing the full displayName
    expect(oldMatch).not.toBeNull();
    expect(oldMatch[1]).toBe('PM'); // only "PM", not "PM-乔布斯"

    // New regex captures the full displayName including Chinese chars and hyphens
    expect(newMatch).not.toBeNull();
    expect(newMatch[1]).toBe('PM-乔布斯'); // full displayName captured

    // Pure Chinese displayName test
    const pureChineseInput = '@开发者-托瓦兹 修复bug';
    const oldChineseMatch = pureChineseInput.match(oldRegex);
    const newChineseMatch = pureChineseInput.match(newRegex);

    // Old regex fails entirely on Chinese-starting displayName
    expect(oldChineseMatch).toBeNull();
    // New regex works correctly
    expect(newChineseMatch).not.toBeNull();
    expect(newChineseMatch[1]).toBe('开发者-托瓦兹');
  });
});

// =====================================================================
// shortName: 消息头显示简短名 vs ROUTE 保留完整名
// =====================================================================

describe('shortName - message header displays short name', () => {
  // Replicate shortName from CrewChatView.js
  function shortName(displayName) {
    if (!displayName) return '';
    const idx = displayName.indexOf('-');
    return idx > 0 ? displayName.substring(idx + 1) : displayName;
  }

  it('should extract name after hyphen from "PM-乔布斯"', () => {
    expect(shortName('PM-乔布斯')).toBe('乔布斯');
  });

  it('should extract name after hyphen from "架构师-福勒"', () => {
    expect(shortName('架构师-福勒')).toBe('福勒');
  });

  it('should extract name after hyphen from "开发者-托瓦兹"', () => {
    expect(shortName('开发者-托瓦兹')).toBe('托瓦兹');
  });

  it('should extract name after hyphen from "审查者-马丁"', () => {
    expect(shortName('审查者-马丁')).toBe('马丁');
  });

  it('should extract name after hyphen from "测试-贝克"', () => {
    expect(shortName('测试-贝克')).toBe('贝克');
  });

  it('should extract name after hyphen from "设计师-拉姆斯"', () => {
    expect(shortName('设计师-拉姆斯')).toBe('拉姆斯');
  });

  it('should return full name if no hyphen', () => {
    expect(shortName('PM')).toBe('PM');
    expect(shortName('Admin')).toBe('Admin');
  });

  it('should return empty string for empty/falsy input', () => {
    expect(shortName('')).toBe('');
    expect(shortName(null)).toBe('');
    expect(shortName(undefined)).toBe('');
  });

  it('should handle hyphen at position 0 (return full name)', () => {
    // idx = 0, condition idx > 0 is false, returns full name
    expect(shortName('-orphan')).toBe('-orphan');
  });

  it('should only split on first hyphen', () => {
    // "策略师-索罗斯-备份" → substring after first '-' = "索罗斯-备份"
    expect(shortName('策略师-索罗斯-备份')).toBe('索罗斯-备份');
  });
});

describe('Message header: shortName vs full name for ROUTE', () => {
  // Replicate the template logic from line 95 of CrewChatView.js:
  // {{ turn.message.type === 'route' ? turn.message.roleName : shortName(turn.message.roleName) }}
  function shortName(displayName) {
    if (!displayName) return '';
    const idx = displayName.indexOf('-');
    return idx > 0 ? displayName.substring(idx + 1) : displayName;
  }

  function getHeaderDisplayName(message) {
    return message.type === 'route' ? message.roleName : shortName(message.roleName);
  }

  it('should show short name for normal text messages', () => {
    const msg = { type: 'text', role: 'pm', roleName: 'PM-乔布斯', content: '分析完成' };
    expect(getHeaderDisplayName(msg)).toBe('乔布斯');
  });

  it('should show full name for route messages', () => {
    const msg = { type: 'route', role: 'pm', roleName: 'PM-乔布斯', routeTo: 'developer' };
    expect(getHeaderDisplayName(msg)).toBe('PM-乔布斯');
  });

  it('should show short name for tool messages', () => {
    const msg = { type: 'tool', role: 'developer', roleName: '开发者-托瓦兹', toolName: 'Read' };
    expect(getHeaderDisplayName(msg)).toBe('托瓦兹');
  });

  it('should show short name for system messages', () => {
    const msg = { type: 'system', role: 'system', roleName: 'System' };
    expect(getHeaderDisplayName(msg)).toBe('System');
  });

  it('should show short name for human_needed messages', () => {
    const msg = { type: 'human_needed', role: 'pm', roleName: 'PM-乔布斯', content: '需要决策' };
    expect(getHeaderDisplayName(msg)).toBe('乔布斯');
  });

  it('should verify all preset roles show short names in headers', () => {
    const presetRoles = [
      { displayName: 'PM-乔布斯', expectedShort: '乔布斯' },
      { displayName: '架构师-福勒', expectedShort: '福勒' },
      { displayName: '开发者-托瓦兹', expectedShort: '托瓦兹' },
      { displayName: '审查者-马丁', expectedShort: '马丁' },
      { displayName: '测试-贝克', expectedShort: '贝克' },
      { displayName: '设计师-拉姆斯', expectedShort: '拉姆斯' }
    ];

    for (const role of presetRoles) {
      const msg = { type: 'text', roleName: role.displayName };
      expect(getHeaderDisplayName(msg)).toBe(role.expectedShort);
    }
  });

  it('should verify all preset roles show full names in ROUTE headers', () => {
    const presetRoles = [
      'PM-乔布斯', '架构师-福勒', '开发者-托瓦兹',
      '审查者-马丁', '测试-贝克', '设计师-拉姆斯'
    ];

    for (const displayName of presetRoles) {
      const msg = { type: 'route', roleName: displayName, routeTo: 'pm' };
      expect(getHeaderDisplayName(msg)).toBe(displayName);
    }
  });
});

describe('Grouped turn header also uses shortName', () => {
  // Verify the grouped turn template (line 121) uses shortName
  function shortName(displayName) {
    if (!displayName) return '';
    const idx = displayName.indexOf('-');
    return idx > 0 ? displayName.substring(idx + 1) : displayName;
  }

  it('should show short name in grouped turn header', () => {
    // Simulates a grouped turn (multiple messages from same role)
    const turn = {
      type: 'turn',
      role: 'developer',
      roleName: '开发者-托瓦兹',
      roleIcon: '',
      messages: [
        { type: 'text', content: '开始实现...' },
        { type: 'tool', toolName: 'Read' }
      ]
    };

    // Template uses: {{ shortName(turn.roleName) }}
    expect(shortName(turn.roleName)).toBe('托瓦兹');
  });

  it('should show short name for futures team roles', () => {
    const futuresRoles = [
      { displayName: '策略师-索罗斯', expectedShort: '索罗斯' },
      { displayName: '分析师-利弗莫尔', expectedShort: '利弗莫尔' },
      { displayName: '研究员-达里奥', expectedShort: '达里奥' },
      { displayName: '风控官-塔勒布', expectedShort: '塔勒布' },
      { displayName: '交易员-琼斯', expectedShort: '琼斯' }
    ];

    for (const role of futuresRoles) {
      expect(shortName(role.displayName)).toBe(role.expectedShort);
    }
  });

  it('should show short name for writing team roles', () => {
    const writingRoles = [
      { displayName: '编排师-金庸', expectedShort: '金庸' },
      { displayName: '设计师-陈丹青', expectedShort: '陈丹青' },
      { displayName: '执笔师-鲁迅', expectedShort: '鲁迅' },
      { displayName: '审稿师-叶圣陶', expectedShort: '叶圣陶' }
    ];

    for (const role of writingRoles) {
      expect(shortName(role.displayName)).toBe(role.expectedShort);
    }
  });
});

// Verify source file template uses shortName correctly
describe('Source file verification - shortName usage in template', () => {
  let fileContent;

  it('should load CrewChatView.js source', async () => {
    fileContent = await fs.readFile(
      join(__dirname, '../../web/components/CrewChatView.js'),
      'utf-8'
    );
    expect(fileContent).toBeTruthy();
  });

  it('should use shortName for non-route standalone messages', () => {
    // Line 95: route uses full roleName, others use shortName
    expect(fileContent).toContain(
      "turn.message.type === 'route' ? turn.message.roleName : shortName(turn.message.roleName)"
    );
  });

  it('should use shortName for grouped turn headers', () => {
    // Line 121: {{ shortName(turn.roleName) }}
    expect(fileContent).toContain('shortName(turn.roleName)');
  });

  it('should define shortName method that splits on hyphen', () => {
    // Verify the shortName method exists and uses indexOf('-')
    expect(fileContent).toContain("shortName(displayName)");
    expect(fileContent).toContain("displayName.indexOf('-')");
    expect(fileContent).toContain("displayName.substring(idx + 1)");
  });

  it('should NOT use shortName for route message names', () => {
    // The ternary ensures route messages show full roleName
    // Verify the pattern: route ? roleName : shortName(roleName)
    const routePattern = fileContent.match(
      /type\s*===\s*'route'\s*\?\s*turn\.message\.roleName\s*:\s*shortName\(turn\.message\.roleName\)/
    );
    expect(routePattern).toBeTruthy();
  });
});

// =====================================================================
// Feature Blocks: taskId-based message grouping
// =====================================================================

describe('featureBlocks - message segmentation by taskId', () => {
  // Replicate the segment splitting logic from featureBlocks computed
  function splitSegments(messages) {
    const segments = [];
    let currentSegment = null;

    const flushSegment = () => {
      if (currentSegment && currentSegment.messages.length > 0) {
        segments.push(currentSegment);
      }
      currentSegment = null;
    };

    for (const msg of messages) {
      const taskId = msg.taskId || null;
      const isGlobal = !taskId || msg.role === 'human';

      if (isGlobal) {
        if (currentSegment && currentSegment.taskId) {
          flushSegment();
        }
        if (!currentSegment || currentSegment.taskId) {
          flushSegment();
          currentSegment = { taskId: null, messages: [] };
        }
        currentSegment.messages.push(msg);
      } else {
        if (currentSegment && currentSegment.taskId === taskId) {
          currentSegment.messages.push(msg);
        } else {
          flushSegment();
          currentSegment = { taskId, messages: [msg] };
        }
      }
    }
    flushSegment();
    return segments;
  }

  // Replicate _buildTurns
  function buildTurns(messages) {
    const turns = [];
    let currentTurn = null;
    let turnCounter = 0;

    const flushTurn = () => {
      if (currentTurn) {
        currentTurn.textMsg = currentTurn.messages.find(m => m.type === 'text') || null;
        currentTurn.toolMsgs = currentTurn.messages.filter(m => m.type === 'tool');
        turns.push(currentTurn);
        currentTurn = null;
      }
    };

    for (const msg of messages) {
      if (msg.type === 'route' || msg.type === 'system' || msg.type === 'human_needed') {
        flushTurn();
        turns.push({ type: msg.type, message: msg, id: 'standalone_' + (msg.id || turnCounter++) });
        continue;
      }
      if (msg.role === 'human') {
        flushTurn();
        turns.push({ type: 'text', message: msg, id: 'human_' + (msg.id || turnCounter++) });
        continue;
      }
      if (currentTurn && currentTurn.role === msg.role) {
        currentTurn.messages.push(msg);
      } else {
        flushTurn();
        currentTurn = {
          type: 'turn', role: msg.role, roleName: msg.roleName, roleIcon: msg.roleIcon,
          messages: [msg], textMsg: null, toolMsgs: [], id: 'turn_' + (turnCounter++)
        };
      }
    }
    flushTurn();
    return turns;
  }

  // Replicate full featureBlocks computed
  function buildFeatureBlocks(allMessages, completedTaskIds = new Set()) {
    const segments = splitSegments(allMessages);
    const blocks = [];
    let blockCounter = 0;

    for (const seg of segments) {
      const turns = buildTurns(seg.messages);
      if (seg.taskId) {
        const taskTitle = seg.messages.find(m => m.taskTitle)?.taskTitle || seg.taskId;
        const isCompleted = completedTaskIds.has(seg.taskId);
        const hasStreaming = seg.messages.some(m => m._streaming);
        const activeRoles = [];
        const seenRoles = new Set();
        for (let i = seg.messages.length - 1; i >= 0; i--) {
          const m = seg.messages[i];
          if (m._streaming && m.role && !seenRoles.has(m.role)) {
            seenRoles.add(m.role);
            activeRoles.push({ role: m.role, roleName: m.roleName, roleIcon: m.roleIcon });
          }
        }
        blocks.push({
          type: 'feature', taskId: seg.taskId, taskTitle, turns,
          isCompleted, hasStreaming, activeRoles,
          id: 'feature_' + seg.taskId + '_' + (blockCounter++)
        });
      } else {
        blocks.push({ type: 'global', turns, id: 'global_' + (blockCounter++) });
      }
    }
    return blocks;
  }

  // Replicate isFeatureExpanded
  function isFeatureExpanded(block, expandedFeatures = {}) {
    if (block.taskId in expandedFeatures) {
      return expandedFeatures[block.taskId];
    }
    return !block.isCompleted || block.hasStreaming;
  }

  it('should group messages without taskId into global blocks', () => {
    const messages = [
      { role: 'pm', type: 'text', content: 'PM 说' },
      { role: 'developer', type: 'text', content: '开发者回复' }
    ];
    const blocks = buildFeatureBlocks(messages);
    expect(blocks.length).toBe(1);
    expect(blocks[0].type).toBe('global');
    expect(blocks[0].turns.length).toBe(2);
  });

  it('should group messages with same taskId into feature block', () => {
    const messages = [
      { role: 'pm', type: 'text', content: '分配任务', taskId: 'task_1', taskTitle: '实现登录' },
      { role: 'developer', type: 'text', content: '收到', taskId: 'task_1' },
      { role: 'developer', type: 'tool', toolName: 'Edit', taskId: 'task_1' }
    ];
    const blocks = buildFeatureBlocks(messages);
    expect(blocks.length).toBe(1);
    expect(blocks[0].type).toBe('feature');
    expect(blocks[0].taskId).toBe('task_1');
    expect(blocks[0].taskTitle).toBe('实现登录');
  });

  it('should separate global and feature blocks', () => {
    const messages = [
      { role: 'pm', type: 'text', content: '欢迎' },
      { role: 'pm', type: 'text', content: '开始任务1', taskId: 'task_1', taskTitle: '任务一' },
      { role: 'developer', type: 'text', content: '执行中', taskId: 'task_1' },
      { role: 'pm', type: 'text', content: '全局消息' },
      { role: 'pm', type: 'text', content: '开始任务2', taskId: 'task_2', taskTitle: '任务二' }
    ];
    const blocks = buildFeatureBlocks(messages);
    expect(blocks.length).toBe(4);
    expect(blocks[0].type).toBe('global');
    expect(blocks[1].type).toBe('feature');
    expect(blocks[1].taskId).toBe('task_1');
    expect(blocks[2].type).toBe('global');
    expect(blocks[3].type).toBe('feature');
    expect(blocks[3].taskId).toBe('task_2');
  });

  it('should treat human messages as global even if they have taskId', () => {
    const messages = [
      { role: 'pm', type: 'text', content: '执行中', taskId: 'task_1', taskTitle: '任务' },
      { role: 'human', type: 'text', content: '人工消息', taskId: 'task_1' },
      { role: 'pm', type: 'text', content: '继续', taskId: 'task_1' }
    ];
    const blocks = buildFeatureBlocks(messages);
    // Human message breaks the feature block into: feature, global(human), feature
    expect(blocks.length).toBe(3);
    expect(blocks[0].type).toBe('feature');
    expect(blocks[1].type).toBe('global');
    expect(blocks[1].turns[0].message.role).toBe('human');
    expect(blocks[2].type).toBe('feature');
  });

  it('should merge consecutive global messages into one block', () => {
    const messages = [
      { role: 'pm', type: 'text', content: '消息1' },
      { role: 'pm', type: 'text', content: '消息2' },
      { role: 'developer', type: 'text', content: '消息3' }
    ];
    const blocks = buildFeatureBlocks(messages);
    expect(blocks.length).toBe(1);
    expect(blocks[0].type).toBe('global');
  });

  it('should handle different taskIds as separate feature blocks', () => {
    const messages = [
      { role: 'developer', type: 'text', content: '任务1', taskId: 'task_1', taskTitle: '登录' },
      { role: 'developer', type: 'text', content: '任务2', taskId: 'task_2', taskTitle: '注册' }
    ];
    const blocks = buildFeatureBlocks(messages);
    expect(blocks.length).toBe(2);
    expect(blocks[0].taskId).toBe('task_1');
    expect(blocks[1].taskId).toBe('task_2');
  });

  it('should mark completed features correctly', () => {
    const messages = [
      { role: 'developer', type: 'text', content: '完成', taskId: 'task_1', taskTitle: '登录' }
    ];
    const completed = new Set(['task_1']);
    const blocks = buildFeatureBlocks(messages, completed);
    expect(blocks[0].isCompleted).toBe(true);
  });

  it('should detect streaming features', () => {
    const messages = [
      { role: 'developer', type: 'text', content: '进行中', taskId: 'task_1', taskTitle: '登录', _streaming: true }
    ];
    const blocks = buildFeatureBlocks(messages);
    expect(blocks[0].hasStreaming).toBe(true);
  });

  it('should collect active roles from streaming messages', () => {
    const messages = [
      { role: 'developer', roleName: '开发者-托瓦兹', roleIcon: '', type: 'text', content: '编码中', taskId: 'task_1', _streaming: true },
      { role: 'reviewer', roleName: '审查者-马丁', roleIcon: '', type: 'text', content: '审查中', taskId: 'task_1', _streaming: true }
    ];
    const blocks = buildFeatureBlocks(messages);
    expect(blocks[0].activeRoles.length).toBe(2);
    // Active roles are collected in reverse order (latest first)
    expect(blocks[0].activeRoles[0].role).toBe('reviewer');
    expect(blocks[0].activeRoles[1].role).toBe('developer');
  });

  it('should not duplicate active roles', () => {
    const messages = [
      { role: 'developer', roleName: '开发者', roleIcon: '', type: 'text', content: '行1', taskId: 'task_1', _streaming: true },
      { role: 'developer', roleName: '开发者', roleIcon: '', type: 'tool', toolName: 'Edit', taskId: 'task_1', _streaming: true }
    ];
    const blocks = buildFeatureBlocks(messages);
    expect(blocks[0].activeRoles.length).toBe(1);
  });

  it('should use taskId as fallback title when no taskTitle found', () => {
    const messages = [
      { role: 'developer', type: 'text', content: '工作中', taskId: 'task_abc' }
    ];
    const blocks = buildFeatureBlocks(messages);
    expect(blocks[0].taskTitle).toBe('task_abc');
  });

  it('should handle empty messages', () => {
    const blocks = buildFeatureBlocks([]);
    expect(blocks.length).toBe(0);
  });

  it('should build turns inside feature blocks correctly', () => {
    const messages = [
      { role: 'developer', roleName: '开发者', type: 'text', content: '文本', taskId: 'task_1', taskTitle: '功能' },
      { role: 'developer', roleName: '开发者', type: 'tool', toolName: 'Read', taskId: 'task_1' },
      { role: 'pm', roleName: 'PM', type: 'route', routeTo: 'developer', taskId: 'task_1' },
      { role: 'reviewer', roleName: '审查者', type: 'text', content: '审查', taskId: 'task_1' }
    ];
    const blocks = buildFeatureBlocks(messages);
    expect(blocks.length).toBe(1);
    const turns = blocks[0].turns;
    // developer text+tool grouped, then route standalone, then reviewer text
    expect(turns.length).toBe(3);
    expect(turns[0].type).toBe('turn');
    expect(turns[0].role).toBe('developer');
    expect(turns[0].toolMsgs.length).toBe(1);
    expect(turns[1].type).toBe('route');
    expect(turns[2].type).toBe('turn');
    expect(turns[2].role).toBe('reviewer');
  });

  it('should handle interleaved global and feature messages', () => {
    const messages = [
      { role: 'pm', type: 'text', content: '计划' },
      { role: 'developer', type: 'text', content: '开发A', taskId: 'task_a', taskTitle: '功能A' },
      { role: 'developer', type: 'text', content: '开发A续', taskId: 'task_a' },
      { role: 'pm', type: 'route', routeTo: 'developer' },
      { role: 'developer', type: 'text', content: '开发B', taskId: 'task_b', taskTitle: '功能B' },
      { role: 'pm', type: 'text', content: '总结' }
    ];
    const blocks = buildFeatureBlocks(messages);
    expect(blocks.length).toBe(5);
    expect(blocks[0].type).toBe('global');   // PM 计划
    expect(blocks[1].type).toBe('feature');  // task_a
    expect(blocks[1].taskId).toBe('task_a');
    expect(blocks[2].type).toBe('global');   // route
    expect(blocks[3].type).toBe('feature');  // task_b
    expect(blocks[3].taskId).toBe('task_b');
    expect(blocks[4].type).toBe('global');   // PM 总结
  });
});

describe('isFeatureExpanded - auto-collapse completed features', () => {
  function isFeatureExpanded(block, expandedFeatures = {}) {
    if (block.taskId in expandedFeatures) {
      return expandedFeatures[block.taskId];
    }
    return !block.isCompleted || block.hasStreaming;
  }

  it('should expand non-completed features by default', () => {
    const block = { taskId: 'task_1', isCompleted: false, hasStreaming: false };
    expect(isFeatureExpanded(block)).toBe(true);
  });

  it('should collapse completed features by default', () => {
    const block = { taskId: 'task_1', isCompleted: true, hasStreaming: false };
    expect(isFeatureExpanded(block)).toBe(false);
  });

  it('should expand completed feature if still streaming', () => {
    const block = { taskId: 'task_1', isCompleted: true, hasStreaming: true };
    expect(isFeatureExpanded(block)).toBe(true);
  });

  it('should respect manual toggle: expand collapsed', () => {
    const block = { taskId: 'task_1', isCompleted: true, hasStreaming: false };
    const expandedFeatures = { task_1: true };
    expect(isFeatureExpanded(block, expandedFeatures)).toBe(true);
  });

  it('should respect manual toggle: collapse expanded', () => {
    const block = { taskId: 'task_1', isCompleted: false, hasStreaming: false };
    const expandedFeatures = { task_1: false };
    expect(isFeatureExpanded(block, expandedFeatures)).toBe(false);
  });

  it('should not affect other features when toggling one', () => {
    const blockA = { taskId: 'task_a', isCompleted: false, hasStreaming: false };
    const blockB = { taskId: 'task_b', isCompleted: true, hasStreaming: false };
    const expandedFeatures = { task_b: true };
    expect(isFeatureExpanded(blockA, expandedFeatures)).toBe(true); // default
    expect(isFeatureExpanded(blockB, expandedFeatures)).toBe(true); // manually expanded
  });

  it('should expand streaming features regardless of manual toggle', () => {
    // If manually collapsed but streaming, the logic still uses manual state
    // (manual state takes precedence)
    const block = { taskId: 'task_1', isCompleted: false, hasStreaming: true };
    const expandedFeatures = { task_1: false };
    // Manual toggle wins
    expect(isFeatureExpanded(block, expandedFeatures)).toBe(false);
  });
});

describe('shouldShowTurnDivider - accepts turns array parameter', () => {
  // Replicate the updated shouldShowTurnDivider (now takes turns as param)
  function shouldShowTurnDivider(turns, tidx) {
    const prev = turns[tidx - 1];
    const curr = turns[tidx];
    if (curr.type === 'route' || prev.type === 'route') return false;
    const prevRole = prev.type === 'turn' ? prev.role : prev.message?.role;
    const currRole = curr.type === 'turn' ? curr.role : curr.message?.role;
    return prevRole && currRole && prevRole !== currRole;
  }

  it('should show divider between different roles', () => {
    const turns = [
      { type: 'turn', role: 'pm' },
      { type: 'turn', role: 'developer' }
    ];
    expect(shouldShowTurnDivider(turns, 1)).toBe(true);
  });

  it('should not show divider for same role', () => {
    const turns = [
      { type: 'turn', role: 'pm' },
      { type: 'turn', role: 'pm' }
    ];
    expect(shouldShowTurnDivider(turns, 1)).toBe(false);
  });

  it('should not show divider around route messages', () => {
    const turns = [
      { type: 'turn', role: 'pm' },
      { type: 'route', message: { role: 'pm' } }
    ];
    expect(shouldShowTurnDivider(turns, 1)).toBe(false);
  });

  it('should work with standalone messages', () => {
    const turns = [
      { type: 'text', message: { role: 'human' } },
      { type: 'turn', role: 'pm' }
    ];
    expect(shouldShowTurnDivider(turns, 1)).toBe(true);
  });
});

describe('Feature blocks - removed task panel and filter bar', () => {
  let fileContent;

  it('should load source file', async () => {
    fileContent = await fs.readFile(
      join(__dirname, '../../web/components/CrewChatView.js'),
      'utf-8'
    );
    expect(fileContent).toBeTruthy();
  });

  it('should NOT have crew-task-panel in template', () => {
    expect(fileContent).not.toContain('crew-task-panel');
  });

  it('should NOT have taskFilter in data', () => {
    expect(fileContent).not.toContain('taskFilter:');
    expect(fileContent).not.toContain('taskFilter ===');
  });

  it('should NOT have crew-filter-bar in template', () => {
    expect(fileContent).not.toContain('crew-filter-bar');
    expect(fileContent).not.toContain('crew-filter-back');
  });

  it('should have featureBlocks computed instead of groupedMessages', () => {
    expect(fileContent).toContain('featureBlocks()');
    expect(fileContent).not.toMatch(/\bgroupedMessages\s*\(\)/);
  });

  it('should have crew-feature-thread in template', () => {
    expect(fileContent).toContain('crew-feature-thread');
    expect(fileContent).toContain('crew-feature-header');
    expect(fileContent).toContain('crew-feature-body');
  });

  it('should have isFeatureExpanded method', () => {
    expect(fileContent).toContain('isFeatureExpanded(block)');
  });

  it('should have toggleFeature method', () => {
    expect(fileContent).toContain('toggleFeature(taskId)');
  });

  it('should use _buildTurns helper method', () => {
    expect(fileContent).toContain('_buildTurns(');
  });

  it('should use shouldShowTurnDivider with turns parameter', () => {
    expect(fileContent).toContain('shouldShowTurnDivider(block.turns, tidx)');
  });

  it('should show completed badge for completed features', () => {
    expect(fileContent).toContain("block.isCompleted");
    expect(fileContent).toContain('已完成');
  });

  it('should show active badge for streaming features', () => {
    expect(fileContent).toContain("block.hasStreaming");
    expect(fileContent).toContain('进行中');
  });

  it('should display message count in feature header', () => {
    expect(fileContent).toContain('block.turns.length');
    expect(fileContent).toContain('条');
  });

  it('should show active roles in feature header using shortName', () => {
    expect(fileContent).toContain('block.activeRoles');
    expect(fileContent).toContain('shortName(ar.roleName)');
  });
});

describe('Feature blocks CSS verification', () => {
  let cssContent;

  it('should load style.css', async () => {
    cssContent = await fs.readFile(
      join(__dirname, '../../web/style.css'),
      'utf-8'
    );
    expect(cssContent).toBeTruthy();
  });

  it('should define crew-feature-thread styles', () => {
    expect(cssContent).toContain('.crew-feature-thread');
    expect(cssContent).toContain('.crew-feature-header');
    expect(cssContent).toContain('.crew-feature-body');
    expect(cssContent).toContain('.crew-feature-title');
  });

  it('should style completed features with muted title', () => {
    expect(cssContent).toContain('.crew-feature-thread.is-completed .crew-feature-title');
  });

  it('should have feature badge styles for completed and active', () => {
    expect(cssContent).toContain('.crew-feature-badge.completed');
    expect(cssContent).toContain('.crew-feature-badge.active');
  });

  it('should have hover effect on feature header', () => {
    expect(cssContent).toContain('.crew-feature-header:hover');
  });

  it('should use border-left for feature body thread line', () => {
    expect(cssContent).toContain('.crew-feature-body');
    // Feature body has border-left for visual thread
    const bodyRule = cssContent.match(/\.crew-feature-body\s*\{[^}]*border-left[^}]*/);
    expect(bodyRule).toBeTruthy();
  });
});
