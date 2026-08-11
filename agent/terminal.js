import { platform, arch } from 'os';
import { existsSync, chmodSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { createRequire } from 'module';
import ctx from './context.js';
import { getRuntimePlatformInfo } from './yeaft/runtime-platform.js';
import { wrapInvocationInSystemdUserScope } from './yeaft/systemd-scope.js';

// Package name of the PTY backend. We use the Homebridge prebuilt fork
// because upstream node-pty ships no Linux prebuilds and falls back to
// node-gyp + C++20, which silently fails on older toolchains. The fork
// ships prebuilds for darwin/linux/win32 across x64/arm64 (incl. musl).
const PTY_PKG = '@homebridge/node-pty-prebuilt-multiarch';

// Ensure spawn-helper has executable permission on Unix systems.
// npm may strip execute bits from prebuilt binaries, causing
// "posix_spawnp failed" on macOS/Linux.
function ensureSpawnHelperPermissions() {
  if (platform() === 'win32') return;
  try {
    const cjsRequire = createRequire(import.meta.url);
    const ptyPkgPath = dirname(cjsRequire.resolve(`${PTY_PKG}/package.json`));
    const targets = [
      join(ptyPkgPath, 'prebuilds', `${platform()}-${arch()}`, 'spawn-helper'),
      join(ptyPkgPath, 'build', 'Release', 'spawn-helper'),
    ];
    for (const helper of targets) {
      if (!existsSync(helper)) continue;
      const mode = statSync(helper).mode;
      if (!(mode & 0o111)) {
        chmodSync(helper, 0o755);
        console.log(`[PTY] Fixed spawn-helper permissions: ${helper}`);
      }
    }
  } catch (e) {
    console.warn('[PTY] Could not ensure spawn-helper permissions:', e.message);
  }
}

// Load PTY backend. With the prebuilt fork this is essentially never
// expected to fail at runtime — it's a regular `dependencies` entry and
// every supported (platform, abi) combination ships a prebuilt binary.
// We still catch and degrade so a single missing binary doesn't crash
// the whole agent on an exotic host.
export async function loadNodePty() {
  if (ctx.nodePty !== null) return ctx.nodePty;
  try {
    let pty = await import(PTY_PKG);
    if (pty.default) pty = pty.default;
    ensureSpawnHelperPermissions();
    ctx.nodePty = pty;
    console.log('[PTY] node-pty loaded successfully');
    return pty;
  } catch (e) {
    console.warn('[PTY] node-pty not available:', e.message);
    ctx.nodePty = false;
    return false;
  }
}

function terminalRoutingFields(source) {
  return {
    ...(source?._requestUserId ? { _requestUserId: source._requestUserId } : {}),
    ...(source?._requestClientId ? { _requestClientId: source._requestClientId } : {}),
    ...(source?._workbenchRequestId ? { _workbenchRequestId: source._workbenchRequestId } : {}),
    ...(source?.workbenchRouteKey ? { workbenchRouteKey: source.workbenchRouteKey } : {}),
    ...(source?.workbenchWorkspaceGeneration
      ? { workbenchWorkspaceGeneration: source.workbenchWorkspaceGeneration }
      : {}),
  };
}

function terminalOwner(source) {
  return {
    conversationId: source?.conversationId || '',
    workbenchRouteKey: source?.workbenchRouteKey || '',
    workbenchWorkspaceGeneration: source?.workbenchWorkspaceGeneration || '',
  };
}

function terminalOwnerMatches(term, msg) {
  if (!term || !msg) return false;
  const owner = terminalOwner(term);
  const request = terminalOwner(msg);
  if (owner.workbenchRouteKey) {
    return request.workbenchRouteKey === owner.workbenchRouteKey
      && request.workbenchWorkspaceGeneration === owner.workbenchWorkspaceGeneration
      && request.conversationId === owner.conversationId;
  }
  return !request.workbenchRouteKey
    && !request.workbenchWorkspaceGeneration
    && request.conversationId === owner.conversationId;
}

function rejectTerminalOwnerMismatch(msg, terminalId) {
  ctx.sendToServer({
    type: 'terminal_error',
    conversationId: msg?.conversationId,
    terminalId,
    message: 'Terminal owner mismatch',
    ...terminalRoutingFields(msg),
  });
}

/**
 * Fail closed when the Agent transport loses its Server-side owner state.
 * Pending creates are cancelled before their backend resolves; established
 * PTYs are removed from the owner map before kill so synchronous or delayed
 * exit callbacks cannot affect a replacement terminal with the same id.
 * No wire event is emitted because the transport is unavailable.
 */
export function cleanupTerminalsForDisconnect() {
  const terminals = [...ctx.terminals.entries()];
  if (terminals.length === 0) return 0;

  for (const [, term] of terminals) {
    term.cancelled = true;
    if (term.timer) {
      clearTimeout(term.timer);
      term.timer = null;
    }
  }
  ctx.terminals.clear();

  for (const [, term] of terminals) {
    if (!term.pty) continue;
    try { term.pty.kill(); } catch {}
  }
  return terminals.length;
}

export async function handleTerminalCreate(msg) {
  const { conversationId, cols, rows } = msg;
  const terminalId = msg.terminalId || conversationId;
  const conv = ctx.conversations.get(conversationId);
  const routeScoped = !!msg.workbenchRouteKey;
  if (routeScoped && !msg.workbenchWorkspaceGeneration) {
    rejectTerminalOwnerMismatch(msg, terminalId);
    return;
  }
  const workDir = routeScoped
    ? (msg.workDir || ctx.CONFIG.workDir)
    : (conv?.workDir || ctx.CONFIG.workDir);
  const routingFields = terminalRoutingFields(msg);

  // A terminal id is an object capability. It may only be replaced by its
  // immutable owner, never by another Session that guessed the id.
  if (ctx.terminals.has(terminalId)) {
    const existing = ctx.terminals.get(terminalId);
    if (!terminalOwnerMatches(existing, msg)) {
      rejectTerminalOwnerMismatch(msg, terminalId);
      return;
    }
    existing.cancelled = true;
    if (existing.timer) {
      clearTimeout(existing.timer);
      existing.timer = null;
    }
    ctx.terminals.delete(terminalId);
    if (existing.pty) {
      try { existing.pty.kill(); } catch {}
    }
  }

  const pendingCreation = {
    pty: null,
    pending: true,
    cancelled: false,
    conversationId,
    cols: cols || 80,
    rows: rows || 24,
    ...terminalOwner(msg),
    ...routingFields,
  };
  ctx.terminals.set(terminalId, pendingCreation);

  const pty = await loadNodePty();
  if (ctx.terminals.get(terminalId) !== pendingCreation || pendingCreation.cancelled) return;
  if (!pty) {
    ctx.terminals.delete(terminalId);
    ctx.sendToServer({
      type: 'terminal_error',
      conversationId,
      terminalId,
      message: 'Terminal backend is not installed. Run: npm install',
      ...routingFields,
    });
    return;
  }

  try {
    const shell = platform() === 'win32'
      ? (existsSync('C:\\Program Files\\PowerShell\\7\\pwsh.exe')
        ? 'C:\\Program Files\\PowerShell\\7\\pwsh.exe'
        : (existsSync(`${process.env.SystemRoot || 'C:\\Windows'}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`)
          ? `${process.env.SystemRoot || 'C:\\Windows'}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
          : (process.env.COMSPEC || 'cmd.exe')))
      : (process.env.SHELL || 'bash');
    const terminalEnv = { ...process.env };
    const terminalInvocation = wrapInvocationInSystemdUserScope(
      { command: shell, args: [], family: platform() === 'win32' ? 'powershell' : 'posix' },
      {
        runtimePlatform: getRuntimePlatformInfo(),
        env: terminalEnv,
        scopeId: `terminal-${terminalId}`,
        scopePrefix: 'yeaft-terminal',
      },
    );
    const ptyProcess = pty.spawn(terminalInvocation.command, terminalInvocation.args || [], {
      name: 'xterm-256color',
      cols: cols || 80,
      rows: rows || 24,
      cwd: workDir,
      env: terminalEnv
    });

    if (ctx.terminals.get(terminalId) !== pendingCreation || pendingCreation.cancelled) {
      try { ptyProcess.kill(); } catch {}
      return;
    }

    const terminalRecord = {
      pty: ptyProcess,
      cancelled: false,
      conversationId,
      cols: cols || 80,
      rows: rows || 24,
      buffer: '',
      timer: null,
      ...terminalOwner(msg),
      ...routingFields,
    };
    ctx.terminals.set(terminalId, terminalRecord);

    // Output callbacks are fenced to this exact record. A disconnect or
    // same-id replacement removes it before kill, so stale data/exit events
    // cannot leak or delete the replacement.
    ptyProcess.onData(data => {
      if (ctx.terminals.get(terminalId) !== terminalRecord || terminalRecord.cancelled) return;
      terminalRecord.buffer += data;
      if (!terminalRecord.timer) {
        terminalRecord.timer = setTimeout(() => {
          terminalRecord.timer = null;
          if (ctx.terminals.get(terminalId) !== terminalRecord || terminalRecord.cancelled) {
            terminalRecord.buffer = '';
            return;
          }
          ctx.sendToServer({
            type: 'terminal_output',
            conversationId,
            terminalId,
            data: terminalRecord.buffer,
            ...routingFields,
          });
          terminalRecord.buffer = '';
        }, 16);
      }
    });

    ptyProcess.onExit(({ exitCode }) => {
      if (ctx.terminals.get(terminalId) !== terminalRecord || terminalRecord.cancelled) return;
      if (terminalRecord.buffer) {
        ctx.sendToServer({
          type: 'terminal_output',
          conversationId,
          terminalId,
          data: terminalRecord.buffer,
          ...routingFields,
        });
        terminalRecord.buffer = '';
      }
      if (terminalRecord.timer) {
        clearTimeout(terminalRecord.timer);
        terminalRecord.timer = null;
      }

      console.log(`[PTY] Process exited for ${terminalId}, code: ${exitCode}`);
      ctx.terminals.delete(terminalId);
      ctx.sendToServer({
        type: 'terminal_closed',
        conversationId,
        terminalId,
        ...routingFields,
      });
    });

    console.log(`[PTY] Created terminal ${terminalId} for ${conversationId} in ${workDir}`);
    ctx.sendToServer({
      type: 'terminal_created',
      conversationId,
      terminalId,
      success: true,
      ...routingFields,
    });
  } catch (e) {
    if (ctx.terminals.get(terminalId) === pendingCreation) ctx.terminals.delete(terminalId);
    console.error(`[PTY] Failed to create terminal:`, e.message);
    ctx.sendToServer({
      type: 'terminal_error',
      conversationId,
      terminalId,
      message: `Failed to create terminal: ${e.message}`,
      ...routingFields,
    });
  }
}

export function handleTerminalInput(msg) {
  const terminalId = msg.terminalId || msg.conversationId;
  const term = ctx.terminals.get(terminalId);
  if (term?.pty) {
    if (!terminalOwnerMatches(term, msg)) {
      rejectTerminalOwnerMismatch(msg, terminalId);
      return;
    }
    try {
      term.pty.write(msg.data);
    } catch (e) {
      console.error(`[PTY] Write error for ${terminalId}:`, e.message);
    }
  }
}

export function handleTerminalResize(msg) {
  const terminalId = msg.terminalId || msg.conversationId;
  const { cols, rows } = msg;
  const term = ctx.terminals.get(terminalId);
  if (term?.pty && cols > 0 && rows > 0) {
    if (!terminalOwnerMatches(term, msg)) {
      rejectTerminalOwnerMismatch(msg, terminalId);
      return;
    }
    try {
      term.pty.resize(cols, rows);
      term.cols = cols;
      term.rows = rows;
    } catch (e) {
      console.error(`[PTY] Resize error for ${terminalId}:`, e.message);
    }
  }
}

export function handleTerminalClose(msg) {
  const terminalId = msg.terminalId || msg.conversationId;
  const term = ctx.terminals.get(terminalId);
  if (term) {
    if (!terminalOwnerMatches(term, msg)) {
      rejectTerminalOwnerMismatch(msg, terminalId);
      return;
    }
    if (term.pending && !term.pty) {
      term.cancelled = true;
      ctx.terminals.delete(terminalId);
      ctx.sendToServer({
        type: 'terminal_closed',
        conversationId: term.conversationId || msg.conversationId,
        terminalId,
        ...terminalRoutingFields(term),
      });
      return;
    }
    term.cancelled = true;
    if (term.timer) {
      clearTimeout(term.timer);
      term.timer = null;
    }
    ctx.terminals.delete(terminalId);
    if (term.pty) {
      try { term.pty.kill(); } catch {}
    }
    console.log(`[PTY] Closed terminal ${terminalId}`);
    ctx.sendToServer({
      type: 'terminal_closed',
      conversationId: term.conversationId || msg.conversationId,
      terminalId,
      ...terminalRoutingFields(term),
    });
  }
}
