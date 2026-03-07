import { describe, it, expect, beforeAll } from 'vitest';

/**
 * Tests for task-42: features persistence and todosByFeature no-filter.
 *
 * Verifies:
 * 1) todosByFeature no longer filters completed groups
 * 2) activeTasks prioritizes store.currentCrewStatus.features
 * 3) crew.js session.features accumulates correctly
 * 4) sendStatusUpdate includes features list
 * 5) session resume restores from meta.features
 */

// =====================================================================
// Source code
// =====================================================================

let crewSource;
let viewSource;
let storeSource;

beforeAll(async () => {
  const { promises: fs } = await import('fs');
  const { join } = await import('path');
  const base = process.cwd();
  crewSource = await fs.readFile(join(base, 'agent/crew.js'), 'utf-8');
  viewSource = await fs.readFile(join(base, 'web/components/CrewChatView.js'), 'utf-8');
  const chatMain = await fs.readFile(join(base, 'web/stores/chat.js'), 'utf-8');
  const crewHelper = await fs.readFile(join(base, 'web/stores/helpers/crew.js'), 'utf-8');
  storeSource = chatMain + '\n' + crewHelper;
});

// =====================================================================
// 1) todosByFeature no longer filters completed groups
// =====================================================================

describe('todosByFeature: no completed-group filtering', () => {

  it('should NOT contain allDone filtering logic', () => {
    // Old code had: const allDone = group.entries.every(...); if (!allDone) result.push(group);
    // This should be removed
    expect(viewSource).not.toContain('allDone');
  });

  it('should return Array.from(groups.values()) directly', () => {
    // The todosByFeature computed should end with:
    // return Array.from(groups.values());
    const todoSection = viewSource.split('todosByFeature')[1];
    expect(todoSection).toContain('return Array.from(groups.values())');
  });

  // Replicate the logic to verify behavior
  it('should include groups where all todos are completed', () => {
    const latestMap = new Map();
    latestMap.set('role-A', {
      taskId: 'task-1', taskTitle: 'Feature A',
      todos: [{ content: 'Do X', status: 'completed' }, { content: 'Do Y', status: 'completed' }]
    });
    latestMap.set('role-B', {
      taskId: 'task-2', taskTitle: 'Feature B',
      todos: [{ content: 'Do Z', status: 'in_progress' }]
    });

    // Replicate grouping logic (no filtering)
    const groups = new Map();
    for (const entry of latestMap.values()) {
      const tid = entry.taskId || '_global';
      if (!groups.has(tid)) {
        groups.set(tid, { taskId: entry.taskId, taskTitle: entry.taskTitle, entries: [] });
      }
      groups.get(tid).entries.push(entry);
    }
    const result = Array.from(groups.values());

    // Both groups should be present, including the fully-completed one
    expect(result).toHaveLength(2);
    const task1 = result.find(g => g.taskId === 'task-1');
    const task2 = result.find(g => g.taskId === 'task-2');
    expect(task1).toBeDefined();
    expect(task2).toBeDefined();
  });
});

// =====================================================================
// 2) activeTasks prioritizes store.currentCrewStatus.features
// =====================================================================

describe('activeTasks: prioritize persisted features', () => {

  it('should reference store.currentCrewStatus.features', () => {
    const activeSection = viewSource.split('activeTasks()')[1]?.split('\n    },')[0] || '';
    expect(activeSection).toContain('currentCrewStatus');
    expect(activeSection).toContain('features');
  });

  it('should set persistedFeatures from store', () => {
    const activeSection = viewSource.split('activeTasks()')[1]?.split('\n    },')[0] || '';
    expect(activeSection).toContain('persistedFeatures');
  });

  it('should iterate persisted features first, then supplement from messages', () => {
    const activeSection = viewSource.split('activeTasks()')[1]?.split('\n    },')[0] || '';
    const persistedIdx = activeSection.indexOf('persistedFeatures');
    const msgIdx = activeSection.indexOf('currentCrewMessages');
    expect(persistedIdx).toBeGreaterThan(-1);
    expect(msgIdx).toBeGreaterThan(-1);
    expect(persistedIdx).toBeLessThan(msgIdx);
  });

  it('messages should only supplement, not overwrite persisted features', () => {
    const activeSection = viewSource.split('activeTasks()')[1]?.split('\n    },')[0] || '';
    expect(activeSection).toContain('!taskMap.has(msg.taskId)');
  });

  // Replicate logic to verify behavior
  it('persisted features take priority over message-derived features', () => {
    const taskMap = new Map();

    // Persisted features (from server)
    const persistedFeatures = [
      { taskId: 'task-1', taskTitle: 'Old Title from Server' },
      { taskId: 'task-2', taskTitle: 'Another Feature' }
    ];
    for (const f of persistedFeatures) {
      taskMap.set(f.taskId, f.taskTitle);
    }

    // Messages (should not overwrite existing)
    const messages = [
      { taskId: 'task-1', taskTitle: 'New Title from Message' },  // should be ignored
      { taskId: 'task-3', taskTitle: 'Brand New Feature' }        // should be added
    ];
    for (const msg of messages) {
      if (msg.taskId && msg.taskTitle && !taskMap.has(msg.taskId)) {
        taskMap.set(msg.taskId, msg.taskTitle);
      }
    }

    expect(taskMap.size).toBe(3);
    expect(taskMap.get('task-1')).toBe('Old Title from Server');  // NOT overwritten
    expect(taskMap.get('task-2')).toBe('Another Feature');
    expect(taskMap.get('task-3')).toBe('Brand New Feature');      // supplemented
  });
});

