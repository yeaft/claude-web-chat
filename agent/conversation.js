import ctx from './context.js';
import { loadSessionHistory } from './history.js';
import { startClaudeQuery } from './claude.js';
import { crewSessions, loadCrewIndex } from './crew.js';
import { rolePlaySessions, saveRolePlayIndex, removeRolePlaySession, loadRolePlayIndex, validateRolePlayConfig, initRolePlayRouteState } from './roleplay.js';

// Restore persisted roleplay sessions on module load (agent startup)
loadRolePlayIndex();

// 不支持的斜杠命令（真正需要交互式 CLI 的命令）
const UNSUPPORTED_SLASH_COMMANDS = ['/help', '/bug', '/login', '/logout', '/terminal-setup', '/vim', '/config'];

/**
 * 解析斜杠命令
 * @param {string} message - 用户消息
 * @returns {{type: string|null, command?: string, message: string, passthrough?: boolean}}
 */
export function parseSlashCommand(message) {
  const trimmed = message.trim();

  // 检查是否是不支持的斜杠命令
  for (const cmd of UNSUPPORTED_SLASH_COMMANDS) {
    if (trimmed === cmd || trimmed.startsWith(cmd + ' ')) {
      return { type: 'unsupported', command: cmd, message: trimmed };
    }
  }

  // 其他所有 / 开头的命令都传递给 Claude 处理
  // 包括 /compact, /init, /doctor, /memory, /model, /review, /mcp, /cost, /context, /skills
  // 以及用户定义的自定义 skills 如 /commit, /pr 等
  if (trimmed.startsWith('/') && trimmed.length > 1) {
    const match = trimmed.match(/^(\/[a-zA-Z0-9_-]+)/);
    if (match) {
      return { type: 'skill', command: match[1], message: trimmed };
    }
  }

  return { type: null, message };
}

// 发送 conversation 列表（含活跃 crew sessions + 索引中已停止的 crew sessions + roleplay sessions）
export async function sendConversationList() {
  const list = [];
  for (const [id, state] of ctx.conversations) {
    const entry = {
      id,
      workDir: state.workDir,
      claudeSessionId: state.claudeSessionId,
      createdAt: state.createdAt,
      processing: !!state.turnActive,
      userId: state.userId,
      username: state.username
    };
    // roleplay conversations are stored in ctx.conversations but also tracked in rolePlaySessions
    if (rolePlaySessions.has(id)) {
      entry.type = 'rolePlay';
      const rpSession = rolePlaySessions.get(id);
      entry.rolePlayRoles = rpSession.roles;
      // Include route state if initialized
      if (rpSession._routeInitialized) {
        entry.rolePlayState = {
          currentRole: rpSession.currentRole,
          round: rpSession.round,
          features: rpSession.features ? Array.from(rpSession.features.values()) : [],
          waitingHuman: rpSession.waitingHuman || false
        };
      }
    }
    list.push(entry);
  }
  // 追加活跃 crew sessions
  const activeCrewIds = new Set();
  for (const [id, session] of crewSessions) {
    activeCrewIds.add(id);
    list.push({
      id,
      workDir: session.projectDir,
      createdAt: session.createdAt,
      processing: session.status === 'running',
      userId: session.userId,
      username: session.username,
      type: 'crew',
    });
  }
  // 追加索引中已停止的 crew sessions（不重复）
  try {
    const index = await loadCrewIndex();
    for (const entry of index) {
      if (!activeCrewIds.has(entry.sessionId)) {
        list.push({
          id: entry.sessionId,
          workDir: entry.projectDir,
          createdAt: entry.createdAt,
          processing: false,
          userId: entry.userId,
          username: entry.username,
          type: 'crew'
        });
      }
    }
  } catch (e) {
    console.warn('[sendConversationList] Failed to load crew index:', e.message);
  }
  ctx.sendToServer({
    type: 'conversation_list',
    conversations: list
  });
}

export function sendOutput(conversationId, data) {
  return ctx.sendToServer({
    type: 'claude_output',
    conversationId,
    data
  });
}

