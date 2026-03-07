/**
 * gitOperations — git command helpers for GitStatusTab.
 */

export function createGitOperations(store, refs) {
  const { effectiveGitWorkDir, gitOperating, gitOpFeedback, commitMessage } = refs;

  let feedbackTimer = null;
  let gitOpTimer = null;

  const showFeedback = (ok, message) => {
    if (feedbackTimer) clearTimeout(feedbackTimer);
    gitOpFeedback.value = { ok, message };
    feedbackTimer = setTimeout(() => { gitOpFeedback.value = null; }, 4000);
  };

  const loadGitStatus = (gitLoading, gitError) => {
    if (!store.currentAgent) return;
    gitLoading.value = true;
    gitError.value = '';
    store.sendWsMessage({
      type: 'git_status',
      conversationId: store.currentConversation || '_explorer',
      agentId: store.currentAgent,
      workDir: effectiveGitWorkDir.value,
      _clientId: store.clientId
    });
  };

  const gitOp = (type, extra = {}) => {
    if (!store.currentAgent) return;
    gitOperating.value = true;
    if (gitOpTimer) clearTimeout(gitOpTimer);
    gitOpTimer = setTimeout(() => {
      if (gitOperating.value) {
        gitOperating.value = false;
        showFeedback(false, 'Operation timed out');
      }
    }, 15000);
    store.sendWsMessage({
      type,
      conversationId: store.currentConversation || '_explorer',
      agentId: store.currentAgent,
      workDir: effectiveGitWorkDir.value,
      _clientId: store.clientId,
      ...extra
    });
  };

  const stageFile = (filePath) => gitOp('git_add', { filePath });
  const unstageFile = (filePath) => gitOp('git_reset', { filePath });
  const discardFile = (filePath) => {
    if (!confirm('Discard changes to ' + filePath + '?')) return;
    gitOp('git_restore', { filePath });
  };
  const stageAll = () => gitOp('git_add', { addAll: true });
  const unstageAll = () => gitOp('git_reset', { resetAll: true });

  const commitChanges = () => {
    const msg = commitMessage.value.trim();
    if (!msg) return;
    gitOp('git_commit', { commitMessage: msg });
  };

  const pushChanges = () => gitOp('git_push');

  const handleGitOpResult = (msg, loadStatusFn) => {
    gitOperating.value = false;
    if (gitOpTimer) { clearTimeout(gitOpTimer); gitOpTimer = null; }
    if (msg.success) {
      showFeedback(true, msg.message || (msg.operation + ' succeeded'));
      if (msg.operation === 'commit') {
        commitMessage.value = '';
      }
      loadStatusFn();
    } else {
      showFeedback(false, msg.error || (msg.operation + ' failed'));
    }
  };

  const cleanup = () => {
    if (feedbackTimer) clearTimeout(feedbackTimer);
    if (gitOpTimer) clearTimeout(gitOpTimer);
  };

  return {
    showFeedback, loadGitStatus, gitOp,
    stageFile, unstageFile, discardFile, stageAll, unstageAll,
    commitChanges, pushChanges, handleGitOpResult, cleanup
  };
}
