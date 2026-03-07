// Re-export from connection/ submodules for backward compatibility
export {
  connect,
  sendToServer,
  flushMessageBuffer,
  parseMessage,
  BUFFERABLE_TYPES,
  startAgentHeartbeat,
  stopAgentHeartbeat,
  scheduleReconnect,
  handleMessage,
  handleRestartAgent,
  handleUpgradeAgent
} from './connection/index.js';
