import { CONFIG } from '../config.js';
import {
  sendToWebClient, forwardToAgent,
  verifyConversationOwnership, getCachedDir
} from '../ws-utils.js';

/**
 * Handle workbench messages from web client (terminal, file, git operations).
 * Types: terminal_create, terminal_input, terminal_resize, terminal_close,
 *        read_file, write_file, list_directory,
 *        git_status, git_diff, git_add, git_reset, git_restore, git_commit, git_push,
 *        file_search, create_file, delete_files, move_files, copy_files, upload_to_dir
 */
export async function handleClientWorkbench(clientId, client, msg, checkAgentAccess) {
  switch (msg.type) {
    // Terminal messages (forward to agent)
    case 'terminal_create':
    case 'terminal_input':
    case 'terminal_resize':
    case 'terminal_close': {
      const termAgentId = msg.agentId || client.currentAgent;
      if (!termAgentId) return;
      if (!await checkAgentAccess(termAgentId)) return;
      const termConvId = msg.conversationId || client.currentConversation;
      if (!termConvId) return;
      if (!CONFIG.skipAuth && !verifyConversationOwnership(termConvId, client.userId)) {
        console.warn(`[Security] User ${client.userId} terminal access denied for ${termConvId}`);
        await sendToWebClient(client, { type: 'error', message: 'Permission denied' });
        return;
      }
      await forwardToAgent(termAgentId, { ...msg, conversationId: termConvId });
      break;
    }

    case 'read_file': {
      const fileAgentId = msg.agentId || client.currentAgent;
      if (!fileAgentId) { console.warn('[Server] read_file: no agentId'); return; }
      if (!await checkAgentAccess(fileAgentId)) return;
      const fileConvId = msg.conversationId || client.currentConversation || '_explorer';
      console.log(`[Server] Forwarding read_file to agent ${fileAgentId}, conv=${fileConvId}, path=${msg.filePath}`);
      await forwardToAgent(fileAgentId, { ...msg, conversationId: fileConvId, _requestUserId: client.userId });
      break;
    }

    case 'write_file': {
      const writeAgentId = msg.agentId || client.currentAgent;
      if (!writeAgentId) return;
      if (!await checkAgentAccess(writeAgentId)) return;
      const writeConvId = msg.conversationId || client.currentConversation || '_explorer';
      const isAgentLevelWrite = writeConvId.startsWith('_');
      if (!isAgentLevelWrite) {
        if (!CONFIG.skipAuth && !verifyConversationOwnership(writeConvId, client.userId)) {
          console.warn(`[Security] User ${client.userId} file write denied for ${writeConvId}`);
          await sendToWebClient(client, { type: 'error', message: 'Permission denied' });
          return;
        }
      }
      await forwardToAgent(writeAgentId, { ...msg, conversationId: writeConvId, _requestUserId: client.userId });
      break;
    }

    case 'list_directory': {
      const dirAgentId = msg.agentId || client.currentAgent;
      if (!dirAgentId) return;
      if (!await checkAgentAccess(dirAgentId)) return;

      // 先查缓存
      const cached = getCachedDir(dirAgentId, msg.dirPath);
      if (cached) {
        await sendToWebClient(client, {
          type: 'directory_listing',
          conversationId: msg.conversationId,
          dirPath: msg.dirPath,
          entries: cached,
          fromCache: true
        });
        return;
      }

      await forwardToAgent(dirAgentId, {
        type: 'list_directory',
        dirPath: msg.dirPath,
        workDir: msg.workDir,
        conversationId: msg.conversationId || client.currentConversation,
        requestId: msg.requestId,
        _requestUserId: client.userId,
        _requestClientId: clientId
      });
      break;
    }

    case 'git_status':
    case 'git_diff':
    case 'git_add':
    case 'git_reset':
    case 'git_restore':
    case 'git_commit':
    case 'git_push':
    case 'file_search': {
      const gitAgentId = msg.agentId || client.currentAgent;
      if (!gitAgentId) return;
      if (!await checkAgentAccess(gitAgentId)) return;
      await forwardToAgent(gitAgentId, {
        ...msg,
        conversationId: msg.conversationId || client.currentConversation,
        _requestUserId: client.userId
      });
      break;
    }

    case 'create_file':
    case 'delete_files':
    case 'move_files':
    case 'copy_files':
    case 'upload_to_dir': {
      const fopAgentId = msg.agentId || client.currentAgent;
      if (!fopAgentId) return;
      if (!await checkAgentAccess(fopAgentId)) return;
      await forwardToAgent(fopAgentId, {
        ...msg,
        conversationId: msg.conversationId || client.currentConversation,
        _requestUserId: client.userId
      });
      break;
    }

    default:
      return false; // Not handled
  }
  return true; // Handled
}
