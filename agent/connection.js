import WebSocket from 'ws';
import { execSync, execFile } from 'child_process';
import ctx from './context.js';
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

// 需要在断连期间缓冲的消息类型（Claude 输出相关的关键消息）
const BUFFERABLE_TYPES = new Set([
  'claude_output', 'turn_completed', 'conversation_closed',
  'session_id_update', 'compact_status', 'slash_commands_update',
  'background_task_started', 'background_task_output'
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
        console.warn(`[WS] Buffer full (${ctx.messageBufferMaxSize}), dropping: ${msg.type}`);
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
          console.log(`[Agent] Upgrading from ${ctx.agentVersion} to ${latestVersion}...`);
          // Use async execFile to avoid blocking event loop (heartbeat must keep running)
          await new Promise((resolve, reject) => {
            execFile('npm', ['install', '-g', `${pkgName}@latest`], { stdio: 'pipe', shell: true }, (err) => {
              if (err) reject(err); else resolve();
            });
          });
          console.log('[Agent] Upgrade successful, restarting...');
          sendToServer({ type: 'upgrade_agent_ack', success: true, version: latestVersion });
          // Restart after upgrade (same as restart_agent)
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
            console.log('[Agent] Cleanup done, exiting for auto-restart...');
            process.exit(1);
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
