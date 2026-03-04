import WebSocket from 'ws';
import { execSync, execFile, spawn } from 'child_process';
import { writeFileSync, mkdirSync, existsSync, cpSync, rmSync } from 'fs';
import { join } from 'path';
import { platform } from 'os';
import ctx from './context.js';
import { getConfigDir } from './service.js';
import { encrypt, decrypt, isEncrypted, decodeKey } from './encryption.js';
import { handleTerminalCreate, handleTerminalInput, handleTerminalResize, handleTerminalClose } from './terminal.js';
import { handleProxyHttpRequest, handleProxyWsOpen, handleProxyWsMessage, handleProxyWsClose } from './proxy.js';
import {
  handleReadFile, handleWriteFile, handleListDirectory,
  handleGitStatus, handleGitDiff, handleGitAdd, handleGitReset, handleGitRestore, handleGitCommit, handleGitPush,
  handleFileSearch, handleCreateFile, handleDeleteFiles, handleMoveFiles, handleCopyFiles, handleUploadToDir, handleTransferFiles
} from './workbench.js';
import { handleListHistorySessions, handleListFolders } from './history.js';
import {
  createConversation, resumeConversation, deleteConversation,
  handleRefreshConversation, handleCancelExecution,
  handleUserInput, handleUpdateConversationSettings, handleAskUserAnswer,
  sendConversationList
} from './conversation.js';
import {
  createCrewSession, handleCrewHumanInput, handleCrewControl,
  addRoleToSession, removeRoleFromSession,
  handleListCrewSessions, resumeCrewSession, removeFromCrewIndex
} from './crew.js';

// 需要在断连期间缓冲的消息类型（Claude 输出相关的关键消息）
const BUFFERABLE_TYPES = new Set([
  'claude_output', 'turn_completed', 'conversation_closed',
  'session_id_update', 'compact_status', 'slash_commands_update',
  'background_task_started', 'background_task_output',
  'crew_output', 'crew_status', 'crew_turn_completed',
  'crew_session_created', 'crew_session_restored', 'crew_human_needed',
  'crew_role_added', 'crew_role_removed'
]);

// Send message to server (with encryption if available)
// 断连时对关键消息类型进行缓冲，重连后自动 flush
async function sendToServer(msg) {
  if (!ctx.ws || ctx.ws.readyState !== WebSocket.OPEN) {
    // 缓冲关键消息
    if (BUFFERABLE_TYPES.has(msg.type)) {
      if (ctx.messageBuffer.length < ctx.messageBufferMaxSize) {
        ctx.messageBuffer.push(msg);
        console.log(`[WS] Buffered message: ${msg.type} (queue: ${ctx.messageBuffer.length})`);
      } else {
        // Buffer full: drop oldest non-status messages to make room
        const dropIdx = ctx.messageBuffer.findIndex(m => m.type !== 'crew_status' && m.type !== 'turn_completed');
        if (dropIdx >= 0) {
          ctx.messageBuffer.splice(dropIdx, 1);
          ctx.messageBuffer.push(msg);
          console.warn(`[WS] Buffer full, dropped oldest to make room for: ${msg.type}`);
        } else {
          console.warn(`[WS] Buffer full (${ctx.messageBufferMaxSize}), dropping: ${msg.type}`);
        }
      }
    } else {
      console.warn(`[WS] Cannot send message, WebSocket not open: ${msg.type}`);
    }
    return;
  }

  try {
    if (ctx.sessionKey) {
      const encrypted = await encrypt(msg, ctx.sessionKey);
      ctx.ws.send(JSON.stringify(encrypted));
    } else {
      ctx.ws.send(JSON.stringify(msg));
    }
  } catch (e) {
    console.error(`[WS] Error sending message ${msg.type}:`, e.message);
    // 发送失败也缓冲
    if (BUFFERABLE_TYPES.has(msg.type) && ctx.messageBuffer.length < ctx.messageBufferMaxSize) {
      ctx.messageBuffer.push(msg);
      console.log(`[WS] Send failed, buffered: ${msg.type}`);
    }
  }
}

// Flush 断连期间缓冲的消息
async function flushMessageBuffer() {
  if (ctx.messageBuffer.length === 0) return;

  const buffered = ctx.messageBuffer.splice(0);
  console.log(`[WS] Flushing ${buffered.length} buffered messages...`);

  for (const msg of buffered) {
    await sendToServer(msg);
  }

  console.log(`[WS] Flush complete`);
}