export function sendError(conversationId, message) {
  ctx.sendToServer({
    type: 'error',
    conversationId,
    message
  });
}

// 创建新的 conversation (延迟启动 Claude，等待用户发送第一条消息)
export async function createConversation(msg) {
  const { conversationId, workDir, userId, username, disallowedTools } = msg;
  const effectiveWorkDir = workDir || ctx.CONFIG.workDir;

  // Validate and sanitize rolePlayConfig if provided
  let rolePlayConfig = null;
  if (msg.rolePlayConfig) {
    const result = validateRolePlayConfig(msg.rolePlayConfig);
    if (!result.valid) {
      console.warn(`[createConversation] Invalid rolePlayConfig: ${result.error}`);
      sendError(conversationId, `Invalid rolePlayConfig: ${result.error}`);
      return;
    }
    rolePlayConfig = result.config;
  }

  console.log(`Creating conversation: ${conversationId} in ${effectiveWorkDir} (lazy start)`);
  if (username) console.log(`  User: ${username} (${userId})`);
  if (rolePlayConfig) console.log(`  RolePlay: teamType=${rolePlayConfig.teamType}, roles=${rolePlayConfig.roles?.length}`);

  // 只创建 conversation 状态，不启动 Claude 进程
  // Claude 进程会在用户发送第一条消息时启动 (见 handleUserInput)
  ctx.conversations.set(conversationId, {
    query: null,
    inputStream: null,
    workDir: effectiveWorkDir,
    claudeSessionId: null,
    createdAt: Date.now(),
    abortController: null,
    tools: [],
    slashCommands: [],
    model: null,
    userId,
    username,
    disallowedTools: disallowedTools || null,  // null = 使用全局默认
    rolePlayConfig: rolePlayConfig || null,
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheRead: 0,
      cacheCreation: 0,
      totalCostUsd: 0
    }
  });

  // Register in rolePlaySessions for type inference in sendConversationList
  if (rolePlayConfig) {
    const rpSession = {
      roles: rolePlayConfig.roles,
      teamType: rolePlayConfig.teamType,
      language: rolePlayConfig.language,
      projectDir: effectiveWorkDir,
      createdAt: Date.now(),
      userId,
      username,
    };
    rolePlaySessions.set(conversationId, rpSession);
    // Initialize route state eagerly so it's ready when Claude starts
    initRolePlayRouteState(rpSession, ctx.conversations.get(conversationId));
    saveRolePlayIndex();
  }

  ctx.sendToServer({
    type: 'conversation_created',
    conversationId,
    workDir: effectiveWorkDir,
    userId,
    username,
    disallowedTools: disallowedTools || null,
    rolePlayConfig: rolePlayConfig || null
  });

  // 立即发送 agent 级别的 MCP servers 列表（从 ~/.claude.json 读取的）
  // 让前端在 Claude CLI init 之前就能显示 MCP 配置入口
  // Claude CLI init 后会用实际 tools 列表覆盖更新
  if (ctx.mcpServers.length > 0) {
    const effectiveDisallowed = disallowedTools || ctx.CONFIG.disallowedTools || [];
    const serversWithState = ctx.mcpServers.map(s => ({
      name: s.name,
      enabled: !effectiveDisallowed.some(d => d === `mcp__${s.name}` || d.startsWith(`mcp__${s.name}__`)),
      source: s.source
    }));
    ctx.sendToServer({
      type: 'conversation_mcp_update',
      conversationId,
      servers: serversWithState
    });
  }

  sendConversationList();
}

