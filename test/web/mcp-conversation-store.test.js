import { describe, it, expect } from 'vitest';

/**
 * Tests for Store-level conversation MCP management.
 *
 * Verifies:
 * 1. conversation_mcp_update handler stores servers per conversationId
 * 2. toggleConversationMcp correctly computes disallowedTools
 * 3. conversation_settings_updated syncs MCP enabled state from disallowedTools
 * 4. needRestart flag is correctly set on conversation
 *
 * Logic replicated from:
 * - web/stores/helpers/messageHandler.js (conversation_mcp_update + conversation_settings_updated)
 * - web/stores/helpers/conversation.js (toggleConversationMcp)
 * - web/stores/chat.js (currentMcpServers getter)
 */

// =====================================================================
// Replicate message handler: conversation_mcp_update (messageHandler.js:334-338)
// =====================================================================

function handleConversationMcpUpdate(store, msg) {
  if (msg.conversationId && msg.servers) {
    store.conversationMcpServers[msg.conversationId] = msg.servers;
  }
}

// Replicate message handler: conversation_settings_updated (messageHandler.js:90-105)
function handleConversationSettingsUpdated(store, msg) {
  const settingsConv = store.conversations.find(c => c.id === msg.conversationId);
  if (settingsConv && msg.disallowedTools !== undefined) {
    settingsConv.disallowedTools = msg.disallowedTools;
  }
  // Sync conversationMcpServers enabled state
  const convMcpList = store.conversationMcpServers[msg.conversationId];
  if (convMcpList && msg.disallowedTools) {
    for (const server of convMcpList) {
      server.enabled = !msg.disallowedTools.some(d => d === `mcp__${server.name}`);
    }
  }
  // Mark needRestart
  if (msg.needRestart && settingsConv) {
    settingsConv.needRestart = true;
  }
}

// Replicate toggleConversationMcp (conversation.js:149-172)
function toggleConversationMcp(store, serverName, enabled) {
  const convId = store.currentConversation;
  if (!convId) return;

  // Optimistic update
  const servers = store.conversationMcpServers[convId];
  if (servers) {
    const server = servers.find(s => s.name === serverName);
    if (server) server.enabled = enabled;
  }

  // Compute new disallowedTools
  const currentServers = store.conversationMcpServers[convId] || [];
  const mcpDisallowed = currentServers
    .filter(s => !s.enabled)
    .map(s => `mcp__${s.name}`);

  // Merge with non-MCP disallowed tools
  const conv = store.conversations.find(c => c.id === convId);
  const existing = conv?.disallowedTools || [];
  const nonMcpDisallowed = existing.filter(t => !t.startsWith('mcp__'));
  const newDisallowed = [...nonMcpDisallowed, ...mcpDisallowed];

  // Return the computed disallowedTools (in real code this is sent via WS)
  return newDisallowed;
}

// Replicate currentMcpServers getter (chat.js:179-181)
function getCurrentMcpServers(store) {
  if (!store.currentConversation) return [];
  return store.conversationMcpServers[store.currentConversation] || [];
}

// Helper: create a mock store
function createMockStore(overrides = {}) {
  return {
    currentConversation: 'currentConversation' in overrides ? overrides.currentConversation : 'conv_001',
    conversationMcpServers: overrides.conversationMcpServers || {},
    conversations: overrides.conversations || [
      { id: 'conv_001', disallowedTools: [] }
    ],
    sentMessages: [],
    sendWsMessage(msg) { this.sentMessages.push(msg); }
  };
}

// =====================================================================
// Tests
// =====================================================================

