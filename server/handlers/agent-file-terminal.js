import { randomUUID } from 'crypto';
import { previewFiles, webClients } from '../context.js';
import {
  sendToWebClient, forwardToClients,
  setCachedDir, invalidateParentDirCache, clearAgentDirCache
} from '../ws-utils.js';
import { workbenchRouteKeyFromConversationId } from '../workbench-route.js';

/**
 * Handle file, terminal, and git messages from agent.
 * Types: terminal_created, terminal_output, terminal_closed, terminal_error,
 *        file_content, file_saved, directory_listing, file_op_result,
 *        git_status_result, git_diff_result, git_op_result, file_search_result
 */
async function forwardWorkbenchResponse(agentId, msg) {
  const outbound = { ...msg, agentId };
  const targetClient = outbound._requestClientId
    ? webClients.get(outbound._requestClientId)
    : null;
  const targetMatchesUser = !outbound._requestUserId
    || targetClient?.userId === outbound._requestUserId;
  if (targetClient?.authenticated && targetMatchesUser) {
    const { _requestClientId, _requestUserId, ...cleanMsg } = outbound;
    await sendToWebClient(targetClient, cleanMsg);
    return;
  }
  const { _requestClientId, ...fallbackMsg } = outbound;
  await forwardToClients(agentId, outbound.conversationId, fallbackMsg);
}

export async function handleAgentFileTerminal(agentId, agent, msg) {
  const { workbenchRouteKey: _untrustedRouteKey, ...cleanInbound } = msg || {};
  const routeKey = workbenchRouteKeyFromConversationId(cleanInbound.conversationId, agentId);
  msg = routeKey ? { ...cleanInbound, workbenchRouteKey: routeKey } : cleanInbound;
  switch (msg.type) {
    // Terminal messages (forward to web clients)
    case 'terminal_created':
    case 'terminal_output':
    case 'terminal_closed':
    case 'terminal_error': {
      await forwardWorkbenchResponse(agentId, msg);
      break;
    }

    // File operation messages
    case 'file_content': {
      let fwdMsg = { ...msg, agentId };
      if (msg.binary) {
        // Binary file: cache on server, forward fileId instead of base64 content
        const fileId = randomUUID();
        const token = randomUUID();
        const filename = msg.filePath.split('/').pop() || 'file';
        previewFiles.set(fileId, {
          buffer: Buffer.from(msg.content, 'base64'),
          mimeType: msg.mimeType,
          filename,
          createdAt: Date.now(),
          token
        });
        console.log(`[Server] Cached binary preview: fileId=${fileId}, mime=${msg.mimeType}, path=${msg.filePath}`);
        fwdMsg = {
          type: 'file_content',
          agentId,
          conversationId: msg.conversationId,
          requestId: msg.requestId,
          workbenchRouteKey: msg.workbenchRouteKey,
          _requestUserId: msg._requestUserId,
          _requestClientId: msg._requestClientId,
          filePath: msg.filePath,
          requestedFilePath: msg.requestedFilePath,
          binary: true,
          fileId,
          previewToken: token,
          mimeType: msg.mimeType
        };
      } else {
        console.log(`[Server] Forwarding file_content to clients, conv=${msg.conversationId}, path=${msg.filePath}`);
      }
      await forwardWorkbenchResponse(agentId, fwdMsg);
      break;
    }

    case 'file_saved': {
      // Phase 4: 文件保存后失效父目录缓存
      invalidateParentDirCache(agentId, msg.filePath);
      await forwardWorkbenchResponse(agentId, msg);
      break;
    }

    case 'directory_listing': {
      // Phase 4: 缓存目录列表结果
      if (msg.dirPath && msg.entries && !msg.error) {
        setCachedDir(agentId, msg.dirPath, msg.entries);
      }
      await forwardWorkbenchResponse(agentId, msg);
      break;
    }

    case 'file_op_result':
      // Phase 4: 文件创建/删除/移动 — 清空该 agent 的所有目录缓存
      clearAgentDirCache(agentId);
      await forwardWorkbenchResponse(agentId, msg);
      break;

    case 'git_status_result':
    case 'git_diff_result':
    case 'git_op_result':
    case 'file_search_result':
      await forwardWorkbenchResponse(agentId, msg);
      break;

    default:
      return false; // Not handled
  }
  return true; // Handled
}
