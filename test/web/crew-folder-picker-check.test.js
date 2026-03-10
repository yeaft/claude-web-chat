import { describe, it, expect, beforeAll } from 'vitest';

/**
 * Tests for commit 26b6120: fix: trigger crew check after folder picker updates projectDir
 *
 * Bug: confirmFolderPicker() only set crewPanel.projectDir without calling onWorkDirChange(),
 *      so .crew detection was not re-triggered when selecting a new folder via browse button.
 *
 * Fix: After setting crewPanel.projectDir, also call crewPanel.onWorkDirChange().
 *
 * Scenarios:
 * 1) confirmFolderPicker calls onWorkDirChange after setting projectDir for crew target
 * 2) onWorkDirChange triggers crew check when agent + projectDir are valid
 * 3) Switching directories resets crewCheckState from previous result to new detection
 * 4) The input @change="onWorkDirChange" still works (original path via typing)
 * 5) Contrast: non-crew folderPickerTarget does NOT call onWorkDirChange
 */

// =====================================================================
// Read source files
// =====================================================================
let chatPageContent;
let configContent;

beforeAll(async () => {
  const { promises: fs } = await import('fs');
  const { join } = await import('path');
  chatPageContent = await fs.readFile(
    join(process.cwd(), 'web/components/ChatPage.js'),
    'utf-8'
  );
  configContent = await fs.readFile(
    join(process.cwd(), 'web/components/CrewConfigPanel.js'),
    'utf-8'
  );
});

// =====================================================================
// Simulate the core logic
// =====================================================================

// Simulate onWorkDirChange — determines if triggerCrewCheck is called
function onWorkDirChange(selectedAgent, projectDir) {
  if (selectedAgent && projectDir.trim()) {
    return 'triggerCrewCheck';
  } else {
    return 'idle'; // resets crewCheckState to idle
  }
}

// Simulate confirmFolderPicker for crew target (FIXED version)
function confirmFolderPickerFixed(folderPickerPath, folderPickerSelected, crewPanel) {
  let path = folderPickerPath;
  if (!path) return { updated: false };
  if (folderPickerSelected) {
    const sep = path.includes('\\') ? '\\' : '/';
    path = path.replace(/[/\\]$/, '') + sep + folderPickerSelected;
  }
  // Fixed: set projectDir AND call onWorkDirChange
  crewPanel.projectDir = path;
  const checkResult = onWorkDirChange(crewPanel.selectedAgent, crewPanel.projectDir);
  return { updated: true, projectDir: path, checkResult };
}

// Simulate confirmFolderPicker for crew target (BROKEN version - before fix)
function confirmFolderPickerBroken(folderPickerPath, folderPickerSelected, crewPanel) {
  let path = folderPickerPath;
  if (!path) return { updated: false };
  if (folderPickerSelected) {
    const sep = path.includes('\\') ? '\\' : '/';
    path = path.replace(/[/\\]$/, '') + sep + folderPickerSelected;
  }
  // Bug: only sets projectDir, does NOT call onWorkDirChange
  crewPanel.projectDir = path;
  return { updated: true, projectDir: path, checkResult: null };
}

// Simulate crewCheckState transition when switching directories
function simulateDirectorySwitch(initialState, newDir, selectedAgent) {
  // Step 1: onWorkDirChange is called
  const action = onWorkDirChange(selectedAgent, newDir);
  if (action === 'triggerCrewCheck') {
    // triggerCrewCheck resets state to 'checking' immediately
    return 'checking';
  }
  return 'idle';
}

