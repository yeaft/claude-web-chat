// Plugin protocol support is omission-compatible: old Agents that never
// advertised capability metadata keep the legacy relay path. Once an Agent
// explicitly provides metadata, omitting this token is an explicit refusal.
export const YEAFT_PLUGINS_CAPABILITY = 'yeaft_plugins';
export const YEAFT_PLUGINS_UNSUPPORTED_ERROR = 'The selected Agent does not support Plugins; upgrade and restart the Agent';

export function agentSupportsYeaftPlugins(agent) {
  if (agent?.capabilityMetadataProvided !== true) return true;
  return Array.isArray(agent.capabilities)
    && agent.capabilities.includes(YEAFT_PLUGINS_CAPABILITY);
}