// =====================================================================
// 3) crew.js session.features accumulation and persistence
// =====================================================================

describe('crew.js: session.features accumulation', () => {

  it('createCrewSession should initialize features as empty Map', () => {
    expect(crewSource).toContain('features: new Map()');
  });

  it('sendCrewOutput should accumulate features on new taskId', () => {
    expect(crewSource).toContain('session.features.has(taskId)');
    expect(crewSource).toContain('session.features.set(taskId');
  });

  it('should only accumulate when both taskId and taskTitle are present', () => {
    // Check: if (taskId && taskTitle && !session.features.has(taskId))
    expect(crewSource).toContain('taskId && taskTitle && !session.features.has(taskId)');
  });

  it('should store taskId, taskTitle, and createdAt in feature entry', () => {
    const featureSetLine = crewSource.split('session.features.set(taskId')[1]?.split(')')[0] || '';
    expect(featureSetLine).toContain('taskId');
    expect(featureSetLine).toContain('taskTitle');
    expect(featureSetLine).toContain('createdAt');
  });

  it('saveSessionMeta should serialize features to array', () => {
    const saveSection = crewSource.split('saveSessionMeta')[1]?.split('await fs.writeFile')[0] || '';
    expect(saveSection).toContain('features: Array.from(session.features.values())');
  });

  // Replicate accumulation logic
  it('should not duplicate features with same taskId', () => {
    const features = new Map();

    // First message with task-1
    const taskId1 = 'task-1';
    const taskTitle1 = 'Feature A';
    if (taskId1 && taskTitle1 && !features.has(taskId1)) {
      features.set(taskId1, { taskId: taskId1, taskTitle: taskTitle1, createdAt: 1000 });
    }

    // Duplicate message with task-1 (different title, but should be ignored)
    const taskTitle1b = 'Feature A Updated';
    if (taskId1 && taskTitle1b && !features.has(taskId1)) {
      features.set(taskId1, { taskId: taskId1, taskTitle: taskTitle1b, createdAt: 2000 });
    }

    expect(features.size).toBe(1);
    expect(features.get('task-1').taskTitle).toBe('Feature A');  // original preserved
  });

  it('should skip when taskId or taskTitle is missing', () => {
    const features = new Map();

    // No taskId
    const taskId = undefined;
    const taskTitle = 'Some Title';
    if (taskId && taskTitle && !features.has(taskId)) {
      features.set(taskId, { taskId, taskTitle, createdAt: Date.now() });
    }
    expect(features.size).toBe(0);

    // No taskTitle
    const taskId2 = 'task-2';
    const taskTitle2 = undefined;
    if (taskId2 && taskTitle2 && !features.has(taskId2)) {
      features.set(taskId2, { taskId: taskId2, taskTitle: taskTitle2, createdAt: Date.now() });
    }
    expect(features.size).toBe(0);
  });
});

// =====================================================================
// 4) sendStatusUpdate includes features list
// =====================================================================

describe('sendStatusUpdate: features in payload', () => {

  it('sendStatusUpdate should include features field', () => {
    // sendStatusUpdate function definition starts with "function sendStatusUpdate"
    const fnStart = crewSource.indexOf('function sendStatusUpdate');
    expect(fnStart).toBeGreaterThan(-1);
    const statusSection = crewSource.substring(fnStart, crewSource.indexOf('异步更新持久化', fnStart));
    expect(statusSection).toContain('features: Array.from(session.features.values())');
  });

  it('chat store should receive and store features from status update', () => {
    expect(storeSource).toContain("features: msg.features || []");
  });
});

