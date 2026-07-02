import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

vi.mock('../../../agent/connection/buffer.js', () => ({
  sendToServer: vi.fn(),
}));

const { __testHooks } = await import('../../../agent/yeaft/web-bridge.js');

describe('Yeaft session runtime state decoration', () => {
  beforeEach(() => {
    __testHooks.resetVpStatusBroker();
  });

  it('does not mark a session running for a retained VP error status', () => {
    __testHooks.seedVpStatus({
      sessionId: 'session-a',
      vpId: 'vp-a',
      threadId: 'main',
      state: 'error',
      turnId: 'turn-a',
    });

    const [row] = __testHooks.decorateSessionsWithRuntimeState([
      { id: 'session-a', name: 'Session A' },
    ]);

    expect(row).toMatchObject({
      id: 'session-a',
      running: false,
      active: false,
      runningVpCount: 0,
    });
  });

  it('still marks a session running for active VP states', () => {
    __testHooks.seedVpStatus({
      sessionId: 'session-a',
      vpId: 'vp-a',
      threadId: 'main',
      state: 'tool',
      turnId: 'turn-a',
    });

    const [row] = __testHooks.decorateSessionsWithRuntimeState([
      { id: 'session-a', name: 'Session A' },
    ]);

    expect(row).toMatchObject({
      id: 'session-a',
      running: true,
      active: true,
      runningVpCount: 1,
    });
  });

  it('uses per-session model effort overrides for the query watchdog', () => {
    const yeaftDir = join(tmpdir(), `yeaft-watchdog-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const sessionId = 'session-high-effort';
    mkdirSync(join(yeaftDir, 'sessions', sessionId), { recursive: true });
    writeFileSync(join(yeaftDir, 'sessions', sessionId, 'config.json'), JSON.stringify({ modelEffort: 'high' }), 'utf8');

    try {
      __testHooks.setSessionForTest({ config: { dir: yeaftDir, modelEffort: 'medium' } });

      expect(__testHooks.queryTimeoutMsForSessionConfig({ modelEffort: 'medium' })).toBe(120_000);
      expect(__testHooks.queryTimeoutMsForSession(sessionId)).toBe(300_000);
    } finally {
      __testHooks.setSessionForTest(null);
      rmSync(yeaftDir, { recursive: true, force: true });
    }
  });
});