// Resume 历史 conversation (延迟启动 Claude，等待用户发送第一条消息)
export async function resumeConversation(msg) {
  const { conversationId, claudeSessionId, workDir, userId, username, disallowedTools } = msg;
  const effectiveWorkDir = workDir || ctx.CONFIG.workDir;

  console.log(`[Resume] conversationId: ${conversationId}`);
  console.log(`[Resume] claudeSessionId: ${claudeSessionId}`);
  console.log(`[Resume] workDir: ${effectiveWorkDir} (lazy start)`);

  // 清理旧条目：同 conversationId 或同 claudeSessionId 的条目（避免重复恢复同一个 session 累积）
  for (const [id, conv] of ctx.conversations) {
    if (id === conversationId || (claudeSessionId && conv.claudeSessionId === claudeSessionId)) {
      console.log(`[Resume] Cleaning up old conversation: ${id} (claudeSessionId: ${conv.claudeSessionId})`);
      if (conv.abortController) {
        conv.abortController.abort();
      }
      if (conv.inputStream) {
        try { conv.inputStream.done(); } catch {}
      }
      ctx.conversations.delete(id);
    }
  }

  const historyMessages = loadSessionHistory(effectiveWorkDir, claudeSessionId);
  if (username) console.log(`[Resume] User: ${username} (${userId})`);
  console.log(`Loaded ${historyMessages.length} history messages`);

  // 只创建 conversation 状态并保存 claudeSessionId，不启动 Claude 进程
  // Claude 进程会在用户发送第一条消息时启动 (见 handleUserInput)
  // Restore rolePlayConfig from persisted rolePlaySessions if available
  const rolePlayEntry = rolePlaySessions.get(conversationId);
  const rolePlayConfig = rolePlayEntry
    ? { roles: rolePlayEntry.roles, teamType: rolePlayEntry.teamType, language: rolePlayEntry.language }
    : null;

  ctx.conversations.set(conversationId, {
    query: null,
    inputStream: null,
    workDir: effectiveWorkDir,
    claudeSessionId: claudeSessionId,  // 保存要恢复的 session ID
    createdAt: Date.now(),
    abortController: null,
    tools: [],
    slashCommands: [],
    model: null,
    userId,
    username,
    disallowedTools: disallowedTools || null,  // null = 使用全局默认
    rolePlayConfig,
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheRead: 0,
      cacheCreation: 0,
      totalCostUsd: 0
    }
  });

  ctx.sendToServer({
    type: 'conversation_resumed',
    conversationId,
    claudeSessionId,
    workDir: effectiveWorkDir,
    historyMessages,
    userId,
    username
  });

  // 立即发送 agent 级别的 MCP servers 列表
  if (ctx.mcpServers.length > 0) {
    const effectiveDisallowed = disallowedTools || ctx.CONFIG.disallowedTools || [];
    const serversWithState = ctx.mcpServers.map(s => ({
      name: s.name,
      enabled: !effectiveDisallowed.some(d => d === `mcp__${s.name}` || d.startsWith(`mcp__${s.name}__`)),
      source: s.source
    }));
    ctx.sendToServer({
      type: 'conversation_mcp_update',
      conversationId,
      servers: serversWithState
    });
  }

  sendConversationList();
}

// 删除 conversation
export function deleteConversation(msg) {
  const { conversationId } = msg;

  console.log(`Deleting conversation: ${conversationId}`);

  // 清理关联的所有终端（一个 conversation 可能有多个分屏终端）
  for (const [terminalId, term] of ctx.terminals.entries()) {
    if (term.conversationId === conversationId || terminalId === conversationId) {
      if (term.pty) {
        try { term.pty.kill(); } catch {}
      }
      if (term.timer) clearTimeout(term.timer);
      ctx.terminals.delete(terminalId);
    }
  }

  const conv = ctx.conversations.get(conversationId);
  if (conv) {
    if (conv.abortController) {
      conv.abortController.abort();
    }
    if (conv.inputStream) {
      conv.inputStream.done();
    }
    ctx.conversations.delete(conversationId);
  }

  // Clean up roleplay session if applicable
  if (rolePlaySessions.has(conversationId)) {
    removeRolePlaySession(conversationId);
  }

  ctx.sendToServer({
    type: 'conversation_deleted',
    conversationId
  });

  sendConversationList();
}

