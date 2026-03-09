import { describe, it, expect } from 'vitest';

/**
 * Tests for agent/claude.js MCP server extraction and conversation_mcp_update logic.
 *
 * Verifies:
 * 1. extractMcpServers correctly parses mcp__<server>__<tool> format and returns serverTools mapping
 * 2. conversation_mcp_update message is built with correct enabled state
 * 3. disallowedTools properly determines enabled/disabled servers (both prefix and full tool name)
 *
 * Logic replicated from agent/claude.js
 */

// =====================================================================
// Replicate extractMcpServers from agent/claude.js (updated version)
// =====================================================================

function extractMcpServers(tools) {
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
  return {
    serverNames: Object.keys(serverToolsMap),
    serverTools: serverToolsMap
  };
}

// Replicate conversation_mcp_update message building from agent/claude.js
function buildMcpUpdateMessage(tools, conversationId, disallowedTools) {
  const { serverNames: mcpServers, serverTools: mcpServerTools } = extractMcpServers(tools);
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
    serverTools: mcpServerTools
  };
}

// =====================================================================
// Tests
// =====================================================================

describe('Agent — extractMcpServers', () => {
  it('should extract server names from mcp__<server>__<tool> format', () => {
    const tools = [
      'mcp__playwright__browser_navigate',
      'mcp__playwright__browser_click',
      'mcp__filesystem__read_file',
      'mcp__filesystem__write_file'
    ];
    const { serverNames } = extractMcpServers(tools);
    expect(serverNames).toContain('playwright');
    expect(serverNames).toContain('filesystem');
    expect(serverNames).toHaveLength(2);
  });

  it('should deduplicate server names', () => {
    const tools = [
      'mcp__playwright__browser_navigate',
      'mcp__playwright__browser_click',
      'mcp__playwright__browser_snapshot',
      'mcp__playwright__browser_fill_form'
    ];
    const { serverNames } = extractMcpServers(tools);
    expect(serverNames).toEqual(['playwright']);
  });

  it('should ignore non-MCP tools', () => {
    const tools = [
      'Read',
      'Write',
      'Bash',
      'Glob',
      'mcp__filesystem__read_file'
    ];
    const { serverNames } = extractMcpServers(tools);
    expect(serverNames).toEqual(['filesystem']);
  });

  it('should return empty arrays when no MCP tools', () => {
    const tools = ['Read', 'Write', 'Bash', 'Glob', 'Grep'];
    const { serverNames, serverTools } = extractMcpServers(tools);
    expect(serverNames).toEqual([]);
    expect(serverTools).toEqual({});
  });

  it('should return empty arrays for empty tools list', () => {
    const { serverNames, serverTools } = extractMcpServers([]);
    expect(serverNames).toEqual([]);
    expect(serverTools).toEqual({});
  });

  it('should handle tool names with multiple underscores in tool part', () => {
    const tools = ['mcp__myserver__do_complex_thing'];
    const { serverNames } = extractMcpServers(tools);
    expect(serverNames).toEqual(['myserver']);
  });

  it('should handle server names with underscores', () => {
    const tools = [
      'mcp__my_server__do_thing',
      'mcp__another_long_name__action'
    ];
    const { serverNames } = extractMcpServers(tools);
    expect(serverNames).toContain('my_server');
    expect(serverNames).toContain('another_long_name');
    expect(serverNames).toHaveLength(2);
  });

  it('should return per-server tools mapping', () => {
    const tools = [
      'mcp__playwright__browser_navigate',
      'mcp__playwright__browser_click',
      'mcp__filesystem__read_file',
      'mcp__filesystem__write_file'
    ];
    const { serverTools } = extractMcpServers(tools);
    expect(serverTools.playwright).toEqual([
      'mcp__playwright__browser_navigate',
      'mcp__playwright__browser_click'
    ]);
    expect(serverTools.filesystem).toEqual([
      'mcp__filesystem__read_file',
      'mcp__filesystem__write_file'
    ]);
  });
});

