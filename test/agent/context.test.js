import { describe, it, expect } from 'vitest';

/**
 * Tests for agent/context.js — the shared mutable context object.
 */

describe('Agent Context', () => {
  it('should initialize with correct default values', async () => {
    // Import context fresh
    const ctx = (await import('../../agent/context.js')).default;

    expect(ctx.ws).toBeNull();
    expect(ctx.sessionKey).toBeNull();
    expect(ctx.conversations).toBeInstanceOf(Map);
    expect(ctx.terminals).toBeInstanceOf(Map);
    expect(ctx.proxyPorts).toEqual([]);
    expect(ctx.proxyWsSockets).toBeInstanceOf(Map);
    expect(ctx.pendingUserQuestions).toBeInstanceOf(Map);
    expect(ctx.nodePty).toBeNull();
    expect(ctx.CONFIG).toBeNull();
    expect(ctx.agentCapabilities).toEqual([]);
    expect(ctx.reconnectTimer).toBeNull();
    expect(ctx.pendingAuthTempId).toBeNull();
    expect(ctx.agentHeartbeatTimer).toBeNull();
    expect(ctx.lastPongAt).toBe(0);
    expect(ctx.sendToServer).toBeNull();
    expect(ctx.saveConfig).toBeNull();
  });

  it('should support mutable state operations', async () => {
    const ctx = (await import('../../agent/context.js')).default;

    // Conversations Map
    ctx.conversations.set('conv1', { id: 'conv1', workDir: '/test' });
    expect(ctx.conversations.has('conv1')).toBe(true);
    expect(ctx.conversations.get('conv1').workDir).toBe('/test');

    // Terminals Map
    ctx.terminals.set('term1', { pty: null });
    expect(ctx.terminals.size).toBe(1);

    // Register functions
    ctx.sendToServer = (msg) => msg;
    expect(typeof ctx.sendToServer).toBe('function');

    // Cleanup
    ctx.conversations.clear();
    ctx.terminals.clear();
    ctx.sendToServer = null;
  });

  it('should share state across imports (singleton)', async () => {
    const ctx1 = (await import('../../agent/context.js')).default;
    const ctx2 = (await import('../../agent/context.js')).default;

    ctx1.conversations.set('shared_test', { id: 'shared_test' });
    expect(ctx2.conversations.has('shared_test')).toBe(true);

    // Cleanup
    ctx1.conversations.delete('shared_test');
  });
});
