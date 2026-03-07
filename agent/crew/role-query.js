/**
 * Crew — 角色 Query 管理
 * createRoleQuery, buildRoleSystemPrompt, sessionId 持久化, 错误分类
 */
import { query, Stream } from '../sdk/index.js';
import { promises as fs } from 'fs';
import { join } from 'path';
import { getMessages } from '../crew-i18n.js';

/** Format role label */
function roleLabel(r) {
  return r.icon ? `${r.icon} ${r.displayName}` : r.displayName;
}

// =====================================================================
// Session Persistence (role sessionId)
// =====================================================================

/**
 * 保存角色的 claudeSessionId 到文件
 */
export async function saveRoleSessionId(sharedDir, roleName, claudeSessionId) {
  const sessionsDir = join(sharedDir, 'sessions');
  await fs.mkdir(sessionsDir, { recursive: true });
  const filePath = join(sessionsDir, `${roleName}.json`);
  await fs.writeFile(filePath, JSON.stringify({
    claudeSessionId,
    savedAt: Date.now()
  }));
  console.log(`[Crew] Saved sessionId for ${roleName}: ${claudeSessionId}`);
}

/**
 * 从文件加载角色的 claudeSessionId
 */
export async function loadRoleSessionId(sharedDir, roleName) {
  const filePath = join(sharedDir, 'sessions', `${roleName}.json`);
  try {
    const data = JSON.parse(await fs.readFile(filePath, 'utf-8'));
    return data.claudeSessionId || null;
  } catch {
    return null;
  }
}

/**
 * 清除角色的 savedSessionId（用于强制新建 conversation）
 */
export async function clearRoleSessionId(sharedDir, roleName) {
  const filePath = join(sharedDir, 'sessions', `${roleName}.json`);
  try {
    await fs.unlink(filePath);
    console.log(`[Crew] Cleared sessionId for ${roleName} (force new conversation)`);
  } catch {
    // 文件不存在也正常
  }
}

/**
 * 判断角色错误是否可恢复
 */
export function classifyRoleError(error) {
  const msg = error.message || '';
  if (/context.*(window|limit|exceeded)|token.*limit|too.*(long|large)|max.*token/i.test(msg)) {
    return { recoverable: true, reason: 'context_exceeded' };
  }
  if (/compact|compress|context.*reduc/i.test(msg)) {
    return { recoverable: true, reason: 'compact_failed' };
  }
  if (/rate.?limit|429|overloaded|503|502|timeout|ECONNRESET|ETIMEDOUT/i.test(msg)) {
    return { recoverable: true, reason: 'transient_api_error' };
  }
  if (/exited with code [1-9]/i.test(msg) && msg.length < 100) {
    return { recoverable: true, reason: 'process_crashed' };
  }
  if (/spawn|ENOENT|not found/i.test(msg)) {
    return { recoverable: false, reason: 'spawn_failed' };
  }
  return { recoverable: true, reason: 'unknown' };
}

// =====================================================================
// Role Query Management
// =====================================================================

/**
 * 为角色创建持久 query 实例
 */
export async function createRoleQuery(session, roleName) {
  const role = session.roles.get(roleName);
  if (!role) throw new Error(`Role not found: ${roleName}`);

  // Lazy import to avoid circular dependency
  const { processRoleOutput } = await import('./role-output.js');

  const inputStream = new Stream();
  const abortController = new AbortController();

  const systemPrompt = buildRoleSystemPrompt(role, session);

  // 尝试加载之前保存的 sessionId
  const savedSessionId = await loadRoleSessionId(session.sharedDir, roleName);

  // cwd 设为角色目录
  const roleCwd = join(session.sharedDir, 'roles', roleName);

  const queryOptions = {
    cwd: roleCwd,
    permissionMode: 'bypassPermissions',
    abort: abortController.signal,
    model: role.model || undefined,
    appendSystemPrompt: systemPrompt
  };

  if (savedSessionId) {
    queryOptions.resume = savedSessionId;
    console.log(`[Crew] Resuming ${roleName} with sessionId: ${savedSessionId}`);
  }

  const roleQuery = query({
    prompt: inputStream,
    options: queryOptions
  });

  const roleState = {
    query: roleQuery,
    inputStream,
    abortController,
    accumulatedText: '',
    turnActive: false,
    claudeSessionId: savedSessionId,
    lastCostUsd: 0,
    lastInputTokens: 0,
    lastOutputTokens: 0,
    consecutiveErrors: 0,
    lastDispatchContent: null,
    lastDispatchFrom: null,
    lastDispatchTaskId: null,
    lastDispatchTaskTitle: null
  };

  session.roleStates.set(roleName, roleState);

  // 异步处理角色输出
  processRoleOutput(session, roleName, roleQuery, roleState);

  return roleState;
}

/**
 * 构建角色的 system prompt
 */
