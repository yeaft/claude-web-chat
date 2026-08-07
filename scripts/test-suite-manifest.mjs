const TEST_ROOT = 'test/';
const TEST_FILE_PATTERN = /\.(?:test|spec)\.(?:[cm]?[jt]sx?)$/;

export const CORE_TEST_FILES = Object.freeze([
  'test/test-budget-gate.test.js',
  'test/agent/connection-plaintext.test.js',
  'test/agent/router-per-model-protocol.test.js',
  'test/agent/sub-agent/sub-agent-reliability.test.js',
  'test/agent/terminal-routing.test.js',
  'test/agent/windows-upgrade-handoff.test.js',
  'test/agent/yeaft/conversation/persist.test.js',
  'test/agent/yeaft/config-api-debug.test.js',
  'test/agent/yeaft/deepseek-effort.test.js',
  'test/agent/yeaft/engine.test.js',
  'test/agent/yeaft/llm-adapter-errors.test.js',
  'test/agent/yeaft/llm-auth-headers.test.js',
  'test/agent/yeaft/project-sessions-migrate.test.js',
  'test/agent/yeaft/route-forward-thread.test.js',
  'test/agent/yeaft/session-config.test.js',
  'test/agent/yeaft/session-recovery.test.js',
  'test/agent/yeaft/sessions/pre-flow.test.js',
  'test/agent/yeaft/stdio-protocol.test.js',
  'test/agent/yeaft/task-result-reentry.test.js',
  'test/agent/yeaft/tasks/manager.test.js',
  'test/agent/yeaft/web-bridge-fast-history.test.js',
  'test/agent/yeaft/work-center/core.test.js',
  'test/agent/yeaft/work-center/dynamic-coordination.test.js',
  'test/agent/yeaft/work-center/mainline-projection.test.js',
  'test/agent/yeaft/work-center/runner-policy.test.js',
  'test/agent/yeaft/work-center/store-migration.test.js',
  'test/agent/yeaft/work-center/watcher.test.js',
  'test/server/agent-access-error.test.js',
  'test/server/agent-connection-fence.test.js',
  'test/server/auth-token-uniqueness.test.js',
  'test/server/request-auth.test.js',
  'test/server/server-image-runtime.test.js',
  'test/server/upload-routes.test.js',
  'test/server/user-routes-agent-secret.test.js',
  'test/server/ws-plaintext-negotiation.test.js',
  'test/server/yeaft-history-search-relay.test.js',
  'test/server/yeaft-asset-store.test.js',
  'test/server/yeaft-session-online-filter.test.js',
  'test/web/auth-bootstrap.test.js',
  'test/web/auth-fetch.test.js',
  'test/web/history-sender-filter.test.js',
  'test/web/message-flow-regression.test.js',
  'test/web/message-file-preview.test.js',
  'test/web/message-virtualization-source.test.js',
  'test/web/session-message-quote-ui.test.js',
  'test/web/session-message-quote.test.js',
  'test/web/stores/auth-session-refresh.test.js',
  'test/web/stores/load-more-yeaft-history.test.js',
  'test/web/stores/session-cookie-auth.test.js',
  'test/web/stores/websocket-auth-token-race.test.js',
  'test/web/stores/yeaft-debug-panel.test.js',
  'test/web/stores/yeaft-history-outline-state.test.js',
  'test/web/virtual-transcript-dom.test.js',
  'test/web/virtual-transcript.test.js',
  'test/web/yeaft-history-reveal-dom.test.js',
  'test/web/yeaft-history-search-ui.test.js',
  'test/web/yeaft-page-setup.test.js',
  'test/web/turn-debug-eyes.test.js',
]);

export const SANDBOX_TEST_FILES = Object.freeze([
  'test/agent/container-manager.test.js',
  'test/web/sandbox-settings.test.js',
]);

export const REVIEWED_TEST_FILES = Object.freeze([
  ...CORE_TEST_FILES,
  ...SANDBOX_TEST_FILES,
]);

export function normalizeTestPath(filePath) {
  return String(filePath || '').replaceAll('\\', '/').replace(/^\.\//, '');
}

export function isTestFile(filePath) {
  const normalized = normalizeTestPath(filePath);
  return normalized.startsWith(TEST_ROOT) && TEST_FILE_PATTERN.test(normalized);
}