// =====================================================================
// 1. confirmFolderPicker calls onWorkDirChange for crew target
// =====================================================================
describe('confirmFolderPicker - crew target fix (26b6120)', () => {

  describe('source code verification', () => {
    // Extract the confirmFolderPicker method from ChatPage source
    function getConfirmFolderPickerMethod() {
      const methodStart = chatPageContent.indexOf('confirmFolderPicker()');
      return chatPageContent.substring(methodStart, methodStart + 600);
    }

    it('confirmFolderPicker should call crewPanel.onWorkDirChange() after setting projectDir', () => {
      const method = getConfirmFolderPickerMethod();
      expect(method).toContain('crewPanel.projectDir = path');
      expect(method).toContain('crewPanel.onWorkDirChange()');
    });

    it('onWorkDirChange call should come AFTER projectDir assignment', () => {
      const method = getConfirmFolderPickerMethod();
      const projectDirIdx = method.indexOf('crewPanel.projectDir = path');
      const onChangeIdx = method.indexOf('crewPanel.onWorkDirChange()');
      expect(projectDirIdx).toBeGreaterThan(-1);
      expect(onChangeIdx).toBeGreaterThan(-1);
      expect(projectDirIdx).toBeLessThan(onChangeIdx);
    });

    it('both projectDir assignment and onWorkDirChange should be inside crewPanel null check', () => {
      const method = getConfirmFolderPickerMethod();
      expect(method).toContain('if (crewPanel)');
      const crewPanelCheck = method.indexOf('if (crewPanel)');
      const projectDirSet = method.indexOf('crewPanel.projectDir = path');
      const onChangeCall = method.indexOf('crewPanel.onWorkDirChange()');
      expect(projectDirSet).toBeGreaterThan(crewPanelCheck);
      expect(onChangeCall).toBeGreaterThan(crewPanelCheck);
    });
  });

  describe('fixed behavior simulation', () => {
    it('should trigger crew check when folder is picked via browse button', () => {
      const crewPanel = { selectedAgent: 'agent-1', projectDir: '/old/path' };
      const result = confirmFolderPickerFixed('/new/project', '', crewPanel);
      expect(result.updated).toBe(true);
      expect(result.projectDir).toBe('/new/project');
      expect(result.checkResult).toBe('triggerCrewCheck');
      expect(crewPanel.projectDir).toBe('/new/project');
    });

    it('should trigger crew check when folder with subfolder is picked', () => {
      const crewPanel = { selectedAgent: 'agent-1', projectDir: '/old/path' };
      const result = confirmFolderPickerFixed('/home/user', 'my-project', crewPanel);
      expect(result.projectDir).toBe('/home/user/my-project');
      expect(result.checkResult).toBe('triggerCrewCheck');
    });

    it('should NOT trigger check if crewPanel has no selected agent', () => {
      const crewPanel = { selectedAgent: '', projectDir: '/old/path' };
      const result = confirmFolderPickerFixed('/new/project', '', crewPanel);
      expect(result.updated).toBe(true);
      expect(result.checkResult).toBe('idle');
    });

    it('should return not updated when path is empty', () => {
      const crewPanel = { selectedAgent: 'agent-1', projectDir: '/old/path' };
      const result = confirmFolderPickerFixed('', '', crewPanel);
      expect(result.updated).toBe(false);
    });
  });

  describe('broken behavior contrast (before fix)', () => {
    it('broken version should NOT trigger crew check (checkResult is null)', () => {
      const crewPanel = { selectedAgent: 'agent-1', projectDir: '/old/path' };
      const result = confirmFolderPickerBroken('/new/project', '', crewPanel);
      expect(result.updated).toBe(true);
      expect(result.projectDir).toBe('/new/project');
      expect(result.checkResult).toBeNull(); // Bug: no check triggered
    });

    it('broken version still updates projectDir', () => {
      const crewPanel = { selectedAgent: 'agent-1', projectDir: '/old/path' };
      confirmFolderPickerBroken('/new/project', '', crewPanel);
      expect(crewPanel.projectDir).toBe('/new/project');
    });
  });
});

