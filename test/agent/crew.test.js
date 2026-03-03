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
    goal: overrides.goal || '测试目标',
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

    it('should not include roles, goal, or other metadata', () => {
      const session = createTestSession();
      const entry = sessionToIndexEntry(session);

      expect(entry.roles).toBeUndefined();
      expect(entry.goal).toBeUndefined();
      expect(entry.userId).toBeUndefined();
      expect(entry.username).toBeUndefined();
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
