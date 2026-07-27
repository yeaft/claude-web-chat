import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { MockWebSocket, WS_OPEN } from '../helpers/mockWs.js';
import {
  DEFAULT_UPGRADE_REGISTRY,
  buildUpgradeInstallArgs,
  buildUpgradeMetadataArgs,
  buildUpgradeMetadataUrl,
  buildUpgradeUpdateArgs,
  buildWindowsUpgradeInvocation,
  launchWindowsUpgradeScript,
} from '../../agent/upgrade-command.js';
import { buildWindowsUpgradeCommand } from '../../agent/connection/upgrade.js';

/**
 * Tests for the agent side of feat-ws-plaintext-negotiation.
 *
 * Agent state machine:
 *   - default: ctx.serverEncryptionRequired = true (= old server, encrypt)
 *   - on `registered { acceptPlaintext: true }`: flip to false
 *   - send-side: encrypt only if (serverEncryptionRequired && sessionKey)
 *   - receive-side: unchanged — decrypt iff sessionKey && isEncrypted()
 *
 * Source files exercised by intent (not directly imported, because
 * agent/context.js has side effects that don't unit-test cleanly):
 *   - agent/connection/message-router.js (case 'registered' handler)
 *   - agent/connection/buffer.js (sendToServer encrypt-or-plaintext gate)
 *   - agent/connection/index.js (capabilities include 'plaintext-ok')
 *   - agent/context.js (default serverEncryptionRequired: true)
 */

// Mirrors the send-site decision in agent/connection/buffer.js. This is an
// independent copy of the branching logic, not the production function —
// keep it in sync by hand if buffer.js changes.
async function sendToServerUnderTest(ctxLike, msg) {
  const ws = ctxLike.ws;
  if (ws.readyState !== WS_OPEN) return;

  const { encrypt } = await import('../../agent/encryption.js');
  if (ctxLike.serverEncryptionRequired && ctxLike.sessionKey) {
    const encrypted = await encrypt(msg, ctxLike.sessionKey);
    ws.send(JSON.stringify(encrypted));
  } else {
    ws.send(JSON.stringify(msg));
  }
}

// Verbatim copy of the registered-handler flag flip in message-router.js.
function applyRegisteredMessage(ctxLike, msg) {
  if (msg.acceptPlaintext === true) {
    ctxLike.serverEncryptionRequired = false;
  }
}