// =====================================================================
// 2. onWorkDirChange triggers crew check correctly
// =====================================================================
describe('onWorkDirChange - crew check triggering', () => {

  it('should trigger check when agent is selected and dir is non-empty', () => {
    expect(onWorkDirChange('agent-1', '/some/dir')).toBe('triggerCrewCheck');
  });

  it('should reset to idle when dir is empty', () => {
    expect(onWorkDirChange('agent-1', '')).toBe('idle');
  });

  it('should reset to idle when dir is whitespace only', () => {
    expect(onWorkDirChange('agent-1', '   ')).toBe('idle');
  });

  it('should reset to idle when no agent is selected', () => {
    expect(onWorkDirChange('', '/some/dir')).toBe('idle');
  });

  it('source: onWorkDirChange calls triggerCrewCheck when conditions met', () => {
    expect(configContent).toContain('onWorkDirChange()');
    expect(configContent).toContain('this.triggerCrewCheck()');
  });

  it('source: onWorkDirChange resets to idle when conditions not met', () => {
    expect(configContent).toContain("this.crewCheckState = 'idle'");
  });
});

// =====================================================================
// 3. Directory switch resets crewCheckState
// =====================================================================
describe('directory switch - crewCheckState transitions', () => {

  it('switching from dir-A to dir-B should reset to "checking"', () => {
    const newState = simulateDirectorySwitch('exists', '/new/dir', 'agent-1');
    expect(newState).toBe('checking');
  });

  it('switching from "none" state to another dir should go to "checking"', () => {
    const newState = simulateDirectorySwitch('none', '/another/dir', 'agent-1');
    expect(newState).toBe('checking');
  });

  it('switching to empty dir should go to "idle"', () => {
    const newState = simulateDirectorySwitch('exists', '', 'agent-1');
    expect(newState).toBe('idle');
  });

  it('source: triggerCrewCheck sets state to "checking" immediately', () => {
    expect(configContent).toContain("this.crewCheckState = 'checking'");
  });

  it('source: triggerCrewCheck clears previous sessionInfo', () => {
    expect(configContent).toContain('this.crewExistsSessionInfo = null');
  });
});

// =====================================================================
// 4. Input @change="onWorkDirChange" still works (original typing path)
// =====================================================================
describe('input field onWorkDirChange binding', () => {

  it('workspace input should have @change="onWorkDirChange" binding', () => {
    expect(configContent).toContain('@change="onWorkDirChange"');
  });

  it('workspace input should have v-model="projectDir"', () => {
    expect(configContent).toContain('v-model="projectDir"');
  });

  it('both typing and browse should use the same onWorkDirChange method', () => {
    // Input uses @change="onWorkDirChange" (typing)
    // Browse uses confirmFolderPicker → crewPanel.onWorkDirChange() (browse)
    // Both call the same method
    expect(configContent).toContain('@change="onWorkDirChange"');
    expect(chatPageContent).toContain('crewPanel.onWorkDirChange()');
  });
});

// =====================================================================
// 5. Non-crew folderPickerTarget does NOT call onWorkDirChange
// =====================================================================
describe('non-crew folderPickerTarget behavior', () => {

  it('convModal path should set convModalWorkDir (not call onWorkDirChange)', () => {
    // The confirmFolderPicker method: after the crew/roleplay returns, convModalWorkDir is set
    const method = chatPageContent.substring(
      chatPageContent.indexOf('confirmFolderPicker()'),
      chatPageContent.indexOf('confirmFolderPicker()') + 1200
    );
    expect(method).toContain('this.convModalWorkDir = path');
  });

  it('confirmFolderPicker should return early after crew target handling', () => {
    // In the confirmFolderPicker method, the crew block ends with return;
    const method = chatPageContent.substring(
      chatPageContent.indexOf('confirmFolderPicker()'),
      chatPageContent.indexOf('confirmFolderPicker()') + 1200
    );
    // crew block has: this.folderPickerOpen = false; return;
    // then convModalWorkDir comes after
    const crewReturnIdx = method.indexOf('return;');
    const convModalIdx = method.indexOf('this.convModalWorkDir');
    expect(crewReturnIdx).toBeGreaterThan(-1);
    expect(convModalIdx).toBeGreaterThan(-1);
    expect(crewReturnIdx).toBeLessThan(convModalIdx);
  });
});