// 刷新会话状态 - 发送当前会话的处理状态
export async function handleRefreshConversation(msg) {
  const { conversationId } = msg;
  const conv = ctx.conversations.get(conversationId);

  if (!conv) {
    ctx.sendToServer({
      type: 'conversation_refresh',
      conversationId,
      error: 'Conversation not found'
    });
    return;
  }

  // 检查是否有 turn 正在处理（不是 query 是否存在，因为持久模式下 query 一直存在）
  const isRunning = !!conv.turnActive;

  ctx.sendToServer({
    type: 'conversation_refresh',
    conversationId,
    isProcessing: isRunning,
    workDir: conv.workDir,
    claudeSessionId: conv.claudeSessionId
  });
}

// 取消当前执行
export async function handleCancelExecution(msg) {
  const { conversationId } = msg;

  console.log(`[${conversationId}] Cancelling execution`);

  const state = ctx.conversations.get(conversationId);
  if (!state) {
    console.log(`[${conversationId}] No active conversation found`);
    ctx.sendToServer({
      type: 'execution_cancelled',
      conversationId
    });
    return;
  }

  // 保存当前会话 ID，以便后续可以恢复
  const claudeSessionId = state.claudeSessionId;
  const workDir = state.workDir;

  // 标记为取消状态，防止 processClaudeOutput 的 finally 发送 conversation_closed
  state.cancelled = true;

  // 中止当前查询
  if (state.abortController) {
    state.abortController.abort();
  }

  // 关闭输入流
  if (state.inputStream) {
    state.inputStream.done();
  }

  // 清理当前查询状态，但保留会话信息
  state.query = null;
  state.inputStream = null;
  state.abortController = null;
  state.turnActive = false;

  console.log(`[${conversationId}] Execution cancelled, session: ${claudeSessionId}`);

  // 通知客户端取消完成
  ctx.sendToServer({
    type: 'execution_cancelled',
    conversationId,
    claudeSessionId
  });

  sendConversationList();
}

// 清空排队消息 — 已移至 server 端管理 (Phase 3.6)
// handleClearQueue 和 handleCancelQueuedMessage 不再需要

// 处理用户输入
export async function handleUserInput(msg) {
  const { conversationId, prompt, workDir, claudeSessionId } = msg;

  // 解析斜杠命令
  const slashCommand = parseSlashCommand(prompt);

  // 处理不支持的斜杠命令
  if (slashCommand.type === 'unsupported') {
    console.log(`[${conversationId}] Unsupported slash command: ${slashCommand.command}`);

    sendOutput(conversationId, {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{
          type: 'text',
          text: `命令 \`${slashCommand.command}\` 在远程模式下不可用（需要交互式终端）。\n\n` +
            `**支持的命令：**\n` +
            `- \`/clear\` - 清除当前会话上下文\n` +
            `- \`/compact\` - 压缩会话上下文\n` +
            `- \`/context\` - 显示上下文使用情况\n` +
            `- \`/cost\` - 显示花费信息\n` +
            `- \`/init\` - 初始化项目 CLAUDE.md\n` +
            `- \`/doctor\` - 运行诊断检查\n` +
            `- \`/memory\` - 管理记忆\n` +
            `- \`/model\` - 查看/切换模型\n` +
            `- \`/review\` - 代码审查\n` +
            `- \`/mcp\` - MCP 服务器管理\n` +
            `- \`/<skill-name>\` - 自定义技能（如 /commit, /pr 等）`
        }]
      }
    });
    // 通知前端清除 processing 状态（因为不会启动 Claude 查询，没有 result 消息）
    const existingState = ctx.conversations.get(conversationId);
    ctx.sendToServer({
      type: 'turn_completed',
      conversationId,
      claudeSessionId: existingState?.claudeSessionId,
      workDir: existingState?.workDir || ctx.CONFIG.workDir
    });
    return;
  }

  let state = ctx.conversations.get(conversationId);

  // 如果没有活跃的查询，启动新的
  if (!state || !state.query || !state.inputStream) {
    const resumeSessionId = claudeSessionId || state?.claudeSessionId || null;
    const effectiveWorkDir = workDir || state?.workDir || ctx.CONFIG.workDir;

    console.log(`[SDK] Starting Claude for ${conversationId}, resume: ${resumeSessionId || 'none'}`);
    state = await startClaudeQuery(conversationId, effectiveWorkDir, resumeSessionId);
  }

  // 发送用户消息到输入流
  // Claude stream-json 模式支持在回复过程中接收新消息（写入 stdin）
  let effectivePrompt = prompt;

  // ★ RolePlay: if session was waiting for human input, clear the flag and
  // wrap the user message with context about which role was asking
  const rpSession = rolePlaySessions.get(conversationId);
  if (rpSession && rpSession.waitingHuman && rpSession.waitingHumanContext) {
    const { fromRole, message: requestMessage } = rpSession.waitingHumanContext;
    const fromRoleConfig = rpSession.roles.find?.(r => r.name === fromRole) ||
                           (Array.isArray(rpSession.roles) ? rpSession.roles.find(r => r.name === fromRole) : null);
    const fromLabel = fromRoleConfig
      ? (fromRoleConfig.icon ? `${fromRoleConfig.icon} ${fromRoleConfig.displayName}` : fromRoleConfig.displayName)
      : fromRole;

    effectivePrompt = `人工回复（回应 ${fromLabel} 的请求: "${requestMessage}"）:\n\n${prompt}`;

    rpSession.waitingHuman = false;
    rpSession.waitingHumanContext = null;
    console.log(`[RolePlay] Human responded, resuming from ${fromRole}'s request`);
  }

  const userMessage = {
    type: 'user',
    message: { role: 'user', content: effectivePrompt }
  };

  console.log(`[${conversationId}] Sending: ${prompt.substring(0, 100)}...`);
  state.turnActive = true;
  state.turnResultReceived = false; // 重置 per-turn 去重标志
  sendConversationList(); // 在 turnActive=true 后通知 server，确保 processing 状态正确
  sendOutput(conversationId, userMessage);
  state.inputStream.enqueue(userMessage);
}

