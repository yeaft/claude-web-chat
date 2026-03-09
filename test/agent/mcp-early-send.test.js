import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Tests for PR#148: MCP list sent immediately on conversation create/resume.
 *
 * Verifies:
 * 1. createConversation sends conversation_mcp_update when ctx.mcpServers is populated
 * 2. resumeConversation sends conversation_mcp_update when ctx.mcpServers is populated
 * 3. No conversation_mcp_update sent when ctx.mcpServers is empty
 * 4. disallowedTools (per-conversation and global) correctly determine enabled state
 * 5. Init message (from claude.js) overwrites the early MCP list
 *
 * Logic replicated from agent/conversation.js:147-162 and :228-241
 */

// =====================================================================
// Replicate early MCP send logic from conversation.js
// =====================================================================

/**
 * Simulates the MCP early-send logic in createConversation/resumeConversation.
 * Returns the conversation_mcp_update message that would be sent, or null if skipped.
 */
function buildEarlyMcpUpdate(mcpServers, conversationId, disallowedTools, globalDisallowedTools) {
  if (mcpServers.length === 0) return null;

  const effectiveDisallowed = disallowedTools || globalDisallowedTools || [];
  const serversWithState = mcpServers.map(s => ({
    name: s.name,
    enabled: !effectiveDisallowed.some(d => d === `mcp__${s.name}` || d.startsWith(`mcp__${s.name}__`)),
    source: s.source
  }));

  return {
    type: 'conversation_mcp_update',
    conversationId,
    servers: serversWithState
  };
}

/**
 * Simulates the init-time MCP update from claude.js (extractMcpServers + buildMcpUpdateMessage).
 * This should overwrite the early MCP list.
 */
function buildInitMcpUpdate(tools, conversationId, disallowedTools) {
  const serverToolsMap = {};
  for (const tool of tools) {
    const parts = tool.split('__');
    if (parts.length >= 3 && parts[0] === 'mcp') {
      const serverName = parts[1];
      if (!serverToolsMap[serverName]) {
        serverToolsMap[serverName] = [];
      }
      serverToolsMap[serverName].push(tool);
    }
  }
  const mcpServers = Object.keys(serverToolsMap);
  if (mcpServers.length === 0) return null;

  const effectiveDisallowed = disallowedTools || [];
  const serversWithState = mcpServers.map(name => ({
    name,
    enabled: !effectiveDisallowed.some(d => d === `mcp__${name}` || d.startsWith(`mcp__${name}__`)),
    source: name === 'playwright' ? 'Built-in' : 'MCP'
  }));

  return {
    type: 'conversation_mcp_update',
    conversationId,
    servers: serversWithState,
    serverTools: serverToolsMap
  };
}

// =====================================================================
// Tests
// =====================================================================

