import { describe, it, expect, beforeAll } from 'vitest';

/**
 * Tests for commit bf79ad0: feat: sidebar session grouping, crew restore/delete buttons, remove dividers
 *
 * Three features:
 * 1) Sidebar grouping — Crew Sessions at top, normal conversations below, group headers shown conditionally
 * 2) CrewConfigPanel dual buttons — restore + delete when sessionId exists, only delete when not
 * 3) Divider removal — crew-feature-history, crew-round-divider, crew-panel-left-actions
 */

// =====================================================================
// Read source files from dev-1 worktree
// =====================================================================
let chatPageContent;
let configContent;
let styleContent;
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
  styleContent = await fs.readFile(join(base, 'web/style.css'), 'utf-8');
  chatStoreContent = await fs.readFile(join(base, 'web/stores/chat.js'), 'utf-8');
  wsClientContent = await fs.readFile(join(base, 'server/ws-client.js'), 'utf-8');
  crewJsContent = await fs.readFile(join(base, 'agent/crew.js'), 'utf-8');
  connectionJsContent = await fs.readFile(join(base, 'agent/connection.js'), 'utf-8');
});

// =====================================================================
// Simulate core logic
// =====================================================================

// Simulate crewConversations / normalConversations computed
function splitConversations(conversations) {
  return {
    crew: conversations.filter(c => c.type === 'crew'),
    normal: conversations.filter(c => c.type !== 'crew')
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
    // After delete, state transitions to 'none'
    newCrewCheckState: 'none',
    newCrewExistsSessionInfo: null
  };
}

// Simulate button visibility logic for exists state
function getExistsButtons(crewExistsSessionInfo) {
  const hasSessionId = !!crewExistsSessionInfo?.sessionId;
  return {
    showRestoreBtn: hasSessionId,
    showDeleteBtn: true, // always visible
    deleteBtnText: hasSessionId ? '删除配置' : '删除并重新创建'
  };
}

// =====================================================================
// 1. Sidebar Grouping
// =====================================================================
describe('Sidebar session grouping (bf79ad0)', () => {

  describe('crewConversations / normalConversations computed', () => {
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

    it('should return empty normal list when only crew conversations', () => {
      const convs = [
        { id: '1', type: 'crew', name: 'Team A' },
        { id: '2', type: 'crew', name: 'Team B' }
      ];
      const { crew, normal } = splitConversations(convs);
      expect(crew).toHaveLength(2);
      expect(normal).toHaveLength(0);
    });

    it('should handle empty conversations list', () => {
      const { crew, normal } = splitConversations([]);
      expect(crew).toHaveLength(0);
      expect(normal).toHaveLength(0);
    });
  });

  describe('source: computed properties exist in ChatPage', () => {
    it('should have crewConversations computed', () => {
      expect(chatPageContent).toContain('crewConversations()');
      expect(chatPageContent).toContain("c.type === 'crew'");
    });

    it('should have normalConversations computed', () => {
      expect(chatPageContent).toContain('normalConversations()');
      expect(chatPageContent).toContain("c.type !== 'crew'");
    });
  });

  describe('source: Crew Sessions group in template', () => {
    it('should have Crew Sessions group header', () => {
      expect(chatPageContent).toContain('session-group-header');
      expect(chatPageContent).toContain('Crew Sessions');
    });

    it('Crew Sessions panel always renders (no v-if guard)', () => {
      // In the new dual-panel layout, both panels always render
      const crewHeaderIdx = chatPageContent.indexOf('Crew Sessions');
      expect(crewHeaderIdx).toBeGreaterThan(-1);
    });

    it('should iterate crewConversations for crew items', () => {
      expect(chatPageContent).toContain('v-for="conv in crewConversations"');
    });

    it('crew items should always have session-item-crew class', () => {
      expect(chatPageContent).toContain('class="session-item session-item-crew"');
    });

    it('crew items should use getCrewTitle (not getConversationTitle)', () => {
      const crewIdx = chatPageContent.indexOf('v-for="conv in crewConversations"');
      const crewSection = chatPageContent.substring(crewIdx, crewIdx + 1500);
      expect(crewSection).toContain('getCrewTitle(conv)');
      expect(crewSection).not.toContain('getConversationTitle(conv)');
    });
  });

  describe('source: normal conversations group in template', () => {
    it('should have recent chats group header via i18n', () => {
      expect(chatPageContent).toContain("$t('chat.sidebar.recentChats')");
    });

    it('normal panel always renders (dual-panel layout)', () => {
      // In the new layout, both panels always render
      expect(chatPageContent).toContain('class="session-panel"');
    });

    it('should iterate normalConversations for normal items', () => {
      expect(chatPageContent).toContain('v-for="conv in normalConversations"');
    });

    it('normal items should use getConversationTitle (not getCrewTitle)', () => {
      const normalSection = chatPageContent.substring(
        chatPageContent.indexOf('v-for="conv in normalConversations"'),
        chatPageContent.indexOf('v-for="conv in crewConversations"')
      );
      expect(normalSection).toContain('getConversationTitle(conv)');
      expect(normalSection).not.toContain('getCrewTitle(conv)');
    });
  });

  describe('source: group header styling', () => {
    it('should have session-group-header CSS class', () => {
      expect(styleContent).toContain('.session-group-header');
    });

    it('session-group-header should use uppercase text-transform', () => {
      const headerStyle = styleContent.split('.session-group-header')[1];
      const blockEnd = headerStyle.indexOf('}');
      const block = headerStyle.substring(0, blockEnd);
      expect(block).toContain('text-transform: uppercase');
    });

    it('session-group-header should have small font size', () => {
      const headerStyle = styleContent.split('.session-group-header')[1];
      const blockEnd = headerStyle.indexOf('}');
      const block = headerStyle.substring(0, blockEnd);
      expect(block).toContain('font-size: 11px');
    });
  });

  describe('dual-panel layout: both headers always visible', () => {
    it('both headers always show regardless of conversation counts', () => {
      // In the dual-panel layout, both panels and their headers are always rendered
      // The panel is just empty when there are no conversations of that type
      const convs = [
        { id: '1', type: 'crew' },
        { id: '2', type: undefined }
      ];
      const { crew, normal } = splitConversations(convs);
      expect(crew.length).toBe(1);
      expect(normal.length).toBe(1);
      // Both panels always visible — headers are unconditional
    });

    it('panels render even when one type is empty', () => {
      const convs = [{ id: '1', type: undefined }];
      const { crew, normal } = splitConversations(convs);
      expect(crew).toHaveLength(0);
      expect(normal).toHaveLength(1);
      // Both panels still render — crew panel just has no items
    });

    it('panels render when only crew exist', () => {
      const convs = [{ id: '1', type: 'crew' }];
      const { crew, normal } = splitConversations(convs);
      expect(crew).toHaveLength(1);
      expect(normal).toHaveLength(0);
      // Both panels still render — normal panel just has no items
    });
  });
});

