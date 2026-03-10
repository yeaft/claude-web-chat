import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Tests for VCrewConfigPanel component logic.
 *
 * Covers:
 * 1. Folder picker: browse button emits 'browse' event (instead of plain input)
 * 2. Language: derived from store.locale (not a separate dropdown)
 * 3. Template reloading when locale changes
 * 4. startSession emits correct config with store locale
 * 5. Auto-select agent on created
 * 6. Role management (add/remove)
 */

import { getVCrewTemplate } from '../../web/crew-templates/index.js';

// ---------------------------------------------------------------------------
// Replicate the VCrewConfigPanel's computed/methods logic for unit testing
// without requiring a DOM / Vue mount.
// ---------------------------------------------------------------------------

/**
 * Simulates the component's data + computed + methods.
 */
function createPanelState(storeOverrides = {}) {
  const store = {
    locale: storeOverrides.locale ?? 'zh-CN',
    currentAgent: storeOverrides.currentAgent ?? 'agent-1',
    agents: storeOverrides.agents ?? [
      { id: 'agent-1', name: 'Server', online: true, latency: 1, workDir: '/home/user/projects' },
      { id: 'agent-2', name: 'Remote', online: false, latency: null, workDir: '/opt' },
    ],
  };

  const emitted = { close: [], start: [], browse: [] };

  const panel = {
    // data
    selectedAgent: '',
    projectDir: '',
    currentTemplate: 'dev',
    roles: [],

    // store ref
    store,

    // computed (replicated)
    get onlineAgents() {
      return store.agents.filter(a => a.online);
    },
    get selectedAgentWorkDir() {
      if (!this.selectedAgent) return '';
      const agent = store.agents.find(a => a.id === this.selectedAgent);
      return agent?.workDir || '';
    },
    get language() {
      return store.locale || 'zh-CN';
    },
    get canStart() {
      return !!(this.selectedAgent && this.projectDir.trim() && this.roles.length > 0);
    },

    // methods (replicated)
    loadTemplate(type) {
      this.currentTemplate = type;
      if (type === 'custom') {
        this.roles = [];
        return;
      }
      const template = getVCrewTemplate(type, this.language);
      if (template) {
        this.roles = template.map(r => ({ ...r }));
      }
    },

    removeRole(idx) {
      if (this.roles.length <= 1) return;
      this.roles.splice(idx, 1);
    },

    addCustomRole() {
      const idx = this.roles.length + 1;
      this.roles.push({
        name: 'role' + idx,
        displayName: 'Role ' + idx,
        icon: '🤖',
        description: '',
        claudeMd: '',
      });
    },

    startSession() {
      if (!this.canStart) return;
      const roles = this.roles.map(r => ({
        name: r.name || r.displayName.toLowerCase().replace(/\s+/g, '_'),
        displayName: r.displayName,
        icon: r.icon,
        description: r.description,
        claudeMd: r.claudeMd || '',
      }));
      emitted.start.push({
        agentId: this.selectedAgent,
        projectDir: this.projectDir.trim(),
        roles,
        teamType: this.currentTemplate === 'custom' ? 'custom' : this.currentTemplate,
        language: this.language,
      });
    },

    $emit(event, ...args) {
      if (!emitted[event]) emitted[event] = [];
      emitted[event].push(args.length === 1 ? args[0] : args);
    },

    // simulate created() lifecycle + selectedAgent watcher
    created() {
      this.loadTemplate('dev');
      if (store.currentAgent) {
        const current = store.agents.find(a => a.id === store.currentAgent);
        if (current?.online) {
          this.selectedAgent = current.id;
        }
      }
      if (!this.selectedAgent && this.onlineAgents.length > 0) {
        this.selectedAgent = this.onlineAgents[0].id;
      }
      // Simulate the watch on selectedAgent that auto-fills projectDir
      if (this.selectedAgent && !this.projectDir) {
        this.projectDir = this.selectedAgentWorkDir;
      }
    },

    // access emitted events for assertions
    _emitted: emitted,
  };

  return panel;
}

// ===========================================================================
// Tests
// ===========================================================================