export function buildRoleSystemPrompt(role, session) {
  const allRoles = Array.from(session.roles.values());

  let routeTargets;
  if (role.groupIndex > 0) {
    routeTargets = allRoles.filter(r =>
      r.name !== role.name && (r.groupIndex === role.groupIndex || r.groupIndex === 0)
    );
  } else {
    routeTargets = allRoles.filter(r => r.name !== role.name);
  }

  const m = getMessages(session.language || 'zh-CN');

  let prompt = `${m.teamCollab}
${m.teamCollabIntro()}

${m.teamMembers}
${allRoles.map(r => `- ${roleLabel(r)}: ${r.description}${r.isDecisionMaker ? ` (${m.decisionMakerTag})` : ''}`).join('\n')}`;

  const hasMultiInstance = allRoles.some(r => r.groupIndex > 0);

  if (routeTargets.length > 0) {
    prompt += `\n\n${m.routingRules}
${m.routingIntro}

\`\`\`
---ROUTE---
to: <roleName>
summary: <brief description>
---END_ROUTE---
\`\`\`

${m.routeTargets}
${routeTargets.map(r => `- ${r.name}: ${roleLabel(r)} — ${r.description}`).join('\n')}
- human: ${m.humanTarget}

${m.routeNotes(session.decisionMaker)}`;
  }

  // 决策者额外 prompt
  if (role.isDecisionMaker) {
    const isDevTeam = session.teamType === 'dev';

    prompt += `\n\n${m.toolUsage}
${m.toolUsageContent(isDevTeam)}`;

    prompt += `\n\n${m.dmRole}
${m.dmRoleContent}`;

    if (isDevTeam) {
      prompt += m.dmDevExtra;
    }

    if (!isDevTeam) {
      prompt += `\n\n${m.collabMode}
${m.collabModeContent}`;
    }

    if (isDevTeam && hasMultiInstance) {
      const maxGroup = Math.max(...allRoles.map(r => r.groupIndex));
      const groupLines = [];
      for (let g = 1; g <= maxGroup; g++) {
        const members = allRoles.filter(r => r.groupIndex === g);
        const memberStrs = members.map(r => {
          const state = session.roleStates.get(r.name);
          const busy = state?.turnActive;
          const task = state?.currentTask;
          if (busy && task) return `${r.name}(${m.groupBusy(task.taskId + ' ' + task.taskTitle)})`;
          if (busy) return `${r.name}(${m.groupBusyShort})`;
          return `${r.name}(${m.groupIdle})`;
        });
        groupLines.push(`${m.groupLabel(g)}: ${memberStrs.join(' ')}`);
      }

      prompt += `\n\n${m.execGroupStatus}
${groupLines.join(' / ')}

${m.parallelRules}
${m.parallelRulesContent(maxGroup)}

\`\`\`
---ROUTE---
to: dev-1
task: task-1
taskTitle: ${m.implLoginPage}
summary: ${m.implLoginSummary}
---END_ROUTE---

---ROUTE---
to: dev-2
task: task-2
taskTitle: ${m.implRegisterPage}
summary: ${m.implRegisterSummary}
---END_ROUTE---
\`\`\`

${m.parallelExample}`;
    }

    prompt += `\n
${m.workflowEnd}
${m.workflowEndContent(isDevTeam)}

${m.taskList}
${m.taskListContent}

\`\`\`
${m.taskExample}
\`\`\`

${m.taskListNotes}`;
  }

  // Feature 进度文件说明
  prompt += `\n\n${m.featureRecordTitle}
${m.featureRecordContent}

${m.contextRestartTitle}
${m.contextRestartContent}`;

  // 执行者角色的组绑定 prompt
  if (role.groupIndex > 0 && role.roleType === 'developer') {
    const gi = role.groupIndex;
    const rev = allRoles.find(r => r.roleType === 'reviewer' && r.groupIndex === gi);
    const test = allRoles.find(r => r.roleType === 'tester' && r.groupIndex === gi);
    if (rev && test) {
      prompt += `\n\n${m.devGroupBinding}
${m.devGroupBindingContent(gi, roleLabel(rev), rev.name, roleLabel(test), test.name)}

\`\`\`
---ROUTE---
to: ${rev.name}
summary: ${m.reviewCode}
---END_ROUTE---

---ROUTE---
to: ${test.name}
summary: ${m.testFeature}
---END_ROUTE---
\`\`\`

${m.devGroupBindingNote}`;
    }
  }

  // Language instruction
  if (session.language === 'en') {
    prompt += `\n\n# Language
Always respond in English. Use English for all explanations, comments, and communications with the user. Technical terms and code identifiers should remain in their original form.`;
  } else {
    prompt += `\n\n# Language
Always respond in 中文. Use 中文 for all explanations, comments, and communications with the user. Technical terms and code identifiers should remain in their original form.`;
  }

  return prompt;
}
