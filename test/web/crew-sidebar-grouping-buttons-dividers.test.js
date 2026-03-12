import { describe, it, expect, beforeAll } from 'vitest';

/**
 * Tests for sidebar session grouping, crew restore/delete buttons, and backend delete chain.
 *
 * Covers:
 * 1) Sidebar grouping — Crew Sessions vs normal conversations split logic
 * 2) CrewConfigPanel dual buttons — restore + delete visibility and state transitions
 * 3) deleteCrewDir backend message chain — store → ws-client → agent handler
 */

let chatPageContent;
let configContent;
let chatStoreContent;
let wsClientContent;
let crewJsContent;
let connectionJsContent;

beforeAll(async () => {
  const { promises: fs } = await import('fs');
  const { join } = await import('path');
  const base = process.cwd();
  chatPageContent = await fs.readFile(join(base, 'web/components/ChatPage.js'), 'utf-8');
  configContent = await fs.readFile(join(base, 'web/components/CrewConfigPanel.js'), 'utf-8');
  const chatMain = await fs.readFile(join(base, 'web/stores/chat.js'), 'utf-8');
  const crewHelper = await fs.readFile(join(base, 'web/stores/helpers/crew.js'), 'utf-8');
  chatStoreContent = chatMain + '\n' + crewHelper;
  wsClientContent = await fs.readFile(join(base, 'server/handlers/client-crew.js'), 'utf-8');
  crewJsContent = await fs.readFile(join(base, 'agent/crew/session.js'), 'utf-8');
  connectionJsContent = await fs.readFile(join(base, 'agent/connection/message-router.js'), 'utf-8');
});

// Simulate crewConversations / normalConversations computed
function splitConversations(conversations) {
  return {
    crew: conversations.filter(c => c.type === 'crew'),
    normal: conversations.filter(c => c.type !== 'crew')
  };
}

// Simulate button visibility logic for exists state
function getExistsButtons(crewExistsSessionInfo) {
  const hasSessionId = !!crewExistsSessionInfo?.sessionId;
  return {
    showRestoreBtn: hasSessionId,
    showDeleteBtn: true,
    deleteBtnText: hasSessionId ? '删除配置' : '删除并重新创建'
  };
}

// Simulate deleteCrewDir method
function simulateDeleteCrewDir(projectDir, selectedAgent) {
  const dir = projectDir?.trim();
  if (!dir || !selectedAgent) return { action: null };
  return {
    action: 'deleteCrewDir',
    projectDir: dir,
    agentId: selectedAgent,
    newCrewCheckState: 'none',
    newCrewExistsSessionInfo: null
  };
}

// =====================================================================
// 1. Sidebar Grouping — business logic
// =====================================================================
describe('Sidebar session grouping', () => {
  it('should separate crew and normal conversations', () => {
    const convs = [
      { id: '1', type: 'crew', name: 'Team A' },
      { id: '2', type: undefined, name: 'Chat 1' },
      { id: '3', type: 'crew', name: 'Team B' },
      { id: '4', type: 'normal', name: 'Chat 2' }
    ];
    const { crew, normal } = splitConversations(convs);
    expect(crew).toHaveLength(2);
    expect(normal).toHaveLength(2);
    expect(crew.map(c => c.id)).toEqual(['1', '3']);
    expect(normal.map(c => c.id)).toEqual(['2', '4']);
  });

  it('should return empty crew list when no crew conversations', () => {
    const convs = [
      { id: '1', name: 'Chat 1' },
      { id: '2', type: 'normal', name: 'Chat 2' }
    ];
    const { crew, normal } = splitConversations(convs);
    expect(crew).toHaveLength(0);
    expect(normal).toHaveLength(2);
  });

  it('should handle empty conversations list', () => {
    const { crew, normal } = splitConversations([]);
    expect(crew).toHaveLength(0);
    expect(normal).toHaveLength(0);
  });
});

