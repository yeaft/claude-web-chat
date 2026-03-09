import { describe, it, expect } from 'vitest';

/**
 * Tests for agent/claude.js MCP server extraction and conversation_mcp_update logic.
 *
 * Verifies:
 * 1. extractMcpServers correctly parses mcp__<server>__<tool> format
 * 2. conversation_mcp_update message is built with correct enabled state
 * 3. disallowedTools properly determines enabled/disabled servers
 *
 * Logic replicated from agent/claude.js:485-494 and :281-296
 */

// =====================================================================
// Replicate extractMcpServers from agent/claude.js:485-494
// =====================================================================

function extractMcpServers(tools) {
  const serverNames = new Set();
  for (const tool of tools) {
    const parts = tool.split('__');
    if (parts.length >= 3 && parts[0] === 'mcp') {
      serverNames.add(parts[1]);
    }
  }
  return [...serverNames];
}

// Replicate conversation_mcp_update message building from agent/claude.js:282-295
function buildMcpUpdateMessage(tools, conversationId, disallowedTools) {
  const mcpServers = extractMcpServers(tools);
  if (mcpServers.length === 0) return null;

  const effectiveDisallowed = disallowedTools || [];
  const serversWithState = mcpServers.map(name => ({
    name,
    enabled: !effectiveDisallowed.some(d => d === `mcp__${name}`),
    source: name === 'playwright' ? 'Built-in' : 'MCP'
  }));

  return {
    type: 'conversation_mcp_update',
    conversationId,
    servers: serversWithState
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
    const servers = extractMcpServers(tools);
    expect(servers).toContain('playwright');
    expect(servers).toContain('filesystem');
    expect(servers).toHaveLength(2);
  });

  it('should deduplicate server names', () => {
    const tools = [
      'mcp__playwright__browser_navigate',
      'mcp__playwright__browser_click',
      'mcp__playwright__browser_snapshot',
      'mcp__playwright__browser_fill_form'
    ];
    const servers = extractMcpServers(tools);
    expect(servers).toEqual(['playwright']);
  });

  it('should ignore non-MCP tools', () => {
    const tools = [
      'Read',
      'Write',
      'Bash',
      'Glob',
      'mcp__filesystem__read_file'
    ];
    const servers = extractMcpServers(tools);
    expect(servers).toEqual(['filesystem']);
  });

  it('should return empty array when no MCP tools', () => {
    const tools = ['Read', 'Write', 'Bash', 'Glob', 'Grep'];
    const servers = extractMcpServers(tools);
    expect(servers).toEqual([]);
  });

  it('should return empty array for empty tools list', () => {
    const servers = extractMcpServers([]);
    expect(servers).toEqual([]);
  });

  it('should handle tool names with multiple underscores in tool part', () => {
    const tools = ['mcp__myserver__do_complex_thing'];
    const servers = extractMcpServers(tools);
    expect(servers).toEqual(['myserver']);
  });

  it('should handle server names with underscores', () => {
    const tools = [
      'mcp__my_server__do_thing',
      'mcp__another_long_name__action'
    ];
    const servers = extractMcpServers(tools);
    expect(servers).toContain('my_server');
    expect(servers).toContain('another_long_name');
    expect(servers).toHaveLength(2);
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

  it('should mark disallowed servers as disabled', () => {
    const msg = buildMcpUpdateMessage(sampleTools, 'conv_456', ['mcp__filesystem', 'mcp__github']);

    const playwright = msg.servers.find(s => s.name === 'playwright');
    expect(playwright.enabled).toBe(true);

    const filesystem = msg.servers.find(s => s.name === 'filesystem');
    expect(filesystem.enabled).toBe(false);

    const github = msg.servers.find(s => s.name === 'github');
    expect(github.enabled).toBe(false);
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