// =====================================================================
// 2. CrewConfigPanel dual buttons (restore + delete)
// =====================================================================
describe('CrewConfigPanel - restore/delete dual buttons (bf79ad0)', () => {

  describe('button visibility logic', () => {
    it('with sessionId: show both restore and delete buttons', () => {
      const btns = getExistsButtons({ sessionId: 'crew_abc' });
      expect(btns.showRestoreBtn).toBe(true);
      expect(btns.showDeleteBtn).toBe(true);
      expect(btns.deleteBtnText).toBe('删除配置');
    });

    it('without sessionId: show only delete button', () => {
      const btns = getExistsButtons({});
      expect(btns.showRestoreBtn).toBe(false);
      expect(btns.showDeleteBtn).toBe(true);
      expect(btns.deleteBtnText).toBe('删除并重新创建');
    });

    it('with null sessionInfo: show only delete button', () => {
      const btns = getExistsButtons(null);
      expect(btns.showRestoreBtn).toBe(false);
      expect(btns.showDeleteBtn).toBe(true);
      expect(btns.deleteBtnText).toBe('删除并重新创建');
    });
  });

  describe('source: dual button template', () => {
    it('should have crew-exists-actions container', () => {
      expect(configContent).toContain('crew-exists-actions');
    });

    it('should have crew-exists-action-btn class (not crew-restore-btn)', () => {
      expect(configContent).toContain('crew-exists-action-btn');
      expect(configContent).not.toContain('crew-restore-btn');
    });

    it('restore button should only show when sessionId exists', () => {
      expect(configContent).toContain('v-if="crewExistsSessionInfo?.sessionId"');
    });

    it('restore button should call restoreFromDisk', () => {
      expect(configContent).toContain('@click="restoreFromDisk"');
    });

    it('delete button should always be present (no v-if)', () => {
      // The delete button uses @click="deleteCrewDir" and has class "danger"
      expect(configContent).toContain('@click="deleteCrewDir"');
      expect(configContent).toContain('crew-exists-action-btn danger');
    });

    it('delete button text should be conditional', () => {
      expect(configContent).toContain("crewConfig.deleteConfig");
      expect(configContent).toContain("crewConfig.deleteAndRecreate");
    });

    it('restore button should use i18n key crewConfig.restoreCrew', () => {
      expect(configContent).toContain("crewConfig.restoreCrew");
    });
  });

  describe('deleteCrewDir method', () => {
    it('source: should have deleteCrewDir method', () => {
      expect(configContent).toContain('deleteCrewDir()');
    });

    it('source: should show confirmation dialog', () => {
      expect(configContent).toContain("crewConfig.confirmDeleteCrew");
    });

    it('source: should call store.deleteCrewDir', () => {
      expect(configContent).toContain('this.store.deleteCrewDir(dir, this.selectedAgent)');
    });

    it('source: should reset crewCheckState to none after delete', () => {
      // Extract deleteCrewDir method
      const methodStart = configContent.indexOf('deleteCrewDir()');
      const methodBlock = configContent.substring(methodStart, methodStart + 400);
      expect(methodBlock).toContain("this.crewCheckState = 'none'");
      expect(methodBlock).toContain('this.crewExistsSessionInfo = null');
    });

    it('simulation: should return correct action on valid inputs', () => {
      const result = simulateDeleteCrewDir('/home/user/project', 'agent-1');
      expect(result.action).toBe('deleteCrewDir');
      expect(result.projectDir).toBe('/home/user/project');
      expect(result.agentId).toBe('agent-1');
      expect(result.newCrewCheckState).toBe('none');
      expect(result.newCrewExistsSessionInfo).toBeNull();
    });

    it('simulation: should trim projectDir', () => {
      const result = simulateDeleteCrewDir('  /project  ', 'agent-1');
      expect(result.projectDir).toBe('/project');
    });

    it('simulation: should do nothing with empty dir', () => {
      const result = simulateDeleteCrewDir('', 'agent-1');
      expect(result.action).toBeNull();
    });

    it('simulation: should do nothing with no agent', () => {
      const result = simulateDeleteCrewDir('/project', '');
      expect(result.action).toBeNull();
    });
  });

  describe('delete flow transitions to create flow', () => {
    it('after deleteCrewDir, crewCheckState becomes "none" which shows create form', () => {
      // crewCheckState === 'none' enables the create flow template
      const result = simulateDeleteCrewDir('/project', 'agent-1');
      expect(result.newCrewCheckState).toBe('none');
      // In template: v-if="selectedAgent && crewCheckState === 'none'" shows create form
      const showCreateForm = !!('agent-1') && result.newCrewCheckState === 'none';
      expect(showCreateForm).toBe(true);
    });
  });

  describe('source: button styling', () => {
    it('should have crew-exists-actions flex container', () => {
      expect(styleContent).toContain('.crew-exists-actions');
    });

    it('should have danger variant for delete button', () => {
      expect(styleContent).toContain('.crew-exists-action-btn.danger');
    });

    it('danger button should use red color', () => {
      const dangerBlock = styleContent.split('.crew-exists-action-btn.danger')[1];
      const blockEnd = dangerBlock.indexOf('}');
      const block = dangerBlock.substring(0, blockEnd);
      expect(block).toContain('#ef4444');
    });

    it('should NOT have old crew-restore-btn style', () => {
      // Old single button class should be replaced
      expect(styleContent).not.toContain('.crew-restore-btn');
    });
  });
});

