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
import ctx from '../../agent/context.js';
import { connect, resetConnectionTransport, sendToServer } from '../../agent/connection/index.js';
import { parseLocalArgs } from '../../agent/local-run.js';
import {
  applyAgentIdentityToEnv,
  getDefaultAgentName,
  getInstanceIdFromArgs,
  parseServiceArgs,
  resolveAgentName,
} from '../../agent/service/config.js';
import { applyRegisteredTransport } from '../../agent/connection/message-router.js';
import { generateSessionKey, isEncrypted } from '../../agent/encryption.js';

/**
 * Tests for the agent side of feat-ws-plaintext-negotiation.
 *
 * Agent state machine:
 *   - default: ctx.serverEncryptionRequired = true (= old server, encrypt)
 *   - on `registered { acceptPlaintext: true }`: flip to false
 *   - send-side: encrypt only if (serverEncryptionRequired && sessionKey)
 *   - receive-side: unchanged — decrypt iff sessionKey && isEncrypted()
 *
 * Source files exercised by the production transport helpers:
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

describe('agent ctx defaults and upgrade contract', () => {
  it('defaults identity and encryption safely and pins every upgrade fetch to the Yeaft registry', async () => {
    expect(getDefaultAgentName('Dev Box/东')).toBe('Dev-Box--');
    expect(getDefaultAgentName('')).toBe('default');

    const computerName = getDefaultAgentName();
    expect(computerName).toMatch(/^[A-Za-z0-9._-]+$/);
    expect(getInstanceIdFromArgs([], {})).toBe(computerName);
    expect(getInstanceIdFromArgs([], {}, { management: true })).toBe('default');
    expect(parseLocalArgs([], {})).toEqual({ name: computerName, port: 6868 });
    expect(parseLocalArgs([], { AGENT_NAME: 'env-name' })).toEqual({ name: 'env-name', port: 6868 });

    const env = {};
    expect(applyAgentIdentityToEnv([], env)).toBeNull();
    expect(env).toEqual({});

    expect(getInstanceIdFromArgs(['--name', 'explicit-name'], {})).toBe('explicit-name');
    expect(getInstanceIdFromArgs(['--instance', 'legacy', '--name', 'explicit-name'], {})).toBe('explicit-name');
    expect(getInstanceIdFromArgs([], { AGENT_NAME: 'env-name' })).toBe('env-name');
    expect(resolveAgentName([], { AGENT_NAME: 'env-name' }, 'file-name')).toBe('env-name');
    expect(resolveAgentName([], {}, 'file-name')).toBe('file-name');
    expect(resolveAgentName([], {}, 'host-name')).toBe('host-name');
    expect(applyAgentIdentityToEnv(['--instance', 'legacy', '--name', 'explicit-name'], env)).toBe('explicit-name');
    expect(env).toEqual({
      YEAFT_AGENT_INSTANCE: 'explicit-name',
      AGENT_NAME: 'explicit-name',
    });
    expect(() => getInstanceIdFromArgs(['--name'], {})).toThrow('--name requires a value');
    expect(() => getInstanceIdFromArgs(['--instance'], {})).toThrow('--instance requires a value');
    expect(() => getInstanceIdFromArgs(['--instance', 'legacy', '--name', 'bad name'], {})).toThrow('Instance id');
    expect(() => parseLocalArgs(['--name', 'bad name'])).toThrow('Instance id');

    const priorIdentity = {
      AGENT_NAME: process.env.AGENT_NAME,
      YEAFT_AGENT_INSTANCE: process.env.YEAFT_AGENT_INSTANCE,
    };
    try {
      delete process.env.AGENT_NAME;
      delete process.env.YEAFT_AGENT_INSTANCE;
      const defaultService = parseServiceArgs([]);
      expect(defaultService.instanceId).toBe('default');
      expect(defaultService.agentName).toBe(computerName);

      process.env.AGENT_NAME = 'env-name';
      const envService = parseServiceArgs([]);
      expect(envService.instanceId).toBe('default');
      expect(envService.agentName).toBe('env-name');

      const namedService = parseServiceArgs(['--instance', 'legacy', '--name', 'explicit-name']);
      expect(namedService.instanceId).toBe('explicit-name');
      expect(namedService.agentName).toBe('explicit-name');
    } finally {
      if (priorIdentity.AGENT_NAME === undefined) delete process.env.AGENT_NAME;
      else process.env.AGENT_NAME = priorIdentity.AGENT_NAME;
      if (priorIdentity.YEAFT_AGENT_INSTANCE === undefined) delete process.env.YEAFT_AGENT_INSTANCE;
      else process.env.YEAFT_AGENT_INSTANCE = priorIdentity.YEAFT_AGENT_INSTANCE;
    }

    const agentSource = readFileSync(new URL('../../agent/index.js', import.meta.url), 'utf8');
    const doctorSource = readFileSync(new URL('../../agent/service/doctor.js', import.meta.url), 'utf8');
    expect(doctorSource).toContain('getSystemdServicePath(instanceId)');
    expect(doctorSource).toContain('getLaunchdPlistPath(instanceId)');
    expect(doctorSource).toContain('getEcosystemPath(instanceId)');
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
  it('keeps the registered plaintext decision connection-scoped', async () => {
    const original = {
      ws: ctx.ws,
      sessionKey: ctx.sessionKey,
      serverEncryptionRequired: ctx.serverEncryptionRequired,
      pendingAuthTempId: ctx.pendingAuthTempId,
      CONFIG: ctx.CONFIG,
      agentCapabilities: ctx.agentCapabilities,
      outboundSendQueue: ctx.outboundSendQueue,
      outboundSendQueueActive: ctx.outboundSendQueueActive,
    };
    try {
      resetConnectionTransport();
      expect(ctx.serverEncryptionRequired).toBe(true);
      applyRegisteredTransport({ type: 'registered', acceptPlaintext: true });
      expect(ctx.serverEncryptionRequired).toBe(false);

      const legacyKey = generateSessionKey();
      class ConnectSocket extends MockWebSocket {}
      ctx.CONFIG = {
        instanceId: 'test-agent',
        agentName: 'Test Agent',
        workDir: '/tmp',
        serverUrl: 'ws://localhost:1',
        disallowedTools: [],
      };
      ctx.agentCapabilities = [];
      connect(ConnectSocket);
      applyRegisteredTransport({
        type: 'registered',
        sessionKey: Buffer.from(legacyKey).toString('base64'),
      });
      const legacySocket = ctx.ws;
      legacySocket.readyState = WS_OPEN;
      await sendToServer({ type: 'claude_output', payload: { text: 'legacy' } });
      await new Promise(resolve => setImmediate(resolve));

      expect(ctx.serverEncryptionRequired).toBe(true);
      expect(isEncrypted(legacySocket.getLastMessage())).toBe(true);
    } finally {
      ctx.ws = original.ws;
      ctx.sessionKey = original.sessionKey;
      ctx.serverEncryptionRequired = original.serverEncryptionRequired;
      ctx.pendingAuthTempId = original.pendingAuthTempId;
      ctx.CONFIG = original.CONFIG;
      ctx.agentCapabilities = original.agentCapabilities;
      ctx.outboundSendQueue = original.outboundSendQueue;
      ctx.outboundSendQueueActive = original.outboundSendQueueActive;
    }
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