describe('Store — conversation_mcp_update handler', () => {
  it('should store servers for the given conversationId', () => {
    const store = createMockStore();
    const msg = {
      conversationId: 'conv_001',
      servers: [
        { name: 'playwright', enabled: true, source: 'Built-in' },
        { name: 'filesystem', enabled: false, source: 'MCP' }
      ]
    };

    handleConversationMcpUpdate(store, msg);

    expect(store.conversationMcpServers['conv_001']).toHaveLength(2);
    expect(store.conversationMcpServers['conv_001'][0].name).toBe('playwright');
    expect(store.conversationMcpServers['conv_001'][1].name).toBe('filesystem');
  });

  it('should overwrite existing servers on re-init', () => {
    const store = createMockStore({
      conversationMcpServers: {
        'conv_001': [{ name: 'old_server', enabled: true, source: 'MCP' }]
      }
    });

    handleConversationMcpUpdate(store, {
      conversationId: 'conv_001',
      servers: [{ name: 'new_server', enabled: true, source: 'MCP' }]
    });

    expect(store.conversationMcpServers['conv_001']).toHaveLength(1);
    expect(store.conversationMcpServers['conv_001'][0].name).toBe('new_server');
  });

  it('should NOT store when conversationId is missing', () => {
    const store = createMockStore();
    handleConversationMcpUpdate(store, { servers: [{ name: 'x', enabled: true }] });
    expect(Object.keys(store.conversationMcpServers)).toHaveLength(0);
  });

  it('should NOT store when servers is missing', () => {
    const store = createMockStore();
    handleConversationMcpUpdate(store, { conversationId: 'conv_001' });
    expect(store.conversationMcpServers['conv_001']).toBeUndefined();
  });

  it('should store for different conversations independently', () => {
    const store = createMockStore();

    handleConversationMcpUpdate(store, {
      conversationId: 'conv_A',
      servers: [{ name: 'playwright', enabled: true, source: 'Built-in' }]
    });
    handleConversationMcpUpdate(store, {
      conversationId: 'conv_B',
      servers: [{ name: 'filesystem', enabled: true, source: 'MCP' }]
    });

    expect(store.conversationMcpServers['conv_A'][0].name).toBe('playwright');
    expect(store.conversationMcpServers['conv_B'][0].name).toBe('filesystem');
  });
});

describe('Store — currentMcpServers getter', () => {
  it('should return servers for current conversation', () => {
    const store = createMockStore({
      currentConversation: 'conv_001',
      conversationMcpServers: {
        'conv_001': [{ name: 'playwright', enabled: true, source: 'Built-in' }]
      }
    });
    const servers = getCurrentMcpServers(store);
    expect(servers).toHaveLength(1);
    expect(servers[0].name).toBe('playwright');
  });

  it('should return empty array when no MCP data for current conversation', () => {
    const store = createMockStore({ currentConversation: 'conv_999' });
    expect(getCurrentMcpServers(store)).toEqual([]);
  });

  it('should return empty array when no current conversation', () => {
    const store = createMockStore({ currentConversation: null });
    expect(getCurrentMcpServers(store)).toEqual([]);
  });
});

describe('Store — toggleConversationMcp', () => {
  it('should optimistically update server enabled state', () => {
    const store = createMockStore({
      currentConversation: 'conv_001',
      conversationMcpServers: {
        'conv_001': [
          { name: 'playwright', enabled: true, source: 'Built-in' },
          { name: 'filesystem', enabled: true, source: 'MCP' }
        ]
      }
    });

    toggleConversationMcp(store, 'filesystem', false);

    const fs = store.conversationMcpServers['conv_001'].find(s => s.name === 'filesystem');
    expect(fs.enabled).toBe(false);
  });

  it('should compute disallowedTools for disabled servers', () => {
    const store = createMockStore({
      currentConversation: 'conv_001',
      conversationMcpServers: {
        'conv_001': [
          { name: 'playwright', enabled: true, source: 'Built-in' },
          { name: 'filesystem', enabled: true, source: 'MCP' },
          { name: 'github', enabled: true, source: 'MCP' }
        ]
      }
    });

    const disallowed = toggleConversationMcp(store, 'filesystem', false);
    expect(disallowed).toContain('mcp__filesystem');
    expect(disallowed).not.toContain('mcp__playwright');
    expect(disallowed).not.toContain('mcp__github');
  });

  it('should preserve non-MCP disallowed tools', () => {
    const store = createMockStore({
      currentConversation: 'conv_001',
      conversations: [{ id: 'conv_001', disallowedTools: ['some_other_tool'] }],
      conversationMcpServers: {
        'conv_001': [
          { name: 'playwright', enabled: true, source: 'Built-in' },
          { name: 'filesystem', enabled: true, source: 'MCP' }
        ]
      }
    });

    const disallowed = toggleConversationMcp(store, 'filesystem', false);
    expect(disallowed).toContain('some_other_tool');
    expect(disallowed).toContain('mcp__filesystem');
  });

  it('should replace existing MCP disallowed entries (not duplicate)', () => {
    const store = createMockStore({
      currentConversation: 'conv_001',
      conversations: [{ id: 'conv_001', disallowedTools: ['mcp__filesystem', 'non_mcp_tool'] }],
      conversationMcpServers: {
        'conv_001': [
          { name: 'playwright', enabled: false, source: 'Built-in' },
          { name: 'filesystem', enabled: true, source: 'MCP' }
        ]
      }
    });

    // Disable playwright → should have mcp__playwright but filesystem was re-enabled
    const disallowed = toggleConversationMcp(store, 'playwright', false);
    expect(disallowed).toContain('non_mcp_tool');
    expect(disallowed).toContain('mcp__playwright');
    // Old mcp__filesystem should be removed (since filesystem is now enabled)
    expect(disallowed).not.toContain('mcp__filesystem');
  });

  it('should early return when no current conversation', () => {
    const store = createMockStore({ currentConversation: null });
    const result = toggleConversationMcp(store, 'playwright', false);
    expect(result).toBeUndefined();
  });

  it('should enable a previously disabled server', () => {
    const store = createMockStore({
      currentConversation: 'conv_001',
      conversations: [{ id: 'conv_001', disallowedTools: ['mcp__filesystem'] }],
      conversationMcpServers: {
        'conv_001': [
          { name: 'filesystem', enabled: false, source: 'MCP' }
        ]
      }
    });

    const disallowed = toggleConversationMcp(store, 'filesystem', true);
    expect(disallowed).not.toContain('mcp__filesystem');
    // Server should be optimistically enabled
    expect(store.conversationMcpServers['conv_001'][0].enabled).toBe(true);
  });
});