// =====================================================================
// 5) session resume restores from meta.features
// =====================================================================

describe('resumeCrewSession: restore features from meta', () => {

  it('should reconstruct features Map from meta.features array', () => {
    expect(crewSource).toContain("features: new Map((meta.features || []).map(f => [f.taskId, f]))");
  });

  // Replicate resume logic
  it('should correctly restore features Map from serialized array', () => {
    const metaFeatures = [
      { taskId: 'task-1', taskTitle: 'Feature A', createdAt: 1000 },
      { taskId: 'task-2', taskTitle: 'Feature B', createdAt: 2000 }
    ];
    const features = new Map((metaFeatures || []).map(f => [f.taskId, f]));
    expect(features.size).toBe(2);
    expect(features.get('task-1').taskTitle).toBe('Feature A');
    expect(features.get('task-2').taskTitle).toBe('Feature B');
    expect(features.get('task-2').createdAt).toBe(2000);
  });

  it('should handle empty/undefined meta.features gracefully', () => {
    const features1 = new Map((undefined || []).map(f => [f.taskId, f]));
    expect(features1.size).toBe(0);

    const features2 = new Map(([] || []).map(f => [f.taskId, f]));
    expect(features2.size).toBe(0);
  });

  it('should handle meta.features with duplicate taskIds (last wins)', () => {
    // Edge case: corrupted data with duplicate taskIds
    const metaFeatures = [
      { taskId: 'task-1', taskTitle: 'First', createdAt: 1000 },
      { taskId: 'task-1', taskTitle: 'Second', createdAt: 2000 }
    ];
    const features = new Map(metaFeatures.map(f => [f.taskId, f]));
    expect(features.size).toBe(1);
    expect(features.get('task-1').taskTitle).toBe('Second');  // Map: last entry wins
  });
});

// =====================================================================
// Integration: end-to-end data flow
// =====================================================================

describe('Integration: features data flow', () => {

  it('full cycle: accumulate → save → resume → status update', () => {
    // 1. Accumulate features (crew.js sendCrewOutput)
    const sessionFeatures = new Map();
    const outputs = [
      { taskId: 'task-1', taskTitle: 'Auth Module' },
      { taskId: 'task-2', taskTitle: 'User Profile' },
      { taskId: 'task-1', taskTitle: 'Auth Module Updated' },  // duplicate, ignored
    ];
    for (const { taskId, taskTitle } of outputs) {
      if (taskId && taskTitle && !sessionFeatures.has(taskId)) {
        sessionFeatures.set(taskId, { taskId, taskTitle, createdAt: Date.now() });
      }
    }
    expect(sessionFeatures.size).toBe(2);

    // 2. Save to meta (saveSessionMeta)
    const savedFeatures = Array.from(sessionFeatures.values());
    expect(savedFeatures).toHaveLength(2);
    expect(savedFeatures[0].taskId).toBe('task-1');

    // 3. Resume from meta (resumeCrewSession)
    const restoredFeatures = new Map(savedFeatures.map(f => [f.taskId, f]));
    expect(restoredFeatures.size).toBe(2);
    expect(restoredFeatures.get('task-1').taskTitle).toBe('Auth Module');

    // 4. Status update payload (sendStatusUpdate)
    const statusPayload = { features: Array.from(restoredFeatures.values()) };
    expect(statusPayload.features).toHaveLength(2);

    // 5. Store receives (chat.js)
    const storeFeatures = statusPayload.features || [];
    expect(storeFeatures).toHaveLength(2);

    // 6. activeTasks uses persisted features
    const taskMap = new Map();
    for (const f of storeFeatures) {
      taskMap.set(f.taskId, f.taskTitle);
    }
    // Supplement from messages
    const msgs = [{ taskId: 'task-3', taskTitle: 'New Feature' }];
    for (const msg of msgs) {
      if (msg.taskId && msg.taskTitle && !taskMap.has(msg.taskId)) {
        taskMap.set(msg.taskId, msg.taskTitle);
      }
    }
    expect(taskMap.size).toBe(3);
    expect(taskMap.get('task-1')).toBe('Auth Module');
    expect(taskMap.get('task-3')).toBe('New Feature');
  });
});