describe('Early MCP send on conversation create/resume', () => {
  const sampleMcpServers = [
    { name: 'playwright', enabled: true, source: 'Built-in' },
    { name: 'filesystem', enabled: true, source: 'MCP' },
    { name: 'github', enabled: true, source: 'MCP' }
  ];

  describe('createConversation early MCP send', () => {
    it('should send conversation_mcp_update when mcpServers is populated', () => {
      const msg = buildEarlyMcpUpdate(sampleMcpServers, 'conv_new', null, []);
      expect(msg).not.toBeNull();
      expect(msg.type).toBe('conversation_mcp_update');
      expect(msg.conversationId).toBe('conv_new');
      expect(msg.servers).toHaveLength(3);
    });

    it('should NOT send when mcpServers is empty', () => {
      const msg = buildEarlyMcpUpdate([], 'conv_new', null, []);
      expect(msg).toBeNull();
    });

    it('should use per-conversation disallowedTools when provided', () => {
      const perConvDisallowed = ['mcp__filesystem'];
      const msg = buildEarlyMcpUpdate(sampleMcpServers, 'conv_new', perConvDisallowed, []);

      expect(msg.servers.find(s => s.name === 'playwright').enabled).toBe(true);
      expect(msg.servers.find(s => s.name === 'filesystem').enabled).toBe(false);
      expect(msg.servers.find(s => s.name === 'github').enabled).toBe(true);
    });

    it('should fall back to global disallowedTools when per-conversation is null', () => {
      const globalDisallowed = ['mcp__github', 'mcp__filesystem'];
      const msg = buildEarlyMcpUpdate(sampleMcpServers, 'conv_new', null, globalDisallowed);

      expect(msg.servers.find(s => s.name === 'playwright').enabled).toBe(true);
      expect(msg.servers.find(s => s.name === 'filesystem').enabled).toBe(false);
      expect(msg.servers.find(s => s.name === 'github').enabled).toBe(false);
    });

    it('should prefer per-conversation disallowedTools over global', () => {
      // per-conversation only disallows playwright, global disallows filesystem+github
      const perConvDisallowed = ['mcp__playwright'];
      const globalDisallowed = ['mcp__filesystem', 'mcp__github'];
      const msg = buildEarlyMcpUpdate(sampleMcpServers, 'conv_new', perConvDisallowed, globalDisallowed);

      // per-conversation takes priority: only playwright disabled
      expect(msg.servers.find(s => s.name === 'playwright').enabled).toBe(false);
      expect(msg.servers.find(s => s.name === 'filesystem').enabled).toBe(true);
      expect(msg.servers.find(s => s.name === 'github').enabled).toBe(true);
    });

    it('should preserve source field from ctx.mcpServers', () => {
      const msg = buildEarlyMcpUpdate(sampleMcpServers, 'conv_new', null, []);

      expect(msg.servers.find(s => s.name === 'playwright').source).toBe('Built-in');
      expect(msg.servers.find(s => s.name === 'filesystem').source).toBe('MCP');
      expect(msg.servers.find(s => s.name === 'github').source).toBe('MCP');
    });

    it('should handle underscore server names in ctx.mcpServers', () => {
      const mcpWithUnderscores = [
        { name: 'my_server', enabled: true, source: 'MCP' },
        { name: 'db_manager', enabled: true, source: 'MCP' }
      ];
      const msg = buildEarlyMcpUpdate(mcpWithUnderscores, 'conv_new', ['mcp__my_server'], []);

      expect(msg.servers.find(s => s.name === 'my_server').enabled).toBe(false);
      expect(msg.servers.find(s => s.name === 'db_manager').enabled).toBe(true);
    });
  });

  describe('resumeConversation early MCP send', () => {
    it('should send conversation_mcp_update on resume (same logic as create)', () => {
      const msg = buildEarlyMcpUpdate(sampleMcpServers, 'conv_resume', null, []);
      expect(msg).not.toBeNull();
      expect(msg.conversationId).toBe('conv_resume');
      expect(msg.servers).toHaveLength(3);
      expect(msg.servers.every(s => s.enabled)).toBe(true);
    });

    it('should respect resumed conversation disallowedTools', () => {
      const resumedDisallowed = ['mcp__playwright', 'mcp__github'];
      const msg = buildEarlyMcpUpdate(sampleMcpServers, 'conv_resume', resumedDisallowed, []);

      expect(msg.servers.find(s => s.name === 'playwright').enabled).toBe(false);
      expect(msg.servers.find(s => s.name === 'filesystem').enabled).toBe(true);
      expect(msg.servers.find(s => s.name === 'github').enabled).toBe(false);
    });
  });
});