describe('Agent — conversation_mcp_update message', () => {
  const sampleTools = [
    'Read', 'Write', 'Bash',
    'mcp__playwright__browser_navigate',
    'mcp__playwright__browser_click',
    'mcp__filesystem__read_file',
    'mcp__filesystem__write_file',
    'mcp__github__create_pr'
  ];

  it('should build message with all servers enabled when no disallowedTools', () => {
    const msg = buildMcpUpdateMessage(sampleTools, 'conv_123', []);
    expect(msg.type).toBe('conversation_mcp_update');
    expect(msg.conversationId).toBe('conv_123');
    expect(msg.servers).toHaveLength(3);

    const playwright = msg.servers.find(s => s.name === 'playwright');
    expect(playwright.enabled).toBe(true);
    expect(playwright.source).toBe('Built-in');

    const filesystem = msg.servers.find(s => s.name === 'filesystem');
    expect(filesystem.enabled).toBe(true);
    expect(filesystem.source).toBe('MCP');

    const github = msg.servers.find(s => s.name === 'github');
    expect(github.enabled).toBe(true);
    expect(github.source).toBe('MCP');
  });

  it('should mark disallowed servers as disabled (prefix format)', () => {
    const msg = buildMcpUpdateMessage(sampleTools, 'conv_456', ['mcp__filesystem', 'mcp__github']);

    const playwright = msg.servers.find(s => s.name === 'playwright');
    expect(playwright.enabled).toBe(true);

    const filesystem = msg.servers.find(s => s.name === 'filesystem');
    expect(filesystem.enabled).toBe(false);

    const github = msg.servers.find(s => s.name === 'github');
    expect(github.enabled).toBe(false);
  });

  it('should mark disallowed servers as disabled (full tool name format)', () => {
    const msg = buildMcpUpdateMessage(sampleTools, 'conv_789', [
      'mcp__filesystem__read_file',
      'mcp__filesystem__write_file'
    ]);

    const playwright = msg.servers.find(s => s.name === 'playwright');
    expect(playwright.enabled).toBe(true);

    const filesystem = msg.servers.find(s => s.name === 'filesystem');
    expect(filesystem.enabled).toBe(false);
  });

  it('should include serverTools mapping in the message', () => {
    const msg = buildMcpUpdateMessage(sampleTools, 'conv_st', []);
    expect(msg.serverTools).toBeDefined();
    expect(msg.serverTools.playwright).toEqual([
      'mcp__playwright__browser_navigate',
      'mcp__playwright__browser_click'
    ]);
    expect(msg.serverTools.filesystem).toEqual([
      'mcp__filesystem__read_file',
      'mcp__filesystem__write_file'
    ]);
    expect(msg.serverTools.github).toEqual(['mcp__github__create_pr']);
  });

  it('should use "Built-in" source for playwright, "MCP" for others', () => {
    const tools = [
      'mcp__playwright__browser_navigate',
      'mcp__custom_server__do_thing'
    ];
    const msg = buildMcpUpdateMessage(tools, 'conv_789', []);

    expect(msg.servers.find(s => s.name === 'playwright').source).toBe('Built-in');
    expect(msg.servers.find(s => s.name === 'custom_server').source).toBe('MCP');
  });

  it('should return null when no MCP tools present', () => {
    const tools = ['Read', 'Write', 'Bash'];
    const msg = buildMcpUpdateMessage(tools, 'conv_000', []);
    expect(msg).toBeNull();
  });

  it('should handle null disallowedTools (fallback to empty)', () => {
    const msg = buildMcpUpdateMessage(sampleTools, 'conv_111', null);
    expect(msg.servers.every(s => s.enabled)).toBe(true);
  });

  it('should not match partial disallowedTools names', () => {
    // disallowed 'mcp__play' should NOT match 'mcp__playwright'
    const msg = buildMcpUpdateMessage(sampleTools, 'conv_222', ['mcp__play']);
    const playwright = msg.servers.find(s => s.name === 'playwright');
    expect(playwright.enabled).toBe(true);
  });
});