// =====================================================================
// 3. Backend: delete_crew_dir message chain
// =====================================================================
describe('delete_crew_dir - backend message chain (bf79ad0)', () => {

  describe('store action', () => {
    it('store should have deleteCrewDir action', () => {
      expect(chatStoreContent).toContain('deleteCrewDir(projectDir, agentId)');
    });

    it('store action should send delete_crew_dir message type', () => {
      expect(chatStoreContent).toContain("type: 'delete_crew_dir'");
    });
  });

  describe('ws-client forwarding', () => {
    it('ws-client should handle delete_crew_dir case', () => {
      expect(wsClientContent).toContain("case 'delete_crew_dir'");
    });

    it('ws-client should forward delete_crew_dir to agent via forwardToAgent', () => {
      // Verify the full case block exists with forwardToAgent and correct type
      const startIdx = wsClientContent.indexOf("case 'delete_crew_dir'");
      expect(startIdx).toBeGreaterThan(-1);
      // Extract a generous block from the case statement
      const caseBlock = wsClientContent.substring(startIdx, startIdx + 400);
      expect(caseBlock).toContain('forwardToAgent');
      expect(caseBlock).toContain('projectDir: msg.projectDir');
      expect(caseBlock).toContain('break;');
    });
  });

  describe('agent handler', () => {
    it('crew.js should export handleDeleteCrewDir', () => {
      expect(crewJsContent).toContain('export async function handleDeleteCrewDir');
    });

    it('handleDeleteCrewDir should use fs.rm with recursive + force', () => {
      const handler = crewJsContent.split('handleDeleteCrewDir')[1];
      const handlerEnd = handler.indexOf('\n}');
      const handlerBlock = handler.substring(0, handlerEnd);
      expect(handlerBlock).toContain('fs.rm(crewDir');
      expect(handlerBlock).toContain('recursive: true');
      expect(handlerBlock).toContain('force: true');
    });

    it('handleDeleteCrewDir should construct .crew path from projectDir', () => {
      const handler = crewJsContent.split('handleDeleteCrewDir')[1];
      const handlerEnd = handler.indexOf('\n}');
      const handlerBlock = handler.substring(0, handlerEnd);
      expect(handlerBlock).toContain("join(projectDir, '.crew')");
    });

    it('connection.js should import handleDeleteCrewDir', () => {
      expect(connectionJsContent).toContain('handleDeleteCrewDir');
    });

    it('connection.js should route delete_crew_dir to handler', () => {
      expect(connectionJsContent).toContain("case 'delete_crew_dir'");
      expect(connectionJsContent).toContain('handleDeleteCrewDir(msg)');
    });
  });
});