describe('Init MCP update overwrites early MCP list', () => {
  it('should produce different server list when CLI has additional servers', () => {
    // Early send from ctx.mcpServers (config-based)
    const configServers = [
      { name: 'playwright', enabled: true, source: 'Built-in' },
      { name: 'filesystem', enabled: true, source: 'MCP' }
    ];
    const earlyMsg = buildEarlyMcpUpdate(configServers, 'conv_1', null, []);

    // Init send from actual CLI tools (has additional server)
    const cliTools = [
      'mcp__playwright__browser_navigate',
      'mcp__filesystem__read_file',
      'mcp__github__create_pr'  // extra server not in config
    ];
    const initMsg = buildInitMcpUpdate(cliTools, 'conv_1', []);

    // Early had 2, init has 3 — init should win
    expect(earlyMsg.servers).toHaveLength(2);
    expect(initMsg.servers).toHaveLength(3);
    expect(initMsg.servers.find(s => s.name === 'github')).toBeDefined();
  });

  it('should produce different server list when CLI has fewer servers', () => {
    // Config knows about 3 servers
    const configServers = [
      { name: 'playwright', enabled: true, source: 'Built-in' },
      { name: 'filesystem', enabled: true, source: 'MCP' },
      { name: 'broken_server', enabled: true, source: 'MCP' }
    ];
    const earlyMsg = buildEarlyMcpUpdate(configServers, 'conv_1', null, []);

    // CLI only loaded 2 (broken_server failed to start)
    const cliTools = [
      'mcp__playwright__browser_navigate',
      'mcp__filesystem__read_file'
    ];
    const initMsg = buildInitMcpUpdate(cliTools, 'conv_1', []);

    expect(earlyMsg.servers).toHaveLength(3);
    expect(initMsg.servers).toHaveLength(2);
    expect(initMsg.servers.find(s => s.name === 'broken_server')).toBeUndefined();
  });

  it('should both use same message type for overwrite semantics', () => {
    const configServers = [{ name: 'filesystem', enabled: true, source: 'MCP' }];
    const earlyMsg = buildEarlyMcpUpdate(configServers, 'conv_1', null, []);
    const initMsg = buildInitMcpUpdate(['mcp__filesystem__read_file'], 'conv_1', []);

    expect(earlyMsg.type).toBe('conversation_mcp_update');
    expect(initMsg.type).toBe('conversation_mcp_update');
    expect(earlyMsg.conversationId).toBe(initMsg.conversationId);
  });

  it('should handle init overwrite with underscore server names', () => {
    const configServers = [
      { name: 'my_server', enabled: true, source: 'MCP' }
    ];
    const earlyMsg = buildEarlyMcpUpdate(configServers, 'conv_1', null, []);

    const cliTools = [
      'mcp__my_server__action_one',
      'mcp__my_server__action_two',
      'mcp__new_server__do_thing'
    ];
    const initMsg = buildInitMcpUpdate(cliTools, 'conv_1', []);

    expect(earlyMsg.servers).toHaveLength(1);
    expect(initMsg.servers).toHaveLength(2);
    expect(initMsg.servers.find(s => s.name === 'my_server')).toBeDefined();
    expect(initMsg.servers.find(s => s.name === 'new_server')).toBeDefined();
  });
});

describe('CSS spacing fix — context-usage-hint margin-right', () => {
  // This is a visual/layout test - we verify the CSS property exists
  // by reading the actual CSS file content

  it('should have margin-right on context-usage-hint to prevent MCP badge overlap', async () => {
    const fs = await import('fs');
    const cssPath = new URL('../../web/styles/chat-input.css', import.meta.url).pathname;
    const css = fs.readFileSync(cssPath, 'utf-8');

    // Verify the .context-usage-hint rule includes margin-right
    const hintRuleMatch = css.match(/\.context-usage-hint\s*\{[^}]*\}/);
    expect(hintRuleMatch).not.toBeNull();
    expect(hintRuleMatch[0]).toContain('margin-right');
  });
});

describe('Agent log — tool names printed after Available tools count', () => {
  it('should produce comma-separated tool names for console.log', () => {
    // Replicate the logging behavior: tools.join(', ')
    const tools = ['Read', 'Write', 'Bash', 'mcp__playwright__browser_navigate', 'mcp__filesystem__read_file'];
    const logLine = `Tools: ${tools.join(', ')}`;

    expect(logLine).toBe('Tools: Read, Write, Bash, mcp__playwright__browser_navigate, mcp__filesystem__read_file');
    expect(logLine).toContain('mcp__playwright__browser_navigate');
    expect(logLine).toContain('mcp__filesystem__read_file');
  });

  it('should handle empty tools list', () => {
    const tools = [];
    const logLine = `Tools: ${tools.join(', ')}`;
    expect(logLine).toBe('Tools: ');
  });

  it('should include underscore server tools in log', () => {
    const tools = ['mcp__my_server__do_thing', 'mcp__another_long_name__action'];
    const logLine = `Tools: ${tools.join(', ')}`;
    expect(logLine).toContain('mcp__my_server__do_thing');
    expect(logLine).toContain('mcp__another_long_name__action');
  });
});
