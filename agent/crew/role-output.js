/**
 * Crew — 角色输出处理
 * processRoleOutput（核心流式输出处理循环）
 */
import { sendCrewMessage, sendCrewOutput, sendStatusUpdate, endRoleStreaming } from './ui-messages.js';
import { saveRoleSessionId, clearRoleSessionId, classifyRoleError, createRoleQuery } from './role-query.js';
import { parseRoutes, executeRoute, dispatchToRole } from './routing.js';
import { parseCompletedTasks, updateFeatureIndex, appendChangelog } from './task-files.js';

// Context 使用率阈值常量
const MAX_CONTEXT = 128000;       // API max_prompt_tokens 限制
const COMPACT_THRESHOLD = 0.85;   // 85% → 触发预防性 compact
const CLEAR_THRESHOLD = 0.95;     // 95% → compact 后仍超限则 clear + rebuild

/**
 * 处理角色的流式输出
 */
export async function processRoleOutput(session, roleName, roleQuery, roleState) {
  try {
    for await (const message of roleQuery) {
      // 检查 session 是否已停止或暂停
      if (session.status === 'stopped' || session.status === 'paused') break;

      if (message.type === 'system' && message.subtype === 'init') {
        roleState.claudeSessionId = message.session_id;
        console.log(`[Crew] ${roleName} session: ${message.session_id}`);
        continue;
      }

      // compact 消息过滤
      if (roleState._compacting && message.type !== 'result') {
        if (message.type === 'system') {
          if (message.subtype === 'compact_boundary') {
            roleState._compactSummaryPending = true;
          }
          continue;
        }
        if (message.type === 'user' && roleState._compactSummaryPending) {
          roleState._compactSummaryPending = false;
          continue;
        }
        continue;
      }

      if (message.type === 'assistant') {
        const content = message.message?.content;
        if (content) {
          if (typeof content === 'string') {
            roleState.accumulatedText += content;
            sendCrewOutput(session, roleName, 'text', message);
          } else if (Array.isArray(content)) {
            let hasText = false;
            for (const block of content) {
              if (block.type === 'text') {
                roleState.accumulatedText += block.text;
                hasText = true;
              } else if (block.type === 'tool_use') {
                endRoleStreaming(session, roleName);
                roleState.currentTool = block.name;
                sendCrewOutput(session, roleName, 'tool_use', message);
              }
            }
            if (hasText) {
              sendCrewOutput(session, roleName, 'text', message);
            }
          }
        }
      } else if (message.type === 'user') {
        roleState.currentTool = null;
        sendCrewOutput(session, roleName, 'tool_result', message);
      } else if (message.type === 'result') {
        // Turn 完成
        console.log(`[Crew] ${roleName} turn completed`);
        roleState.consecutiveErrors = 0;

        endRoleStreaming(session, roleName);

        // 更新费用（差值计算）
        if (message.total_cost_usd != null) {
          const costDelta = message.total_cost_usd - roleState.lastCostUsd;
          if (costDelta > 0) session.costUsd += costDelta;
          roleState.lastCostUsd = message.total_cost_usd;
        }
        if (message.usage) {
          const inputDelta = (message.usage.input_tokens || 0) - (roleState.lastInputTokens || 0);
          const outputDelta = (message.usage.output_tokens || 0) - (roleState.lastOutputTokens || 0);
          if (inputDelta > 0) session.totalInputTokens += inputDelta;
          if (outputDelta > 0) session.totalOutputTokens += outputDelta;
          roleState.lastInputTokens = message.usage.input_tokens || 0;
          roleState.lastOutputTokens = message.usage.output_tokens || 0;
        }

        // compact turn 完成的处理
        if (roleState._compacting) {
          roleState._compacting = false;
          const postCompactTokens = message.usage?.input_tokens || 0;
          const postCompactPercentage = postCompactTokens / MAX_CONTEXT;
          console.log(`[Crew] ${roleName} compact completed, context now at ${Math.round(postCompactPercentage * 100)}%`);

          sendCrewMessage({
            type: 'crew_role_compact',
            sessionId: session.id,
            role: roleName,
            contextPercentage: Math.round(postCompactPercentage * 100),
            status: 'completed'
          });

          // Layer 2: compact 后仍超 95% → clear + rebuild
          if (postCompactPercentage >= CLEAR_THRESHOLD) {
            console.warn(`[Crew] ${roleName} still at ${Math.round(postCompactPercentage * 100)}% after compact, escalating to clear`);

            await clearRoleSessionId(session.sharedDir, roleName);
            roleState.claudeSessionId = null;

            if (roleState.abortController) roleState.abortController.abort();
            roleState.query = null;
            roleState.inputStream = null;

            sendCrewMessage({
              type: 'crew_role_compact',
              sessionId: session.id,
              role: roleName,
              status: 'cleared'
            });

            if (roleState._pendingCompactRoutes) {
              const routes = roleState._pendingCompactRoutes;
              const fromRole = roleState._fromRole;
              roleState._pendingCompactRoutes = null;
              roleState._fromRole = null;
              session.round++;
              const results = await Promise.allSettled(routes.map(route =>
                executeRoute(session, fromRole, route)
              ));
              for (const r of results) {
                if (r.status === 'rejected') {
                  console.warn(`[Crew] Route execution failed:`, r.reason);
                }
              }
            } else if (roleState._pendingDispatch) {
              const pd = roleState._pendingDispatch;
              roleState._pendingDispatch = null;
              await dispatchToRole(session, roleName, pd.content, pd.from, pd.taskId, pd.taskTitle);
            }
            return; // abort 后 query 已清空，退出
          }

          // 执行之前缓存的路由
          if (roleState._pendingCompactRoutes) {
            const routes = roleState._pendingCompactRoutes;
            const fromRole = roleState._fromRole;
            roleState._pendingCompactRoutes = null;
            roleState._fromRole = null;
            session.round++;
            const results = await Promise.allSettled(routes.map(route =>
              executeRoute(session, fromRole, route)
            ));
            for (const r of results) {
              if (r.status === 'rejected') {
                console.warn(`[Crew] Route execution failed:`, r.reason);
              }
            }
          } else if (roleState._pendingDispatch) {
            const pd = roleState._pendingDispatch;
            roleState._pendingDispatch = null;
            await dispatchToRole(session, roleName, pd.content, pd.from, pd.taskId, pd.taskTitle);
          }
          continue; // 不要重复处理这个 compact result
        }

        // 持久化 sessionId
        if (roleState.claudeSessionId) {
          saveRoleSessionId(session.sharedDir, roleName, roleState.claudeSessionId)
            .catch(e => console.warn(`[Crew] Failed to save sessionId for ${roleName}:`, e.message));
        }

        // context 使用率监控
        const inputTokens = message.usage?.input_tokens || 0;
        if (inputTokens > 0) {
          sendCrewMessage({
            type: 'crew_context_usage',
            sessionId: session.id,
            role: roleName,
            inputTokens,
            maxTokens: MAX_CONTEXT,
            percentage: Math.min(100, Math.round((inputTokens / MAX_CONTEXT) * 100))
          });
        }

        const contextPercentage = inputTokens / MAX_CONTEXT;
        const needCompact = contextPercentage >= COMPACT_THRESHOLD;

        // 解析路由
        const routes = parseRoutes(roleState.accumulatedText);

        // 决策者 turn 完成：检测 TASKS block 中新完成的任务
        const roleConfig = session.roles.get(roleName);
        if (roleConfig?.isDecisionMaker) {
          const nowCompleted = parseCompletedTasks(roleState.accumulatedText);
          if (nowCompleted.size > 0) {
            const prev = session._completedTaskIds || new Set();
            const newlyDone = [];
            for (const tid of nowCompleted) {
              if (!prev.has(tid)) {
                prev.add(tid);
                newlyDone.push(tid);
              }
            }
            session._completedTaskIds = prev;
            if (newlyDone.length > 0) {
              updateFeatureIndex(session).catch(e => console.warn('[Crew] Failed to update feature index:', e.message));
              for (const tid of newlyDone) {
                const feature = session.features.get(tid);
                const title = feature?.taskTitle || tid;
                appendChangelog(session, tid, title).catch(e => console.warn(`[Crew] Failed to append changelog for ${tid}:`, e.message));
              }
            }
          }
        }

        roleState.accumulatedText = '';
        roleState.turnActive = false;

        sendCrewMessage({
          type: 'crew_turn_completed',
          sessionId: session.id,
          role: roleName
        });

        sendStatusUpdate(session);

        // 需要 compact：缓存路由，先执行 compact
        if (needCompact) {
          console.log(`[Crew] ${roleName} context at ${Math.round(contextPercentage * 100)}%, compacting before next dispatch`);

          roleState._pendingCompactRoutes = routes.length > 0 ? routes : null;
          roleState._compacting = true;
          roleState._compactSummaryPending = false;
          roleState._fromRole = roleName;

          const currentTask = roleState.currentTask;
          if (roleState._pendingCompactRoutes) {
            for (const route of roleState._pendingCompactRoutes) {
              if (!route.taskId && currentTask) {
                route.taskId = currentTask.taskId;
                route.taskTitle = currentTask.taskTitle;
              }
            }
          }

          roleState.inputStream.enqueue({
            type: 'user',
            message: { role: 'user', content: '/compact' }
          });

          sendCrewMessage({
            type: 'crew_role_compact',
            sessionId: session.id,
            role: roleName,
            contextPercentage: Math.round(contextPercentage * 100),
            status: 'compacting'
          });

          continue;
        }

        // 执行路由（无需 compact 时）
        if (routes.length > 0) {
          session.round++;

          const currentTask = roleState.currentTask;
          for (const route of routes) {
            if (!route.taskId && currentTask) {
              route.taskId = currentTask.taskId;
              route.taskTitle = currentTask.taskTitle;
            }
          }

          const results = await Promise.allSettled(routes.map(route =>
            executeRoute(session, roleName, route)
          ));
          for (const r of results) {
            if (r.status === 'rejected') {
              console.warn(`[Crew] Route execution failed:`, r.reason);
            }
          }
        } else {
          const { processHumanQueue } = await import('./human-interaction.js');
          await processHumanQueue(session);
        }
      }
    }
  } catch (error) {
    if (error.name === 'AbortError') {
      console.log(`[Crew] ${roleName} aborted`);
      if (session.status === 'paused' && roleState.accumulatedText) {
        const routes = parseRoutes(roleState.accumulatedText);
        if (routes.length > 0 && session.pendingRoutes.length === 0) {
          session.pendingRoutes = routes.map(route => ({ fromRole: roleName, route }));
          console.log(`[Crew] Saved ${routes.length} pending route(s) from aborted ${roleName}`);
        }
        roleState.accumulatedText = '';
      }
    } else {
      console.error(`[Crew] ${roleName} error:`, error.message);

      // Step 1: 清理 roleState
      endRoleStreaming(session, roleName);
      roleState.query = null;
      roleState.inputStream = null;
      roleState.turnActive = false;
      roleState.accumulatedText = '';
      roleState._compacting = false;
      roleState._compactSummaryPending = false;

      // Step 2: 错误分类
      const classification = classifyRoleError(error);
      roleState.consecutiveErrors++;

      // Step 3: 通知前端
      sendCrewMessage({
        type: 'crew_role_error',
        sessionId: session.id,
        role: roleName,
        error: error.message.substring(0, 500),
        reason: classification.reason,
        recoverable: classification.recoverable,
        retryCount: roleState.consecutiveErrors
      });
      sendStatusUpdate(session);

      // Step 4: 判断是否重试
      const MAX_RETRIES = 3;
      if (!classification.recoverable || roleState.consecutiveErrors > MAX_RETRIES) {
        const exhausted = roleState.consecutiveErrors > MAX_RETRIES;
        const errDetail = exhausted
          ? `角色 ${roleName} 连续 ${MAX_RETRIES} 次错误后停止重试。最后错误: ${error.message}`
          : `角色 ${roleName} 不可恢复错误: ${error.message}`;
        if (roleName !== session.decisionMaker) {
          await dispatchToRole(session, session.decisionMaker, errDetail, 'system');
        } else {
          session.status = 'waiting_human';
          sendCrewMessage({
            type: 'crew_human_needed',
            sessionId: session.id,
            fromRole: roleName,
            reason: 'error',
            message: errDetail
          });
          sendStatusUpdate(session);
        }
        return;
      }

      // Step 5: 可恢复 → 自动重建并重试
      console.log(`[Crew] ${roleName} attempting recovery (${classification.reason}), retry ${roleState.consecutiveErrors}/${MAX_RETRIES}`);

      sendCrewOutput(session, 'system', 'system', {
        type: 'assistant',
        message: { role: 'assistant', content: [{
          type: 'text',
          text: `${roleName} 遇到 ${classification.reason}，正在自动恢复 (${roleState.consecutiveErrors}/${MAX_RETRIES})...`
        }] }
      });

      if (roleState.lastDispatchContent) {
        if (classification.reason === 'context_exceeded') {
          await clearRoleSessionId(session.sharedDir, roleName);
          const newState = await createRoleQuery(session, roleName);

          newState._pendingDispatch = {
            content: roleState.lastDispatchContent,
            from: roleState.lastDispatchFrom || 'system',
            taskId: roleState.lastDispatchTaskId,
            taskTitle: roleState.lastDispatchTaskTitle
          };
          newState._compacting = true;
          newState._compactSummaryPending = false;
          newState.consecutiveErrors = roleState.consecutiveErrors;

          newState.inputStream.enqueue({
            type: 'user',
            message: { role: 'user', content: '/compact' }
          });

          sendCrewMessage({
            type: 'crew_role_compact',
            sessionId: session.id,
            role: roleName,
            status: 'compacting'
          });
        } else {
          if (classification.skipResume) {
            await clearRoleSessionId(session.sharedDir, roleName);
          }
          await dispatchToRole(
            session, roleName,
            roleState.lastDispatchContent,
            roleState.lastDispatchFrom || 'system',
            roleState.lastDispatchTaskId,
            roleState.lastDispatchTaskTitle
          );
        }
      } else {
        const msg = `角色 ${roleName} 已恢复（${classification.reason}），但无待重试消息。`;
        if (roleName !== session.decisionMaker) {
          await dispatchToRole(session, session.decisionMaker, msg, 'system');
        }
      }
    }
  }
}