describe('Store — conversation_settings_updated handler', () => {
  it('should update conversation disallowedTools', () => {
    const store = createMockStore({
      conversations: [{ id: 'conv_001', disallowedTools: [] }]
    });

    handleConversationSettingsUpdated(store, {
      conversationId: 'conv_001',
      disallowedTools: ['mcp__filesystem']
    });

    const conv = store.conversations.find(c => c.id === 'conv_001');
    expect(conv.disallowedTools).toEqual(['mcp__filesystem']);
  });

  it('should sync MCP server enabled state from disallowedTools', () => {
    const store = createMockStore({
      conversationMcpServers: {
        'conv_001': [
          { name: 'playwright', enabled: true, source: 'Built-in' },
          { name: 'filesystem', enabled: true, source: 'MCP' }
        ]
      }
    });

    handleConversationSettingsUpdated(store, {
      conversationId: 'conv_001',
      disallowedTools: ['mcp__filesystem']
    });

    const servers = store.conversationMcpServers['conv_001'];
    expect(servers.find(s => s.name === 'playwright').enabled).toBe(true);
    expect(servers.find(s => s.name === 'filesystem').enabled).toBe(false);
  });

  it('should set needRestart flag when msg.needRestart is true', () => {
    const store = createMockStore({
      conversations: [{ id: 'conv_001', disallowedTools: [] }]
    });

    handleConversationSettingsUpdated(store, {
      conversationId: 'conv_001',
      disallowedTools: ['mcp__filesystem'],
      needRestart: true
    });

    const conv = store.conversations.find(c => c.id === 'conv_001');
    expect(conv.needRestart).toBe(true);
  });

  it('should NOT set needRestart when msg.needRestart is false/missing', () => {
    const store = createMockStore({
      conversations: [{ id: 'conv_001', disallowedTools: [] }]
    });

    handleConversationSettingsUpdated(store, {
      conversationId: 'conv_001',
      disallowedTools: ['mcp__filesystem']
    });

    const conv = store.conversations.find(c => c.id === 'conv_001');
    expect(conv.needRestart).toBeUndefined();
  });

  it('should handle missing conversation gracefully', () => {
    const store = createMockStore({ conversations: [] });
    // Should not throw
    handleConversationSettingsUpdated(store, {
      conversationId: 'conv_999',
      disallowedTools: ['mcp__filesystem'],
      needRestart: true
    });
  });

  it('should handle no MCP data for conversation', () => {
    const store = createMockStore({
      conversations: [{ id: 'conv_001', disallowedTools: [] }]
    });

    // No conversationMcpServers entry — should not throw
    handleConversationSettingsUpdated(store, {
      conversationId: 'conv_001',
      disallowedTools: ['mcp__filesystem']
    });

    const conv = store.conversations.find(c => c.id === 'conv_001');
    expect(conv.disallowedTools).toEqual(['mcp__filesystem']);
  });

  it('should re-enable servers when removed from disallowedTools', () => {
    const store = createMockStore({
      conversationMcpServers: {
        'conv_001': [
          { name: 'filesystem', enabled: false, source: 'MCP' },
          { name: 'github', enabled: false, source: 'MCP' }
        ]
      }
    });

    handleConversationSettingsUpdated(store, {
      conversationId: 'conv_001',
      disallowedTools: ['mcp__github']  // filesystem removed from disallowed
    });

    const servers = store.conversationMcpServers['conv_001'];
    expect(servers.find(s => s.name === 'filesystem').enabled).toBe(true);
    expect(servers.find(s => s.name === 'github').enabled).toBe(false);
  });
});