// 更新会话设置（如 disallowedTools）
export function handleUpdateConversationSettings(msg) {
  const { conversationId } = msg;
  const conv = ctx.conversations.get(conversationId);
  if (!conv) {
    console.log(`[Settings] Conversation not found: ${conversationId}`);
    return;
  }

  if (msg.disallowedTools !== undefined) {
    conv.disallowedTools = msg.disallowedTools;
    console.log(`[Settings] ${conversationId} disallowedTools updated:`, msg.disallowedTools);
  }

  ctx.sendToServer({
    type: 'conversation_settings_updated',
    conversationId,
    disallowedTools: conv.disallowedTools,
    needRestart: !!conv.query  // Claude 进程已启动则需要重启才能生效
  });
}

// AskUserQuestion 交互式问答

/**
 * 处理 AskUserQuestion 工具调用 — 转发到 Web UI 等待用户回答
 */
export function handleAskUserQuestion(conversationId, input, toolCtx) {
  return new Promise((resolve, reject) => {
    const requestId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

    console.log(`[AskUser] ${conversationId} requesting user input, requestId: ${requestId}`);

    // 发送到 Web UI
    ctx.sendToServer({
      type: 'ask_user_question',
      conversationId,
      requestId,
      questions: input.questions || []
    });

    ctx.pendingUserQuestions.set(requestId, {
      resolve,
      conversationId,
      input
    });

    // 监听 abort signal
    if (toolCtx?.signal) {
      toolCtx.signal.addEventListener('abort', () => {
        ctx.pendingUserQuestions.delete(requestId);
        reject(new Error('aborted'));
      });
    }
  });
}

/**
 * 处理 Web UI 的 AskUserQuestion 回答
 */
export function handleAskUserAnswer(msg) {
  const pending = ctx.pendingUserQuestions.get(msg.requestId);
  if (pending) {
    console.log(`[AskUser] Received answer for ${msg.requestId}`);
    ctx.pendingUserQuestions.delete(msg.requestId);
    pending.resolve({
      behavior: 'allow',
      updatedInput: {
        questions: pending.input.questions,
        answers: msg.answers || {}
      }
    });
  } else {
    console.log(`[AskUser] No pending question for requestId: ${msg.requestId}`);
  }
}
