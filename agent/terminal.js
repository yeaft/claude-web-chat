import { platform, arch } from 'os';
import { existsSync, chmodSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { createRequire } from 'module';
import ctx from './context.js';

// Fix spawn-helper executable permission on Unix systems.
// npm may strip execute bits from prebuilt binaries, causing
// "posix_spawnp failed" on macOS/Linux.
// TODO: Remove this workaround once node-pty ships with correct permissions.
function fixSpawnHelperPermissions() {
  if (platform() === 'win32') return;
  try {
    const cjsRequire = createRequire(import.meta.url);
    const ptyPkgPath = dirname(cjsRequire.resolve('node-pty/package.json'));
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
    console.warn('[PTY] Failed to fix spawn-helper permissions:', e.message);
  }
}

// 动态加载 node-pty (optionalDependency)
export async function loadNodePty() {
  if (ctx.nodePty !== null) return ctx.nodePty;
  try {
    let pty = await import('node-pty');
    if (pty.default) pty = pty.default;
    fixSpawnHelperPermissions();
    ctx.nodePty = pty;
    console.log('[PTY] node-pty loaded successfully');
    return pty;
  } catch (e) {
    console.warn('[PTY] node-pty not available:', e.message);
    ctx.nodePty = false;
    return false;
  }
}

export async function handleTerminalCreate(msg) {
  const { conversationId, cols, rows } = msg;
  const terminalId = msg.terminalId || conversationId;
  const conv = ctx.conversations.get(conversationId);
  const workDir = conv?.workDir || ctx.CONFIG.workDir;

  // 如果已存在终端，先关闭
  if (ctx.terminals.has(terminalId)) {
    const existing = ctx.terminals.get(terminalId);
    if (existing.pty) {
      try { existing.pty.kill(); } catch {}
    }
    if (existing.timer) clearTimeout(existing.timer);
    ctx.terminals.delete(terminalId);
  }

  const pty = await loadNodePty();
  if (!pty) {
    ctx.sendToServer({
      type: 'terminal_error',
      conversationId,
      terminalId,
      message: 'node-pty is not installed. Run: npm install node-pty'
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
    const ptyProcess = pty.spawn(shell, [], {
      name: 'xterm-256color',
      cols: cols || 80,
      rows: rows || 24,
      cwd: workDir,
      env: process.env
    });

    // 输出缓冲 - 每 16ms 批量发送
    let buffer = '';
    let timer = null;

    ptyProcess.onData(data => {
      buffer += data;
      if (!timer) {
        timer = setTimeout(() => {
          ctx.sendToServer({
            type: 'terminal_output',
            conversationId,
            terminalId,
            data: buffer
          });
          buffer = '';
          timer = null;
        }, 16);
      }
    });

    ptyProcess.onExit(({ exitCode }) => {
      // 发送剩余缓冲
      if (buffer) {
        ctx.sendToServer({
          type: 'terminal_output',
          conversationId,
          terminalId,
          data: buffer
        });
        buffer = '';
      }
      if (timer) clearTimeout(timer);

      console.log(`[PTY] Process exited for ${terminalId}, code: ${exitCode}`);
      ctx.terminals.delete(terminalId);
      ctx.sendToServer({
        type: 'terminal_closed',
        conversationId,
        terminalId
      });
    });

    ctx.terminals.set(terminalId, {
      pty: ptyProcess,
      conversationId,
      cols: cols || 80,
      rows: rows || 24,
      buffer: '',
      timer: null
    });

    console.log(`[PTY] Created terminal ${terminalId} for ${conversationId} in ${workDir}`);
    ctx.sendToServer({
      type: 'terminal_created',
      conversationId,
      terminalId,
      success: true
    });
  } catch (e) {
    console.error(`[PTY] Failed to create terminal:`, e.message);
    ctx.sendToServer({
      type: 'terminal_error',
      conversationId,
      terminalId,
      message: `Failed to create terminal: ${e.message}`
    });
  }
}

export function handleTerminalInput(msg) {
  const terminalId = msg.terminalId || msg.conversationId;
  const term = ctx.terminals.get(terminalId);
  if (term?.pty) {
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
    if (term.pty) {
      try { term.pty.kill(); } catch {}
    }
    if (term.timer) clearTimeout(term.timer);
    ctx.terminals.delete(terminalId);
    console.log(`[PTY] Closed terminal ${terminalId}`);
    ctx.sendToServer({
      type: 'terminal_closed',
      conversationId: term.conversationId || msg.conversationId,
      terminalId
    });
  }
}