// Parse incoming message (decrypt if encrypted)
async function parseMessage(data) {
  try {
    const parsed = JSON.parse(data.toString());

    if (ctx.sessionKey && isEncrypted(parsed)) {
      return await decrypt(parsed, ctx.sessionKey);
    }

    return parsed;
  } catch (e) {
    console.error('Failed to parse message:', e);
    return null;
  }
}

async function handleMessage(msg) {
  switch (msg.type) {
    case 'registered':
      if (msg.sessionKey) {
        ctx.sessionKey = decodeKey(msg.sessionKey);
        console.log('Encryption enabled');
      }

      // 只保存基本配置（不再保存 agentId，因为现在用 agentName 作为 ID）
      ctx.saveConfig({
        serverUrl: ctx.CONFIG.serverUrl,
        agentName: ctx.CONFIG.agentName,
        workDir: ctx.CONFIG.workDir,
        reconnectInterval: ctx.CONFIG.reconnectInterval
        // 不保存 agentSecret 到配置文件（安全考虑）
      });
      console.log(`Registered as agent: ${msg.agentId} (name: ${ctx.CONFIG.agentName})`);

      // Check server-pushed upgrade notification
      if (msg.upgradeAvailable) {
        console.log(`\n  Update available: ${ctx.agentVersion} → ${msg.upgradeAvailable}`);
        console.log(`  Run "yeaft-agent upgrade" to update\n`);
      }

      sendConversationList();

      // ★ Flush 断连期间缓冲的消息
      await flushMessageBuffer();

      // ★ Phase 1: 通知 server 同步完成
      sendToServer({ type: 'agent_sync_complete' });
      break;

    case 'create_conversation':
      await createConversation(msg);
      break;

    case 'resume_conversation':
      await resumeConversation(msg);
      break;

    case 'delete_conversation':
      deleteConversation(msg);
      break;

    case 'get_conversations':
      sendConversationList();
      break;

    case 'list_history_sessions':
      await handleListHistorySessions(msg);
      break;

    case 'list_folders':
      await handleListFolders(msg);
      break;

    case 'transfer_files':
      await handleTransferFiles(msg);
      break;

    case 'execute':
      await handleUserInput(msg);
      break;

    case 'cancel_execution':
      await handleCancelExecution(msg);
      break;

    // clear_queue 和 cancel_queued_message 已移至 server 端管理 (Phase 3.6)

    case 'refresh_conversation':
      await handleRefreshConversation(msg);
      break;

    // Terminal (PTY) messages
    case 'terminal_create':
      await handleTerminalCreate(msg);
      break;

    case 'terminal_input':
      handleTerminalInput(msg);
      break;

    case 'terminal_resize':
      handleTerminalResize(msg);
      break;

    case 'terminal_close':
      handleTerminalClose(msg);
      break;

    // File operation messages
    case 'read_file':
      await handleReadFile(msg);
      break;

    case 'write_file':
      await handleWriteFile(msg);
      break;

    case 'list_directory':
      await handleListDirectory(msg);
      break;

    case 'git_status':
      await handleGitStatus(msg);
      break;

    case 'git_diff':
      await handleGitDiff(msg);
      break;

    case 'git_add':
      await handleGitAdd(msg);
      break;

    case 'git_reset':
      await handleGitReset(msg);
      break;

    case 'git_restore':
      await handleGitRestore(msg);
      break;

    case 'git_commit':
      await handleGitCommit(msg);
      break;

    case 'git_push':
      await handleGitPush(msg);
      break;

    case 'file_search':
      await handleFileSearch(msg);
      break;

    case 'create_file':
      await handleCreateFile(msg);
      break;

    case 'delete_files':
      await handleDeleteFiles(msg);
      break;

    case 'move_files':
      await handleMoveFiles(msg);
      break;

    case 'copy_files':
      await handleCopyFiles(msg);
      break;

    case 'upload_to_dir':
      await handleUploadToDir(msg);
      break;

    case 'update_conversation_settings':
      handleUpdateConversationSettings(msg);
      break;

    case 'ask_user_answer':
      handleAskUserAnswer(msg);
      break;

    // Crew (multi-agent) messages
    case 'create_crew_session':
      await createCrewSession(msg);
      break;

    case 'crew_human_input':
      await handleCrewHumanInput(msg);
      break;

    case 'crew_control':
      await handleCrewControl(msg);
      break;

    case 'crew_add_role':
      await addRoleToSession(msg);
      break;

    case 'crew_remove_role':
      await removeRoleFromSession(msg);
      break;

    case 'list_crew_sessions':
      await handleListCrewSessions(msg);
      break;

    case 'resume_crew_session':
      await resumeCrewSession(msg);
      break;

    case 'delete_crew_session':
      await removeFromCrewIndex(msg.sessionId);
      (await import('./conversation.js')).sendConversationList();
      break;

    case 'update_crew_session':
      await (await import('./crew.js')).handleUpdateCrewSession(msg);
      break;

    // Port proxy
    case 'proxy_request':
      handleProxyHttpRequest(msg);
      break;

    case 'proxy_ws_open':
      handleProxyWsOpen(msg);
      break;

    case 'proxy_ws_message':
      handleProxyWsMessage(msg);
      break;

    case 'proxy_ws_close':
      handleProxyWsClose(msg);
      break;

    case 'proxy_update_ports':
      ctx.proxyPorts = msg.ports || [];
      sendToServer({ type: 'proxy_ports_update', ports: ctx.proxyPorts });
      break;

    case 'restart_agent':
      console.log('[Agent] Restart requested, shutting down for PM2/systemd restart...');
      sendToServer({ type: 'restart_agent_ack' });
      // 延迟让 ack 消息发出，然后优雅退出
      setTimeout(() => {
        // 清理终端和会话（与 index.js cleanup 相同逻辑）
        for (const [, term] of ctx.terminals) {
          if (term.pty) { try { term.pty.kill(); } catch {} }
          if (term.timer) clearTimeout(term.timer);
        }
        ctx.terminals.clear();
        for (const [, state] of ctx.conversations) {
          if (state.abortController) state.abortController.abort();
          if (state.inputStream) state.inputStream.done();
        }
        ctx.conversations.clear();
        stopAgentHeartbeat();
        if (ctx.ws) {
          // 禁止自动重连，让 process.exit 干净退出
          ctx.ws.removeAllListeners('close');
          ctx.ws.close();
        }
        clearTimeout(ctx.reconnectTimer);
        console.log('[Agent] Cleanup done, exiting with code 1 for auto-restart...');
        process.exit(1);
      }, 500);
      break;

    case 'upgrade_agent':
      console.log('[Agent] Upgrade requested, checking for updates...');
      (async () => {
        try {
          const pkgName = ctx.pkgName || '@yeaft/webchat-agent';
          // Check latest version (async to avoid blocking heartbeat)
          const latestVersion = await new Promise((resolve, reject) => {
            execFile('npm', ['view', pkgName, 'version'], { stdio: 'pipe', shell: true }, (err, stdout) => {
              if (err) reject(err); else resolve(stdout.toString().trim());
            });
          });
          if (latestVersion === ctx.agentVersion) {
            console.log(`[Agent] Already at latest version (${ctx.agentVersion}), skipping upgrade.`);
            sendToServer({ type: 'upgrade_agent_ack', success: true, alreadyLatest: true, version: ctx.agentVersion });
            return;
          }
          console.log(`[Agent] Upgrading from ${ctx.agentVersion} to latest (${latestVersion})...`);

          // 检测安装方式：npm install 的路径包含 node_modules，源码运行则不包含
          const scriptPath = (process.argv[1] || '').replace(/\\/g, '/');
          const nmIndex = scriptPath.lastIndexOf('/node_modules/');
          const isNpmInstall = nmIndex !== -1;

          if (!isNpmInstall) {
            // 源码运行不支持远程升级（代码在 git repo 中，需要手动 git pull）
            console.log('[Agent] Source-based install detected, remote upgrade not supported.');
            sendToServer({ type: 'upgrade_agent_ack', success: false, error: 'Source-based install: please use git pull to upgrade' });
            return;
          }

          // 提取 node_modules 的父目录（即 npm install 执行时的项目目录或全局 prefix）
          // 例如 /usr/lib/node_modules/@yeaft/webchat-agent/cli.js → /usr/lib
          // 例如 C:/Users/x/myproject/node_modules/@yeaft/webchat-agent/cli.js → C:/Users/x/myproject
          const installDir = scriptPath.substring(0, nmIndex);

          // 判断全局安装 vs 局部安装
          // npm 全局 node_modules: prefix/lib/node_modules (Linux/macOS) 或 prefix/node_modules (Windows)
          const isGlobalInstall = await new Promise((resolve) => {
            execFile('npm', ['prefix', '-g'], { shell: true }, (err, stdout) => {
              if (err) { resolve(false); return; }
              const globalPrefix = stdout.toString().trim().replace(/\\/g, '/');
              resolve(installDir === globalPrefix || installDir === globalPrefix + '/lib');
            });
          });

          const isWindows = platform() === 'win32';
          // 全局安装用 npm install -g，局部安装在 installDir 下 npm install
          // 不指定版本号，直接用 @latest 确保安装最新版
          const npmArgs = isGlobalInstall
            ? ['install', '-g', `${pkgName}@latest`]
            : ['install', `${pkgName}@latest`];

          if (isWindows) {
            // Windows: 进程持有文件锁，npm install 无法覆盖正在运行的模块文件 (EBUSY)
            // 策略：生成 detached bat 脚本，等当前进程退出后再 npm install
            const pid = process.pid;
            const configDir = getConfigDir();
            mkdirSync(configDir, { recursive: true });
            const logDir = join(configDir, 'logs');
            mkdirSync(logDir, { recursive: true });
            const batPath = join(configDir, 'upgrade.bat');
            const logPath = join(logDir, 'upgrade.log');
            const isPm2 = !!process.env.pm_id;
            const installDirWin = installDir.replace(/\//g, '\\');

            const batLines = [
              '@echo off',
              'setlocal',
              `set PID=${pid}`,
              `set PKG=${pkgName}@latest`,
              `set INSTALL_DIR=${installDirWin}`,
              `set LOGFILE=${logPath}`,
              `set MAX_WAIT=30`,
              `set COUNT=0`,
              '',
              ':: Redirect all output to log file',
              'echo [Upgrade] Started at %date% %time% > "%LOGFILE%"',
              ':WAIT_LOOP',
              'tasklist /FI "PID eq %PID%" 2>NUL | find /I "%PID%" >NUL',
              'if errorlevel 1 goto PID_EXITED',
              'set /A COUNT+=1',
              'if %COUNT% GEQ %MAX_WAIT% (',
              '  echo [Upgrade] Timeout waiting for PID %PID% to exit after 60s >> "%LOGFILE%"',
              '  goto PID_EXITED',
              ')',
              'timeout /T 2 /NOBREAK >NUL',
              'goto WAIT_LOOP',
              ':PID_EXITED',
            ];

            if (isPm2) {
              // pm2 可能已自动重启旧代码（exit 触发），先 stop 释放文件锁
              batLines.push(
                'echo [Upgrade] Stopping pm2 agent to release file locks... >> "%LOGFILE%"',
                'call pm2 stop yeaft-agent >> "%LOGFILE%" 2>&1',
                'timeout /T 3 /NOBREAK >NUL',
              );
            }

            const npmBatCmd = isGlobalInstall
              ? 'call npm install -g %PKG%'
              : 'cd /d "%INSTALL_DIR%" && call npm install %PKG%';

            batLines.push(
              'echo [Upgrade] Installing %PKG%... >> "%LOGFILE%"',
              `${npmBatCmd} >> "%LOGFILE%" 2>&1`,
              'if errorlevel 1 (',
              '  echo [Upgrade] npm install failed with exit code %errorlevel% >> "%LOGFILE%"',
              '  goto CLEANUP',
              ')',
              'echo [Upgrade] Successfully installed %PKG% >> "%LOGFILE%"',
            );

            if (isPm2) {
              batLines.push(
                'echo [Upgrade] Starting agent via pm2... >> "%LOGFILE%"',
                'call pm2 start yeaft-agent >> "%LOGFILE%" 2>&1',
              );
            }

            batLines.push(
              ':CLEANUP',
              `del /F /Q "${batPath}"`,
            );

            writeFileSync(batPath, batLines.join('\r\n'));
            const child = spawn('cmd.exe', ['/c', batPath], {
              detached: true,
              stdio: 'ignore',
              windowsHide: true
            });
            child.unref();
            console.log(`[Agent] Spawned upgrade script (PID wait for ${pid}, pm2=${isPm2}, dir=${installDir}): ${batPath}`);
            sendToServer({ type: 'upgrade_agent_ack', success: true, version: latestVersion, pendingRestart: true });

            if (isPm2) {
              // PM2 环境：先同步 pm2 stop 防止 autorestart 竞态，再 exit
              try { execSync('pm2 stop yeaft-agent', { timeout: 5000 }); } catch {}
            }
          } else {
            // Linux/macOS: 生成 detached shell 脚本，先停止服务再升级再启动
            // 避免在升级过程中 systemd 不断重启已删除的旧版本
            const pid = process.pid;
            const configDir = getConfigDir();
            mkdirSync(configDir, { recursive: true });
            const shPath = join(configDir, 'upgrade.sh');
            const isSystemd = existsSync(join(process.env.HOME || '', '.config', 'systemd', 'user', 'yeaft-agent.service'));
            const isLaunchd = platform() === 'darwin' && existsSync(join(process.env.HOME || '', 'Library', 'LaunchAgents', 'com.yeaft.agent.plist'));
            const cwd = isGlobalInstall ? undefined : installDir;

            const shLines = [
              '#!/bin/bash',
              `PID=${pid}`,
              `PKG="${pkgName}@latest"`,
              `LOGFILE="${join(configDir, 'logs', 'upgrade.log')}"`,
              `export PATH="${process.env.PATH}"`,
              '',
              '# Redirect all output to log file',
              'exec > "$LOGFILE" 2>&1',
              'echo "[Upgrade] Started at $(date)"',
              '',
              ...(cwd ? [`INSTALL_DIR="${cwd}"`] : []),
              '',
              '# Wait for current process to exit',
              'COUNT=0',
              'while kill -0 $PID 2>/dev/null; do',
              '  COUNT=$((COUNT+1))',
              '  if [ $COUNT -ge 30 ]; then',
              '    echo "[Upgrade] Timeout waiting for PID $PID to exit"',
              '    break',
              '  fi',
              '  sleep 2',
              'done',
              '',
            ];

            // 停止服务管理器的自动重启
            if (isSystemd) {
              shLines.push(
                '# Stop systemd service to prevent restart loop',
                'systemctl --user stop yeaft-agent 2>/dev/null',
                'sleep 1',
                '',
              );
            } else if (isLaunchd) {
              const plistPath = join(process.env.HOME || '', 'Library', 'LaunchAgents', 'com.yeaft.agent.plist');
              shLines.push(
                '# Unload launchd service to prevent restart loop',
                `launchctl unload "${plistPath}" 2>/dev/null`,
                'sleep 1',
                '',
              );
            }

            // npm install
            const npmCmd = isGlobalInstall
              ? `npm install -g "$PKG"`
              : `cd "$INSTALL_DIR" && npm install "$PKG"`;

            shLines.push(
              'echo "[Upgrade] Installing $PKG..."',
              npmCmd,
              'EXIT_CODE=$?',
              'if [ $EXIT_CODE -ne 0 ]; then',
              '  echo "[Upgrade] npm install failed with exit code $EXIT_CODE"',
              'else',
              '  echo "[Upgrade] Successfully installed $PKG"',
              'fi',
              '',
            );

            // 重新启动服务
            if (isSystemd) {
              shLines.push(
                '# Restart systemd service',
                'systemctl --user start yeaft-agent',
                'echo "[Upgrade] Service restarted via systemd"',
              );
            } else if (isLaunchd) {
              const plistPath = join(process.env.HOME || '', 'Library', 'LaunchAgents', 'com.yeaft.agent.plist');
              shLines.push(
                '# Reload launchd service',
                `launchctl load "${plistPath}"`,
                'echo "[Upgrade] Service restarted via launchd"',
              );
            }

            // 清理脚本自身
            shLines.push('', `rm -f "${shPath}"`);

            writeFileSync(shPath, shLines.join('\n'), { mode: 0o755 });
            const child = spawn('bash', [shPath], {
              detached: true,
              stdio: 'ignore',
            });
            child.unref();
            console.log(`[Agent] Spawned upgrade script: ${shPath}`);
            sendToServer({ type: 'upgrade_agent_ack', success: true, version: latestVersion, pendingRestart: true });
          }

          // 清理并退出，让升级脚本接管
          setTimeout(() => {
            for (const [, term] of ctx.terminals) {
              if (term.pty) { try { term.pty.kill(); } catch {} }
              if (term.timer) clearTimeout(term.timer);
            }
            ctx.terminals.clear();
            for (const [, state] of ctx.conversations) {
              if (state.abortController) state.abortController.abort();
              if (state.inputStream) state.inputStream.done();
            }
            ctx.conversations.clear();
            stopAgentHeartbeat();
            if (ctx.ws) {
              ctx.ws.removeAllListeners('close');
              ctx.ws.close();
            }
            clearTimeout(ctx.reconnectTimer);
            console.log('[Agent] Cleanup done, exiting for upgrade...');
            process.exit(0);
          }, 500);
        } catch (e) {
          console.error('[Agent] Upgrade failed:', e.message);
          sendToServer({ type: 'upgrade_agent_ack', success: false, error: e.message });
        }
      })();
      break;
  }
}

export function startAgentHeartbeat() {
  stopAgentHeartbeat();
  ctx.lastPongAt = Date.now();

  // 监听 pong 帧
  if (ctx.ws) {
    ctx.ws.on('pong', () => {
      ctx.lastPongAt = Date.now();
    });
  }

  ctx.agentHeartbeatTimer = setInterval(() => {
    if (!ctx.ws || ctx.ws.readyState !== WebSocket.OPEN) return;

    // 检查上次 pong 是否超时
    const sincePong = Date.now() - ctx.lastPongAt;
    if (sincePong > 45000) {
      console.warn(`[Heartbeat] No pong for ${Math.round(sincePong / 1000)}s, reconnecting...`);
      ctx.ws.terminate();
      return;
    }

    try {
      ctx.ws.ping();
    } catch (e) {
      console.warn('[Heartbeat] Failed to send ping:', e.message);
    }
  }, 25000);
}

export function stopAgentHeartbeat() {
  if (ctx.agentHeartbeatTimer) {
    clearInterval(ctx.agentHeartbeatTimer);
    ctx.agentHeartbeatTimer = null;
  }
}

export function scheduleReconnect() {
  clearTimeout(ctx.reconnectTimer);
  ctx.reconnectTimer = setTimeout(() => {
    console.log('Attempting to reconnect...');
    connect();
  }, ctx.CONFIG.reconnectInterval);
}

export function connect() {
  // Don't include secret in URL - it will be sent via WebSocket message after connection
  // 使用 agentName 作为唯一标识（不再使用随机 UUID）
  const params = new URLSearchParams({
    type: 'agent',
    id: ctx.CONFIG.agentName,  // 直接用名称作为 ID
    name: ctx.CONFIG.agentName,
    workDir: ctx.CONFIG.workDir,
    capabilities: ctx.agentCapabilities.join(',')
  });

  const url = `${ctx.CONFIG.serverUrl}?${params.toString()}`;
  console.log(`Connecting to server: ${ctx.CONFIG.serverUrl}`);
  if (ctx.CONFIG.disallowedTools.length > 0) {
    console.log(`Disallowed tools: ${ctx.CONFIG.disallowedTools.join(', ')}`);
  }

  ctx.ws = new WebSocket(url);

  ctx.ws.on('open', () => {
    console.log('Connected to server, waiting for auth challenge...');
    clearTimeout(ctx.reconnectTimer);
    // 启动 agent 端心跳: 每 25 秒发一次 ping 帧
    startAgentHeartbeat();
  });

  ctx.ws.on('message', async (data) => {
    // 收到任何消息都说明连接活着
    ctx.lastPongAt = Date.now();

    // Check for auth_required message (unencrypted)
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'auth_required' && msg.tempId) {
        console.log('Received auth challenge, sending credentials...');
        ctx.pendingAuthTempId = msg.tempId;
        // Send authentication via WebSocket (not URL)
        ctx.ws.send(JSON.stringify({
          type: 'auth',
          tempId: msg.tempId,
          secret: ctx.CONFIG.agentSecret,
          capabilities: ctx.agentCapabilities,
          version: ctx.agentVersion
        }));
        return;
      }
    } catch (e) {
      // Not JSON or parse error - continue to normal handling
    }

    const msg = await parseMessage(data);
    if (msg) {
      handleMessage(msg);
    }
  });

  ctx.ws.on('close', (code, reason) => {
    console.log(`Disconnected from server: ${code} ${reason}`);
    ctx.sessionKey = null;
    ctx.pendingAuthTempId = null;
    stopAgentHeartbeat();

    if (code === 1008) {
      console.error('Authentication failed. Check AGENT_SECRET configuration.');
      return;
    }

    scheduleReconnect();
  });

  ctx.ws.on('error', (err) => {
    console.error('WebSocket error:', err.message);
  });
}

// 注册 sendToServer 到 ctx 供其他模块使用
ctx.sendToServer = sendToServer;