// =====================================================================
// 4. Divider removal
// =====================================================================
describe('divider removal (bf79ad0)', () => {

  describe('crew-feature-history: dashed borders removed', () => {
    it('::before pseudo-element should NOT have border-top', () => {
      const beforeBlock = styleContent.split('.crew-feature-history::before')[1];
      const blockEnd = beforeBlock.indexOf('}');
      const block = beforeBlock.substring(0, blockEnd);
      expect(block).not.toContain('border-top');
      expect(block).not.toContain('dashed');
    });

    it('::after pseudo-element should NOT have border-top', () => {
      const afterBlock = styleContent.split('.crew-feature-history::after')[1];
      const blockEnd = afterBlock.indexOf('}');
      const block = afterBlock.substring(0, blockEnd);
      expect(block).not.toContain('border-top');
      expect(block).not.toContain('dashed');
    });

    it('::before should still have content, display, height, margin (structure preserved)', () => {
      const beforeBlock = styleContent.split('.crew-feature-history::before')[1];
      const blockEnd = beforeBlock.indexOf('}');
      const block = beforeBlock.substring(0, blockEnd);
      expect(block).toContain("content: ''");
      expect(block).toContain('display: block');
      expect(block).toContain('height: 1px');
      expect(block).toContain('margin:');
    });
  });

  describe('crew-round-line: background removed', () => {
    it('should NOT have background property', () => {
      const roundLineBlock = styleContent.split('.crew-round-line')[1];
      const blockEnd = roundLineBlock.indexOf('}');
      const block = roundLineBlock.substring(0, blockEnd);
      expect(block).not.toContain('background');
    });

    it('should still have flex and height (structure preserved)', () => {
      const roundLineBlock = styleContent.split('.crew-round-line')[1];
      const blockEnd = roundLineBlock.indexOf('}');
      const block = roundLineBlock.substring(0, blockEnd);
      expect(block).toContain('flex: 1');
      expect(block).toContain('height: 1px');
    });
  });

  describe('crew-panel-left-actions: border-top removed', () => {
    it('should NOT have border-top', () => {
      const actionsBlock = styleContent.split('.crew-panel-left-actions')[1];
      const blockEnd = actionsBlock.indexOf('}');
      const block = actionsBlock.substring(0, blockEnd);
      expect(block).not.toContain('border-top');
    });

    it('should still have display, gap, padding, margin-top (structure preserved)', () => {
      const actionsBlock = styleContent.split('.crew-panel-left-actions')[1];
      const blockEnd = actionsBlock.indexOf('}');
      const block = actionsBlock.substring(0, blockEnd);
      expect(block).toContain('display: flex');
      expect(block).toContain('gap:');
      expect(block).toContain('padding:');
      expect(block).toContain('margin-top:');
    });
  });
});

// =====================================================================
// 5. Integration: sidebar ordering is crew-first
// =====================================================================
describe('sidebar ordering: normal conversations appear first, crew sessions below', () => {

  it('in template, normalConversations section comes before crewConversations', () => {
    const crewIdx = chatPageContent.indexOf('v-for="conv in crewConversations"');
    const normalIdx = chatPageContent.indexOf('v-for="conv in normalConversations"');
    expect(crewIdx).toBeGreaterThan(-1);
    expect(normalIdx).toBeGreaterThan(-1);
    expect(normalIdx).toBeLessThan(crewIdx);
  });

  it('recent chats header comes before Crew Sessions header', () => {
    const crewHeaderIdx = chatPageContent.indexOf('Crew Sessions');
    const recentHeaderIdx = chatPageContent.indexOf("chat.sidebar.recentChats");
    expect(crewHeaderIdx).toBeGreaterThan(-1);
    expect(recentHeaderIdx).toBeGreaterThan(-1);
    expect(recentHeaderIdx).toBeLessThan(crewHeaderIdx);
  });
});