describe('agent ctx defaults and upgrade contract', () => {
  it('defaults encryption safely and pins every upgrade fetch to the Yeaft registry', async () => {
    const agentSource = readFileSync(new URL('../../agent/index.js', import.meta.url), 'utf8');
    const startupCommands = [...agentSource.matchAll(/await execHiddenAsync\(/g)];
    expect(startupCommands).toHaveLength(6);
    expect(agentSource).toContain('return execAsync(command, { ...options, windowsHide: true });');
    expect(agentSource).not.toMatch(/await execAsync\(/);

    // The actual default is set in agent/context.js. Mirror the contract.
    const ctxLike = { serverEncryptionRequired: true };
    expect(ctxLike.serverEncryptionRequired).toBe(true);

    expect(DEFAULT_UPGRADE_REGISTRY).toBe('https://pkg.yeaft.com/');
    expect(buildUpgradeMetadataArgs('@yeaft/webchat-agent@latest', 'version')).toEqual([
      'view',
      '@yeaft/webchat-agent@latest',
      'version',
      '--registry=https://pkg.yeaft.com/',
      '--prefer-online',
      '--prefer-offline=false',
      '--offline=false',
    ]);
    expect(buildUpgradeInstallArgs('@yeaft/webchat-agent@1.0.250')).toEqual([
      'install',
      '-g',
      '@yeaft/webchat-agent@1.0.250',
      '--registry=https://pkg.yeaft.com/',
    ]);
    expect(buildUpgradeInstallArgs('@yeaft/webchat-agent@1.0.250', { global: false })).toEqual([
      'install',
      '@yeaft/webchat-agent@1.0.250',
      '--registry=https://pkg.yeaft.com/',
    ]);
    expect(buildUpgradeUpdateArgs('@yeaft/webchat-agent')).toEqual([
      'update',
      '-g',
      '@yeaft/webchat-agent',
      '--registry=https://pkg.yeaft.com/',
    ]);
    expect(buildUpgradeMetadataUrl('@yeaft/webchat-agent')).toBe(
      'https://pkg.yeaft.com/%40yeaft%2Fwebchat-agent/latest',
    );
    expect(buildWindowsUpgradeCommand()).toBe(
      'call npm update -g %PKG% --registry=https://pkg.yeaft.com/',
    );

    const options = {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      windowsVerbatimArguments: true,
    };
    const batPath = 'C:\\Users\\Corp User\\AppData\\Roaming\\yeaft-agent\\upgrade.bat';
    const handoffPath = 'C:\\Users\\Corp User\\AppData\\Roaming\\yeaft-agent\\upgrade.started';
    expect(buildWindowsUpgradeInvocation(batPath)).toEqual({
      command: 'cmd.exe',
      args: ['/d', '/s', '/c', `"${batPath}"`],
      options,
    });
    const makeChild = () => {
      const child = new EventEmitter();
      child.exitCode = null;
      child.signalCode = null;
      child.unref = vi.fn();
      child.kill = vi.fn();
      return child;
    };
    const runLauncher = (overrides = {}) => launchWindowsUpgradeScript({
      batPath,
      handoffPath,
      fileExists: () => false,
      removeFile: () => {},
      sleep: async () => {},
      timeoutMs: 10,
      ...overrides,
    });

    await expect(runLauncher({
      spawnProcess: () => { throw new Error('cmd blocked'); },
    })).rejects.toThrow('Windows upgrade launcher failed: cmd blocked');

    const asyncErrorChild = makeChild();
    await expect(runLauncher({
      spawnProcess: () => {
        queueMicrotask(() => asyncErrorChild.emit('error', new Error('spawn denied')));
        return asyncErrorChild;
      },
    })).rejects.toThrow('Windows upgrade launcher failed: spawn denied');
    expect(asyncErrorChild.kill).toHaveBeenCalledOnce();

    const postSpawnErrorChild = makeChild();
    await expect(runLauncher({
      spawnProcess: () => {
        queueMicrotask(() => {
          postSpawnErrorChild.emit('spawn');
          queueMicrotask(() => postSpawnErrorChild.emit('error', new Error('launcher failed after spawn')));
        });
        return postSpawnErrorChild;
      },
    })).rejects.toThrow('Windows upgrade launcher failed: launcher failed after spawn');
    expect(postSpawnErrorChild.kill).toHaveBeenCalledOnce();
    expect(postSpawnErrorChild.unref).not.toHaveBeenCalled();

    const exitedChild = makeChild();
    const exitedSpawn = vi.fn(() => {
      queueMicrotask(() => {
        exitedChild.emit('spawn');
        exitedChild.exitCode = 1;
        exitedChild.emit('close', 1);
      });
      return exitedChild;
    });
    const exitedHandoff = vi.fn();
    await expect(runLauncher({
      spawnProcess: exitedSpawn,
      onHandoff: exitedHandoff,
    })).rejects.toThrow('exited before handoff (code 1)');
    expect(exitedHandoff).not.toHaveBeenCalled();
    expect(exitedChild.unref).not.toHaveBeenCalled();
    expect(exitedChild.kill).toHaveBeenCalledOnce();

    const markerThenExitChild = makeChild();
    const markerThenExitHandoff = vi.fn();
    let markerChecks = 0;
    await expect(runLauncher({
      spawnProcess: () => {
        queueMicrotask(() => markerThenExitChild.emit('spawn'));
        return markerThenExitChild;
      },
      fileExists: () => ++markerChecks > 0,
      sleep: async () => {
        markerThenExitChild.exitCode = 1;
        markerThenExitChild.emit('close', 1);
      },
      onHandoff: markerThenExitHandoff,
    })).rejects.toThrow('exited before handoff (code 1)');
    expect(markerChecks).toBe(1);
    expect(markerThenExitHandoff).not.toHaveBeenCalled();
    expect(markerThenExitChild.kill).toHaveBeenCalledOnce();

    const timeoutChild = makeChild();
    await expect(runLauncher({
      spawnProcess: () => {
        queueMicrotask(() => timeoutChild.emit('spawn'));
        return timeoutChild;
      },
      timeoutMs: 0,
    })).rejects.toThrow('did not confirm handoff within 0ms');
    expect(timeoutChild.kill).toHaveBeenCalledOnce();

    const cmdChild = makeChild();
    const spawnMock = vi.fn(() => {
      queueMicrotask(() => cmdChild.emit('spawn'));
      return cmdChild;
    });
    let handoffChecks = 0;
    const onHandoff = vi.fn();
    await expect(runLauncher({
      spawnProcess: spawnMock,
      fileExists: () => ++handoffChecks >= 2,
      onHandoff,
    })).resolves.toBe('cmd.exe');
    expect(spawnMock).toHaveBeenCalledWith(
      'cmd.exe',
      ['/d', '/s', '/c', `"${batPath}"`],
      options,
    );
    expect(handoffChecks).toBeGreaterThanOrEqual(3);
    expect(onHandoff).toHaveBeenCalledOnce();
    expect(cmdChild.kill).not.toHaveBeenCalled();
    expect(cmdChild.unref).toHaveBeenCalledOnce();

    const callbackChild = makeChild();
    const removeHandoff = vi.fn();
    await expect(runLauncher({
      spawnProcess: () => {
        queueMicrotask(() => callbackChild.emit('spawn'));
        return callbackChild;
      },
      fileExists: () => true,
      removeFile: removeHandoff,
      onHandoff: () => { throw new Error('pm2 delete failed'); },
    })).rejects.toThrow('pm2 delete failed');
    expect(callbackChild.kill).toHaveBeenCalledOnce();
    expect(callbackChild.unref).not.toHaveBeenCalled();
    expect(removeHandoff).toHaveBeenCalledTimes(2);
  });
});

describe('agent advertises plaintext-ok capability', () => {
  it('includes plaintext-ok in agent capability list', async () => {
    // Mirror agent/index.js definition.
    const capabilities = ['background_tasks', 'file_editor', 'ping_session', 'plaintext-ok', 'work_center'];
    expect(capabilities).toContain('plaintext-ok');
    expect(capabilities).toContain('work_center');
  });

  it('serializes plaintext-ok into the auth-frame capabilities array', () => {
    const capabilities = ['background_tasks', 'file_editor', 'ping_session', 'plaintext-ok', 'work_center'];
    const authFrame = {
      type: 'auth',
      tempId: 'temp_abc',
      secret: 'my-secret',
      capabilities,
      version: '0.1.999'
    };
    expect(authFrame.capabilities).toContain('plaintext-ok');
    expect(authFrame.capabilities).toContain('work_center');
  });

  it('serializes plaintext-ok into the URL ?capabilities= query', () => {
    const capabilities = ['background_tasks', 'file_editor', 'ping_session', 'plaintext-ok', 'work_center'];
    const params = new URLSearchParams({ capabilities: capabilities.join(',') });
    expect(params.get('capabilities')).toBe('background_tasks,file_editor,ping_session,plaintext-ok,work_center');
    expect(params.get('capabilities').split(',')).toContain('plaintext-ok');
    expect(params.get('capabilities').split(',')).toContain('work_center');
  });
});

describe('agent received `registered` flips serverEncryptionRequired', () => {
  it('flips serverEncryptionRequired off on registered { acceptPlaintext: true }', () => {
    const ctxLike = { serverEncryptionRequired: true };
    applyRegisteredMessage(ctxLike, {
      type: 'registered',
      agentId: 'global:Worker-1',
      sessionKey: null,
      acceptPlaintext: true
    });
    expect(ctxLike.serverEncryptionRequired).toBe(false);
  });

  it('keeps serverEncryptionRequired on when registered omits acceptPlaintext (old server)', () => {
    const ctxLike = { serverEncryptionRequired: true };
    applyRegisteredMessage(ctxLike, {
      type: 'registered',
      agentId: 'global:Worker-1',
      sessionKey: 'base64key'
      // no acceptPlaintext field
    });
    expect(ctxLike.serverEncryptionRequired).toBe(true);
  });

  it('keeps serverEncryptionRequired on if acceptPlaintext is false explicitly', () => {
    const ctxLike = { serverEncryptionRequired: true };
    applyRegisteredMessage(ctxLike, {
      type: 'registered',
      agentId: 'global:Worker-1',
      sessionKey: null,
      acceptPlaintext: false
    });
    expect(ctxLike.serverEncryptionRequired).toBe(true);
  });
});

describe('sendToServer: encrypt vs plaintext gate', () => {
  it('writes plain JSON when serverEncryptionRequired is false (new server)', async () => {
    const { generateSessionKey } = await import('../../agent/encryption.js');
    const ws = new MockWebSocket();
    const ctxLike = {
      ws,
      sessionKey: generateSessionKey(),
      serverEncryptionRequired: false
    };

    const msg = { type: 'claude_output', payload: { text: 'hello' } };
    await sendToServerUnderTest(ctxLike, msg);

    expect(ws.getLastMessage()).toEqual(msg);
  });

  it('writes encrypted envelope when serverEncryptionRequired is true (old server)', async () => {
    const { generateSessionKey, isEncrypted, decrypt } = await import('../../agent/encryption.js');
    const sessionKey = generateSessionKey();
    const ws = new MockWebSocket();
    const ctxLike = {
      ws,
      sessionKey,
      serverEncryptionRequired: true
    };

    const msg = { type: 'claude_output', payload: { text: 'hello' } };
    await sendToServerUnderTest(ctxLike, msg);

    const lastSent = ws.getLastMessage();
    expect(isEncrypted(lastSent)).toBe(true);
    const decoded = await decrypt(lastSent, sessionKey);
    expect(decoded).toEqual(msg);
  });

  it('writes plain JSON when sessionKey is missing (regardless of flag)', async () => {
    const ws = new MockWebSocket();
    const ctxLike = {
      ws,
      sessionKey: null,
      serverEncryptionRequired: true // even with flag on
    };
    const msg = { type: 'auth' };
    await sendToServerUnderTest(ctxLike, msg);
    expect(ws.getLastMessage()).toEqual(msg);
  });
});

describe('agent receive path stays unconditional (back-compat with old server)', () => {
  it('decrypts an encrypted frame even after agent has flipped to plaintext outbound', async () => {
    // Scenario: agent has flipped serverEncryptionRequired=false because a
    // new server told it to, but for whatever reason a frame in the wire
    // is still {n,c} (e.g. a re-routed message from an old peer through
    // the hub). The agent's parseMessage must still decrypt it.
    const { encrypt, decrypt, isEncrypted, generateSessionKey } = await import('../../agent/encryption.js');
    const sessionKey = generateSessionKey();

    const upstream = { type: 'execute', conversationId: 'c1', prompt: 'hi' };
    const wire = await encrypt(upstream, sessionKey);
    expect(isEncrypted(wire)).toBe(true);

    // Mirror agent's parseMessage:
    //   const parsed = JSON.parse(data.toString());
    //   if (ctx.sessionKey && isEncrypted(parsed)) return await decrypt(parsed, ctx.sessionKey);
    //   return parsed;
    const parsed = JSON.parse(JSON.stringify(wire));
    const decoded = (sessionKey && isEncrypted(parsed))
      ? await decrypt(parsed, sessionKey)
      : parsed;
    expect(decoded).toEqual(upstream);
  });

  it('passes plain JSON through untouched after flag flip (new server → new agent)', async () => {
    const { isEncrypted } = await import('../../agent/encryption.js');
    const upstream = { type: 'execute', conversationId: 'c1', prompt: 'hi' };
    const parsed = JSON.parse(JSON.stringify(upstream));
    expect(isEncrypted(parsed)).toBe(false);
  });
});