// =====================================================================
// 6. Edge cases for folder picker path construction
// =====================================================================
describe('folder picker path construction edge cases', () => {

  it('should append selected subfolder with path separator', () => {
    const crewPanel = { selectedAgent: 'agent-1', projectDir: '' };
    const result = confirmFolderPickerFixed('/home/user/projects', 'my-app', crewPanel);
    expect(result.projectDir).toBe('/home/user/projects/my-app');
  });

  it('should handle trailing slash in base path', () => {
    const crewPanel = { selectedAgent: 'agent-1', projectDir: '' };
    const result = confirmFolderPickerFixed('/home/user/projects/', 'my-app', crewPanel);
    expect(result.projectDir).toBe('/home/user/projects/my-app');
  });

  it('should use base path directly when no subfolder is selected', () => {
    const crewPanel = { selectedAgent: 'agent-1', projectDir: '' };
    const result = confirmFolderPickerFixed('/home/user/projects', '', crewPanel);
    expect(result.projectDir).toBe('/home/user/projects');
  });

  it('should handle Windows-style paths', () => {
    const crewPanel = { selectedAgent: 'agent-1', projectDir: '' };
    const result = confirmFolderPickerFixed('C:\\Users\\dev\\projects', 'my-app', crewPanel);
    expect(result.projectDir).toBe('C:\\Users\\dev\\projects\\my-app');
  });

  it('should handle Windows trailing backslash', () => {
    const crewPanel = { selectedAgent: 'agent-1', projectDir: '' };
    const result = confirmFolderPickerFixed('C:\\Users\\dev\\projects\\', 'my-app', crewPanel);
    expect(result.projectDir).toBe('C:\\Users\\dev\\projects\\my-app');
  });
});

// =====================================================================
// 7. Full flow simulation: browse → pick → check → result
// =====================================================================
describe('full flow: browse folder → crew check → result', () => {

  it('should transition: idle → (browse pick) → checking → exists/none', () => {
    // Initial state
    let crewCheckState = 'idle';
    const crewPanel = { selectedAgent: 'agent-1', projectDir: '/old/path' };

    // Step 1: User clicks browse, picks a new folder
    const pickResult = confirmFolderPickerFixed('/new/project', '', crewPanel);
    expect(pickResult.checkResult).toBe('triggerCrewCheck');
    crewCheckState = 'checking'; // triggerCrewCheck sets this

    // Step 2: Server responds with crew_exists_result
    const storeResult = {
      exists: true,
      projectDir: '/new/project',
      sessionInfo: { sessionId: 'crew_abc', name: 'Team X' }
    };
    if (storeResult.projectDir === crewPanel.projectDir.trim()) {
      crewCheckState = storeResult.exists ? 'exists' : 'none';
    }
    expect(crewCheckState).toBe('exists');
  });

  it('should handle rapid directory switches (last one wins)', () => {
    const crewPanel = { selectedAgent: 'agent-1', projectDir: '' };

    // First pick
    confirmFolderPickerFixed('/dir/a', '', crewPanel);
    expect(crewPanel.projectDir).toBe('/dir/a');

    // Second pick (rapid switch)
    confirmFolderPickerFixed('/dir/b', '', crewPanel);
    expect(crewPanel.projectDir).toBe('/dir/b');

    // Result for /dir/a arrives — should be ignored (projectDir mismatch)
    const staleResult = { exists: true, projectDir: '/dir/a', sessionInfo: null };
    const matches = staleResult.projectDir === crewPanel.projectDir.trim();
    expect(matches).toBe(false); // Stale result ignored

    // Result for /dir/b arrives — should be accepted
    const freshResult = { exists: false, projectDir: '/dir/b', sessionInfo: null };
    const matchesFresh = freshResult.projectDir === crewPanel.projectDir.trim();
    expect(matchesFresh).toBe(true);
  });
});
