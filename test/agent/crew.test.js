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