// =====================================================================
// 2. CrewConfigPanel — button visibility logic
// =====================================================================
describe('CrewConfigPanel - restore/delete button visibility', () => {
  it('with sessionId: show both restore and delete buttons', () => {
    const btns = getExistsButtons({ sessionId: 'crew_abc' });
    expect(btns.showRestoreBtn).toBe(true);
    expect(btns.showDeleteBtn).toBe(true);
  });

  it('without sessionId: show only delete button', () => {
    const btns = getExistsButtons({});
    expect(btns.showRestoreBtn).toBe(false);
    expect(btns.showDeleteBtn).toBe(true);
  });

  it('with null sessionInfo: show only delete button', () => {
    const btns = getExistsButtons(null);
    expect(btns.showRestoreBtn).toBe(false);
    expect(btns.showDeleteBtn).toBe(true);
  });
});

// =====================================================================
// 3. deleteCrewDir — simulation
// =====================================================================
describe('deleteCrewDir method', () => {
  it('should return correct action on valid inputs', () => {
    const result = simulateDeleteCrewDir('/home/user/project', 'agent-1');
    expect(result.action).toBe('deleteCrewDir');
    expect(result.projectDir).toBe('/home/user/project');
    expect(result.agentId).toBe('agent-1');
    expect(result.newCrewCheckState).toBe('none');
    expect(result.newCrewExistsSessionInfo).toBeNull();
  });

  it('should trim projectDir', () => {
    const result = simulateDeleteCrewDir('  /project  ', 'agent-1');
    expect(result.projectDir).toBe('/project');
  });

  it('should do nothing with empty dir', () => {
    const result = simulateDeleteCrewDir('', 'agent-1');
    expect(result.action).toBeNull();
  });

  it('should do nothing with no agent', () => {
    const result = simulateDeleteCrewDir('/project', '');
    expect(result.action).toBeNull();
  });

  it('after delete, crewCheckState becomes "none" which shows create form', () => {
    const result = simulateDeleteCrewDir('/project', 'agent-1');
    expect(result.newCrewCheckState).toBe('none');
    const showCreateForm = !!('agent-1') && result.newCrewCheckState === 'none';
    expect(showCreateForm).toBe(true);
  });

  it('source: should reset crewCheckState to none after delete', () => {
    const methodStart = configContent.indexOf('deleteCrewDir()');
    const methodBlock = configContent.substring(methodStart, methodStart + 400);
    expect(methodBlock).toContain("this.crewCheckState = 'none'");
    expect(methodBlock).toContain('this.crewExistsSessionInfo = null');
  });
});

// =====================================================================
// 4. Backend: delete_crew_dir message chain
// =====================================================================
describe('delete_crew_dir - backend message chain', () => {
  it('store has deleteCrewDir action that sends delete_crew_dir message', () => {
    expect(chatStoreContent).toContain('deleteCrewDir(projectDir, agentId)');
    expect(chatStoreContent).toContain("type: 'delete_crew_dir'");
  });

  it('ws-client handles and forwards delete_crew_dir', () => {
    expect(wsClientContent).toContain("case 'delete_crew_dir'");
    const startIdx = wsClientContent.indexOf("case 'delete_crew_dir'");
    const caseBlock = wsClientContent.substring(startIdx, startIdx + 400);
    expect(caseBlock).toContain('forwardToAgent');
    expect(caseBlock).toContain('projectDir: msg.projectDir');
  });

  it('agent exports handleDeleteCrewDir with proper cleanup logic', () => {
    expect(crewJsContent).toContain('export async function handleDeleteCrewDir');
    const handler = crewJsContent.split('handleDeleteCrewDir')[1];
    const handlerEnd = handler.indexOf('\n}');
    const handlerBlock = handler.substring(0, handlerEnd);
    expect(handlerBlock).toContain("join(projectDir, '.crew')");
    expect(handlerBlock).toContain('fs.rm(');
    expect(handlerBlock).toContain('recursive: true');
  });

  it('connection.js routes delete_crew_dir to handler', () => {
    expect(connectionJsContent).toContain("case 'delete_crew_dir'");
    expect(connectionJsContent).toContain('handleDeleteCrewDir(msg)');
  });
});