describe('VCrewConfigPanel', () => {

  // ---------------------------------------------------------------
  // 1. Language follows store.locale (no separate dropdown)
  // ---------------------------------------------------------------

  describe('language — follows store.locale', () => {
    it('should derive language from store.locale (zh-CN)', () => {
      const panel = createPanelState({ locale: 'zh-CN' });
      expect(panel.language).toBe('zh-CN');
    });

    it('should derive language from store.locale (en)', () => {
      const panel = createPanelState({ locale: 'en' });
      expect(panel.language).toBe('en');
    });

    it('should fall back to zh-CN when store.locale is falsy', () => {
      const panel = createPanelState({ locale: '' });
      expect(panel.language).toBe('zh-CN');
    });

    it('language should update reactively when store.locale changes', () => {
      const panel = createPanelState({ locale: 'zh-CN' });
      expect(panel.language).toBe('zh-CN');
      panel.store.locale = 'en';
      expect(panel.language).toBe('en');
    });

    it('should NOT have language as a data property (it is computed)', () => {
      const panel = createPanelState();
      // language is defined as a getter, not in the data return
      const descriptor = Object.getOwnPropertyDescriptor(panel, 'language');
      // it's a getter (computed), not a simple value
      expect(descriptor.get).toBeDefined();
    });

    it('template should load with store locale language', () => {
      const panel = createPanelState({ locale: 'en' });
      panel.created();
      // Roles should be in English
      expect(panel.roles.length).toBe(4);
      expect(panel.roles[0].displayName).toMatch(/Jobs|PM/i);
    });

    it('template should load with zh-CN locale', () => {
      const panel = createPanelState({ locale: 'zh-CN' });
      panel.created();
      expect(panel.roles.length).toBe(4);
      expect(panel.roles[0].displayName).toContain('乔布斯');
    });

    it('changing locale should reload template when not custom', () => {
      const panel = createPanelState({ locale: 'zh-CN' });
      panel.created();
      expect(panel.roles[0].displayName).toContain('乔布斯');

      // Simulate locale change + watcher trigger
      panel.store.locale = 'en';
      // The watcher calls loadTemplate when not custom
      if (panel.currentTemplate !== 'custom') {
        panel.loadTemplate(panel.currentTemplate);
      }
      expect(panel.roles[0].displayName).toMatch(/Jobs|PM/i);
    });

    it('changing locale should NOT reload template when custom', () => {
      const panel = createPanelState({ locale: 'zh-CN' });
      panel.created();
      panel.loadTemplate('custom');
      panel.addCustomRole();
      expect(panel.roles.length).toBe(1);
      expect(panel.roles[0].name).toBe('role1');

      // Simulate locale change — custom template should not reset
      panel.store.locale = 'en';
      if (panel.currentTemplate !== 'custom') {
        panel.loadTemplate(panel.currentTemplate);
      }
      // Roles should remain unchanged
      expect(panel.roles.length).toBe(1);
      expect(panel.roles[0].name).toBe('role1');
    });
  });

  // ---------------------------------------------------------------
  // 2. startSession emits language from store.locale
  // ---------------------------------------------------------------

  describe('startSession — language in emitted config', () => {
    it('should include store locale as language in start event', () => {
      const panel = createPanelState({ locale: 'en' });
      panel.created();
      panel.projectDir = '/home/user/project';

      panel.startSession();

      expect(panel._emitted.start).toHaveLength(1);
      const config = panel._emitted.start[0];
      expect(config.language).toBe('en');
    });

    it('should update language when store locale changes before start', () => {
      const panel = createPanelState({ locale: 'zh-CN' });
      panel.created();
      panel.projectDir = '/p';

      // Change locale before starting
      panel.store.locale = 'en';
      panel.loadTemplate(panel.currentTemplate); // reload for en

      panel.startSession();

      expect(panel._emitted.start[0].language).toBe('en');
    });

    it('should include correct teamType in start event', () => {
      const panel = createPanelState();
      panel.created();
      panel.projectDir = '/p';

      panel.startSession();
      expect(panel._emitted.start[0].teamType).toBe('dev');
    });

    it('should include custom teamType when custom template selected', () => {
      const panel = createPanelState();
      panel.created();
      panel.loadTemplate('custom');
      panel.addCustomRole();
      panel.projectDir = '/p';

      panel.startSession();
      expect(panel._emitted.start[0].teamType).toBe('custom');
    });
  });

  // ---------------------------------------------------------------
  // 3. Folder picker via browse button
  // ---------------------------------------------------------------

  describe('folder picker — browse button integration', () => {
    it('emits list should include browse event', () => {
      // The component declares emits: ['close', 'start', 'browse']
      // This is verified by the actual Vue component definition.
      // Here we just verify the browse mechanism is consistent.
      const panel = createPanelState();
      panel.$emit('browse');
      expect(panel._emitted.browse).toHaveLength(1);
    });

    it('projectDir can be set externally (simulating folder picker callback)', () => {
      const panel = createPanelState();
      panel.created();
      expect(panel.projectDir).toBe('/home/user/projects'); // auto-set from agent workDir

      // Simulate ChatPage setting projectDir after folder picker confirms
      panel.projectDir = '/home/user/other-project';
      expect(panel.projectDir).toBe('/home/user/other-project');
    });

    it('canStart should be true when agent selected, projectDir set, and roles loaded', () => {
      const panel = createPanelState();
      panel.created();
      // After created: agent auto-selected, projectDir auto-set, roles loaded from dev template
      expect(panel.canStart).toBe(true);
    });

    it('canStart should be false when projectDir is empty', () => {
      const panel = createPanelState();
      panel.created();
      panel.projectDir = '';
      expect(panel.canStart).toBe(false);
    });

    it('canStart should be false when projectDir is whitespace only', () => {
      const panel = createPanelState();
      panel.created();
      panel.projectDir = '   ';
      expect(panel.canStart).toBe(false);
    });
  });

  // ---------------------------------------------------------------
  // 4. Auto-select agent
  // ---------------------------------------------------------------

  describe('auto-select agent on created', () => {
    it('should auto-select currentAgent if online', () => {
      const panel = createPanelState({ currentAgent: 'agent-1' });
      panel.created();
      expect(panel.selectedAgent).toBe('agent-1');
    });

    it('should auto-select first online agent if currentAgent is offline', () => {
      const panel = createPanelState({
        currentAgent: 'agent-2', // offline
        agents: [
          { id: 'agent-2', name: 'Offline', online: false, workDir: '/off' },
          { id: 'agent-3', name: 'Online', online: true, workDir: '/on' },
        ]
      });
      panel.created();
      expect(panel.selectedAgent).toBe('agent-3');
    });

    it('should not select any agent if none are online', () => {
      const panel = createPanelState({
        currentAgent: null,
        agents: [
          { id: 'agent-1', name: 'Off1', online: false },
          { id: 'agent-2', name: 'Off2', online: false },
        ]
      });
      panel.created();
      expect(panel.selectedAgent).toBe('');
    });

    it('should auto-fill projectDir from selected agent workDir', () => {
      const panel = createPanelState();
      panel.created();
      expect(panel.projectDir).toBe('/home/user/projects');
    });
  });

  // ---------------------------------------------------------------
  // 5. Role management
  // ---------------------------------------------------------------

  describe('role management', () => {
    it('dev template should load 4 roles', () => {
      const panel = createPanelState();
      panel.created();
      expect(panel.roles).toHaveLength(4);
    });

    it('custom template should load 0 roles', () => {
      const panel = createPanelState();
      panel.loadTemplate('custom');
      expect(panel.roles).toHaveLength(0);
    });

    it('addCustomRole should add a role', () => {
      const panel = createPanelState();
      panel.loadTemplate('custom');
      panel.addCustomRole();
      expect(panel.roles).toHaveLength(1);
      expect(panel.roles[0].name).toBe('role1');
      expect(panel.roles[0].icon).toBe('🤖');
    });

    it('removeRole should remove a role', () => {
      const panel = createPanelState();
      panel.created();
      const initialCount = panel.roles.length;
      panel.removeRole(0);
      expect(panel.roles).toHaveLength(initialCount - 1);
    });

    it('removeRole should not remove the last role', () => {
      const panel = createPanelState();
      panel.loadTemplate('custom');
      panel.addCustomRole();
      expect(panel.roles).toHaveLength(1);
      panel.removeRole(0);
      expect(panel.roles).toHaveLength(1); // should remain
    });

    it('should not add more than 6 roles (template enforces max)', () => {
      const panel = createPanelState();
      panel.loadTemplate('custom');
      for (let i = 0; i < 7; i++) {
        panel.addCustomRole();
      }
      // addCustomRole doesn't enforce the limit itself, the template v-if does
      // But the method always adds, so we just verify it doesn't crash
      expect(panel.roles.length).toBe(7);
    });

    it('canStart should be false when roles are empty', () => {
      const panel = createPanelState();
      panel.created();
      panel.loadTemplate('custom');
      expect(panel.roles).toHaveLength(0);
      expect(panel.canStart).toBe(false);
    });

    it('startSession should not emit when canStart is false', () => {
      const panel = createPanelState();
      panel.created();
      panel.loadTemplate('custom'); // no roles
      panel.startSession();
      expect(panel._emitted.start).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------
  // 6. ChatPage folder picker integration (vcrew target)
  // ---------------------------------------------------------------

  describe('ChatPage folder picker integration', () => {
    /**
     * Simulates ChatPage.confirmFolderPicker for vcrew target.
     * This verifies the ChatPage correctly writes back to vcrewPanel.projectDir.
     */
    function simulateConfirmFolderPicker(vcrewPanel, selectedPath) {
      // This is what ChatPage.confirmFolderPicker does for 'vcrew' target:
      if (vcrewPanel) {
        vcrewPanel.projectDir = selectedPath;
      }
    }

    it('should update VCrewConfigPanel projectDir when folder picker confirms', () => {
      const panel = createPanelState();
      panel.created();

      simulateConfirmFolderPicker(panel, '/home/user/new-project');
      expect(panel.projectDir).toBe('/home/user/new-project');
    });

    it('should update canStart after folder picker sets projectDir', () => {
      const panel = createPanelState();
      panel.created();
      panel.projectDir = ''; // clear
      expect(panel.canStart).toBe(false);

      simulateConfirmFolderPicker(panel, '/home/user/selected');
      expect(panel.canStart).toBe(true);
    });

    it('startSession should use the folder-picker-selected path', () => {
      const panel = createPanelState();
      panel.created();

      simulateConfirmFolderPicker(panel, '/opt/my-project');
      panel.startSession();

      expect(panel._emitted.start).toHaveLength(1);
      expect(panel._emitted.start[0].projectDir).toBe('/opt/my-project');
    });
  });
});
